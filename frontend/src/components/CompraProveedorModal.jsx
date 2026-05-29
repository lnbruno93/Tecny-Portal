/**
 * Modal "Cargar Compra a Proveedor".
 *
 * Reemplaza la planilla inline antigua. Permite registrar una compra completa:
 *   - 1+ items, cada uno con TODOS los campos del producto (categoría, depósito,
 *     costo, precio, condición, etc.) para que entre directamente al Inventario.
 *   - Caja (opcional → queda a crédito) + TC manual si la caja no es USD.
 *   - Auto-fill: el "proveedor" del producto se llena con el nombre del proveedor
 *     (lo hace el backend al INSERT).
 *
 * Reglas (validadas también en backend):
 *   - Categoría obligatoria por item (lo exige el schema de Inventario).
 *   - IMEI duplicado (contra stock o dentro del payload) → 409 visible.
 *   - Pago siempre necesita caja; compras pueden no tener (queda a crédito).
 */
import { useState, useMemo, useEffect } from 'react';
import { Icons } from './Icons';
import { proveedores as provApi, inventario as invApi, cajas as cajasApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';

function todayISO() { return new Date().toLocaleDateString('sv'); }

// Forma de un item dentro del modal. Mantenemos `producto/modelo/tamano/color/
// imei_serial/valor` para el log clásico (espejo de proveedor_movimiento_items),
// y en paralelo todos los campos del producto que se va a crear en stock.
const mkItem = () => ({
  _id: Math.random().toString(36).slice(2),
  // Log
  producto: '', modelo: '', tamano: '', color: '',
  imei_serial: '',
  valor: '',           // monto USD de este item (informativo, no impacta caja)
  verificado: false,
  // Stock (camelCase opcional para crear producto)
  tipo_carga: 'unitario',
  clase: 'celular',
  nombre: '',          // requerido por backend (≥ 1 char)
  imei: '',
  gb: '',
  bateria: '',
  categoria_id: '',
  deposito_id: '',
  costo: '',
  costo_moneda: 'USD',
  precio_venta: '',
  precio_moneda: 'USD',
  cantidad: '1',
  condicion: 'nuevo',
  observaciones: '',
  // Flag para decidir si crear stock o sólo loguear (p.ej. flete, servicio).
  crear_stock: true,
});

export default function CompraProveedorModal({ proveedor, onClose, onSaved }) {
  const { toast } = useToast();

  // Cabecera de la compra
  const [fecha, setFecha] = useState(todayISO());
  const [cajaId, setCajaId] = useState('');
  const [tc, setTc] = useState('');
  const [notas, setNotas] = useState('');

  // Items
  const [items, setItems] = useState(() => [mkItem()]);

  // Catálogos
  const [categorias, setCategorias] = useState([]);
  const [depositos, setDepositos] = useState([]);
  const [cajas, setCajas] = useState([]);

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      invApi.categorias().catch(() => []),
      invApi.depositos().catch(() => []),
      cajasApi.listCajas().catch(() => []),
    ]).then(([c, d, k]) => {
      setCategorias(c || []);
      setDepositos(d || []);
      setCajas((k || []).filter(x => x.activo !== false));
    });
  }, []);

  // Helpers
  const monedaCaja = useMemo(() => {
    if (!cajaId) return 'USD';
    return cajas.find(c => String(c.id) === String(cajaId))?.moneda || 'USD';
  }, [cajaId, cajas]);

  const totalUsd = useMemo(() => {
    // Sumamos costos por item, todos convertidos a USD vía su propia moneda+tc-global.
    // (El TC se aplica al monto total a nivel caja, pero también acepto que
    // cada item tenga su moneda de costo distinta — se computa con el TC global
    // cuando aplica.)
    return items.reduce((acc, it) => {
      const v = Number(it.costo) * Number(it.cantidad || 1);
      if (!v) return acc;
      if (it.costo_moneda === 'USD') return acc + v;
      const tcN = Number(tc);
      if (!tcN) return acc; // sin TC, descartamos lo no-USD del total provisorio
      return acc + v / tcN;
    }, 0);
  }, [items, tc]);

  function updItem(idx, field, val) {
    setItems(arr => arr.map((it, i) => {
      if (i !== idx) return it;
      const next = { ...it, [field]: val };
      // Si pasa a "stock=false", limpia los campos extras irrelevantes
      if (field === 'crear_stock' && val === false) {
        // No tocamos por si vuelve a true
      }
      return next;
    }));
  }
  function addItem() { setItems(arr => [...arr, mkItem()]); }
  function rmItem(idx) {
    setItems(arr => arr.length <= 1 ? arr : arr.filter((_, i) => i !== idx));
  }

  function validar() {
    if (!fecha) return 'Falta la fecha';
    if (cajaId && monedaCaja !== 'USD' && (!Number(tc) || Number(tc) <= 0))
      return `Cargá el TC para convertir ${monedaCaja} → USD`;
    if (items.length === 0) return 'Agregá al menos un item';
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!Number(it.costo) || Number(it.costo) <= 0) return `Item #${i + 1}: cargá el costo`;
      if (it.crear_stock) {
        if (!it.nombre.trim()) return `Item #${i + 1}: el nombre es obligatorio para el stock`;
        if (!it.categoria_id) return `Item #${i + 1}: elegí categoría`;
        if (it.clase === 'celular' && it.tipo_carga === 'unitario' && Number(it.cantidad) !== 1)
          return `Item #${i + 1}: un celular unitario debe tener cantidad = 1`;
      }
    }
    // IMEI duplicados internos
    const imeis = items.filter(it => it.crear_stock && it.imei).map(it => it.imei.trim());
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
    setSaving(true);
    try {
      // Construir el payload.
      //   - `monto` va en la moneda de la caja (eso se descuenta literal).
      //   - `tc` traduce esa moneda a USD para el saldo auditado del proveedor.
      //   - Si no hay caja → `moneda` = USD, `tc` = null (queda como deuda en USD).
      const tcN = monedaCaja === 'USD' ? null : Number(tc);
      const montoEnMonedaCaja = monedaCaja === 'USD' ? totalUsd : totalUsd * tcN;
      const payload = {
        proveedor_id: proveedor.id,
        fecha,
        tipo: 'compra',
        monto: Number(montoEnMonedaCaja.toFixed(2)),
        moneda: monedaCaja,
        tc: tcN,
        caja_id: cajaId ? Number(cajaId) : null,
        notas: notas.trim() || null,
        items: items.map(it => {
          const baseLog = {
            producto: it.producto.trim() || it.nombre.trim() || null,
            modelo:   it.modelo.trim() || null,
            tamano:   it.tamano.trim() || it.gb.trim() || null,
            color:    it.color.trim() || null,
            imei_serial: (it.imei_serial || it.imei).trim() || null,
            valor:    Number(it.costo) || 0,
            verificado: !!it.verificado,
          };
          if (!it.crear_stock) return baseLog;
          // Sub-objeto producto_stock → backend crea producto.
          const num = (v) => v === '' || v == null ? null : Number(v);
          return {
            ...baseLog,
            producto_stock: {
              tipo_carga: it.tipo_carga,
              clase: it.clase,
              nombre: it.nombre.trim(),
              imei: it.imei.trim() || null,
              gb: it.gb.trim() || null,
              color: it.color.trim() || null,
              bateria: num(it.bateria),
              categoria_id: Number(it.categoria_id),
              deposito_id: it.deposito_id ? Number(it.deposito_id) : null,
              costo: Number(it.costo),
              costo_moneda: it.costo_moneda,
              precio_venta: Number(it.precio_venta) || 0,
              precio_moneda: it.precio_moneda,
              cantidad: Number(it.cantidad) || 1,
              condicion: it.condicion,
              observaciones: it.observaciones.trim() || null,
            },
          };
        }),
      };
      const res = await provApi.createMovimiento(payload);
      const creados = res.productos_creados?.length || 0;
      toast.success(`Compra registrada${creados ? ` · ${creados} producto${creados > 1 ? 's' : ''} al stock` : ''}`);
      onSaved?.(res);
      onClose();
    } catch (e) {
      toast.error(e.message || 'No se pudo guardar la compra');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 1100, width: '95vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <h3>Cargar compra · {proveedor.nombre}</h3>
          <button className="icon-btn" onClick={onClose}><Icons.X size={16} /></button>
        </div>

        <div className="modal-body" style={{ maxHeight: '80vh', overflowY: 'auto' }}>
          {/* ── Cabecera: fecha · caja · tc · notas ── */}
          <div className="row" style={{ marginBottom: 14 }}>
            <div className="field" style={{ flex: '0 0 140px' }}>
              <label className="field-label">Fecha</label>
              <input type="date" className="input" value={fecha} onChange={e => setFecha(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label">Pagar con</label>
              <select className="input" value={cajaId} onChange={e => setCajaId(e.target.value)}>
                <option value="">— Cuenta corriente (queda como deuda) —</option>
                {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>)}
              </select>
            </div>
            {cajaId && monedaCaja !== 'USD' && (
              <div className="field" style={{ flex: '0 0 130px' }}>
                <label className="field-label">TC {monedaCaja}→USD <span style={{ color: 'var(--neg)' }}>*</span></label>
                <input type="number" className="input mono" min="0" step="0.01"
                  value={tc} onChange={e => setTc(e.target.value)} placeholder="0" />
              </div>
            )}
          </div>

          {/* ── Items ── */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              Items de la compra · {items.length}
            </div>
            <button className="btn btn-sm" onClick={addItem}>
              <Icons.Plus size={13} /> Agregar item
            </button>
          </div>

          <div className="stack" style={{ gap: 12 }}>
            {items.map((it, idx) => (
              <ItemCard
                key={it._id}
                idx={idx}
                item={it}
                onChange={(field, val) => updItem(idx, field, val)}
                onRemove={() => rmItem(idx)}
                canRemove={items.length > 1}
                categorias={categorias}
                depositos={depositos}
              />
            ))}
          </div>

          {/* ── Notas + total ── */}
          <div className="row" style={{ marginTop: 14, alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label">Notas de la compra (opcional)</label>
              <input className="input" value={notas} onChange={e => setNotas(e.target.value)}
                placeholder="Ej. Pago con transferencia 9876, recibo #5421" />
            </div>
            <div style={{ flex: '0 0 200px', textAlign: 'right' }}>
              <div className="muted tiny">Total compra</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 800 }}>
                USD {totalUsd.toLocaleString('es-AR', { maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>
        </div>

        <div className="modal-ft">
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleGuardar}>
            {saving ? 'Guardando…' : 'Guardar compra'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Card de cada item ────────────────────────────────────────────────────
function ItemCard({ idx, item, onChange, onRemove, canRemove, categorias, depositos }) {
  const set = (f) => (e) => onChange(f, e.target.value);
  const setN = (f) => (e) => onChange(f, e.target.value);
  return (
    <div className="card card-tight" style={{ position: 'relative', padding: 12 }}>
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Item #{idx + 1}</div>
        <label className="flex-row" style={{ gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={item.crear_stock}
            onChange={e => onChange('crear_stock', e.target.checked)} />
          Crear en Inventario al guardar
        </label>
        {canRemove && (
          <button className="icon-btn" title="Quitar item"
            style={{ color: 'var(--neg)' }} onClick={onRemove}>
            <Icons.Trash size={14} />
          </button>
        )}
      </div>

      {/* Fila 1: clase + categoría + depósito + condición */}
      <div className="row">
        <div className="field" style={{ flex: '0 0 140px' }}>
          <label className="field-label">Tipo</label>
          <select className="input" value={item.clase} onChange={set('clase')} disabled={!item.crear_stock}>
            <option value="celular">Celular</option>
            <option value="accesorio">Accesorio</option>
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">Categoría {item.crear_stock && <span style={{ color: 'var(--neg)' }}>*</span>}</label>
          <select className="input" value={item.categoria_id} onChange={set('categoria_id')} disabled={!item.crear_stock}>
            <option value="">— Elegir —</option>
            {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">Depósito</label>
          <select className="input" value={item.deposito_id} onChange={set('deposito_id')} disabled={!item.crear_stock}>
            <option value="">Sin depósito</option>
            {depositos.map(d => <option key={d.id} value={d.id}>{d.nombre}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: '0 0 120px' }}>
          <label className="field-label">Condición</label>
          <select className="input" value={item.condicion} onChange={set('condicion')} disabled={!item.crear_stock}>
            <option value="nuevo">Nuevo</option>
            <option value="usado">Usado</option>
          </select>
        </div>
      </div>

      {/* Fila 2: nombre + imei + gb + bateria + color */}
      <div className="row">
        <div className="field" style={{ flex: 2 }}>
          <label className="field-label">Nombre {item.crear_stock && <span style={{ color: 'var(--neg)' }}>*</span>}</label>
          <input className="input" placeholder="ej. iPhone 15 Pro" value={item.nombre} onChange={set('nombre')} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">IMEI/Serial</label>
          <input className="input mono" placeholder="356938…" value={item.imei} onChange={set('imei')} />
        </div>
        <div className="field" style={{ flex: '0 0 90px' }}>
          <label className="field-label">GB</label>
          <input className="input" placeholder="256" value={item.gb} onChange={set('gb')} />
        </div>
        <div className="field" style={{ flex: '0 0 80px' }}>
          <label className="field-label">Batería %</label>
          <input type="number" className="input mono" placeholder="100" value={item.bateria} onChange={set('bateria')} />
        </div>
        <div className="field" style={{ flex: '0 0 110px' }}>
          <label className="field-label">Color</label>
          <input className="input" placeholder="Negro" value={item.color} onChange={set('color')} />
        </div>
      </div>

      {/* Fila 3: tipo_carga + cantidad + costo + precio venta */}
      <div className="row">
        <div className="field" style={{ flex: '0 0 130px' }}>
          <label className="field-label">Tipo carga</label>
          <select className="input" value={item.tipo_carga} onChange={set('tipo_carga')} disabled={!item.crear_stock}>
            <option value="unitario">Unitario</option>
            <option value="lote">Lote</option>
          </select>
        </div>
        <div className="field" style={{ flex: '0 0 100px' }}>
          <label className="field-label">Cantidad</label>
          <input type="number" min="1" className="input mono" value={item.cantidad} onChange={setN('cantidad')} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">Costo unit. <span style={{ color: 'var(--neg)' }}>*</span></label>
          <div className="flex-row" style={{ gap: 6 }}>
            <input type="number" min="0" className="input mono" placeholder="0"
              value={item.costo} onChange={set('costo')} style={{ flex: 1 }} />
            <select className="input" style={{ width: 80 }} value={item.costo_moneda} onChange={set('costo_moneda')}>
              <option>USD</option><option>ARS</option>
            </select>
          </div>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">Precio venta</label>
          <div className="flex-row" style={{ gap: 6 }}>
            <input type="number" min="0" className="input mono" placeholder="0"
              value={item.precio_venta} onChange={set('precio_venta')} style={{ flex: 1 }} disabled={!item.crear_stock} />
            <select className="input" style={{ width: 80 }} value={item.precio_moneda} onChange={set('precio_moneda')} disabled={!item.crear_stock}>
              <option>USD</option><option>ARS</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
