/**
 * CompraProveedorDetalleModal — vista de detalle + edición de una compra a
 * proveedor.
 *
 * Fase A (pedido Gianfranco 2026-07-30): vista read-only con todos los items.
 * Fase B (2026-07-30): modo editable — cambiar campos de items existentes,
 *   agregar items nuevos, remover items. Sync automático al Inventario.
 *
 * Modos:
 *   · View (default): tabla read-only + botón "Editar" en el footer.
 *   · Edit: form editable — cada item es una fila con inputs, botón X para
 *     remover, botón "+ Agregar producto" para agregar filas nuevas.
 *
 * Guards del backend (respondidos con toast si aparecen):
 *   · Producto ya vendido no removible → 409 con lista de productos afectados.
 *   · IMEI duplicado (dentro del lote o vs Inventario existente) → 409.
 *   · Solo tipo=compra editable → 400.
 *
 * Sync a Inventario:
 *   Items con producto asociado (matcheados por IMEI original en backend)
 *   se sincronizan: producto → nombre, imei_serial → imei, tamano → gb,
 *   color → color, valor → costo. Ver runbook backend para limitaciones.
 *
 * Items NUEVOS: se agregan como "concepto/gasto" sin ficha de Inventario
 * en Fase B v1. Para crear un item que también genere producto, usar el
 * modal "Cargar compra" nuevo (o borrar y recargar la compra).
 */
import { useRef, useState, useEffect } from 'react';
import useModal from '../lib/useModal';
import { Icons } from './Icons';
import { proveedores as provApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { friendlyError } from '../lib/friendlyError';
import { downloadDetalleXlsx } from '../lib/detalleXlsx';

// Formato helper compartido con la grilla.
function fmt(n) {
  const num = Number(n);
  if (!isFinite(num)) return '—';
  return num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Etiqueta del tipo — matchea TIPO_DISPLAY de Proveedores.jsx.
const TIPO_LABEL = {
  compra: 'Compra',
  devolucion: 'Devolución',
  entrega_mercaderia: 'Entrega de mercadería',
};

function fmtFecha(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

// Convierte un item de la API a shape editable en el form.
// _localId permite tracking en React sin depender del id de la DB.
let _localIdCounter = 0;
function itemToDraft(item) {
  return {
    _localId: `db-${item.id}`,
    id: item.id,   // presente = existente en DB (para el PUT)
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

// Toma el draft del form y lo convierte al payload esperado por el backend.
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
  return out;
}

export default function CompraProveedorDetalleModal({ movimiento, proveedor, onClose, onSaved }) {
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

  // Reset estado cuando se abre el modal (o cambia el movimiento).
  useEffect(() => {
    if (movimiento) {
      setMode('view');
      setDrafts((movimiento.items || []).map(itemToDraft));
      setNotasDraft(movimiento.notas || '');
      setFechaDraft(String(movimiento.fecha || '').slice(0, 10));
      setError(null);
    }
  }, [movimiento]);

  useModal({ open: !!movimiento, onClose: mode === 'edit' && !saving ? undefined : onClose, overlayRef });

  if (!movimiento) return null;

  const items = movimiento.items || [];
  const tipoLabel = TIPO_LABEL[movimiento.tipo] || movimiento.tipo;
  const isCredito = !movimiento.caja_id;
  const cajaText = movimiento.caja_nombre || (isCredito ? 'A crédito (CC)' : '—');
  const puedeEditar = movimiento.tipo === 'compra'; // Solo compras (backend guard)

  const sumaItemsMoneda = items.reduce((acc, it) => acc + (Number(it.valor) || 0), 0);
  const montoMovMoneda = Number(movimiento.monto) || 0;
  const hayDiscrepancia = items.length > 0 && Math.abs(sumaItemsMoneda - montoMovMoneda) > 0.01;

  // Suma del draft (para preview en modo edit)
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
    setError(null);
    setMode('view');
  }

  // 2026-08-04 (task #305, pedido Lautaro): descargar el detalle como XLSX.
  // Layout: header key-value (Tipo/Fecha/Proveedor/Monto/Caja/Notas) + tabla
  // de items con Producto/Modelo/Cap./Color/IMEI/Valor/Verificado + fila Total.
  function handleDownloadXlsx() {
    const prov = proveedor?.nombre || 'proveedor';
    const fechaFile = String(movimiento.fecha || '').slice(0, 10);
    const filename = `compra-proveedor_${prov}_${fechaFile}_#${movimiento.id}`;
    const moneda = movimiento.moneda || 'USD';
    downloadDetalleXlsx({
      filename,
      sheetName: `Compra ${fechaFile}`,
      header: [
        { label: 'Tipo',        value: tipoLabel },
        { label: 'Fecha',       value: fmtFecha(movimiento.fecha) },
        { label: 'Proveedor',   value: prov },
        { label: `Monto ${moneda}`, value: montoMovMoneda },
        { label: 'Caja',        value: cajaText },
        { label: 'Notas',       value: movimiento.notas || '' },
      ],
      columns: ['Producto', 'Modelo', 'Cap.', 'Color', 'IMEI/Serial', `Valor ${moneda}`, 'Verificado'],
      rows: items.map(it => [
        it.producto || '',
        it.modelo || '',
        it.tamano || '',
        it.color || '',
        it.imei_serial || '',
        Number(it.valor) || 0,
        it.verificado ? '✓' : '',
      ]),
      sumaTotal: sumaItemsMoneda,
    });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        fecha: fechaDraft || undefined,
        notas: notasDraft.trim() || null,
        items: drafts.map(draftToPayload),
      };
      const res = await provApi.updateMovimiento(movimiento.id, payload);
      toast.success('Compra actualizada');
      onSaved?.(res);
      onClose();
    } catch (err) {
      const msg = friendlyError(err, 'No se pudo actualizar la compra');
      setError(msg);
      // Si el backend devolvió productos_vendidos, mostrar toast contextual.
      if (err?.body?.productos_vendidos?.length) {
        toast.error(`Productos vendidos: ${err.body.productos_vendidos.slice(0, 3).join(', ')}`);
      } else if (err?.body?.imeis_existentes?.length) {
        toast.error(`IMEI ya usado: ${err.body.imeis_existentes.join(', ')}`);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" ref={overlayRef} onMouseDown={(e) => {
      if (e.target === overlayRef.current && mode === 'view') onClose();
    }}>
      <div className="modal u-mw-720" role="dialog" aria-labelledby="compra-detalle-title">
        <div className="modal-hd">
          <div>
            <h3 id="compra-detalle-title">
              {mode === 'edit' ? 'Editar ' : ''}{tipoLabel} — {fmtFecha(mode === 'edit' ? fechaDraft : movimiento.fecha)}
            </h3>
            <div className="page-sub">
              {proveedor?.nombre || 'Proveedor'}
              {' · '}
              <span className="mono">USD {fmt(mode === 'edit' ? sumaDrafts : movimiento.monto_usd)}</span>
              {' · '}
              <span className="muted">{cajaText}</span>
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar" title="Cerrar"
            disabled={saving}>
            <Icons.X size={16} />
          </button>
        </div>

        <div className="modal-body">
          {mode === 'edit' && (
            <>
              <div className="field">
                <label className="field-label" htmlFor="compra-edit-fecha">Fecha</label>
                <input
                  id="compra-edit-fecha"
                  type="date"
                  className="input"
                  value={fechaDraft}
                  onChange={(e) => setFechaDraft(e.target.value)}
                  disabled={saving}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="compra-edit-notas">Notas</label>
                <input
                  id="compra-edit-notas"
                  type="text"
                  className="input"
                  value={notasDraft}
                  onChange={(e) => setNotasDraft(e.target.value)}
                  placeholder="Factura #, referencia interna, etc."
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

          {/* Grid de items */}
          {mode === 'view' && items.length === 0 && (
            <div className="u-empty-p-24-16">Este movimiento no tiene productos asociados.</div>
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
                    <th className="u-fs-12 u-td-right-fw-700">Valor</th>
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
                      <td className="u-td-right-fw-700 mono">
                        {fmt(sumaItemsMoneda)}{movimiento.moneda && ` ${movimiento.moneda}`}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
              {hayDiscrepancia && (
                <div className="muted tiny u-mt-8">
                  Nota: el monto ({fmt(montoMovMoneda)} {movimiento.moneda || ''}) difiere de la suma
                  de items — puede ser normal si la compra incluyó descuentos, envío o ajustes.
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
                    <th className="u-td-right-fw-700">Valor</th>
                    <th className="u-text-center">✓</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {drafts.map(d => (
                    <tr key={d._localId}>
                      <td>
                        <input className="input compra-edit-input" value={d.producto}
                          onChange={(e) => updateDraft(d._localId, 'producto', e.target.value)}
                          disabled={saving} maxLength={100} placeholder="Nombre" />
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
                  ))}
                  {drafts.length === 0 && (
                    <tr>
                      <td colSpan={8} className="u-empty-p-24-16">
                        Sin items. Tocá "+ Agregar producto" para empezar.
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
                      {fmt(sumaDrafts)}{movimiento.moneda && ` ${movimiento.moneda}`}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
              <div className="u-mt-8">
                <button type="button" className="btn btn-ghost btn-sm" onClick={addDraft} disabled={saving}>
                  + Agregar producto
                </button>
              </div>
              <div className="muted tiny u-mt-8">
                Al guardar: los cambios en items con IMEI se propagan al Inventario (nombre,
                IMEI, capacidad, color, costo). Los items nuevos NO se crean en Inventario en esta versión —
                se registran solo como línea de la compra. Los items eliminados soft-deletean el producto
                asociado (a menos que ya se haya vendido — en ese caso el guardado falla).
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
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleDownloadXlsx}
                title="Descargar detalle como Excel (.xlsx)"
                data-testid="compra-prov-download-xlsx"
              >
                <Icons.Download size={14} /> Descargar Excel
              </button>
              {puedeEditar && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setMode('edit')}
                  title="Editar campos, agregar o remover items"
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
