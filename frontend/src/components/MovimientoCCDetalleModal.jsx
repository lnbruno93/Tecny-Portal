/**
 * MovimientoCCDetalleModal — vista de detalle + edición de un movimiento B2B
 * (cuentas corrientes de clientes).
 *
 * Fase A (pedido Lautaro Bisman 2026-08-03): vista read-only con todos los
 * items del movimiento, notas, fecha, monto total. Mismo patrón visual del
 * CompraProveedorDetalleModal (task #261) — reusable UX que el user ya conoce.
 *
 * Fase B (2026-08-03, task #300): modo editable — cambiar fecha/notas, editar
 * campos NO ligados a stock de items existentes, agregar items nuevos, remover
 * items. Sync automático al Inventario:
 *   · Nuevo item con producto_id → descuenta stock (guard 409 si insuficiente)
 *   · Item removido con producto_id → revierte stock al Inventario
 *   · Item existente con producto_id → color/notas/verificado/valor editables;
 *     producto_id + cantidad NO editables (para cambiar producto: remover +
 *     agregar). Simplifica lógica de sync (no double-touch).
 *   · Guard 409: no se puede remover un item cuyo producto ya se vendió en
 *     otra venta posterior.
 *
 * Modos:
 *   · View (default): tabla read-only + botón "Editar" en el footer (solo
 *     tipo=compra).
 *   · Edit: form editable — fecha/notas + fila por item con inputs, botón X
 *     para remover, "+ Agregar item" para agregar filas nuevas.
 *
 * Contexto: en CuentasCC.jsx (tab B2B), cada fila de la tabla de movimientos
 * muestra los campos principales. Este modal es la vista expandida accesible
 * desde click en la fila completa.
 *
 * Simétrico a CompraProveedorDetalleModal.jsx (task #262). Mismo pattern
 * de useModal + toggle mode + drafts locales con _localId.
 */
import { useRef, useState, useEffect } from 'react';
import useModal from '../lib/useModal';
import { Icons } from './Icons';
import { cuentas as cuentasApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { friendlyError } from '../lib/friendlyError';

// Formato helper — matchea el pattern del CompraProveedorDetalleModal.
function fmt(n) {
  const num = Number(n);
  if (!isFinite(num)) return '—';
  return num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtFecha(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

// Etiqueta del tipo — matchea TIPO_DISPLAY.label de CuentasCC.jsx. Se
// duplica intencionalmente acá (no import) porque el modal es autónomo
// y el TIPO_DISPLAY de CuentasCC tiene lógica extra (tone/signo) que no
// aplica al modal.
const TIPO_LABEL = {
  compra:              'Compra',
  pago:                'Cobro',   // "Me pagan" en la tabla, "Cobro" en el modal es más neutro
  devolucion:          'Devolución',
  parte_de_pago:       'Parte de pago',
  entrega_mercaderia:  'Entrega de mercadería',
  saldo_inicial:       'Saldo inicial',
  mercaderia_recibida: 'Mercadería recibida',
  pago_a_cliente:      'Pago a cliente',
  entrega_dinero:      'Entrega de dinero',
};

// Convierte un item de la API a shape editable en el form.
// _localId permite tracking en React sin depender del id de la DB.
let _localIdCounter = 0;
function itemToDraft(item) {
  return {
    _localId: `db-${item.id}`,
    id: item.id,   // presente = existente en DB (para el PUT)
    // producto_id + cantidad son READ-ONLY para items existentes con
    // producto_id vivo (backend rechaza cambios). Los guardamos para
    // enviarlos en el payload y para el bloqueo visual.
    producto_id: item.producto_id ?? null,
    cantidad: item.cantidad ?? 1,
    producto: item.producto ?? '',
    modelo: item.modelo ?? '',
    tamano: item.tamano ?? '',
    color: item.color ?? '',
    imei_serial: item.imei_serial ?? '',
    valor: item.valor != null ? String(item.valor) : '',
    verificado: !!item.verificado,
    notas: item.notas ?? '',
  };
}

function emptyDraft() {
  _localIdCounter += 1;
  return {
    _localId: `new-${_localIdCounter}`,
    id: undefined,
    producto_id: null,
    cantidad: 1,
    producto: '',
    modelo: '',
    tamano: '',
    color: '',
    imei_serial: '',
    valor: '',
    verificado: false,
    notas: '',
  };
}

// Toma el draft y lo convierte al payload esperado por el backend.
// Elimina _localId (solo React tracking). Convierte valor a número o null.
function draftToPayload(d) {
  const out = {
    producto: d.producto?.trim() || null,
    modelo: d.modelo?.trim() || null,
    tamano: d.tamano?.trim() || null,
    color: d.color?.trim() || null,
    imei_serial: d.imei_serial?.trim() || null,
    valor: d.valor !== '' ? Number(d.valor) : null,
    verificado: !!d.verificado,
    notas: d.notas?.trim() || null,
  };
  if (d.id) out.id = d.id;
  // producto_id + cantidad: solo se envían si el draft las tiene (items
  // existentes o nuevos con producto_id). Para nuevos sin producto_id, no
  // se envían — el backend los trata como texto libre.
  if (d.producto_id) out.producto_id = d.producto_id;
  if (d.cantidad) out.cantidad = d.cantidad;
  return out;
}

export default function MovimientoCCDetalleModal({ movimiento, cliente, onClose, onSaved }) {
  const overlayRef = useRef(null);
  const { toast } = useToast();

  // Modo del modal: 'view' (default) o 'edit'.
  const [mode, setMode] = useState('view');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Estado editable (solo relevante en modo edit).
  const [drafts, setDrafts] = useState([]);
  const [notasDraft, setNotasDraft] = useState('');
  const [fechaDraft, setFechaDraft] = useState('');
  const [descripcionDraft, setDescripcionDraft] = useState('');

  // Reset estado cuando se abre el modal (o cambia el movimiento).
  useEffect(() => {
    if (movimiento) {
      setMode('view');
      setDrafts((movimiento.items || []).map(itemToDraft));
      setNotasDraft(movimiento.notas || '');
      setFechaDraft(String(movimiento.fecha || '').slice(0, 10));
      setDescripcionDraft(movimiento.descripcion || '');
      setError(null);
    }
  }, [movimiento]);

  // useModal: cierre por Escape + click fuera. En modo edit sin cambios, cierra
  // igual; en edit con `saving` activo, bloqueamos para no dejar la request
  // en el aire.
  useModal({
    open: !!movimiento,
    onClose: mode === 'edit' && saving ? undefined : onClose,
    overlayRef,
  });

  // Foco inicial en el botón Cerrar cuando abre — mejora accesibilidad.
  const closeBtnRef = useRef(null);
  useEffect(() => {
    if (closeBtnRef.current && mode === 'view') closeBtnRef.current.focus();
  }, [mode]);

  if (!movimiento) return null;

  const items = Array.isArray(movimiento.items) ? movimiento.items : [];
  const tipoLabel = TIPO_LABEL[movimiento.tipo] || movimiento.tipo;
  // Movimientos con venta_id != NULL vienen de sincronizarCuentaCorriente
  // (ventaSync.js) — son ventas retail replicadas al ledger B2B. La fuente
  // de verdad de sus items es `venta_items` (tabla retail). Editarlas desde
  // acá desincronizaría la venta original → botón "Editar" oculto. El user
  // debe ir al módulo Ventas para modificar la venta origen.
  const esVentaRetail = !!movimiento.venta_id;
  const puedeEditar = movimiento.tipo === 'compra' && !esVentaRetail;

  // Suma de valores de items — útil para chequear que matchee monto_total
  // (puede haber discrepancias legítimas si hubo descuentos/ajustes).
  const sumaItems = items.reduce((sum, it) => sum + (Number(it.valor) || 0), 0);
  const montoTotal = Number(movimiento.monto_total) || 0;
  const hayDiscrepancia = items.length > 0 && Math.abs(sumaItems - montoTotal) > 0.01;

  // Suma del draft (para preview en modo edit — el backend recomputa monto_total
  // como esta suma).
  const sumaDrafts = drafts.reduce((acc, d) => acc + (d.valor !== '' ? Number(d.valor) || 0 : 0), 0);

  function updateDraft(localId, field, value) {
    setDrafts(prev => prev.map(d => d._localId === localId ? { ...d, [field]: value } : d));
  }
  function removeDraft(localId) {
    setDrafts(prev => prev.filter(d => d._localId !== localId));
  }
  function addDraft() {
    setDrafts(prev => [...prev, emptyDraft()]);
  }
  function cancelEdit() {
    setDrafts(items.map(itemToDraft));
    setNotasDraft(movimiento.notas || '');
    setFechaDraft(String(movimiento.fecha || '').slice(0, 10));
    setDescripcionDraft(movimiento.descripcion || '');
    setError(null);
    setMode('view');
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        fecha: fechaDraft || undefined,
        descripcion: descripcionDraft.trim() || null,
        notas: notasDraft.trim() || null,
        items: drafts.map(draftToPayload),
      };
      const res = await cuentasApi.updateMovimiento(movimiento.id, payload);
      toast.success('Movimiento actualizado');
      onSaved?.(res);
      onClose();
    } catch (err) {
      const msg = friendlyError(err, 'No se pudo actualizar el movimiento');
      setError(msg);
      // Toast contextual para guards del backend
      if (err?.body?.productos_vendidos?.length) {
        toast.error(`Productos ya vendidos: ${err.body.productos_vendidos.slice(0, 3).join(', ')}`);
      } else if (err?.body?.producto_id) {
        toast.error(msg);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={overlayRef} className="modal-overlay" role="dialog" aria-modal="true"
         aria-labelledby="mov-cc-detalle-title"
         onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="modal u-mw-720" onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <div>
            <h3 id="mov-cc-detalle-title">
              {mode === 'edit' ? 'Editar ' : ''}{tipoLabel} — {fmtFecha(mode === 'edit' ? fechaDraft : movimiento.fecha)}
            </h3>
            <div className="page-sub">
              {cliente?.nombre} {cliente?.apellido || ''}
              {' · '}
              <span className="mono">USD {fmt(mode === 'edit' ? sumaDrafts : montoTotal)}</span>
              {mode === 'view' && movimiento.descripcion && (
                <> {' · '}<span className="muted">{movimiento.descripcion}</span></>
              )}
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Cerrar"
            title="Cerrar"
            disabled={saving}
          >
            <Icons.X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {mode === 'edit' && (
            <>
              <div className="field">
                <label className="field-label" htmlFor="mov-cc-edit-fecha">Fecha</label>
                <input
                  id="mov-cc-edit-fecha"
                  type="date"
                  className="input"
                  value={fechaDraft}
                  onChange={(e) => setFechaDraft(e.target.value)}
                  disabled={saving}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="mov-cc-edit-descripcion">Descripción</label>
                <input
                  id="mov-cc-edit-descripcion"
                  type="text"
                  className="input"
                  value={descripcionDraft}
                  onChange={(e) => setDescripcionDraft(e.target.value)}
                  placeholder="Referencia interna, etc."
                  maxLength={500}
                  disabled={saving}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="mov-cc-edit-notas">Notas</label>
                <input
                  id="mov-cc-edit-notas"
                  type="text"
                  className="input"
                  value={notasDraft}
                  onChange={(e) => setNotasDraft(e.target.value)}
                  placeholder="Notas internas"
                  maxLength={1000}
                  disabled={saving}
                />
              </div>
            </>
          )}

          {mode === 'view' && movimiento.notas && (
            <div className="field">
              <div className="field-label">Notas</div>
              <div className="u-color-text-2">{movimiento.notas}</div>
            </div>
          )}

          {mode === 'view' && esVentaRetail && (
            <div className="muted tiny u-mt-8">
              Este movimiento proviene de una venta minorista. Los ítems se
              muestran para consulta — para modificarlos, editá la venta original
              desde el módulo Ventas.
            </div>
          )}

          {mode === 'view' && items.length === 0 && (
            <div className="u-empty-p-24-16">
              Este movimiento no tiene productos asociados (pago, ajuste, o registro
              sin desglose).
            </div>
          )}

          {mode === 'view' && items.length > 0 && (
            <div className="u-overflow-auto">
              <table className="table u-fs-13">
                <thead>
                  <tr>
                    <th className="u-fs-12">Producto</th>
                    <th className="u-fs-12">Modelo</th>
                    <th className="u-fs-12">Cap.</th>
                    <th className="u-fs-12">Color</th>
                    <th className="u-fs-12">IMEI / Serial</th>
                    <th className="u-fs-12 u-td-right-fw-700">Valor USD</th>
                    <th className="u-fs-12 u-text-center">✓</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => (
                    <tr key={it.id ?? idx}>
                      <td>
                        {it.producto || <span className="dim">—</span>}
                        {it.notas && <div className="muted tiny">{it.notas}</div>}
                      </td>
                      <td className="u-color-text-2">{it.modelo || <span className="dim">—</span>}</td>
                      <td className="u-color-text-2">{it.tamano || <span className="dim">—</span>}</td>
                      <td className="u-color-text-2">{it.color || <span className="dim">—</span>}</td>
                      <td className="u-mono u-fs-12">{it.imei_serial || <span className="dim">—</span>}</td>
                      <td className="u-td-right-fw-700 mono">
                        {it.valor != null ? fmt(it.valor) : <span className="dim">—</span>}
                      </td>
                      <td className="u-text-center">
                        {it.verificado
                          ? <span className="u-color-pos-fs-14" title="Verificado">✓</span>
                          : <span className="dim u-fs-11">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {items.length > 1 && (
                  <tfoot>
                    <tr>
                      <td colSpan={5} className="u-td-right-fw-700 muted">
                        Suma de valores ({items.length} items):
                      </td>
                      <td className="u-td-right-fw-700 mono">USD {fmt(sumaItems)}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
              {hayDiscrepancia && (
                <div className="muted tiny u-mt-8">
                  Nota: el monto total (USD {fmt(montoTotal)}) difiere de la suma de
                  items — puede ser normal si hubo descuentos, ajustes o si algunos
                  items se registraron sin valor.
                </div>
              )}
            </div>
          )}

          {mode === 'edit' && (
            <div className="u-overflow-auto">
              <table className="table u-fs-12 compra-edit-table">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th>Modelo</th>
                    <th>Cap.</th>
                    <th>Color</th>
                    <th>IMEI / Serial</th>
                    <th className="u-td-right-fw-700">Valor USD</th>
                    <th className="u-text-center">✓</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {drafts.map(d => {
                    // Item con producto_id vivo = campos ligados a stock
                    // (producto_id + cantidad) NO editables. El resto (color,
                    // notas, verificado, valor, imei_serial, tamano, modelo,
                    // producto texto) sí editable. Backend valida el resto.
                    const esExistenteConStock = d.id && d.producto_id;
                    return (
                      <tr key={d._localId}>
                        <td>
                          <input className="input compra-edit-input" value={d.producto}
                            onChange={(e) => updateDraft(d._localId, 'producto', e.target.value)}
                            disabled={saving} maxLength={100} placeholder="Nombre" />
                          {esExistenteConStock && (
                            <div className="muted tiny" title="Vinculado al Inventario">
                              🔗 Inventario #{d.producto_id}
                            </div>
                          )}
                        </td>
                        <td>
                          <input className="input compra-edit-input" value={d.modelo}
                            onChange={(e) => updateDraft(d._localId, 'modelo', e.target.value)}
                            disabled={saving} maxLength={100} />
                        </td>
                        <td>
                          <input className="input compra-edit-input" value={d.tamano}
                            onChange={(e) => updateDraft(d._localId, 'tamano', e.target.value)}
                            disabled={saving} maxLength={50} />
                        </td>
                        <td>
                          <input className="input compra-edit-input" value={d.color}
                            onChange={(e) => updateDraft(d._localId, 'color', e.target.value)}
                            disabled={saving} maxLength={50} />
                        </td>
                        <td>
                          <input className="input compra-edit-input mono" value={d.imei_serial}
                            onChange={(e) => updateDraft(d._localId, 'imei_serial', e.target.value)}
                            disabled={saving} maxLength={100} />
                        </td>
                        <td>
                          <input className="input compra-edit-input mono u-td-right-fw-700"
                            type="number" inputMode="decimal" step="0.01" min="0"
                            value={d.valor}
                            onChange={(e) => updateDraft(d._localId, 'valor', e.target.value)}
                            disabled={saving} />
                        </td>
                        <td className="u-text-center">
                          <input type="checkbox" checked={d.verificado}
                            onChange={(e) => updateDraft(d._localId, 'verificado', e.target.checked)}
                            disabled={saving}
                            aria-label="Verificado" title="Verificado" />
                        </td>
                        <td>
                          <button type="button" className="icon-btn" onClick={() => removeDraft(d._localId)}
                            disabled={saving} title="Eliminar item" aria-label="Eliminar item">
                            <Icons.Trash size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {drafts.length === 0 && (
                    <tr>
                      <td colSpan={8} className="u-empty-p-24-16">
                        Sin items. Tocá "+ Agregar item" para empezar.
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} className="u-td-right-fw-700 muted">
                      Suma ({drafts.length} items):
                    </td>
                    <td className="u-td-right-fw-700 mono">
                      USD {fmt(sumaDrafts)}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
              <div className="u-mt-8">
                <button type="button" className="btn btn-ghost btn-sm" onClick={addDraft} disabled={saving}>
                  + Agregar item
                </button>
              </div>
              <div className="muted tiny u-mt-8">
                Al guardar: el monto total del movimiento se recalcula como la suma
                de valores. Items nuevos NO se vinculan al Inventario en esta versión
                (para agregar productos con stock, usá "Nueva venta"). Items
                eliminados con producto vinculado (🔗) restauran el stock al
                Inventario — a menos que ya se haya vendido en otra venta, en cuyo
                caso el guardado falla con 409.
              </div>
              {error && (
                <div className="u-alert-red-box u-mt-8">
                  <strong>Error:</strong> {error}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-ft">
          {mode === 'view' ? (
            <>
              {puedeEditar && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setMode('edit')}
                  title="Editar fecha, notas, o items"
                >
                  <Icons.Edit size={14} /> Editar
                </button>
              )}
              <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
                Cerrar
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-ghost" onClick={cancelEdit} disabled={saving}>
                Cancelar
              </button>
              <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Guardando…' : 'Guardar cambios'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
