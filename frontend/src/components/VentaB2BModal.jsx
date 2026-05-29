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
import { useState, useMemo, useEffect } from 'react';
import { Icons } from './Icons';
import { cuentas as cuentasApi, inventario as invApi, cajas as cajasApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmModal';
import AutocompletePicker from './AutocompletePicker';
import { cellInp, headerTh as th, catalogosErrorBanner } from '../lib/spreadsheetStyles';

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
  // Cantidad a vender y precio
  cantidad: '1',
  precio_unit: '',
  precio_moneda: 'USD',
});

const isUsedRow = (r) => !!(r.producto_id || r.nombre?.trim() || Number(r.precio_unit) > 0);

export default function VentaB2BModal({ cliente, onClose, onSaved }) {
  const { toast } = useToast();
  const confirm = useConfirm();

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
  const [rows, setRows] = useState(() =>
    Array.from({ length: INITIAL_ROWS }, () => mkRow())
  );

  // ── Catálogos ───────────────────────────────────────────────────────
  const [cajas, setCajas]   = useState([]);
  const [saving, setSaving] = useState(false);
  const [catalogosError, setCatalogosError] = useState(null); // #H-12

  useEffect(() => {
    cajasApi.listCajas()
      .then(r => setCajas((r || []).filter(c => c.activo !== false)))
      .catch(() => { setCajas([]); setCatalogosError(['cajas']); });
  }, []);

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
  function updCell(idx, field, val) {
    setRows(rs => rs.map((r, i) => i === idx ? { ...r, [field]: val } : r));
  }
  function pickProducto(idx, p) {
    setRows(rs => rs.map((r, i) => i !== idx ? r : {
      ...r,
      producto_id: p.id,
      nombre: p.nombre,
      imei:   p.imei || '',
      gb:     p.gb || '',
      color:  p.color || '',
      stock_disp: Number(p.cantidad ?? 0),
      precio_unit:   r.precio_unit || (p.precio_venta != null ? String(p.precio_venta) : ''),
      precio_moneda: r.precio_unit ? r.precio_moneda : (p.precio_moneda || 'USD'),
    }));
  }
  function clearProducto(idx) {
    setRows(rs => rs.map((r, i) => i !== idx ? r : {
      ...r, producto_id: null, stock_disp: null, imei: '', gb: '', color: '',
    }));
  }
  function addRows(n = ADD_BATCH) {
    setRows(rs => [...rs, ...Array.from({ length: n }, () => mkRow())]);
  }
  function removeRow(idx) {
    setRows(rs => rs.length <= 1 ? rs : rs.filter((_, i) => i !== idx));
  }

  function validar() {
    if (!fecha) return 'Falta la fecha';
    if (cajaId && monedaCaja !== 'USD' && (!Number(tc) || Number(tc) <= 0))
      return `Cargá el TC para convertir ${monedaCaja} → USD`;
    const used = rows.filter(isUsedRow);
    if (used.length === 0) return 'Cargá al menos un item';
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

  // Estilos compartidos vienen de lib/spreadsheetStyles
  return (
    <div className="modal-overlay" onClick={tryClose}>
      <div className="modal" style={{ maxWidth: 1700, width: '98vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <h3>Cargar venta B2B · {cliente.nombre} {cliente.apellido || ''}</h3>
          <button className="icon-btn" onClick={tryClose}><Icons.X size={16} /></button>
        </div>

        <div className="modal-body" style={{ maxHeight: '85vh', overflowY: 'auto' }}>
          {/* #H-12: banner si catálogos fallaron */}
          {catalogosError && (
            <div style={catalogosErrorBanner}>
              ⚠ No se pudieron cargar: <strong>{catalogosError.join(', ')}</strong>.
              Cerrá/abrí el modal después de revisar tu conexión.
            </div>
          )}
          {/* ── Cabecera ── */}
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="field" style={{ flex: '0 0 150px' }}>
              <label className="field-label">Fecha</label>
              <input type="date" className="input" value={fecha} onChange={e => setFecha(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label">Cobrar en</label>
              <select className="input" value={cajaId} onChange={e => setCajaId(e.target.value)}>
                <option value="">— Cuenta corriente (suma deuda) —</option>
                {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>)}
              </select>
            </div>
            {((cajaId && monedaCaja !== 'USD') || rows.some(r => isUsedRow(r) && r.precio_moneda !== 'USD')) && (
              <div className="field" style={{ flex: '0 0 140px' }}>
                <label className="field-label">TC →USD <span style={{ color: 'var(--neg)' }}>*</span></label>
                <input type="number" className="input mono" min="0" step="0.01"
                  value={tc} onChange={e => setTc(e.target.value)} placeholder="0" />
              </div>
            )}
          </div>

          {/* ── Acciones ── */}
          <div className="flex-between" style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              Items · {rows.filter(isUsedRow).length} usadas / {rows.length} filas
            </div>
            <button className="btn btn-sm" onClick={() => addRows(ADD_BATCH)}>
              + {ADD_BATCH} filas
            </button>
          </div>

          {/* ── Planilla ── */}
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1400, tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 32 }} />   {/* # */}
                <col style={{ width: 320 }} />  {/* Producto (picker) */}
                <col style={{ width: 130 }} />  {/* IMEI */}
                <col style={{ width: 60 }} />   {/* GB */}
                <col style={{ width: 90 }} />   {/* Color */}
                <col style={{ width: 80 }} />   {/* Stock */}
                <col style={{ width: 70 }} />   {/* Cant */}
                <col style={{ width: 100 }} />  {/* Precio unit */}
                <col style={{ width: 64 }} />   {/* M */}
                <col style={{ width: 100 }} />  {/* Subtotal */}
                <col style={{ width: 32 }} />   {/* X */}
              </colgroup>
              <thead>
                <tr>
                  {['#','Producto *','IMEI','GB','Color','Stock','Cant. *','Precio *','M.','Subtotal',''].map((h, i) =>
                    <th key={i} style={{ ...th, textAlign: i === 0 ? 'center' : 'left' }}>{h}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const used = isUsedRow(r);
                  const cant = Number(r.cantidad) || 0;
                  const exceeds = r.stock_disp != null && cant > r.stock_disp;
                  const sub = (Number(r.precio_unit) || 0) * cant;
                  return (
                    <tr key={r._id} style={{
                      background: used ? 'rgba(99,102,241,0.04)' : 'transparent',
                      borderTop: '1px solid var(--hairline)',
                    }}>
                      <td style={{ padding: '3px 6px', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>{idx + 1}</td>
                      <td style={{ padding: '3px 4px' }}>
                        <ProductoPicker
                          value={r.nombre}
                          locked={!!r.producto_id}
                          onPick={p => pickProducto(idx, p)}
                          onClear={() => clearProducto(idx)}
                          onChange={v => updCell(idx, 'nombre', v)}
                          cellInp={cellInp}
                        />
                      </td>
                      <td style={{ padding: '3px 4px' }}>
                        <input style={{ ...cellInp, fontFamily: 'monospace', opacity: r.producto_id ? 0.7 : 1 }}
                          value={r.imei} readOnly={!!r.producto_id} placeholder="—" />
                      </td>
                      <td style={{ padding: '3px 4px' }}>
                        <input style={{ ...cellInp, textAlign: 'right', opacity: r.producto_id ? 0.7 : 1 }}
                          value={r.gb} readOnly={!!r.producto_id} placeholder="—" />
                      </td>
                      <td style={{ padding: '3px 4px' }}>
                        <input style={{ ...cellInp, opacity: r.producto_id ? 0.7 : 1 }}
                          value={r.color} readOnly={!!r.producto_id} placeholder="—" />
                      </td>
                      <td style={{ padding: '3px 4px', textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>
                        {r.stock_disp != null ? r.stock_disp : '—'}
                      </td>
                      <td style={{ padding: '3px 4px' }}>
                        <input type="number" min="1" style={{
                          ...cellInp, textAlign: 'right',
                          borderColor: exceeds ? 'var(--neg)' : 'var(--border)',
                        }} value={r.cantidad}
                          onChange={e => updCell(idx, 'cantidad', e.target.value)} />
                      </td>
                      <td style={{ padding: '3px 4px' }}>
                        <input type="number" min="0" style={{ ...cellInp, textAlign: 'right', fontWeight: 700 }}
                          value={r.precio_unit} placeholder="0"
                          onChange={e => updCell(idx, 'precio_unit', e.target.value)} />
                      </td>
                      <td style={{ padding: '3px 4px' }}>
                        <select style={{ ...cellInp, cursor: 'pointer' }} value={r.precio_moneda}
                          onChange={e => updCell(idx, 'precio_moneda', e.target.value)}>
                          <option>USD</option><option>ARS</option>
                        </select>
                      </td>
                      <td style={{ padding: '3px 4px', textAlign: 'right', fontWeight: 600, fontSize: 12 }}>
                        {sub > 0 ? `${r.precio_moneda} ${sub.toLocaleString('es-AR', { maximumFractionDigits: 2 })}` : '—'}
                      </td>
                      <td style={{ padding: '3px 4px', textAlign: 'center' }}>
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
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label">Descripción / notas (opcional)</label>
              <input className="input" value={descripcion} onChange={e => setDescripcion(e.target.value)}
                placeholder="Ej. Pedido WhatsApp del 29/5" />
            </div>
            <div style={{ flex: '0 0 220px', textAlign: 'right' }}>
              <div className="muted tiny">Total venta</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 800 }}>
                USD {totalUsd.toLocaleString('es-AR', { maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>
        </div>

        <div className="modal-ft">
          <button className="btn btn-ghost" onClick={tryClose}>Cancelar</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleGuardar}>
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
function ProductoPicker({ value, locked, onPick, onClear, onChange, cellInp }) {
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
      cellInp={cellInp}
      renderOption={(p) => (
        <>
          <div style={{ fontWeight: 600 }}>
            {p.nombre}
            <span className="muted tiny" style={{ marginLeft: 6 }}>
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
