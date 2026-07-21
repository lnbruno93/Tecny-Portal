// Red B2B Config (F4 #457) — config del tenant para Red B2B.
//
// Hoy expone:
//   - caja_default_id (donde recibimos pagos cross-tenant propagados desde el
//     otro lado).
//   - email_prefs (PR-X1 #465): 5 boolean opt-in/opt-out de avisos por email
//     para eventos cross-tenant (invitaciones, operaciones, pagos). Backend
//     en F5 #458, endpoint en GET/PATCH /api/red-b2b/config/email-prefs.
//
// PR-X1 #465: refactor a Option B. El "core content" (form + estado) vive
// en <RedB2BConfigContent /> sin page-head propio para que se pueda embeber
// dentro del hub /red-b2b (tab Configuración). El wrapper standalone que
// preserva la ruta legacy /red-b2b/config (con su page-head y back-link)
// queda como default export.

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { redB2b, cajas } from '../lib/api';
import { useToast } from '../contexts/ToastContext';

// Definición de los 5 flags de email prefs. Single source of truth para el
// JSX (label/descripción del checkbox) y para los tests (orden y nombres).
// El backend mantiene cada flag como JSONB boolean default true.
const EMAIL_PREF_FLAGS = [
  { key: 'invitation_received', label: 'Recibí invitación de partnership' },
  { key: 'invitation_accepted', label: 'Un partner aceptó mi invitación' },
  { key: 'operation_received',  label: 'Un partner me envió una venta' },
  { key: 'operation_cancelled', label: 'Un partner canceló una operación' },
  { key: 'payment_received',    label: 'Un partner cobró un pago' },
];

// ── Core content (sin page-head propio) ─────────────────────────────────────
// Se exporta named para que RedB2B.jsx (hub) pueda renderearlo dentro del tab.
// Hace su propio fetch + render — autónomo. Si en el futuro el hub necesita
// refrescar la config al cambiar de tab, puede remontarlo con `key`.
export function RedB2BConfigContent() {
  const { toast } = useToast();

  const [config, setConfig] = useState(null);
  const [cajasList, setCajasList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cajaIdDraft, setCajaIdDraft] = useState('');

  // PR-X1 #465: email prefs. `emailPrefs` es el objeto con los 5 booleans;
  // arranca en null y se hidrata en el initial load junto con caja default.
  // `savingPrefKey` guarda qué flag está saving en este momento (para deshabilitar
  // sólo ese checkbox mientras el PATCH viaja). Se queda null si no hay PATCH en curso.
  const [emailPrefs, setEmailPrefs] = useState(null);
  const [savingPrefKey, setSavingPrefKey] = useState(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        // Pedimos los 3 endpoints en paralelo. Si getEmailPrefs falla pero los
        // otros no, todavía mostramos la caja default — el catch del bloque
        // entero abarca cualquier error.
        const [cfg, mp, prefsResp] = await Promise.all([
          redB2b.config.get(),
          cajas.listMetodosPago(),
          redB2b.config.getEmailPrefs(),
        ]);
        if (!mounted) return;
        setConfig(cfg.red_b2b);
        setCajaIdDraft(cfg.red_b2b?.caja_default_id ? String(cfg.red_b2b.caja_default_id) : '');
        // Auditoría 2026-06-30 Q-02/Q-03: `cajas.listMetodosPago()` devuelve
        // array plano (contrato verificado en backend/tests/metodos-pago.test.js).
        // Antes había defensive logic `mp.metodos_pago || mp.cajas` heredada
        // de un mock de test mal armado — corregido en RedB2B.test.jsx.
        setCajasList(Array.isArray(mp) ? mp : []);
        // El endpoint devuelve { email_prefs: {...} }. Defaults a true por flag
        // si el backend no devuelve algún campo (ej: si se agregó un flag nuevo
        // post-deploy y la row vieja no lo tiene en su JSONB).
        const prefs = prefsResp?.email_prefs || {};
        const hydrated = {};
        EMAIL_PREF_FLAGS.forEach(({ key }) => {
          hydrated[key] = prefs[key] !== false; // default true
        });
        setEmailPrefs(hydrated);
      } catch (err) {
        toast.error(err.message || 'No pudimos cargar la config');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, [toast]);

  async function handleSave() {
    setSaving(true);
    try {
      const cajaId = cajaIdDraft === '' ? null : Number(cajaIdDraft);
      await redB2b.config.setCajaDefault(cajaId);
      toast.success('Caja default actualizada');
      // Reload to get enriched caja.
      const cfg = await redB2b.config.get();
      setConfig(cfg.red_b2b);
    } catch (err) {
      toast.error(err.message || 'No pudimos guardar');
    } finally {
      setSaving(false);
    }
  }

  // Toggle de un flag de email prefs con optimistic update + revert on error.
  // Flow:
  //   1. Capturamos el nuevo valor (negación del actual).
  //   2. Flip inmediato del state (UI cambia ya).
  //   3. PATCH al backend con solo el flag que cambió — backend hace merge JSONB.
  //   4. Si falla, revertimos el state + toast error. Si va bien, toast success.
  async function toggleEmailPref(key) {
    if (!emailPrefs) return;
    const oldValue = emailPrefs[key];
    const newValue = !oldValue;
    // Optimistic flip.
    setEmailPrefs((prev) => ({ ...prev, [key]: newValue }));
    setSavingPrefKey(key);
    try {
      await redB2b.config.setEmailPrefs({ [key]: newValue });
      toast.success('Preferencia guardada');
    } catch (err) {
      // Revert.
      setEmailPrefs((prev) => ({ ...prev, [key]: oldValue }));
      toast.error(err.message || 'No pudimos guardar la preferencia');
    } finally {
      setSavingPrefKey(null);
    }
  }

  if (loading) {
    return (
      <div className="empty-state u-p-32">Cargando…</div>
    );
  }

  return (
    <section className="card u-p-16">
      <h2 className="u-mt-0-fs-16">Caja default cross-tenant</h2>
      <p style={{ marginBottom: 12, fontSize: 14 }}>
        Cuando un partner Red B2B registra un pago de una operación nuestra,
        el sistema necesita saber en qué caja propia anotar el movimiento.
        Si no configurás una caja default, usamos la primera caja con moneda
        compatible (ARS para pagos ARS, USD para pagos USD/USDT).
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: '1 1 240px', marginBottom: 0 }}>
          <label className="field-label" htmlFor="caja-default-select">
            Caja a usar por defecto
          </label>
          <select
            id="caja-default-select"
            className="input"
            value={cajaIdDraft}
            onChange={(e) => setCajaIdDraft(e.target.value)}
          >
            <option value="">— Sin configurar (usar fallback automático) —</option>
            {cajasList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre} ({c.moneda})
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>

      {config?.caja_default && (
        <p className="u-mt-12-fs-13">
          <span className="muted">Actual: </span>
          <strong>{config.caja_default.nombre}</strong>
          <span className="muted"> ({config.caja_default.moneda})</span>
        </p>
      )}

      {/* ── PR-X1 #465: Avisos por email ────────────────────────────────── */}
      {emailPrefs && (
        <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border, #e5e7eb)' }}>
          <h2 className="u-mt-0-fs-16">Avisos por email</h2>
          <p style={{ marginBottom: 12, fontSize: 14 }}>
            Decidí qué notificaciones de Red B2B querés recibir por mail.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {EMAIL_PREF_FLAGS.map(({ key, label }) => {
              const inputId = `email-pref-${key}`;
              const checked = !!emailPrefs[key];
              const isThisSaving = savingPrefKey === key;
              return (
                <label
                  key={key}
                  htmlFor={inputId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 14,
                    cursor: isThisSaving ? 'wait' : 'pointer',
                  }}
                >
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={checked}
                    disabled={isThisSaving}
                    onChange={() => toggleEmailPref(key)}
                    style={{ width: 16, height: 16, cursor: isThisSaving ? 'wait' : 'pointer' }}
                  />
                  {label}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// ── Wrapper standalone para la ruta legacy /red-b2b/config ──────────────────
// Mantenemos esta ruta activa para no romper bookmarks ni links existentes
// (emails, docs). PR-X1 además agrega un redirect implícito desde el hub —
// ver Cambio 3 en App.jsx. Si el user llega acá vía bookmark, ve la pantalla
// con el page-head + back-link al hub.
export default function RedB2BConfig() {
  return (
    <div className="screen-wrap">
      <header className="page-head">
        <Link to="/red-b2b" className="btn-link u-fs-14">
          ← Red B2B
        </Link>
        <h1>Configuración Red B2B</h1>
        <p className="muted">
          Configuración global del tenant para operaciones cross-tenant.
        </p>
      </header>
      <RedB2BConfigContent />
    </div>
  );
}
