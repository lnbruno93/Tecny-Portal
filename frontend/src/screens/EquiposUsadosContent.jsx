// EquiposUsadosContent.jsx — 2026-07-11
//
// Contenido del tab "Equipos usados" en Inventario. Componente separado del
// Inventario.jsx principal (ya ~2500 LOC) para mantener el archivo grande
// legible.
//
// Consume GET /api/inventario/usados que filtra productos.condicion='usado'
// y trae trazabilidad de origen (LEFT JOIN a canjes → ventas → contactos):
//
//   - origen: 'canje' | 'manual'
//   - canje_origen: null | { venta_id, venta_order_id, venta_fecha,
//                            cliente_nombre, cliente_telefono }
//
// KPIs arriba:
//   1. Count total de usados en stock (respeta filtro `estado`).
//   2. Count de los que vinieron por canje (% del total).
//   3. Inversión total (SUM(costo) para los que canseecostos, USD).
//
// Filtros: buscar (nombre + IMEI + cliente), solo_canjes toggle, estado.
// Sin filtros de fecha en la primera versión (se pueden agregar si Lucas
// los pide — el schema del endpoint ya los acepta).
//
// Interacciones:
//   - Click en badge de canje → link a /ventas?buscar=<order_id> para
//     abrir la venta de origen (mismo pattern que el chip de drill-down).

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../components/Icons';
import { inventario } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import Seg from '../components/Seg';
// 2026-07-11: panel del operador para gestionar el share link público
// de Equipos Usados. Vive arriba de los KPIs, colapsable.
import ShareLinkPanel from './ShareLinkPanel';

function fmtN(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('es-AR', { maximumFractionDigits: 0 });
}

function fmtFecha(s) {
  if (!s) return '';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : s;
}

// Batería con color según nivel. Convenio del negocio revendedor:
//   ≥ 85% → verde (equipo vendible sin service)
//   75-84 → amarillo (aceptable, negociar precio)
//   < 75  → rojo (probablemente reparar antes de vender)
function BateriaBadge({ valor }) {
  if (valor == null || valor === '') return <span className="muted">—</span>;
  const v = Number(valor);
  if (!Number.isFinite(v)) return <span className="muted">—</span>;
  const tono = v >= 85 ? 'pos' : v >= 75 ? 'warn' : 'neg';
  return (
    <span className={`badge badge-${tono} u-tnum`}>
      {v}%
    </span>
  );
}

export default function EquiposUsadosContent({ onCountChange }) {
  // useToast() devuelve `{ toast }` (ver ToastContext) — hay que destructurar.
  const { toast } = useToast();

  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);

  // Filtros
  const [buscar, setBuscar] = useState('');
  const dBuscar = useDebouncedValue(buscar, 300);
  // 2026-07-11: filtro origen refactor de bool → 3-way seg.
  // 'todos'  → sin filtro por origen (default).
  // 'canjes' → solo los que vinieron por canje (parte de pago de una venta).
  // 'manual' → solo los que se cargaron por afuera del flujo canje: compra
  //            externa (lote de usados a proveedor), carga manual desde el
  //            form, o cualquier otro path que no genere fila en `canjes`.
  //            Feedback de Lucas 2026-07-11: los tenants compran lotes de
  //            usados regularmente y necesitan verlos separados.
  const [origen, setOrigen] = useState('todos');
  const [estado, setEstado] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 50 };
      if (dBuscar) params.buscar = dBuscar;
      if (origen === 'canjes') params.solo_canjes = 'true';
      else if (origen === 'manual') params.solo_manual = 'true';
      if (estado) params.estado = estado;
      const r = await inventario.usados(params);
      setItems(Array.isArray(r?.data) ? r.data : []);
      setPagination(r?.pagination || { page: 1, limit: 50, total: 0, pages: 1 });
      // Callback al padre para sincronizar el badge del tab.
      if (onCountChange) onCountChange(r?.pagination?.total ?? 0);
    } catch (e) {
      toast.error(`No se pudo cargar equipos usados: ${e?.message || e}`);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [dBuscar, origen, estado, page, toast, onCountChange]);

  useEffect(() => { load(); }, [load]);

  // Al cambiar filtros, volver a página 1 (sin este reset, si estás en la
  // página 5 y buscás algo que tiene 2 resultados, ves lista vacía).
  useEffect(() => { setPage(1); }, [dBuscar, origen, estado]);

  // 2026-07-11 (Lucas): botón "Copiar listado". Los tenants arman diariamente
  // un listado de usados para enviar por WhatsApp a clientes. El copy genera
  // solo las filas de equipos en formato "Nombre | Color | GBGB | Bat% — USD X"
  // y el operador después le agrega emojis / encabezado / cierre marketing en
  // su template.
  //
  // Reglas:
  //   - Solo estado='disponible' (los otros no van al público — vendidos,
  //     en_tecnico, reservados NO se comparten).
  //   - Si falta color / GB / batería → se salta ese campo (no dejamos
  //     separadores vacíos "iPh 17 |  | 256GB").
  //   - Sin precio de venta → se salta el equipo entero (no publicás sin
  //     precio).
  //   - Moneda: usa `precio_moneda` (default USD). Formato de miles con
  //     separador es-AR (1.420).
  const copiarListado = useCallback(async () => {
    const disponibles = items
      .filter(p => p.estado === 'disponible')
      .filter(p => Number(p.precio_venta) > 0);
    if (disponibles.length === 0) {
      toast.error('No hay equipos disponibles con precio para copiar.');
      return;
    }
    const lineas = disponibles.map(p => {
      const partes = [p.nombre];
      if (p.color) partes.push(String(p.color).trim());
      if (p.gb)    partes.push(`${String(p.gb).trim()}GB`);
      if (p.bateria != null && p.bateria !== '') partes.push(`${p.bateria}%`);
      const cabeza = partes.join(' | ');
      const moneda = p.precio_moneda || 'USD';
      const precio = Number(p.precio_venta).toLocaleString('es-AR', { maximumFractionDigits: 0 });
      return `${cabeza} — ${moneda} ${precio}`;
    });
    const texto = lineas.join('\n');
    try {
      await navigator.clipboard.writeText(texto);
      const skipped = items.length - disponibles.length;
      const extra = skipped > 0 ? ` (${skipped} filtrados: no disponibles o sin precio)` : '';
      toast.success(`Copiados ${disponibles.length} equipos al portapapeles${extra}`);
    } catch (_e) {
      toast.error('No se pudo copiar. Copiá manualmente desde la tabla.');
    }
  }, [items, toast]);

  // KPIs calculados desde el response actual. Nota: `origenCanjeCount` es
  // sobre el response de la página actual — no el total global. Para el
  // dato global habría que hacer una segunda query agregada. La aproximación
  // es aceptable en la primera versión: si hay >50 resultados el operador
  // puede paginar o filtrar.
  const kpis = useMemo(() => {
    const totalGlobal = pagination.total || 0;
    const origenCanjeEnPagina = items.filter(p => p.origen === 'canje').length;
    // Inversión = SUM(costo * cantidad) para las filas visibles con USD.
    // Los productos sin cap ver_costos vienen sin `costo` — se saltean.
    const invUsd = items.reduce((acc, p) => {
      if (p.costo_moneda !== 'USD') return acc;
      const c = Number(p.costo);
      const q = Number(p.cantidad) || 1;
      return acc + (Number.isFinite(c) ? c * q : 0);
    }, 0);
    return {
      totalGlobal,
      origenCanjeEnPagina,
      pctCanje: items.length > 0 ? Math.round((origenCanjeEnPagina / items.length) * 100) : 0,
      invUsd,
    };
  }, [items, pagination.total]);

  return (
    <div>
      {/* ── Panel del share link público (2026-07-11) ────────── */}
      <ShareLinkPanel />

      {/* ── KPIs mini ─────────────────────────────────────────── */}
      <div className="kpi-grid u-mb-16">
        <div className="card card-tight">
          <div className="kpi-label">Equipos usados</div>
          <div className="kpi-value">{fmtN(kpis.totalGlobal)}</div>
          <div className="muted tiny">Total en stock (todos los estados)</div>
        </div>
        <div className="card card-tight">
          <div className="kpi-label">Origen canje</div>
          <div className="kpi-value">
            {fmtN(kpis.origenCanjeEnPagina)}{' '}
            <span className="muted u-fs-13-fw-500">
              ({kpis.pctCanje}%)
            </span>
          </div>
          <div className="muted tiny">Ingresados como parte de pago</div>
        </div>
        <div className="card card-tight">
          <div className="kpi-label">Inversión (página)</div>
          <div className="kpi-value">
            <span className="ccy u-usados-kpi-ccy">USD </span>
            {fmtN(kpis.invUsd)}
          </div>
          <div className="muted tiny">Suma de costos USD de esta página</div>
        </div>
      </div>

      {/* ── Filtros ───────────────────────────────────────────── */}
      <div className="flex-row u-gap-10-mb-12-wrap-center">
        <input
          className="input u-usados-search-input"
          placeholder="Buscar nombre, IMEI, cliente…"
          value={buscar}
          onChange={e => setBuscar(e.target.value)}
        />
        {/* 2026-07-11: Seg reemplaza el toggle "Solo canjes" (bool). Los
            tenants necesitan diferenciar los canjes (parte de pago) de las
            compras externas (lotes de usados). "Todos" es el default. */}
        <Seg
          value={origen}
          options={[
            { value: 'todos',  label: 'Todos' },
            { value: 'canjes', label: 'Canjes' },
            { value: 'manual', label: 'Carga manual' },
          ]}
          onChange={setOrigen}
        />
        <select className="input" value={estado} onChange={e => setEstado(e.target.value)} className="u-mw-180-max">
          <option value="">Todos los estados</option>
          <option value="disponible">Disponible</option>
          <option value="vendido">Vendido</option>
          <option value="en_tecnico">En técnico</option>
          <option value="reservado">Reservado</option>
        </select>
        <div className="u-flex-1" />
        {/* 2026-07-11 (Lucas): copy del listado para WhatsApp de venta a clientes.
            Ver `copiarListado` para las reglas de filtro (solo disponibles con precio). */}
        <button
          className="btn btn-sm"
          onClick={copiarListado}
          disabled={loading || items.length === 0}
          title="Copia los equipos disponibles con formato 'Nombre | Color | GBGB | Bat% — USD Precio' para pegar en WhatsApp"
        >
          <Icons.Copy size={13} /> Copiar listado
        </button>
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          <Icons.Refresh size={13} /> Actualizar
        </button>
      </div>

      {/* ── Tabla ─────────────────────────────────────────────── */}
      {loading ? (
        <div className="card card-tight" aria-busy="true" aria-live="polite">
          <div className="muted u-p-20-text-center">Cargando equipos usados…</div>
        </div>
      ) : items.length === 0 ? (
        <div className="empty u-p-28-16">
          <div className="u-fw-600-mb-6">Sin resultados</div>
          <div className="muted tiny">
            {buscar || origen !== 'todos' || estado
              ? 'No hay equipos usados que coincidan con los filtros aplicados.'
              : 'Todavía no ingresaron equipos usados a tu stock. Cuando registres una venta con canje "A inventario" tildado, o cargues un producto con condición Usado, van a aparecer acá.'}
          </div>
        </div>
      ) : (
        <div className="card card-flush u-overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="u-mw-180">Equipo</th>
                <th className="u-w-120px">GB · Color</th>
                <th className="u-w-90px">Batería</th>
                <th className="u-w-142-nowrap">IMEI / Serial</th>
                <th className="u-w-100-td-right">Costo</th>
                <th className="u-w-100-td-right">Precio venta</th>
                <th className="u-w-130px">Origen</th>
                <th className="u-mw-170">Cliente que lo entregó</th>
                <th className="u-w-96">Ingresó</th>
                <th className="u-w-100px">Estado</th>
              </tr>
            </thead>
            <tbody>
              {items.map(p => (
                <UsadoRow key={p.id} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Paginación ───────────────────────────────────────── */}
      {!loading && pagination.pages > 1 && (
        <div className="flex-row u-gap-8-center-mt-14">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            ‹ Anterior
          </button>
          <span className="muted tiny u-self-center">
            {pagination.page} / {pagination.pages} · {pagination.total} equipos
          </span>
          <button className="btn btn-sm" disabled={page >= pagination.pages} onClick={() => setPage(p => p + 1)}>
            Siguiente ›
          </button>
        </div>
      )}
    </div>
  );
}

// ── UsadoRow ──────────────────────────────────────────────────
// Fila de la tabla. Componente separado por 2 razones:
//   1. Legibilidad — la fila tiene bastantes columnas y celdas custom.
//   2. Reuso futuro — si sale un endpoint que solo devuelve N usados
//      (Dashboard, KPI drill-down), la fila se reutiliza.
function UsadoRow({ p }) {
  const origenCanje = p.origen === 'canje' && p.canje_origen;
  const orderId = origenCanje ? p.canje_origen.venta_order_id : null;

  return (
    <tr>
      <td>
        <div className="u-flex-col-gap-2">
          <span className="u-fw-500">{p.nombre || '—'}</span>
          {p.clase_nombre && (
            <span className="muted tiny">
              {p.clase_emoji ? `${p.clase_emoji} ` : ''}{p.clase_nombre}
            </span>
          )}
        </div>
      </td>
      <td className="muted tiny">
        {[p.gb, p.color].filter(Boolean).join(' · ') || '—'}
      </td>
      <td>
        <BateriaBadge valor={p.bateria} />
      </td>
      <td className="mono tiny nowrap">{p.imei || <span className="muted">—</span>}</td>
      <td className="right mono">
        {p.costo != null ? (
          <>
            <span className="ccy u-fs-11-muted-mr-3">
              {p.costo_moneda || 'USD'}
            </span>
            {fmtN(p.costo)}
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="right mono">
        {p.precio_venta ? (
          <>
            <span className="ccy u-fs-11-muted-mr-3">
              {p.precio_moneda || 'USD'}
            </span>
            {fmtN(p.precio_venta)}
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        {origenCanje ? (
          // Badge clickeable → abre Ventas con el order_id como filtro.
          // Preserva el contexto del operador (puede volver con back del browser).
          <Link
            to={`/ventas?buscar=${encodeURIComponent(orderId)}`}
            className="badge badge-info u-usados-order-badge"
            title={`Abrir venta ${orderId}`}
          >
            {orderId}
            <Icons.ArrowUpRight size={11} />
          </Link>
        ) : (
          <span className="badge u-color-text-muted">Manual</span>
        )}
      </td>
      <td>
        {origenCanje ? (
          <div className="u-flex-col-gap-2">
            <span>{p.canje_origen.cliente_nombre || <span className="muted">Cliente no informado</span>}</span>
            {p.canje_origen.cliente_telefono && (
              <span className="muted tiny">{p.canje_origen.cliente_telefono}</span>
            )}
          </div>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="muted tiny">
        {origenCanje && p.canje_origen.venta_fecha
          ? fmtFecha(p.canje_origen.venta_fecha)
          : fmtFecha(p.created_at)}
      </td>
      <td>
        <EstadoBadge estado={p.estado} />
      </td>
    </tr>
  );
}

function EstadoBadge({ estado }) {
  const map = {
    disponible: { tone: 'pos', label: 'Disponible' },
    vendido:    { tone: '',    label: 'Vendido' },
    en_tecnico: { tone: 'warn', label: 'En técnico' },
    reservado:  { tone: 'info', label: 'Reservado' },
  };
  const cfg = map[estado] || { tone: '', label: estado || '—' };
  return <span className={`badge ${cfg.tone ? `badge-${cfg.tone}` : ''}`}>{cfg.label}</span>;
}
