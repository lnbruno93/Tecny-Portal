/**
 * RecepcionStock — pantalla mobile-first para registrar stock entrante
 * escaneando IMEIs con la cámara del celular.
 *
 * Reemplaza el flujo XLSX + ticketeadora-lector. El operador:
 *   1. Setea datos comunes de la sesión (proveedor, depósito).
 *   2. Define el "modelo activo" (nombre/color/GB/costo/precio) — se aplica
 *      a los próximos scans. Lo puede cambiar mid-sesión si la caja es mixta.
 *   3. Toca "Escanear IMEI" — se abre la cámara y cada scan suma una unidad
 *      al lote con los atributos del modelo activo en ese momento.
 *   4. Al final "Guardar todo" — un POST /productos/bulk crea N productos en
 *      una transacción atómica con audit log.
 *
 * Validaciones del cliente:
 *   · IMEI 14-17 dígitos numéricos (algunos fabricantes usan códigos no-IMEI
 *     en Code128 — aceptamos rango amplio pero rechazamos basura como QR de
 *     URLs).
 *   · Luhn check para IMEIs de 15 dígitos (estándar GSMA).
 *   · Modelo activo requiere nombre + categoría.
 *
 * Validaciones del backend:
 *   · IMEIs duplicados dentro del lote → 400.
 *   · IMEIs ya existentes en inventario → 409 con lista (raro acá porque el
 *     scanner ya ignora los que están en la lista local, pero defendemos
 *     contra el caso "alguien más cargó el mismo IMEI mientras yo scaneaba").
 */
import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { inventario, proveedores as proveedoresApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { Icons } from '../components/Icons';
import BarcodeScanner from '../components/BarcodeScanner';

// Luhn check para IMEI estándar GSMA (15 dígitos). Para 14/16/17 (serial
// numbers de otros fabricantes) saltamos el check pero validamos formato.
function isValidImei(s) {
  const code = String(s || '').trim();
  if (!/^\d{14,17}$/.test(code)) return false;
  if (code.length !== 15) return true; // formato OK pero sin Luhn
  // Luhn (mod 10) en los 15 dígitos.
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(code[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const fmtNumero = (n) => Math.round(Number(n) || 0).toLocaleString('es-AR');

export default function RecepcionStock() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();

  // Catálogos para selectores.
  const [cats,    setCats]    = useState([]);
  const [deps,    setDeps]    = useState([]);
  const [provs,   setProvs]   = useState([]);
  const [loadingCats, setLoadingCats] = useState(true);

  // Datos comunes de la sesión.
  const [deposito_id, setDepositoId] = useState('');
  const [proveedor,   setProveedor]  = useState('');

  // Modelo activo — se aplica a los próximos scans.
  const [mNombre,    setMNombre]    = useState('');
  const [mCategoria, setMCategoria] = useState('');
  const [mColor,     setMColor]     = useState('');
  const [mGb,        setMGb]        = useState('');
  const [mCondicion, setMCondicion] = useState('nuevo');
  const [mCosto,     setMCosto]     = useState('');
  const [mCostoMoneda, setMCostoMoneda] = useState('USD');
  const [mPrecio,    setMPrecio]    = useState('');
  const [mPrecioMoneda, setMPrecioMoneda] = useState('USD');

  // Lote scaneado (cada item es snapshot del modelo activo + IMEI).
  const [items, setItems] = useState([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualImei, setManualImei]   = useState('');
  const [guardando, setGuardando] = useState(false);

  // Cargar catálogos al montar.
  useEffect(() => {
    let cancelado = false;
    setLoadingCats(true);
    Promise.all([
      inventario.categorias().catch(() => []),
      inventario.depositos().catch(() => []),
      proveedoresApi.list({ limit: 500 }).then(r => r.data || r).catch(() => []),
    ]).then(([c, d, p]) => {
      if (cancelado) return;
      setCats(c || []);
      setDeps(d || []);
      setProvs(Array.isArray(p) ? p : (p?.data || []));
    }).finally(() => { if (!cancelado) setLoadingCats(false); });
    return () => { cancelado = true; };
  }, []);

  // Validación del modelo activo (sin esto no podés scanear).
  const modeloListo = mNombre.trim() && mCategoria;

  // Set de IMEIs ya en el lote — pasamos al scanner para que ignore re-scans.
  const imeisYaEnLote = items.map(it => it.imei);

  // Handler de cada scan (manual o cámara).
  const agregarImei = useCallback((rawCode) => {
    const code = String(rawCode || '').trim();
    if (!code) return;
    if (!isValidImei(code)) {
      toast.error(`"${code.slice(0, 20)}…" no parece un IMEI válido. Esperaba 14-17 dígitos.`);
      return;
    }
    if (items.some(it => it.imei === code)) {
      toast.info('Ese IMEI ya está en el lote.');
      return;
    }
    if (!modeloListo) {
      toast.error('Primero completá nombre + categoría del modelo activo.');
      return;
    }
    // Snapshot del modelo activo. Si después el usuario cambia los selectors,
    // este item conserva sus valores (lo que define el flow "mixto").
    const nuevo = {
      imei: code,
      nombre:    mNombre.trim(),
      categoria_id: Number(mCategoria),
      color:     mColor.trim() || null,
      gb:        mGb.trim() || null,
      condicion: mCondicion,
      costo:     Number(mCosto) || 0,
      costo_moneda:  mCostoMoneda,
      precio_venta:  Number(mPrecio) || 0,
      precio_moneda: mPrecioMoneda,
      // tipo_carga + clase + cantidad ya tienen defaults en backend.
    };
    setItems(prev => [nuevo, ...prev]); // los más nuevos arriba (visible al instante)
  }, [items, modeloListo, mNombre, mCategoria, mColor, mGb, mCondicion, mCosto, mCostoMoneda, mPrecio, mPrecioMoneda, toast]);

  // Tipear IMEI manual (fallback si la cámara no anda).
  const onSubmitManual = (e) => {
    e.preventDefault();
    if (!manualImei.trim()) return;
    agregarImei(manualImei);
    setManualImei('');
  };

  // Borrar un item del lote (si se equivocó o lo agregó duplicado).
  const eliminarItem = (idx) => {
    setItems(prev => prev.filter((_, i) => i !== idx));
  };

  // Editar un campo puntual de un item (costo, precio, etc.). Lo necesitamos
  // porque dentro de una caja con varios modelos del mismo tipo, el costo y
  // el precio de venta pueden variar producto-a-producto (un usado con
  // detalle, una unidad demo, una negociación puntual).
  const editarItem = (idx, campo, valor) => {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, [campo]: valor } : it));
  };

  // Guardar todo el lote.
  const guardar = async () => {
    if (items.length === 0) { toast.error('No hay productos cargados.'); return; }
    const proveedor_str = proveedor.trim() || null;
    const ok = await confirm({
      title: 'Confirmar recepción',
      message: (
        <>
          <p>Vas a cargar <b>{items.length} productos</b> al inventario.</p>
          {deposito_id && <p>Depósito: <b>{deps.find(d => d.id === Number(deposito_id))?.nombre || '?'}</b></p>}
          {proveedor_str && <p>Proveedor: <b>{proveedor_str}</b></p>}
          <p>¿Continuar?</p>
        </>
      ),
      confirmLabel: 'Sí, cargar',
    });
    if (!ok) return;

    setGuardando(true);
    try {
      const productos = items.map(it => ({
        ...it,
        deposito_id: deposito_id ? Number(deposito_id) : null,
        proveedor:   proveedor_str,
        clase:      'celular',     // recepción es siempre celulares (los accesorios van por XLSX)
        tipo_carga: 'unitario',    // 1 producto = 1 IMEI
        cantidad:   1,
      }));
      const r = await inventario.bulkProductos(productos);
      toast.success(`✓ ${r.creados} productos cargados al inventario.`);
      // Limpiamos sólo los items — dejamos los defaults del modelo activo y
      // los datos comunes por si quieren cargar otra caja seguida.
      setItems([]);
    } catch (err) {
      if (err?.message === 'NO_AUTH') return;
      // Si el backend devolvió 409 con duplicados, mostramos cuáles.
      if (err?.duplicados?.length) {
        toast.error(`Estos IMEIs ya existen en el inventario: ${err.duplicados.join(', ')}`);
      } else {
        toast.error(err?.message || 'No se pudo guardar el lote.');
      }
    } finally {
      setGuardando(false);
    }
  };

  // Cancelar la sesión completa (con confirm si hay items).
  const cancelar = async () => {
    if (items.length > 0) {
      const ok = await confirm({
        title: 'Descartar lote',
        message: <p>Vas a perder <b>{items.length}</b> productos scaneados que aún no se guardaron. ¿Continuar?</p>,
        confirmLabel: 'Sí, descartar',
        tone: 'danger',
      });
      if (!ok) return;
    }
    navigate('/inventario');
  };

  return (
    <div className="content" style={{ paddingBottom: 80 }}>
      {/* Header */}
      <div className="page-head" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icons.Box size={20} /> Recepción de stock
          </h2>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            Escaneá los IMEIs con la cámara. Cambiá el modelo activo cuando cambies de producto.
          </div>
        </div>
        <Link to="/inventario" className="btn" aria-label="Volver al inventario">
          <Icons.ArrowRight size={14} style={{ transform: 'rotate(180deg)' }} /> Volver
        </Link>
      </div>

      {/* 1. Datos comunes */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-hd"><h3>1. Datos comunes de la recepción</h3></div>
        <div style={{ padding: 14, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <label>
            <div className="muted tiny" style={{ marginBottom: 4 }}>Depósito</div>
            <select className="input" value={deposito_id} onChange={e => setDepositoId(e.target.value)} disabled={loadingCats}>
              <option value="">— Sin asignar —</option>
              {deps.map(d => <option key={d.id} value={d.id}>{d.nombre}</option>)}
            </select>
          </label>
          <label>
            <div className="muted tiny" style={{ marginBottom: 4 }}>Proveedor</div>
            <input
              className="input"
              list="provs-recepcion"
              placeholder="Buscar o tipear…"
              value={proveedor}
              onChange={e => setProveedor(e.target.value)}
            />
            <datalist id="provs-recepcion">
              {provs.map(p => <option key={p.id} value={p.nombre} />)}
            </datalist>
          </label>
        </div>
      </div>

      {/* 2. Modelo activo */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-hd">
          <h3>2. Modelo activo <span className="muted tiny" style={{ marginLeft: 6 }}>(se aplica a los próximos scans)</span></h3>
        </div>
        <div style={{ padding: 14, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <label style={{ gridColumn: 'span 2' }}>
            <div className="muted tiny" style={{ marginBottom: 4 }}>Nombre / Modelo *</div>
            <input className="input" placeholder="Ej: Samsung Galaxy A55" value={mNombre} onChange={e => setMNombre(e.target.value)} />
          </label>
          <label>
            <div className="muted tiny" style={{ marginBottom: 4 }}>Categoría *</div>
            <select className="input" value={mCategoria} onChange={e => setMCategoria(e.target.value)} disabled={loadingCats}>
              <option value="">— Elegir —</option>
              {cats.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </label>
          <label>
            <div className="muted tiny" style={{ marginBottom: 4 }}>Color</div>
            <input className="input" placeholder="Negro / Blanco / …" value={mColor} onChange={e => setMColor(e.target.value)} />
          </label>
          <label>
            <div className="muted tiny" style={{ marginBottom: 4 }}>Capacidad</div>
            <input className="input" placeholder="128GB / 256GB" value={mGb} onChange={e => setMGb(e.target.value)} />
          </label>
          <label>
            <div className="muted tiny" style={{ marginBottom: 4 }}>Condición</div>
            <select className="input" value={mCondicion} onChange={e => setMCondicion(e.target.value)}>
              <option value="nuevo">Nuevo</option>
              <option value="usado">Usado</option>
            </select>
          </label>
          <label>
            <div className="muted tiny" style={{ marginBottom: 4 }}>Costo unitario</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input className="input" inputMode="decimal" placeholder="0" value={mCosto} onChange={e => setMCosto(e.target.value)} style={{ flex: 1 }} />
              <select className="input" value={mCostoMoneda} onChange={e => setMCostoMoneda(e.target.value)} style={{ width: 70 }}>
                <option>USD</option>
                <option>ARS</option>
              </select>
            </div>
          </label>
          <label>
            <div className="muted tiny" style={{ marginBottom: 4 }}>Precio venta</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input className="input" inputMode="decimal" placeholder="0" value={mPrecio} onChange={e => setMPrecio(e.target.value)} style={{ flex: 1 }} />
              <select className="input" value={mPrecioMoneda} onChange={e => setMPrecioMoneda(e.target.value)} style={{ width: 70 }}>
                <option>USD</option>
                <option>ARS</option>
              </select>
            </div>
          </label>
        </div>
        {!modeloListo && (
          <div style={{ padding: '0 14px 14px', color: 'var(--neg)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icons.Alert size={12} /> Completá nombre + categoría para habilitar el scanner.
          </div>
        )}
      </div>

      {/* 3. Scanner + manual */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-hd">
          <h3>3. Escanear IMEI <span className="muted tiny" style={{ marginLeft: 6 }}>({items.length} cargados)</span></h3>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            className="btn btn-primary"
            onClick={() => setScannerOpen(true)}
            disabled={!modeloListo}
            style={{ minHeight: 56, fontSize: 16, fontWeight: 600 }}
            aria-label="Abrir cámara para escanear IMEI"
          >
            <Icons.Camera size={18} /> Escanear con cámara
          </button>
          <form onSubmit={onSubmitManual} style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              type="text"
              inputMode="numeric"
              placeholder="O tipeá el IMEI a mano…"
              value={manualImei}
              onChange={e => setManualImei(e.target.value.replace(/\D/g, ''))}
              maxLength={17}
              disabled={!modeloListo}
              style={{ flex: 1 }}
              aria-label="IMEI manual"
            />
            <button className="btn" type="submit" disabled={!modeloListo || !manualImei.trim()}>
              <Icons.Plus size={14} /> Sumar
            </button>
          </form>
        </div>
      </div>

      {/* 4. Lista de items con costo + precio editables por fila.
          Diseño en cards (no tabla) porque en mobile los inputs de moneda
          + edit inline son incómodos en celdas estrechas. Cada card = un
          producto, ocupa todo el ancho y es fácil de tocar con el pulgar. */}
      {items.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-hd">
            <h3>4. Productos a cargar ({items.length})</h3>
            <div className="muted tiny" style={{ marginLeft: 8 }}>
              Tocá costo o precio para ajustarlo individualmente.
            </div>
          </div>
          <div style={{ maxHeight: '55vh', overflowY: 'auto', padding: 8 }}>
            {items.map((it, idx) => (
              <div
                key={it.imei}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: 10,
                  marginBottom: 8,
                  border: '1px solid var(--hairline)',
                  borderRadius: 8,
                  background: 'var(--surface)',
                }}
              >
                {/* Header de card: IMEI + delete */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{it.imei}</div>
                    <div style={{ fontSize: 13, marginTop: 2 }}>{it.nombre}</div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {[it.color, it.gb, it.condicion].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <button
                    className="icon-btn"
                    onClick={() => eliminarItem(idx)}
                    aria-label={`Eliminar ${it.imei} del lote`}
                    title="Eliminar del lote"
                  >
                    <Icons.X size={14} />
                  </button>
                </div>
                {/* Costo + Precio editables */}
                <div style={{ display: 'flex', gap: 8 }}>
                  <label style={{ flex: 1 }}>
                    <div className="muted tiny" style={{ marginBottom: 2 }}>Costo</div>
                    <div style={{ display: 'flex', gap: 2 }}>
                      <input
                        className="input"
                        type="text"
                        inputMode="decimal"
                        value={it.costo}
                        onChange={e => editarItem(idx, 'costo', Number(e.target.value.replace(/[^\d.,]/g, '').replace(',', '.')) || 0)}
                        aria-label={`Costo de ${it.imei}`}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <select
                        className="input"
                        value={it.costo_moneda}
                        onChange={e => editarItem(idx, 'costo_moneda', e.target.value)}
                        aria-label="Moneda del costo"
                        style={{ width: 60 }}
                      >
                        <option>USD</option>
                        <option>ARS</option>
                      </select>
                    </div>
                  </label>
                  <label style={{ flex: 1 }}>
                    <div className="muted tiny" style={{ marginBottom: 2 }}>Precio venta</div>
                    <div style={{ display: 'flex', gap: 2 }}>
                      <input
                        className="input"
                        type="text"
                        inputMode="decimal"
                        value={it.precio_venta}
                        onChange={e => editarItem(idx, 'precio_venta', Number(e.target.value.replace(/[^\d.,]/g, '').replace(',', '.')) || 0)}
                        aria-label={`Precio venta de ${it.imei}`}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <select
                        className="input"
                        value={it.precio_moneda}
                        onChange={e => editarItem(idx, 'precio_moneda', e.target.value)}
                        aria-label="Moneda del precio"
                        style={{ width: 60 }}
                      >
                        <option>USD</option>
                        <option>ARS</option>
                      </select>
                    </div>
                  </label>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 5. Acciones — sticky bottom para alcanzarlas con el pulgar en mobile */}
      <div style={{
        position: 'sticky', bottom: 0, marginTop: 16,
        padding: '12px 0',
        background: 'linear-gradient(0deg, var(--surface) 70%, transparent)',
        display: 'flex', gap: 8,
      }}>
        <button className="btn" onClick={cancelar} disabled={guardando} style={{ flex: 1 }}>
          Cancelar
        </button>
        <button
          className="btn btn-primary"
          onClick={guardar}
          disabled={guardando || items.length === 0}
          style={{ flex: 2 }}
        >
          <Icons.Check size={14} />
          {guardando ? ' Guardando…' : ` Guardar ${items.length} productos`}
        </button>
      </div>

      {/* Modal scanner */}
      <BarcodeScanner
        open={scannerOpen}
        ignoreCodes={imeisYaEnLote}
        onScan={agregarImei}
        onClose={() => setScannerOpen(false)}
      />
    </div>
  );
}
