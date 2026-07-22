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
import { userHasCap } from '../lib/userHasCap';
// 2026-06-22: el perfil del negocio (ficha de Google que usa el Cotizador
// para personalizar el mensaje generado) vive como tab "Configuración"
// dentro de Cotizador, NO acá en Config global. Se hizo así para que el
// dato esté al lado del lugar donde se usa — Lucas pidió evitar la confusión
// de tener configuración "general del portal" mezclada con configuración
// específica de un módulo. Por eso `BusinessProfileSection` no se importa
// más desde acá.


// Fallback usado si /api/config/system-limits falla (red caída, deploy mid-flight).
// Los VALORES REALES vienen del backend (#443). Mantenemos este fallback
// porque la sección es informativa — preferible mostrar algo a romper el
// render. Sincronizar a mano con backend/src/lib/systemLimits.js si cambia.
const SYSTEM_LIMITS_FALLBACK = [
  { t: 'OCR rate-limit',  d: '60 solicitudes/hora por usuario' },
  { t: 'Tamaño máximo archivos', d: 'Máximo 10 MB por archivo subido' },
  { t: 'Soft delete',     d: 'Los registros nunca se borran físicamente' },
  { t: 'Permisos',        d: 'Owner + Admin bypassean checks; otros según permisos' },
  { t: 'Auditoría',       d: 'Cambios registrados por 90 días' },
  { t: 'Cotizador',       d: 'Client-side, TC default = último cambio del tenant' },
];

export default function Config() {
  const location = useLocation();
  const { user } = useAuth();
  // 2026-06-23 F5c: gating per-tab basado en caps del sistema nuevo.
  // El RequirePermission del route ya garantiza que el user tiene AL MENOS
  // UNA de las 3 caps de Config — acá decidimos qué tabs renderear y a
  // cuál arrancar.
  const canGeneral       = userHasCap(user, 'config.general');
  const canAlertas       = userHasCap(user, 'config.alertas');
  const canMantenimiento = userHasCap(user, 'config.mantenimiento');

  // Tab inicial: respeta el hash si el user puede ver esa tab, sino fallback
  // a la primera tab visible. Seguridad (2FA propia) es siempre accesible
  // — todo user logueado puede gestionar su propia 2FA.
  const hashTab = location.hash.replace('#', '');
  const wantedFromHash =
    (hashTab === 'general'       && canGeneral)       ? 'general' :
    (hashTab === 'alertas'       && canAlertas)       ? 'alertas' :
    (hashTab === 'mantenimiento' && canMantenimiento) ? 'mantenimiento' :
    (hashTab === 'seguridad')                         ? 'seguridad' :
    null;
  // Default: primera tab disponible (general → alertas → mantenimiento → seguridad).
  const firstAvailableTab =
    canGeneral       ? 'general' :
    canAlertas       ? 'alertas' :
    canMantenimiento ? 'mantenimiento' :
    'seguridad';
  const initialTab = wantedFromHash || firstAvailableTab;
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
  // #443: System limits ahora vienen del backend (antes hardcoded). Fallback
  // al array local si el fetch falla — no rompemos render por una llamada
  // informativa.
  const [systemLimits, setSystemLimits] = useState(SYSTEM_LIMITS_FALLBACK);
  useEffect(() => {
    let alive = true;
    configApi.systemLimits()
      .then((res) => { if (alive && Array.isArray(res?.limits)) setSystemLimits(res.limits); })
      .catch(() => { /* silent: ya tenemos fallback */ });
    return () => { alive = false; };
  }, []);

  // Si el hash cambia mientras estamos en Config (ej: click al badge de
  // alertas estando ya en Config), sincronizar la tab. F5c: gated por cap.
  // Si el user no tiene la cap, ignoramos el hash (se queda en la tab actual).
  useEffect(() => {
    if (location.hash === '#alertas' && canAlertas) setTab('alertas');
    else if (location.hash === '#seguridad') setTab('seguridad');
    else if (location.hash === '#mantenimiento' && canMantenimiento) setTab('mantenimiento');
    else if (location.hash === '#general' && canGeneral) setTab('general');
  }, [location.hash, canAlertas, canMantenimiento, canGeneral]);

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
      {/* 2026-06-23 F5c: tabs visibles según caps del user. Seguridad (2FA
          propia) siempre visible — todo user puede gestionar su propia 2FA. */}
      <div className="flex-row u-tabs-row">
        {canGeneral && (
          <button className={'btn ' + (tab === 'general' ? 'btn-primary' : '')}
                  onClick={() => goToTab('general')}>
            General
          </button>
        )}
        {canAlertas && (
          <button className={'btn ' + (tab === 'alertas' ? 'btn-primary' : '')}
                  onClick={() => goToTab('alertas')}>
            <Icons.Bell size={14} /> Alertas
          </button>
        )}
        <button className={'btn ' + (tab === 'seguridad' ? 'btn-primary' : '')}
                onClick={() => goToTab('seguridad')}>
          <Icons.Shield size={14} /> Seguridad
        </button>
        {canMantenimiento && (
          <button className={'btn ' + (tab === 'mantenimiento' ? 'btn-primary' : '')}
                  onClick={() => goToTab('mantenimiento')}>
            <Icons.Bolt size={14} /> Mantenimiento
          </button>
        )}
      </div>

      {tab === 'alertas' && canAlertas && <AlertasModule />}
      {tab === 'seguridad' && <TwoFaSection />}
      {tab === 'mantenimiento' && canMantenimiento && <MantenimientoSection />}

      {tab === 'general' && canGeneral && (
      <>

      {/* ── Split layout ──────────────────────────────────────────────────── */}
      <div className="u-config-split-340">
        {/* Left: Comisiones de métodos de pago (2026-06-14, pedido Lucas).
            Unifica el % de Financiera con el % de cada tarjeta es_tarjeta=true.
            Antes había que editar las tarjetas por separado en Cajas → Config —
            ahora todo el costo financiero del negocio se ajusta acá. */}
        <div className="card">
          <div className="card-hd">
            <div className="u-fw-600-fs-15">Comisiones de métodos de pago</div>
            <div className="muted tiny u-mt-2">
              Se aplican al cobrar con cada método (Tema C — descontado de la ganancia)
            </div>
          </div>

          <div className="u-p-0-0-16">
            {/* Fila Transferencia (= pct_financiera) */}
            <div className="field u-mb-16">
              <div className="field-label">Transferencias <span className="muted">(Financiera)</span></div>
              <div className="u-flex-center-gap-10">
                <div className="input-group u-mw-160">
                  <input
                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                    step="0.1" min="0" max="100"
                    className="input mono u-fw-700-fs-16"
                    data-testid="config-pct-financiera"
                    value={inputVal}
                    onChange={e => {
                      setInputVal(e.target.value);
                      setSaved(false);
                      setError('');
                    }}
                  />
                  <span className="addon u-color-accent-fw-700">%</span>
                </div>
                <span className="muted tiny">
                  Guardado: <span className="mono u-fw-700">{pct.toFixed(1)}%</span>
                </span>
              </div>
            </div>

            {/* Filas Tarjetas de Crédito */}
            <div className="u-mb-16">
              <div className="field-label u-mb-8">Tarjetas de crédito</div>
              {tarjetas.length === 0 ? (
                <div className="muted tiny u-p-6-0">
                  No hay tarjetas configuradas. Creá una en Cajas → Config marcándola como tarjeta.
                </div>
              ) : (
                <div className="stack u-gap-8">
                  {tarjetas.map(t => {
                    const tDirty = parseFloat(t.pct_input) !== t._original;
                    return (
                      <div key={t.id} className="u-config-tarjeta-row">
                        <div className="u-fs-13-fw-600">{t.nombre}</div>
                        <div className="input-group">
                          <input
                            type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                            step="0.1" min="0" max="100"
                            className="input mono u-fw-700-fs-15"
                            data-testid={`config-pct-tarjeta-${t.id}`}
                            value={t.pct_input}
                            onChange={e => setTarjetaPct(t.id, e.target.value)}
                          />
                          <span className="addon u-color-accent-fw-700">%</span>
                        </div>
                        <span className="muted tiny u-text-right">
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
            <div className="u-config-sim-box">
              <div className="muted tiny u-config-sim-title">
                Simulación Financiera con ARS 1.000.000
              </div>
              <div className="stack u-gap-6">
                <div className="flex-between">
                  <span className="muted tiny">Bruto</span>
                  <span className="mono u-fw-600">ARS 1.000.000</span>
                </div>
                <div className="flex-between">
                  <span className="muted tiny">Retención ({simPct.toFixed(1)}%)</span>
                  <span className="mono u-color-accent-fw-600">
                    ARS {fmt(simRet)}
                  </span>
                </div>
                <div className="flex-between u-config-sim-total">
                  <span className="u-fs-13-fw-600">Nos queda</span>
                  <span className="mono pos u-fw-700-fs-15">
                    ARS {fmt(simNeto)}
                  </span>
                </div>
              </div>
            </div>

            {/* Error / success messages */}
            {error && (
              <div className="u-alert-neg">
                {error}
              </div>
            )}
            {saved && (
              <div className="u-alert-pos">
                Configuración guardada correctamente.
              </div>
            )}

            <div className="flex-row u-gap-8">
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
            <div className="u-fw-600-fs-15">Limitaciones del sistema</div>
            <div className="muted tiny u-mt-2">
              Comportamientos que conviene tener presentes
            </div>
          </div>
          <div className="u-config-limits-grid">
            {systemLimits.map(({ t, d }) => (
              <div
                key={t}
                className="u-config-limit-card"
              >
                <div className="u-fw-600-fs-13-mb-4">{t}</div>
                <div className="muted tiny u-lh-14">{d}</div>
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
