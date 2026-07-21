/**
 * Modal "Cargar Venta B2B" — planilla spreadsheet con picker de stock.
 *
 * Análogo invertido del modal de Compra a Proveedor:
 *   - Compra a proveedor → entra stock al Inventario.
 *   - Venta B2B          → sale stock del Inventario.
 *
 * Cada fila tiene un buscador en la celda "Producto" que consulta
 * /api/inventario/productos?buscar=X&vista=no_vendidos en vivo. Al elegir un
 * producto, se autocompletan IMEI, GB, Color y se sugiere el precio_venta
 * cargado en stock. La cantidad por línea respeta el stock disponible.
 *
 * Cabecera: fecha · caja (donde entra el dinero) · TC si la caja no es USD.
 * Si no se elige caja, la venta queda como deuda del cliente (CC).
 *
 * Al guardar (1 TX backend):
 *   1. movimientos_cc (tipo=compra) + items con producto_id+cantidad.
 *   2. UPDATE productos SET cantidad -= cantidad por cada producto_id.
 *   3. Si caja_id → ingreso en caja_movimientos (origen='b2b').
 *   4. Stock insuficiente / producto inexistente → rollback total (409/404).
 */
import { useState, useMemo, useEffect, useRef } from 'react';
import { Icons } from './Icons';
import { cuentas as cuentasApi, inventario as invApi, cajas as cajasApi, redB2b } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmModal';
import AutocompletePicker from './AutocompletePicker';
import { headerTh as th, catalogosErrorBanner } from '../lib/spreadsheetStyles';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #M-11
import useSpreadsheetRows from '../lib/useSpreadsheetRows'; // #F-5
import TcWarning from './TcWarning';
import useModal from '../lib/useModal'; // U2 auditoría 2026-06
import CajaSelectHint from './CajaSelectHint';
// 2026-06-29 Multi-país F3: dropdowns moneda gated por tenant.pais.
import { useMonedasTenant } from '../lib/useMonedasTenant';


function todayISO() { return new Date().toLocaleDateString('sv'); }

const INITIAL_ROWS = 10;
const ADD_BATCH    = 10;

const mkRow = () => ({
  _id: Math.random().toString(36).slice(2),
  // Producto seleccionado (autocomplete)
  producto_id: null,
  nombre: '',        // texto que ve el usuario (puede ser libre si no hay match)
  imei: '',
  gb: '',
  color: '',
  stock_disp: null,  // cuántas unidades tiene en stock (informativo)
  // Costo del producto (snapshot al elegir del picker — informativo para que
  // el operador vea cuánto ganará al fijar el precio).
  costo:        null,
  costo_moneda: null,
  // Cantidad a vender y precio
  cantidad: '1',
  precio_unit: '',
  precio_moneda: 'USD',
});

const isUsedRow = (r) => !!(r.producto_id || r.nombre?.trim() || Number(r.precio_unit) > 0);

export default function VentaB2BModal({ cliente, onClose, onSaved }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  // 2026-06-29 Multi-país F3: USD + moneda local del tenant.
  const { monedaLocal } = useMonedasTenant();

  // #B-09: confirm-on-close si hay data cargada
  async function tryClose() {
    const usadas = rows.filter(isUsedRow).length;
    if (usadas === 0) return onClose();
    const ok = await confirm({
      title: 'Cerrar sin guardar',
      message: `Vas a perder ${usadas} fila${usadas > 1 ? 's' : ''} cargada${usadas > 1 ? 's' : ''}. ¿Seguro?`,
      confirmLabel: 'Cerrar y perder cambios',
      danger: true,
    });
    if (ok) onClose();
  }

  // ── Cabecera ────────────────────────────────────────────────────────
  const [fecha, setFecha]   = useState(todayISO());
  const [cajaId, setCajaId] = useState('');
  const [tc, setTc]         = useState('');
  const [descripcion, setDescripcion] = useState('');

  // ── Planilla ────────────────────────────────────────────────────────
  // #F-5: state + handlers comunes vienen del hook (R-01). Antes este
  // archivo replicaba rows/updCell/addRows/removeRow inline duplicando
  // ~25 líneas con CompraProveedorModal y CobranzaMasivaModal.
  const { rows, setRows, updCell, addRows, removeRow } = useSpreadsheetRows({
    mkRow,
    isUsedRow,
    initialCount: INITIAL_ROWS,
    addBatch: ADD_BATCH,
  });

  // ── Catálogos ───────────────────────────────────────────────────────
  const [cajas, setCajas]   = useState([]);
  const [saving, setSaving] = useState(false);
  const [catalogosError, setCatalogosError] = useState(null); // #H-12

  // 2026-06-28 PR-A audit Red B2B (UX-1 BLOCKER): pre-fetch active
  // partnerships para detectar si el cliente seleccionado es un partner
  // cross-tenant. Match exact-case por nombre (mismo criterio que
  // partnerships.accept en backend al linkear contactos). Si matchea,
  // el modal switchea el endpoint POST a /api/red-b2b/operations (en
  // lugar de /api/cuentas/movimientos) y muestra banner explicando la
  // replicación al partner.
  //
  // Por qué pre-fetch en el mount y no en backend resumen:
  //   - clientes_cc no tiene linked_tenant_id (es contactos quien lo
  //     tiene), y agregar un JOIN al resumen requiere tocar backend.
  //   - partnerships.list ya existe, está tenant-scoped y es barato
  //     (typical < 20 partners por tenant).
  //   - Si el partner se suspende mid-modal, el backend
  //     validateOperationPrecondition rebota con 409 al POST — lo
  //     surface en el toast.
  const [partnerships, setPartnerships] = useState([]);
  const [partnershipsError, setPartnershipsError] = useState(false);

  useEffect(() => {
    cajasApi.listCajas()
      .then(r => setCajas((r || []).filter(c => c.activo !== false)))
      .catch(() => { setCajas([]); setCatalogosError(['cajas']); });
    // Best-effort: si falla (user sin cap cross_tenant.write, server
    // error, etc.), el modal sigue funcionando como venta CC normal.
    // partnershipsError solo controla un warning visual leve si UNA
    // venta a un partner conocido falla por el fetch.
    redB2b.partnerships.list('active')
      .then(r => setPartnerships(r?.partnerships || []))
      .catch(() => { setPartnerships([]); setPartnershipsError(true); });
  }, []);

  // Detección de partner cross-tenant. Compara cliente.nombre (clientes_cc)
  // contra cada partner.nombre (tenants linked). Match exact-case porque
  // accept-partnership también es exact-case al linkear contactos (evita
  // colisiones accidentales tipo "TekHaus" vs "tekhaus").
  const matchedPartnership = useMemo(() => {
    if (!cliente?.nombre) return null;
    const clienteName = String(cliente.nombre).trim();
    if (!clienteName) return null;
    return partnerships.find(p =>
      p?.partner?.nombre && String(p.partner.nombre).trim() === clienteName
    ) || null;
  }, [cliente, partnerships]);

  const isCrossTenant = !!matchedPartnership;

  const monedaCaja = useMemo(() => {
    if (!cajaId) return 'USD';
    return cajas.find(c => String(c.id) === String(cajaId))?.moneda || 'USD';
  }, [cajaId, cajas]);

  // Total venta (USD). Si una fila tiene precio_moneda ≠ USD se convierte con el TC.
  const totalUsd = useMemo(() => {
    const tcN = Number(tc) || 0;
    return rows.reduce((acc, r) => {
      if (!isUsedRow(r)) return acc;
      const p = Number(r.precio_unit) || 0;
      const c = Number(r.cantidad) || 1;
      const sub = p * c;
      if (r.precio_moneda === 'USD') return acc + sub;
      if (!tcN) return acc;
      return acc + sub / tcN;
    }, 0);
  }, [rows, tc]);

  // ── Handlers ────────────────────────────────────────────────────────
  // updCell / addRows / removeRow vienen del hook. Solo dejamos los
  // handlers específicos de este modal (pick/clear producto).
  function pickProducto(idx, p) {
    setRows(rs => rs.map((r, i) => i !== idx ? r : {
      ...r,
      producto_id: p.id,
      nombre: p.nombre,
      imei:   p.imei || '',
      gb:     p.gb || '',
      color:  p.color || '',
      stock_disp: Number(p.cantidad ?? 0),
      // Snapshot del costo al momento de elegir del picker. Solo informativo
      // — el backend congela su propio snapshot en items_movimiento_cc.costo_unit.
      costo:        p.costo != null ? Number(p.costo) : null,
      costo_moneda: p.costo_moneda || null,
      precio_unit:   r.precio_unit || (p.precio_venta != null ? String(p.precio_venta) : ''),
      precio_moneda: r.precio_unit ? r.precio_moneda : (p.precio_moneda || 'USD'),
    }));
  }
  function clearProducto(idx) {
    setRows(rs => rs.map((r, i) => i !== idx ? r : {
      ...r, producto_id: null, stock_disp: null, imei: '', gb: '', color: '',
      costo: null, costo_moneda: null,
    }));
  }
  // Set de producto_id duplicados — el mismo producto unitario no puede
  // venderse dos veces en la misma venta. Si se cuela, el backend rebota
  // con "Inconsistencia al actualizar stock" (rowCount mismatch en el UPDATE
  // bulk). Detectamos en cliente para avisar inline antes de enviar.
  const dupProductoIds = (() => {
    const counts = new Map();
    for (const r of rows) {
      if (!r.producto_id) continue;
      counts.set(r.producto_id, (counts.get(r.producto_id) || 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id));
  })();
  const hayDuplicados = dupProductoIds.size > 0;

  function validar() {
    if (!fecha) return 'Falta la fecha';
    if (cajaId && monedaCaja !== 'USD' && (!Number(tc) || Number(tc) <= 0))
      return `Cargá el TC para convertir ${monedaCaja} → USD`;
    const used = rows.filter(isUsedRow);
    if (used.length === 0) return 'Cargá al menos un item';
    // Cross-tenant requiere TC > 0 sí o sí (el backend exige `tc` para
    // calcular total_ars del lado del buyer, schema z.coerce.number().positive()).
    if (isCrossTenant && (!Number(tc) || Number(tc) <= 0)) {
      return 'Esta venta se replica en el partner. Cargá el TC para convertir USD → ARS.';
    }
    // Chequeo de duplicados PRIMERO — mensaje específico con los IMEIs.
    if (hayDuplicados) {
      const dupRows = rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.producto_id && dupProductoIds.has(r.producto_id));
      const imeis = [...new Set(dupRows.map(({ r }) => r.imei || r.nombre || `#${r.producto_id}`))];
      return `Tenés productos repetidos: ${imeis.join(', ')}. Eliminá las filas duplicadas.`;
    }
    for (let i = 0; i < used.length; i++) {
      const r = used[i];
      if (!r.producto_id) return `Fila ${i + 1}: elegí un producto del stock`;
      if (!Number(r.precio_unit) || Number(r.precio_unit) <= 0) return `Fila ${i + 1}: cargá el precio`;
      const cant = Number(r.cantidad) || 0;
      if (cant <= 0) return `Fila ${i + 1}: la cantidad debe ser ≥ 1`;
      if (r.stock_disp != null && cant > r.stock_disp)
        return `Fila ${i + 1}: stock insuficiente (disponible ${r.stock_disp}, pedido ${cant})`;
      if (r.precio_moneda !== 'USD' && (!Number(tc) || Number(tc) <= 0))
        return `Fila ${i + 1}: precio en ${r.precio_moneda}, cargá el TC`;
    }
    return null;
  }

  async function handleGuardar() {
    const err = validar();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const used = rows.filter(isUsedRow);
      const tcN = Number(tc) || null;

      // 2026-06-28 PR-A audit Red B2B (UX-1 BLOCKER): switch del endpoint.
      // Si el cliente es un partner cross-tenant, POST a
      // /api/red-b2b/operations (crea ambos lados — venta del seller +
      // compra del buyer — atómico). Sino, POST normal a /api/cuentas
      // (movimientos CC local sin replicación).
      if (isCrossTenant) {
        // Mapeo del payload al schema createOperationSchema:
        //   { partnership_id, items: [{producto_id, cantidad, precio_usd}],
        //     tc, total_usd, total_ars, notes? }
        // total_ars = total_usd * tc (el server valida ±0.01 USD coherencia).
        const items = used.map(r => {
          const precioUsd = r.precio_moneda === 'USD'
            ? Number(r.precio_unit)
            : Number(r.precio_unit) / (tcN || 1);
          return {
            producto_id: Number(r.producto_id),
            cantidad:    Number(r.cantidad),
            precio_usd:  Number(precioUsd.toFixed(2)),
          };
        });
        const totalUsdN = Number(totalUsd.toFixed(2));
        const totalArsN = Number((totalUsdN * tcN).toFixed(2));
        const payload = {
          partnership_id: matchedPartnership.id,
          items,
          tc:        tcN,
          total_usd: totalUsdN,
          total_ars: totalArsN,
          notes:     descripcion.trim() || undefined,
        };
        const res = await redB2b.operations.create(payload);
        toast.success(
          `Venta cross-tenant registrada · ${used.length} ítem${used.length > 1 ? 's' : ''} · replicada en ${matchedPartnership.partner?.nombre || 'partner'}`
        );
        onSaved?.(res);
        onClose();
        return;
      }

      const payload = {
        cliente_cc_id: cliente.id,
        fecha,
        tipo: 'compra', // en B2B "compra" significa que el cliente nos compra (venta nuestra)
        descripcion: descripcion.trim() || null,
        monto_total: Number(totalUsd.toFixed(2)),
        caja_id: cajaId ? Number(cajaId) : null,
        items: used.map(r => {
          const subUsd = (Number(r.precio_unit) * Number(r.cantidad)) /
            (r.precio_moneda === 'USD' ? 1 : (tcN || 1));
          return {
            producto_id: r.producto_id,
            cantidad: Number(r.cantidad),
            // Mantenemos texto descriptivo para el log (legacy)
            producto:    r.nombre || null,
            imei_serial: r.imei || null,
            tamano:      r.gb || null,
            color:       r.color || null,
            valor:       Number(subUsd.toFixed(2)),
          };
        }),
      };
      const res = await cuentasApi.createMovimiento(payload);
      toast.success(`Venta registrada · ${used.length} ítem${used.length > 1 ? 's' : ''}`);
      onSaved?.(res);
      onClose();
    } catch (e) {
      toast.error(e.message || 'No se pudo guardar la venta');
    } finally {
      setSaving(false);
    }
  }

  // U2 auditoría 2026-06: useModal aplicado — Esc llama tryClose (con guarda
  // si hay data cargada), body scroll lock + restore focus al cerrar.
  const overlayRef = useRef(null);
  useModal({ open: true, onClose: tryClose, overlayRef });

  // Estilos compartidos vienen de lib/spreadsheetStyles
  return (
    <div ref={overlayRef} className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="b2b-modal-title"
         onClick={(e) => { if (e.target === e.currentTarget) tryClose(); }}>
      <div className="modal" style={{ maxWidth: 1700, width: '98vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <h3 id="b2b-modal-title">
            Cargar venta B2B · {cliente.nombre} {cliente.apellido || ''}
            {/* PR-A audit Red B2B (UX-1): badge inline en el header cuando el
                cliente es un partner cross-tenant. Title attr explica el
                comportamiento al hover. */}
            {isCrossTenant && (
              <span
                data-testid="b2b-cross-tenant-badge"
                title="Esta venta se va a replicar automáticamente en el partner Red B2B"
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.02em',
                  textTransform: 'uppercase',
                  padding: '2px 8px',
                  borderRadius: 12,
                  background: 'var(--accent-bg, rgba(59, 130, 246, 0.12))',
                  color: 'var(--accent, #2563eb)',
                  border: '1px solid var(--accent, #2563eb)',
                  verticalAlign: 'middle',
                }}
              >
                Red B2B
              </span>
            )}
          </h3>
          <button className="icon-btn" onClick={tryClose} aria-label="Cerrar modal"><Icons.X size={16} /></button>
        </div>

        <div className="modal-body" style={{ maxHeight: '85vh', overflowY: 'auto' }}>
          {/* PR-A audit Red B2B (UX-1 BLOCKER): banner inline cuando el
              cliente es un partner cross-tenant. Explica al seller que la
              operación se replicará al partner (inventario + CC bilateral). */}
          {isCrossTenant && (
            <div
              data-testid="b2b-cross-tenant-banner"
              role="status"
              style={{
                background: 'var(--accent-bg, rgba(59, 130, 246, 0.08))',
                border: '1px solid var(--accent, #2563eb)',
                color: 'var(--accent, #2563eb)',
                padding: '10px 12px',
                borderRadius: 8,
                marginBottom: 12,
                fontSize: 13,
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
              }}
            >
              <strong className="u-flex-shrink-0">Red B2B:</strong>
              <span>
                Esta venta se va a replicar automáticamente en{' '}
                <strong>{matchedPartnership.partner?.nombre || 'el partner'}</strong>.
                Su inventario va a aumentar y la cuenta corriente bilateral va a ajustarse.
                {/* Caja_id local NO se postea: el endpoint cross-tenant
                    arma la mov_cc del seller sin caja (queda como CC pura,
                    se cobra después vía /pagos). Avisamos para que el
                    operador no espere ver egreso/ingreso en una caja. */}
                <br />
                <span className="muted u-fs-12">
                  La cobranza se registra después desde Operaciones → Detalle.
                  El campo "Cobrar en" se ignora para esta venta.
                </span>
              </span>
            </div>
          )}
          {partnershipsError && cliente?.nombre && (
            <div
              data-testid="b2b-partnerships-fetch-warn"
              className="muted"
              style={{ fontSize: 11, marginBottom: 8 }}
            >
              No se pudo verificar partnerships Red B2B (sin permiso o error). La venta se guardará como CC local.
            </div>
          )}
          {/* #H-12: banner si catálogos fallaron */}
          {catalogosError && (
            <div style={catalogosErrorBanner}>
              ⚠ No se pudieron cargar: <strong>{catalogosError.join(', ')}</strong>.
              Cerrá/abrí el modal después de revisar tu conexión.
            </div>
          )}
          {/* ── Cabecera ── */}
          <div className="row u-mb-12">
            <div className="field u-flex-0-0-150">
              <label className="field-label">Fecha</label>
              <input type="date" className="input" value={fecha} onChange={e => setFecha(e.target.value)} />
            </div>
            <div className="field u-flex-1">
              <label className="field-label">Cobrar en</label>
              <select className="input" value={cajaId} onChange={e => setCajaId(e.target.value)}>
                <option value="">— Cuenta corriente (suma deuda) —</option>
                {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>)}
                <CajaSelectHint />
              </select>
            </div>
            {((cajaId && monedaCaja !== 'USD') || rows.some(r => isUsedRow(r) && r.precio_moneda !== 'USD')) && (
              <div className="field u-flex-0-0-140">
                <label className="field-label">TC →USD <span className="u-color-neg">*</span></label>
                <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" min="0" step="0.01"
                  value={tc} onChange={e => setTc(e.target.value)} placeholder="0" />
                <TcWarning tc={tc} />
              </div>
            )}
          </div>

          {/* ── Acciones ── */}
          <div className="flex-between u-mb-8">
            <div className="u-fs-13-fw-600">
              Items · {rows.filter(isUsedRow).length} usadas / {rows.length} filas
            </div>
            <button className="btn btn-sm" onClick={() => addRows(ADD_BATCH)}>
              + {ADD_BATCH} filas
            </button>
          </div>

          {/* ── Planilla ── */}
          {/* 2026-06-24 mobile lote C: la planilla tiene minWidth 1400 con
              12 columnas. En mobile el modal ya scrollea horizontalmente,
              pero sin indicador el usuario asume que está roto. */}
          <div className="bulk-spreadsheet-hint">↔ Desliza horizontalmente para ver todas las columnas</div>
          <div className="u-overflow-x-border-r-6">
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1400, tableLayout: 'fixed' }}>
              <colgroup>
                <col className="u-w-32px" />   {/* # */}
                <col style={{ width: 320 }} />  {/* Producto (picker) */}
                <col className="u-w-130px" />  {/* IMEI */}
                <col className="u-w-60px" />   {/* GB */}
                <col className="u-w-90px" />   {/* Color */}
                <col className="u-w-80px" />   {/* Stock */}
                <col className="u-w-100px" />  {/* Costo unit (2026-06-09) */}
                <col className="u-w-70px" />   {/* Cant */}
                <col className="u-w-100px" />  {/* Precio unit */}
                <col className="u-w-64" />   {/* M */}
                <col className="u-w-100px" />  {/* Subtotal */}
                <col className="u-w-32px" />   {/* X */}
              </colgroup>
              <thead>
                <tr>
                  {/* "Costo" agregado 2026-06-09 — informativo, no editable. Permite
                      ver de un vistazo cuánto se gana antes de cargar el precio. */}
                  {['#','Producto *','IMEI','GB','Color','Stock','Costo','Cant. *','Precio *','M.','Subtotal',''].map((h, i) =>
                    <th key={i} style={{ ...th, textAlign: i === 0 ? 'center' : 'left' }}>{h}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const used = isUsedRow(r);
                  const cant = Number(r.cantidad) || 0;
                  const exceeds = r.stock_disp != null && cant > r.stock_disp;
                  const dup = r.producto_id && dupProductoIds.has(r.producto_id);
                  const sub = (Number(r.precio_unit) || 0) * cant;
                  return (
                    <tr key={r._id}
                      // data-testid agregado para E2E (TANDA 5 B2B): las filas
                      // de la planilla son dinámicas (mkRow asigna `_id`
                      // aleatorio) y no tienen un wrapping accesible único.
                      // Sin testid, scopear inputs por fila requiere CSS frágil.
                      data-testid="b2b-item-row"
                      style={{
                      background: dup ? 'rgba(220, 38, 38, 0.08)'
                                      : used ? 'rgba(99,102,241,0.04)' : 'transparent',
                      borderTop: '1px solid var(--hairline)',
                    }}
                    title={dup ? 'IMEI duplicado en otra fila — eliminá una' : undefined}>
                      <td style={{ padding: '3px 6px', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>{idx + 1}</td>
                      <td className="u-p-3-4">
                        <ProductoPicker
                          value={r.nombre}
                          locked={!!r.producto_id}
                          onPick={p => pickProducto(idx, p)}
                          onClear={() => clearProducto(idx)}
                          onChange={v => updCell(idx, 'nombre', v)}
                        />
                      </td>
                      <td className="u-p-3-4">
                        <input className="cell-inp u-mono" style={{ opacity: r.producto_id ? 0.7 : 1 }}
                          value={r.imei} readOnly={!!r.producto_id} placeholder="—" />
                      </td>
                      <td className="u-p-3-4">
                        <input className="cell-inp u-text-right" style={{ opacity: r.producto_id ? 0.7 : 1 }}
                          value={r.gb} readOnly={!!r.producto_id} placeholder="—" />
                      </td>
                      <td className="u-p-3-4">
                        <input className="cell-inp" style={{ opacity: r.producto_id ? 0.7 : 1 }}
                          value={r.color} readOnly={!!r.producto_id} placeholder="—" />
                      </td>
                      <td style={{ padding: '3px 4px', textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>
                        {r.stock_disp != null ? r.stock_disp : '—'}
                      </td>
                      {/* Costo unit (2026-06-09) — informativo, snapshot del picker.
                          Si moneda del costo difiere de la del precio, mostramos igual
                          la moneda explícita para no confundir (ej. costo USD, precio ARS). */}
                      <td style={{ padding: '3px 4px', textAlign: 'right', fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                        {r.costo != null
                          ? `${r.costo_moneda || 'USD'} ${Number(r.costo).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`
                          : '—'}
                      </td>
                      <td className="u-p-3-4">
                        <input type="number" onKeyDown={blockInvalidNumberKeys} min="1"
                          className="cell-inp u-text-right"
                          style={{ borderColor: exceeds ? 'var(--neg)' : 'var(--border)' }}
                          value={r.cantidad}
                          onChange={e => updCell(idx, 'cantidad', e.target.value)} />
                      </td>
                      <td className="u-p-3-4">
                        {/* Si precio < costo en la misma moneda, fondo rojo tenue para
                            avisar que vende a pérdida. Comparamos solo cuando ambos
                            están en la misma moneda (sin TC para no inventar conversión). */}
                        {(() => {
                          const precioN = Number(r.precio_unit) || 0;
                          const mismaMoneda = r.costo != null && r.precio_moneda === (r.costo_moneda || 'USD');
                          const aPerdida = mismaMoneda && precioN > 0 && precioN < Number(r.costo);
                          return (
                            <input type="number" onKeyDown={blockInvalidNumberKeys} min="0"
                              className="cell-inp u-td-right-fw-700"
                              style={{
                                borderColor: aPerdida ? 'var(--neg)' : 'var(--border)',
                                background:  aPerdida ? 'rgba(220, 38, 38, 0.08)' : 'var(--surface)',
                              }}
                              title={aPerdida ? `Precio menor al costo (${r.costo_moneda || 'USD'} ${r.costo}) — vendés a pérdida` : undefined}
                              value={r.precio_unit} placeholder="0"
                              onChange={e => updCell(idx, 'precio_unit', e.target.value)} />
                          );
                        })()}
                      </td>
                      <td className="u-p-3-4">
                        {/* 2026-06-29 Multi-país F3: USD + moneda local. */}
                        <select className="cell-inp u-cursor-pointer" value={r.precio_moneda}
                          onChange={e => updCell(idx, 'precio_moneda', e.target.value)}>
                          {Array.from(new Set(['USD', monedaLocal, r.precio_moneda].filter(Boolean)))
                            .map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '3px 4px', textAlign: 'right', fontWeight: 600, fontSize: 12 }}>
                        {sub > 0 ? `${r.precio_moneda} ${sub.toLocaleString('es-AR', { maximumFractionDigits: 2 })}` : '—'}
                      </td>
                      <td className="u-p-3-4-text-center">
                        {rows.length > 1 && (
                          <button className="icon-btn" style={{ color: 'var(--neg)', padding: 2 }}
                            onClick={() => removeRow(idx)} title="Quitar fila">
                            <Icons.Trash size={12} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Descripción + Total ── */}
          <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
            <div className="field u-flex-1">
              <label className="field-label">Descripción / notas (opcional)</label>
              <input className="input" value={descripcion} onChange={e => setDescripcion(e.target.value)}
                placeholder="Ej. Pedido WhatsApp del 29/5" />
            </div>
            <div style={{ flex: '0 0 220px', textAlign: 'right' }}>
              <div className="muted tiny">Total venta</div>
              <div className="mono u-fs-22-fw-800">
                {/* #M-13: guion en vez de "USD 0" cuando no hay filas usadas. */}
                {rows.filter(isUsedRow).length === 0
                  ? <span className="muted">—</span>
                  : <>USD {totalUsd.toLocaleString('es-AR', { maximumFractionDigits: 2 })}</>}
              </div>
            </div>
          </div>
        </div>

        <div className="modal-ft">
          {hayDuplicados && (
            <div style={{
              flex: 1, fontSize: 12, color: 'var(--neg)', fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <Icons.Alert size={12} /> Hay {dupProductoIds.size} producto{dupProductoIds.size > 1 ? 's' : ''} repetido{dupProductoIds.size > 1 ? 's' : ''} (filas en rojo) — eliminá las duplicadas
            </div>
          )}
          <button className="btn btn-ghost" onClick={tryClose}>Cancelar</button>
          <button
            className="btn btn-primary"
            // data-testid agregado para E2E (TANDA 5 B2B): el label del botón
            // muta a "Guardando…" durante el async, lo que rompería un
            // selector por texto en el spec.
            data-testid="b2b-submit"
            disabled={saving || hayDuplicados}
            onClick={handleGuardar}
            title={hayDuplicados ? 'Resolvé los duplicados antes de guardar' : ''}
          >
            {saving ? 'Guardando…' : `Guardar venta (${rows.filter(isUsedRow).length})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Producto Picker (autocomplete en vivo) ──────────────────────────────
// Busca en /api/inventario/productos con vista=no_vendidos (productos vivos
// con stock > 0 y no ocultos). Muestra los 8 primeros matches al tipear ≥ 2
// chars. Click o Enter elige; X desbloquea para volver a buscar.
// Reemplazado por AutocompletePicker genérico (#R-03). La lógica de
// fetch/dropdown/teclado vive en components/AutocompletePicker.jsx. Acá
// solo configuramos el fetcher y el render de cada opción.
const PRODUCTO_LIMIT = 8;
function ProductoPicker({ value, locked, onPick, onClear, onChange }) {
  const fetchOptions = (q) =>
    invApi.productos({ buscar: q, vista: 'no_vendidos', limit: PRODUCTO_LIMIT + 1 })
      .then(res => (res.data || []).slice(0, PRODUCTO_LIMIT));
  return (
    <AutocompletePicker
      value={value} onChange={onChange}
      locked={locked} onClear={onClear} onPick={onPick}
      fetchOptions={fetchOptions}
      getOptionKey={(p) => p.id}
      placeholder="Buscar nombre o IMEI…"
      emptyText="Sin coincidencias en stock"
      limit={PRODUCTO_LIMIT}
      renderOption={(p) => (
        <>
          <div className="u-fw-600">
            {p.nombre}
            <span className="muted tiny u-ml-6">
              {p.gb && `${p.gb}GB`}{p.gb && p.color && ' · '}{p.color}
            </span>
          </div>
          <div className="muted tiny" style={{ display: 'flex', gap: 10 }}>
            {p.imei && <span style={{ fontFamily: 'monospace' }}>IMEI {p.imei}</span>}
            <span>Stock: {p.cantidad}</span>
            {p.precio_venta != null && <span>Precio sugerido: USD {p.precio_venta}</span>}
          </div>
        </>
      )}
    />
  );
}
