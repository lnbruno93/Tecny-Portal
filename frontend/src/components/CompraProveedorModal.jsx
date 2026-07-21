/**
 * Modal "Cargar Compra a Proveedor" — planilla spreadsheet.
 *
 * Pensado para data entry rápido de 50-100 items en una sola compra:
 *   - Defaults arriba (categoría, depósito, condición, monedas, etc.) que se
 *     aplican a cada fila nueva. Vos sólo editás lo que cambia fila por fila.
 *   - Tabla con scroll horizontal y todas las columnas del producto.
 *   - Tab / Shift+Tab para navegar como Excel. Enter en la última celda
 *     guarda y avanza a la siguiente fila.
 *   - "Pegar desde Excel" toma el clipboard y crea N filas de un saque
 *     (orden esperado: Nombre · IMEI · GB · Color · Batería · Costo · Precio).
 *   - "+ 10 filas" agrega 10 vacías con defaults.
 *   - Total compra (USD) calculado al vuelo respetando monedas + TC.
 *
 * Al guardar (1 sola TX en backend):
 *   1. proveedor_movimiento (tipo=compra) + log de items.
 *   2. Para cada fila con "Stock" tildado → INSERT producto en Inventario.
 *   3. Si hay caja_id → egreso automático en caja_movimientos.
 *   4. IMEI duplicado (interno o vs stock) → 409, rollback total.
 */
import { useState, useMemo, useEffect, useRef } from 'react';
import useModal from '../lib/useModal'; // U2 auditoría 2026-06
import { Icons } from './Icons';
import { proveedores as provApi, inventario as invApi, cajas as cajasApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmModal';
import { headerTh as th, catalogosErrorBanner } from '../lib/spreadsheetStyles';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #M-11
import useSpreadsheetRows from '../lib/useSpreadsheetRows'; // #F-5
import TcWarning from './TcWarning';
import CajaSelectHint from './CajaSelectHint';
// 2026-06-29 Multi-país F3: dropdowns moneda gated por tenant.pais.
import { useMonedasTenant } from '../lib/useMonedasTenant';


function todayISO() { return new Date().toLocaleDateString('sv'); }

const INITIAL_ROWS = 10;        // arranca con 10 vacías
const ADD_BATCH    = 10;        // "+ 10 filas" suma de a 10

// Estado de defaults editable por el usuario arriba de la planilla.
const DEFAULTS_INICIALES = {
  clase: 'celular',
  tipo_carga: 'unitario',
  categoria_id: '',
  deposito_id: '',
  condicion: 'nuevo',
  costo_moneda: 'USD',
  precio_moneda: 'USD',
  crear_stock: true,
};

// Construye una fila vacía aplicando los defaults actuales.
const mkRow = (defaults) => ({
  _id: Math.random().toString(36).slice(2),
  // Estado de creación de stock
  crear_stock: defaults.crear_stock,
  // Inputs del producto
  clase: defaults.clase,
  tipo_carga: defaults.tipo_carga,
  categoria_id: defaults.categoria_id,
  deposito_id: defaults.deposito_id,
  condicion: defaults.condicion,
  nombre: '',
  imei: '',
  gb: '',
  color: '',
  bateria: '',
  cantidad: defaults.tipo_carga === 'unitario' ? '1' : '',
  costo: '',
  costo_moneda: defaults.costo_moneda,
  precio_venta: '',
  precio_moneda: defaults.precio_moneda,
});

// Detecta si una fila está realmente "usada" (tiene nombre o costo o IMEI).
const isUsedRow = (r) => !!(r.nombre?.trim() || r.imei?.trim() || Number(r.costo) > 0);

// Parser de bloque TSV/CSV pegado desde Excel.
// Orden esperado (columnas que varían fila por fila):
//   Nombre · IMEI · GB · Color · Batería · Costo · Precio venta
// Tolerante: filas vacías se descartan, valores faltantes quedan vacíos.
function parsePastedRows(text, defaults) {
  const sep = text.includes('\t') ? '\t' : ',';
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.map(line => {
    const cells = line.split(sep);
    return {
      ...mkRow(defaults),
      nombre:      (cells[0] || '').trim(),
      imei:        (cells[1] || '').trim(),
      gb:          (cells[2] || '').trim(),
      color:       (cells[3] || '').trim(),
      bateria:     (cells[4] || '').trim(),
      costo:       (cells[5] || '').trim(),
      precio_venta:(cells[6] || '').trim(),
    };
  });
}

export default function CompraProveedorModal({ proveedor, onClose, onSaved }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  // 2026-06-29 Multi-país F3: monedas operativas para form costo/precio.
  const { monedaLocal } = useMonedasTenant();

  // ── Cabecera ─────────────────────────────────────────────────────────
  const [fecha, setFecha]   = useState(todayISO());
  const [cajaId, setCajaId] = useState('');
  const [tc, setTc]         = useState('');
  const [notas, setNotas]   = useState('');

  // ── Defaults para nuevas filas ────────────────────────────────────────
  const [defs, setDefs] = useState(DEFAULTS_INICIALES);
  const setDef = (k, v) => setDefs(d => ({ ...d, [k]: v }));

  // ── Planilla ──────────────────────────────────────────────────────────
  // #F-5: state + handlers comunes desde el hook (R-01). addRows va custom
  // (toma defaults runtime `defs` que cambian). applyDefaultsToEmpty también
  // queda custom: tiene la semántica "fueTocada" propia (compara contra
  // template inicial para no pisar filas con edits parciales — #M-10).
  const { rows, setRows, updCell, removeRow } = useSpreadsheetRows({
    mkRow: () => mkRow(DEFAULTS_INICIALES),
    isUsedRow,
    initialCount: INITIAL_ROWS,
    addBatch: ADD_BATCH,
  });

  // ── Catálogos ────────────────────────────────────────────────────────
  const [categorias, setCategorias] = useState([]);
  const [depositos,  setDepositos]  = useState([]);
  const [cajas,      setCajas]      = useState([]);
  // F3.d-3: clases_producto del tenant (para el dropdown Categoría).
  const [clases,     setClases]     = useState([]);
  const [saving,     setSaving]     = useState(false);
  // #B-10: IMEIs que el backend devolvió como conflictivos en el último save.
  // Sus filas se marcan en rojo para que el user pueda identificar y corregir.
  const [imeisConflicto, setImeisConflicto] = useState(new Set());
  // #H-12: si algún catálogo falla, mostramos banner ámbar (en vez de silenciar
  // el error y que el user vea selects vacíos sin entender por qué).
  const [catalogosError, setCatalogosError] = useState(null);

  useEffect(() => {
    Promise.allSettled([
      invApi.categorias(),
      invApi.depositos(),
      cajasApi.listCajas(),
      invApi.clases(),   // F3.d-3
    ]).then(([rc, rd, rk, rcl]) => {
      const errores = [];
      if (rc.status === 'fulfilled') setCategorias(rc.value || []); else errores.push('categorías');
      if (rd.status === 'fulfilled') setDepositos(rd.value || []); else errores.push('depósitos');
      if (rk.status === 'fulfilled') setCajas((rk.value || []).filter(x => x.activo !== false)); else errores.push('cajas');
      if (rcl.status === 'fulfilled') setClases(rcl.value || []); else errores.push('categorías de producto');
      if (errores.length > 0) setCatalogosError(errores);
    });
  }, []);

  // F3.d-3: helper para saber si una clase_id corresponde a un slug unitario
  // (celular sellado/usado o ipads). Se usa en validación de coherencia.
  const SLUGS_UNITARIOS = new Set(['celular_sellado', 'celular_usado', 'ipads']);
  const esUnitario = (clase_id) => {
    const c = clases.find(x => x.id === clase_id);
    return c && SLUGS_UNITARIOS.has(c.slug_legacy);
  };

  // Moneda de la caja seleccionada → si no es USD pedimos TC.
  const monedaCaja = useMemo(() => {
    if (!cajaId) return 'USD';
    return cajas.find(c => String(c.id) === String(cajaId))?.moneda || 'USD';
  }, [cajaId, cajas]);

  // Total compra (USD): sumamos cada fila usando su moneda + un único TC global.
  const totalUsd = useMemo(() => {
    const tcN = Number(tc) || 0;
    return rows.reduce((acc, r) => {
      if (!isUsedRow(r)) return acc;
      const costoUnit = Number(r.costo) || 0;
      const cant      = Number(r.cantidad) || 1;
      const sub       = costoUnit * cant;
      if (r.costo_moneda === 'USD') return acc + sub;
      if (!tcN) return acc; // si la fila no es USD y no hay TC, no sumamos (la validación atrapa)
      return acc + sub / tcN;
    }, 0);
  }, [rows, tc]);

  // ── Handlers ──────────────────────────────────────────────────────────
  // updCell / removeRow vienen del hook. addRows custom porque pasa los
  // defaults runtime `defs` que el user edita en la cabecera.
  function addRows(n = ADD_BATCH) {
    setRows(rs => [...rs, ...Array.from({ length: n }, () => mkRow(defs))]);
  }
  // "Aplicar defaults a las filas vacías": útil cuando ajustás defaults
  // después de haber agregado filas.
  //
  // #M-10: NO pisar filas tocadas-pero-no-cargadas. Antes `mkRow(defs)`
  // reemplazaba la fila completa, perdiendo edits parciales del usuario
  // (ej. tipeó `costo=100` o cambió la `clase` en esa fila puntualmente
  // pero aún no puso nombre/imei → la fila no era "used" por isUsedRow).
  // Ahora compara contra el template inicial: si la fila tiene cualquier
  // valor distinto al default original, se respeta.
  function applyDefaultsToEmpty() {
    const blank = mkRow(DEFAULTS_INICIALES);
    // Campos en mkRow (todos los que podrían estar "tocados").
    const camposComparar = Object.keys(blank).filter(k => k !== '_id');
    setRows(rs => rs.map(r => {
      if (isUsedRow(r)) return r;
      // ¿Algún campo difiere del template? Entonces fue tocada.
      const fueTocada = camposComparar.some(k => r[k] !== blank[k]);
      return fueTocada ? r : mkRow(defs);
    }));
  }

  // Pegar desde Excel: toma el clipboard, parsea TSV, reemplaza filas vacías
  // del final por las parseadas y agrega las que falten.
  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { toast.error('Clipboard vacío'); return; }
      const parsed = parsePastedRows(text, defs);
      if (parsed.length === 0) { toast.error('No se detectaron filas válidas'); return; }
      setRows(rs => {
        // Conservamos las filas YA usadas; las que no están usadas se reemplazan.
        const usedExisting = rs.filter(isUsedRow);
        return [...usedExisting, ...parsed, ...Array.from({ length: 3 }, () => mkRow(defs))];
      });
      toast.success(`${parsed.length} fila${parsed.length > 1 ? 's' : ''} agregada${parsed.length > 1 ? 's' : ''} desde el portapapeles`);
    } catch (e) {
      toast.error('No se pudo leer el portapapeles · permitilo en el navegador');
    }
  }

  // Pegado dentro de la planilla: si el user presiona Ctrl/Cmd+V sobre una
  // celda y el contenido tiene saltos de línea o tabs, intercepto y proceso
  // como bloque (rellena varias filas desde esta posición).
  function handlePasteOnRow(e, startIdx) {
    const text = e.clipboardData?.getData('text') || '';
    if (!text.includes('\n') && !text.includes('\t')) return; // pega normal
    e.preventDefault();
    const parsed = parsePastedRows(text, defs);
    if (parsed.length === 0) return;
    setRows(rs => {
      const out = [...rs];
      // Sobrescribe desde startIdx hacia abajo
      for (let i = 0; i < parsed.length; i++) {
        if (out[startIdx + i]) out[startIdx + i] = parsed[i];
        else out.push(parsed[i]);
      }
      return out;
    });
    toast.success(`${parsed.length} fila${parsed.length > 1 ? 's' : ''} pegada${parsed.length > 1 ? 's' : ''}`);
  }

  function validar() {
    if (!fecha) return 'Falta la fecha';
    if (cajaId && monedaCaja !== 'USD' && (!Number(tc) || Number(tc) <= 0))
      return `Cargá el TC para convertir ${monedaCaja} → USD`;
    const used = rows.filter(isUsedRow);
    if (used.length === 0) return 'Cargá al menos una fila con nombre/IMEI/costo';
    // Validar cada fila usada
    for (let i = 0; i < used.length; i++) {
      const r = used[i];
      if (!Number(r.costo) || Number(r.costo) <= 0) return `Fila ${i + 1}: cargá el costo`;
      if (r.costo_moneda !== 'USD' && (!Number(tc) || Number(tc) <= 0))
        return `Fila ${i + 1}: el costo está en ${r.costo_moneda}, cargá el TC`;
      if (r.crear_stock) {
        if (!r.nombre?.trim()) return `Fila ${i + 1}: el nombre es obligatorio para crear stock`;
        if (!r.categoria_id) return `Fila ${i + 1}: elegí categoría`;
        // F3.d-3: coherencia unitario ↔ cantidad basada en slug_legacy del
        // catálogo del tenant. Antes usaba `r.clase === 'celular'` hardcoded.
        if (esUnitario(r.clase_id) && r.tipo_carga === 'unitario' && Number(r.cantidad) !== 1)
          return `Fila ${i + 1}: un producto unitario debe tener cantidad = 1`;
      }
    }
    // IMEI duplicados internos
    const imeis = used.filter(r => r.crear_stock && r.imei).map(r => r.imei.trim());
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
      const used = rows.filter(isUsedRow);
      const tcN = Number(tc) || null;
      // Monto del movimiento: en la moneda de la caja.
      //   USD → totalUsd; otra → totalUsd * tc
      const montoEnMonedaCaja = monedaCaja === 'USD' ? totalUsd : totalUsd * tcN;

      const payload = {
        proveedor_id: proveedor.id,
        fecha,
        tipo: 'compra',
        monto: Number(montoEnMonedaCaja.toFixed(2)),
        moneda: monedaCaja,
        tc:     monedaCaja === 'USD' ? null : tcN,
        caja_id: cajaId ? Number(cajaId) : null,
        notas: notas.trim() || null,
        items: used.map(r => {
          // Log clásico (siempre)
          const baseLog = {
            producto:    r.nombre.trim() || null,
            tamano:      r.gb.trim() || null,
            color:       r.color.trim() || null,
            imei_serial: r.imei.trim() || null,
            valor:       Number(r.costo) || 0,
            verificado:  false,
          };
          if (!r.crear_stock) return baseLog;
          // Producto que entra al stock
          const num = (v) => v === '' || v == null ? null : Number(v);
          return {
            ...baseLog,
            producto_stock: {
              tipo_carga:    r.tipo_carga,
              clase_id:      r.clase_id || null,   // F3.d-3
              nombre:        r.nombre.trim(),
              imei:          r.imei.trim() || null,
              gb:            r.gb.trim() || null,
              color:         r.color.trim() || null,
              bateria:       num(r.bateria),
              categoria_id:  Number(r.categoria_id),
              deposito_id:   r.deposito_id ? Number(r.deposito_id) : null,
              costo:         Number(r.costo),
              costo_moneda:  r.costo_moneda,
              precio_venta:  Number(r.precio_venta) || 0,
              precio_moneda: r.precio_moneda,
              cantidad:      Number(r.cantidad) || 1,
              condicion:     r.condicion,
            },
          };
        }),
      };
      const res = await provApi.createMovimiento(payload);
      const creados = res.productos_creados?.length || 0;
      toast.success(`Compra registrada · ${used.length} ítem${used.length > 1 ? 's' : ''}${creados ? ` · ${creados} al stock` : ''}`);
      onSaved?.(res);
      onClose();
    } catch (e) {
      // #B-10: parsear imeis_existentes del error para marcar filas culpables.
      // El backend devuelve { error, imeis_existentes: [...] } en 409.
      const data = e.responseBody || e.data || {};
      if (Array.isArray(data.imeis_existentes) && data.imeis_existentes.length > 0) {
        setImeisConflicto(new Set(data.imeis_existentes.map(String)));
        const lista = data.imeis_existentes.slice(0, 3).join(', ');
        const more = data.imeis_existentes.length > 3 ? `…+${data.imeis_existentes.length - 3}` : '';
        toast.error(`IMEI ya existe en stock: ${lista}${more}. Filas marcadas en rojo.`, { duration: 8000 });
      } else {
        toast.error(e.message || 'No se pudo guardar la compra');
      }
    } finally {
      setSaving(false);
    }
  }

  // #B-09: confirm-on-close si hay data cargada para no perder 80 filas
  // por un click accidental en el overlay.
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

  // U2 auditoría 2026-06: useModal aplicado.
  const overlayRef = useRef(null);
  useModal({ open: true, onClose: tryClose, overlayRef });

  // Estilos compartidos: cellInp + headerTh vienen de lib/spreadsheetStyles
  return (
    <div ref={overlayRef} className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="compra-prov-modal-title"
         onClick={(e) => { if (e.target === e.currentTarget) tryClose(); }}>
      <div className="modal" style={{ maxWidth: 1800, width: '98vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <h3 id="compra-prov-modal-title">Cargar compra · {proveedor.nombre}</h3>
          <button className="icon-btn" onClick={tryClose} aria-label="Cerrar modal"><Icons.X size={16} /></button>
        </div>

        <div className="modal-body" style={{ maxHeight: '85vh', overflowY: 'auto' }}>
          {/* #H-12: banner si catálogos fallaron al cargar */}
          {catalogosError && (
            <div style={catalogosErrorBanner}>
              ⚠ No se pudieron cargar: <strong>{catalogosError.join(', ')}</strong>.
              Algunos selectores aparecerán vacíos. Revisá tu conexión y cerrá/abrí el modal.
            </div>
          )}
          {/* ── Cabecera: fecha + caja + tc ── */}
          <div className="row u-mb-12">
            <div className="field u-flex-0-0-150">
              <label className="field-label">Fecha</label>
              <input type="date" className="input" value={fecha} onChange={e => setFecha(e.target.value)} />
            </div>
            <div className="field u-flex-1">
              <label className="field-label">Pagar con</label>
              <select className="input" value={cajaId} onChange={e => setCajaId(e.target.value)}>
                <option value="">— Cuenta corriente (queda como deuda) —</option>
                {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>)}
                <CajaSelectHint />
              </select>
            </div>
            {cajaId && monedaCaja !== 'USD' && (
              <div className="field u-flex-0-0-140">
                <label className="field-label">TC {monedaCaja}→USD <span className="u-color-neg">*</span></label>
                <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" min="0" step="0.01"
                  value={tc} onChange={e => setTc(e.target.value)} placeholder="0" />
                <TcWarning tc={tc} />
              </div>
            )}
            {/* TC también se pide si HAY filas en moneda no-USD aunque la caja sea CC */}
            {(!cajaId || monedaCaja === 'USD') && rows.some(r => isUsedRow(r) && r.costo_moneda !== 'USD') && (
              <div className="field u-flex-0-0-140">
                <label className="field-label">TC ARS→USD <span className="u-color-neg">*</span></label>
                <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" min="0" step="0.01"
                  value={tc} onChange={e => setTc(e.target.value)} placeholder="0" />
                <TcWarning tc={tc} />
              </div>
            )}
          </div>

          {/* ── Defaults para nuevas filas ── */}
          <div className="card card-tight" style={{ padding: 10, marginBottom: 12, background: 'var(--surface-2)' }}>
            <div className="flex-between u-mb-8">
              <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                Defaults para nuevas filas
              </div>
              <button className="btn btn-sm btn-ghost" onClick={applyDefaultsToEmpty}
                title="Aplica estos defaults a las filas que aún están vacías">
                Aplicar a vacías
              </button>
            </div>
            <div className="row u-gap-8">
              <Field label="Categoría"><select className="input" value={defs.clase_id} onChange={e => setDef('clase_id', e.target.value)}>
                <option value="">— Sin default —</option>
                {clases.filter(c => c.activa && !c.es_sin_categoria).map(c => (
                  <option key={c.id} value={c.id}>{c.emoji ? `${c.emoji} ${c.nombre}` : c.nombre}</option>
                ))}
              </select></Field>
              <Field label="Categoría"><select className="input" value={defs.categoria_id} onChange={e => setDef('categoria_id', e.target.value)}>
                <option value="">— Sin default —</option>
                {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select></Field>
              <Field label="Depósito"><select className="input" value={defs.deposito_id} onChange={e => setDef('deposito_id', e.target.value)}>
                <option value="">— Sin default —</option>
                {depositos.map(d => <option key={d.id} value={d.id}>{d.nombre}</option>)}
              </select></Field>
              <Field label="Condición"><select className="input" value={defs.condicion} onChange={e => setDef('condicion', e.target.value)}>
                <option value="nuevo">Nuevo</option><option value="usado">Usado</option></select></Field>
              <Field label="Tipo carga"><select className="input" value={defs.tipo_carga} onChange={e => setDef('tipo_carga', e.target.value)}>
                <option value="unitario">Unitario</option><option value="lote">Lote</option></select></Field>
              {/* 2026-06-29 Multi-país F3: USD + moneda local del tenant. */}
              <Field label="Moneda costo"><select className="input" value={defs.costo_moneda} onChange={e => setDef('costo_moneda', e.target.value)}>
                {Array.from(new Set(['USD', monedaLocal, defs.costo_moneda].filter(Boolean)))
                  .map(m => <option key={m} value={m}>{m}</option>)}</select></Field>
              <Field label="Moneda venta"><select className="input" value={defs.precio_moneda} onChange={e => setDef('precio_moneda', e.target.value)}>
                {Array.from(new Set(['USD', monedaLocal, defs.precio_moneda].filter(Boolean)))
                  .map(m => <option key={m} value={m}>{m}</option>)}</select></Field>
            </div>
          </div>

          {/* ── Acciones de la planilla ── */}
          <div className="flex-between u-mb-8">
            <div className="u-fs-13-fw-600">
              Items · {rows.filter(isUsedRow).length} usadas / {rows.length} filas
            </div>
            <div className="flex-row u-gap-6">
              <button className="btn btn-sm" onClick={pasteFromClipboard}
                title="Pegá un bloque desde Excel · orden: Nombre · IMEI · GB · Color · Batería · Costo · Precio">
                <Icons.Plus size={13} /> Pegar desde Excel
              </button>
              <button className="btn btn-sm" onClick={() => addRows(ADD_BATCH)}>
                + {ADD_BATCH} filas
              </button>
            </div>
          </div>

          {/* ── Planilla spreadsheet ── */}
          {/* 2026-06-24 mobile lote C: planilla con minWidth 1500 (~16 columnas).
              Hint visible solo en mobile para indicar scroll horizontal. */}
          <div className="bulk-spreadsheet-hint">↔ Desliza horizontalmente para ver todas las columnas</div>
          <div className="u-overflow-x-border-r-6">
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1500, tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 28 }} />   {/* # */}
                <col style={{ width: 38 }} />   {/* Stock */}
                <col style={{ width: 180 }} />  {/* Nombre */}
                <col className="u-w-130px" />  {/* IMEI */}
                <col className="u-w-60px" />   {/* GB */}
                <col className="u-w-90px" />   {/* Color */}
                <col className="u-w-60px" />   {/* Bat % */}
                <col style={{ width: 88 }} />   {/* Tipo */}
                <col className="u-w-120px" />  {/* Categoría */}
                <col className="u-w-120px" />  {/* Depósito */}
                <col style={{ width: 88 }} />   {/* Condición */}
                <col className="u-w-96" />   {/* Tipo carga */}
                <col className="u-w-60px" />   {/* Cant */}
                <col className="u-w-80px" />   {/* Costo */}
                <col className="u-w-64" />   {/* Moneda */}
                <col className="u-w-80px" />   {/* Precio */}
                <col className="u-w-64" />   {/* Moneda */}
                <col className="u-w-32px" />   {/* X */}
              </colgroup>
              <thead>
                <tr>
                  {['#','✓','Nombre *','IMEI/Serial','GB','Color','Bat %','Tipo','Categoría *','Depósito','Cond.','Tipo carga','Cant.','Costo *','M.','Precio venta','M.',''].map((h, i) =>
                    <th key={i} style={{ ...th, textAlign: (i === 0 || i === 1) ? 'center' : 'left' }}>{h}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const used = isUsedRow(r);
                  // #B-10: marca visual si el IMEI de esta fila está en conflicto.
                  const imeiBad = r.imei && imeisConflicto.has(r.imei.trim());
                  return (
                    <tr key={r._id} style={{
                      background: imeiBad
                        ? 'rgba(239,68,68,0.10)'
                        : used ? 'rgba(99,102,241,0.04)' : 'transparent',
                      borderTop: '1px solid var(--hairline)',
                      boxShadow: imeiBad ? 'inset 3px 0 0 0 var(--neg)' : undefined,
                    }}>
                      <td style={{ padding: '3px 6px', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>{idx + 1}</td>
                      <td style={{ padding: '3px 6px', textAlign: 'center' }}>
                        <input type="checkbox" checked={r.crear_stock}
                          onChange={e => updCell(idx, 'crear_stock', e.target.checked)} />
                      </td>
                      <td className="u-p-3-4">
                        <input className="cell-inp" value={r.nombre}
                          placeholder="iPhone 15 Pro"
                          onPaste={e => handlePasteOnRow(e, idx)}
                          onChange={e => updCell(idx, 'nombre', e.target.value)} />
                      </td>
                      <td className="u-p-3-4">
                        <input className="cell-inp u-mono" value={r.imei}
                          placeholder="356938…"
                          onChange={e => updCell(idx, 'imei', e.target.value)} />
                      </td>
                      <td className="u-p-3-4">
                        <input className="cell-inp u-text-right" value={r.gb}
                          placeholder="256" onChange={e => updCell(idx, 'gb', e.target.value)} />
                      </td>
                      <td className="u-p-3-4">
                        <input className="cell-inp" value={r.color}
                          placeholder="Negro" onChange={e => updCell(idx, 'color', e.target.value)} />
                      </td>
                      <td className="u-p-3-4">
                        <input type="number" onKeyDown={blockInvalidNumberKeys} className="cell-inp u-text-right" value={r.bateria}
                          placeholder="100" onChange={e => updCell(idx, 'bateria', e.target.value)} />
                      </td>
                      <td className="u-p-3-4">
                        <select className="cell-inp u-cursor-pointer" value={r.clase_id || ''}
                          onChange={e => updCell(idx, 'clase_id', e.target.value)}>
                          <option value="">—</option>
                          {clases.filter(c => c.activa && !c.es_sin_categoria).map(c => (
                            <option key={c.id} value={c.id}>{c.emoji ? `${c.emoji} ${c.nombre}` : c.nombre}</option>
                          ))}
                        </select>
                      </td>
                      <td className="u-p-3-4">
                        <select className="cell-inp u-cursor-pointer" value={r.categoria_id}
                          onChange={e => updCell(idx, 'categoria_id', e.target.value)}>
                          <option value="">—</option>
                          {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                        </select>
                      </td>
                      <td className="u-p-3-4">
                        <select className="cell-inp u-cursor-pointer" value={r.deposito_id}
                          onChange={e => updCell(idx, 'deposito_id', e.target.value)}>
                          <option value="">—</option>
                          {depositos.map(d => <option key={d.id} value={d.id}>{d.nombre}</option>)}
                        </select>
                      </td>
                      <td className="u-p-3-4">
                        <select className="cell-inp u-cursor-pointer" value={r.condicion}
                          onChange={e => updCell(idx, 'condicion', e.target.value)}>
                          <option value="nuevo">Nuevo</option>
                          <option value="usado">Usado</option>
                        </select>
                      </td>
                      <td className="u-p-3-4">
                        <select className="cell-inp u-cursor-pointer" value={r.tipo_carga}
                          onChange={e => updCell(idx, 'tipo_carga', e.target.value)}>
                          <option value="unitario">Unitario</option>
                          <option value="lote">Lote</option>
                        </select>
                      </td>
                      <td className="u-p-3-4">
                        <input type="number" onKeyDown={blockInvalidNumberKeys} className="cell-inp u-text-right" value={r.cantidad}
                          placeholder="1" onChange={e => updCell(idx, 'cantidad', e.target.value)} />
                      </td>
                      <td className="u-p-3-4">
                        <input type="number" onKeyDown={blockInvalidNumberKeys} className="cell-inp u-td-right-fw-700"
                          value={r.costo} placeholder="0"
                          onChange={e => updCell(idx, 'costo', e.target.value)} />
                      </td>
                      <td className="u-p-3-4">
                        {/* 2026-06-29 Multi-país F3: USD + moneda local. */}
                        <select className="cell-inp u-cursor-pointer" value={r.costo_moneda}
                          onChange={e => updCell(idx, 'costo_moneda', e.target.value)}>
                          {Array.from(new Set(['USD', monedaLocal, r.costo_moneda].filter(Boolean)))
                            .map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </td>
                      <td className="u-p-3-4">
                        <input type="number" onKeyDown={blockInvalidNumberKeys} className="cell-inp u-text-right"
                          value={r.precio_venta} placeholder="0"
                          onChange={e => updCell(idx, 'precio_venta', e.target.value)} />
                      </td>
                      <td className="u-p-3-4">
                        <select className="cell-inp u-cursor-pointer" value={r.precio_moneda}
                          onChange={e => updCell(idx, 'precio_moneda', e.target.value)}>
                          {Array.from(new Set(['USD', monedaLocal, r.precio_moneda].filter(Boolean)))
                            .map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
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

          {/* ── Notas + Total ── */}
          <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
            <div className="field u-flex-1">
              <label className="field-label">Notas de la compra (opcional)</label>
              <input className="input" value={notas} onChange={e => setNotas(e.target.value)}
                placeholder="Ej. Pago con transferencia, recibo #5421" />
            </div>
            <div style={{ flex: '0 0 220px', textAlign: 'right' }}>
              <div className="muted tiny">Total compra</div>
              <div className="mono u-fs-22-fw-800">
                {/* #M-13: si no hay filas usadas, mostrar guion en vez de
                    "USD 0" para no parecer que se está cargando algo. */}
                {rows.filter(isUsedRow).length === 0
                  ? <span className="muted">—</span>
                  : <>USD {totalUsd.toLocaleString('es-AR', { maximumFractionDigits: 2 })}</>}
              </div>
            </div>
          </div>
        </div>

        <div className="modal-ft">
          <button className="btn btn-ghost" onClick={tryClose}>Cancelar</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleGuardar}>
            {saving ? 'Guardando…' : `Guardar compra (${rows.filter(isUsedRow).length})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// Helper: campo compacto para la zona de defaults.
function Field({ label, children }) {
  return (
    <div className="field" style={{ flex: 1, minWidth: 110 }}>
      <label className="field-label" style={{ fontSize: 10 }}>{label}</label>
      {children}
    </div>
  );
}
