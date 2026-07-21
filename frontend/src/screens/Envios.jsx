import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { silentReport } from '../lib/reportError';
import { Icons } from '../components/Icons';
import { envios, ventas, cajas as cajasApi, inventario, cuentas as cuentasApi, config as configApi, ocr as ocrApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha, fmtImei } from '../lib/format';
import { toUsd } from '../lib/money';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import TcWarning from '../components/TcWarning';
import BarrioCombobox from '../components/BarrioCombobox';
import useModal from '../lib/useModal';
import useFormFields from '../lib/useFormFields';
import Badge from '../components/Badge';
import Seg from '../components/Seg';
import { Skeleton } from '../components/Skeleton';
// 2026-06-29 Multi-país F3: dropdowns moneda gated por tenant.pais.
import { useMonedasTenant } from '../lib/useMonedasTenant';


// ─── Create modal helpers ─────────────────────────────────────────────────────
const EMPTY_FORM = {
  fecha: new Date().toLocaleDateString('sv'),
  cliente: '', telefono: '', direccion: '', barrio: '',
  horario: '', operador: '', notas: '',
  prioridad: '', estado: 'Pendiente',
  // 2026-06-10 — Todo envío genera una venta asociada (estado='pendiente'
  // al crearse, 'acreditado' al confirmar entrega). El operador no decide
  // esto: cuadra con la regla "envío = venta minorista al consumidor".
  // Antes era un checkbox opcional y era footgun (Lucas creó un envío
  // sin tickearlo y la venta nunca apareció en el dashboard).
  tc: '', // TC del envío (opcional, solo necesario si hay items en ARS)
  // 2026-07-13 (feature vuelto Fase 2): cambio dado al cliente al recibir
  // el envío. Se propaga a la venta que crea el envío (usa columnas
  // `ventas.vuelto_*`). Solo aplica cuando el envío crea venta (siempre
  // hoy — `registrar_venta` está hardcodeado a true en el submit).
  vuelto_monto:   '',
  vuelto_moneda:  'ARS',
  vuelto_caja_id: '',
};
// Default USD: los productos del inventario son típicamente USD y los precios
// del envío "tipo Ventas" se manejan en USD. El usuario puede cambiar a ARS/USDT.
// Los campos con prefijo `_` son solo para mostrar en la UI — no se envían al
// backend. Los seteamos al pickear un producto del inventario para que el
// operador vea modelo/capacidad/color/IMEI/costo sin tener que abrir Inventario.
// Tema C rev5 (paridad con Ventas): los items tipo 'pago' tienen además
// `usd_input` (valor primario que tipea el operador) y `neto_input` (si
// edita "Entra a tu caja" directamente). `monto` sigue siendo el bruto en
// la moneda nativa — única fuente de verdad para el backend.
const EMPTY_ITEM = { tipo: 'producto', descripcion: '', monto: '', metodo_pago: '', metodo_pago_id: '', producto_id: '', moneda: 'USD', tc: '', es_cuenta_corriente: false, usd_input: '', neto_input: '', _imei: '', _nombre: '', _gb: '', _color: '', _costo: '', _costo_moneda: '' };

// Auditoría 2026-06-30 F-13/14: ID único estable para usar como React key en
// las filas del array `items`. Usar el índice como key rompe el reconciler al
// quitar un ítem del medio (el draft del input "salta" al siguiente). Con un
// id estable, la fila eliminada se desmonta limpia. crypto.randomUUID está
// disponible en todos los browsers target + jsdom; fallback defensivo para
// entornos legacy o non-secure-context.
function newItemId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `it-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
const sym = (m) => m === 'ARS' ? '$' : 'u$s';

// ─── Estado / Prioridad maps ──────────────────────────────────────────────────
// Backend values are capitalized with spaces: 'Pendiente', 'En camino', 'Entregado', 'Cancelado'
const ESTADO_DISPLAY = {
  'Pendiente': { label: 'Pendiente', tone: 'info' },
  'En camino': { label: 'En camino', tone: 'info' },
  'Entregado': { label: 'Entregado', tone: 'pos' },
  'Cancelado': { label: 'Cancelado', tone: 'neg' },
};

const PRIO_DISPLAY = {
  'Alta':  { label: 'Alta',  tone: 'neg' },
  'Media': { label: 'Media', tone: 'warn' },
  'Baja':  { label: 'Baja',  tone: 'default' },
};

// Badge y Seg ahora viven en frontend/src/components/ (U-13 dedup, auditoría
// 2026-06-10) — importados arriba.

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function Envios() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  // 2026-06-29 Multi-país F3: monedas operativas según país del tenant.
  const { monedas } = useMonedasTenant();
  const [enviosList, setEnviosList] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [estadoFilter, setEstadoFilter] = useState('todos');
  // 2026-07-14 (bug reportado por TekHaus vía Lucas): init `search` desde
  // ?q= del URL para que el CommandPalette pueda deep-linkear a un envío
  // específico (/envios?q=Juan Perez → filtro pre-aplicado). Antes el input
  // quedaba vacío y "no pasaba nada" visualmente.
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('q') || '');
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  // dateFilter: null = todos | 'YYYY-MM-DD' = día específico
  const [dateFilter, setDateFilter] = useState(null);
  // TODAS las cajas activas (incluye financieras y tarjetas). Las cajas
  // financiera/tarjeta y la opción CC requieren "Registrar como venta" — el
  // frontend lo marca con un disabled/warning cuando aplica.
  const [cajasPago, setCajasPago] = useState([]);
  // Tema C rev5 (paridad con Ventas): pct global de Financiera para preview.
  const [pctFinanciera, setPctFinanciera] = useState(0);
  const [clientesCc, setClientesCc] = useState([]); // para asignar CC al envío
  // Búsqueda de productos para linkear: igual que en Ventas — debounce + backend search.
  // Un solo "search activo a la vez" (itemIdx identifica qué item del form está buscando).
  const [prodSearch, setProdSearch] = useState({ itemIdx: null, q: '', results: [], loading: false });
  const prodTimer = useRef(null);
  const prodReq   = useRef(0);

  useEffect(() => {
    // 2026-06-10: usar el endpoint lite (sin permiso 'cajas') así un operador
    // que solo tiene 'envios' puede cobrar. Antes usábamos listCajas() que
    // requería permiso 'cajas' y devolvía 403 → lista vacía → solo aparecía
    // "Cuenta corriente" en el select.
    cajasApi.listMetodosPago()
      .then(list => setCajasPago(Array.isArray(list) ? list : []))
      .catch(silentReport);
    cuentasApi.clientes({ limit: 200 })
      .then(list => setClientesCc(Array.isArray(list?.data) ? list.data : (Array.isArray(list) ? list : [])))
      .catch(() => {});
    // pct_financiera para el desglose en-vivo (paridad con Ventas).
    configApi.get()
      .then(cfg => setPctFinanciera(Number(cfg?.pct_financiera) || 0))
      .catch(() => {});
  }, []);

  // ── Create/Edit modal ──
  // 2026-06-10 — Antes solo había modal de "Nuevo envío". Ahora el mismo
  // modal sirve para editar: el `modalMode` discrimina ('create' | 'edit') y
  // el handler de submit elige POST vs PUT. `editingId` guarda qué envío se
  // está editando (null cuando es create).
  const [modalMode, setModalMode] = useState(null); // null | 'create' | 'edit'
  const showCreate = modalMode !== null; // mantiene el nombre original donde se usa
  const [editingId, setEditingId] = useState(null);
  const setShowCreate = (open) => { if (!open) { setModalMode(null); setEditingId(null); } };
  // 2026-07-16 (task #147 UX B.2): validación inline con useFormFields.
  // Antes: 2 chequeos secuenciales `if (!X.trim()) { setCreateError(); return; }`
  // → user completaba cliente + dirección + N items, submitteaba, veía
  // "Cliente obligatorio", corregía, veía "Dirección obligatoria", etc.
  // Ahora los errores aparecen JUNTOS bajo cada input.
  const {
    form,
    setForm,
    setField,
    fieldErrors,
    setFieldErrors,
    validate: validateEnvio,
    resetErrors: resetEnvioErrors,
  } = useFormFields(EMPTY_FORM, (f) => {
    const errs = {};
    if (!f.cliente.trim()) errs.cliente = 'Requerido.';
    if (!f.direccion.trim()) errs.direccion = 'Requerido.';
    return Object.keys(errs).length ? errs : null;
  });
  const [items, setItems] = useState([{ ...EMPTY_ITEM, _id: newItemId() }]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  // Paridad con Ventas: si un pago usa la caja Financiera, se exige adjuntar
  // comprobante en el alta para que el backend auto-genere la entrada del
  // dashboard de Transferencias (syncFinancieraComprobante).
  const [comprobantes, setComprobantes] = useState([]);
  // OCR del primer comprobante adjunto: mismo patrón que Ventas. Endpoint
  // /api/ocr usa Claude Haiku 4.5 para extraer el monto del comprobante.
  const [ocrSugerencia, setOcrSugerencia] = useState({ status: 'idle', monto: null });
  // useModal — auditoría 2026-06-06 UX B2: Esc cierra el modal de "Nuevo
  // envío", focus trap, body scroll lock.
  const createModalRef = useRef(null);
  useModal({
    open: showCreate,
    onClose: () => !creating && setShowCreate(false),
    overlayRef: createModalRef,
  });

  // 2026-07-16 (task #147 UX B.2): setF ahora delega al setField del hook
  // useFormFields — mismo signature, además limpia fieldErrors[field] al
  // setear (feedback UX inmediato al empezar a corregir un input inválido).
  const setF = setField;
  // Auditoría 2026-06-30 F-13/14: cada item tiene _id estable. rmItem opera
  // por id (el JSX pasa it._id). setItem mantiene firma por índice porque los
  // call-sites del JSX están dentro del .map y conocen idx, y porque hay
  // handlers internos (setPagoUsd, etc.) que usan items[idx] para fórmulas.
  const addItem = () => setItems(i => [...i, { ...EMPTY_ITEM, _id: newItemId() }]);
  const addProducto = () => setItems(i => [...i, { ...EMPTY_ITEM, _id: newItemId(), tipo: 'producto' }]);
  // 2026-06-10 — Default del pago pasa a USD (era ARS). Footgun: si el operador
  // no cambiaba el dropdown, el pago quedaba como ARS aunque la venta fuera USD.
  // USD es la moneda predominante del negocio (iPhones, accesorios premium).
  const addPago = () => setItems(i => [...i, { ...EMPTY_ITEM, _id: newItemId(), tipo: 'pago', moneda: 'USD' }]);
  const rmItem = (id) => setItems(i => i.filter(it => it._id !== id));
  const setItem = (idx, field, val) =>
    setItems(i => i.map((it, j) => j === idx ? { ...it, [field]: val } : it));

  // Resumen del envío en USD + desglose por pago (paridad con Ventas Tema C rev5).
  // - totalUsd: suma de productos en USD.
  // - pagosUsd: suma de los BRUTOS de pagos en USD (lo que cobra el cliente).
  // - netoUsd: suma de los NETOS percibidos (después de comisión financiera).
  // - pagosDetalle[i]: { pct, brutoOrig, brutoUsd, costoFinOrig, costoFinUsd,
  //                     netoOrig, netoUsd } — usado por el render del desglose.
  // - cubierto: BRUTO >= total de productos (tolerancia 0.01).
  //   2026-07-04 (#506) — El chequeo va contra el BRUTO (lo que paga el cliente),
  //   NO contra el neto. La comisión se la lleva un tercero, no debe participar
  //   del chequeo pagos-vs-venta. Impacta sí en Ganancia real (más abajo).
  const summary = useMemo(() => {
    const tcEnv = Number(form.tc) || null;
    let totalUsd = 0, pagosUsd = 0, netoUsd = 0;
    const pagosDetalle = items.map(it => {
      if (it.tipo !== 'pago') return null;
      const brutoOrig = Number(it.monto) || 0;
      const brutoUsd = toUsd(it.monto, it.moneda || 'ARS', it.tc || tcEnv);
      let pct = 0;
      if (!it.es_cuenta_corriente && it.metodo_pago_id) {
        const m = cajasPago.find(c => Number(c.id) === Number(it.metodo_pago_id));
        if (m) pct = pctMetodo(m);
      }
      const costoFinOrig = brutoOrig * pct / 100;
      const costoFinUsd  = brutoUsd  * pct / 100;
      const netoOrigVal  = brutoOrig - costoFinOrig;
      const netoUsdVal   = brutoUsd  - costoFinUsd;
      return { pct, brutoOrig, brutoUsd, costoFinOrig, costoFinUsd, netoOrig: netoOrigVal, netoUsd: netoUsdVal };
    });
    items.forEach((it, i) => {
      if (it.tipo === 'producto') {
        totalUsd += toUsd(it.monto, it.moneda || 'USD', it.tc || tcEnv);
      } else if (it.tipo === 'pago') {
        const d = pagosDetalle[i];
        if (d) { pagosUsd += d.brutoUsd; netoUsd += d.netoUsd; }
      }
    });
    // Diferencia se evalúa contra BRUTO (no neto): la comisión se la lleva un
    // tercero (financiera/procesadora), no debe participar del chequeo de
    // "los pagos suman el total de la venta". El neto sigue siendo útil para
    // mostrar cuánto entra a caja y para el cálculo de Ganancia real.
    return { totalUsd, pagosUsd, netoUsd, diferenciaUsd: totalUsd - pagosUsd, pagosDetalle };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, form.tc, cajasPago, pctFinanciera]);
  const cubierto = Math.abs(summary.diferenciaUsd) < 0.01;

  // Heurística: si lo tipeado parece un IMEI completo (12+ dígitos seguidos),
  // y la búsqueda devuelve EXACTAMENTE un match cuyo p.imei coincide, lo
  // seleccionamos solo. Lucas usa lector / escribe el IMEI directo de la caja
  // y no quiere tener que clickear el resultado.
  const looksLikeImei = (s) => /^\d{12,17}$/.test((s || '').trim());

  // Búsqueda asincrónica de productos: debounce 300ms, backend filtra por nombre/IMEI/color/gb.
  function searchProductos(itemIdx, q) {
    setProdSearch(s => ({ ...s, itemIdx, q, loading: q.trim().length >= 2 }));
    clearTimeout(prodTimer.current);
    if (q.trim().length < 2) { setProdSearch(s => ({ ...s, results: [], loading: false })); return; }
    const reqId = ++prodReq.current;
    prodTimer.current = setTimeout(async () => {
      try {
        const res = await inventario.productos({ solo_stock: 'true', limit: 8, buscar: q.trim() });
        if (reqId !== prodReq.current) return;
        const results = res?.data || [];
        // Auto-pick por IMEI: si el query es un IMEI y hay UN único match
        // con ese IMEI exacto, lo seleccionamos sin esperar el click.
        const qTrim = q.trim();
        if (looksLikeImei(qTrim) && results.length === 1 && String(results[0].imei || '').trim() === qTrim) {
          pickProducto(itemIdx, results[0]);
          return;
        }
        setProdSearch(s => ({ ...s, results, loading: false }));
      } catch (_) { if (reqId === prodReq.current) setProdSearch(s => ({ ...s, results: [], loading: false })); }
    }, 300);
  }
  // Helper: agrega "GB" al final si no lo tiene ya. Evita "128GBGB" cuando el
  // inventario tiene "128GB" guardado en p.gb (algunos productos sí, otros no).
  // Usado en la descripción que se guarda en el envío y en los resultados del picker.
  function gbLabel(gb) {
    if (!gb) return null;
    const s = String(gb);
    return /GB\s*$/i.test(s) ? s : `${s}GB`;
  }
  function pickProducto(idx, p) {
    setItems(i => i.map((it, j) => j !== idx ? it : ({
      ...it,
      producto_id: p.id,
      descripcion: [p.nombre, gbLabel(p.gb), p.color].filter(Boolean).join(' · '),
      monto: String(p.precio_venta || ''),
      moneda: p.precio_moneda || 'USD',  // heredada del producto del inventario (típicamente USD)
      // _campos: solo para mostrar (modelo/capacidad/color/IMEI/costo), no se envían.
      _nombre: p.nombre || '',
      _gb: p.gb || '',
      _color: p.color || '',
      // 2026-07-04: fmtImei normaliza notación científica heredada de imports XLSX
      _imei: fmtImei(p.imei),
      _costo: p.costo != null ? String(p.costo) : '',
      _costo_moneda: p.costo_moneda || 'USD',
    })));
    setProdSearch({ itemIdx: null, q: '', results: [], loading: false });
  }
  function unpickProducto(idx) {
    setItems(i => i.map((it, j) => j !== idx ? it : ({
      ...it, producto_id: '', descripcion: '', monto: '',
      _imei: '', _nombre: '', _gb: '', _color: '', _costo: '', _costo_moneda: '',
    })));
  }
  // ── Tema C rev5 (paridad con Ventas) ──────────────────────────────────────
  // Helpers de fórmula: el operador tipea USD y el sistema arma el bruto en
  // moneda nativa según el % del método. Si edita "Entra a tu caja" (neto),
  // derivamos el bruto al revés. Fórmulas idénticas a Ventas.jsx:298-310.
  function pctMetodo(m) {
    if (!m) return 0;
    if (m.es_tarjeta && Number(m.comision_pct) > 0) return Number(m.comision_pct);
    if (m.es_financiera && pctFinanciera > 0)        return pctFinanciera;
    return 0;
  }
  function brutoFromUsdInput(usd, moneda, tc, pct) {
    const u = Number(usd) || 0;
    if (u <= 0) return '';
    const factor = pct > 0 ? 1 / (1 - pct / 100) : 1;
    if (moneda === 'USD' || moneda === 'USDT') return Math.round(u * factor * 100) / 100;
    const t = Number(tc);
    if (moneda === 'ARS' && t > 0)              return Math.round(u * t * factor * 100) / 100;
    return '';
  }
  function brutoFromNetoInput(neto, pct) {
    const n = Number(neto) || 0;
    if (n <= 0) return '';
    return Math.round(n / (1 - pct / 100) * 100) / 100;
  }
  // 2026-07-04: inversa de brutoFromUsdInput. Dado el bruto ARS/UYU/USD que el
  // operador tipeó en "Le cobrás al cliente", devolver el USD equivalente para
  // mantener consistencia visual en el input USD. Ver Ventas.jsx (mismo helper).
  function usdFromBrutoInput(bruto, moneda, tc, pct) {
    const b = Number(bruto) || 0;
    if (b <= 0) return '';
    const factor = pct > 0 ? 1 / (1 - pct / 100) : 1;
    const netoEquivalente = b / factor;
    if (moneda === 'USD' || moneda === 'USDT') return Math.round(netoEquivalente * 100) / 100;
    const t = Number(tc);
    if (moneda === 'ARS' && t > 0) return Math.round(netoEquivalente / t * 100) / 100;
    return '';
  }
  // Faltante USD = total productos − otros pagos. Usado para auto-llenar el
  // USD al elegir un método nuevo (si el operador no había tipeado nada).
  function faltanteUsd(indexExcluir, prevItems) {
    const tcEnv = Number(form.tc) || null;
    let totalUsd = 0;
    prevItems.forEach(it => {
      if (it.tipo !== 'producto') return;
      totalUsd += toUsd(it.monto, it.moneda || 'USD', it.tc || tcEnv);
    });
    if (totalUsd <= 0) return 0;
    let otrosUsd = 0;
    prevItems.forEach((it, k) => {
      if (k === indexExcluir) return;
      if (it.tipo !== 'pago') return;
      otrosUsd += toUsd(it.monto, it.moneda || 'ARS', it.tc || tcEnv);
    });
    return Math.max(0, totalUsd - otrosUsd);
  }

  // Setter del USD tipeado por el operador. Recalcula bruto en moneda nativa.
  // 2026-07-04: limpia bruto_manual — al editar USD el override se pierde.
  function setPagoUsd(idx, value) {
    setItems(arr => arr.map((it, j) => {
      if (j !== idx) return it;
      const m = cajasPago.find(x => Number(x.id) === Number(it.metodo_pago_id));
      const pct = pctMetodo(m);
      const tcUse = it.tc || form.tc;
      const bruto = brutoFromUsdInput(value, it.moneda, tcUse, pct);
      return { ...it, usd_input: value, neto_input: '', bruto_manual: false, monto: bruto !== '' ? String(bruto) : '' };
    }));
  }
  // 2026-07-04: setter para el input "Le cobrás al cliente" editable. Ver
  // setPagoBruto en Ventas.jsx (mismo modelo).
  function setPagoBruto(idx, value) {
    setItems(arr => arr.map((it, j) => {
      if (j !== idx) return it;
      const m = cajasPago.find(x => Number(x.id) === Number(it.metodo_pago_id));
      const pct = pctMetodo(m);
      const tc = it.tc || form.tc;
      const usdDerivado = usdFromBrutoInput(value, it.moneda, tc, pct);
      return {
        ...it,
        monto: value,
        usd_input: usdDerivado !== '' ? String(usdDerivado) : '',
        neto_input: '',
        bruto_manual: true,
      };
    }));
  }
  // Setter del Neto editable ("entra a tu caja"). Caso "cliente ya transfirió X".
  function setPagoNeto(idx, value) {
    setItems(arr => arr.map((it, j) => {
      if (j !== idx) return it;
      const m = cajasPago.find(x => Number(x.id) === Number(it.metodo_pago_id));
      const pct = pctMetodo(m);
      const bruto = brutoFromNetoInput(value, pct);
      const tc = Number(it.tc) || Number(form.tc) || null;
      let usd = '';
      const n = Number(value) || 0;
      if (n > 0) {
        if (it.moneda === 'ARS' && tc > 0) usd = Math.round(n / tc * 100) / 100;
        else                                 usd = n;
      }
      return { ...it, usd_input: usd !== '' ? String(usd) : '', neto_input: value, monto: bruto !== '' ? String(bruto) : '' };
    }));
  }
  // Setter del TC del pago (recalcula bruto desde el USD tipeado).
  // 2026-07-04: limpia bruto_manual (misma política que setPagoUsd).
  function setPagoTc(idx, value) {
    setItems(arr => arr.map((it, j) => {
      if (j !== idx) return it;
      const m = cajasPago.find(x => Number(x.id) === Number(it.metodo_pago_id));
      const pct = pctMetodo(m);
      const bruto = brutoFromUsdInput(it.usd_input, it.moneda, value, pct);
      return { ...it, tc: value, neto_input: '', bruto_manual: false, monto: bruto !== '' ? String(bruto) : '' };
    }));
  }
  // Setter directo en moneda nativa para EFECTIVO ARS (sin comisión). El operador
  // a veces piensa "cliente me dio $X en efectivo" — más natural que pensar en USD.
  function setPagoArsAmount(idx, value) {
    setItems(arr => arr.map((it, j) => j !== idx ? it : ({
      ...it, monto: value, usd_input: '', neto_input: '',
    })));
  }

  // Setea el método del pago: caja del catálogo o "Cuenta corriente" (__CC__).
  // Con auto-fill: si el operador no había tipeado USD, autocompletamos con el
  // faltante (paridad con Ventas). Para EFECTIVO ARS, autocompletamos el monto
  // en ARS directamente (sin pasar por USD).
  function pickCajaPago(idx, value) {
    if (value === '__CC__') {
      setItems(arr => arr.map((it, j) => j !== idx ? it : ({
        ...it,
        metodo_pago_id: '', es_cuenta_corriente: true,
        // 2026-06-29 Multi-país F3: CC raramente se lleva en moneda local
        // (ARS o UYU son volátiles); default USD si la moneda era local,
        // sino preservar (USDT, etc.).
        moneda: it.moneda && it.moneda !== 'ARS' && it.moneda !== 'UYU' ? it.moneda : 'USD',
        tc: '', usd_input: '', neto_input: '',
      })));
      return;
    }
    const c = cajasPago.find(x => String(x.id) === String(value));
    setItems(arr => {
      const newMoneda = c ? c.moneda : null;
      const pct = pctMetodo(c);
      const arsDirect = pct === 0 && newMoneda === 'ARS';
      return arr.map((it, j) => {
        if (j !== idx) return it;
        const tcUse = it.tc || form.tc;
        if (arsDirect) {
          // Auto-fill en moneda local del método (cliente paga efectivo).
          //
          // BUG FIX Fase A+ #4 (2026-07-07): esta rama hardcodeaba
          // `moneda: 'ARS'` incluso cuando el método era UYU (path arsDirect
          // dispara con newMoneda === 'ARS' || 'UYU'). Para tenants UY, el
          // pago quedaba con moneda='ARS' contra caja moneda='UYU' → mismatch
          // en `syncVentaCaja` → data histórica del reporte del tenant UY.
          // La rama de Ventas.jsx retail ya usa `newMoneda` correctamente
          // (línea análoga); acá replicamos para paridad de comportamiento.
          let monto = it.monto;
          if (!monto || Number(monto) <= 0) {
            const falt = faltanteUsd(idx, arr);
            const tcN = Number(tcUse);
            if (falt > 0 && tcN > 0) monto = String(Math.round(falt * tcN * 100) / 100);
          }
          return {
            ...it,
            metodo_pago_id: value,
            es_cuenta_corriente: false,
            moneda: newMoneda,
            usd_input: '', neto_input: '', bruto_manual: false,
            monto: monto || '',
            tc: it.tc || '',
          };
        }
        // Resto: input en USD (Tarjeta, Transferencia, Efectivo USD, etc.).
        let usd = it.usd_input;
        if (!usd || Number(usd) <= 0) {
          const falt = faltanteUsd(idx, arr);
          if (falt > 0) usd = String(Math.round(falt * 100) / 100);
        }
        const bruto = brutoFromUsdInput(usd, newMoneda || it.moneda, tcUse, pct);
        return {
          ...it,
          metodo_pago_id: value,
          es_cuenta_corriente: false,
          moneda: newMoneda || it.moneda || 'USD',
          tc: c && c.moneda !== 'ARS' ? '' : it.tc,
          usd_input: usd,
          neto_input: '',
          bruto_manual: false,
          monto: bruto !== '' ? String(bruto) : '',
        };
      });
    });
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    resetEnvioErrors();
    setItems([{ ...EMPTY_ITEM, _id: newItemId() }]);
    setCreateError('');
    setComprobantes([]);
    setOcrSugerencia({ status: 'idle', monto: null });
    setEditingId(null);
    setModalMode('create');
  }

  function onComprobFiles(e) {
    const files = [...(e.target.files || [])];
    const MAX = 6 * 1024 * 1024;
    const next = [];
    let pending = files.length;
    setOcrSugerencia({ status: 'idle', monto: null });
    if (!pending) { setComprobantes([]); return; }
    files.forEach(f => {
      if (f.size > MAX) { pending--; return; }
      const r = new FileReader();
      r.onload = ev => { next.push({ nombre: f.name, tipo: f.type, data: String(ev.target.result).split(',')[1] }); pending--; if (pending === 0) {
        setComprobantes([...next]);
        // OCR del primer archivo (mismo patrón que Ventas).
        const first = next[0];
        if (first) {
          setOcrSugerencia({ status: 'pending', monto: null });
          ocrApi.extract(first.data, first.tipo)
            .then(res => {
              const m = Number(res?.monto);
              if (m > 0) setOcrSugerencia({ status: 'done', monto: m });
              else        setOcrSugerencia({ status: 'idle',  monto: null });
            })
            .catch(() => setOcrSugerencia({ status: 'error', monto: null }));
        }
      } };
      r.onerror = () => { pending--; if (pending === 0) setComprobantes([...next]); };
      r.readAsDataURL(f);
    });
  }
  // Aplica el monto detectado al "Entra a tu caja" del pago Financiera (o
  // primer no-CC si no hay Financiera). Mismo modelo que Ventas Tema C rev5.
  function aplicarOcrMonto() {
    if (ocrSugerencia.status !== 'done' || !ocrSugerencia.monto) return;
    const finCaja = cajasPago.find(c => c.es_financiera);
    let idx = -1;
    if (finCaja) idx = items.findIndex(it => it.tipo === 'pago' && !it.es_cuenta_corriente && Number(it.metodo_pago_id) === Number(finCaja.id));
    if (idx < 0) idx = items.findIndex(it => it.tipo === 'pago' && !it.es_cuenta_corriente && it.metodo_pago_id);
    if (idx < 0) { toast.error('Agregá un método de pago antes de aplicar el monto.'); return; }
    setPagoNeto(idx, String(ocrSugerencia.monto));
    setOcrSugerencia({ status: 'idle', monto: null });
  }

  // Precarga el modal con los datos del envío y abre en modo edit. Para items
  // tipo 'producto' linkeados, mapeamos lo que viene del backend (descripcion,
  // monto, producto_id, moneda) a la forma que espera el form. Los meta-fields
  // del producto (_nombre, _gb, etc.) quedan vacíos en el load inicial: el
  // operador ve la descripción plana y, si quiere los chips de detalle, hace
  // click en "Cambiar" para volver a pickear desde el inventario.
  function openEdit(envio) {
    if (!envio) return;
    setForm({
      fecha:        envio.fecha || new Date().toLocaleDateString('sv'),
      cliente:      envio.cliente || '',
      telefono:     envio.telefono || '',
      direccion:    envio.direccion || '',
      barrio:       envio.barrio || '',
      horario:      envio.horario || '',
      operador:     envio.operador || '',
      notas:        envio.notas || '',
      prioridad:    envio.prioridad || '',
      estado:       envio.estado || 'Pendiente',
      tc:           envio.tc != null ? String(envio.tc) : '',
      // 2026-07-13 (feature vuelto Fase 2): populate desde la venta linkeada.
      // GET /envios trae los 3 campos con prefijo `venta_vuelto_*` (LEFT JOIN
      // a ventas). Si el envío no tiene venta_id, los 3 son NULL.
      vuelto_monto:   envio.venta_vuelto_monto != null ? String(envio.venta_vuelto_monto) : '',
      vuelto_moneda:  envio.venta_vuelto_moneda || 'ARS',
      vuelto_caja_id: envio.venta_vuelto_caja_id || '',
    });
    const mappedItems = (envio.items || []).map(i => ({
      _id: newItemId(),
      tipo: i.tipo,
      descripcion: i.descripcion || '',
      monto: i.monto != null ? String(i.monto) : '',
      metodo_pago: i.metodo_pago || '',
      metodo_pago_id: i.metodo_pago_id || '',
      producto_id: i.producto_id || '',
      moneda: i.moneda || 'USD',
      tc: i.tc != null ? String(i.tc) : '',
      es_cuenta_corriente: !!i.es_cuenta_corriente,
      // Meta solo para UI — vacío al cargar; se llena solo si hacen "Cambiar".
      _imei: '', _nombre: '', _gb: '', _color: '', _costo: '', _costo_moneda: '',
    }));
    setItems(mappedItems.length ? mappedItems : [{ ...EMPTY_ITEM, _id: newItemId() }]);
    setCreateError('');
    setComprobantes([]);
    setOcrSugerencia({ status: 'idle', monto: null });
    setEditingId(envio.id);
    setModalMode('edit');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    // 2026-07-16 (task #147 UX B.2): validación inline consolidada.
    if (!validateEnvio()) return;
    // Paridad con Ventas: si algún pago usa la caja Financiera, exigir el
    // comprobante en el alta (no en edición — desde la pantalla del envío se
    // puede adjuntar después). Sin esto, syncFinancieraComprobante corre en
    // backend pero no tiene archivo → el dashboard de Transferencias queda
    // vacío para envíos.
    const finCaja = cajasPago.find(c => c.es_financiera);
    const pagosItems = items.filter(i => i.tipo === 'pago' && !i.es_cuenta_corriente && i.metodo_pago_id);
    const usaFinanciera = !!finCaja && pagosItems.some(p => Number(p.metodo_pago_id) === Number(finCaja.id));
    if (modalMode === 'create' && usaFinanciera && comprobantes.length === 0) {
      setCreateError('Este envío se cobra por Transferencia: adjuntá el comprobante antes de guardar.');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      const payload = {
        fecha: form.fecha,
        cliente: form.cliente.trim(),
        telefono: form.telefono.trim() || null,
        direccion: form.direccion.trim(),
        barrio: form.barrio.trim() || null,
        horario: form.horario.trim() || null,
        operador: form.operador.trim() || null,
        notas: form.notas.trim() || null,
        prioridad: form.prioridad || null,
        estado: form.estado || 'Pendiente',
        costo_envio: 0,
        tc: form.tc ? Number(form.tc) : null,
        total_cobrado: items.filter(i => i.tipo === 'pago').reduce((s, i) => s + (Number(i.monto) || 0), 0),
        items: items
          // tipo 'producto' SIEMPRE va linkeado (no se permite texto libre); 'pago' va siempre.
          .filter(i => i.tipo === 'pago' || (i.tipo === 'producto' && i.producto_id))
          .map(i => ({
            tipo: i.tipo,
            descripcion: (i.descripcion || '').trim() || null,
            monto: Number(i.monto) || 0,
            metodo_pago: (i.metodo_pago || '').trim() || null,
            metodo_pago_id: (i.tipo === 'pago' && !i.es_cuenta_corriente && i.metodo_pago_id) ? Number(i.metodo_pago_id) : null,
            producto_id: (i.tipo === 'producto' && i.producto_id) ? Number(i.producto_id) : null,
            moneda: i.moneda || 'ARS',
            tc: i.tc ? Number(i.tc) : null,
            es_cuenta_corriente: i.tipo === 'pago' ? !!i.es_cuenta_corriente : false,
          })),
      };
      // 2026-07-13 (feature vuelto Fase 2): incluir los 3 campos si el operador
      // cargó vuelto. En edit, mandar los 3 en null si están vacíos para
      // "quitar" el vuelto que la venta ya tenía (mismo patrón que Ventas.jsx).
      const vueltoMontoNum = Number(form.vuelto_monto);
      if (form.vuelto_monto && vueltoMontoNum > 0 && form.vuelto_caja_id) {
        payload.vuelto_monto   = vueltoMontoNum;
        payload.vuelto_moneda  = form.vuelto_moneda;
        payload.vuelto_caja_id = Number(form.vuelto_caja_id);
      } else if (modalMode === 'edit') {
        payload.vuelto_monto = null;
        payload.vuelto_moneda = null;
        payload.vuelto_caja_id = null;
      }
      let envioGuardado;
      if (modalMode === 'edit' && editingId) {
        // PUT: el backend resincroniza venta_items + venta_pagos + caja
        // automáticamente desde actualizarVentaDesdeEnvio. cliente_cc_id no
        // se manda — ya no se usa CC en Envíos y el backend mantiene el viejo.
        const actualizado = await envios.update(editingId, payload);
        envioGuardado = actualizado;
        setEnviosList(prev => prev.map(x => x.id === editingId ? { ...actualizado, items: payload.items } : x));
        setSelectedId(editingId);
      } else {
        // POST: siempre registrar como venta (regla del flujo).
        const nuevo = await envios.create({ ...payload, registrar_venta: true, cliente_cc_id: null });
        envioGuardado = nuevo;
        setEnviosList(prev => [{ ...nuevo, items: payload.items }, ...prev]);
        setSelectedId(nuevo.id);
      }
      // Subir comprobantes a la venta auto-creada por el envío. El backend
      // de envíos UPDATEa envios.venta_id en POST y mantiene la asociación
      // en PUT — usamos ese venta_id para reusar /api/ventas/:id/comprobantes
      // (mismo endpoint que Ventas → mismo syncFinancieraComprobante).
      let uploadFalló = false;
      const ventaId = envioGuardado?.venta_id;
      if (comprobantes.length > 0 && ventaId) {
        for (const c of comprobantes) {
          try { await ventas.uploadComprobante(ventaId, { archivo_data: c.data, archivo_nombre: c.nombre, archivo_tipo: c.tipo }); }
          catch (err) { uploadFalló = true; silentReport(err, 'envio-uploadComprobante'); }
        }
        if (uploadFalló) toast.error('El envío se guardó, pero el comprobante no se pudo adjuntar. Subilo de nuevo desde la venta.');
      }
      setShowCreate(false);
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  // ── Register global + action ──
  const { setPrimaryAction } = usePageActions();
  useEffect(() => {
    setPrimaryAction({ label: 'Nuevo envío', onClick: openCreate });
    return () => setPrimaryAction(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPrimaryAction]);

  // ── Load on mount ──
  useEffect(() => {
    setLoading(true);
    envios
      .list({ limit: 100 })
      .then(res => {
        const list = res.data || res || [];
        setEnviosList(list);
        if (list.length > 0) setSelectedId(list[0].id);
      })
      .catch(silentReport)
      .finally(() => setLoading(false));
  }, []);

  // ── Date helpers ──────────────────────────────────────────────────────────
  function todayStr() { return new Date().toLocaleDateString('sv'); } // 'sv' = YYYY-MM-DD
  function shiftDate(isoStr, days) {
    const d = new Date(isoStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString('sv');
  }
  function dateLabel(isoStr) {
    if (!isoStr) return 'Todos los días';
    const today = todayStr();
    const yesterday = shiftDate(today, -1);
    const tomorrow  = shiftDate(today, +1);
    if (isoStr === today)     return 'Hoy';
    if (isoStr === yesterday) return 'Ayer';
    if (isoStr === tomorrow)  return 'Mañana';
    const d = new Date(isoStr + 'T00:00:00');
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  // ── Client-side filter ──
  const filtered = useMemo(() => {
    return enviosList.filter(e => {
      const matchEstado = estadoFilter === 'todos' || e.estado === estadoFilter;
      const matchDate   = !dateFilter || (e.fecha && e.fecha.startsWith(dateFilter));
      const matchSearch =
        !search ||
        (e.cliente + ' ' + (e.direccion || '') + ' ' + (e.barrio || '') + ' ' +
          (e.items || []).map(i => i.descripcion || '').join(' '))
          .toLowerCase()
          .includes(search.toLowerCase());
      return matchEstado && matchDate && matchSearch;
    });
  }, [enviosList, estadoFilter, dateFilter, search]);

  const selected = enviosList.find(e => e.id === selectedId) || null;

  // ── KPIs ──
  // "esta semana" = lunes al domingo de la semana actual
  const weekStart = useMemo(() => {
    const d = new Date();
    const day = d.getDay(); // 0 = domingo
    const diff = day === 0 ? -6 : 1 - day; // ajustar a lunes
    d.setDate(d.getDate() + diff);
    return d.toLocaleDateString('sv');
  }, []);

  const kpiTotal = enviosList.length;
  const kpiEntregados = enviosList.filter(e =>
    e.estado === 'Entregado' && e.fecha && e.fecha >= weekStart
  ).length;
  const kpiEnCamino = enviosList.filter(e => e.estado === 'En camino').length;
  const kpiPendientes = enviosList.filter(e => e.estado === 'Pendiente').length;
  // 2026-06-10 — Antes este KPI sumaba todos los `monto` sin distinguir moneda y
  // mostraba el label hardcodeado "ARS". Resultado: un envío con pago de USD 290
  // aparecía como "ARS 290". Ahora convertimos cada pago a USD según su moneda
  // (ARS → divide por i.tc o e.tc como fallback; USD/USDT → directo) y mostramos
  // u$s en el label, alineado con el resto del portal que trabaja en USD.
  const kpiCobros = enviosList.reduce(
    (s, e) =>
      s + (e.items || []).filter(i => i.tipo === 'pago').reduce((ss, i) =>
        ss + toUsd(i.monto, i.moneda || 'ARS', i.tc || e.tc), 0),
    0
  );

  // ── Update estado ──
  async function handleUpdateEstado(id, newEstado) {
    setUpdatingId(id);
    try {
      // Backend has no /estado sub-route — use the PUT endpoint with partial update
      await envios.update(id, { estado: newEstado });
      setEnviosList(prev => prev.map(e => e.id === id ? { ...e, estado: newEstado } : e));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setUpdatingId(null);
    }
  }

  // ── Delete envío ──
  async function handleDelete(id) {
    const ok = await confirm({ title: 'Eliminar envío', message: 'Esta acción no se puede deshacer.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    setDeletingId(id);
    try {
      await envios.delete(id);
      const remaining = enviosList.filter(e => e.id !== id);
      setEnviosList(remaining);
      setSelectedId(prev => prev === id ? (remaining[0]?.id ?? null) : prev);
      toast.success('Envío eliminado.');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setDeletingId(null);
    }
  }

  // ── Badge helpers ──
  function estadoBadge(s) {
    const d = ESTADO_DISPLAY[s] || { label: s, tone: 'default' };
    return <Badge tone={d.tone}>{d.label}</Badge>;
  }

  function prioridadBadge(p) {
    if (!p) return null;
    const d = PRIO_DISPLAY[p] || { label: p, tone: 'default' };
    return <Badge tone={d.tone}>{d.label}</Badge>;
  }

  // ── Next-estado action label ──
  function nextEstadoLabel(estado) {
    if (estado === 'Pendiente') return 'Marcar en camino';
    if (estado === 'En camino') return 'Marcar entregado';
    return null;
  }

  function nextEstadoValue(estado) {
    if (estado === 'Pendiente') return 'En camino';
    if (estado === 'En camino') return 'Entregado';
    return null;
  }

  return (
    <div>
      {/* ── Page head ── */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Envíos</h1>
          <div className="page-sub">Despachos a domicilio · prioridad · items producto y pago</div>
        </div>
        <div className="page-actions u-flex-gap-8">
          <button
            className="btn"
            onClick={() => {
              setLoading(true);
              envios.list({ limit: 100 }).then(res => {
                const list = res.data || res || [];
                setEnviosList(list);
              }).catch(silentReport).finally(() => setLoading(false));
            }}
          >
            <Icons.Refresh size={14} /> Actualizar
          </button>
          <button className="btn btn-primary" onClick={openCreate}>
            <Icons.Plus size={14} /> Nuevo envío
          </button>
        </div>
      </div>

      {/* ── KPI row ── */}
      {/* 2026-06-24 mobile lote D: usar .kpi-grid (no .row) — 5 cards en
          .row colisionan en 375px exprimiendo cada card a ~70px ilegible.
          .kpi-grid hereda los breakpoints del styles.css (2x2 en <=640px). */}
      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">Total</div>
          <div className="kpi-value mono">{kpiTotal}</div>
          <div className="muted tiny u-mt-6">en sistema</div>
        </div>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">Entregados</div>
          <div className="kpi-value mono pos">{kpiEntregados}</div>
          <div className="muted tiny u-mt-6">esta semana</div>
        </div>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">En camino</div>
          <div className="kpi-value mono" style={{ color: 'var(--info)' }}>{kpiEnCamino}</div>
          <div className="muted tiny u-mt-6">ahora</div>
        </div>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">Pendientes</div>
          <div className="kpi-value mono" style={{ color: 'var(--warn)' }}>{kpiPendientes}</div>
          <div className="muted tiny u-mt-6">por despachar</div>
        </div>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">Cobros en ruta</div>
          <div className="kpi-value">
            <span className="ccy">u$s</span>
            <span className="mono pos">{fmt(kpiCobros)}</span>
          </div>
          <div className="muted tiny u-mt-6">items tipo "pago"</div>
        </div>
      </div>

      {/* ── Date nav + search + filter ── */}
      {/* 2026-06-24 mobile lote E: flex-wrap + gap mayor para que en
          <=414px las dos mitades (date nav + search/filtros) caigan a
          líneas separadas en vez de squeezear horizontalmente. */}
      <div className="flex-between" style={{ marginBottom: 14, flexWrap: 'wrap', rowGap: 10 }}>
        <div className="flex-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            className="icon-btn"
            title="Día anterior"
            aria-label="Día anterior"
            onClick={() => setDateFilter(d => d ? shiftDate(d, -1) : shiftDate(todayStr(), -1))}
          >
            <Icons.ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <div style={{ fontWeight: 600, fontSize: 14, minWidth: 96, textAlign: 'center' }}>
            {dateLabel(dateFilter)}
          </div>
          <button
            className="icon-btn"
            title="Día siguiente"
            aria-label="Día siguiente"
            onClick={() => setDateFilter(d => d ? shiftDate(d, +1) : shiftDate(todayStr(), +1))}
          >
            <Icons.ChevronRight size={14} />
          </button>
          <button
            className="btn btn-sm"
            style={dateFilter === todayStr() ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : {}}
            onClick={() => setDateFilter(todayStr())}
          >
            Hoy
          </button>
          {dateFilter && (
            <button className="btn btn-sm btn-ghost" onClick={() => setDateFilter(null)}>
              Todos
            </button>
          )}
        </div>
        <div className="flex-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {/* 2026-06-24 mobile lote E: width 280 fijo no entra en 375px viewport
              (junto con el Seg al lado). flex-grow + min-width 200 hace que
              se estire en desktop pero achique a 200px mínimo en mobile. */}
          <div className="input-group" style={{ flex: '1 1 200px', minWidth: 200, maxWidth: 280 }}>
            <span className="addon addon-l"><Icons.Search size={14} /></span>
            <input
              className="input"
              placeholder="Buscar cliente, producto, dirección…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Seg
            value={estadoFilter}
            options={[
              { value: 'todos',     label: 'Todos' },
              { value: 'Pendiente', label: 'Pendientes' },
              { value: 'En camino', label: 'En camino' },
              { value: 'Entregado', label: 'Entregados' },
              { value: 'Cancelado', label: 'Cancelados' },
            ]}
            onChange={setEstadoFilter}
          />
        </div>
      </div>

      {/* ── Loading state ──
          Skeletons mimicking ~5 envío cards (header + cliente + dirección)
          en lugar de "Cargando…" plano. Reduce perceived loading time
          (U-12 auditoría 2026-06-10). aria-busy avisa a lectores de
          pantalla que el área está cargando. */}
      {loading && (
        <div
          aria-busy="true"
          aria-live="polite"
          aria-label="Cargando envíos"
          className="stack"
          style={{ gap: 8, padding: '12px 0' }}
        >
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="card card-tight">
              <div className="flex-between u-mb-8">
                <Skeleton width={120} height={14} />
                <Skeleton width={60} height={12} />
              </div>
              <Skeleton width="60%" height={16} className="u-mb-4" />
              <Skeleton width="80%" height={12} />
            </div>
          ))}
        </div>
      )}

      {/* ── Split layout ── */}
      {/* 2026-06-24 mobile fix: .split-master-detail con --master-width 340.
          En <=720px colapsa a single column (la lista se ve full-width;
          al seleccionar un envío el detalle reemplaza la vista). Antes
          el grid inline `340px 1fr` dejaba ~10px de detalle en S20/SE
          —inusable. */}
      {!loading && (
        <div
          className="split-master-detail"
          style={{ '--master-width': '340px', gap: 12 }}
        >
          {/* ── Left: envío list ── */}
          <div
            className="stack"
            style={{
              gap: 8,
              // svh (small viewport height) en lugar de vh: en iOS Safari
              // el URL bar dinámico recorta vh cuando aparece y vuelve a
              // expandirse al hacer scroll → la lista pegaba saltos.
              // svh refleja el viewport mínimo (sin URL bar) y es estable.
              // Browser support: Safari 15.4+, Chrome 108+, Firefox 101+
              // (~98% global). El portal ya usa svh en otros lugares
              // (styles.css:1788, 2047).
              maxHeight: 'calc(100svh - 340px)',
              overflowY: 'auto',
              paddingRight: 2,
            }}
          >
            {filtered.length === 0 && (
              // 2026-06-25 UX-2 (audit pre-live): empty state con CTA + distinción
              // entre "sin envíos cargados" y "sin resultados para los filtros".
              (() => {
                const hasFilters = !!(search || estadoFilter !== 'todos' || dateFilter);
                if (hasFilters) {
                  return (
                    <div className="empty" style={{ padding: '24px 16px' }}>
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>Sin resultados</div>
                      <div className="muted tiny u-mb-14">
                        No hay envíos que coincidan con los filtros aplicados.
                      </div>
                      <button
                        className="btn btn-sm"
                        onClick={() => { setSearch(''); setEstadoFilter('todos'); setDateFilter(null); }}
                      >
                        Limpiar filtros
                      </button>
                    </div>
                  );
                }
                return (
                  <div className="empty" style={{ padding: '28px 16px' }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>Todavía no cargaste envíos</div>
                    <div className="muted tiny u-mb-14">
                      Los envíos a domicilio se cargan acá. Cada uno puede luego acreditarse como venta.
                    </div>
                    <button className="btn btn-primary btn-sm" onClick={openCreate}>
                      <Icons.Plus size={13} /> Nuevo envío
                    </button>
                  </div>
                );
              })()
            )}
            {filtered.map(e => {
              const productos = (e.items || []).filter(i => i.tipo === 'producto');
              const pagos = (e.items || []).filter(i => i.tipo === 'pago');
              const isSelected = selectedId === e.id;
              return (
                <div
                  key={e.id}
                  className="card card-tight"
                  onClick={() => setSelectedId(e.id)}
                  style={{
                    cursor: 'pointer',
                    borderColor: isSelected ? 'var(--accent)' : undefined,
                    background: isSelected ? 'var(--surface-2)' : undefined,
                    borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
                  }}
                >
                  <div className="flex-between u-mb-8">
                    <div className="flex-row u-gap-8">
                      <span
                        className="mono tiny"
                        style={{ fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.04em' }}
                      >
                        #{e.id}
                      </span>
                      {prioridadBadge(e.prioridad)}
                      {estadoBadge(e.estado)}
                    </div>
                    <div className="muted tiny mono">{e.horario || fmtFecha(e.fecha)}</div>
                  </div>
                  <div className="u-fs-14-fw-600">{e.cliente}</div>
                  <div className="muted tiny u-mt-2">{e.direccion}{e.barrio ? ' · ' + e.barrio : ''}</div>
                  <div className="flex-row" style={{ gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
                    {productos.length > 0 && (
                      <div className="flex-row" style={{ gap: 5, fontSize: 12 }}>
                        <Icons.Box size={13} className="muted" />
                        <span className="muted">{productos.length} {productos.length === 1 ? 'producto' : 'productos'}</span>
                      </div>
                    )}
                    {pagos.length > 0 && (
                      <div className="flex-row" style={{ gap: 5, fontSize: 12 }}>
                        <Icons.Dollar size={13} className="u-color-pos" />
                        <span className="pos mono u-fw-600">
                          {/* 2026-06-10: la moneda salía hardcodeada "ARS". Ahora
                              usa la del primer pago (caso 99%: todos los pagos del
                              envío comparten moneda). Si hay mixto, muestra la del
                              primero — suficiente como hint en la card lateral. */}
                          {pagos[0]?.moneda || 'ARS'} {fmt(pagos.reduce((s, p) => s + Number(p.monto || 0), 0))}
                        </span>
                      </div>
                    )}
                    {e.operador && (
                      <div className="flex-row" style={{ gap: 5, fontSize: 12, marginLeft: 'auto' }}>
                        <Icons.Users size={13} className="muted" />
                        <span className="muted">{e.operador}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Right: detail panel ── */}
          {selected ? (
            <div
              className="card card-flush"
              style={{ position: 'sticky', top: 16 }}
            >
              {/* Panel header */}
              <div className="card-hd">
                <div>
                  <div className="u-flex-center-gap-8">
                    <span
                      className="mono"
                      style={{ fontWeight: 700, color: 'var(--accent)', fontSize: 13 }}
                    >
                      Envío #{selected.id}
                    </span>
                    {estadoBadge(selected.estado)}
                    {prioridadBadge(selected.prioridad)}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 16, marginTop: 4 }}>{selected.cliente}</div>
                </div>
              </div>

              {/* Data rows */}
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
                <div className="stack u-gap-8">
                  {[
                    ['Fecha',     fmtFecha(selected.fecha) + (selected.horario ? ' · ' + selected.horario : '')],
                    ['Dirección', selected.direccion + (selected.barrio ? ' · ' + selected.barrio : '')],
                    selected.operador && ['Operador', selected.operador],
                  ].filter(Boolean).map(([label, value]) => (
                    <div
                      key={label}
                      style={{
                        display: 'flex',
                        gap: 12,
                        alignItems: 'flex-start',
                        fontSize: 13,
                      }}
                    >
                      <span
                        className="muted"
                        style={{
                          minWidth: 72,
                          fontWeight: 600,
                          fontSize: 11,
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          paddingTop: 1,
                        }}
                      >
                        {label}
                      </span>
                      <span className="u-fw-500">{value}</span>
                    </div>
                  ))}
                </div>

                {selected.notas && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: '10px 12px',
                      background: 'var(--warn-soft, rgba(234,179,8,0.08))',
                      borderLeft: '3px solid var(--warn)',
                      borderRadius: 6,
                      fontSize: 12.5,
                    }}
                  >
                    <strong>Nota:</strong> {selected.notas}
                  </div>
                )}
              </div>

              {/* Items section label */}
              <div
                style={{
                  padding: '10px 18px',
                  background: 'var(--bg-elev)',
                  borderBottom: '1px solid var(--border)',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.10em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                }}
              >
                Items del envío ({(selected.items || []).length})
              </div>

              {/* Items list */}
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                {(selected.items || []).length === 0 && (
                  <div className="empty">Sin items</div>
                )}
                {(selected.items || []).map((it, i, a) => (
                  <div
                    key={i}
                    style={{
                      padding: '12px 18px',
                      borderBottom: i < a.length - 1 ? '1px solid var(--hairline)' : 0,
                    }}
                  >
                    <div className="flex-between">
                      <div className="flex-row u-gap-10">
                        {it.tipo === 'producto' ? (
                          <>
                            <Icons.Box size={14} className="muted" />
                            <span className="u-fs-13-fw-600">
                              {it.descripcion || '(sin descripción)'}
                            </span>
                          </>
                        ) : (
                          <>
                            <Icons.Dollar size={14} className="u-color-pos" />
                            <span className="pos u-fs-13-fw-600">
                              Cobrar: {it.metodo_pago || 'efectivo'}
                            </span>
                          </>
                        )}
                      </div>
                      {it.tipo === 'pago' && (
                        <span className="mono pos" style={{ fontWeight: 700, fontSize: 13 }}>
                          {/* 2026-06-10: antes hardcodeaba "ARS" en el detalle aunque
                              el pago fuera USD. Ahora usa la moneda real del item. */}
                          {it.moneda || 'ARS'} {fmt(it.monto)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Action buttons */}
              <div style={{ padding: '12px 18px', display: 'flex', gap: 8, borderTop: '1px solid var(--border)' }}>
                {nextEstadoLabel(selected.estado) && (
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={updatingId === selected.id}
                    onClick={() => handleUpdateEstado(selected.id, nextEstadoValue(selected.estado))}
                  >
                    <Icons.Check size={13} />
                    {updatingId === selected.id ? 'Guardando…' : nextEstadoLabel(selected.estado)}
                  </button>
                )}
                {selected.telefono && (
                  <a
                    href={`tel:${selected.telefono}`}
                    className="btn btn-sm"
                    style={{ textDecoration: 'none' }}
                  >
                    <Icons.Phone size={13} /> {selected.telefono}
                  </a>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() => openEdit(selected)}
                  title="Editar este envío"
                >
                  <Icons.Edit size={13} /> Editar
                </button>
                <button
                  className="btn btn-sm"
                  style={{ marginLeft: 'auto', color: 'var(--neg)' }}
                  disabled={deletingId === selected.id}
                  onClick={() => handleDelete(selected.id)}
                >
                  <Icons.Trash size={13} />
                  {deletingId === selected.id ? 'Eliminando…' : 'Eliminar'}
                </button>
              </div>
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: 200,
                color: 'var(--text-muted)',
                fontSize: 13,
                border: '1px dashed var(--border)',
                borderRadius: 12,
              }}
            >
              Seleccioná un envío
            </div>
          )}
        </div>
      )}

      {/* ── Modal: Nuevo envío ─────────────────────────────────────────── */}
      {showCreate && (
        <div ref={createModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && !creating && setShowCreate(false)}>
          {/* 2026-06-10 — maxWidth bumpeado a 760px: el modal de envíos quedó
              chico tras agregar el display extendido del producto (modelo +
              capacidad + color + IMEI + costo) en la misma fila que Precio +
              Moneda + ✕. Con 600px se cortaba "MONEDA" y el botón ✕. */}
          <div
            className="modal"
            style={{ maxWidth: 760 }}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="envio-modal-title"
          >
            <div className="modal-hd">
              <h3 id="envio-modal-title">{modalMode === 'edit' ? `Editar envío #${editingId}` : 'Nuevo envío'}</h3>
              <button type="button" className="icon-btn" onClick={() => setShowCreate(false)} disabled={creating} aria-label="Cerrar" title="Cerrar">
                <Icons.X size={16} />
              </button>
            </div>
            {/* 2026-07-11 (Lucas Chrome 100% zoom bug): el <form> necesita ser
                flex-column con flex:1 + minHeight:0 para que la cadena flex del
                .modal se propague al .modal-body. Sin esto, el body toma su alto
                natural (todo el contenido), supera max-height: calc(100svh - 48px)
                del .modal, y el `overflow: hidden` del .modal CLIPEA el contenido
                en vez de scrollearlo. Con flex column el .modal-body.flex:1 activa,
                el overflow-y:auto del body kickea, y header/footer quedan pegados.
                minHeight:0 es crítico — sin él, el flex child no puede shrinkear
                por debajo de su content size (default en flex es min-content).
                Ver también nota abajo de 2026-06-24 que removió el workaround
                maxHeight:70vh inline sin arreglar la cadena flex. */}
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              {/* 2026-06-24 mobile fix: removido inline maxHeight 70vh y overflowY.
                  El base .modal-body ya tiene flex:1 + overflow-y:auto y el .modal
                  tiene max-height: calc(100svh - 48px). El override capeaba el
                  body al 70vh innecesariamente, haciendo el form sentirse más
                  apretado en mobile (especialmente con la barra de Safari).
                  2026-07-11: para que flex:1 realmente aplique al body, el <form>
                  padre tiene que ser flex column — ver comment arriba. */}
              <div className="modal-body">
                <div className="stack" style={{ gap: 16 }}>

                  {/* Fila 1: fecha + estado + prioridad */}
                  <div className="row">
                    <div className="field u-flex-1">
                      <label className="field-label">Fecha <span className="u-color-neg">*</span></label>
                      <input type="date" className="input" value={form.fecha}
                        onChange={e => setF('fecha', e.target.value)} />
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label">Estado</label>
                      <select className="input" value={form.estado} onChange={e => setF('estado', e.target.value)}>
                        <option>Pendiente</option>
                        <option>En camino</option>
                        <option>Entregado</option>
                        <option>Cancelado</option>
                      </select>
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label">Prioridad</label>
                      <select className="input" value={form.prioridad} onChange={e => setF('prioridad', e.target.value)}>
                        <option value="">Sin prioridad</option>
                        <option>Alta</option>
                        <option>Media</option>
                        <option>Baja</option>
                      </select>
                    </div>
                  </div>

                  {/* Fila 2: cliente + teléfono */}
                  <div className="row">
                    <div className="field u-flex-2">
                      <label className="field-label">Cliente <span className="u-color-neg">*</span></label>
                      <input className={'input' + (fieldErrors.cliente ? ' input-error' : '')} placeholder="Nombre del cliente"
                        value={form.cliente} onChange={e => setF('cliente', e.target.value)} autoFocus
                        aria-invalid={!!fieldErrors.cliente} />
                      {fieldErrors.cliente && <div className="field-error">{fieldErrors.cliente}</div>}
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label">Teléfono</label>
                      <input className="input" placeholder="ej. 3416123456"
                        value={form.telefono} onChange={e => setF('telefono', e.target.value)} />
                    </div>
                  </div>

                  {/* Fila 3: dirección + barrio */}
                  <div className="row">
                    <div className="field u-flex-2">
                      <label className="field-label">Dirección <span className="u-color-neg">*</span></label>
                      <input className={'input' + (fieldErrors.direccion ? ' input-error' : '')} placeholder="ej. San Martín 450"
                        value={form.direccion} onChange={e => setF('direccion', e.target.value)}
                        aria-invalid={!!fieldErrors.direccion} />
                      {fieldErrors.direccion && <div className="field-error">{fieldErrors.direccion}</div>}
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label">Barrio</label>
                      {/* 2026-06-10 — Combobox con autocomplete agrupado por
                          zona (CABA/Norte/Oeste/Sur/Este). Permite tipear libre
                          si el barrio no está en la lista curada. */}
                      <BarrioCombobox
                        value={form.barrio}
                        onChange={(v) => setF('barrio', v)}
                        placeholder="Buscar barrio o localidad…"
                      />
                    </div>
                  </div>

                  {/* Fila 4: horario + operador */}
                  <div className="row">
                    <div className="field u-flex-1">
                      <label className="field-label">Horario</label>
                      <input className="input" placeholder="ej. 10:00-12:00"
                        value={form.horario} onChange={e => setF('horario', e.target.value)} />
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label">Operador</label>
                      <input className="input" placeholder="Quién despacha"
                        value={form.operador} onChange={e => setF('operador', e.target.value)} />
                    </div>
                  </div>

                  {/* Notas */}
                  <div className="field">
                    <label className="field-label">Notas</label>
                    <input className="input" placeholder="Instrucciones, detalles…"
                      value={form.notas} onChange={e => setF('notas', e.target.value)} />
                  </div>

                  {/* Items del envío — solo productos (linkeados al stock con búsqueda) */}
                  <div>
                    <div className="flex-between u-mb-10">
                      <div className="u-fs-13-fw-600">Items del envío</div>
                      <button type="button" className="btn btn-sm" onClick={addProducto}>
                        <Icons.Plus size={13} /> Agregar producto
                      </button>
                    </div>
                    <div className="stack u-gap-8">
                      {/* Auditoría 2026-06-30 F-13/14: key={_id} estable. */}
                      {items.map((it, idx) => ({ it, idx })).filter(({ it }) => it.tipo === 'producto').map(({ it, idx }) => (
                        <div key={it._id} className="card card-tight" style={{ padding: '12px 14px' }}>
                          {/* 2026-06-10 (Lucas eligió layout "Hero card con chips"):
                              · Sin linkear → grilla compacta de 4 col: buscador + monto + moneda + ✕.
                              · Linkeado → 2 niveles:
                                  hero (modelo grande + chips capacidad/color/costo)
                                  → línea IMEI tenue
                                  → fila de controles (precio venta + moneda + ✕). */}
                          {!it.producto_id ? (
                            // 2026-06-24 mobile lote C: .item-grid responsive
                            <div className="item-grid" style={{ '--cols': '1fr 140px 90px auto', gap: 8, alignItems: 'end' }}>
                              <div className="field" style={{ marginBottom: 0, position: 'relative' }}>
                                <label className="field-label">Buscar producto del inventario <span className="muted tiny">(nombre, IMEI, color, GB…)</span></label>
                                <input className="input" placeholder="Empezá a tipear…"
                                       value={prodSearch.itemIdx === idx ? prodSearch.q : ''}
                                       onChange={e => searchProductos(idx, e.target.value)}
                                       onFocus={() => setProdSearch(s => ({ ...s, itemIdx: idx }))} />
                                {prodSearch.itemIdx === idx && prodSearch.q.trim().length >= 2 && (
                                  <div className="card card-tight" style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, zIndex: 50, maxHeight: 260, overflowY: 'auto', padding: 0 }}>
                                    {prodSearch.loading && <div className="muted tiny" style={{ padding: '8px 10px' }}>Buscando…</div>}
                                    {!prodSearch.loading && prodSearch.results.length === 0 && <div className="muted tiny" style={{ padding: '8px 10px' }}>Sin resultados</div>}
                                    {prodSearch.results.map(p => (
                                      <button type="button" key={p.id}
                                              onClick={() => pickProducto(idx, p)}
                                              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: 'transparent', cursor: 'pointer', borderBottom: '1px solid var(--hairline)', color: 'var(--text)' }}>
                                        <div className="u-fs-13-fw-600">{[p.nombre, gbLabel(p.gb), p.color].filter(Boolean).join(' · ')}</div>
                                        <div className="muted tiny mono">{p.imei ? 'IMEI ' + fmtImei(p.imei) : '—'} · cantidad {p.cantidad ?? 0} · ${fmt(p.precio_venta)}</div>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div className="field u-mb-0">
                                <label className="field-label">Monto</label>
                                <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="0"
                                  value={it.monto} onChange={e => setItem(idx, 'monto', e.target.value)} />
                              </div>
                              <div className="field u-mb-0">
                                <label className="field-label">Moneda</label>
                                {/* 2026-06-29 Multi-país F3: monedas según país del tenant.
                                    Preserva legacy value si existiera (records viejos). */}
                                <select className="input" value={it.moneda || 'USD'} onChange={e => setItem(idx, 'moneda', e.target.value)}>
                                  {Array.from(new Set([...monedas, it.moneda].filter(Boolean)))
                                    .map(m => <option key={m} value={m}>{m}</option>)}
                                </select>
                              </div>
                              <button type="button" className="icon-btn" title="Quitar ítem" aria-label="Quitar ítem" style={{ marginBottom: 1 }} onClick={() => rmItem(it._id)}>
                                <Icons.X size={14} />
                              </button>
                            </div>
                          ) : (
                            <>
                              {/* HERO: solo título + Cambiar. Los chips, IMEI y controles
                                  bajan a una única fila debajo (variante V2 elegida por Lucas). */}
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
                                <div className="u-flex-1-minw-0">
                                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>
                                    Producto seleccionado
                                  </div>
                                  {/* 2026-06-24 lote F: clamp para que en mobile (375px viewport)
                                      el título del producto seleccionado no domine sobre los chips
                                      e info debajo. Min 15px asegura legibilidad. */}
                                  <div style={{ fontSize: 'clamp(15px, 4vw, 17px)', fontWeight: 600, letterSpacing: -0.2, color: 'var(--text)' }}>
                                    {it._nombre || it.descripcion}
                                  </div>
                                </div>
                                <button type="button" className="btn btn-ghost btn-sm" onClick={() => unpickProducto(idx)}>Cambiar</button>
                              </div>
                              {/* Fila única: chips + IMEI a la izquierda, Precio + Moneda + ✕ a la
                                  derecha. Los chips quedan baseline-alineados con los inputs
                                  gracias al paddingBottom que compensa la altura del label.
                                  2026-06-24 mobile lote C: .item-grid responsive en <=520px. */}
                              <div className="item-grid" style={{
                                '--cols': '1fr 140px 90px auto',
                                gap: 10, alignItems: 'end',
                              }}>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', paddingBottom: 7 }}>
                                  {it._gb && <span className="badge">{gbLabel(it._gb)}</span>}
                                  {it._color && <span className="badge">{it._color}</span>}
                                  {it._costo && (
                                    <span className="badge badge-pos">
                                      Costo {it._costo_moneda === 'ARS' ? '$' : 'u$s'}{fmt(Number(it._costo))}
                                    </span>
                                  )}
                                  {it._imei && (
                                    <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 11.5, marginLeft: 2 }}>
                                      IMEI {it._imei}
                                    </span>
                                  )}
                                </div>
                                <div className="field u-mb-0">
                                  <label className="field-label">Precio venta</label>
                                  <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="0"
                                    value={it.monto} onChange={e => setItem(idx, 'monto', e.target.value)} />
                                </div>
                                <div className="field u-mb-0">
                                  <label className="field-label">Moneda</label>
                                  {/* 2026-06-29 Multi-país F3: monedas según país del tenant. */}
                                  <select className="input" value={it.moneda || 'USD'} onChange={e => setItem(idx, 'moneda', e.target.value)}>
                                    {Array.from(new Set([...monedas, it.moneda].filter(Boolean)))
                                      .map(m => <option key={m} value={m}>{m}</option>)}
                                  </select>
                                </div>
                                <button type="button" className="icon-btn" style={{ marginBottom: 1 }} onClick={() => rmItem(it._id)}>
                                  <Icons.X size={14} />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Pagos — sección separada como Ventas: select de método (incluye CC), monto, moneda, TC */}
                  <div>
                    <div className="flex-between u-mb-10">
                      <div className="u-fs-13-fw-600">Pagos</div>
                      <button type="button" className="btn btn-sm" onClick={addPago}>
                        <Icons.Plus size={13} /> Agregar método
                      </button>
                    </div>
                    <div className="stack u-gap-6">
                      {/* Paridad con Ventas Tema C rev5: operador tipea USD (mental
                          model), el sistema arma el bruto en moneda nativa. Si hay
                          comisión, debajo aparece el desglose "Le cobrás / Financiera
                          (%) / Entra a tu caja (editable)". Para EFECTIVO ARS (sin
                          comisión), el input es ARS directo. */}
                      {items.map((it, idx) => ({ it, idx })).filter(({ it }) => it.tipo === 'pago').map(({ it, idx }) => {
                        const det = summary.pagosDetalle[idx];
                        const m = cajasPago.find(c => Number(c.id) === Number(it.metodo_pago_id));
                        const tcEff = Number(it.tc) || Number(form.tc) || null;
                        const pctEff = pctMetodo(m);
                        const factorEff = pctEff > 0 ? 1 / (1 - pctEff / 100) : 1;
                        const arsDirect = pctEff === 0 && it.moneda === 'ARS';
                        const showTc = !it.es_cuenta_corriente && it.moneda === 'ARS';
                        const showDesglose = det && det.pct > 0 && it.moneda === 'ARS';
                        const montoNum = Number(it.monto) || 0;
                        let derivedUsd = it.usd_input;
                        if (!arsDirect && (derivedUsd === '' || derivedUsd === null) && montoNum > 0) {
                          // Editing envíos viejos: derivar el USD del monto bruto.
                          if (it.moneda === 'USD' || it.moneda === 'USDT') {
                            derivedUsd = String(Math.round(montoNum / factorEff * 100) / 100);
                          } else if (it.moneda === 'ARS' && tcEff > 0) {
                            derivedUsd = String(Math.round(montoNum / factorEff / tcEff * 100) / 100);
                          }
                        }
                        return (
                          <div key={it._id}>
                            <div style={{
                              display: 'grid',
                              gridTemplateColumns: showTc ? '1fr 110px 90px auto' : '1fr 110px auto',
                              gap: 6, alignItems: 'center',
                            }}>
                              <select className="input" value={it.es_cuenta_corriente ? '__CC__' : it.metodo_pago_id}
                                      onChange={e => pickCajaPago(idx, e.target.value)}>
                                <option value="">Método…</option>
                                {cajasPago.map(c => (
                                  <option key={c.id} value={c.id}>{c.nombre}</option>
                                ))}
                                {/* 2026-06-10: Cuenta corriente removida del modal de
                                    Envíos por pedido de Lucas — no se vende a consumidor
                                    final con CC. La lógica detrás (es_cuenta_corriente)
                                    queda por compatibilidad con envíos legacy. */}
                              </select>
                              <div className="u-pos-rel">
                                <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 11, pointerEvents: 'none' }}>
                                  {arsDirect ? '$' : 'USD'}
                                </span>
                                {arsDirect ? (
                                  <input
                                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                                    data-testid="envio-pago-monto"
                                    className="input mono" placeholder="730.000"
                                    value={it.monto}
                                    onChange={e => setPagoArsAmount(idx, e.target.value)}
                                    style={{ paddingLeft: 22 }}
                                  />
                                ) : (
                                  <input
                                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                                    data-testid="envio-pago-monto"
                                    className="input mono" placeholder="500"
                                    value={derivedUsd}
                                    onChange={e => setPagoUsd(idx, e.target.value)}
                                    style={{ paddingLeft: 36 }}
                                  />
                                )}
                              </div>
                              {showTc && (
                                <div className="u-pos-rel">
                                  <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 11, pointerEvents: 'none' }}>TC</span>
                                  <input
                                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                                    className="input mono" placeholder="1460"
                                    value={it.tc}
                                    onChange={e => setPagoTc(idx, e.target.value)}
                                    style={{ paddingLeft: 30 }}
                                  />
                                </div>
                              )}
                              <button type="button" className="icon-btn" title="Quitar ítem" aria-label="Quitar ítem" onClick={() => rmItem(it._id)}>
                                <Icons.X size={14} />
                              </button>
                            </div>
                            {showDesglose && (
                              <div style={{
                                marginTop: 8, display: 'grid',
                                gridTemplateColumns: '1fr 1fr 1fr',
                                gap: 10, fontSize: 12, alignItems: 'start',
                                paddingLeft: 2,
                              }}>
                                <div>
                                  <div className="muted tiny" style={{ marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span>Le cobrás al cliente <span className="u-color-text-muted">(editable)</span></span>
                                    {it.bruto_manual && (
                                      <span
                                        title="Estás editando el monto manualmente. Al cambiar USD/TC/método el cálculo vuelve a la fórmula."
                                        style={{
                                          fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                                          padding: '1px 5px', borderRadius: 3,
                                          background: 'rgba(217, 119, 6, 0.15)',
                                          color: '#d97706',
                                          border: '1px solid rgba(217, 119, 6, 0.35)',
                                        }}
                                      >MANUAL</span>
                                    )}
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <span className="mono u-fs-13-fw-600">{sym(it.moneda)}</span>
                                    <input
                                      type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                                      className="input mono"
                                      value={it.bruto_manual ? (it.monto ?? '') : Math.round(det.brutoOrig * 100) / 100}
                                      onChange={e => setPagoBruto(idx, e.target.value)}
                                      style={{ padding: '2px 6px', fontSize: 13, fontWeight: 600, width: 110 }}
                                    />
                                  </div>
                                </div>
                                <div>
                                  <div className="muted tiny u-mb-2" title={m?.nombre || ''}>Financiera ({det.pct}%)</div>
                                  <div className="mono neg u-fs-13-fw-600">−{sym(it.moneda)}{fmt(det.costoFinOrig)}</div>
                                </div>
                                <div>
                                  <div className="muted tiny u-mb-2">Entra a tu caja <span className="u-color-text-muted">(editable)</span></div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                                    <input
                                      type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                                      className="input mono"
                                      value={it.neto_input || Math.round(det.netoOrig * 100) / 100}
                                      onChange={e => setPagoNeto(idx, e.target.value)}
                                      style={{ padding: '2px 6px', fontSize: 13, fontWeight: 600, width: 110 }}
                                    />
                                    <span className="mono pos" style={{ fontWeight: 600, fontSize: 12 }}>= u$s{fmt(det.netoUsd)}</span>
                                  </div>
                                </div>
                              </div>
                            )}
                            <TcWarning tc={it.tc} />
                          </div>
                        );
                      })}
                      {items.filter(i => i.tipo === 'pago').length === 0 && (
                        <div className="muted tiny" style={{ padding: '4px 0' }}>Sin pagos cargados. Sumá un método con "Agregar método".</div>
                      )}
                    </div>
                  </div>

                  {/* 2026-07-13 (feature vuelto Fase 2): sección Vuelto/Cambio
                      idéntica a Ventas.jsx. Como en Envíos `registrar_venta` está
                      hardcodeado a true en el submit, siempre se propaga a la
                      venta que crea el envío. Al cancelar el envío, la venta
                      se cancela y el egreso del vuelto se revierte auto. */}
                  <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: form.vuelto_monto ? 8 : 0 }}>
                      <div className="u-fs-13-fw-600">
                        Vuelto/Cambio
                        <span className="muted tiny" style={{ marginLeft: 8, fontWeight: 400 }}>
                          (opcional — dinero que entregás al cliente)
                        </span>
                      </div>
                      {form.vuelto_monto && (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => {
                          setForm(f => ({ ...f, vuelto_monto: '', vuelto_caja_id: '' }));
                        }}>Quitar</button>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.5fr', gap: 8 }}>
                      <div>
                        <div className="muted tiny u-mb-2">Monto</div>
                        <input
                          type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                          className="input mono"
                          value={form.vuelto_monto}
                          onChange={e => setForm(f => ({ ...f, vuelto_monto: e.target.value }))}
                          placeholder="0"
                          className="u-w-100"
                        />
                      </div>
                      <div>
                        <div className="muted tiny u-mb-2">Moneda</div>
                        <select
                          className="input"
                          value={form.vuelto_moneda}
                          onChange={e => setForm(f => ({ ...f, vuelto_moneda: e.target.value }))}
                          className="u-w-100"
                        >
                          <option value="ARS">ARS</option>
                          <option value="UYU">UYU</option>
                          <option value="USD">USD</option>
                          <option value="USDT">USDT</option>
                        </select>
                      </div>
                      <div>
                        <div className="muted tiny u-mb-2">
                          Sale de{' '}
                          {form.vuelto_monto && !form.vuelto_caja_id && (
                            <span className="warn u-fw-600">· elegí caja</span>
                          )}
                        </div>
                        <select
                          className="input"
                          value={form.vuelto_caja_id}
                          onChange={e => setForm(f => ({ ...f, vuelto_caja_id: e.target.value }))}
                          className="u-w-100"
                        >
                          <option value="">— Elegí caja —</option>
                          {cajasPago.filter(c => !c.deleted_at).map(c => (
                            <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Comprobantes — paridad con Ventas. Si algún pago usa la
                      caja Financiera, son OBLIGATORIOS en el alta (handleSubmit
                      lo valida). Se suben a la venta auto-creada por el envío
                      vía /api/ventas/:venta_id/comprobantes, que dispara
                      syncFinancieraComprobante en backend. */}
                  {modalMode === 'create' && (
                    <div className="field">
                      <label className="field-label">Comprobantes de pago <span className="muted tiny">(imágenes/PDF, máx 6MB c/u · requerido si cobrás por Transferencia)</span></label>
                      <input type="file" multiple accept="image/*,application/pdf" className="input" onChange={onComprobFiles} />
                      {comprobantes.length > 0 && <div className="muted tiny u-mt-4">{comprobantes.length} archivo(s) listo(s)</div>}
                      {/* OCR del comprobante (Tema C rev5 — mismo patrón que Ventas
                          y Financiera). Aplica al "Entra a tu caja" del pago. */}
                      {ocrSugerencia.status === 'pending' && (
                        <div className="muted tiny u-mt-4">Leyendo monto del comprobante…</div>
                      )}
                      {ocrSugerencia.status === 'done' && ocrSugerencia.monto > 0 && (
                        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span className="muted tiny">Detectamos en el comprobante:</span>
                          <span className="mono u-fw-600">${fmt(ocrSugerencia.monto)}</span>
                          <button type="button" className="btn btn-sm" onClick={aplicarOcrMonto}>Aplicar al pago</button>
                        </div>
                      )}
                      {ocrSugerencia.status === 'error' && (
                        <div className="muted tiny u-color-neg-mt-4">No se pudo leer el monto. Cargalo a mano.</div>
                      )}
                    </div>
                  )}

                  {/* Resumen tipo Ventas: Total venta · Pagos · Diferencia (Cubierto ✓) */}
                  <div className="card card-tight" style={{ padding: '10px 12px', background: 'var(--surface-2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span className="muted">Total venta</span>
                      <span className="mono">u$s {summary.totalUsd.toFixed(2)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span className="muted">Pagos</span>
                      <span className="mono">u$s {summary.pagosUsd.toFixed(2)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span className="muted">Diferencia</span>
                      <span className="mono" style={{ color: cubierto ? 'var(--pos)' : 'var(--neg)' }}>
                        {cubierto ? 'Cubierto ✓' : `u$s ${summary.diferenciaUsd.toFixed(2)}`}
                      </span>
                    </div>
                  </div>

                  {/* 2026-06-10 — Sacamos el checkbox "Registrar como venta": todo
                      envío genera una venta asociada (estado='pendiente' al crear,
                      'acreditado' al confirmar entrega). Antes era opcional y era
                      footgun: si el operador no lo tickeaba, el envío nunca aparecía
                      en el dashboard de ventas. */}
                  <div className="field u-mb-0">
                    <label className="field-label">Tipo de cambio (TC) del envío <span className="muted tiny">opcional · necesario si hay items en ARS</span></label>
                    <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="Ej: 1000"
                           value={form.tc} onChange={e => setF('tc', e.target.value)} />
                  </div>

                  {createError && (
                    <div className="u-color-neg-fs-13">{createError}</div>
                  )}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? 'Guardando…' : (modalMode === 'edit' ? 'Guardar cambios' : 'Crear envío')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
