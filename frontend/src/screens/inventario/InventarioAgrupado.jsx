// InventarioAgrupado — vista alternativa de la grilla de Inventario donde
// las filas se agrupan por (Categoría, Nombre, GB). Color y batería NO
// separan grupos: un "15 Pro 256 Silver 93%" se agrupa con un "15 Pro
// 256 Blue 98%". Pedido cliente Nook Tech, task #279 (2026-08-01).
//
// El componente:
//   1. Fetch inicial: `inventario.productosAgrupado(params)` → lista de
//      grupos con counts + rangos precio/batería.
//   2. Cada grupo se renderiza como una fila-header colapsada con chevron.
//   3. Al hacer click en el chevron/nombre: fetch de los productos
//      individuales del grupo con `inventario.productos({...params,
//      clase_id, nombre, gb})` — cache local para no re-fetchear.
//   4. Filas expandidas usan el MISMO `<InventarioRow>` que la lista
//      normal — misma edición inline, mismos handlers.
//
// Trade-off consciente: hacemos 1 fetch por grupo expandido en vez de
// pre-cargar todo. Para tenants con 100+ grupos, la lazy load evita
// bloquear el primer render con miles de productos.

import { useCallback, useEffect, useState, memo } from 'react';
import { inventario } from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';
import Icons from '../../components/Icons';
import { fmtMoney } from '../../lib/format';
import { SkeletonRow } from '../../components/Skeleton';

// ─────────────────────────────────────────────────────────────────────────
// GrupoRow — fila header + filas expandidas.
// Memoizado para no re-renderizar cuando cambia otro grupo hermano.
// ─────────────────────────────────────────────────────────────────────────
const GrupoRow = memo(function GrupoRow({
  grupo,
  baseParams,
  monedaLocal,
  provOptions,
  canEditProducto,
  canDeleteProducto,
  canSeeCostos,
  inlineUpdate,
  openEdit,
  handleDelete,
  onOpenHistorial,
  InventarioRow,
}) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [productos, setProductos] = useState(null); // null = no cargado; [] = cargado vacío; [...] = cargado
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // Al hacer click en el chevron: si nunca cargamos productos de este grupo,
  // hacemos el fetch. Sino, solo togglea expanded.
  const toggle = useCallback(async () => {
    const willExpand = !expanded;
    setExpanded(willExpand);
    if (willExpand && productos === null && !loading) {
      setLoading(true);
      setErr(null);
      try {
        // Params del filtro global + drill-down por el grupo específico.
        // limit=200 (max del backend) — muy raro que un grupo tenga 200+
        // productos del mismo modelo. Si pasa, mostrar mensaje "primeros 200".
        const params = {
          ...baseParams,
          clase_id: grupo.clase_id || undefined,
          nombre: grupo.nombre,
          gb: grupo.gb || undefined,
          // NO paginamos dentro del grupo: pedimos todo lo que haya.
          page: 1,
          limit: 200,
        };
        // Sacamos claves undefined para no ensuciar el query string.
        Object.keys(params).forEach(k => params[k] === undefined && delete params[k]);
        const res = await inventario.productos(params);
        setProductos(res.data || []);
      } catch (e) {
        setErr(e?.message || 'No se pudieron cargar los productos');
        toast.error(e?.message || 'Error');
      } finally {
        setLoading(false);
      }
    }
  }, [expanded, productos, loading, baseParams, grupo, toast]);

  const rangeBateria = (grupo.bateria_min != null && grupo.bateria_max != null)
    ? (grupo.bateria_min === grupo.bateria_max
        ? `${grupo.bateria_max}%`
        : `${grupo.bateria_min}–${grupo.bateria_max}%`)
    : '—';

  const rangePrecio = (grupo.precio_min != null && grupo.precio_max != null)
    ? (Number(grupo.precio_min) === Number(grupo.precio_max)
        ? fmtMoney(grupo.precio_max, 'USD')
        : `${fmtMoney(grupo.precio_min, 'USD')}–${fmtMoney(grupo.precio_max, 'USD')}`)
    : '—';

  return (
    <>
      {/* Header del grupo — clickeable en toda la fila. Chevron rota al expandir.
          `cursor:pointer` lo aporta la clase `.inv-grupo-header` (styles.css). */}
      <tr
        data-testid="inv-grupo-header"
        onClick={toggle}
        className="inv-grupo-header"
      >
        <td colSpan={15}>
          <div className="inv-grupo-header-content">
            {/* Chevron */}
            <span className="inv-grupo-chevron" aria-hidden="true">
              {expanded ? <Icons.ChevronDown size={16} /> : <Icons.ChevronRight size={16} />}
            </span>
            {/* Categoría (emoji + nombre) */}
            <span className="inv-grupo-cat" title={grupo.clase_nombre}>
              <span aria-hidden="true">{grupo.clase_emoji}</span>{' '}
              <span className="muted tiny">{grupo.clase_nombre}</span>
            </span>
            {/* Modelo + GB */}
            <span className="inv-grupo-nombre">
              <strong>{grupo.nombre}</strong>
              {grupo.gb && <span className="mono u-ml-6">{grupo.gb}GB</span>}
            </span>
            {/* Counts: total + breakdown por estado */}
            <span className="inv-grupo-counts">
              <strong>{grupo.count_total}</strong>
              <span className="muted tiny">
                {' unidades ('}
                {grupo.count_disponible > 0 && <span className="pos">{grupo.count_disponible} disp</span>}
                {grupo.count_vendido > 0 && (
                  <>{grupo.count_disponible > 0 ? ' · ' : ''}<span className="muted">{grupo.count_vendido} vend</span></>
                )}
                {grupo.count_reservado > 0 && (
                  <>{(grupo.count_disponible + grupo.count_vendido) > 0 ? ' · ' : ''}<span className="warn">{grupo.count_reservado} res</span></>
                )}
                {grupo.count_en_tecnico > 0 && (
                  <>{(grupo.count_disponible + grupo.count_vendido + grupo.count_reservado) > 0 ? ' · ' : ''}<span className="muted">{grupo.count_en_tecnico} téc</span></>
                )}
                {')'}
              </span>
            </span>
            {/* Rangos precio + batería. En mobile se ocultan por overflow. */}
            <span className="inv-grupo-precio muted tiny" title="Rango de precios de venta">
              {rangePrecio}
            </span>
            <span className="inv-grupo-bateria muted tiny" title="Rango de batería">
              🔋 {rangeBateria}
            </span>
          </div>
        </td>
      </tr>

      {/* Filas expandidas: usan el MISMO InventarioRow que la lista plana. */}
      {expanded && loading && (
        <tr><td colSpan={15}><div className="u-p-8-center muted tiny">Cargando…</div></td></tr>
      )}
      {expanded && err && (
        <tr><td colSpan={15}><div className="u-p-8-center inv-agrupado-error">Error: {err}</div></td></tr>
      )}
      {expanded && !loading && productos && productos.length === 0 && (
        <tr><td colSpan={15}><div className="u-p-8-center muted tiny">Sin productos en este grupo (¿filtro cambió mientras estaba cargado?)</div></td></tr>
      )}
      {expanded && !loading && productos && productos.length > 0 && productos.map(p => (
        <InventarioRow
          key={p.id}
          p={p}
          monedaLocal={monedaLocal}
          provOptions={provOptions}
          canEditProducto={canEditProducto}
          canDeleteProducto={canDeleteProducto}
          inlineUpdate={inlineUpdate}
          openEdit={openEdit}
          handleDelete={handleDelete}
          onOpenHistorial={onOpenHistorial}
        />
      ))}
    </>
  );
});

// ─────────────────────────────────────────────────────────────────────────
// InventarioAgrupado — componente principal.
//
// Recibe los mismos params que loadProductos construye en Inventario.jsx
// (page, limit, vista, clase_id, etc.) más las props de InventarioRow
// necesarias para renderizar las filas expandidas.
// ─────────────────────────────────────────────────────────────────────────
export default function InventarioAgrupado({
  params,             // filtros globales (misma shape que loadProductos)
  monedaLocal,
  provOptions,
  canEditProducto,
  canDeleteProducto,
  canSeeCostos,
  inlineUpdate,
  openEdit,
  handleDelete,
  onOpenHistorial,
  InventarioRow,      // pasado por prop desde Inventario.jsx (evita import circular)
  onTotalsChange,     // callback opcional para propagar {total, pages} al parent
}) {
  const { toast } = useToast();
  const [grupos, setGrupos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  // Serializamos params para el effect dep. JSON.stringify es suficiente
  // dado que los valores son primitivos (strings, numbers, undefined).
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    inventario.productosAgrupado(params)
      .then(res => {
        if (cancelled) return;
        setGrupos(res.data || []);
        setTotal(res.pagination?.total || 0);
        if (onTotalsChange) onTotalsChange({ total: res.pagination?.total || 0, pages: res.pagination?.pages || 1 });
      })
      .catch(e => {
        if (cancelled) return;
        toast.error(e?.message || 'No se pudo cargar la vista agrupada');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  if (loading) {
    return (
      <div className="card card-flush u-overflow-x-auto" aria-busy="true" aria-live="polite">
        <table className="table table-compact">
          <tbody>{Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} columns={15} />)}</tbody>
        </table>
      </div>
    );
  }

  if (grupos.length === 0) {
    return (
      <div className="empty u-p-28-16">
        <div className="u-fw-600-mb-6">Sin grupos</div>
        <div className="muted tiny">No hay productos que coincidan con los filtros aplicados.</div>
      </div>
    );
  }

  return (
    <div className="card card-flush u-overflow-x-auto">
      <table className="table table-compact inv-agrupado-table">
        <thead>
          <tr>
            <th colSpan={15} className="muted tiny u-p-8-14">
              {total} grupo{total !== 1 ? 's' : ''} · click en cada grupo para ver los equipos
            </th>
          </tr>
        </thead>
        <tbody>
          {grupos.map(g => (
            <GrupoRow
              key={g.key}
              grupo={g}
              baseParams={params}
              monedaLocal={monedaLocal}
              provOptions={provOptions}
              canEditProducto={canEditProducto}
              canDeleteProducto={canDeleteProducto}
              canSeeCostos={canSeeCostos}
              inlineUpdate={inlineUpdate}
              openEdit={openEdit}
              handleDelete={handleDelete}
              onOpenHistorial={onOpenHistorial}
              InventarioRow={InventarioRow}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
