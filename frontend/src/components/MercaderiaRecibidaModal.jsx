/**
 * Modal "Recibir mercadería" — cliente B2B cancela deuda con productos.
 *
 * Task #155 (2026-07-17). Backend en PR #651. Este modal consume
 * `POST /api/cuentas/movimientos` con `tipo=mercaderia_recibida`.
 *
 * Diseño UX (validado con Lucas, iterado post-#652):
 *   - Header sticky con banner de saldo actual + fecha + concepto.
 *   - Tabla compacta de items — 1 fila por producto con columnas:
 *     [Producto][Categoría][IMEI][Cant][Valor unit.][Subtotal][✕]
 *     Header sticky, filas scrolleables. Escala bien con 10+ productos
 *     sin romper el layout (v1 con cards se ponía inusable a partir de 4).
 *   - Footer sticky con total + preview del saldo post-op + botones.
 *   - Guardar permitido aunque el total no coincida con la deuda (queda
 *     saldo remanente); confirm intermedio si no cierra en 0.
 *
 * Diferencias vs VentaB2BModal:
 *   - Es un flujo puntual (no data entry masivo tipo planilla).
 *   - Sin caja / TC / moneda (backend rechaza caja_id + valida en USD).
 *   - Cada item SIEMPRE crea producto en stock (los productos SON el pago —
 *     no tiene sentido registrar entrega sin ingresar stock).
 *
 * Semántica del saldo (invariante que asume esta UI):
 *   - saldo > 0 → el cliente nos debe (deuda).
 *   - saldo < 0 → nosotros le debemos al cliente (crédito a favor del cliente).
 *   - mercaderia_recibida SIEMPRE baja el saldo (equivalente contable a pago
 *     que hace el cliente). Si el cliente ya estaba a favor, entregar más
 *     mercadería lo profundiza — warning suave en el preview.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import useModal from '../lib/useModal';
import { Icons } from './Icons';
import { cuentas as cuentasApi, inventario as invApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmModal';
import { blockInvalidNumberKeys } from '../lib/inputUtils';

const fmtUSD = (n) => `USD ${Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function todayISO() { return new Date().toLocaleDateString('sv'); }

// Item vacío con defaults sensatos. tipo_carga='unitario' + condicion='nuevo'
// se pueden reajustar por item (aunque en general la UX apunta al equipo
// unitario nuevo que trae el cliente).
// 2026-07-17 (pedido de Lucas post-#654): agregado `color` + `bateria` para
// alinear con los campos que ya usa el modal Inventario (celulares/consolas).
const mkItem = () => ({
  _id: Math.random().toString(36).slice(2),
  nombre: '',
  categoria_id: '',
  clase_id: '',
  imei: '',
  color: '',
  bateria: '',
  cantidad: '1',
  valor_unitario: '',
});

export default function MercaderiaRecibidaModal({ cliente, saldoActual, onClose, onSaved }) {
  const { toast } = useToast();
  const confirm = useConfirm();

  const [fecha, setFecha] = useState(todayISO());
  const [concepto, setConcepto] = useState('');
  const [items, setItems] = useState([mkItem()]);
  const [saving, setSaving] = useState(false);

  // Catálogos: colecciones + clases (para dropdowns) + productos existentes
  // para el autocomplete de nombre (datalist HTML nativo, sin fetch per-key).
  const [categorias, setCategorias] = useState([]);
  const [clases, setClases] = useState([]);
  const [productosCatalogo, setProductosCatalogo] = useState([]);
  const [catalogosError, setCatalogosError] = useState(null);

  // Pattern G — Idempotency-Key regenerado al abrir. Doble click en "Guardar"
  // usa el MISMO key → replay backend en vez de duplicar el movimiento.
  const [idemKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    Promise.allSettled([
      invApi.categorias(),
      invApi.clases(),
      invApi.productos({ limit: 100 }), // primeros 100 productos para autocomplete
    ]).then(([rc, rcl, rp]) => {
      const errores = [];
      if (rc.status === 'fulfilled') setCategorias(rc.value || []); else errores.push('colecciones');
      if (rcl.status === 'fulfilled') setClases(rcl.value || []); else errores.push('categorías');
      if (rp.status === 'fulfilled') {
        const list = rp.value?.data || [];
        const uniqNames = [...new Set(list.map(p => p.nombre).filter(Boolean))];
        setProductosCatalogo(uniqNames.slice(0, 50));
      } else {
        errores.push('productos');
      }
      if (errores.length > 0) setCatalogosError(errores);
    });
  }, []);

  const totalUsd = useMemo(() => {
    return items.reduce((acc, it) => {
      const q = Number(it.cantidad) || 0;
      const v = Number(it.valor_unitario) || 0;
      return acc + q * v;
    }, 0);
  }, [items]);

  // Saldo post-op: entregar mercadería BAJA el saldo del cliente
  // (convención: saldo positivo = cliente nos debe).
  const saldoPost = useMemo(() => Number(saldoActual || 0) - totalUsd, [saldoActual, totalUsd]);
  const saldoCierraEnCero = Math.abs(saldoPost) < 0.01;
  // Warning suave: cliente ya con saldo a favor + entrega adicional → lo
  // hunde más. Se puede guardar igual pero le sugerimos que revise si no
  // debería registrar antes una venta B2B a ese cliente.
  const saldoInvertido = Number(saldoActual || 0) <= 0 && totalUsd > 0;

  function updItem(idx, field, value) {
    setItems(items => items.map((it, i) => i === idx ? { ...it, [field]: value } : it));
  }
  function addItem() { setItems(items => [...items, mkItem()]); }
  function removeItem(idx) {
    setItems(items => items.length > 1 ? items.filter((_, i) => i !== idx) : items);
  }

  function validar() {
    if (!fecha) return 'Falta la fecha';
    if (items.length === 0) return 'Agregá al menos un producto';
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.nombre.trim()) return `Item ${i + 1}: falta el nombre del producto`;
      if (!it.clase_id) return `Item ${i + 1}: elegí la categoría (celular / consola / etc.)`;
      const q = Number(it.cantidad);
      if (!q || q <= 0) return `Item ${i + 1}: la cantidad debe ser mayor a 0`;
      const v = Number(it.valor_unitario);
      if (!v || v <= 0) return `Item ${i + 1}: el valor unitario debe ser mayor a 0`;
      // Batería: opcional pero si viene, 0..100 (schema Zod en backend hace
      // el mismo guard — validamos acá para feedback rápido).
      if (it.bateria !== '' && it.bateria != null) {
        const b = Number(it.bateria);
        if (!Number.isFinite(b) || b < 0 || b > 100) {
          return `Item ${i + 1}: la batería debe estar entre 0 y 100`;
        }
      }
    }
    if (totalUsd <= 0) return 'El total debe ser mayor a 0';
    const imeis = items.map(it => it.imei.trim()).filter(Boolean);
    const seen = new Set();
    for (const i of imeis) {
      if (seen.has(i)) return `IMEI duplicado dentro del lote: ${i}`;
      seen.add(i);
    }
    return null;
  }

  async function handleGuardar() {
    const err = validar();
    if (err) { toast.error(err); return; }
    // Confirm si el saldo no cierra en 0 (evita clicks accidentales).
    if (!saldoCierraEnCero) {
      const remanente = saldoPost;
      const msg = remanente > 0
        ? `Después de la entrega el cliente seguirá teniendo saldo de ${fmtUSD(remanente)} (te va a seguir debiendo). ¿Guardar igual?`
        : `Después de la entrega el cliente quedará con ${fmtUSD(Math.abs(remanente))} a favor. ¿Guardar igual?`;
      const ok = await confirm({
        title: 'La entrega no cancela toda la deuda',
        message: msg,
        confirmLabel: 'Guardar entrega',
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      const payload = {
        cliente_cc_id: cliente.id,
        fecha,
        tipo: 'mercaderia_recibida',
        descripcion: concepto.trim() || null,
        monto_total: Number(totalUsd.toFixed(2)),
        moneda: 'USD',
        // Sin caja_id, sin tc → el backend rechaza si vienen.
        items: items.map(it => ({
          producto: it.nombre.trim(),
          modelo: null,
          color: it.color.trim() || null,
          imei_serial: it.imei.trim() || null,
          valor: Number(it.valor_unitario) || 0,
          verificado: false,
          producto_stock: {
            tipo_carga: 'unitario',
            clase_id: it.clase_id,
            nombre: it.nombre.trim(),
            imei: it.imei.trim() || null,
            color: it.color.trim() || null,
            // Batería en %: 0..100. Vacío → null (el schema es opcional).
            bateria: it.bateria !== '' && it.bateria != null
              ? Number(it.bateria)
              : null,
            categoria_id: it.categoria_id ? Number(it.categoria_id) : null,
            costo: Number(it.valor_unitario) || 0,
            costo_moneda: 'USD',
            precio_venta: 0,      // el user setea después en Inventario
            precio_moneda: 'USD',
            cantidad: Number(it.cantidad) || 1,
            condicion: 'nuevo',
          },
        })),
      };
      const res = await cuentasApi.createMovimiento(payload, idemKey);
      const creados = res.productos_creados?.length || 0;
      toast.success(`Entrega registrada · ${creados} producto${creados === 1 ? '' : 's'} al stock`);
      onSaved?.(res);
      onClose();
    } catch (e) {
      const data = e.responseBody || e.data || {};
      if (Array.isArray(data.imeis_existentes) && data.imeis_existentes.length > 0) {
        const lista = data.imeis_existentes.slice(0, 3).join(', ');
        const more = data.imeis_existentes.length > 3 ? `…+${data.imeis_existentes.length - 3}` : '';
        toast.error(`IMEI ya existe en stock: ${lista}${more}`, { duration: 8000 });
      } else {
        toast.error(e.message || 'No se pudo registrar la entrega');
      }
    } finally {
      setSaving(false);
    }
  }

  async function tryClose() {
    const cargados = items.some(it => it.nombre.trim() || it.valor_unitario || it.imei.trim());
    if (!cargados) return onClose();
    const ok = await confirm({
      title: 'Cerrar sin guardar',
      message: 'Vas a perder los ítems cargados. ¿Seguro?',
      confirmLabel: 'Cerrar y perder cambios',
      danger: true,
    });
    if (ok) onClose();
  }

  const overlayRef = useRef(null);
  useModal({ open: true, onClose: tryClose, overlayRef });

  // ── Estilos ─────────────────────────────────────────────────────────────
  const bannerSaldoStyle = {
    background: 'var(--warn-soft, rgba(251,191,36,0.14))',
    border: '1px solid var(--warn, #fbbf24)',
    borderRadius: 6,
    padding: '8px 12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: 12,
  };
  // Grid compartido para header + filas. Un cambio acá y todo queda alineado.
  //  Producto | Categoría | IMEI | Color | Bat% | Cant | Valor unit. | Subtotal | ✕
  const gridCols = 'minmax(160px, 1.4fr) 130px minmax(100px, 1fr) 90px 60px 55px 90px 90px 28px';
  const cellPad = '6px 8px';
  const inputCell = { width: '100%', padding: '6px 8px', fontSize: 12, borderRadius: 4 };
  const previewStyle = {
    padding: '10px 12px',
    background: saldoCierraEnCero
      ? 'var(--pos-soft, rgba(74,222,128,0.12))'
      : 'var(--warn-soft, rgba(251,191,36,0.14))',
    border: `1px solid ${saldoCierraEnCero ? 'var(--pos, #4ade80)' : 'var(--warn, #fbbf24)'}`,
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: 12,
    color: 'var(--text-2)',
  };

  const nombreCliente = [cliente.nombre, cliente.apellido].filter(Boolean).join(' ') || cliente.nombre;
  const primerNombre = (cliente.nombre || '').split(' ')[0] || 'Cliente';

  const subtotalDe = (it) => (Number(it.cantidad) || 0) * (Number(it.valor_unitario) || 0);

  return (
    <div ref={overlayRef} className="modal-overlay" role="dialog" aria-modal="true"
         aria-labelledby="mercaderia-recibida-modal-title"
         onClick={(e) => { if (e.target === e.currentTarget) tryClose(); }}>
      <div className="modal" style={{ maxWidth: 1200, width: '96vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <h3 id="mercaderia-recibida-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icons.Box size={16} /> Recibir mercadería · {nombreCliente}
          </h3>
          <button className="icon-btn" onClick={tryClose} aria-label="Cerrar modal">
            <Icons.X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ padding: 0, display: 'flex', flexDirection: 'column', maxHeight: '82vh' }}>
          {/* ── Header sticky: saldo + fecha + concepto ── */}
          <div style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface)',
            display: 'flex', flexDirection: 'column', gap: 10,
            flexShrink: 0,
          }}>
            {catalogosError && (
              <div style={{
                padding: '8px 10px', borderRadius: 4,
                background: 'var(--warn-soft, rgba(251,191,36,0.14))',
                border: '1px solid var(--warn)',
                fontSize: 11,
              }}>
                ⚠ No se pudieron cargar: <strong>{catalogosError.join(', ')}</strong>. Algunos selectores estarán vacíos.
              </div>
            )}
            <div style={bannerSaldoStyle}>
              <span style={{ color: 'var(--text-2)' }}>
                Saldo actual {Number(saldoActual || 0) > 0 ? '(cliente nos debe)' : Number(saldoActual || 0) < 0 ? '(a favor del cliente)' : ''}
              </span>
              <span style={{
                fontWeight: 600, fontSize: 14,
                color: Number(saldoActual || 0) > 0 ? 'var(--neg)' : Number(saldoActual || 0) < 0 ? 'var(--pos)' : 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {fmtUSD(Number(saldoActual || 0))}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: 10 }}>
              <input type="date" className="input" value={fecha}
                     onChange={e => setFecha(e.target.value)}
                     style={{ fontSize: 12, padding: '6px 8px' }} />
              <input type="text" className="input"
                     placeholder="Concepto (opcional) — Ej: 2 PS5 a cuenta"
                     value={concepto} onChange={e => setConcepto(e.target.value)}
                     style={{ fontSize: 12, padding: '6px 8px' }} />
            </div>
          </div>

          {/* ── Tabla scrolleable ── */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 180 }}>
            {/* Datalist HTML nativo para autocomplete de nombres */}
            <datalist id="mercaderia-recibida-productos-catalogo">
              {productosCatalogo.map((n, i) => <option key={i} value={n} />)}
            </datalist>

            {/* Header sticky de la tabla */}
            <div style={{
              display: 'grid', gridTemplateColumns: gridCols, gap: 4,
              padding: '10px 20px 6px',
              position: 'sticky', top: 0,
              background: 'var(--surface)',
              borderBottom: '1px solid var(--hairline)',
              fontSize: 10, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.05em',
              color: 'var(--text-muted)',
              zIndex: 1,
            }}>
              <span>Producto</span>
              <span>Categoría</span>
              <span>IMEI / Serial</span>
              <span>Color</span>
              <span style={{ textAlign: 'center' }}>Bat.%</span>
              <span style={{ textAlign: 'center' }}>Cant.</span>
              <span style={{ textAlign: 'right' }}>Valor unit.</span>
              <span style={{ textAlign: 'right' }}>Subtotal</span>
              <span></span>
            </div>

            {/* Filas */}
            <div style={{ padding: '4px 20px 12px' }}>
              {items.map((it, idx) => {
                const st = subtotalDe(it);
                return (
                  <div key={it._id} style={{
                    display: 'grid', gridTemplateColumns: gridCols, gap: 4,
                    alignItems: 'center',
                    padding: '4px 0',
                    borderBottom: '1px solid var(--hairline)',
                  }}>
                    <input
                      type="text"
                      className="input"
                      list="mercaderia-recibida-productos-catalogo"
                      placeholder="Ej: PlayStation 5 Slim"
                      value={it.nombre}
                      onChange={e => updItem(idx, 'nombre', e.target.value)}
                      autoFocus={idx === 0 && items.length === 1}
                      style={inputCell}
                    />
                    <select className="input" value={it.clase_id}
                            onChange={e => updItem(idx, 'clase_id', e.target.value)}
                            style={inputCell}>
                      <option value="">—</option>
                      {clases.filter(c => c.activa !== false && !c.es_sin_categoria).map(c => (
                        <option key={c.id} value={c.id}>{c.emoji ? `${c.emoji} ${c.nombre}` : c.nombre}</option>
                      ))}
                    </select>
                    <input
                      type="text" className="input"
                      value={it.imei}
                      onChange={e => updItem(idx, 'imei', e.target.value)}
                      placeholder="—"
                      style={{ ...inputCell, fontFamily: 'monospace' }}
                    />
                    <input
                      type="text" className="input"
                      value={it.color}
                      onChange={e => updItem(idx, 'color', e.target.value)}
                      placeholder="Negro"
                      style={inputCell}
                    />
                    <input
                      type="number" className="input mono"
                      min="0" max="100" step="1"
                      onKeyDown={blockInvalidNumberKeys}
                      value={it.bateria}
                      onChange={e => updItem(idx, 'bateria', e.target.value)}
                      placeholder="—"
                      style={{ ...inputCell, textAlign: 'center' }}
                    />
                    <input
                      type="number" className="input mono"
                      min="1" step="1"
                      onKeyDown={blockInvalidNumberKeys}
                      value={it.cantidad}
                      onChange={e => updItem(idx, 'cantidad', e.target.value)}
                      style={{ ...inputCell, textAlign: 'center' }}
                    />
                    <input
                      type="number" className="input mono"
                      min="0" step="0.01"
                      onKeyDown={blockInvalidNumberKeys}
                      value={it.valor_unitario}
                      onChange={e => updItem(idx, 'valor_unitario', e.target.value)}
                      placeholder="0.00"
                      style={{ ...inputCell, textAlign: 'right' }}
                    />
                    <span style={{
                      textAlign: 'right', padding: cellPad,
                      fontFamily: 'monospace', fontSize: 12,
                      color: st > 0 ? 'var(--text)' : 'var(--text-dim)',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {st > 0 ? fmtUSD(st) : '—'}
                    </span>
                    <button
                      onClick={() => removeItem(idx)}
                      type="button"
                      disabled={items.length === 1}
                      aria-label={`Eliminar producto ${idx + 1}`}
                      title={items.length === 1 ? 'Necesitás al menos un producto' : 'Eliminar producto'}
                      style={{
                        width: 24, height: 24, borderRadius: 4,
                        background: 'transparent', border: 'none',
                        color: items.length === 1 ? 'var(--text-dim)' : 'var(--text-muted)',
                        cursor: items.length === 1 ? 'not-allowed' : 'pointer',
                        display: 'grid', placeItems: 'center',
                        opacity: items.length === 1 ? 0.4 : 1,
                      }}
                    >
                      <Icons.X size={12} />
                    </button>
                  </div>
                );
              })}

              {/* Botón agregar producto */}
              <button className="btn btn-sm btn-ghost" onClick={addItem} type="button"
                      style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}>
                <Icons.Plus size={13} /> Agregar producto
              </button>
            </div>
          </div>

          {/* ── Footer sticky: total + preview + botones ── */}
          <div style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
            background: 'var(--surface)',
            display: 'flex', flexDirection: 'column', gap: 8,
            flexShrink: 0,
          }}>
            {/* Total */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              padding: '10px 14px', background: 'var(--surface-2)',
              border: '1px solid var(--border)', borderRadius: 6,
            }}>
              <span style={{
                fontSize: 11, color: 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>Total a cancelar</span>
              <span style={{
                fontSize: 18, fontWeight: 700, color: 'var(--pos)',
                fontVariantNumeric: 'tabular-nums',
              }}>{fmtUSD(totalUsd)}</span>
            </div>

            {/* Preview del saldo post-op */}
            {totalUsd > 0 && (
              <div style={previewStyle}>
                <span style={{ fontSize: 16 }}>{saldoCierraEnCero ? '✓' : '⚠'}</span>
                <div style={{ flex: 1 }}>
                  {saldoCierraEnCero ? (
                    <>
                      Después de la entrega: <strong style={{ color: 'var(--pos)' }}>saldo {primerNombre} = {fmtUSD(0)}</strong> (deuda cancelada).
                    </>
                  ) : saldoInvertido ? (
                    <>
                      Ojo: el cliente no tiene deuda o ya está a favor. Con la entrega queda en
                      {' '}<strong>{fmtUSD(saldoPost)}</strong>. Registrá antes una venta B2B si corresponde.
                    </>
                  ) : (
                    <>
                      Después de la entrega: <strong>saldo {primerNombre} = {fmtUSD(saldoPost)}</strong>
                      {' '}({saldoPost > 0 ? 'te va a seguir debiendo' : 'quedará a favor'}).
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="modal-ft" style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={tryClose} disabled={saving} type="button">
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={handleGuardar} disabled={saving} type="button">
            {saving ? 'Guardando…' : 'Registrar entrega'}
          </button>
        </div>
      </div>
    </div>
  );
}
