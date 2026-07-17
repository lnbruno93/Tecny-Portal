import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icons } from '../components/Icons';
import { ventas, inventario, vendedores as vendedoresApi, cuentas as cuentasApi, contactos as contactosApi, envios as enviosApi, config as configApi, ocr as ocrApi } from '../lib/api';
import { exportCsv } from '../lib/exportCsv';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import useLoadingAction from '../lib/useLoadingAction'; // #F-2
import useModal from '../lib/useModal';
import TcWarning from '../components/TcWarning';
import Badge from '../components/Badge';
import { SkeletonRow } from '../components/Skeleton';
import VendedoresCatalogModal from '../components/VendedoresCatalogModal';
import { fmt, fmt2, fmtImei } from '../lib/format';
// 2026-06-29 Multi-país F3: dropdowns moneda gated por tenant.pais.
// AR → ARS/USD/USDT, UY → UYU/USD/USDT. monedaLocal sirve de default para
// pagos y para el check "es moneda local" (que antes era hardcoded ARS).
import { useMonedasTenant } from '../lib/useMonedasTenant';
import { useAuth } from '../contexts/AuthContext';
import { getMonedasConValor } from '../lib/monedasPais';
// 2026-07-07: helper puro para sustituir {{negocio}} por tenant.nombre
// en las plantillas de garantía. Reemplaza el hack anterior donde el
// nombre del negocio quedaba hardcoded en el texto guardado en DB.
import { renderPlantilla, PLACEHOLDER_NEGOCIO } from '../lib/renderPlantilla';

// Componentes y helpers locales del módulo Ventas — extraídos a archivos
// dedicados para mantener este screen enfocado en orchestration.
import Seg from './ventas/Seg';
import Dashboard from './ventas/Dashboard';
import DiffModal from './ventas/DiffModal';
import ExitoModal from './ventas/ExitoModal';
import EditarVendedorModal from './ventas/EditarVendedorModal';
import VentasList from './ventas/VentasList';
import { sym, toUsd, todayStr, shiftDate, monthStart, weekStart, computeVentaTotales } from './ventas/utils';

const ESTADO_DISPLAY = {
  acreditado: { label: 'Acreditado', tone: 'pos' },
  pendiente:  { label: 'Pendiente',  tone: 'warn' },
  cancelado:  { label: 'Cancelado',  tone: 'neg' },
};
const ESTADO_LABEL = { acreditado: 'Acreditado', pendiente: 'Pendiente', cancelado: 'Cancelado' };
// Texto de garantía por defecto cuando el tenant no tiene ninguna plantilla
// activa. 2026-07-07: el pie ahora usa el placeholder `{{negocio}}` en
// lugar de concatenar el nombre — así es CONSISTENTE con las plantillas
// guardadas en DB (que también usan `{{negocio}}` tras el backfill de
// migration 20260707000003). Al pasar por `renderPlantilla(...)` se resuelve
// al nombre real del tenant.
const GARANTIA_FALLBACK_TEXTO = `Este comprobante es tu nota de compra y avala la operación comercial entre partes. No es una factura ni comprobante fiscal.

Nos responsabilizamos por 12 meses, desde la fecha de compra, ante cualquier error, falla o mal funcionamiento propio de software y hardware.

${PLACEHOLDER_NEGOCIO}`;

const EMPTY_VENTA = {
  fecha: todayStr(), hora: '', cliente_nombre: '', cliente_id: '', cliente_cc_id: '', etiqueta_id: '', garantia_id: '',
  // 2026-07-07: default `acreditado` — la mayoría de las ventas se cargan
  // ya cobradas (no en pending). Antes era 'pendiente' y el operador tenía
  // que cambiarlo manualmente en cada venta cash — fricción innecesaria.
  vendedor_id: '', comision: '', tc_venta: '', estado: 'acreditado', notas: '',
  // Junio 2026: canjes pasa de 1 sola entrada con 4 campos a array de hasta N
  // canjes con 10 campos c/u — cada canje puede ir a Inventario con todos sus
  // datos. Ver schema canjeSchema en backend/src/schemas/ventas.js.
  canjes: [],
  // #475 — opt-in para enviar el comprobante PDF por email al cliente al
  // confirmar la venta. cliente_email pre-cargado desde contactos.email del
  // contacto vinculado (si tiene). enviar_comprobante_email default ON si
  // el contacto ya tiene email (asumimos que es el flow esperado).
  cliente_email: '',
  enviar_comprobante_email: false,
  // 2026-07-13 (feature vuelto): cambio dado al cliente. Los 3 campos van
  // juntos (todo-o-nada). Si `vuelto_monto` es '', no se registra vuelto.
  // Al submit: si monto > 0, se envían los 3 al backend; sino, los 3 en null.
  vuelto_monto:   '',
  vuelto_moneda:  'ARS',   // default ARS (el 99% de los casos)
  vuelto_caja_id: '',
  // 2026-07-14 (bug reportado por Lucas): TC del vuelto, obligatorio si
  // moneda ∈ {ARS, UYU}. Sin esto el backend rechaza + la ganancia_usd no
  // reflejaba el vuelto (mentía sobre la rentabilidad de la venta).
  vuelto_tc:      '',
};

// Forma de un canje vacío para usar como template al "+ Agregar equipo".
// 2026-07-11: `categoria_id` (Colección legacy) → `clase_id` (categoría real
// F3: Celular Sellado/Usado, Watch, iPads, Auriculares, etc.). Antes del fix
// el select cargaba `categorias` legacy que estaba vacío para tenants sin
// colecciones creadas — fricción reportada por Lucas.
const EMPTY_CANJE = {
  descripcion: '', imei: '', gb: '', color: '', bateria: '',
  valor_toma: '', moneda: 'USD', agregar_stock: true,
  clase_id: '', condicion: 'usado',
  precio_venta_sugerido: '', observaciones: '',
};

// Auditoría 2026-06-30 F-13/14: ID único por ítem para usarse como React key.
// Usar el índice como key rompe el reconciler cuando se quita un ítem del
// medio: React reutiliza el DOM del index anterior, pero el state interno
// del input (incluyendo el draft no-controlado y el cursor) "salta" al
// ítem siguiente. Con un id estable la fila eliminada se desmonta limpio.
// crypto.randomUUID está disponible en todos los browsers target + jsdom.
function newItemId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback ultra-defensivo (jsdom viejos, entornos no-secure-context).
  return `it-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─── Pantalla ──────────────────────────────────────────────────────────────────
export default function Ventas() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { setPrimaryAction } = usePageActions();
  const navigate = useNavigate();
  // 2026-06-29 Multi-país F3: set de monedas + local del tenant. Reemplaza
  // los hardcodes ['ARS','USD','USDT'] / 'ARS' en los dropdowns y la lógica
  // país-aware (TC visible cuando moneda===monedaLocal, no ARS hardcoded).
  const { monedas, monedaLocal } = useMonedasTenant();
  // 2026-07-04 (#506): nombre del negocio (owner-set) para brandear el PDF del
  // comprobante + fallback de garantía. Guard igual a useMonedasTenant: user
  // puede ser null en mount inicial o si /me falló.
  //
  // 2026-07-11 (bug Tek Haus): fallback pasa de 'Tecny' → 'Tu comercio'.
  // Contexto: si /me devuelve tenant:null (fail-open del helper backend, ver
  // fix en auth.js /me 2026-07-11), este `||` activaba y el comprobante salía
  // brandeado con "Tecny" (el nombre del SaaS) — confuso para el cliente
  // final del tenant. Ahora usamos un placeholder neutro. La fuente correcta
  // (nombre del tenant en DB) llega en el 99% de los casos post-fix del /me;
  // este fallback solo activa si TODO falla.
  const { user } = useAuth() || {};
  const tenantNombre = user?.tenant?.nombre || 'Tu comercio';

  const [lista, setLista] = useState([]);
  const [dash, setDash] = useState(null);
  const [rapidas, setRapidas] = useState([]);
  const [loading, setLoading] = useState(true);

  // Auditoría 2026-06-30 F-07: filtros persistidos en URL via useSearchParams.
  // Defaults NO se escriben (mantiene URLs limpias para el caso típico).
  // Compartir un link con ?periodo=trimestre& estadoFilter=acreditado restaura
  // el filtro exacto. Reglas: replace:true para no inflar history, helpers
  // setX(p) borran el param cuando coincide con el default.
  const [searchParams, setSearchParams] = useSearchParams();
  const _today = todayStr();
  const periodo = searchParams.get('periodo') || 'hoy';
  const desde = searchParams.get('desde') || _today;
  const hasta = searchParams.get('hasta') || _today;
  const estadoFilter = searchParams.get('estado') || '';
  const search = searchParams.get('q') || '';

  // Setters que escriben (o borran) un solo param sobre los existentes —
  // preservan cualquier otro param (drill-down, etc.) que ya esté en la URL.
  const setParam = useCallback((key, value, def) => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === def) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  // Set múltiples params en un solo render — usado al cambiar el preset
  // (periodo + desde + hasta cambian todos juntos, no queremos 3 renders).
  const setParams = useCallback((updates) => {
    const next = new URLSearchParams(searchParams);
    for (const { key, value, def } of updates) {
      if (!value || value === def) next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const setPeriodo = useCallback((p) => setParam('periodo', p, 'hoy'), [setParam]);
  const setDesde = useCallback((d) => setParam('desde', d, _today), [setParam, _today]);
  const setHasta = useCallback((h) => setParam('hasta', h, _today), [setParam, _today]);
  const setEstadoFilter = useCallback((e) => setParam('estado', e, ''), [setParam]);
  const setSearch = useCallback((s) => setParam('q', s, ''), [setParam]);
  const dSearch = useDebouncedValue(search, 350); // no fetch en cada keystroke

  // Catálogos
  const [vendedores, setVendedores] = useState([]);
  const [etiquetas, setEtiquetas] = useState([]);
  // Clases de producto (F3.a) — categorías reales por tenant, editables,
  // con emoji. Se usan en el picker del canje para que un equipo tomado
  // entre directo en su categoría correcta.
  // 2026-07-11: reemplaza el uso previo de `categoriasInv` (Colecciones
  // legacy, tabla `categorias`) — quedaba vacío para tenants sin
  // colecciones creadas y no era la dimensión semánticamente correcta
  // post-F3.
  const [clasesInv, setClasesInv] = useState([]);
  const [metodos, setMetodos] = useState([]);
  // Tema C en-vivo (2026-06-13): porcentaje global de Financiera (`config.pct_financiera`).
  // Lo usamos en el preview de ganancia real para descontar comisión de pagos por
  // transferencia. Cargado en loadCatalogos, no se refetcha durante la sesión —
  // si Lucas lo cambia en Config, se actualiza al re-entrar a Ventas.
  const [pctFinanciera, setPctFinanciera] = useState(0);
  const [garantias, setGarantias] = useState([]);
  const [clientesCC, setClientesCC] = useState([]);
  const [contactos, setContactos] = useState([]);
  const [clienteDrop, setClienteDrop] = useState(false);

  // Modal de diferencia en pagos (visual rico, custom — no usa ConfirmModal)
  // y modal de éxito post-venta con descargar comprobante en PDF.
  const [diffModal, setDiffModal] = useState({ open: false, items: 0, cubierto: 0, dif: 0, resolve: null });
  const [exitoModal, setExitoModal] = useState({ open: false, venta: null });
  // #509 — modal focalizado para editar el "atendido por" del comprobante
  // post-emisión. Se abre desde el icono Users de VentasList.
  const [editarVendedor, setEditarVendedor] = useState({ open: false, venta: null });
  // #M-12 / #F-2: loading state del PDF compartido entre modal éxito y grilla.
  // Extraído al hook useLoadingAction — el patrón se reutiliza para cualquier
  // acción async con anti-click-spam.
  const { loading: pdfLoading, run: withPdfLoading } = useLoadingAction();

  // Modales
  const [showVenta, setShowVenta] = useState(false);
  // 2026-07-12 (auditoría TOTAL Financiero P1-1, Pattern G):
  // Idempotency-Key generado UNA VEZ por sesión del modal. Doble-click,
  // retry por error transient, o dos submits accidentales del mismo modal
  // usan el MISMO UUID → backend devuelve la venta original sin duplicar
  // stock/cajas/tarjetas/email. El useEffect abajo regenera el UUID cada
  // vez que se abre el modal para NUEVA venta (no en edit — el UPDATE
  // /ventas/:id no usa Idempotency-Key). Solo aplica al flow POST.
  const [idempotencyKey, setIdempotencyKey] = useState(null);
  const [showRapida, setShowRapida] = useState(false);
  const [showGarantias, setShowGarantias] = useState(false);
  const [showEtiquetas, setShowEtiquetas] = useState(false);
  const [nuevaEtiqueta, setNuevaEtiqueta] = useState('');
  // 2026-07-01: modal de administración del catálogo de vendedores.
  // Antes vivía en el tab "Vendedores" de Transferencias, pero se consume
  // desde el dropdown de "Nueva venta" en esta pantalla — moverlo acá
  // resuelve el mismatch conceptual reportado por cliente Uruguay.
  const [showVendedoresModal, setShowVendedoresModal] = useState(false);
  const [showComprob, setShowComprob] = useState(null); // venta id
  const [comprobList, setComprobList] = useState([]);
  // useModal — auditoría 2026-06-06 UX B2 + 2026-06-30 F-10:
  // Esc cierra los modales, focus trap, body scroll lock.
  // Aplicado a los 5 modales del módulo: venta nueva, venta rápida,
  // garantías, etiquetas (F-10) y ver comprobantes (F-10).
  const ventaModalRef = useRef(null);
  const rapidaModalRef = useRef(null);
  const garantiasModalRef = useRef(null);
  const etiquetasModalRef = useRef(null);
  const comprobModalRef = useRef(null);
  useModal({ open: showVenta, onClose: () => setShowVenta(false), overlayRef: ventaModalRef });
  useModal({ open: showRapida, onClose: () => setShowRapida(false), overlayRef: rapidaModalRef });
  useModal({ open: showGarantias, onClose: () => setShowGarantias(false), overlayRef: garantiasModalRef });
  useModal({ open: showEtiquetas, onClose: () => setShowEtiquetas(false), overlayRef: etiquetasModalRef });
  useModal({ open: showComprob != null, onClose: () => setShowComprob(null), overlayRef: comprobModalRef });

  // ── Carga ──
  const loadDash = useCallback(async () => {
    try { setDash(await ventas.dashboard({ desde, hasta })); } catch (_) {}
  }, [desde, hasta]);

  const loadLista = useCallback(async () => {
    setLoading(true);
    try {
      const params = { desde, hasta, limit: 200 };
      if (estadoFilter) params.estado = estadoFilter;
      if (dSearch.trim()) params.buscar = dSearch.trim();
      const res = await ventas.list(params);
      setLista(res.data || []);
    } catch (e) { toast.error(e.message); } finally { setLoading(false); }
  }, [desde, hasta, estadoFilter, dSearch, toast]);

  const loadRapidas = useCallback(async () => {
    try { setRapidas(await ventas.rapidas({ estado: 'pendiente' })); } catch (_) { setRapidas([]); }
  }, []);

  const loadCatalogos = useCallback(async () => {
    const safe = (p) => p.then(r => r).catch(() => []);
    // `configApi.get()` falla con array vacío → defensivo: si no es un objeto
    // con pct_financiera, lo tratamos como 0 y el preview de ganancia real
    // simplemente no descuenta Financiera (igual que pre-Tema C).
    const safeCfg = (p) => p.then(r => r).catch(() => ({}));
    const [v, e, m, g, cc, ct, cls, cfg] = await Promise.all([
      safe(vendedoresApi.list()), safe(ventas.etiquetas()), safe(ventas.metodosPago()), safe(ventas.garantias()), safe(cuentasApi.clientes()), safe(contactosApi.list()),
      safe(inventario.clases()), // clases_producto para el picker del canje (F3 real)
      safeCfg(configApi.get()),  // pct_financiera para el preview Tema C
    ]);
    // Los endpoints paginados devuelven { data, pagination }. Usamos un
    // unwrap defensivo: si vino array (endpoint no-paginado o vacío), tomar
    // tal cual; si vino objeto con .data, extraerlo.
    const unwrap = (r) => Array.isArray(r) ? r : (r?.data ?? []);
    const ccArr = unwrap(cc);
    const ctArr = unwrap(ct); // post-audit: contactos ahora paginado
    setVendedores(v); setEtiquetas(e); setMetodos(m); setGarantias(g); setClientesCC(ccArr); setContactos(ctArr);
    // Filtramos: solo activas y no "Sin categoría" (esa es fallback interno del
    // import XLSX, no una opción real para el operador).
    setClasesInv(unwrap(cls).filter(c => c.activa && !c.es_sin_categoria));
    setPctFinanciera(Number(cfg?.pct_financiera) || 0);
  }, []);

  useEffect(() => { loadCatalogos(); }, [loadCatalogos]);
  useEffect(() => { loadDash(); loadLista(); loadRapidas(); }, [loadDash, loadLista, loadRapidas]);

  function setPeriodoRange(p) {
    // Auditoría 2026-06-30 F-07: batch periodo + desde + hasta en un solo
    // setSearchParams (sin esto serían 3 navegaciones consecutivas y la URL
    // quedaba inconsistente entre ticks).
    const today = todayStr();
    let nd = desde, nh = hasta;
    if (p === 'hoy') { nd = today; nh = today; }
    else if (p === 'ayer') { const y = shiftDate(today, -1); nd = y; nh = y; }
    else if (p === 'semana') { nd = weekStart(); nh = today; }
    else if (p === 'mes') { nd = monthStart(); nh = today; }
    // 'custom' → el usuario edita los date inputs
    setParams([
      { key: 'periodo', value: p, def: 'hoy' },
      { key: 'desde', value: nd, def: today },
      { key: 'hasta', value: nh, def: today },
    ]);
  }

  // ── Nueva venta ──
  const [vForm, setVForm] = useState(EMPTY_VENTA);
  const [cart, setCart] = useState([]);
  const [pagos, setPagos] = useState([]);
  const [comprobantes, setComprobantes] = useState([]);
  // OCR del primer comprobante adjunto: se dispara automáticamente en
  // onComprobFiles y el operador acepta la sugerencia con un click. Mismo
  // endpoint (/api/ocr) que el módulo Financiera; backend usa Claude Haiku.
  // Estados: 'idle' | 'pending' | 'done' | 'error'.
  const [ocrSugerencia, setOcrSugerencia] = useState({ status: 'idle', monto: null });
  const [procRapidaId, setProcRapidaId] = useState(null);
  const [editId, setEditId] = useState(null);
  const [savingVenta, setSavingVenta] = useState(false);
  const [ventaError, setVentaError] = useState('');
  const [prodSearch, setProdSearch] = useState('');
  const [prodResults, setProdResults] = useState([]);
  const prodTimer = useRef(null);
  const prodReq = useRef(0); // token "última request gana" (evita que una respuesta lenta pise a una nueva)
  const setVF = (k, v) => setVForm(f => ({ ...f, [k]: v }));

  // 2026-07-05 TANDA 1 sub-fase C follow-up: wrapeamos los 7 handlers que
  // pasamos a <VentasList> con useCallback para que React.memo(VentaRow)
  // efectivamente skipee re-renders. Sin esto, cada render del padre creaba
  // funciones nuevas y el memo bail-outeaba. Deps confirmadas: setters son
  // estables, navigate/newItemId también, EMPTY_VENTA y garantiaFallback son
  // module scope. openEdit sólo depende de navigate.
  const openEdit = useCallback((v) => {
    // 2026-06-09: si la fila es una venta B2B (origen='b2b'), no podemos
    // editarla con el modal de retail (estructura distinta). La grilla
    // unificada redirige al cliente B2B para que la edite desde su pantalla
    // dedicada. CuentasCC ya tiene el flow de editar movimientos.
    if (v.origen === 'b2b' && v.cliente_cc_id) {
      navigate(`/cuentas?cliente=${v.cliente_cc_id}`);
      return;
    }
    setEditId(v.id); setProcRapidaId(null); setComprobantes([]); setOcrSugerencia({ status: 'idle', monto: null }); setVentaError(''); setProdSearch(''); setProdResults([]);
    setVForm({
      ...EMPTY_VENTA,
      fecha: (v.fecha || '').substring(0, 10), hora: v.hora ? v.hora.substring(0, 5) : '',
      cliente_nombre: v.cliente_nombre || '', cliente_id: v.cliente_id || '', cliente_cc_id: v.cliente_cc_id || '', etiqueta_id: v.etiqueta_id || '', garantia_id: v.garantia_id || '',
      vendedor_id: (v.items.find(i => i.vendedor_id) || {}).vendedor_id || '', comision: v.items[0]?.comision || '',
      tc_venta: v.tc_venta || '', estado: v.estado, notas: v.notas || '',
      // Junio 2026: canjes existentes vienen del backend con descripcion + imei + gb + color +
      // bateria + valor_toma + moneda + producto_id. Reconstruimos el form con esos campos +
      // defaults para los nuevos (categoria/condicion/precio_venta_sugerido/observaciones) —
      // edición de canjes existentes no permite cambiar campos que ya viajaron a Inventario.
      canjes: (v.canjes || []).map(c => ({
        _id: newItemId(),
        descripcion: c.descripcion || '',
        imei: c.imei || '', gb: c.gb || '', color: c.color || '', bateria: c.bateria ?? '',
        valor_toma: c.valor_toma || '', moneda: c.moneda || 'USD',
        agregar_stock: !!c.producto_id, // si ya tiene producto_id, está en Inventario
        clase_id: '', condicion: 'usado',
        precio_venta_sugerido: '', observaciones: '',
        _existing: true, // flag: este canje ya existe en DB, no se re-crea producto
        // 2026-07-11: `producto_id` viene del backend (canjes.producto_id) — lo
        // preservamos para el PUT y el backend actualiza el producto en vez
        // de crear uno nuevo. Bug Lucas: no se podía editar la categoría del
        // producto asociado a un canje.
        producto_id: c.producto_id || null,
      })),
      // 2026-07-13 (feature vuelto): populate desde la venta persistida.
      vuelto_monto:   v.vuelto_monto != null ? String(v.vuelto_monto) : '',
      vuelto_moneda:  v.vuelto_moneda || 'ARS',
      vuelto_caja_id: v.vuelto_caja_id || '',
      // 2026-07-14: TC del vuelto (populate para edición).
      vuelto_tc:      v.vuelto_tc != null ? String(v.vuelto_tc) : '',
    });
    setCart((v.items || []).map(it => ({ _id: newItemId(), producto_id: it.producto_id, descripcion: it.descripcion, imei: it.imei || '', cantidad: it.cantidad, precio_vendido: Number(it.precio_vendido), costo: Number(it.costo), moneda: it.moneda })));
    setPagos((v.pagos || []).map(p => ({
      _id: newItemId(),
      metodo_pago_id: p.metodo_pago_id ?? null, metodo_nombre: p.metodo_nombre,
      monto: Number(p.monto), moneda: p.moneda, tc: p.tc || '',
      es_cuenta_corriente: !!p.es_cuenta_corriente,
      // rev5: usd_input es el valor primario; al cargar venta existente lo
      // derivamos de monto (bruto) descontando la comisión. Se popula completo
      // recién cuando los metodos están cargados — si la edición abre antes,
      // queda '' y el USD se muestra calculado por el componente.
      usd_input: '', neto_input: '',
    })));
    setShowVenta(true);
  }, [navigate]);

  function openVenta(rapida) {
    setVForm({ ...EMPTY_VENTA, fecha: todayStr() });
    setCart([]); setPagos([]); setComprobantes([]); setOcrSugerencia({ status: 'idle', monto: null }); setVentaError(''); setProdSearch(''); setProdResults([]);
    setProcRapidaId(null); setEditId(null);
    if (rapida) {
      setProcRapidaId(rapida.id);
      setVForm(f => ({ ...f, cliente_nombre: rapida.cliente_texto || '', notas: rapida.detalle || '' }));
      const vend = vendedores.find(v => v.nombre.toLowerCase() === (rapida.vendedor_nombre || '').toLowerCase());
      if (vend) setVForm(f => ({ ...f, vendedor_id: vend.id }));
      setCart([{ _id: newItemId(), producto_id: null, descripcion: '', imei: '', cantidad: 1, precio_vendido: 0, costo: 0, moneda: 'USD' }]);
    }
    setShowVenta(true);
  }

  useEffect(() => {
    setPrimaryAction({ label: 'Nueva venta', onClick: () => openVenta(null) });
    return () => setPrimaryAction(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPrimaryAction, vendedores]);

  // 2026-07-15 (task #134/#135): deep-link `?open=<venta_id>` desde Cmd+K.
  // Cuando el usuario clickea un resultado de "Ventas" en la búsqueda global,
  // el CommandPalette navega a /ventas?open=<id>. Este effect fetchea esa
  // venta específica (usando el filtro `id` del backend, que ignora fechas)
  // y abre el modal de edición directamente.
  //
  // #135 fix (2026-07-15 v2): deps era `[]` — corría solo al mount. Si el
  // usuario ya está en /ventas y hace Cmd+K a otra venta, React Router
  // actualiza searchParams SIN remontar → el effect no volvía a disparar
  // y el user quedaba mirando el dashboard sin modal. Ahora dep = [openId]
  // con guard `lastOpenedRef` para deduplicar (evita re-abrir al mismo id
  // después de limpiar el param).
  const lastOpenedRef = useRef(null);
  const openIdParam = searchParams.get('open');
  useEffect(() => {
    if (!openIdParam) return;
    if (lastOpenedRef.current === openIdParam) return;
    lastOpenedRef.current = openIdParam;
    (async () => {
      try {
        const res = await ventas.list({ id: openIdParam, limit: 1 });
        const v = (res?.data || [])[0];
        if (v) {
          openEdit(v);
        } else {
          // No la encontramos (borrada o id inválido) — mostramos toast y
          // dejamos al user en el dashboard. No forzamos error banner.
          toast.error?.('No pudimos abrir esa venta (¿fue eliminada?).');
        }
      } catch (err) {
        toast.error?.(err?.message || 'No pudimos abrir la venta.');
      } finally {
        // Limpiamos el param con callback pattern para evitar stale closure
        // sobre searchParams (importante en el async: entre el await y este
        // finally, searchParams del closure puede estar desactualizado si
        // el user cambió otros filtros).
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete('open');
          return next;
        }, { replace: true });
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIdParam]);

  // Pattern G — regenerar Idempotency-Key cada vez que se abre el modal para
  // una NUEVA venta. En modo edit no aplica (PUT /ventas/:id no usa el key).
  // El key se persiste durante la vida del modal para que doble-click/retry
  // usen el MISMO UUID.
  useEffect(() => {
    if (showVenta && !editId) {
      setIdempotencyKey(crypto.randomUUID());
    }
  }, [showVenta, editId]);

  function searchProducto(q) {
    setProdSearch(q);
    clearTimeout(prodTimer.current);
    if (q.trim().length < 2) { setProdResults([]); return; }
    const reqId = ++prodReq.current;
    prodTimer.current = setTimeout(async () => {
      try {
        const res = await inventario.productos({ solo_stock: 'true', limit: 8, buscar: q.trim() });
        if (reqId === prodReq.current) setProdResults(res.data || []);
      } catch (_) { if (reqId === prodReq.current) setProdResults([]); }
    }, 300);
  }
  function addProd(p) {
    setCart(c => [...c, {
      _id: newItemId(),
      producto_id: p.id,
      descripcion: [p.nombre, p.color, p.gb ? p.gb + 'GB' : ''].filter(Boolean).join(' '),
      // 2026-07-04: fmtImei normaliza notación científica (p.ej. "3.5E14" → "350000000000000")
      // heredada de imports XLSX viejos, para que la venta quede persistida limpia.
      imei: fmtImei(p.imei), cantidad: 1, precio_vendido: Number(p.precio_venta) || 0, costo: Number(p.costo) || 0, moneda: p.precio_moneda || 'USD',
      // 2026-07-07 (Lucas #525): preservamos `bateria` y `condicion` en el
      // item para renderizar la chip "IMEI · Bat X%" debajo de la descripción
      // — sin eso, dos iPhones usados con la misma descripción son
      // indistinguibles en la grilla del cart. Estos campos NO viajan al
      // backend: handleSaveVenta filtra explícitamente el shape del item, por
      // lo que agregarlos no altera el payload del POST /ventas.
      bateria: p.bateria, condicion: p.condicion,
    }]);
    setProdSearch(''); setProdResults([]);
  }
  // Auditoría 2026-06-30 F-13/14: cart, pagos y canjes usan _id estable como
  // React key. setItem/rmItem operan por id (no por índice) — quitar un ítem
  // del medio no afecta el draft de los inputs de los siguientes.
  const addItemManual = () => setCart(c => [...c, { _id: newItemId(), producto_id: null, descripcion: '', imei: '', cantidad: 1, precio_vendido: 0, costo: 0, moneda: 'USD' }]);
  const setItem = (id, k, v) => setCart(c => c.map(it => it._id === id ? { ...it, [k]: (k === 'cantidad' || k === 'precio_vendido' || k === 'costo') ? (v === '' ? '' : Number(v)) : v } : it));
  const rmItem = (id) => setCart(c => c.filter(it => it._id !== id));

  // Tema C en-vivo rev5 (2026-06-14): nuevo modelo de pago — el operador
  // tipea USD (su mental model), el sistema arma el bruto ARS según el
  // método elegido. Cada pago tiene:
  //   · usd_input  — valor "primario" tipeado por el operador
  //   · neto_input — opcional, si edita "Entra a tu caja" directamente
  //                  (caso "cliente ya transfirió $X")
  //   · monto      — bruto en moneda (SOURCE OF TRUTH para el backend)
  //   · moneda, tc — derivados del método (excepto CC)
  // Cuando cambia usd_input/tc/método, monto se recalcula con la fórmula
  // bruto = usd × tc / (1 − pct/100). El backend recibe monto como siempre,
  // sin cambios server-side.
  const addPago = () => setPagos(p => [...p, {
    _id: newItemId(),
    // Default a la moneda local del tenant (ARS en AR, UYU en UY). Cuando
    // el operador elige método, `handleMetodoChange` lo reemplaza con
    // `m.moneda`. Este default es el estado transitorio entre "click en
    // + Pago" y "elige método" — usarlo hardcoded en ARS provocaba que si
    // el operador olvidaba elegir método (edge case), el pago quedaba en
    // ARS aunque el tenant fuera UY. Fix #4 audit 2026-07-07.
    metodo_pago_id: null, metodo_nombre: '', monto: '', moneda: monedaLocal, tc: '',
    usd_input: '', neto_input: '', es_cuenta_corriente: false,
  }]);
  // Auditoría 2026-06-30 F-13/14: setPago/rmPago aceptan _id estable. Los
  // handlers internos (setPagoUsd, setPagoMetodo, etc.) siguen operando por
  // índice porque dependen de prevPagos[i] para fórmulas multi-pago — el
  // call-site del JSX usa el _id de la fila y lo resolvemos a índice acá.
  const setPago = (id, k, v) => setPagos(p => p.map(pg => pg._id === id ? { ...pg, [k]: v } : pg));
  const rmPago = (id) => setPagos(p => p.filter(pg => pg._id !== id));

  // Helpers de fórmula (rev5)
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
    // 2026-06-29 Multi-país F3: ARS y UYU usan el mismo cálculo USD×TC (el TC
    // viene del país correcto vía configApi.lastTc()). Antes era ARS-only,
    // sesgo AR pre-multi-país.
    if ((moneda === 'ARS' || moneda === 'UYU') && t > 0) return Math.round(u * t * factor * 100) / 100;
    return '';
  }
  function brutoFromNetoInput(neto, pct) {
    const n = Number(neto) || 0;
    if (n <= 0) return '';
    return Math.round(n / (1 - pct / 100) * 100) / 100;
  }
  // 2026-07-04: inversa de brutoFromUsdInput. Dado el bruto que el operador
  // tipea en "Le cobrás al cliente" (moneda nativa del pago), devolver el USD
  // equivalente para mostrarlo en el input USD y mantener consistencia visual
  // interna. La comisión sigue aplicándose sobre el bruto manual (mismo modelo
  // contable). Retorna '' si no se puede computar (bruto=0 o TC faltante).
  function usdFromBrutoInput(bruto, moneda, tc, pct) {
    const b = Number(bruto) || 0;
    if (b <= 0) return '';
    const factor = pct > 0 ? 1 / (1 - pct / 100) : 1;
    const netoEquivalente = b / factor;   // bruto sin comisión
    if (moneda === 'USD' || moneda === 'USDT') return Math.round(netoEquivalente * 100) / 100;
    const t = Number(tc);
    if ((moneda === 'ARS' || moneda === 'UYU') && t > 0) {
      return Math.round(netoEquivalente / t * 100) / 100;
    }
    return '';
  }
  // Faltante USD = total venta − otros pagos − canjes. Usado para auto-llenar
  // el USD al elegir un método nuevo (si el operador no había tipeado nada).
  function faltanteUsd(indexExcluir, prevPagos) {
    const tc = Number(vForm.tc_venta) || null;
    let totalUsd = 0;
    cart.forEach(it => {
      const qty = Number(it.cantidad) || 0;
      const precio = Number(it.precio_vendido) || 0;
      totalUsd += toUsd(precio * qty, it.moneda, tc);
    });
    if (totalUsd <= 0) return 0;
    let otrosUsd = 0;
    prevPagos.forEach((pg, k) => {
      if (k === indexExcluir) return;
      otrosUsd += toUsd(pg.monto, pg.moneda, pg.tc || tc);
    });
    const canjeUsd = (vForm.canjes || []).reduce((acc, c) => acc + (Number(c.valor_toma) || 0), 0);
    return Math.max(0, totalUsd - otrosUsd - canjeUsd);
  }

  // Setter para el input USD (lo que el operador tipea).
  // 2026-07-04: al editar USD se pierde el override manual del bruto
  // (bruto_manual=false) — el vendedor "vuelve" al modo calculado por fórmula.
  function setPagoUsd(i, value) {
    setPagos(p => p.map((pg, j) => {
      if (j !== i) return pg;
      const m = metodos.find(x => x.id === pg.metodo_pago_id);
      const pct = pctMetodo(m);
      const tc = pg.tc || vForm.tc_venta;
      const bruto = brutoFromUsdInput(value, pg.moneda, tc, pct);
      return { ...pg, usd_input: value, neto_input: '', bruto_manual: false, monto: bruto !== '' ? String(bruto) : '' };
    }));
  }
  // 2026-07-04: setter para el input "Le cobrás al cliente" (bruto en moneda
  // nativa). Único caso donde el bruto no se deriva de USD × TC × factor sino
  // que es directamente lo que el operador tipea. Recalcula USD y limpia neto
  // para que se muestre el neto derivado del bruto manual. bruto_manual=true
  // dispara el badge "Manual" en el render.
  function setPagoBruto(i, value) {
    setPagos(p => p.map((pg, j) => {
      if (j !== i) return pg;
      const m = metodos.find(x => x.id === pg.metodo_pago_id);
      const pct = pctMetodo(m);
      const tc = pg.tc || vForm.tc_venta;
      const usdDerivado = usdFromBrutoInput(value, pg.moneda, tc, pct);
      return {
        ...pg,
        monto: value,
        usd_input: usdDerivado !== '' ? String(usdDerivado) : '',
        neto_input: '',
        bruto_manual: true,
      };
    }));
  }
  // Setter para el input Neto (caso "cliente ya transfirió X").
  function setPagoNeto(i, value) {
    setPagos(p => p.map((pg, j) => {
      if (j !== i) return pg;
      const m = metodos.find(x => x.id === pg.metodo_pago_id);
      const pct = pctMetodo(m);
      const bruto = brutoFromNetoInput(value, pct);
      // El usd_input ahora deja de ser autoritativo; lo derivamos del neto.
      const tc = Number(pg.tc) || Number(vForm.tc_venta) || null;
      let usd = '';
      const n = Number(value) || 0;
      if (n > 0) {
        // 2026-06-29 Multi-país F3: ARS o UYU se convierten dividiendo por TC.
        if ((pg.moneda === 'ARS' || pg.moneda === 'UYU') && tc > 0) usd = Math.round(n / tc * 100) / 100;
        else                                usd = n;
      }
      return { ...pg, usd_input: usd !== '' ? String(usd) : '', neto_input: value, monto: bruto !== '' ? String(bruto) : '' };
    }));
  }
  // Setter del TC (recalcula el bruto desde el USD tipeado).
  // 2026-07-04: al editar TC se pierde el override manual (misma política
  // que setPagoUsd — cualquier cambio en input primario descarta el manual).
  //
  // 2026-07-07 FIX (feedback Lucas): si el operador tipeó MONTO primero y
  // TC después (flow común efectivo ARS/UYU), preservar el monto y calcular
  // el USD equivalente hacia atrás. Antes borrábamos el monto porque
  // `brutoFromUsdInput('', ...)` retorna '' cuando usd_input está vacío —
  // el operador tenía que re-tipear el monto.
  function setPagoTc(i, value) {
    setPagos(p => p.map((pg, j) => {
      if (j !== i) return pg;
      const m = metodos.find(x => x.id === pg.metodo_pago_id);
      const pct = pctMetodo(m);
      const hayUsdInput = pg.usd_input && Number(pg.usd_input) > 0;
      const hayMonto    = pg.monto && Number(pg.monto) > 0;
      if (hayUsdInput) {
        // Flow "cliente paga USD X" → recalcula el bruto en moneda del pago.
        const bruto = brutoFromUsdInput(pg.usd_input, pg.moneda, value, pct);
        return { ...pg, tc: value, neto_input: '', bruto_manual: false, monto: bruto !== '' ? String(bruto) : '' };
      }
      if (hayMonto) {
        // Flow "cliente paga $X directo" → preservar monto, derivar USD
        // desde el monto ahora que tenemos TC. El USD queda como fuente de
        // verdad para el cálculo del total cubierto.
        const usdDerivado = usdFromBrutoInput(pg.monto, pg.moneda, value, pct);
        return {
          ...pg,
          tc: value,
          neto_input: '',
          bruto_manual: false,
          // NO tocamos monto — respetamos lo que tipeó el operador.
          usd_input: usdDerivado !== '' ? String(usdDerivado) : pg.usd_input,
        };
      }
      // Ni monto ni usd_input tipeados — solo actualizamos el TC.
      return { ...pg, tc: value, neto_input: '', bruto_manual: false };
    }));
  }
  // Setter directo en moneda nativa para EFECTIVO ARS (sin comisión). El operador
  // a veces piensa "cliente me dio $X en efectivo" — más natural que pensar en USD.
  // El TC sigue siendo necesario para que el total cubierto se calcule en USD.
  function setPagoArsAmount(i, value) {
    setPagos(p => p.map((pg, j) => j === i ? {
      ...pg, monto: value, usd_input: '', neto_input: '',
    } : pg));
  }
  function setPagoMetodo(i, value) {
    if (value === '__CC__') {
      setPagos(p => p.map((pg, j) => j === i ? {
        ...pg, metodo_pago_id: null, metodo_nombre: 'Cuenta corriente',
        es_cuenta_corriente: true, moneda: pg.moneda || 'USD',
      } : pg));
      return;
    }
    const m = metodos.find(x => x.nombre === value);
    setPagos(p => {
      const newMoneda = m ? m.moneda : null;
      const pct = pctMetodo(m);
      // Caso EFECTIVO en moneda local (sin comisión): el operador trabaja
      // en ARS o UYU directo. Autollenar el monto = faltante_usd × tc, NO
      // calcular USD intermedio.
      // 2026-06-29 Multi-país F3: acepta ARS o UYU (la moneda del método
      // viene de la DB, que en tenant UY van a ser métodos UYU-default).
      const arsDirect = pct === 0 && (newMoneda === 'ARS' || newMoneda === 'UYU');
      return p.map((pg, j) => {
        if (j !== i) return pg;
        const tcUse = pg.tc || vForm.tc_venta;
        if (arsDirect) {
          // Si ya había monto y el operador no quiere perderlo, preservar; sino auto-llenar.
          let monto = pg.monto;
          if (!monto || Number(monto) <= 0) {
            const falt = faltanteUsd(i, p);
            const tcN = Number(tcUse);
            if (falt > 0 && tcN > 0) monto = String(Math.round(falt * tcN * 100) / 100);
          }
          return {
            ...pg,
            metodo_pago_id: m ? m.id : null,
            metodo_nombre: value,
            es_cuenta_corriente: false,
            // Mantener la moneda del método (ARS o UYU) — no la forzamos a ARS.
            moneda: newMoneda,
            usd_input: '', neto_input: '', bruto_manual: false,
            monto: monto || '',
          };
        }
        // Resto de los métodos: input en USD (rev5 flow original).
        let usd = pg.usd_input;
        if (!usd || Number(usd) <= 0) {
          const falt = faltanteUsd(i, p);
          if (falt > 0) usd = String(Math.round(falt * 100) / 100);
        }
        const bruto = brutoFromUsdInput(usd, newMoneda || pg.moneda, tcUse, pct);
        return {
          ...pg,
          metodo_pago_id: m ? m.id : null,
          metodo_nombre: value,
          es_cuenta_corriente: false,
          moneda: newMoneda || pg.moneda,
          usd_input: usd,
          neto_input: '',
          bruto_manual: false,
          monto: bruto !== '' ? String(bruto) : '',
        };
      });
    });
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
        // OCR del primer archivo. Si el operador adjuntó múltiples, solo
        // procesamos el primero — caso común es UN comprobante por venta.
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
  // Aplica el monto detectado por OCR al pago Financiera (o al primer pago
  // no-CC si no hay Financiera). Va al "Entra a tu caja" (neto_input) —
  // ese es el campo editable de Tema C que representa "lo que el cliente
  // ya transfirió". El setPagoNeto recalcula el bruto al revés.
  function aplicarOcrMonto() {
    if (ocrSugerencia.status !== 'done' || !ocrSugerencia.monto) return;
    const finCaja = metodos.find(m => m.es_financiera);
    let idx = -1;
    if (finCaja) idx = pagos.findIndex(p => p.metodo_pago_id === finCaja.id);
    if (idx < 0) idx = pagos.findIndex(p => !p.es_cuenta_corriente && p.metodo_pago_id);
    if (idx < 0) { toast.error('Agregá un método de pago antes de aplicar el monto.'); return; }
    setPagoNeto(idx, String(ocrSugerencia.monto));
    setOcrSugerencia({ status: 'idle', monto: null });
  }

  // 2026-07-04 auditoría TANDA 0: lógica extraída a `computeVentaTotales` en
  // ventas/utils.js para poder testearla como unidad pura (ver utils.test.js).
  // El cambio de criterio bruto-vs-neto para el "Cubierto ✓" (#506) vive dentro
  // del helper; ver comment allí. El useMemo acá es solo el wire-up + deps.
  //
  // 2026-07-14 (bug reportado por Lucas): pasamos el vuelto al helper para que
  // se descuente de `real`. Antes el preview mentía sobre la rentabilidad
  // cuando había vuelto (típicamente ARS/UYU sobre venta USD).
  const vueltoPreview = useMemo(() => {
    const monto = Number(vForm.vuelto_monto);
    if (!vForm.vuelto_monto || monto <= 0) return null;
    return {
      monto,
      moneda: vForm.vuelto_moneda,
      tc:     vForm.vuelto_tc ? Number(vForm.vuelto_tc) : null,
    };
  }, [vForm.vuelto_monto, vForm.vuelto_moneda, vForm.vuelto_tc]);
  const totales = useMemo(
    () => computeVentaTotales(cart, pagos, vForm.canjes, metodos, pctFinanciera, vForm.tc_venta, vueltoPreview),
    [cart, pagos, vForm.tc_venta, vForm.canjes, metodos, pctFinanciera, vueltoPreview]
  );

  // ── Helpers para manipular el array de canjes (junio 2026) ─────────────
  // Auditoría 2026-06-30 F-13/14: _id estable por canje + rmCanje/setCanje
  // por id. Mismo motivo que cart/pagos: quitar el canje del medio no debe
  // pisar el draft del input del siguiente canje.
  const addCanje = () => setVForm(f => ({ ...f, canjes: [...(f.canjes || []), { ...EMPTY_CANJE, _id: newItemId() }] }));
  const rmCanje = (id) => setVForm(f => ({ ...f, canjes: (f.canjes || []).filter(c => c._id !== id) }));
  const setCanje = (id, k, v) => setVForm(f => ({
    ...f,
    canjes: (f.canjes || []).map(c => c._id === id ? { ...c, [k]: v } : c),
  }));

  async function handleSaveVenta(e) {
    e.preventDefault();
    setVentaError('');
    const items = cart.filter(it => String(it.descripcion).trim()).map((it, idx) => ({
      producto_id: it.producto_id || null,
      vendedor_id: vForm.vendedor_id || null,
      descripcion: String(it.descripcion).trim(),
      imei: it.imei ? String(it.imei).trim() : null,
      cantidad: Number(it.cantidad) || 1,
      precio_vendido: Number(it.precio_vendido) || 0,
      costo: Number(it.costo) || 0,
      moneda: it.moneda || 'USD',
      comision: idx === 0 ? (Number(vForm.comision) || 0) : 0,
    }));
    if (!items.length) { setVentaError('Agregá al menos un producto con descripción.'); return; }
    const pagosPayload = pagos.filter(p => p.metodo_nombre && (Number(p.monto) || 0) > 0).map(p => ({
      metodo_pago_id: p.metodo_pago_id ?? null,
      metodo_nombre: p.metodo_nombre, monto: Number(p.monto) || 0, moneda: p.moneda, tc: p.tc ? Number(p.tc) : null,
      es_cuenta_corriente: !!p.es_cuenta_corriente,
    }));
    // Caja Financiera: si un pago la usa, exigir el comprobante (en alta) para que
    // se auto-genere el comprobante de Financiera y no haya doble carga.
    const finCaja = metodos.find(m => m.es_financiera);
    const usaFinanciera = !!finCaja && pagosPayload.some(p => p.metodo_pago_id === finCaja.id);
    if (!editId && usaFinanciera && comprobantes.length === 0) {
      setVentaError('Esta venta se cobra por la Financiera: adjuntá el comprobante antes de guardar.');
      return;
    }
    // Junio 2026: array de canjes (puede ser N, ya no 1 fijo). Cada canje se
    // sanitiza individualmente y se ignora cualquiera sin descripción ni valor.
    // Los _existing (canjes que vienen de la DB en edit) se mandan con sus
    // campos básicos pero NO con los nuevos (categoria/condicion/etc) porque
    // edit no re-crea el producto en Inventario.
    const canjes = (vForm.canjes || [])
      .filter(c => String(c.descripcion || '').trim() || Number(c.valor_toma) > 0)
      .map(c => {
        const base = {
          descripcion: String(c.descripcion || 'Canje').trim(),
          imei: c.imei ? String(c.imei).trim() : null,
          gb: c.gb ? String(c.gb).trim() : null,
          color: c.color ? String(c.color).trim() : null,
          bateria: c.bateria === '' || c.bateria == null ? null : Number(c.bateria),
          valor_toma: Number(c.valor_toma) || 0,
          moneda: c.moneda || 'USD',
          agregar_stock: !!c.agregar_stock,
        };
        // Solo enviamos los campos extra si va a Inventario (sino no aportan nada).
        // 2026-07-11: `categoria_id` (Colección legacy) → `clase_id` (categoría
        // real F3, UUID). El backend valida que exista + pertenezca al tenant;
        // si no viene, deriva por condición como fallback (celular_sellado/usado).
        //
        // 2026-07-11 bug Lucas: si el canje ya está en Inventario (`_existing`),
        // enviamos `producto_id` para que el backend UPDATE el producto asociado
        // en vez de intentar crear uno nuevo (que fallaría con IMEI dup). Los
        // campos clase_id/condicion/precio_venta_sugerido/observaciones que
        // vengan editados se aplicarán al producto.
        if (c.agregar_stock) {
          if (c.clase_id)              base.clase_id              = String(c.clase_id);
          if (c.condicion)             base.condicion             = c.condicion;
          if (c.precio_venta_sugerido) base.precio_venta_sugerido = Number(c.precio_venta_sugerido);
          if (c.observaciones?.trim()) base.observaciones         = c.observaciones.trim();
          if (c.producto_id)           base.producto_id           = Number(c.producto_id);
        }
        return base;
      });

    // Aviso de diferencia: si el total cobrado != total de items (con canje),
    // mostramos un modal visual rico (no el ConfirmModal genérico) con desglose
    // total/cobrado/restante, y dos opciones: "Corregir" (volver al form) o
    // "Aceptar igual" (proceder + inyectar item "Diferencia").
    //
    // El item de diferencia se calcula:
    //   · A favor (cobrado de más):  precio_vendido = +dif, costo = 0
    //     → sube total_usd y ganancia_usd.
    //   · En contra (cobrado de menos): precio_vendido = 0, costo = |dif|
    //     → no toca total_usd pero baja ganancia_usd.
    // (No usamos precio negativo: la DB tiene CHECK precio_vendido >= 0.)
    // Tolerancia 0.005 USD para no marcar errores de redondeo por floats.
    if (Math.abs(totales.dif) > 0.005) {
      // Promesa que el modal resuelve con true (aceptar) o false (corregir).
      const aceptado = await new Promise(resolve => {
        setDiffModal({ open: true, items: totales.items, cubierto: totales.cubierto, dif: totales.dif, resolve });
      });
      if (!aceptado) return;
      const aFavor = totales.dif > 0;
      const dif = Math.abs(totales.dif);
      items.push({
        producto_id:   null,
        vendedor_id:   vForm.vendedor_id || null,
        descripcion:   aFavor ? 'Diferencia de cambio (a favor)' : 'Diferencia de cambio (en contra)',
        imei:          null,
        cantidad:      1,
        precio_vendido: aFavor ? dif : 0,
        costo:         aFavor ? 0 : dif,
        moneda:        'USD',
        comision:      0,
      });
    }

    const payload = {
      fecha: vForm.fecha, hora: vForm.hora || null, cliente_nombre: vForm.cliente_nombre.trim() || null,
      cliente_id: vForm.cliente_id || null, cliente_cc_id: vForm.cliente_cc_id || null,
      etiqueta_id: vForm.etiqueta_id || null, garantia_id: vForm.garantia_id || null,
      estado: vForm.estado, tc_venta: vForm.tc_venta ? Number(vForm.tc_venta) : null,
      notas: vForm.notas.trim() || null, items, pagos: pagosPayload, canjes,
    };
    // 2026-07-13 (feature vuelto): incluir los 3 campos SIEMPRE (todo o nada).
    // Si monto > 0 → mandar los 3 con valor. Si vacío → los 3 en null (backend
    // los borra en el UPDATE del PUT — necesario para "quitar" el vuelto de
    // una venta que lo tenía y se edita para removerlo).
    const vueltoMontoNum = Number(vForm.vuelto_monto);
    if (vForm.vuelto_monto && vueltoMontoNum > 0 && vForm.vuelto_caja_id) {
      payload.vuelto_monto   = vueltoMontoNum;
      payload.vuelto_moneda  = vForm.vuelto_moneda;
      payload.vuelto_caja_id = Number(vForm.vuelto_caja_id);
      // 2026-07-14: TC del vuelto. Requerido si moneda ∈ {ARS, UYU} (el schema
      // backend rechaza sino). Para USD/USDT mandamos null explícito (el TC no
      // aplica — 1 unidad = 1 USD).
      const esLocal = vForm.vuelto_moneda === 'ARS' || vForm.vuelto_moneda === 'UYU';
      payload.vuelto_tc = esLocal && vForm.vuelto_tc ? Number(vForm.vuelto_tc) : null;
    } else if (editId) {
      // En edición, si el operador vació el vuelto, hay que persistir NULL
      // (sino el backend hace COALESCE y el vuelto viejo persiste).
      payload.vuelto_monto = null;
      payload.vuelto_moneda = null;
      payload.vuelto_caja_id = null;
      payload.vuelto_tc = null;
    }
    // #475 — pasar opt-in del comprobante por email solo en alta (no en edición).
    // El backend acepta ambos campos como opcionales en createVentaSchema; el
    // schema de update no los acepta (es propio del alta — para reenviar desde
    // edición se usa el endpoint dedicado /:id/enviar-comprobante).
    if (!editId && vForm.enviar_comprobante_email && vForm.cliente_email) {
      payload.enviar_comprobante_email = true;
      payload.cliente_email = vForm.cliente_email.trim().toLowerCase();
    }
    setSavingVenta(true);
    try {
      // Pattern G: pasamos idempotencyKey solo en el flow POST (create).
      // En edit (PUT /ventas/:id) el key se ignora — no aplica.
      const venta = editId
        ? await ventas.update(editId, payload)
        : await ventas.create(payload, idempotencyKey);
      let uploadFalló = false;
      for (const c of comprobantes) {
        try { await ventas.uploadComprobante(venta.id, { archivo_data: c.data, archivo_nombre: c.nombre, archivo_tipo: c.tipo }); }
        catch (e) { uploadFalló = true; console.warn('Error al adjuntar comprobante:', e); }
      }
      if (!editId && procRapidaId) { try { await ventas.updateRapida(procRapidaId, { estado: 'procesada', venta_id: venta.id }); } catch (_) {} }
      // Si el adjunto falló no podemos cantar éxito (y en el flujo financiera el
      // comprobante de Financiera NO se habría auto-generado): avisamos.
      if (uploadFalló) toast.error('La venta se guardó, pero el comprobante no se pudo adjuntar. Subilo de nuevo desde la venta.');
      // #475 — feedback inline si pedimos enviar comprobante por mail. El send
      // es fire-and-forget del backend (setImmediate post-COMMIT), así que no
      // sabemos acá si el send tuvo éxito — el feedback es informativo. El
      // detalle de la venta tiene el historial real (sent/failed).
      if (!editId && payload.enviar_comprobante_email) {
        toast.success(`Enviando comprobante a ${payload.cliente_email}…`);
      }
      setShowVenta(false);
      // Cobro por Financiera con comprobante OK: ya se auto-generó el de Financiera → ir a verificarlo.
      if (!editId && usaFinanciera && !uploadFalló) { navigate('/financiera'); return; }
      await Promise.all([loadDash(), loadLista(), loadRapidas()]);
      // Modal de éxito con opción de descargar comprobante PDF. Reemplaza
      // al toast minimalista — da feedback claro y permite imprimir el
      // comprobante para el cliente sin pasos extra.
      //
      // IMPORTANTE: el endpoint POST/PUT /api/ventas devuelve solo la fila
      // de `ventas`, sin items ni pagos embebidos. Para el PDF reusamos el
      // payload del frontend (con los datos que el usuario acaba de cargar)
      // y los mergeamos sobre la respuesta. monto_usd se calcula con toUsd.
      if (!uploadFalló) {
        const tcVenta = Number(vForm.tc_venta) || null;
        // items: agregamos imei tomado del cart original (cart[i] tiene imei,
        // items no lo lleva al payload). Para mantener orden, indexamos por idx.
        const itemsPdf = items.map((it, idx) => ({
          descripcion:    it.descripcion,
          cantidad:       Number(it.cantidad) || 1,
          precio_vendido: Number(it.precio_vendido) || 0,
          costo:          Number(it.costo) || 0,
          moneda:         it.moneda || 'USD',
          imei:           cart[idx]?.imei || null,
        }));
        const pagosPdf = pagosPayload.map(p => ({
          metodo_nombre: p.metodo_nombre,
          monto:         Number(p.monto) || 0,
          moneda:        p.moneda,
          tc:            p.tc ? Number(p.tc) : null,
          monto_usd:     toUsd(p.monto, p.moneda, p.tc || tcVenta),
          es_cuenta_corriente: !!p.es_cuenta_corriente,
        }));
        // Cliente completo: si está vinculado por id, traemos del state de
        // contactos; sino solo el nombre que tipeó el operador.
        const contactoVinculado = vForm.cliente_id
          ? contactos.find(c => String(c.id) === String(vForm.cliente_id))
          : null;
        const vendedorNombre = vForm.vendedor_id
          ? (vendedores.find(v => String(v.id) === String(vForm.vendedor_id))?.nombre || null)
          : null;
        // Mismo criterio que el botón de imprimir en la grilla: garantía
        // elegida, o la default del catálogo si no se eligió. Si tampoco hay
        // default, queda el fallback hardcoded (GARANTIA_FALLBACK).
        const garantiaSel = vForm.garantia_id
          ? garantias.find(g => String(g.id) === String(vForm.garantia_id))
          : garantias.find(g => g.es_default);
        const ventaCompleta = {
          ...venta,
          total_usd: venta.total_usd != null ? venta.total_usd :
            itemsPdf.reduce((s, it) => s + toUsd(it.precio_vendido * it.cantidad, it.moneda, tcVenta), 0),
          cliente_nombre: venta.cliente_nombre || vForm.cliente_nombre || 'Consumidor final',
          cliente_apellido: contactoVinculado?.apellido || null,
          cliente_dni:      contactoVinculado?.dni      || null,
          cliente_telefono: contactoVinculado?.telefono || null,
          // #475 — preferimos el email cargado en el form (puede ser fresh,
          // de un contacto sin email previo) sobre el del contacto vinculado.
          cliente_email:    vForm.cliente_email?.trim() || contactoVinculado?.email || null,
          vendedor_nombre:  vendedorNombre,
          hora:             venta.hora    || vForm.hora || null,
          fecha:            venta.fecha   || vForm.fecha,
          notas:            venta.notas   || vForm.notas,
          garantia_nombre:  garantiaSel?.nombre || (vForm.garantia_id ? null : 'Predeterminada'),
          garantia_texto:   renderPlantilla(garantiaSel?.texto || GARANTIA_FALLBACK_TEXTO, tenantNombre),
          items:            itemsPdf,
          pagos:            pagosPdf,
        };
        setExitoModal({ open: true, venta: ventaCompleta });
      }
    } catch (err) { setVentaError(err.message); } finally { setSavingVenta(false); }
  }

  const changeEstado = useCallback(async (v, estado) => {
    // 2026-06-10: la grilla unificada acepta cambiar estado a B2B también.
    // Origen 'b2b' → PATCH a /api/cuentas/movimientos/:id/estado.
    // Origen 'retail' → PUT a /api/ventas/:id (legacy, sigue igual).
    try {
      if (v?.origen === 'b2b') {
        await cuentasApi.setEstadoMovimiento(v._b2b_mov_id, estado);
      } else {
        await ventas.update(v?.id ?? v, { estado });
      }
      toast.success('Estado actualizado.');
      await Promise.all([loadLista(), loadDash()]);
    } catch (e) { toast.error(e.message); }
  }, [toast, loadLista, loadDash]);

  // 2026-06-10 — Confirmar entrega de un envío desde la grilla. En el backend
  // pasa el envío a 'Entregado' y la venta asociada de 'pendiente' a
  // 'acreditado' en una sola TX. Sólo se muestra cuando v.envio?.estado no es
  // 'Entregado' ni 'Cancelado'.
  const confirmarEntrega = useCallback(async (v) => {
    if (!v?.envio?.id) return;
    const ok = await confirm({
      title: 'Confirmar entrega',
      message: 'Se marca el envío como entregado y la venta como acreditada en el dashboard.',
      confirmLabel: 'Confirmar entrega',
    });
    if (!ok) return;
    try {
      await enviosApi.confirmarEntrega(v.envio.id);
      toast.success('Entrega confirmada.');
      await Promise.all([loadLista(), loadDash()]);
    } catch (e) { toast.error(e.message); }
  }, [confirm, toast, loadLista, loadDash]);
  const deleteVenta = useCallback(async (v) => {
    // Si la fila es B2B (origen='b2b'), el endpoint correcto es el de
    // movimientos_cc (que cascadea: revierte caja + restaura stock + audit).
    // El _b2b_mov_id lo arrastra el backend desde el listado unificado.
    const esB2B = v.origen === 'b2b';
    const msg = esB2B
      ? 'Se cancelará el movimiento B2B, se repondrá el stock y se revertirá la caja (si la había). Esta acción no se puede deshacer.'
      : 'Se repondrá el stock de los productos vinculados. Esta acción no se puede deshacer.';
    const ok = await confirm({ title: 'Eliminar venta', message: msg, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      if (esB2B) {
        await cuentasApi.deleteMovimiento(v._b2b_mov_id);
      } else {
        await ventas.delete(v.id);
      }
      toast.success('Venta eliminada.');
      await Promise.all([loadLista(), loadDash()]);
    } catch (e) { toast.error(e.message); }
  }, [confirm, toast, loadLista, loadDash]);
  async function deleteRapida(id) {
    const ok = await confirm({ title: 'Eliminar venta rápida', message: '¿Seguro?', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await ventas.deleteRapida(id); await loadRapidas(); } catch (e) { toast.error(e.message); }
  }

  // ── Quick-add de cliente embebido (form mini) ─────────────────────────
  // Antes creábamos el contacto con solo `nombre`. Ahora pedimos también DNI,
  // WhatsApp, email y fecha de nacimiento — todos opcionales menos nombre.
  // Estos datos son insumo para Data Science (cumpleaños, perfilado) y para
  // contacto post-venta. El form se monta en línea dentro del dropdown.
  const [quickClient, setQuickClient] = useState({ open: false, nombre: '', dni: '', telefono: '', email: '', fecha_nacimiento: '' });
  const [quickClientSaving, setQuickClientSaving] = useState(false);
  const [quickClientError, setQuickClientError] = useState('');

  function abrirQuickClient(nombre) {
    setQuickClient({ open: true, nombre: nombre.trim(), dni: '', telefono: '', email: '', fecha_nacimiento: '' });
    setQuickClientError('');
  }
  function cerrarQuickClient() {
    setQuickClient(q => ({ ...q, open: false }));
    setQuickClientError('');
  }
  async function guardarQuickClient(e) {
    e?.preventDefault?.();
    const n = quickClient.nombre.trim();
    if (!n) { setQuickClientError('El nombre es obligatorio.'); return; }
    setQuickClientSaving(true);
    setQuickClientError('');
    try {
      const payload = {
        nombre: n,
        tipo: 'cliente',
        dni:              quickClient.dni.trim()      || null,
        telefono:         quickClient.telefono.trim() || null,
        email:            quickClient.email.trim()    || null,
        fecha_nacimiento: quickClient.fecha_nacimiento || null,
      };
      const c = await contactosApi.create(payload);
      setContactos(prev => [...prev, c]);
      setVForm(f => ({ ...f, cliente_nombre: c.nombre, cliente_id: c.id }));
      setClienteDrop(false);
      setQuickClient({ open: false, nombre: '', dni: '', telefono: '', email: '', fecha_nacimiento: '' });
      toast.success('Cliente creado y vinculado.');
    } catch (e) {
      setQuickClientError(e.message || 'No se pudo crear el cliente.');
    } finally {
      setQuickClientSaving(false);
    }
  }

  // ── Venta rápida ──
  // 2026-06-24 redesign: Lucas trajo referencia de otro proyecto con un solo
  // textarea libre + datetime. Estrategia: en vez de pedirle campos
  // estructurados (vendedor, cliente) en la captura "rápida", dejamos que
  // escriba TODO en formato libre. La estructura aparece después cuando
  // convertimos a venta completa con los pickers reales. Velocidad de
  // captura > reuso de datos parciales.
  //
  // El backend ya acepta vendedor_nombre/cliente_texto como opcionales,
  // así que no rompemos la API ni el storage — simplemente quedan null.
  function nowLocalDt() {
    const n = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    return `${n.getFullYear()}-${pad(n.getMonth()+1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}`;
  }
  const [rForm, setRForm] = useState(() => ({ fechaHora: nowLocalDt(), detalle: '' }));
  const [savingRapida, setSavingRapida] = useState(false);
  async function handleSaveRapida(e) {
    e.preventDefault();
    if (!rForm.detalle.trim()) return;
    setSavingRapida(true);
    try {
      // Split datetime-local 'YYYY-MM-DDTHH:mm' → fecha + hora separados que
      // espera el schema del backend (createVentaRapidaSchema).
      const [fecha, hora] = rForm.fechaHora.split('T');
      await ventas.createRapida({ fecha, hora, detalle: rForm.detalle.trim() });
      toast.success('Venta rápida guardada.');
      setShowRapida(false);
      setRForm({ fechaHora: nowLocalDt(), detalle: '' });
      await loadRapidas();
    } catch (err) { toast.error(err.message); } finally { setSavingRapida(false); }
  }

  // ── Garantías (gestión) ──
  const [gForm, setGForm] = useState({ id: null, nombre: '', texto: '', es_default: false });
  const [savingGar, setSavingGar] = useState(false);
  async function reloadGarantias() { try { setGarantias(await ventas.garantias()); } catch (_) {} }
  async function handleSaveGarantia(e) {
    e.preventDefault();
    if (!gForm.nombre.trim() || !gForm.texto.trim()) return;
    setSavingGar(true);
    try {
      const body = { nombre: gForm.nombre.trim(), texto: gForm.texto.trim(), es_default: gForm.es_default };
      if (gForm.id) await ventas.updateGarantia(gForm.id, body); else await ventas.createGarantia(body);
      toast.success('Plantilla guardada.');
      setGForm({ id: null, nombre: '', texto: '', es_default: false });
      await reloadGarantias();
    } catch (err) { toast.error(err.message); } finally { setSavingGar(false); }
  }
  async function deleteGarantia(id) {
    const ok = await confirm({ title: 'Eliminar plantilla', message: '¿Seguro?', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await ventas.deleteGarantia(id); await reloadGarantias(); } catch (e) { toast.error(e.message); }
  }

  // ── Etiquetas (gestión) ──
  async function addEtiqueta() {
    const nombre = nuevaEtiqueta.trim();
    if (!nombre) return;
    try { await ventas.createEtiqueta({ nombre }); setNuevaEtiqueta(''); setEtiquetas(await ventas.etiquetas()); }
    catch (e) { toast.error(e.message); }
  }
  async function delEtiqueta(id) {
    const ok = await confirm({ title: 'Eliminar etiqueta', message: 'Las ventas con esta etiqueta quedarán sin etiqueta.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await ventas.deleteEtiqueta(id); setEtiquetas(await ventas.etiquetas()); } catch (e) { toast.error(e.message); }
  }

  // ── Comprobantes adjuntos (ver) ──
  const openComprob = useCallback(async (id) => {
    setShowComprob(id); setComprobList(null);
    try { setComprobList(await ventas.comprobantes(id)); } catch (_) { setComprobList([]); }
  }, []);
  async function abrirComprob(cid) {
    try {
      const c = await ventas.getComprobante(cid);
      const w = window.open('', '_blank');
      if (!w) { toast.error('Permití las ventanas emergentes.'); return; }
      // Allowlist estricta de mime y de base64 — el visor inserta `data:<tipo>;base64,...`
      // y un tipo o data adulterado podría inyectar HTML en la ventana hija.
      const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
      const tipo = ALLOWED.includes(c.archivo_tipo) ? c.archivo_tipo : 'image/png';
      const dataOk = typeof c.archivo_data === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(c.archivo_data);
      if (!dataOk) { toast.error('Archivo inválido.'); w.close(); return; }
      const url = `data:${tipo};base64,${c.archivo_data.replace(/\s/g, '')}`;
      // Construimos el DOM con la API de elementos (sin document.write de strings interpolados):
      const body = w.document.body;
      body.style.cssText = 'margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh';
      const el = tipo === 'application/pdf' ? w.document.createElement('iframe') : w.document.createElement('img');
      el.src = url;
      el.style.cssText = tipo === 'application/pdf'
        ? 'position:fixed;inset:0;width:100%;height:100%;border:none'
        : 'max-width:100%;max-height:100vh';
      body.appendChild(el);
    } catch (e) { toast.error('Error al abrir.'); }
  }

  // #509 — persistir el override del "atendido por" del comprobante.
  // Delega en el PATCH focalizado que corre server-side el trim + audit log.
  // El backend devuelve la venta actualizada; refrescamos el listado para que
  // el PDF y el modal reflejen el nuevo valor sin lag.
  async function saveVendedorNombre(ventaId, nuevoNombre) {
    try {
      await ventas.updateVendedorNombre(ventaId, nuevoNombre);
      toast.success('Vendedor del comprobante actualizado');
      await loadLista();
    } catch (e) {
      toast.error(`No se pudo actualizar: ${e?.message || e}`);
      throw e; // el modal mantiene el estado de guardado en false y cerrará vía onClose.
    }
  }

  // ── Comprobante PDF (mismo flujo que el modal de éxito) ──
  // Antes había dos comprobantes: el PDF del modal y un HTML imprimible
  // que abría una ventana nueva. Unificamos en uno solo: ambos puntos de
  // entrada (botón "Descargar comprobante" del modal y icono impresora en
  // la grilla) generan el mismo PDF con el mismo layout sobrio.
  const comprobantePDF = useCallback(async (v) => {
    await withPdfLoading(async () => {
      const contactoVinculado = v.cliente_id
        ? contactos.find(c => String(c.id) === String(v.cliente_id))
        : null;
      // Cuando la venta viene del backend (lista), los items tienen vendedor_id;
      // usamos el primer item con vendedor para resolver el nombre.
      // #509 — si la venta tiene `vendedor_nombre` (override post-emisión desde
      // el modal Editar vendedor o del alta), lo preferimos sobre el derivado
      // del item. Ese es exactamente el punto del feature: dejar que el owner
      // muestre otro nombre en el comprobante sin tocar los items.
      const vendedorId = (v.items || []).find(i => i.vendedor_id)?.vendedor_id;
      const vendedorDerivado = vendedorId
        ? (vendedores.find(x => String(x.id) === String(vendedorId))?.nombre || null)
        : null;
      const vendedorNombre = v.vendedor_nombre || vendedorDerivado;
      // Garantía: la elegida en la venta, o la default del catálogo, o el fallback.
      const garFuente = v.garantia_id
        ? garantias.find(g => String(g.id) === String(v.garantia_id))
        : garantias.find(g => g.es_default);
      const ventaEnriquecida = {
        ...v,
        cliente_apellido: contactoVinculado?.apellido || null,
        cliente_dni:      contactoVinculado?.dni      || null,
        cliente_telefono: contactoVinculado?.telefono || null,
        cliente_email:    contactoVinculado?.email    || null,
        vendedor_nombre:  vendedorNombre,
        garantia_nombre:  garFuente?.nombre || (v.garantia_id ? null : 'Predeterminada'),
        garantia_texto:   renderPlantilla(garFuente?.texto || GARANTIA_FALLBACK_TEXTO, tenantNombre),
      };
      try {
        const mod = await import('../lib/generarComprobantePdf');
        await mod.generarComprobantePdf(ventaEnriquecida, { tenantNombre });
      } catch (e) {
        console.error('PDF error:', e);
        toast.error(`No se pudo generar el comprobante PDF: ${e?.message || e}`, { duration: 12000 });
      }
    });
  }, [withPdfLoading, contactos, vendedores, garantias, tenantNombre, toast]);

  // Handler estable para abrir el modal focalizado de "editar vendedor" del
  // comprobante. Antes se pasaba inline a <VentasList> (nueva ref por render);
  // ahora es un useCallback vacío-deps para no romper el memo de VentaRow.
  const openEditarVendedor = useCallback((v) => {
    setEditarVendedor({ open: true, venta: v });
  }, []);

  function exportarExcel() {
    if (!lista.length) { toast.error('No hay ventas para exportar.'); return; }
    // 2026-07-04 (ventas.ver_ganancias): si el backend redactó ganancia_usd
    // (user sin la cap), la columna ganancia queda fuera del CSV — sino
    // exportaríamos "undefined" y expondríamos el gap. Consistente con la
    // grilla en pantalla (VentasList oculta la columna en el mismo caso).
    const showGanancia = 'ganancia_usd' in lista[0];
    const rows = lista.map(v => {
      const base = {
        order_id: v.order_id, fecha: (v.fecha || '').substring(0, 10), hora: v.hora ? v.hora.substring(0, 5) : '',
        cliente: v.cliente_nombre || '', etiqueta: v.etiqueta_nombre || '', estado: v.estado,
        productos: (v.items || []).map(i => i.descripcion + (i.cantidad > 1 ? ' x' + i.cantidad : '')).join(' | '),
        imei: (v.items || []).map(i => i.imei).filter(Boolean).join(' | '),
        pagos: (v.pagos || []).map(p => `${p.metodo_nombre} ${p.moneda} ${p.monto}`).join(' | '),
        tc_venta: v.tc_venta || '', total_usd: v.total_usd,
      };
      return showGanancia ? { ...base, ganancia_usd: v.ganancia_usd } : base;
    });
    const cols = ['order_id', 'fecha', 'hora', 'cliente', 'etiqueta', 'estado', 'productos', 'imei', 'pagos', 'tc_venta', 'total_usd'];
    if (showGanancia) cols.push('ganancia_usd');
    exportCsv(`ventas_${desde}_${hasta}.csv`, rows, cols.map(k => ({ key: k, label: k })));
  }

  function estadoBadge(s) { const d = ESTADO_DISPLAY[s] || { label: s, tone: 'default' }; return <Badge tone={d.tone}>{d.label}</Badge>; }

  return (
    <div>
      {/* 2026-06-19 Lucas: page-head solo título + subtítulo; los botones de
          acción bajan a la fila de chips de período (flex-between) para
          quedar a la misma altura visual. */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Ventas</h1>
          <div className="page-sub">Dashboard, movimientos y carga de ventas</div>
        </div>
      </div>

      {/* Período + acciones en la misma fila */}
      <div className="flex-between" style={{ marginBottom: 14, gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <Seg value={periodo} options={[
          { value: 'hoy', label: 'Hoy' }, { value: 'ayer', label: 'Ayer' }, { value: 'semana', label: 'Esta semana' },
          { value: 'mes', label: 'Este mes' }, { value: 'custom', label: 'Personalizado' },
        ]} onChange={setPeriodoRange} />
        <div className="page-actions">
          <button className="btn" onClick={() => { loadDash(); loadLista(); loadRapidas(); }}><Icons.Refresh size={14} /> Actualizar</button>
          <button className="btn" onClick={() => setShowGarantias(true)}><Icons.Shield size={14} /> Plantillas</button>
          <button className="btn" onClick={() => setShowEtiquetas(true)}><Icons.Tag size={14} /> Etiquetas</button>
          {/* 2026-07-01: catálogo de vendedores movido acá desde Transferencias
              — reportado por cliente Uruguay. El modal permite CRUD in-place
              y refresca el dropdown de "Nueva venta" sin refetch adicional. */}
          <button className="btn" onClick={() => setShowVendedoresModal(true)}><Icons.Users size={14} /> Vendedores</button>
          <button className="btn" onClick={() => { setRForm({ fechaHora: nowLocalDt(), detalle: '' }); setShowRapida(true); }}><Icons.Bolt size={14} /> Venta rápida</button>
          <button className="btn" onClick={exportarExcel}><Icons.Download size={14} /> Exportar</button>
          <button className="btn btn-primary" onClick={() => openVenta(null)}><Icons.Plus size={14} /> Nueva venta</button>
        </div>
      </div>

      {/* Dashboard */}
      <Dashboard d={dash} />

      {/* Filtros lista */}
      <div className="flex-between" style={{ marginBottom: 14 }}>
        <div className="flex-row" style={{ gap: 8 }}>
          {/* Auditoría 2026-06-30 F-07: setParams batch — periodo + desde se
              actualizan en un solo render para que el segundo setParam no use
              un searchParams stale del primero (pierde el cambio del primero). */}
          <input type="date" className="input" style={{ width: 150 }} value={desde} onChange={e => setParams([
            { key: 'periodo', value: 'custom', def: 'hoy' },
            { key: 'desde', value: e.target.value, def: _today },
          ])} />
          <input type="date" className="input" style={{ width: 150 }} value={hasta} onChange={e => setParams([
            { key: 'periodo', value: 'custom', def: 'hoy' },
            { key: 'hasta', value: e.target.value, def: _today },
          ])} />
        </div>
        <div className="flex-row" style={{ gap: 8 }}>
          <div className="input-group" style={{ width: 280 }}>
            <span className="addon addon-l"><Icons.Search size={14} /></span>
            <input className="input" placeholder="Order ID, cliente, producto, IMEI…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Seg value={estadoFilter} options={[
            { value: '', label: 'Todos' }, { value: 'acreditado', label: 'Acreditados' }, { value: 'pendiente', label: 'Pendientes' }, { value: 'cancelado', label: 'Cancelados' },
          ]} onChange={setEstadoFilter} />
        </div>
      </div>

      {/* Ventas rápidas pendientes */}
      {rapidas.length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 14 }}>
          <div className="kpi-label" style={{ color: 'var(--warn)', marginBottom: 8 }}><Icons.Bolt size={12} /> Ventas rápidas pendientes ({rapidas.length})</div>
          {rapidas.map(r => (
            <div key={r.id} className="flex-between" style={{ gap: 8, padding: '8px 0', borderBottom: '1px solid var(--hairline)', alignItems: 'flex-start' }}>
              <div style={{ fontSize: 13 }}>
                <strong>{r.vendedor_nombre || '—'}</strong>{r.cliente_texto ? ' · ' + r.cliente_texto : ''}
                <div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{r.detalle}</div>
              </div>
              <div className="flex-row" style={{ gap: 6, flexShrink: 0 }}>
                <button className="btn btn-sm" onClick={() => openVenta(r)}><Icons.Check size={13} /> Procesar</button>
                <button className="icon-btn" title="Eliminar venta rápida" aria-label="Eliminar venta rápida" style={{ color: 'var(--neg)' }} onClick={() => deleteRapida(r.id)}><Icons.Trash size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Lista de movimientos */}
      {/* 2026-07-16 (task #144 UX A): loading + empty states mejorados.
          Antes: "Cargando…" plano y "Sin ventas en el período" sin acción.
          Ahora: skeleton table (perceived load time menor, misma estructura)
          + empty con CTA que invita a la acción principal (crear venta) o
          a revisar los filtros — user no queda mirando pantalla vacía sin
          saber qué hacer. */}
      {loading ? (
        <table className="table" aria-busy="true">
          <thead>
            <tr>
              <th>Estado</th><th>Fecha</th><th>Cliente</th>
              <th>Productos</th><th>Pagos</th><th>Total</th><th></th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} columns={7} />)}
          </tbody>
        </table>
      ) : lista.length === 0 ? (
        <div className="empty" style={{ textAlign: 'center', padding: '32px 20px' }}>
          <div style={{ fontSize: 14, marginBottom: 6 }}>No hay ventas en el período seleccionado.</div>
          <div className="muted tiny">
            Cargá una nueva desde el botón <strong>Nueva venta</strong> del header, o cambiá el filtro de fechas.
          </div>
        </div>
      ) : (
        <VentasList
          lista={lista}
          estadoBadge={estadoBadge}
          changeEstado={changeEstado}
          openEdit={openEdit}
          comprobantePDF={comprobantePDF}
          openComprob={openComprob}
          deleteVenta={deleteVenta}
          confirmarEntrega={confirmarEntrega}
          openEditarVendedor={openEditarVendedor}
        />
      )}

      {/* ── Modal Nueva venta ── */}
      {showVenta && (
        <div ref={ventaModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowVenta(false)}>
          <div
            className="modal"
            style={{ maxWidth: 720 }}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="venta-modal-title"
          >
            <div className="modal-hd"><h3 id="venta-modal-title">{editId ? 'Editar venta' : procRapidaId ? 'Procesar venta rápida' : 'Nueva venta'}</h3><button type="button" className="icon-btn" onClick={() => setShowVenta(false)} aria-label="Cerrar" title="Cerrar"><Icons.X size={16} /></button></div>
            {/* 2026-07-11: form como flex-column con flex:1 + minHeight:0 para
                que la cadena flex del .modal (display:flex column + max-height:
                calc(100svh - 48px) + overflow:hidden) se propague al .modal-body.
                Antes usábamos `maxHeight: '74vh'` inline como workaround, pero
                clava el body al 74% del viewport (queda chico en desktop grande,
                apretado en mobile con la barra Safari). Con el form flex, el
                .modal-body.flex:1 + overflow-y:auto del base CSS scrollea
                automáticamente. Ver Envios.jsx modal para el fix inicial. */}
            <form onSubmit={handleSaveVenta} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <div className="modal-body">
                <div className="stack" style={{ gap: 14 }}>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Fecha <span style={{ color: 'var(--neg)' }}>*</span></label><input type="date" className="input" value={vForm.fecha} onChange={e => setVF('fecha', e.target.value)} /></div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Hora</label><input type="time" className="input" value={vForm.hora} onChange={e => setVF('hora', e.target.value)} /></div>
                  </div>

                  {/* Productos */}
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Productos</div>
                    <div style={{ position: 'relative' }}>
                      <input className="input" placeholder="Buscar producto del inventario (nombre, IMEI, color…)" value={prodSearch} onChange={e => searchProducto(e.target.value)} />
                      {prodResults.length > 0 && (
                        <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 60, maxHeight: 220, overflowY: 'auto', marginTop: 2, padding: 4 }}>
                          {prodResults.map(p => (
                            <div key={p.id} className="nav-item" style={{ cursor: 'pointer', fontSize: 13 }} onClick={() => addProd(p)}>
                              {/* 2026-07-07 (Lucas #525): mostramos batería si el
                                  producto es usado — sin eso, dos iPhones "usado
                                  256GB Deep Blue" son indistinguibles en el
                                  dropdown. Batería es el criterio de decisión
                                  del operador para elegir cuál agregar. Nuevos
                                  no muestran batería porque siempre es 100%. */}
                              <strong>{p.nombre}</strong>&nbsp;{p.color || ''} {p.gb ? p.gb + 'GB' : ''} · {sym(p.precio_moneda)}{fmt(p.precio_venta)}{p.condicion === 'usado' && p.bateria != null ? ' · Bat ' + p.bateria + '%' : ''}{p.imei ? ' · IMEI ' + fmtImei(p.imei) : ''}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                      {cart.map((it) => (
                        // data-testid agregado para E2E (TANDA 5 venta retail) — scoping
                        // estable de los 4 inputs por fila (descripcion/cant/precio/moneda)
                        // sin atarse a CSS frágil del grid.
                        // 2026-06-24 mobile lote C: class .item-grid + CSS var --cols
                        // hace que en <=520px todas las columnas colapsen a 1fr
                        // (stack vertical, delete right-aligned). Desktop sin cambios.
                        // Auditoría 2026-06-30 F-13/14: key={_id} en vez de index.
                        <div key={it._id} data-testid="venta-item-row" className="item-grid" style={{ '--cols': '1fr 60px 90px 78px auto', gap: 6, alignItems: 'center' }}>
                          {/* 2026-07-07 (Lucas #525): wrapper vertical en la
                              1ra columna para mostrar la chip "IMEI · Bat X%"
                              debajo del input cuando el ítem vino de un pick
                              del inventario. La chip solo se muestra si hay
                              IMEI o (batería + condicion=usado) — items
                              manuales quedan como antes (solo input). No
                              rompe layout: el <div> hereda el grid-cell 1fr
                              y el input adentro estira al 100%. */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                            <input className="input" placeholder="Producto" value={it.descripcion} onChange={e => setItem(it._id, 'descripcion', e.target.value)} />
                            {(it.imei || (it.condicion === 'usado' && it.bateria != null)) && (
                              <div style={{ fontSize: 11, color: 'var(--muted)', paddingLeft: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {it.imei ? 'IMEI ' + fmtImei(it.imei) : ''}
                                {it.imei && it.condicion === 'usado' && it.bateria != null ? ' · ' : ''}
                                {it.condicion === 'usado' && it.bateria != null ? 'Bat ' + it.bateria + '%' : ''}
                              </div>
                            )}
                          </div>
                          <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="1" value={it.cantidad} onChange={e => setItem(it._id, 'cantidad', e.target.value)} />
                          <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="Precio" value={it.precio_vendido} onChange={e => setItem(it._id, 'precio_vendido', e.target.value)} />
                          {/* Items de venta retail: USD o moneda local del tenant (no
                              USDT, que es medio de pago, no precio de góndola). Si el
                              record tiene un valor legacy fuera del set (ej. venta
                              vieja ARS en un tenant que hoy es UY), lo conservamos
                              para no romper edits. */}
                          <select className="input" value={it.moneda} onChange={e => setItem(it._id, 'moneda', e.target.value)}>
                            {Array.from(new Set(['USD', monedaLocal, it.moneda].filter(Boolean)))
                              .map(m => <option key={m} value={m}>{m}</option>)}
                          </select>
                          <button type="button" className="icon-btn" title="Quitar ítem" aria-label="Quitar ítem" onClick={() => rmItem(it._id)}><Icons.X size={14} /></button>
                        </div>
                      ))}
                    </div>
                    <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={addItemManual}><Icons.Plus size={13} /> Ítem manual</button>
                  </div>

                  {/* Vendedor / cliente */}
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Vendedor</label><select className="input" value={vForm.vendedor_id} onChange={e => setVF('vendedor_id', e.target.value)}><option value="">—</option>{vendedores.map(v => <option key={v.id} value={v.id}>{v.nombre}</option>)}</select></div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Comisión (USD)</label><input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="0" value={vForm.comision} onChange={e => setVF('comision', e.target.value)} /></div>
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1, position: 'relative' }}>
                      <label className="field-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>Cliente</span>
                        {/* Botón siempre visible para abrir el mini-form de cliente nuevo
                            sin tener que tipear primero en el buscador. Si el operador
                            quiere cargar un cliente con datos completos directo, tocá
                            acá. (También se sigue ofreciendo desde el dropdown como
                            "Crear cliente «X»" si tipea algo nuevo.) */}
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => abrirQuickClient(vForm.cliente_nombre)}>
                          <Icons.Plus size={11} /> Nuevo cliente
                        </button>
                      </label>
                      <input className="input" placeholder="Buscar cliente..." autoComplete="off"
                        value={vForm.cliente_nombre}
                        onChange={e => { setVForm(f => ({ ...f, cliente_nombre: e.target.value, cliente_id: '' })); setClienteDrop(true); }}
                        onFocus={() => setClienteDrop(true)}
                        onBlur={() => setTimeout(() => setClienteDrop(false), 150)} />
                      {clienteDrop && (() => {
                        const q = vForm.cliente_nombre.trim();
                        const ql = q.toLowerCase();
                        const matches = contactos.filter(c => (`${c.nombre} ${c.apellido || ''}`).toLowerCase().includes(ql)).slice(0, 8);
                        const exact = contactos.some(c => `${c.nombre}${c.apellido ? ' ' + c.apellido : ''}`.trim().toLowerCase() === ql);
                        const showCreate = q.length >= 2 && !exact;
                        if (!matches.length && !showCreate) return null;
                        return (
                          <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 60, maxHeight: 220, overflowY: 'auto', marginTop: 2, padding: 4 }}>
                            {matches.map(c => (
                              <div key={c.id} className="nav-item" style={{ cursor: 'pointer', fontSize: 13 }}
                                onMouseDown={() => {
                                  // #475: si el contacto tiene email cargado, lo pre-llenamos
                                  // y tildamos el checkbox automáticamente — asumimos que el
                                  // operador quiere mandar el comprobante (puede destildar).
                                  setVForm(f => ({
                                    ...f,
                                    cliente_nombre: `${c.nombre}${c.apellido ? ' ' + c.apellido : ''}`,
                                    cliente_id: c.id,
                                    cliente_email: c.email || '',
                                    enviar_comprobante_email: !!c.email,
                                  }));
                                  setClienteDrop(false);
                                }}>
                                {c.nombre}{c.apellido ? ' ' + c.apellido : ''} {c.tipo && <span className="muted tiny">· {c.tipo}</span>}
                              </div>
                            ))}
                            {showCreate && (
                              <div className="nav-item" style={{ cursor: 'pointer', fontSize: 13, color: 'var(--accent)' }} onMouseDown={() => abrirQuickClient(q)}>
                                <Icons.Plus size={12} /> Crear cliente «{q}»
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {vForm.cliente_id && <div className="tiny pos" style={{ marginTop: 2 }}>✓ vinculado a la base de clientes</div>}

                      {/* #475 — Email del cliente + checkbox para enviar comprobante.
                          Solo aparece para venta retail nueva (no en edición — la edición
                          no re-dispara el envío para evitar dobles envíos accidentales;
                          el operador usa "Reenviar comprobante" desde el detalle). */}
                      {!editId && (
                        <div style={{ marginTop: 10, padding: 10, background: 'var(--surface-2)', borderRadius: 8 }}>
                          <div className="field" style={{ marginBottom: 8 }}>
                            <label className="field-label" htmlFor="v-cliente-email">
                              Email cliente <span className="muted tiny">(opcional, para enviar comprobante)</span>
                            </label>
                            <input
                              id="v-cliente-email"
                              className="input"
                              type="email"
                              inputMode="email"
                              autoComplete="off"
                              autoCapitalize="none"
                              autoCorrect="off"
                              placeholder="email@ejemplo.com"
                              value={vForm.cliente_email}
                              onChange={e => setVForm(f => ({ ...f, cliente_email: e.target.value }))}
                              onBlur={() => {
                                // Validación blur: si el email no parsea, destildar el
                                // checkbox para no postear con email inválido (el backend
                                // igual lo rebota con 400, pero la UX es mejor inline).
                                const v = vForm.cliente_email.trim();
                                if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
                                  setVForm(f => ({ ...f, enviar_comprobante_email: false }));
                                }
                              }}
                            />
                          </div>
                          {vForm.cliente_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vForm.cliente_email.trim()) && (
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={!!vForm.enviar_comprobante_email}
                                onChange={e => setVForm(f => ({ ...f, enviar_comprobante_email: e.target.checked }))}
                              />
                              Enviar comprobante por mail al cliente
                            </label>
                          )}
                        </div>
                      )}

                      {/* Mini-form embebido — Nuevo cliente con datos completos
                          (DNI, WhatsApp, email, fecha de nacimiento). Se abre al
                          clickear "Crear cliente «X»" en el dropdown. */}
                      {quickClient.open && (
                        <div className="card card-tight" style={{ marginTop: 10, padding: 14, background: 'var(--surface-2)' }}>
                          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Nuevo cliente</div>
                          <div className="muted tiny" style={{ marginBottom: 12 }}>
                            Solo el nombre es obligatorio. El resto es opcional pero ayuda al seguimiento post-venta.
                          </div>
                          <div className="stack" style={{ gap: 10 }}>
                            <div className="field">
                              <label className="field-label" htmlFor="qc-nombre">Nombre completo <span style={{ color: 'var(--neg)' }}>*</span></label>
                              <input id="qc-nombre" className="input" autoFocus
                                value={quickClient.nombre}
                                onChange={e => setQuickClient(q => ({ ...q, nombre: e.target.value }))} />
                            </div>
                            <div className="row" style={{ gap: 10 }}>
                              <div className="field" style={{ flex: 1 }}>
                                <label className="field-label" htmlFor="qc-dni">DNI</label>
                                <input id="qc-dni" className="input" inputMode="numeric" pattern="[0-9]*" placeholder="Ej: 12345678"
                                  value={quickClient.dni}
                                  onChange={e => setQuickClient(q => ({ ...q, dni: e.target.value }))} />
                              </div>
                              <div className="field" style={{ flex: 1 }}>
                                <label className="field-label" htmlFor="qc-tel">WhatsApp</label>
                                <input id="qc-tel" className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder="Ej: 1123456789"
                                  value={quickClient.telefono}
                                  onChange={e => setQuickClient(q => ({ ...q, telefono: e.target.value }))} />
                              </div>
                            </div>
                            <div className="row" style={{ gap: 10 }}>
                              <div className="field" style={{ flex: 1 }}>
                                <label className="field-label" htmlFor="qc-email">Correo electrónico</label>
                                <input id="qc-email" className="input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" placeholder="email@ejemplo.com"
                                  value={quickClient.email}
                                  onChange={e => setQuickClient(q => ({ ...q, email: e.target.value }))} />
                              </div>
                              <div className="field" style={{ flex: 1 }}>
                                <label className="field-label" htmlFor="qc-fnac">Fecha de nacimiento</label>
                                <input id="qc-fnac" className="input" type="date"
                                  value={quickClient.fecha_nacimiento}
                                  onChange={e => setQuickClient(q => ({ ...q, fecha_nacimiento: e.target.value }))} />
                              </div>
                            </div>
                            {quickClientError && (
                              <div style={{ color: 'var(--neg)', fontSize: 13 }} role="alert">{quickClientError}</div>
                            )}
                            <div className="flex-row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={cerrarQuickClient} disabled={quickClientSaving}>Cancelar</button>
                              <button type="button" className="btn btn-primary btn-sm" onClick={guardarQuickClient} disabled={quickClientSaving}>
                                {quickClientSaving ? 'Guardando…' : 'Guardar y vincular'}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label" style={{ display: 'flex', justifyContent: 'space-between' }}>Etiqueta <button type="button" className="btn btn-sm" onClick={() => setShowEtiquetas(true)}><Icons.Settings size={11} /> Gestionar</button></label><select className="input" value={vForm.etiqueta_id} onChange={e => setVF('etiqueta_id', e.target.value)}><option value="">Sin etiqueta</option>{etiquetas.map(et => <option key={et.id} value={et.id}>{et.nombre}</option>)}</select></div>
                  </div>
                  <div className="field">
                    <label className="field-label">Cliente cuenta corriente <span className="muted tiny">(requerido si pagás en CC)</span></label>
                    <select className="input" value={vForm.cliente_cc_id} onChange={e => setVF('cliente_cc_id', e.target.value)}>
                      <option value="">— Ninguno —</option>
                      {clientesCC.map(c => <option key={c.id} value={c.id}>{c.nombre}{c.apellido ? ' ' + c.apellido : ''}</option>)}
                    </select>
                    {(() => {
                      const cc = clientesCC.find(c => String(c.id) === String(vForm.cliente_cc_id));
                      if (!cc) return null;
                      const s = Number(cc.saldo) || 0;
                      return <div className="tiny" style={{ marginTop: 4 }}>Saldo actual: {s > 0 ? <span className="neg">debe u$s{fmt(s)}</span> : s < 0 ? <span className="pos">a favor u$s{fmt(-s)}</span> : <span className="muted">sin deuda</span>}</div>;
                    })()}
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}><label className="field-label">TC venta (ARS/USD)</label><input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="1425" value={vForm.tc_venta} onChange={e => setVF('tc_venta', e.target.value)} /><TcWarning tc={vForm.tc_venta} /></div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Estado</label><select className="input" value={vForm.estado} onChange={e => setVF('estado', e.target.value)}><option value="pendiente">Pendiente</option><option value="acreditado">Acreditado</option></select></div>
                  </div>
                  <div className="field">
                    <label className="field-label" style={{ display: 'flex', justifyContent: 'space-between' }}>Garantía (para el comprobante)
                      <button type="button" className="btn btn-sm" onClick={() => setShowGarantias(true)}><Icons.Settings size={11} /> Gestionar</button>
                    </label>
                    <select className="input" value={vForm.garantia_id} onChange={e => setVF('garantia_id', e.target.value)}>
                      <option value="">Predeterminada{garantias.find(g => g.es_default) ? ' (' + garantias.find(g => g.es_default).nombre + ')' : ''}</option>
                      {garantias.map(g => <option key={g.id} value={g.id}>{g.nombre}{g.es_default ? ' ★' : ''}</option>)}
                    </select>
                  </div>

                  {/* Canjes — equipos tomados en parte de pago (junio 2026: array de N)
                      Si "A inventario" está activo, el equipo se crea como producto
                      en Inventario con todos los campos cargados. */}
                  <div>
                    <div className="flex-between" style={{ alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        Equipos en canje {(vForm.canjes || []).length > 0 && <span className="muted tiny">({vForm.canjes.length})</span>}
                      </div>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={addCanje}>
                        <Icons.Plus size={12} /> Agregar equipo
                      </button>
                    </div>
                    {(vForm.canjes || []).length === 0 && (
                      <div className="muted tiny" style={{ padding: '6px 0' }}>
                        Sin equipos en canje. Si el cliente entrega uno como parte de pago, agregalo acá.
                      </div>
                    )}
                    <div className="stack" style={{ gap: 10 }}>
                      {/* Auditoría 2026-06-30 F-13/14: key={_id} en canjes. */}
                      {(vForm.canjes || []).map((c, i) => (
                        <div key={c._id} style={{
                          padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)',
                          borderRadius: 8,
                        }}>
                          {/* Header del canje: índice + botón quitar */}
                          <div className="flex-between" style={{ alignItems: 'center', marginBottom: 8 }}>
                            <div className="muted tiny" style={{ fontWeight: 600 }}>
                              Equipo {i + 1}
                              {c._existing && <span style={{ marginLeft: 6, color: 'var(--accent)' }}>(ya en Inventario)</span>}
                            </div>
                            <button type="button" className="icon-btn" aria-label="Quitar equipo" onClick={() => rmCanje(c._id)}>
                              <Icons.X size={14} />
                            </button>
                          </div>

                          {/* Fila 1: descripción + IMEI + valor toma */}
                          <div className="row" style={{ marginBottom: 8 }}>
                            <div className="field" style={{ flex: 2 }}>
                              <label className="field-label">Descripción</label>
                              <input className="input" placeholder="iPhone 13 Pro 256 Sierra Blue"
                                     value={c.descripcion} onChange={e => setCanje(c._id, 'descripcion', e.target.value)} />
                            </div>
                            <div className="field" style={{ flex: 1.2 }}>
                              <label className="field-label">IMEI / Nº serie</label>
                              <input className="input mono" placeholder="35..."
                                     value={c.imei} onChange={e => setCanje(c._id, 'imei', e.target.value)} />
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                              <label className="field-label">Valor toma (USD)</label>
                              <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} className="input mono"
                                     placeholder="0" value={c.valor_toma} onChange={e => setCanje(c._id, 'valor_toma', e.target.value)} />
                            </div>
                          </div>

                          {/* Fila 2: GB, color, batería, condición */}
                          <div className="row" style={{ marginBottom: 8 }}>
                            <div className="field" style={{ flex: 0.7 }}>
                              <label className="field-label">GB</label>
                              <input className="input" placeholder="256"
                                     value={c.gb} onChange={e => setCanje(c._id, 'gb', e.target.value)} />
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                              <label className="field-label">Color</label>
                              <input className="input" placeholder="Sierra Blue"
                                     value={c.color} onChange={e => setCanje(c._id, 'color', e.target.value)} />
                            </div>
                            <div className="field" style={{ flex: 0.7 }}>
                              <label className="field-label">% Batería</label>
                              <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} className="input mono"
                                     min="0" max="100" placeholder="100"
                                     value={c.bateria} onChange={e => setCanje(c._id, 'bateria', e.target.value)} />
                            </div>
                            <div className="field" style={{ flex: 0.8 }}>
                              <label className="field-label">Condición</label>
                              <select className="input" value={c.condicion}
                                      onChange={e => setCanje(c._id, 'condicion', e.target.value)}>
                                <option value="usado">Usado</option>
                                <option value="nuevo">Nuevo</option>
                              </select>
                            </div>
                          </div>

                          {/* Fila 3: categoría + precio sugerido + a inventario */}
                          {/* 2026-07-11: fuente cambiada de `categorias` (Colecciones
                              legacy) a `clases_producto` (categoría real F3). El
                              placeholder "— auto por condición —" comunica el fallback
                              del backend cuando no se elige nada explícito.

                              2026-07-11 (bug Lucas): categoria + precio_venta_sugerido
                              + observaciones son EDITABLES aún si el canje ya está en
                              Inventario (`_existing`). El backend detecta `producto_id`
                              en el body y hace UPDATE del producto existente en vez de
                              crear uno nuevo. Antes estaban `disabled={c._existing}`
                              → el operador no podía cambiar la categoría del producto
                              asociado desde el modal de edición de venta. */}
                          <div className="row" style={{ marginBottom: 8 }}>
                            <div className="field" style={{ flex: 1.5 }}>
                              <label className="field-label">Categoría</label>
                              <select className="input" value={c.clase_id}
                                      onChange={e => setCanje(c._id, 'clase_id', e.target.value)}>
                                <option value="">— auto por condición —</option>
                                {clasesInv.map(cat => (
                                  <option key={cat.id} value={cat.id}>
                                    {cat.emoji ? `${cat.emoji} ${cat.nombre}` : cat.nombre}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="field" style={{ flex: 1 }}>
                              <label className="field-label">Precio venta sugerido (USD)</label>
                              <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} className="input mono"
                                     placeholder="0 (editar en Inventario después)"
                                     value={c.precio_venta_sugerido}
                                     onChange={e => setCanje(c._id, 'precio_venta_sugerido', e.target.value)} />
                            </div>
                            <div className="field" style={{ flex: 0.8, alignSelf: 'end' }}>
                              {/* El checkbox "A inventario" SÍ queda disabled en canjes
                                  _existing — cambiar de true a false requeriría borrar
                                  el producto asociado, y eso lo hacemos desde Inventario
                                  (flow más seguro con confirmación). */}
                              <label className="flex-row" style={{ gap: 6, fontSize: 12, cursor: c._existing ? 'not-allowed' : 'pointer' }}>
                                <input type="checkbox" checked={c.agregar_stock}
                                       disabled={c._existing}
                                       onChange={e => setCanje(c._id, 'agregar_stock', e.target.checked)} />
                                A inventario
                              </label>
                            </div>
                          </div>

                          {/* Fila 4: observaciones editables también en _existing.
                              2026-07-11 (bug Lucas): quitamos el gate `!c._existing`. */}
                          {c.agregar_stock && (
                            <div className="field">
                              <label className="field-label">Observaciones (opcional)</label>
                              <input className="input" placeholder="Pantalla sin raspones, caja original, batería al 87%"
                                     value={c.observaciones}
                                     onChange={e => setCanje(c._id, 'observaciones', e.target.value)} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Pagos */}
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Pagos</div>
                    <div className="stack" style={{ gap: 6 }}>
                      {pagos.map((p, i) => {
                        // Tema C rev5 (2026-06-14): el operador tipea USD (su mental
                        // model), el sistema arma el bruto ARS según el método. CC
                        // usa el flujo viejo (input monto directo). Cuando hay
                        // comisión, debajo aparece el desglose en 3 columnas con
                        // neto EDITABLE (caso "cliente ya transfirió $X").
                        const det = totales.pagosDetalle[i];
                        const m = metodos.find(x => x.id === p.metodo_pago_id);
                        // 2026-06-29 Multi-país F3: desglose + TC visibles cuando la
                        // moneda es la local (ARS o UYU), no ARS-hardcoded. USD/USDT
                        // no requieren TC (montos directos).
                        const showDesglose = det && det.pct > 0 && (p.moneda === 'ARS' || p.moneda === 'UYU');
                        const showTc = !p.es_cuenta_corriente && (p.moneda === 'ARS' || p.moneda === 'UYU');
                        // CC = flujo viejo (monto + moneda, sin desglose, sin auto-fill).
                        // Auditoría 2026-06-30 F-13/14: key={_id}, rmPago/setPago por id.
                        // Los handlers setPagoMetodo/setPagoUsd/etc. mantienen firma por
                        // índice porque dependen de faltanteUsd(index, prevPagos) — el
                        // índice viene del closure del map y el array no cambió de orden
                        // entre el render y el dispatch.
                        if (p.es_cuenta_corriente) {
                          return (
                            <div key={p._id}>
                              <div data-testid="venta-pago-row" style={{ display: 'grid', gridTemplateColumns: '1fr 90px 78px 78px auto', gap: 6, alignItems: 'center' }}>
                                <select className="input" value="__CC__" onChange={e => setPagoMetodo(i, e.target.value)}><option value="">Método…</option>{metodos.map(mm => <option key={mm.id} value={mm.nombre}>{mm.nombre}</option>)}<option value="__CC__">Cuenta corriente (deuda)</option></select>
                                <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="Monto" value={p.monto} onChange={e => setPago(p._id, 'monto', e.target.value)} />
                                <select className="input" value={p.moneda} onChange={e => setPago(p._id, 'moneda', e.target.value)}>
                                  {Array.from(new Set([...monedas, p.moneda].filter(Boolean)))
                                    .map(mm => <option key={mm} value={mm}>{mm}</option>)}
                                </select>
                                <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="TC" value={p.tc} onChange={e => setPago(p._id, 'tc', e.target.value)} />
                                <button type="button" className="icon-btn" title="Quitar pago" aria-label="Quitar pago" onClick={() => rmPago(p._id)}><Icons.X size={14} /></button>
                              </div>
                              <TcWarning tc={p.tc} />
                            </div>
                          );
                        }
                        // Determinar modo del input:
                        //   · arsDirect: EFECTIVO ARS (sin comisión, ARS) → input ARS directo
                        //   · resto: USD + TC (Tarjeta, Transferencia, Efectivo USD)
                        const tcEff = Number(p.tc) || Number(vForm.tc_venta) || null;
                        const pctEff = pctMetodo(m);
                        const factorEff = pctEff > 0 ? 1 / (1 - pctEff / 100) : 1;
                        // 2026-06-29 Multi-país F3: "arsDirect" → "localDirect": efectivo
                        // en moneda local (ARS o UYU) sin comisión va al input directo.
                        // Renombro la var para reflejar la nueva semántica país-aware.
                        const localDirect = pctEff === 0 && (p.moneda === 'ARS' || p.moneda === 'UYU');
                        const montoNum = Number(p.monto) || 0;
                        let derivedUsd = p.usd_input;
                        if (!localDirect && (derivedUsd === '' || derivedUsd === null) && montoNum > 0) {
                          // Derivar USD desde monto al cargar venta existente para edición.
                          if (p.moneda === 'USD' || p.moneda === 'USDT') {
                            derivedUsd = String(Math.round(montoNum / factorEff * 100) / 100);
                          } else if ((p.moneda === 'ARS' || p.moneda === 'UYU') && tcEff > 0) {
                            derivedUsd = String(Math.round(montoNum / factorEff / tcEff * 100) / 100);
                          }
                        }
                        return (
                          <div key={p._id}>
                            <div
                              data-testid="venta-pago-row"
                              style={{
                                display: 'grid',
                                gridTemplateColumns: showTc ? '1fr 110px 90px auto' : '1fr 110px auto',
                                gap: 6, alignItems: 'center',
                              }}
                            >
                              <select className="input" value={p.metodo_nombre} onChange={e => setPagoMetodo(i, e.target.value)}>
                                <option value="">Método…</option>
                                {metodos.map(mm => <option key={mm.id} value={mm.nombre}>{mm.nombre}</option>)}
                                <option value="__CC__">Cuenta corriente (deuda)</option>
                              </select>
                              <div style={{ position: 'relative' }}>
                                <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 11, pointerEvents: 'none' }}>
                                  {/* 2026-06-29 Multi-país F3: símbolo local del input ARS-direct
                                      ahora distingue $ (ARS) vs $U (UYU). */}
                                  {localDirect ? (p.moneda === 'UYU' ? '$U' : '$') : 'USD'}
                                </span>
                                {localDirect ? (
                                  <input
                                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                                    data-testid="venta-pago-ars"
                                    className="input mono" placeholder="730.000"
                                    value={p.monto}
                                    onChange={e => setPagoArsAmount(i, e.target.value)}
                                    style={{ paddingLeft: localDirect ? 22 : 36 }}
                                  />
                                ) : (
                                  <input
                                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                                    data-testid="venta-pago-usd"
                                    className="input mono" placeholder="500"
                                    value={derivedUsd}
                                    onChange={e => setPagoUsd(i, e.target.value)}
                                    style={{ paddingLeft: 36 }}
                                  />
                                )}
                              </div>
                              {showTc && (
                                <div style={{ position: 'relative' }}>
                                  <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 11, pointerEvents: 'none' }}>TC</span>
                                  <input
                                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                                    className="input mono" placeholder="1460"
                                    value={p.tc}
                                    onChange={e => setPagoTc(i, e.target.value)}
                                    style={{ paddingLeft: 30 }}
                                  />
                                </div>
                              )}
                              <button type="button" className="icon-btn" title="Quitar pago" aria-label="Quitar pago" onClick={() => rmPago(p._id)}><Icons.X size={14} /></button>
                            </div>
                            {showDesglose && (
                              <div
                                data-testid="venta-pago-desglose"
                                style={{
                                  marginTop: 8, display: 'grid',
                                  gridTemplateColumns: '1fr 1fr 1fr',
                                  gap: 10, fontSize: 12, alignItems: 'start',
                                  paddingLeft: 2,
                                }}
                              >
                                <div>
                                  <div className="muted tiny" style={{ marginBottom: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span>Le cobrás al cliente <span style={{ color: 'var(--text-muted)' }}>(editable)</span></span>
                                    {p.bruto_manual && (
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
                                    <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{sym(p.moneda)}</span>
                                    <input
                                      type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                                      className="input mono"
                                      value={p.bruto_manual ? (p.monto ?? '') : Math.round(det.brutoOrig * 100) / 100}
                                      onChange={e => setPagoBruto(i, e.target.value)}
                                      style={{ padding: '2px 6px', fontSize: 13, fontWeight: 600, width: 110 }}
                                    />
                                  </div>
                                </div>
                                <div>
                                  <div className="muted tiny" style={{ marginBottom: 2 }} title={m?.nombre || ''}>Financiera ({det.pct}%)</div>
                                  <div className="mono neg" style={{ fontWeight: 600, fontSize: 13 }}>−{sym(p.moneda)}{fmt(det.costoFinOrig)}</div>
                                </div>
                                <div>
                                  <div className="muted tiny" style={{ marginBottom: 2 }}>Entra a tu caja <span style={{ color: 'var(--text-muted)' }}>(editable)</span></div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                                    <input
                                      type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                                      className="input mono"
                                      value={p.neto_input || Math.round(det.netoOrig * 100) / 100}
                                      onChange={e => setPagoNeto(i, e.target.value)}
                                      style={{ padding: '2px 6px', fontSize: 13, fontWeight: 600, width: 110 }}
                                    />
                                    <span className="mono pos" style={{ fontWeight: 600, fontSize: 12 }}>= u$s{fmt(det.netoUsd)}</span>
                                  </div>
                                </div>
                              </div>
                            )}
                            <TcWarning tc={p.tc} />
                          </div>
                        );
                      })}
                    </div>
                    <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={addPago}><Icons.Plus size={13} /> Agregar método</button>
                  </div>

                  {/* 2026-07-13 (feature vuelto): sección para registrar el
                      cambio dado al cliente. Los 3 campos van juntos (monto +
                      moneda + caja de dónde sale). El backend postea un egreso
                      a la caja elegida — al cancelar la venta, se revierte
                      automáticamente. Colapsable: por defecto compacto con
                      link "Agregar vuelto"; se expande al hacer click. */}
                  <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: vForm.vuelto_monto ? 8 : 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>
                        Vuelto/Cambio
                        <span className="muted tiny" style={{ marginLeft: 8, fontWeight: 400 }}>
                          (opcional — dinero que entregás al cliente)
                        </span>
                      </div>
                      {vForm.vuelto_monto && (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => {
                          setVF('vuelto_monto', ''); setVF('vuelto_caja_id', '');
                        }}>Quitar</button>
                      )}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.5fr', gap: 8 }}>
                      <div>
                        <div className="muted tiny" style={{ marginBottom: 2 }}>Monto</div>
                        <input
                          type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                          className="input mono"
                          value={vForm.vuelto_monto}
                          onChange={e => setVF('vuelto_monto', e.target.value)}
                          placeholder="0"
                          style={{ width: '100%' }}
                        />
                      </div>
                      <div>
                        <div className="muted tiny" style={{ marginBottom: 2 }}>Moneda</div>
                        <select
                          className="input"
                          value={vForm.vuelto_moneda}
                          onChange={e => setVF('vuelto_moneda', e.target.value)}
                          style={{ width: '100%' }}
                        >
                          <option value="ARS">ARS</option>
                          <option value="UYU">UYU</option>
                          <option value="USD">USD</option>
                          <option value="USDT">USDT</option>
                        </select>
                      </div>
                      <div>
                        <div className="muted tiny" style={{ marginBottom: 2 }}>
                          Sale de{' '}
                          {vForm.vuelto_monto && !vForm.vuelto_caja_id && (
                            <span className="warn" style={{ fontWeight: 600 }}>· elegí caja</span>
                          )}
                        </div>
                        <select
                          className="input"
                          value={vForm.vuelto_caja_id}
                          onChange={e => setVF('vuelto_caja_id', e.target.value)}
                          style={{ width: '100%' }}
                        >
                          <option value="">— Elegí caja —</option>
                          {metodos.filter(m => !m.deleted_at).map(m => (
                            <option key={m.id} value={m.id}>{m.nombre} ({m.moneda})</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {/* 2026-07-14 (bug reportado por Lucas): TC del vuelto, visible
                       solo si moneda ∈ {ARS, UYU}. Sin este TC la Ganancia real
                       no puede descontar el vuelto en USD → mentía sobre la
                       rentabilidad de la venta. Backend rechaza el submit si
                       falta. Default sugerido: TC de la venta si está cargado. */}
                    {(vForm.vuelto_moneda === 'ARS' || vForm.vuelto_moneda === 'UYU') && vForm.vuelto_monto && (
                      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8, alignItems: 'center' }}>
                        <div>
                          <div className="muted tiny" style={{ marginBottom: 2 }}>
                            TC del vuelto{' '}
                            {!vForm.vuelto_tc && (
                              <span className="warn" style={{ fontWeight: 600 }}>· requerido</span>
                            )}
                          </div>
                          <input
                            type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys}
                            className="input mono"
                            value={vForm.vuelto_tc}
                            onChange={e => setVF('vuelto_tc', e.target.value)}
                            placeholder={vForm.tc_venta ? String(vForm.tc_venta) : 'Ej: 1000'}
                            style={{ width: '100%' }}
                          />
                        </div>
                        <div className="muted tiny">
                          Se usa para convertir el vuelto a USD y descontarlo de la
                          ganancia real. Podés cargar el TC del día o reusar el TC
                          de la venta si aplica.
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Totales */}
                  <div className="card card-tight" style={{ padding: '10px 14px' }}>
                    <div className="flex-between" style={{ fontSize: 13 }}><span className="muted">Total venta</span><span className="mono" style={{ fontWeight: 700 }}>u$s{fmt(totales.items)}</span></div>
                    <div className="flex-between" style={{ fontSize: 13 }}>
                      <span
                        className="muted"
                        title="Suma de lo que paga el cliente (brutos) + canjes. La comisión de financiera/tarjeta no descuenta acá — se ve reflejada en Ganancia real."
                      >
                        Pagos
                        {(vForm.canjes || []).length > 0 ? ` + ${vForm.canjes.length} canje${vForm.canjes.length > 1 ? 's' : ''}` : ''}
                      </span>
                      <span className="mono">u$s{fmt(totales.cubierto)}</span>
                    </div>
                    <div className="flex-between" style={{ fontSize: 13 }}><span className="muted">Diferencia</span>
                      <span>{Math.abs(totales.dif) < 0.01 ? <span className="pos">Cubierto ✓</span> : totales.dif < 0 ? <span className="neg">Falta u$s{fmt(-totales.dif)}</span> : <span className="warn">Sobra u$s{fmt(totales.dif)}</span>}</span>
                    </div>
                    {/*
                      Tema C en-vivo (2026-06-14, rev2): preview de ganancia.
                      Modelo nuevo (alineado con Lucas): ganancia real = lo que
                      EFECTIVAMENTE percibimos (cubierto) − costos. Si el operador
                      pasó el recargo al cliente, el neto cubre el precio y la
                      ganancia real ≡ bruta. Si no lo pasó, la ganancia real cae
                      por la comisión que se come la financiera/procesadora.

                      2026-07-14 (bug reportado por Lucas): cuando la venta era
                      una PÉRDIDA (sin cobrar todo o pago 0), el preview salía
                      con el monto absoluto en verde ("u$s720") en vez de reflejar
                      la pérdida. Causa: `fmt()` hace Math.abs por diseño, y la
                      class `pos` estaba hardcoded. Fix: label dinámico
                      "Pérdida" cuando real < 0, color rojo, prefijo "−".
                      Mismo tratamiento para Ganancia bruta.
                    */}
                    {cart.length > 0 && (() => {
                      // Threshold chico para evitar flip por floating-point (ej: -0.001).
                      const brutaNeg = totales.bruta < -0.005;
                      const realNeg  = totales.real  < -0.005;
                      const realPos  = totales.real  >  0.005;
                      // 2026-07-14: si hay vuelto, mostramos su impacto USD como
                      // línea propia para que el operador vea CUÁNTO baja la
                      // ganancia por darlo. Solo visible si vueltoUsd > 0.
                      const hayVueltoUsd = (totales.vueltoUsd || 0) > 0.005;
                      return (
                        <div data-testid="ganancia-preview" style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
                          <div className="flex-between" style={{ fontSize: 13 }}>
                            <span className="muted">{brutaNeg ? 'Pérdida bruta' : 'Ganancia bruta'}</span>
                            <span className={`mono ${brutaNeg ? 'neg' : ''}`}>
                              {brutaNeg ? '−' : ''}u$s{fmt(totales.bruta)}
                            </span>
                          </div>
                          {hayVueltoUsd && (
                            <div className="flex-between" style={{ fontSize: 13 }}>
                              <span className="muted">Vuelto entregado</span>
                              <span className="mono neg">−u$s{fmt(totales.vueltoUsd)}</span>
                            </div>
                          )}
                          <div className="flex-between" style={{ fontSize: 13, borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
                            <span style={{ fontWeight: 600 }}>{realNeg ? 'Pérdida' : 'Ganancia real'}</span>
                            <span
                              className={`mono ${realNeg ? 'neg' : realPos ? 'pos' : ''}`}
                              style={{ fontWeight: 700 }}
                            >
                              {realNeg ? '−' : ''}u$s{fmt(totales.real)}
                            </span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Comprobantes */}
                  <div className="field">
                    <label className="field-label">Comprobantes de pago (imágenes/PDF, máx 6MB c/u)</label>
                    <input type="file" multiple accept="image/*,application/pdf" className="input" onChange={onComprobFiles} />
                    {comprobantes.length > 0 && <div className="muted tiny" style={{ marginTop: 4 }}>{comprobantes.length} archivo(s) listo(s)</div>}
                    {/* OCR del comprobante (Tema C rev5 — paridad con Financiera).
                        Mismo endpoint /api/ocr que el módulo Transferencias. Aplica
                        al "Entra a tu caja" del pago Financiera (o primer no-CC). */}
                    {ocrSugerencia.status === 'pending' && (
                      <div className="muted tiny" style={{ marginTop: 4 }}>Leyendo monto del comprobante…</div>
                    )}
                    {ocrSugerencia.status === 'done' && ocrSugerencia.monto > 0 && (
                      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span className="muted tiny">Detectamos en el comprobante:</span>
                        <span className="mono" style={{ fontWeight: 600 }}>${fmt(ocrSugerencia.monto)}</span>
                        <button type="button" className="btn btn-sm" onClick={aplicarOcrMonto}>Aplicar al pago</button>
                      </div>
                    )}
                    {ocrSugerencia.status === 'error' && (
                      <div className="muted tiny" style={{ marginTop: 4, color: 'var(--neg)' }}>No se pudo leer el monto. Cargalo a mano.</div>
                    )}
                  </div>

                  <div className="field"><label className="field-label">Observaciones</label><input className="input" placeholder="Notas adicionales…" value={vForm.notas} onChange={e => setVF('notas', e.target.value)} /></div>
                  {ventaError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{ventaError}</div>}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowVenta(false)}>Cancelar</button>
                {/* data-testid agregado para E2E (TANDA 5 venta retail) — el texto
                    del botón muta a "Guardando…" durante el submit; el testid es
                    estable contra ese cambio. */}
                <button type="submit" className="btn btn-primary" data-testid="venta-submit" disabled={savingVenta}>{savingVenta ? 'Guardando…' : 'Guardar venta'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal Venta rápida ── */}
      {/* 2026-06-24 redesign: 1 textarea libre + datetime, sin vendedor/cliente
          estructurados (esos se llenan al convertir a venta completa). Inspirado
          por referencia que trajo Lucas. Layout: instrucciones arriba, fecha y
          notas debajo. Header con icon ⚡ para identidad visual. */}
      {showRapida && (
        <div ref={rapidaModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowRapida(false)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icons.Bolt size={18} /> Nueva Venta Rápida
              </h3>
              <button type="button" className="icon-btn" onClick={() => setShowRapida(false)} aria-label="Cerrar" title="Cerrar"><Icons.X size={16} /></button>
            </div>
            <form onSubmit={handleSaveRapida}>
              <div className="modal-body">
                {/* Info box estilo "info" — bg sutil con accent-soft + border accent-ring. */}
                <div style={{
                  background: 'var(--accent-soft)',
                  border: '1px solid var(--accent-ring)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  marginBottom: 14,
                  fontSize: 12.5,
                  lineHeight: 1.5,
                }}>
                  <strong>Instrucciones:</strong> Escribí toda la info de la venta abajo —
                  producto, accesorios, vendedor, cliente, precio, método de pago. Después la
                  cargás como venta completa con los datos estructurados.
                </div>
                <div className="field">
                  <label className="field-label">Fecha y hora de la venta</label>
                  <input
                    type="datetime-local"
                    className="input mono"
                    value={rForm.fechaHora}
                    onChange={e => setRForm(f => ({ ...f, fechaHora: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label className="field-label">Notas de la venta <span style={{ color: 'var(--neg)' }}>*</span></label>
                  <textarea
                    className="input"
                    rows={9}
                    style={{ height: 'auto', padding: 10, fontFamily: 'inherit', lineHeight: 1.5, resize: 'vertical' }}
                    placeholder={`Ejemplo:
iPhone 14 Pro 128GB Azul - $850.000
Funda + Vidrio templado - $15.000
Vendedor: Juan Pérez
Cliente: María González (11-2345-6789)
Pago: Efectivo + Transferencia`}
                    value={rForm.detalle}
                    onChange={e => setRForm(f => ({ ...f, detalle: e.target.value }))}
                  />
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowRapida(false)}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={savingRapida || !rForm.detalle.trim()}>
                  <Icons.Bolt size={13} /> {savingRapida ? 'Guardando…' : 'Guardar Venta Rápida'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}


      {/* ── Modal Garantías ── */}
      {showGarantias && (
        <div ref={garantiasModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowGarantias(false)}>
          <div className="modal" style={{ maxWidth: 720 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>Plantillas de garantía</h3><button type="button" className="icon-btn" onClick={() => setShowGarantias(false)} aria-label="Cerrar" title="Cerrar"><Icons.X size={16} /></button></div>
            {/* 2026-07-11: removido maxHeight:74vh + overflowY:auto — el .modal
                ya es flex column con max-height calc(100svh - 48px), y el
                .modal-body base tiene flex:1 + overflow-y:auto. El body es hijo
                directo del .modal (sin form wrapper que rompa el chain), así que
                el scroll interno funciona sin overrides. */}
            <div className="modal-body">
              <div className="stack" style={{ gap: 6, marginBottom: 14 }}>
                {garantias.length === 0 && <div className="empty">Sin plantillas</div>}
                {garantias.map(g => (
                  <div key={g.id} className="flex-between" style={{ gap: 8, padding: '8px 0', borderBottom: '1px solid var(--hairline)', alignItems: 'flex-start' }}>
                    {/* Preview renderiza `{{negocio}}` como el nombre del tenant así el
                        operador ve cómo va a quedar el comprobante final, no el placeholder crudo. */}
                    <div style={{ fontSize: 13, maxWidth: '78%' }}><strong>{g.nombre}</strong>{g.es_default && <> <Badge tone="pos">Predeterminada</Badge></>}<div className="muted tiny" style={{ whiteSpace: 'pre-wrap', maxHeight: 50, overflow: 'hidden' }}>{renderPlantilla(g.texto, tenantNombre)}</div></div>
                    <div className="flex-row" style={{ gap: 6, flexShrink: 0 }}>
                      <button className="icon-btn" title="Editar plantilla" aria-label="Editar plantilla de garantía" onClick={() => setGForm({ id: g.id, nombre: g.nombre, texto: g.texto, es_default: !!g.es_default })}><Icons.Edit size={14} /></button>
                      <button className="icon-btn" title="Eliminar plantilla" aria-label="Eliminar plantilla de garantía" style={{ color: 'var(--neg)' }} onClick={() => deleteGarantia(g.id)}><Icons.Trash size={14} /></button>
                    </div>
                  </div>
                ))}
              </div>
              <form onSubmit={handleSaveGarantia}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>{gForm.id ? 'Editar plantilla' : 'Nueva plantilla'}</div>
                <div className="field"><label className="field-label">Nombre <span style={{ color: 'var(--neg)' }}>*</span></label><input className="input" placeholder="General, Apple discontinuado…" value={gForm.nombre} onChange={e => setGForm(f => ({ ...f, nombre: e.target.value }))} /></div>
                <div className="field">
                  <label className="field-label">Texto <span style={{ color: 'var(--neg)' }}>*</span></label>
                  <textarea
                    className="input"
                    rows={10}
                    value={gForm.texto}
                    onChange={e => setGForm(f => ({ ...f, texto: e.target.value }))}
                    style={{ height: 'auto', minHeight: 220, padding: '12px 14px', lineHeight: 1.55, fontSize: 14, resize: 'vertical', whiteSpace: 'pre-wrap' }}
                  />
                  <div className="muted tiny" style={{ marginTop: 4 }}>
                    Tip: escribí <code>{PLACEHOLDER_NEGOCIO}</code> donde quieras que aparezca el nombre de tu negocio. Al imprimir el comprobante se reemplaza automáticamente por <strong>{tenantNombre}</strong>.
                  </div>
                </div>
                <label className="flex-row" style={{ gap: 8, fontSize: 13, marginBottom: 10, cursor: 'pointer' }}><input type="checkbox" checked={gForm.es_default} onChange={e => setGForm(f => ({ ...f, es_default: e.target.checked }))} /> Marcar como predeterminada</label>
                <div className="flex-row" style={{ gap: 8 }}>
                  <button type="button" className="btn btn-ghost" onClick={() => setGForm({ id: null, nombre: '', texto: '', es_default: false })}>Limpiar</button>
                  <button type="submit" className="btn btn-primary" disabled={savingGar}>{savingGar ? 'Guardando…' : 'Guardar plantilla'}</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal etiquetas ── */}
      {showEtiquetas && (
        <div ref={etiquetasModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowEtiquetas(false)} role="dialog" aria-modal="true" aria-labelledby="etiquetas-modal-title">
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3 id="etiquetas-modal-title">Etiquetas de venta</h3><button className="icon-btn" title="Cerrar" aria-label="Cerrar" onClick={() => setShowEtiquetas(false)}><Icons.X size={16} /></button></div>
            <div className="modal-body">
              <div className="flex-row" style={{ gap: 6, marginBottom: 10 }}>
                <input className="input" placeholder="Nueva etiqueta (ej. Mayorista)" value={nuevaEtiqueta} onChange={e => setNuevaEtiqueta(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEtiqueta(); } }} />
                <button className="btn btn-sm" onClick={addEtiqueta}><Icons.Plus size={13} /></button>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                {etiquetas.length === 0 && <div className="muted tiny">Sin etiquetas</div>}
                {etiquetas.map(et => (
                  <div key={et.id} className="flex-between" style={{ fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--hairline)' }}>
                    <span>{et.nombre}</span>
                    <button className="icon-btn" title="Eliminar etiqueta" aria-label="Eliminar etiqueta" style={{ color: 'var(--neg)' }} onClick={() => delEtiqueta(et.id)}><Icons.Trash size={13} /></button>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-primary" onClick={() => setShowEtiquetas(false)}>Listo</button></div>
          </div>
        </div>
      )}

      {/* ── Modal catálogo de vendedores (2026-07-01) ──
          onChange refresca el state local para que el dropdown de "Nueva
          venta" refleje inmediatamente los cambios sin refetch redundante. */}
      <VendedoresCatalogModal
        open={showVendedoresModal}
        onClose={() => setShowVendedoresModal(false)}
        onChange={setVendedores}
      />

      {/* ── Modal ver comprobantes adjuntos ── */}
      {showComprob != null && (
        <div ref={comprobModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowComprob(null)} role="dialog" aria-modal="true" aria-labelledby="comprob-modal-title">
          <div className="modal" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3 id="comprob-modal-title">Comprobantes de la venta</h3><button className="icon-btn" title="Cerrar" aria-label="Cerrar" onClick={() => setShowComprob(null)}><Icons.X size={16} /></button></div>
            <div className="modal-body">
              {comprobList == null ? <div className="muted">Cargando…</div> : comprobList.length === 0 ? <div className="empty">Sin comprobantes</div> : (
                comprobList.map(c => (
                  <div key={c.id} className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--hairline)' }}>
                    <span style={{ fontSize: 13 }}>{c.archivo_nombre || 'archivo'}</span>
                    <button className="btn btn-sm" onClick={() => abrirComprob(c.id)}><Icons.Eye size={13} /> Ver</button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal: diferencia en métodos de pago. Custom (no ConfirmModal) para
          tener desglose visual con colores y dos acciones: corregir / aceptar igual. */}
      <DiffModal
        state={diffModal}
        onClose={() => setDiffModal({ open: false, items: 0, cubierto: 0, dif: 0, resolve: null })}
      />

      {/* #509 — Modal focalizado para editar el "atendido por" del comprobante
          post-emisión. Se abre desde el icono Users en cada fila de la grilla. */}
      <EditarVendedorModal
        state={editarVendedor}
        onClose={() => setEditarVendedor({ open: false, venta: null })}
        onSave={saveVendedorNombre}
        vendedores={vendedores}
      />

      {/* Modal: venta guardada con opción de descargar PDF (lazy import del
          módulo para no inflar el bundle principal — solo se carga cuando el
          usuario hace click). */}
      <ExitoModal
        state={exitoModal}
        onClose={() => setExitoModal({ open: false, venta: null })}
        pdfLoading={pdfLoading}
        // #475 — handler de reenvío del comprobante por mail desde el modal éxito.
        // Pre-llena el email destino con el que el operador cargó en el form +
        // permite editarlo via prompt() (simplest UX que no requiere modal nuevo).
        // Si el operador acepta, llamamos al endpoint inline y mostramos el
        // resultado por toast.
        onReenviarEmail={async (venta) => {
          const defaultEmail = venta?.cliente_email || '';
          const dest = window.prompt('Reenviar comprobante a:', defaultEmail);
          if (!dest) return;
          const destTrim = dest.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destTrim)) {
            toast.error('Email inválido');
            return;
          }
          try {
            await ventas.enviarComprobante(venta.id, { email: destTrim });
            toast.success(`Comprobante reenviado a ${destTrim}`);
          } catch (err) {
            toast.error('No se pudo reenviar: ' + (err.message || 'error desconocido'));
          }
        }}
        onDescargar={(venta) => withPdfLoading(async () => {
          try {
            const mod = await import('../lib/generarComprobantePdf');
            await mod.generarComprobantePdf(venta, { tenantNombre });
          } catch (e) {
            // Mostramos el error real para que el usuario lo pueda reportar
            // sin tener que abrir la consola. El stack queda en console.error
            // como antes para debugging.
            console.error('PDF error:', e);
            const detalle = e?.message || String(e);
            toast.error(`No se pudo generar el comprobante PDF: ${detalle}`, { duration: 12000 });
          }
        })}
      />
    </div>
  );
}
