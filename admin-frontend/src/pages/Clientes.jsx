// Pantalla Clientes del admin console (#353).
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
  planLabel,
  tenantInitials,
  getTenantStatus,
  TENANT_STATUS,
  healthProxy,
  healthColor,
} from '../lib/uiHelpers.js';
import CreateTenantModal from '../components/modals/CreateTenantModal.jsx';

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

export default function Clientes() {
  const navigate = useNavigate();

  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('todas');
  // #450: lock UI mientras se descarga el CSV (puede tomar 1-2s con muchos
  // tenants). Sin lock, click repetido dispararía descargas paralelas.
  const [exporting, setExporting] = useState(false);
  // #452: estado del modal "Crear tenant manual" disparado desde "Invitar cliente".
  const [createOpen, setCreateOpen] = useState(false);

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
      .then((res) => {
        // Descartar response viejo (usuario disparó request más nuevo).
        if (myId !== reqIdRef.current) return;
        // PERF-2 fix (audit 2026-06-22): el endpoint ahora paginate y devuelve
        // { tenants, total, limit, offset, sort }. Defensive: aceptar shape
        // viejo (array directo) por si un build cacheado del backend todavía
        // devuelve crudo. Eliminar el fallback cuando todos los environments
        // estén con el shape nuevo.
        const list = Array.isArray(res)
          ? res
          : Array.isArray(res?.tenants) ? res.tenants : [];
        setData(list);
        setLoading(false);
      })
      .catch((err) => {
        if (myId !== reqIdRef.current) return;
        setError(err?.message || 'No pudimos cargar el listado.');
        setData([]);
        setLoading(false);
      });
  };

  // PERF-4 fix (audit 2026-06-22): un solo useEffect con debounce
  // condicional. Antes había DOS effects (uno [mode], otro [search, mode]):
  // al cambiar mode con search no-vacío, ambos disparaban → 2 fetches al
  // backend (el reqIdRef descartaba uno, pero el query igual se ejecuta).
  // Ahora un solo effect: si search está vacío → fetch inmediato (mode
  // cambió); si search tiene contenido → debounce 300ms (mismo flow viejo
  // de search, pero ahora también cubre cambios de mode con search).
  // searchTrim memoizado para mantener la dependencia estable cuando el
  // user agrega espacios al final.
  const searchTrim = search.trim();
  useEffect(() => {
    const params = searchTrim
      ? { ...modeParams(mode), search: searchTrim }
      : modeParams(mode);
    // Sin search: fetch inmediato (cambio de mode no debe esperar).
    if (!searchTrim) {
      loadList(params);
      return undefined;
    }
    // Con search: debounce 300ms.
    const t = setTimeout(() => loadList(params), 300);
    return () => clearTimeout(t);
  }, [mode, searchTrim]);

  const clearFilters = () => {
    setSearch('');
    setMode('todas');
    // El useEffect arriba dispara loadList automáticamente porque mode
    // y/o searchTrim cambian. No necesitamos forzar reload manual.
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
            {/* #450: Exportar usa los filtros activos (modo + búsqueda) — el
                operador exporta exactamente lo que está viendo en pantalla.
                CSV con BOM UTF-8, abre en Excel/Numbers/Sheets sin config. */}
            <Btn
              icon="Download"
              onClick={async () => {
                setExporting(true);
                try {
                  await adminApi.exportTenants({
                    ...modeParams(mode),
                    ...(search.trim() ? { search: search.trim() } : {}),
                  });
                } catch (err) {
                  alert(err?.message || 'No pudimos exportar.');
                } finally {
                  setExporting(false);
                }
              }}
              disabled={exporting}
            >
              {exporting ? 'Exportando…' : 'Exportar'}
            </Btn>
            {/* #452: "Invitar cliente" abre el modal Crear tenant manual.
                Antes estaba en wait-state ("Próximamente"). */}
            <Btn
              kind="primary"
              icon="Plus"
              onClick={() => setCreateOpen(true)}
              title="Crear tenant manual"
            >
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
          <div className="flex-row u-gap-8">
            <div className="input-group u-w-240">
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
        {/* TANDA 6 a11y (audit 2026-06-22): caption sr-only + scope="col"
            en todos los <th>. Para screen readers la tabla ahora se anuncia
            con propósito ("Listado de clientes Tecny") y cada columna asocia
            sus celdas semánticamente. La columna 8 (chevron) lleva
            scope="col" igual pero queda sin texto visible. */}
        <table className="tbl tbl-row-click">
          <caption className="sr-only">
            Listado de clientes Tecny con plan, MRR, usuarios, salud, estado
            y actividad reciente. Cada fila navega al detalle del cliente.
          </caption>
          <thead>
            <tr>
              <th scope="col">Empresa</th>
              <th scope="col">Plan</th>
              <th scope="col" className="num">MRR</th>
              <th scope="col">Usuarios</th>
              <th scope="col">Salud</th>
              <th scope="col">Estado</th>
              <th scope="col">Actividad</th>
              <th scope="col" className="u-w-36">
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && data.length === 0 ? (
              // Skeleton: 5 rows con barras pulse mientras carga el primer fetch.
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={`skel-${i}`} className="tbl-skel-row">
                  <td><div className="skeleton" style={{ height: 16, width: '60%' }} /></td>
                  <td><div className="skeleton" style={{ height: 16, width: 48 }} /></td>
                  <td><div className="skeleton u-h-16-w-60" /></td>
                  <td><div className="skeleton" style={{ height: 16, width: 30 }} /></td>
                  <td><div className="skeleton" style={{ height: 16, width: 80 }} /></td>
                  <td><div className="skeleton" style={{ height: 16, width: 70 }} /></td>
                  <td><div className="skeleton u-h-16-w-60" /></td>
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
                // #440: pasamos el tenant entero — healthProxy preferirá
                // t.health_score si viene del backend; fallback al proxy viejo
                // basado en last_venta_at para cache stale tras deploy.
                const health = healthProxy(t);
                const hColor = healthColor(health, t.health_category);
                return (
                  <tr
                    key={t.id}
                    onClick={() => navigate('/clientes/' + t.id)}
                  >
                    <td>
                      <div className="flex-row u-gap-10">
                        <div className="company-logo">{tenantInitials(t.nombre)}</div>
                        <div>
                          <div className="u-fw-600">{t.nombre || '—'}</div>
                          <div className="muted tiny">{t.slug || ''}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={planTone(t.plan)}>{planLabel(t.plan)}</Badge>
                    </td>
                    <td className="num mono u-fw-600">
                      {(t.mrr_usd ?? 0) > 0 ? fmtMoney(t.mrr_usd) : '—'}
                    </td>
                    <td className="mono">{fmt(t.users_count ?? 0)}</td>
                    <td className="u-w-130px">
                      <div className="bar-track u-mb-3">
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

      {/* #452: modal Crear tenant manual abierto desde "Invitar cliente".
          Tras crear, refrescamos el listado para que el tenant nuevo aparezca
          inmediato (sin tener que recargar página) Y navegamos a su Ficha. */}
      <CreateTenantModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(res) => {
          setCreateOpen(false);
          // Refresh del listado: el tenant nuevo aparece de inmediato si el
          // user vuelve a /clientes desde la ficha. loadList con filtros
          // actuales para no perder el contexto de búsqueda.
          const params = searchTrim
            ? { ...modeParams(mode), search: searchTrim }
            : modeParams(mode);
          loadList(params);
          if (res?.tenant?.id) {
            navigate(`/clientes/${res.tenant.id}`);
          }
        }}
      />
    </>
  );
}
