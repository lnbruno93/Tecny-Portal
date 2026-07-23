// Red B2B Conciliacion bilateral (F4 #457) — vista de saldos cruzados por
// partnership. Si no hay partnershipId en la URL, lista todos los partners
// del tenant + permite drill-down. Si hay :partnershipId, muestra detalle.
//
// PR-D #463: el cache in-memory de 60s del server fue eliminado (multi-instance
// bug + frecuencia de hit baja). Cada GET recomputa fresh. El botón "Recargar"
// se mantiene como acción explícita del usuario para refetchear.
//
// PR-X3 #465: split en `RedB2BConciliacionContent` (named export, sin
// page-head) + default export wrapper standalone. El Content se monta como
// tab dentro de CuentasCC (la pantalla "Venta y Gestión B2B"). En ese
// modo el partnership se pasa por prop (proveniente del query param de
// CuentasCC); en modo standalone se sigue leyendo de useParams() vía el
// wrapper, para preservar el comportamiento histórico de la ruta legacy
// /red-b2b/conciliacion/:partnershipId (hoy redirige al tab nuevo).

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { redB2b } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { fmtMoney, fmtFecha } from '../lib/format';

// ── Content (sin page-head) ──────────────────────────────────────────────────
// Props:
//   - partnershipId (opcional): si se pasa, abre directo el detalle.
//   - onSelectPartnership (opcional): callback con el id seleccionado en la
//     lista. Permite al huésped sincronizar URL/state (ej. CuentasCC actualiza
//     ?partnership=<id> sin tener que duplicar el listado).
//   - onClearPartnership (opcional): callback para volver al listado desde
//     el detalle (botón "← Conciliación").
//
// Si NO se pasan callbacks, el componente cae al comportamiento standalone:
// navegación interna vía <Link> a /red-b2b/conciliacion/:id (las rutas
// legacy redirigen al nuevo home).
export function RedB2BConciliacionContent({
  partnershipId,
  onSelectPartnership,
  onClearPartnership,
} = {}) {
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
        // Si el huésped proveyó callback, lo usamos para limpiar el contexto.
        // Si no, fallback al comportamiento standalone (navigate al listado).
        if (typeof onClearPartnership === 'function') onClearPartnership();
        else navigate('/red-b2b/conciliacion');
      } else {
        toast.error(err.message || 'No pudimos cargar la conciliación');
      }
    } finally {
      setLoading(false);
    }
  }, [partnershipId, navigate, toast, onClearPartnership]);

  useEffect(() => {
    if (partnershipId) loadConciliacion();
    else loadList();
  }, [partnershipId, loadConciliacion, loadList]);

  // Flag: el componente se considera "embebido" (sin page-head propio,
  // navegación interna delegada al huésped) cuando hay callback de
  // selección. Sin callback, mantiene el comportamiento standalone.
  const embedded = typeof onSelectPartnership === 'function';

  function handleSelectPartnership(id) {
    if (embedded) onSelectPartnership(id);
    else navigate(`/red-b2b/conciliacion/${id}`);
  }

  function handleClearPartnership() {
    if (embedded && typeof onClearPartnership === 'function') onClearPartnership();
    else navigate('/red-b2b/conciliacion');
  }

  // ── Lista de partnerships (sin partnershipId) ──────────────────────────
  if (!partnershipId) {
    return (
      <div>
        <p className="muted u-mt-0-mb-16">
          Vista de saldos cruzados por cada partner Red B2B. Hacé click en uno
          para ver la conciliación detallada.
        </p>
        {loading ? (
          <div className="empty-state u-p-32">Cargando…</div>
        ) : partnerships.length === 0 ? (
          <div className="empty-state u-p-32">
            <p>No tenés partnerships activos.</p>
            <Link to="/red-b2b" className="btn-primary u-mt-12">
              Ir a Partnerships
            </Link>
          </div>
        ) : (
          <section className="card u-p-16">
            <ul className="u-list-reset">
              {partnerships.map((p) => {
                const partner = p.partner || p.tenant_a || p.tenant_b;
                return (
                  <li key={p.id} className="u-partnership-row">
                    <div>
                      <strong>{partner?.nombre || `Partnership #${p.id}`}</strong>
                      <div className="muted u-fs-13">
                        Plan: {partner?.plan || '—'}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => handleSelectPartnership(p.id)}
                    >
                      Ver conciliación →
                    </button>
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
      <div>
        <div className="empty-state u-p-32">Cargando conciliación…</div>
      </div>
    );
  }

  const { partnership, totales, saldos_bilaterales, ops_diferencias } = conciliacion;
  const partner = partnership?.partner;

  return (
    <div>
      <div className="u-flex-between-start-wrap-mb-12">
        <div>
          <button
            type="button"
            className="btn-link u-btn-link-inline"
            onClick={handleClearPartnership}
          >
            ← Conciliación
          </button>
          <h2 className="u-mb-4-mt-6">Conciliación con {partner?.nombre || '—'}</h2>
          <div className="muted u-fs-13">
            Partnership #{partnership.id} · Datos en vivo
          </div>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => loadConciliacion()}
          aria-label="Recargar conciliación"
        >
          Recargar
        </button>
      </div>

      <section className="card u-p-16-mb-16">
        <h3 className="u-mt-0-fs-16">Totales agregados</h3>
        <div className="u-grid-autofit-180-16">
          <KpiBox label="Operaciones (USD)" value={fmtMoney(totales.operaciones_usd, 'USD')} sub={`${totales.ops_count} ops`} />
          <KpiBox label="Pagado (USD)" value={fmtMoney(totales.pagado_usd, 'USD')} sub={`${totales.pagos_count} pagos`} />
          <KpiBox
            label="Saldo neto (USD)"
            value={fmtMoney(totales.saldo_neto_usd, 'USD')}
            color={totales.saldo_neto_usd === 0 ? 'green' : 'orange'}
          />
        </div>
      </section>

      <section className="card u-p-16-mb-16">
        <h3 className="u-mt-0-fs-16">Conciliación bilateral</h3>
        {saldos_bilaterales.difieren ? (
          <div className="u-alert-red-box">
            <strong className="u-color-red-fg">
              ⚠ Saldos divergentes
            </strong>
            <p className="u-m-8-0-0-0-fs-14">
              Hay una diferencia de <strong>{fmtMoney(saldos_bilaterales.diferencia_usd, 'USD')}</strong>{' '}
              entre lo que el seller y el buyer registran. Revisá las operaciones abajo.
            </p>
          </div>
        ) : (
          <div className="u-alert-green-box">
            <strong className="u-color-green-fg">
              ✓ Saldos coincidentes
            </strong>
            <p className="u-m-8-0-0-0-fs-14">
              Lo que ambos lados registran cuadra perfecto.
            </p>
          </div>
        )}
      </section>

      {ops_diferencias && ops_diferencias.length > 0 && (
        <section className="card">
          <h2 className="u-p-12-16-m-0-fs-16">
            Operaciones con detalle
          </h2>
          <div className="u-overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Op #</th>
                  <th className="u-text-right">Total USD</th>
                  <th className="u-text-right">Pagado USD</th>
                  <th className="u-text-right">Restante USD</th>
                  <th>Tipo</th>
                  <th>Última actividad</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {ops_diferencias.map((o) => (
                  <tr key={o.op_id}>
                    <td>#{o.op_id}</td>
                    <td className="u-text-right">{fmtMoney(o.total_usd, 'USD')}</td>
                    <td className="u-text-right">{fmtMoney(o.pagado_usd, 'USD')}</td>
                    <td className="u-text-right">{fmtMoney(o.restante_usd, 'USD')}</td>
                    <td>{o.is_devolucion ? <span className="muted">Devolución</span> : 'Venta'}</td>
                    <td>{o.ultima_actividad ? fmtFecha(o.ultima_actividad) : '—'}</td>
                    <td>
                      <Link
                        to={`/red-b2b/operaciones/${o.op_id}`}
                        className="btn-link u-fs-13"
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

// ── Wrapper standalone (con page-head) ──────────────────────────────────────
// Preservado por retro-compat. Las rutas /red-b2b/conciliacion(/:id) en
// App.jsx ahora redirigen al tab "Conciliación Red B2B" dentro de CuentasCC
// (PR-X3 #465), pero dejamos el wrapper exportado para tests viejos y
// montaje directo eventual.
export default function RedB2BConciliacion() {
  const { partnershipId } = useParams();
  const navigate = useNavigate();
  return (
    <div className="screen-wrap">
      <header className="page-head">
        <h1>Conciliación bilateral</h1>
      </header>
      <RedB2BConciliacionContent
        partnershipId={partnershipId}
        onSelectPartnership={(id) => navigate(`/red-b2b/conciliacion/${id}`)}
        onClearPartnership={() => navigate('/red-b2b/conciliacion')}
      />
    </div>
  );
}

function KpiBox({ label, value, sub, color }) {
  const colorClass = color === 'green'
    ? 'u-color-green-fg'
    : color === 'orange'
      ? 'u-color-orange-fg'
      : '';
  return (
    <div className="u-p-12-bg-subtle-r-4">
      <div className="muted u-fs-12-mb-4">{label}</div>
      <div className={`u-kpi-value ${colorClass}`}>{value}</div>
      {sub && <div className="muted u-fs-12-mt-2">{sub}</div>}
    </div>
  );
}
