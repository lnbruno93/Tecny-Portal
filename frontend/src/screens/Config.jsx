import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Icons } from '../components/Icons';
import { config as configApi, cajas as cajasApi } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { fmt } from '../lib/format';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import AlertasModule from './Alertas';
import TwoFaSection from '../components/TwoFaSection';
import MantenimientoSection from '../components/MantenimientoSection';
// 2026-06-22: el perfil del negocio (ficha de Google que usa el Cotizador
// para personalizar el mensaje generado) vive como tab "Configuración"
// dentro de Cotizador, NO acá en Config global. Se hizo así para que el
// dato esté al lado del lugar donde se usa — Lucas pidió evitar la confusión
// de tener configuración "general del portal" mezclada con configuración
// específica de un módulo. Por eso `BusinessProfileSection` no se importa
// más desde acá.


const SYSTEM_LIMITS = [
  { t: 'OCR rate-limit',   d: '10 solicitudes/hora por usuario' },
  { t: 'Archivos',         d: 'Máximo 5 MB por comprobante' },
  { t: 'Soft delete',      d: 'Los registros nunca se borran físicamente' },
  { t: 'Admin bypass',     d: 'Admins tienen acceso a todos los módulos' },
  { t: 'Auditoría',        d: 'Cada cambio queda registrado en el historial' },
  { t: 'Cotizador',        d: 'Client-side sin persistencia en DB' },
];

export default function Config() {
  const location = useLocation();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  // Tab inicial: si el hash es #alertas (deep-link desde el badge de alertas
  // en el sidebar), arrancamos en esa tab. Si no, default general.
  // #mantenimiento solo se respeta si el usuario es admin (de lo contrario
  // cae a 'general'); el backend igual rechaza con 403 a no-admins.
  const initialTab = location.hash === '#alertas' ? 'alertas'
                    : location.hash === '#seguridad' ? 'seguridad'
                    : (location.hash === '#mantenimiento' && isAdmin) ? 'mantenimiento'
                    : 'general';
  const [tab, setTab]           = useState(initialTab); // 'general' | 'alertas' | 'seguridad' | 'mantenimiento'
  // Sección unificada "Comisiones de métodos de pago" (2026-06-14, pedido Lucas):
  //   · `pct` / `inputVal`     — Financiera (= config.pct_financiera)
  //   · `tarjetas`             — métodos es_tarjeta=true con su comision_pct.
  //     Cada uno guarda `_original` para detectar dirty-state granular y solo
  //     pegar al endpoint los que realmente cambiaron.
  const [pct, setPct]           = useState(3);
  const [inputVal, setInputVal] = useState('3');
  const [tarjetas, setTarjetas] = useState([]); // [{id, nombre, pct_input, _original}]
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(true);

  // Si el hash cambia mientras estamos en Config (ej: click al badge de
  // alertas estando ya en Config), sincronizar la tab.
  useEffect(() => {
    if (location.hash === '#alertas') setTab('alertas');
    else if (location.hash === '#seguridad') setTab('seguridad');
    else if (location.hash === '#mantenimiento' && isAdmin) setTab('mantenimiento');
    else if (location.hash === '#general') setTab('general');
  }, [location.hash, isAdmin]);

  // TANDA 5 trazab (UX L4): cambiar tab actualiza el hash con replaceState (no
  // pushState — evita ensuciar el history). Permite copiar URL y compartir,
  // y que F5 mantenga la tab activa en lugar de pegarse al hash inicial.
  function goToTab(t) {
    setTab(t);
    if (window.history.replaceState) {
      window.history.replaceState(null, '', `#${t}`);
    } else {
      window.location.hash = `#${t}`;
    }
  }

  useEffect(() => {
    // Carga paralela: config (pct_financiera) + lista de cajas (para extraer
    // las tarjetas). Si una falla, defaults razonables y mostramos error.
    Promise.all([
      configApi.get().catch(e => { throw e; }),
      cajasApi.listCajas().catch(() => []),
    ])
      .then(([cfg, cajasList]) => {
        const v = Number(cfg?.pct_financiera ?? 3);
        setPct(v);
        setInputVal(String(v));
        // Solo cajas con es_tarjeta=true. listCajas() ya filtra deleted_at,
        // ordenamos por orden + nombre para que el listado sea estable.
        const tcs = (cajasList || [])
          .filter(c => c.es_tarjeta)
          .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || String(a.nombre).localeCompare(String(b.nombre)))
          .map(c => ({
            id: c.id, nombre: c.nombre,
            pct_input: String(Number(c.comision_pct ?? 0)),
            _original: Number(c.comision_pct ?? 0),
          }));
        setTarjetas(tcs);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // ── Live simulation ────────────────────────────────────────────────────────
  const simBase = 1_000_000;
  const simPct  = parseFloat(inputVal) || 0;
  const simRet  = simBase * (simPct / 100);
  const simNeto = simBase - simRet;

  // Dirty global: Financiera cambió o cualquier tarjeta tiene pct distinto al original.
  const finDirty = parseFloat(inputVal) !== pct;
  const tarjetasDirty = tarjetas.some(t => parseFloat(t.pct_input) !== t._original);
  const dirty = finDirty || tarjetasDirty;

  function setTarjetaPct(id, value) {
    setTarjetas(ts => ts.map(t => t.id === id ? { ...t, pct_input: value } : t));
    setSaved(false);
    setError('');
  }

  async function handleSave() {
    // Validación: todos los valores en [0, 100].
    const valFin = parseFloat(inputVal);
    if (isNaN(valFin) || valFin < 0 || valFin > 100) {
      setError('Financiera: valor inválido. Ingresá un número entre 0 y 100.');
      return;
    }
    for (const t of tarjetas) {
      const v = parseFloat(t.pct_input);
      if (isNaN(v) || v < 0 || v > 100) {
        setError(`${t.nombre}: valor inválido. Ingresá un número entre 0 y 100.`);
        return;
      }
    }
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      // Pegamos en paralelo solo lo que cambió. Si un endpoint falla, los demás
      // pueden haber persistido — refrescamos local state desde lo que sí guardó
      // (los que pasaron) y dejamos el error visible.
      const updates = [];
      if (finDirty) updates.push(['fin', configApi.update({ pct_financiera: valFin })]);
      tarjetas.forEach(t => {
        if (parseFloat(t.pct_input) !== t._original) {
          updates.push(['tar:' + t.id, cajasApi.updateCaja(t.id, { comision_pct: parseFloat(t.pct_input) })]);
        }
      });
      await Promise.all(updates.map(([, p]) => p));
      // Sync state: lo persistido pasa a ser el nuevo "original".
      if (finDirty) setPct(valFin);
      setTarjetas(ts => ts.map(t => ({ ...t, _original: parseFloat(t.pct_input) })));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setInputVal(String(pct));
    setTarjetas(ts => ts.map(t => ({ ...t, pct_input: String(t._original) })));
    setError('');
    setSaved(false);
  }

  if (loading) {
    return (
      <div>
        <div className="page-head">
          <h1 className="page-title">Configuración</h1>
        </div>
        <div className="empty">Cargando configuración…</div>
      </div>
    );
  }

  return (
    <div>
      {/* ── Page header ───────────────────────────────────────────────────── */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Configuración</h1>
          <div className="page-sub">Ajustes globales del portal · sólo administradores</div>
        </div>
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      {/* TANDA 5 trazab (UX L4): goToTab sincroniza el hash con el tab activo.
          Antes, si el usuario llegaba via #mantenimiento y luego cambiaba a
          General, el hash quedaba pegado y un F5 lo devolvía a Mantenimiento. */}
      <div className="flex-row" style={{ gap: 4, marginBottom: 16 }}>
        <button className={'btn ' + (tab === 'general' ? 'btn-primary' : '')}
                onClick={() => goToTab('general')}>
          General
        </button>
        <button className={'btn ' + (tab === 'alertas' ? 'btn-primary' : '')}
                onClick={() => goToTab('alertas')}>
          <Icons.Bell size={14} /> Alertas
        </button>
        <button className={'btn ' + (tab === 'seguridad' ? 'btn-primary' : '')}
                onClick={() => goToTab('seguridad')}>
          <Icons.Shield size={14} /> Seguridad
        </button>
        {/* Tab admin-only: aparece solo si user.role === 'admin'. El backend
            igual rechaza con 403 a no-admins si intentan hitear los endpoints. */}
        {isAdmin && (
          <button className={'btn ' + (tab === 'mantenimiento' ? 'btn-primary' : '')}
                  onClick={() => goToTab('mantenimiento')}>
            <Icons.Bolt size={14} /> Mantenimiento
          </button>
        )}
      </div>

      {tab === 'alertas' && <AlertasModule />}
      {tab === 'seguridad' && <TwoFaSection />}
      {tab === 'mantenimiento' && isAdmin && <MantenimientoSection />}

      {tab === 'general' && (
      <>

      {/* ── Split layout ──────────────────────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
        gap: 16,
        marginBottom: 16,
      }}>
        {/* Left: Comisiones de métodos de pago (2026-06-14, pedido Lucas).
            Unifica el % de Financiera con el % de cada tarjeta es_tarjeta=true.
            Antes había que editar las tarjetas por separado en Cajas → Config —
            ahora todo el costo financiero del negocio se ajusta acá. */}
        <div className="card">
          <div className="card-hd">
            <div style={{ fontWeight: 600, fontSize: 15 }}>Comisiones de métodos de pago</div>
            <div className="muted tiny" style={{ marginTop: 2 }}>
              Se aplican al cobrar con cada método (Tema C — descontado de la ganancia)
            </div>
          </div>

          <div style={{ padding: '0 0 16px' }}>
            {/* Fila Transferencia (= pct_financiera) */}
            <div className="field" style={{ marginBottom: 16 }}>
              <div className="field-label">Transferencias <span className="muted">(Financiera)</span></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="input-group" style={{ maxWidth: 160 }}>
                  <input
                    type="number" onKeyDown={blockInvalidNumberKeys}
                    step="0.1" min="0" max="100"
                    className="input mono"
                    style={{ fontWeight: 700, fontSize: 16 }}
                    data-testid="config-pct-financiera"
                    value={inputVal}
                    onChange={e => {
                      setInputVal(e.target.value);
                      setSaved(false);
                      setError('');
                    }}
                  />
                  <span className="addon" style={{ fontWeight: 700, color: 'var(--accent)' }}>%</span>
                </div>
                <span className="muted tiny">
                  Guardado: <span className="mono" style={{ fontWeight: 700 }}>{pct.toFixed(1)}%</span>
                </span>
              </div>
            </div>

            {/* Filas Tarjetas de Crédito */}
            <div style={{ marginBottom: 16 }}>
              <div className="field-label" style={{ marginBottom: 8 }}>Tarjetas de crédito</div>
              {tarjetas.length === 0 ? (
                <div className="muted tiny" style={{ padding: '6px 0' }}>
                  No hay tarjetas configuradas. Creá una en Cajas → Config marcándola como tarjeta.
                </div>
              ) : (
                <div className="stack" style={{ gap: 8 }}>
                  {tarjetas.map(t => {
                    const tDirty = parseFloat(t.pct_input) !== t._original;
                    return (
                      <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '1fr 160px 110px', gap: 10, alignItems: 'center' }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{t.nombre}</div>
                        <div className="input-group">
                          <input
                            type="number" onKeyDown={blockInvalidNumberKeys}
                            step="0.1" min="0" max="100"
                            className="input mono"
                            style={{ fontWeight: 700, fontSize: 15 }}
                            data-testid={`config-pct-tarjeta-${t.id}`}
                            value={t.pct_input}
                            onChange={e => setTarjetaPct(t.id, e.target.value)}
                          />
                          <span className="addon" style={{ fontWeight: 700, color: 'var(--accent)' }}>%</span>
                        </div>
                        <span className="muted tiny" style={{ textAlign: 'right' }}>
                          {tDirty
                            ? <>Guardado: <span className="mono">{t._original.toFixed(1)}%</span></>
                            : <span className="mono">{t._original.toFixed(1)}%</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Simulación (solo para Financiera — las tarjetas el operador
                ya entiende el % de cada cuota) */}
            <div style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: 14,
              marginBottom: 16,
            }}>
              <div className="muted tiny" style={{
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                marginBottom: 10,
              }}>
                Simulación Financiera con ARS 1.000.000
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <div className="flex-between">
                  <span className="muted tiny">Bruto</span>
                  <span className="mono" style={{ fontWeight: 600 }}>ARS 1.000.000</span>
                </div>
                <div className="flex-between">
                  <span className="muted tiny">Retención ({simPct.toFixed(1)}%)</span>
                  <span className="mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>
                    ARS {fmt(simRet)}
                  </span>
                </div>
                <div className="flex-between" style={{
                  paddingTop: 8,
                  borderTop: '1px solid var(--hairline)',
                  marginTop: 4,
                }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>Nos queda</span>
                  <span className="mono pos" style={{ fontWeight: 700, fontSize: 15 }}>
                    ARS {fmt(simNeto)}
                  </span>
                </div>
              </div>
            </div>

            {/* Error / success messages */}
            {error && (
              <div style={{
                padding: '8px 12px',
                background: 'var(--neg-soft, #fef2f2)',
                color: 'var(--neg)',
                borderRadius: 8,
                fontSize: 13,
                marginBottom: 12,
              }}>
                {error}
              </div>
            )}
            {saved && (
              <div style={{
                padding: '8px 12px',
                background: 'var(--pos-soft, #f0fdf4)',
                color: 'var(--pos)',
                borderRadius: 8,
                fontSize: 13,
                marginBottom: 12,
              }}>
                Configuración guardada correctamente.
              </div>
            )}

            <div className="flex-row" style={{ gap: 8 }}>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving || !dirty}
                data-testid="config-comisiones-save"
              >
                <Icons.Check size={15} />
                {saving ? 'Guardando…' : dirty ? 'Guardar cambios' : 'Sin cambios'}
              </button>
              {dirty && (
                <button className="btn btn-ghost" onClick={handleCancel}>
                  Cancelar
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Right: system limitations */}
        <div className="card">
          <div className="card-hd">
            <div style={{ fontWeight: 600, fontSize: 15 }}>Limitaciones del sistema</div>
            <div className="muted tiny" style={{ marginTop: 2 }}>
              Comportamientos que conviene tener presentes
            </div>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 12,
            padding: '0 0 16px',
          }}>
            {SYSTEM_LIMITS.map(({ t, d }) => (
              <div
                key={t}
                style={{
                  padding: 14,
                  background: 'var(--surface-2)',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{t}</div>
                <div className="muted tiny" style={{ lineHeight: 1.4 }}>{d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
