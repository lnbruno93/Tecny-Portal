// Pantalla Clientes del admin console (Sub-fase B.2 #353).
//
// Listado completo de tenants con filtros (estado + búsqueda libre)
// y click-to-detail. La búsqueda usa debounce de 300ms para no
// hostigar el endpoint en cada tecla. Un reqIdRef descarta responses
// viejas si el user cambió el filtro mid-flight (race condition guard).
//
// Diseño defensivo: el endpoint puede devolver shapes parciales —
// optional chaining + defaults en TODO lo que mostramos al user.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../lib/api.js';
import { Btn, Badge, Status, Card, Seg, PageHead } from '../components/primitives/index.jsx';
import { Icons } from '../components/Icons.jsx';
import { fmt, fmtMoney, ago } from '../lib/format.js';
import {
  planTone,
  tenantInitials,
  getTenantStatus,
  TENANT_STATUS,
  healthProxy,
  healthColor,
} from '../lib/uiHelpers.js';

// Mapping del segmented control → filtros del backend. Centralizado
// acá para que un cambio de label o de filter shape no toque dos lugares.
const FILTER_MODES = [
  { value: 'todas',        label: 'Todas',       params: {} },
  { value: 'activas',      label: 'Activas',     params: { suspended: 'false' } },
  { value: 'trial',        label: 'Trial',       params: { plan: 'trial' } },
  { value: 'suspendidas',  label: 'Suspendidas', params: { suspended: 'true' } },
];

function modeParams(mode) {
  return FILTER_MODES.find((m) => m.value === mode)?.params || {};
}

function planLabel(p) {
  if (!p) return '—';
  return p.charAt(0).toUpperCase() + p.slice(1);
}

export default function Clientes() {
  const navigate = useNavigate();

  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('todas');

  // Race condition guard — cada request lleva un id incremental.
  // Cuando llega la respuesta, si su id no es el último (porque el
  // user cambió de filtro mientras tanto), la descartamos. Sin esto,
  // una respuesta lenta a un filtro viejo puede pisar a una rápida
  // del filtro nuevo (UI inconsistente).
  const reqIdRef = useRef(0);

  // Fetcher unificado. Recibe filtros explícitos para evitar capturar
  // estado stale en el closure del useEffect.
  const loadList = (filters) => {
    const myId = ++reqIdRef.current;
    setLoading(true);
    setError('');
    adminApi.listTenants(filters)
      .then((rows) => {
        // Descartar response viejo (usuario disparó request más nuevo).
        if (myId !== reqIdRef.current) return;
        setData(Array.isArray(rows) ? rows : []);
        setLoading(false);
      })
      .catch((err) => {
        if (myId !== reqIdRef.current) return;
        setError(err?.message || 'No pudimos cargar el listado.');
        setData([]);
        setLoading(false);
      });
  };

  // Disparo inicial + cada vez que cambia mode (sin debounce — el seg
  // es discreto, no genera spam de requests).
  useEffect(() => {
    loadList(modeParams(mode));
  }, [mode]);

  // Debounce de search: 300ms entre la última tecla y el fetch.
  // Cleanup borra el timer si el user sigue tipeando → solo dispara
  // cuando se quedó quieto. Combinamos params del modo activo + search.
  useEffect(() => {
    // Caso inicial / search vacío: ya disparamos en el useEffect de
    // mode. No queremos doble-fetch en el primer render.
    if (search === '') return;
    const t = setTimeout(() => {
      loadList({ ...modeParams(mode), search: search.trim() });
    }, 300);
    return () => clearTimeout(t);
  }, [search, mode]);

  const clearFilters = () => {
    setSearch('');
    setMode('todas');
    // El useEffect de mode dispara loadList automáticamente al mutar mode.
    // Si ya estábamos en 'todas', forzamos el reload manual:
    if (mode === 'todas') loadList({});
  };

  // ── Render ────────────────────────────────────────────────────────
  const hasFilters = search.trim() !== '' || mode !== 'todas';

  return (
    <>
      <PageHead
        label="Clientes"
        title="Clientes"
        subtitle={loading && !data.length
          ? 'Cargando…'
          : `${data.length} ${data.length === 1 ? 'empresa' : 'empresas'} ${hasFilters ? 'en los filtros actuales' : 'suscriptas'}`}
        actions={
          <>
            <Btn icon="Download" disabled title="Próximamente">Exportar</Btn>
            <Btn kind="primary" icon="Plus" disabled title="Próximamente">
              Invitar cliente
            </Btn>
          </>
        }
      />

      {error && (
        <div
          role="alert"
          className="card"
          style={{
            marginBottom: 'var(--gap)',
            background: 'var(--neg-soft)',
            border: '1px solid transparent',
            color: 'var(--neg)',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <Card
        flush
        title={`Listado · ${data.length}`}
        actions={
          <div className="flex-row" style={{ gap: 8 }}>
            <div className="input-group" style={{ width: 240 }}>
              <span className="addon addon-l"><Icons.Search size={14} /></span>
              <input
                className="input with-addon-l"
                type="search"
                placeholder="Buscar empresa, slug…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Buscar tenant"
              />
            </div>
            <Seg
              value={mode}
              onChange={setMode}
              options={FILTER_MODES.map((m) => ({ value: m.value, label: m.label }))}
            />
          </div>
        }
      >
        <table className="tbl tbl-row-click">
          <thead>
            <tr>
              <th>Empresa</th>
              <th>Plan</th>
              <th className="num">MRR</th>
              <th>Usuarios</th>
              <th>Salud</th>
              <th>Estado</th>
              <th>Actividad</th>
              <th style={{ width: 36 }} aria-label="" />
            </tr>
          </thead>
          <tbody>
            {loading && data.length === 0 ? (
              // Skeleton: 5 rows con barras pulse mientras carga el primer fetch.
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={`skel-${i}`} className="tbl-skel-row">
                  <td><div className="skeleton" style={{ height: 16, width: '60%' }} /></td>
                  <td><div className="skeleton" style={{ height: 16, width: 48 }} /></td>
                  <td><div className="skeleton" style={{ height: 16, width: 60 }} /></td>
                  <td><div className="skeleton" style={{ height: 16, width: 30 }} /></td>
                  <td><div className="skeleton" style={{ height: 16, width: 80 }} /></td>
                  <td><div className="skeleton" style={{ height: 16, width: 70 }} /></td>
                  <td><div className="skeleton" style={{ height: 16, width: 60 }} /></td>
                  <td />
                </tr>
              ))
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <div className="empty-state">
                    {hasFilters ? (
                      <>
                        <div className="empty-title">Sin resultados para los filtros actuales.</div>
                        <div className="empty-action">
                          <Btn sm onClick={clearFilters}>Limpiar filtros</Btn>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="empty-title">Todavía no hay tenants.</div>
                        Cuando alguien se suscriba aparece acá.
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              data.map((t) => {
                const statusKey = getTenantStatus(t);
                const statusMeta = TENANT_STATUS[statusKey] || TENANT_STATUS.active;
                const health = healthProxy(t.last_venta_at);
                const hColor = healthColor(health);
                return (
                  <tr
                    key={t.id}
                    onClick={() => navigate('/clientes/' + t.id)}
                  >
                    <td>
                      <div className="flex-row" style={{ gap: 10 }}>
                        <div className="company-logo">{tenantInitials(t.nombre)}</div>
                        <div>
                          <div style={{ fontWeight: 600 }}>{t.nombre || '—'}</div>
                          <div className="muted tiny">{t.slug || ''}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={planTone(t.plan)}>{planLabel(t.plan)}</Badge>
                    </td>
                    <td className="num mono" style={{ fontWeight: 600 }}>
                      {(t.mrr_usd ?? 0) > 0 ? fmtMoney(t.mrr_usd) : '—'}
                    </td>
                    <td className="mono">{fmt(t.users_count ?? 0)}</td>
                    <td style={{ width: 130 }}>
                      <div className="bar-track" style={{ marginBottom: 3 }}>
                        <div
                          className="bar-fill"
                          style={{ width: health + '%', background: hColor }}
                        />
                      </div>
                      <span className="tiny mono" style={{ color: hColor }}>{health}</span>
                    </td>
                    <td>
                      <Status tone={statusMeta.tone}>{statusMeta.label}</Status>
                    </td>
                    <td className="muted tiny">
                      {t.last_venta_at ? ago(t.last_venta_at) : '—'}
                    </td>
                    <td>
                      <Icons.ChevronRight size={15} className="muted" />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}
