// Red B2B Conciliacion bilateral (F4 #457) — vista de saldos cruzados por
// partnership. Si no hay partnershipId en la URL, lista todos los partners
// del tenant + permite drill-down. Si hay :partnershipId, muestra detalle.
//
// PR-D #463: el cache in-memory de 60s del server fue eliminado (multi-instance
// bug + frecuencia de hit baja). Cada GET recomputa fresh. El botón "Recargar"
// se mantiene como acción explícita del usuario para refetchear.

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { redB2b } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { fmtMoney, fmtFecha } from '../lib/format';

export default function RedB2BConciliacion() {
  const { partnershipId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [partnerships, setPartnerships] = useState([]);
  const [conciliacion, setConciliacion] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await redB2b.partnerships.list('active');
      setPartnerships(r.partnerships || r || []);
    } catch (err) {
      toast.error(err.message || 'No pudimos cargar las partnerships');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadConciliacion = useCallback(async (refresh = false) => {
    if (!partnershipId) return;
    setLoading(true);
    try {
      const r = await redB2b.conciliacion.get(partnershipId, { refresh });
      setConciliacion(r);
    } catch (err) {
      if (err.status === 404) {
        toast.error('Partnership no encontrada');
        navigate('/red-b2b/conciliacion');
      } else {
        toast.error(err.message || 'No pudimos cargar la conciliación');
      }
    } finally {
      setLoading(false);
    }
  }, [partnershipId, navigate, toast]);

  useEffect(() => {
    if (partnershipId) loadConciliacion();
    else loadList();
  }, [partnershipId, loadConciliacion, loadList]);

  // ── Lista de partnerships (sin partnershipId) ──────────────────────────
  if (!partnershipId) {
    return (
      <div className="screen-wrap">
        <header className="page-head">
          <h1>Conciliación bilateral</h1>
          <p className="muted">
            Vista de saldos cruzados por cada partner Red B2B. Hacé click en uno
            para ver la conciliación detallada.
          </p>
        </header>
        {loading ? (
          <div className="empty-state" style={{ padding: 32 }}>Cargando…</div>
        ) : partnerships.length === 0 ? (
          <div className="empty-state" style={{ padding: 32 }}>
            <p>No tenés partnerships activos.</p>
            <Link to="/red-b2b" className="btn-primary" style={{ marginTop: 12 }}>
              Ir a Partnerships
            </Link>
          </div>
        ) : (
          <section className="card" style={{ padding: 16 }}>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {partnerships.map((p) => {
                const partner = p.partner || p.tenant_a || p.tenant_b;
                return (
                  <li key={p.id} style={{
                    padding: 12, borderBottom: '1px solid var(--border, #e5e7eb)',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div>
                      <strong>{partner?.nombre || `Partnership #${p.id}`}</strong>
                      <div className="muted" style={{ fontSize: 13 }}>
                        Plan: {partner?.plan || '—'}
                      </div>
                    </div>
                    <Link to={`/red-b2b/conciliacion/${p.id}`} className="btn-secondary">
                      Ver conciliación →
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    );
  }

  // ── Detalle de conciliación (con partnershipId) ──────────────────────
  if (loading || !conciliacion) {
    return (
      <div className="screen-wrap">
        <div className="empty-state" style={{ padding: 32 }}>Cargando conciliación…</div>
      </div>
    );
  }

  const { partnership, totales, saldos_bilaterales, ops_diferencias } = conciliacion;
  const partner = partnership?.partner;

  return (
    <div className="screen-wrap">
      <header className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <Link to="/red-b2b/conciliacion" className="btn-link" style={{ fontSize: 14 }}>
            ← Conciliación
          </Link>
          <h1 style={{ marginBottom: 4 }}>Conciliación con {partner?.nombre || '—'}</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            Partnership #{partnership.id} · Datos en vivo
          </div>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => loadConciliacion()}
          aria-label="Recargar conciliación"
        >
          Recargar
        </button>
      </header>

      <section className="card" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Totales agregados</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          <KpiBox label="Operaciones (USD)" value={fmtMoney(totales.operaciones_usd, 'USD')} sub={`${totales.ops_count} ops`} />
          <KpiBox label="Pagado (USD)" value={fmtMoney(totales.pagado_usd, 'USD')} sub={`${totales.pagos_count} pagos`} />
          <KpiBox
            label="Saldo neto (USD)"
            value={fmtMoney(totales.saldo_neto_usd, 'USD')}
            color={totales.saldo_neto_usd === 0 ? 'green' : 'orange'}
          />
        </div>
      </section>

      <section className="card" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Conciliación bilateral</h2>
        {saldos_bilaterales.difieren ? (
          <div style={{ background: 'var(--red-bg, #fef2f2)', padding: 12, borderRadius: 4, marginBottom: 12 }}>
            <strong style={{ color: 'var(--red-fg, #991b1b)' }}>
              ⚠ Saldos divergentes
            </strong>
            <p style={{ margin: '8px 0 0 0', fontSize: 14 }}>
              Hay una diferencia de <strong>{fmtMoney(saldos_bilaterales.diferencia_usd, 'USD')}</strong>{' '}
              entre lo que el seller y el buyer registran. Revisá las operaciones abajo.
            </p>
          </div>
        ) : (
          <div style={{ background: 'var(--green-bg, #f0fdf4)', padding: 12, borderRadius: 4, marginBottom: 12 }}>
            <strong style={{ color: 'var(--green-fg, #166534)' }}>
              ✓ Saldos coincidentes
            </strong>
            <p style={{ margin: '8px 0 0 0', fontSize: 14 }}>
              Lo que ambos lados registran cuadra perfecto.
            </p>
          </div>
        )}
      </section>

      {ops_diferencias && ops_diferencias.length > 0 && (
        <section className="card">
          <h2 style={{ padding: '12px 16px', margin: 0, fontSize: 16 }}>
            Operaciones con detalle
          </h2>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Op #</th>
                  <th style={{ textAlign: 'right' }}>Total USD</th>
                  <th style={{ textAlign: 'right' }}>Pagado USD</th>
                  <th style={{ textAlign: 'right' }}>Restante USD</th>
                  <th>Tipo</th>
                  <th>Última actividad</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {ops_diferencias.map((o) => (
                  <tr key={o.op_id}>
                    <td>#{o.op_id}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(o.total_usd, 'USD')}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(o.pagado_usd, 'USD')}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(o.restante_usd, 'USD')}</td>
                    <td>{o.is_devolucion ? <span className="muted">Devolución</span> : 'Venta'}</td>
                    <td>{o.ultima_actividad ? fmtFecha(o.ultima_actividad) : '—'}</td>
                    <td>
                      <Link
                        to={`/red-b2b/operaciones/${o.op_id}`}
                        className="btn-link"
                        style={{ fontSize: 13 }}
                      >
                        Ver →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function KpiBox({ label, value, sub, color }) {
  const colorStyle = color === 'green'
    ? { color: 'var(--green-fg, #166534)' }
    : color === 'orange'
      ? { color: 'var(--orange-fg, #c2410c)' }
      : {};
  return (
    <div style={{ padding: 12, background: 'var(--bg-subtle, #f9fafb)', borderRadius: 4 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, ...colorStyle }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
