import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../lib/api.js';

// Debounce hook minimalista — usado para el search input (300ms). No vale la
// pena traer lodash por este único uso.
function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function fmtDate(s) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleDateString('es-AR', { year: 'numeric', month: 'short', day: '2-digit' });
  } catch { return s; }
}

function fmtMoney(n, ccy = 'USD') {
  if (n == null || isNaN(Number(n))) return '—';
  return `${ccy} ${Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;
}

function PlanBadge({ plan }) {
  const colors = {
    trial:   { bg: 'var(--warn-soft)', fg: 'var(--warn)' },
    starter: { bg: 'var(--info-soft)', fg: 'var(--info)' },
    growth:  { bg: 'var(--accent-soft)', fg: 'var(--accent)' },
    pro:     { bg: 'var(--pos-soft)', fg: 'var(--pos)' },
  };
  const c = colors[plan] || { bg: 'var(--surface-2)', fg: 'var(--text-muted)' };
  return (
    <span
      className="badge"
      style={{ background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}
    >
      {plan || '—'}
    </span>
  );
}

function StatusBadge({ tenant }) {
  if (tenant.suspended_at) {
    return <span className="badge" style={{ background: 'var(--neg-soft)', color: 'var(--neg)', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>Suspendido</span>;
  }
  if (tenant.plan === 'trial' && tenant.trial_until) {
    const daysLeft = Math.ceil((new Date(tenant.trial_until) - Date.now()) / (1000 * 60 * 60 * 24));
    if (daysLeft <= 0) return <span className="badge" style={{ background: 'var(--neg-soft)', color: 'var(--neg)', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>Trial vencido</span>;
    if (daysLeft <= 3) return <span className="badge" style={{ background: 'var(--warn-soft)', color: 'var(--warn)', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>{daysLeft}d trial</span>;
  }
  return <span className="badge" style={{ background: 'var(--pos-soft)', color: 'var(--pos)', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>Activo</span>;
}

export default function TenantsList() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filtros
  const [plan, setPlan] = useState('');
  const [suspended, setSuspended] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);

  // Race-condition guard: si dispara dos fetchs rápidos (cambio de filtro
  // mientras llega el primer response) queremos descartar el response viejo.
  const reqIdRef = useRef(0);

  const fetchTenants = useCallback(async () => {
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi.listTenants({
        plan: plan || undefined,
        suspended: suspended || undefined,
        search: debouncedSearch || undefined,
      });
      if (myReq !== reqIdRef.current) return; // ignoramos respuesta vieja
      setTenants(Array.isArray(data) ? data : (data?.tenants || []));
    } catch (err) {
      if (myReq !== reqIdRef.current) return;
      if (err.status === 403) {
        setError('Acceso denegado. Esta consola requiere flag de super-admin activo.');
      } else if (err.message === 'NO_AUTH') {
        // El wrapper api() ya dispatched el evento → AuthContext nos sacó la sesión.
        // El ProtectedRoute hará redirect en el próximo render. No mostramos error.
        return;
      } else {
        setError(err.message || 'No se pudo cargar la lista de tenants.');
      }
    } finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  }, [plan, suspended, debouncedSearch]);

  useEffect(() => { fetchTenants(); }, [fetchTenants]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Tenants</h1>
          <p className="page-sub">Gestión de organizaciones del SaaS Tecny.</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={fetchTenants} disabled={loading}>
            {loading ? 'Cargando…' : 'Refrescar'}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="filters">
          <label className="field-inline">
            <span className="field-label">Buscar</span>
            <input
              type="search"
              placeholder="Nombre, slug, email del owner…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="field-inline">
            <span className="field-label">Plan</span>
            <select value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value="">Todos</option>
              <option value="trial">Trial</option>
              <option value="starter">Starter</option>
              <option value="growth">Growth</option>
              <option value="pro">Pro</option>
            </select>
          </label>
          <label className="field-inline">
            <span className="field-label">Estado</span>
            <select value={suspended} onChange={(e) => setSuspended(e.target.value)}>
              <option value="">Todos</option>
              <option value="false">Activos</option>
              <option value="true">Suspendidos</option>
            </select>
          </label>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div className="card card-flush">
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Plan</th>
                <th>Estado</th>
                <th className="num">Usuarios</th>
                <th className="num">Ventas (30d)</th>
                <th className="num">MRR</th>
                <th>Creado</th>
              </tr>
            </thead>
            <tbody>
              {loading && tenants.length === 0 && (
                <>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <tr key={`sk-${i}`}>
                      <td colSpan={7}><div className="skeleton" style={{ height: 18 }} /></td>
                    </tr>
                  ))}
                </>
              )}
              {!loading && tenants.length === 0 && !error && (
                <tr>
                  <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 32 }}>
                    No hay tenants que coincidan con los filtros.
                  </td>
                </tr>
              )}
              {tenants.map((t) => (
                <tr
                  key={t.id}
                  className="tbl-row-click"
                  onClick={() => navigate(`/tenants/${t.id}`)}
                >
                  <td>
                    <div style={{ fontWeight: 600 }}>{t.name || t.slug || `Tenant #${t.id}`}</div>
                    {t.slug && t.slug !== t.name && (
                      <div className="muted" style={{ fontSize: 11.5 }}>{t.slug}</div>
                    )}
                  </td>
                  <td><PlanBadge plan={t.plan} /></td>
                  <td><StatusBadge tenant={t} /></td>
                  <td className="num">{t.users_count ?? '—'}</td>
                  <td className="num">{t.ventas_30d ?? '—'}</td>
                  <td className="num">{fmtMoney(t.mrr_usd, 'USD')}</td>
                  <td>{fmtDate(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
