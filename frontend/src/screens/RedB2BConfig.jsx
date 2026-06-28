// Red B2B Config (F4 #457) — config del tenant para Red B2B.
//
// Por ahora solo expone caja_default_id (donde recibimos pagos cross-tenant
// propagados desde el otro lado). F5+ puede extender con preferencias de
// notificaciones, email opt-in, etc.

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { redB2b, cajas } from '../lib/api';
import { useToast } from '../contexts/ToastContext';

export default function RedB2BConfig() {
  const { toast } = useToast();

  const [config, setConfig] = useState(null);
  const [cajasList, setCajasList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cajaIdDraft, setCajaIdDraft] = useState('');

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [cfg, mp] = await Promise.all([
          redB2b.config.get(),
          cajas.listMetodosPago(),
        ]);
        if (!mounted) return;
        setConfig(cfg.red_b2b);
        setCajaIdDraft(cfg.red_b2b?.caja_default_id ? String(cfg.red_b2b.caja_default_id) : '');
        // mp puede venir como { metodos_pago: [...] } o array directo según endpoint.
        const list = Array.isArray(mp) ? mp : (mp.metodos_pago || mp.cajas || []);
        setCajasList(list);
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

  if (loading) {
    return (
      <div className="screen-wrap">
        <div className="empty-state" style={{ padding: 32 }}>Cargando…</div>
      </div>
    );
  }

  return (
    <div className="screen-wrap">
      <header className="page-head">
        <Link to="/red-b2b" className="btn-link" style={{ fontSize: 14 }}>
          ← Red B2B
        </Link>
        <h1>Configuración Red B2B</h1>
        <p className="muted">
          Configuración global del tenant para operaciones cross-tenant.
        </p>
      </header>

      <section className="card" style={{ padding: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Caja default cross-tenant</h2>
        <p style={{ marginBottom: 12, fontSize: 14 }}>
          Cuando un partner Red B2B registra un pago de una operación nuestra,
          el sistema necesita saber en qué caja propia anotar el movimiento.
          Si no configurás una caja default, usamos la primera caja con moneda
          compatible (ARS para pagos ARS, USD para pagos USD/USDT).
        </p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 240px' }}>
            <label htmlFor="caja-default-select" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
              Caja a usar por defecto
            </label>
            <select
              id="caja-default-select"
              value={cajaIdDraft}
              onChange={(e) => setCajaIdDraft(e.target.value)}
              style={{ width: '100%', padding: 8 }}
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
            className="btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>

        {config?.caja_default && (
          <p style={{ marginTop: 12, fontSize: 13 }}>
            <span className="muted">Actual: </span>
            <strong>{config.caja_default.nombre}</strong>
            <span className="muted"> ({config.caja_default.moneda})</span>
          </p>
        )}
      </section>
    </div>
  );
}
