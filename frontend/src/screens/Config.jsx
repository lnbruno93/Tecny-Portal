import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Icons } from '../components/Icons';
import { config as configApi } from '../lib/api';
import { fmt } from '../lib/format';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import AlertasModule from './Alertas';


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
  // Tab inicial: si el hash es #alertas (deep-link desde el badge de alertas
  // en el sidebar), arrancamos en esa tab. Si no, default general.
  const initialTab = location.hash === '#alertas' ? 'alertas' : 'general';
  const [tab, setTab]           = useState(initialTab); // 'general' | 'alertas'
  const [pct, setPct]           = useState(3);
  const [inputVal, setInputVal] = useState('3');
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(true);

  // Si el hash cambia mientras estamos en Config (ej: click al badge de
  // alertas estando ya en Config), sincronizar la tab.
  useEffect(() => {
    if (location.hash === '#alertas') setTab('alertas');
    else if (location.hash === '#general') setTab('general');
  }, [location.hash]);

  useEffect(() => {
    configApi.get()
      .then(data => {
        const v = Number(data?.pct_financiera ?? 3);
        setPct(v);
        setInputVal(String(v));
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // ── Live simulation ────────────────────────────────────────────────────────
  const simBase = 1_000_000;
  const simPct  = parseFloat(inputVal) || 0;
  const simRet  = simBase * (simPct / 100);
  const simNeto = simBase - simRet;

  const dirty = parseFloat(inputVal) !== pct;

  async function handleSave() {
    const val = parseFloat(inputVal);
    if (isNaN(val) || val < 0 || val > 100) {
      setError('Valor inválido. Ingresá un número entre 0 y 100.');
      return;
    }
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await configApi.update({ pct_financiera: val });
      setPct(val);
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
      <div className="flex-row" style={{ gap: 4, marginBottom: 16 }}>
        <button className={'btn ' + (tab === 'general' ? 'btn-primary' : '')}
                onClick={() => setTab('general')}>
          General
        </button>
        <button className={'btn ' + (tab === 'alertas' ? 'btn-primary' : '')}
                onClick={() => setTab('alertas')}>
          <Icons.Bell size={14} /> Alertas
        </button>
      </div>

      {tab === 'alertas' && <AlertasModule />}

      {tab === 'general' && (
      <>

      {/* ── Split layout ──────────────────────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
        gap: 16,
        marginBottom: 16,
      }}>
        {/* Left: editable % */}
        <div className="card">
          <div className="card-hd">
            <div style={{ fontWeight: 600, fontSize: 15 }}>Retención de la financiera</div>
            <div className="muted tiny" style={{ marginTop: 2 }}>
              Se aplica automáticamente a cada comprobante registrado
            </div>
          </div>

          <div style={{ padding: '0 0 16px' }}>
            <div className="field" style={{ marginBottom: 14 }}>
              <div className="field-label">Porcentaje de retención</div>
              <div className="input-group" style={{ maxWidth: 200 }}>
                <input
                  type="number" onKeyDown={blockInvalidNumberKeys}
                  step="0.1"
                  min="0"
                  max="100"
                  className="input mono"
                  style={{ fontWeight: 700, fontSize: 18 }}
                  value={inputVal}
                  onChange={e => {
                    setInputVal(e.target.value);
                    setSaved(false);
                    setError('');
                  }}
                />
                <span className="addon" style={{ fontWeight: 700, color: 'var(--accent)' }}>%</span>
              </div>
              <div className="muted tiny" style={{ marginTop: 6 }}>
                Guardado: <span className="mono" style={{ fontWeight: 700 }}>{pct.toFixed(1)}%</span>
              </div>
            </div>

            {/* Live simulation */}
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
                Simulación con ARS 1.000.000
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
