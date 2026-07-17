/**
 * Modal "Entrega de mercadería" — proveedor cancela deuda con productos.
 *
 * Task #150 (2026-07-17). Backend en PR #648 — este modal consume
 * `POST /api/proveedores/movimientos` con `tipo=entrega_mercaderia`.
 *
 * Diferencias vs CompraProveedorModal:
 *  - Es un flujo puntual (no data entry masivo) → sin defaults, sin spreadsheet.
 *  - Sin caja / TC / moneda (backend rechaza caja_id + valida monto USD).
 *  - Cada item SIEMPRE crea producto en stock (los productos SON el pago —
 *    no tiene sentido registrar entrega sin ingresar stock).
 *  - Preview del saldo post-op (banner verde/amber según cierre en 0 o quede
 *    remanente) para que el user entienda el impacto ANTES de guardar.
 *
 * Diseño UX (mockup validado con Lucas en /tmp/entrega-mercaderia-mockup):
 *  - Header: fecha + concepto (opcional).
 *  - Items: cards con producto (input con datalist para autocomplete de
 *    catálogo existente), categoría, IMEI/serial, cantidad, valor unitario.
 *  - Total y preview de saldo en tiempo real.
 *  - Guardar permitido aunque el total no coincida con la deuda (queda saldo
 *    remanente) — decisión de Lucas: el user ve el preview y decide.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import useModal from '../lib/useModal';
import { Icons } from './Icons';
import { proveedores as provApi, inventario as invApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmModal';
import { blockInvalidNumberKeys } from '../lib/inputUtils';

const fmtUSD = (n) => `USD ${Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function todayISO() { return new Date().toLocaleDateString('sv'); }

// Genera un item vacío. tipo_carga y clase quedan con defaults sensatos
// (unitario + celular_sellado) — el user puede editarlos si es otra cosa.
const mkItem = () => ({
  _id: Math.random().toString(36).slice(2),
  nombre: '',
  categoria_id: '',
  clase_id: '',
  imei: '',
  cantidad: '1',
  valor_unitario: '',
});

export default function EntregaMercaderiaModal({ proveedor, saldoActual, onClose, onSaved }) {
  const { toast } = useToast();
  const confirm = useConfirm();

  const [fecha, setFecha] = useState(todayISO());
  const [concepto, setConcepto] = useState('');
  const [items, setItems] = useState([mkItem()]);
  const [saving, setSaving] = useState(false);

  // Catálogos: categorías + clases (para el dropdown) + productos existentes
  // (para autocomplete de nombre — datalist HTML nativo, sin fetch per-keystroke).
  const [categorias, setCategorias] = useState([]);
  const [clases, setClases] = useState([]);
  const [productosCatalogo, setProductosCatalogo] = useState([]);
  const [catalogosError, setCatalogosError] = useState(null);

  // 2026-07-12 Pattern G — Idempotency-Key regenerado al abrir. Doble click en
  // "Registrar entrega" usa el MISMO key → replay backend en vez de duplicar.
  const [idemKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    Promise.allSettled([
      invApi.categorias(),
      invApi.clases(),
      invApi.productos({ limit: 100 }), // primeros 100 productos para autocomplete
    ]).then(([rc, rcl, rp]) => {
      const errores = [];
      if (rc.status === 'fulfilled') setCategorias(rc.value || []); else errores.push('categorías');
      if (rcl.status === 'fulfilled') setClases(rcl.value || []); else errores.push('clases');
      if (rp.status === 'fulfilled') {
        // El endpoint devuelve { data: [...] } paginado.
        const list = rp.value?.data || [];
        // Dedupe por nombre para el datalist (los IMEIs no son útiles como sugerencia).
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

  // Saldo previsto post-operación: saldo actual + total entregado.
  // Convención del backend: saldo positivo = les debemos. Entrega baja el
  // saldo (mismo signo que un pago).
  const saldoPost = useMemo(() => Number(saldoActual || 0) - totalUsd, [saldoActual, totalUsd]);
  const saldoCierraEnCero = Math.abs(saldoPost) < 0.01;
  // Si el proveedor tenía saldo a favor (saldoActual < 0) y con la entrega
  // seguimos yendo más negativo, es un warning suave — probablemente el user
  // olvidó cargar la compra que compensa. Le damos guardar de todos modos.
  const saldoInvertido = Number(saldoActual || 0) < 0 && totalUsd > 0;

  function updItem(idx, field, value) {
    setItems(items => items.map((it, i) => i === idx ? { ...it, [field]: value } : it));
  }

  function addItem() {
    setItems(items => [...items, mkItem()]);
  }

  function removeItem(idx) {
    setItems(items => items.length > 1 ? items.filter((_, i) => i !== idx) : items);
  }

  // Autocomplete: si el user selecciona un producto del datalist que ya existe
  // en catálogo, dejamos que el input se llene — la lógica de categoría queda
  // manual porque el mismo nombre puede pertenecer a distintas categorías
  // según cómo lo cargue el user.

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
    }
    if (totalUsd <= 0) return 'El total debe ser mayor a 0';
    // IMEI duplicados dentro del mismo lote.
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
    // Si el saldo NO cierra en 0 y el user no viene del preview, confirmamos.
    if (!saldoCierraEnCero && !saldoInvertido) {
      const remanente = saldoPost;
      const msg = remanente > 0
        ? `Después de la entrega el proveedor seguirá teniendo saldo positivo de ${fmtUSD(remanente)} (le seguirás debiendo). ¿Guardar igual?`
        : `Después de la entrega el proveedor quedará con ${fmtUSD(remanente)} a favor. ¿Guardar igual?`;
      const ok = await confirm({
        title: 'La entrega no cancela toda la deuda',
        message: msg,
        confirmLabel: 'Guardar entrega',
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      // Cada item entrega → producto_stock en la request (backend PR #648 crea
      // los productos + IMEI validation en 1 sola transacción).
      const payload = {
        proveedor_id: proveedor.id,
        fecha,
        tipo: 'entrega_mercaderia',
        descripcion: concepto.trim() || null,
        monto: Number(totalUsd.toFixed(2)),
        moneda: 'USD',
        // Sin caja_id, sin tc → el backend rechaza si vienen.
        items: items.map(it => ({
          producto: it.nombre.trim(),
          imei_serial: it.imei.trim() || null,
          valor: Number(it.valor_unitario) || 0,
          verificado: false,
          producto_stock: {
            tipo_carga: 'unitario',
            clase_id: it.clase_id,
            nombre: it.nombre.trim(),
            imei: it.imei.trim() || null,
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
      const res = await provApi.createMovimiento(payload, idemKey);
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

  // Estilos inline (mismos tokens del portal, pattern de CompraProveedorModal).
  const bannerSaldoStyle = {
    background: 'var(--warn-soft, rgba(251,191,36,0.14))',
    border: '1px solid var(--warn, #fbbf24)',
    borderRadius: 8,
    padding: '12px 14px',
    marginBottom: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: 13,
  };
  const previewStyle = {
    marginTop: 12,
    padding: '14px 16px',
    background: saldoCierraEnCero
      ? 'linear-gradient(180deg, var(--pos-soft, rgba(74,222,128,0.12)), transparent 60%), var(--surface-2)'
      : 'linear-gradient(180deg, var(--warn-soft, rgba(251,191,36,0.14)), transparent 60%), var(--surface-2)',
    border: `1px solid ${saldoCierraEnCero ? 'var(--pos, #4ade80)' : 'var(--warn, #fbbf24)'}`,
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    fontSize: 13,
    color: 'var(--text-2)',
  };
  const itemCardStyle = {
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
    position: 'relative',
  };
  const totalLineStyle = {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
    padding: '14px 18px', background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 8, marginTop: 8,
  };

  return (
    <div ref={overlayRef} className="modal-overlay" role="dialog" aria-modal="true"
         aria-labelledby="entrega-modal-title"
         onClick={(e) => { if (e.target === e.currentTarget) tryClose(); }}>
      <div className="modal" style={{ maxWidth: 760, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <h3 id="entrega-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icons.Box size={16} /> Entrega de mercadería · {proveedor.nombre}
          </h3>
          <button className="icon-btn" onClick={tryClose} aria-label="Cerrar modal">
            <Icons.X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ maxHeight: '78vh', overflowY: 'auto', padding: 20 }}>
          {catalogosError && (
            <div style={{
              padding: '10px 12px', marginBottom: 12, borderRadius: 6,
              background: 'var(--warn-soft, rgba(251,191,36,0.14))',
              border: '1px solid var(--warn)',
              fontSize: 12,
            }}>
              ⚠ No se pudieron cargar: <strong>{catalogosError.join(', ')}</strong>. Algunos selectores estarán vacíos.
            </div>
          )}

          {/* Saldo actual del proveedor */}
          <div style={bannerSaldoStyle}>
            <span style={{ color: 'var(--text-2)' }}>
              Saldo actual {Number(saldoActual || 0) >= 0 ? '(le debemos)' : '(nos debe)'}
            </span>
            <span style={{
              fontWeight: 600, fontSize: 15,
              color: Number(saldoActual || 0) > 0 ? 'var(--neg)' : Number(saldoActual || 0) < 0 ? 'var(--pos)' : 'var(--text-muted)',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {fmtUSD(Number(saldoActual || 0))}
            </span>
          </div>

          {/* Fecha + concepto */}
          <div className="row" style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, marginBottom: 4 }}>
            <div className="field">
              <label className="field-label">Fecha</label>
              <input type="date" className="input" value={fecha}
                     onChange={e => setFecha(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label">Concepto (opcional)</label>
              <input type="text" className="input" placeholder="Ej: entrega parcial pedido plays"
                     value={concepto} onChange={e => setConcepto(e.target.value)} />
            </div>
          </div>

          {/* Items */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '16px 0 10px' }}>
            <span style={{
              fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em',
              color: 'var(--text-muted)', fontWeight: 600,
            }}>
              Productos que entrega
            </span>
            <button className="btn btn-sm btn-primary" onClick={addItem} type="button">
              <Icons.Plus size={13} /> Agregar producto
            </button>
          </div>

          {/* Datalist para autocomplete de nombres (HTML nativo, sin fetch per-keystroke). */}
          <datalist id="entrega-productos-catalogo">
            {productosCatalogo.map((n, i) => <option key={i} value={n} />)}
          </datalist>

          {items.map((it, idx) => (
            <div key={it._id} style={itemCardStyle}>
              {items.length > 1 && (
                <button
                  onClick={() => removeItem(idx)} type="button"
                  aria-label={`Eliminar producto ${idx + 1}`}
                  style={{
                    position: 'absolute', top: 8, right: 8,
                    width: 24, height: 24, borderRadius: 4,
                    background: 'transparent', border: 'none',
                    color: 'var(--text-dim, #525c79)', cursor: 'pointer',
                    display: 'grid', placeItems: 'center',
                  }}
                >
                  <Icons.X size={12} />
                </button>
              )}

              {/* Línea 1: nombre (datalist autocomplete) + categoría interna */}
              <div className="row" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, marginBottom: 10 }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="field-label">Producto</label>
                  <input
                    type="text" className="input"
                    list="entrega-productos-catalogo"
                    placeholder="Ej: PlayStation 5 Slim"
                    value={it.nombre}
                    onChange={e => updItem(idx, 'nombre', e.target.value)}
                    autoFocus={idx === 0}
                  />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="field-label">Categoría</label>
                  <select className="input" value={it.clase_id}
                          onChange={e => updItem(idx, 'clase_id', e.target.value)}>
                    <option value="">—</option>
                    {clases.filter(c => c.activa !== false && !c.es_sin_categoria).map(c => (
                      <option key={c.id} value={c.id}>{c.emoji ? `${c.emoji} ${c.nombre}` : c.nombre}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Línea 2: IMEI + cantidad + valor unitario */}
              <div className="row" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="field-label">IMEI / Serial (opcional)</label>
                  <input type="text" className="input" value={it.imei}
                         onChange={e => updItem(idx, 'imei', e.target.value)}
                         placeholder="—" />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="field-label">Cantidad</label>
                  <input type="number" className="input mono" min="1" step="1"
                         onKeyDown={blockInvalidNumberKeys}
                         value={it.cantidad}
                         onChange={e => updItem(idx, 'cantidad', e.target.value)} />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="field-label">Valor unitario (USD)</label>
                  <input type="number" className="input mono" min="0" step="0.01"
                         onKeyDown={blockInvalidNumberKeys}
                         value={it.valor_unitario}
                         onChange={e => updItem(idx, 'valor_unitario', e.target.value)}
                         placeholder="0.00" />
                </div>
              </div>

              {/* Colección (opcional, si el tenant la usa) */}
              {categorias.length > 0 && (
                <div className="field" style={{ marginBottom: 0, marginTop: 10 }}>
                  <label className="field-label">Colección (opcional)</label>
                  <select className="input" value={it.categoria_id}
                          onChange={e => updItem(idx, 'categoria_id', e.target.value)}>
                    <option value="">— Sin colección —</option>
                    {categorias.map(c => (
                      <option key={c.id} value={c.id}>{c.nombre}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          ))}

          {/* Total */}
          <div style={totalLineStyle}>
            <span style={{
              fontSize: 12, color: 'var(--text-muted)',
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>Total a cancelar</span>
            <span style={{
              fontSize: 22, fontWeight: 700, color: 'var(--pos)',
              fontVariantNumeric: 'tabular-nums',
            }}>{fmtUSD(totalUsd)}</span>
          </div>

          {/* Preview del saldo post-op */}
          {totalUsd > 0 && (
            <div style={previewStyle}>
              <span style={{ fontSize: 20 }}>{saldoCierraEnCero ? '✓' : '⚠'}</span>
              <div style={{ flex: 1 }}>
                {saldoCierraEnCero ? (
                  <>
                    Después de esta entrega: <strong style={{ color: 'var(--pos)' }}>saldo {proveedor.nombre.split(' ')[0]} = {fmtUSD(0)}</strong> (deuda cancelada).
                  </>
                ) : saldoInvertido ? (
                  <>
                    Ojo: el proveedor tiene <strong>saldo a favor</strong> — sumar la entrega lo lleva a
                    {' '}<strong>{fmtUSD(saldoPost)}</strong>. Registrá primero la compra correspondiente para compensar.
                  </>
                ) : (
                  <>
                    Después de esta entrega: <strong>saldo {proveedor.nombre.split(' ')[0]} = {fmtUSD(saldoPost)}</strong>
                    {' '}({saldoPost > 0 ? 'seguís debiendo' : 'quedará a favor'}).
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal-ft" style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
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
