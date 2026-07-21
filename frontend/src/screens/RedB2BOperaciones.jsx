// Red B2B Operaciones (F3 #456) — listado de operaciones cross-tenant.
//
// Scope F3: lista operaciones donde mi tenant participa, ya sea como SELLER
// (yo creé la venta) o como BUYER (yo recibí la compra). Cada fila muestra
// fecha, partner, my_side (badge), totales, status, items_count, y un
// botón "Ver detalle" que navega al detalle.
//
// Filtros: partner (dropdown con mis partnerships activas), status,
// rango de fechas. Reuso el patrón de filtros de RedB2B (F1).
//
// Gating: la ruta está gateada por cap `cross_tenant.write` en App.jsx +
// RequirePermission. El backend igual rechaza con 403.
//
// F4 agrega: vista de conciliación bilateral. F5 agrega: notifs en topbar.

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { redB2b } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { fmtMoney, fmtFecha } from '../lib/format';

const STATUS_LABELS = {
  active:    { label: 'Activa',    color: 'green'  },
  cancelled: { label: 'Cancelada', color: 'red'    },
  frozen:    { label: 'Congelada', color: 'orange' },
};

export default function RedB2BOperaciones() {
  const { toast } = useToast();
  const [operations, setOperations] = useState([]);
  const [partnerships, setPartnerships] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filtros
  const [filterPartner, setFilterPartner] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const filters = {};
      if (filterPartner) filters.partnership_id = filterPartner;
      if (filterStatus)  filters.status = filterStatus;
      if (filterFrom)    filters.from = filterFrom;
      if (filterTo)      filters.to = filterTo;
      const r = await redB2b.operations.list(filters);
      setOperations(r.operations || []);
    } catch (err) {
      toast.error(err.message || 'No pudimos cargar las operaciones');
      setOperations([]);
    } finally {
      setLoading(false);
    }
  }, [filterPartner, filterStatus, filterFrom, filterTo, toast]);

  // Cargar partnerships una sola vez (para el dropdown filtro).
  useEffect(() => {
    redB2b.partnerships.list('active')
      .then((r) => setPartnerships(r.partnerships || []))
      .catch(() => setPartnerships([]));
  }, []);

  useEffect(() => { load(); }, [load]);

  const hasFilters = filterPartner || filterStatus || filterFrom || filterTo;

  const clearFilters = () => {
    setFilterPartner('');
    setFilterStatus('');
    setFilterFrom('');
    setFilterTo('');
  };

  return (
    <div className="screen-wrap">
      <header className="page-head">
        <div>
          <h1>Operaciones Red B2B</h1>
          <p className="muted">
            Ventas y compras cross-tenant con partners de tu Red B2B.
          </p>
        </div>
      </header>

      <section className="card" style={{ marginBottom: 16, padding: 16 }}>
        <div className="filters-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="muted u-fs-12">Partner</span>
            <select
              value={filterPartner}
              onChange={(e) => setFilterPartner(e.target.value)}
              aria-label="Filtrar por partner"
            >
              <option value="">Todos los partners</option>
              {partnerships.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.partner?.nombre || `Partner #${p.id}`}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="muted u-fs-12">Estado</span>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              aria-label="Filtrar por estado"
            >
              <option value="">Todos</option>
              <option value="active">Activas</option>
              <option value="cancelled">Canceladas</option>
              <option value="frozen">Congeladas</option>
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="muted u-fs-12">Desde</span>
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
              aria-label="Filtrar desde fecha"
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="muted u-fs-12">Hasta</span>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => setFilterTo(e.target.value)}
              aria-label="Filtrar hasta fecha"
            />
          </label>

          {hasFilters && (
            <button type="button" className="btn-secondary" onClick={clearFilters}>
              Limpiar filtros
            </button>
          )}
        </div>
      </section>

      <section className="card">
        {loading ? (
          <div className="empty-state" style={{ padding: 24 }}>
            Cargando operaciones…
          </div>
        ) : operations.length === 0 ? (
          <div className="empty-state" style={{ padding: 32, textAlign: 'center' }}>
            <p className="u-mb-8">No hay operaciones cross-tenant aún.</p>
            <p className="muted u-fs-14">
              Cuando vendas a un partner Tecny o recibas una compra de un
              partner, las operaciones aparecen acá.
            </p>
          </div>
        ) : (
          <div className="u-overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Partner</th>
                  <th>Lado</th>
                  <th>Items</th>
                  <th className="u-text-right">Total USD</th>
                  <th className="u-text-right">Total ARS</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {operations.map((op) => (
                  <OperationRow key={op.id} op={op} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function OperationRow({ op }) {
  const statusInfo = STATUS_LABELS[op.status] || { label: op.status, color: 'gray' };
  const sideBadge = op.my_side === 'seller'
    ? { label: 'Vendedor', color: '#2563eb' }
    : { label: 'Comprador', color: '#10b981' };

  return (
    <tr>
      <td>{fmtFecha(op.created_at)}</td>
      <td>{op.partner?.nombre || '—'}</td>
      <td>
        <span
          className="badge"
          style={{
            background: sideBadge.color,
            color: 'white',
            padding: '2px 8px',
            borderRadius: 4,
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          {sideBadge.label}
        </span>
      </td>
      <td>{op.items_count || 0}</td>
      <td className="u-text-right">{fmtMoney(op.total_usd, 'USD')}</td>
      <td className="u-text-right">{fmtMoney(op.total_ars, 'ARS')}</td>
      <td>
        <span
          className={`status-badge status-${statusInfo.color}`}
          style={{
            padding: '2px 8px',
            borderRadius: 4,
            fontSize: 12,
            background: `var(--${statusInfo.color}-bg, #f3f4f6)`,
            color: `var(--${statusInfo.color}-fg, #374151)`,
          }}
        >
          {statusInfo.label}
        </span>
      </td>
      <td>
        <Link to={`/red-b2b/operaciones/${op.id}`} className="btn-link">
          Ver detalle
        </Link>
      </td>
    </tr>
  );
}
