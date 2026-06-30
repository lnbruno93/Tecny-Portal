import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icons } from '../components/Icons';
import { inventario, proveedores as proveedoresApi, cajas as cajasApi, redB2b } from '../lib/api';
import { userHasCap } from '../lib/userHasCap';
import { RedB2BPendingReviewContent } from './RedB2BPendingReview';
import { exportCsv } from '../lib/exportCsv';
import { readXlsxRows, writeXlsx } from '../lib/xlsx';
import { mapStockRows, extractNewCatalogos, groupRowsByProveedor, buildBulkMovimientosPayload, findDuplicateImeis } from '../lib/importStock';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { isTenantAdmin } from '../lib/userHasCap'; // 2026-06-25 Bug #1 — fix owner gating
import { useConfirm } from '../components/ConfirmModal';
import EditableCell from '../components/EditableCell';
import ScrollFadeX from '../components/ScrollFadeX'; // #F-4
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import useModal from '../lib/useModal';
import { fmt, fmtMoney } from '../lib/format';
import Badge from '../components/Badge';
import Seg from '../components/Seg';
import { SkeletonRow } from '../components/Skeleton';
// 2026-06-29 Multi-país F3: dropdowns moneda gated por tenant.pais.
import { useMonedasTenant } from '../lib/useMonedasTenant';


// ─── Formatters ────────────────────────────────────────────────────────────────
// `fmt` y `fmtMoney` vienen de '../lib/format' (Hygiene H2 + U-05 auditoría
// 2026-06-10). Alias local para no tocar todos los callsites — `money` se
// resuelve a `fmtMoney` y comparte la convención ARS=$ / USD=u$s / USDT.
const money = fmtMoney;

// ─── Constantes ──────────────────────────────────────────────────────────────
const EMPTY_PRODUCTO = {
  tipo_carga: 'unitario', clase: 'celular', nombre: '', imei: '', gb: '', color: '',
  bateria: '', categoria_id: '', deposito_id: '', proveedor: '',
  costo: '', costo_moneda: 'USD', precio_venta: '', precio_moneda: 'USD',
  cantidad: '1', estado: 'disponible', observaciones: '',
  condicion: 'nuevo',
};

// Opciones del selector "Vista" — encapsulan combinaciones de estado + oculto.
// Mismo enum que el backend (backend/src/schemas/inventario.js: VISTAS_INVENTARIO).
// Labels reformulados (#M-08): la doble negación "no vendidos" confundía. Ahora
// describen QUÉ se muestra, no qué se excluye. Ojo: NO renombrar los `value` —
// son contrato con el backend.
const VISTAS = [
  { value: 'no_vendidos',         label: 'En stock (visible)' },
  { value: 'no_vendidos_ocultos', label: 'En stock pero ocultos' },
  { value: 'ocultos',             label: 'Todo lo oculto (stock + vendido)' },
  { value: 'vendidos',            label: 'Vendidos' },
  { value: 'todos_visibles',      label: 'Todo lo visible (stock + vendido)' },
  { value: 'todos_ocultos',       label: 'Todo (visible + oculto)' },
];

const ESTADO_DISPLAY = {
  disponible: { label: 'Disponible', tone: 'pos' },
  vendido:    { label: 'Vendido',    tone: 'default' },
  en_tecnico: { label: 'En técnico', tone: 'warn' },
  reservado:  { label: 'Reservado',  tone: 'info' },
};

// Encabezados EXACTOS de la planilla del negocio (misma base para importar y exportar).
const PLANTILLA_HEADERS = ['Nombre', 'GB(solo iph)', 'BATERIA(solo iph)', 'COLOR(solo iph)', 'COSTO',
  'MONEDA COSTO(ARS/USD)', 'PRECIO', 'MONEDA PRECIO(ARS/USD)', 'IMEI(solo iph)', 'TIPO(unitario, stock)',
  'CATEGORIA', 'PROVEEDOR', 'STOCK(solo acc)', 'ID DEPOSITO(SÓLO NÚMERO)'];
// Filas de ejemplo: un celular (IMEI, sin STOCK) y un accesorio (STOCK, sin IMEI).
const PLANTILLA_EJEMPLO = [
  ['iPhone 15 Pro', '256', '92', 'Natural', '800', 'USD', '950', 'USD', '356938035643809', 'Unitario', 'iPhone Nuevo', 'Juan Distribuidor', '', '1'],
  ['Funda iPhone 15', '', '', '', '3', 'USD', '8', 'USD', '', 'stock', 'Accesorios', 'Mayorista Acc', '20', '1'],
];

// Parser CSV mínimo (soporta comillas, comas y saltos dentro de campos).
// Salteamos la primera línea si es el hint `sep=,` que emite exportCsv para
// que Excel ES abra el archivo con columnas separadas — no es un dato.
function parseCsv(text) {
  text = text.replace(/^\uFEFF?sep=.\r?\n/i, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(v => v.trim() !== '')) rows.push(row); }
  return rows;
}

// ─── Pantalla ──────────────────────────────────────────────────────────────────
// Badge y Seg ahora viven en frontend/src/components/ (U-13 dedup, auditoría
// 2026-06-10) — importados arriba.
export default function Inventario() {
  const { toast } = useToast();
  const confirm = useConfirm();
  // Safe destructure: useAuth() puede devolver null en tests que renderean
  // el componente sin AuthProvider. En prod siempre hay user (RequireAuth
  // gate-keep arriba en App.jsx).
  const { user } = useAuth() || {};
  // 2026-06-25 Bug #1: usar isTenantAdmin (incluye tenant_cap_rol owner+admin)
  // en vez de solo `user?.role === 'admin'`. Antes el owner del tenant NO veía
  // el botón "Vaciar stock + compras" porque su role global no es 'admin'.
  const isAdmin = isTenantAdmin(user);
  // PR-X3 #465: el tab "Pendientes Red B2B" solo aparece para usuarios con
  // cap cross_tenant.write (mismo gate que tenía el sidebar item original).
  // Si no hay user (tests sin AuthProvider), la cap evalúa false → tab oculto,
  // que es el comportamiento conservador correcto.
  const canSeeRedB2B = userHasCap(user, 'cross_tenant.write');
  // 2026-06-29 Multi-país F3: monedas operativas del tenant. Si pais=UY,
  // los dropdowns de costo_moneda/precio_moneda muestran UYU en vez de ARS.
  const { monedas, monedaLocal } = useMonedasTenant();
  const { setPrimaryAction } = usePageActions();

  const [productos, setProductos] = useState([]);
  const [metricas, setMetricas] = useState(null);
  const [categorias, setCategorias] = useState([]);
  const [depositos, setDepositos] = useState([]);
  const [proveedoresList, setProveedoresList] = useState([]); // distinct, para combo de edición inline
  // Lista del catálogo formal de proveedores (tabla `proveedores`, con id) —
  // necesaria para el auto-create en el import: matching case-insensitive
  // contra los existentes para evitar duplicados por typo de mayúsculas/espacios.
  const [proveedoresCatalogo, setProveedoresCatalogo] = useState([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // ── Drill-down desde Desglose 360 ──
  // Si llegamos con query params (?proveedor=X, ?categoria_id=N, etc.) los aplicamos
  // al fetch como filtros adicionales y mostramos un chip "Filtrado por: X · Limpiar".
  // No agregamos UI permanente: si el usuario quiere editar el filtro, vuelve al desglose.
  const [searchParams, setSearchParams] = useSearchParams();
  const drillFilters = useMemo(() => {
    const ALLOWED = ['categoria_id', 'deposito_id', 'estado', 'proveedor', 'nombre', 'gb', 'color'];
    const out = {};
    for (const k of ALLOWED) {
      const v = searchParams.get(k);
      if (v) out[k] = v;
    }
    return out;
  }, [searchParams]);
  const hasDrillDown = Object.keys(drillFilters).length > 0;
  function clearDrillDown() { setSearchParams({}); }

  // ── Filtros principales — persistidos en URL ──
  // El filtro de "pestañas" admite ahora valores compuestos:
  //   'todos' | 'celular' | 'accesorio' | 'tecnico' | 'usados' | 'cat:<id>'
  // Esto permite mezclar tabs fijos (claseFilter clásico), el atributo nuevo
  // 'usados' (condicion=usado) y categorías administrables (categoria_id=N).
  //
  // Auditoría 2026-06-30 F-08: claseFilter / vistaFiltro / search ahora viven
  // en la URL (?clase=, ?vista=, ?q=). categoria_id ya se persistía vía el
  // drill-down. Defaults NO escriben URL. setSearchParams con replace:true
  // evita inflar la history en typing rápido.
  const claseFilter = searchParams.get('clase') || 'todos';
  const vistaFiltro = searchParams.get('vista') || 'no_vendidos';
  const search = searchParams.get('q') || '';
  const setParam = useCallback((key, value, def) => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === def) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const setClaseFilter = useCallback((v) => setParam('clase', v, 'todos'), [setParam]);
  const setVistaFiltro = useCallback((v) => setParam('vista', v, 'no_vendidos'), [setParam]);
  const setSearch = useCallback((v) => setParam('q', v, ''), [setParam]);

  // Search debounceada: no dispara una request al backend (con ILIKE multi-columna +
  // COUNT(*)) en cada keystroke; espera 350ms tras la última tecla.
  const dSearch = useDebouncedValue(search, 350);

  // ── PR-X3 #465: tab principal "Productos" vs "Pendientes Red B2B" ─────────
  // El tab Pendientes vive ACÁ porque conceptualmente son productos auto-
  // creados por partners que esperan revisión — el operador los maneja en
  // el mismo módulo donde gestiona stock, sin saltar a una pantalla aparte.
  // Sincronizamos con ?tab= para que back/forward y refresh preserven el
  // estado, y para que el redirect de la ruta legacy /red-b2b/pending-review
  // (→ /inventario?tab=red-b2b-pending) caiga directo en el tab correcto.
  const tabParam = searchParams.get('tab');
  const initialMainTab = (tabParam === 'red-b2b-pending' && canSeeRedB2B) ? 'red-b2b-pending' : 'productos';
  const [mainTab, setMainTab] = useState(initialMainTab);
  // Counter del badge del tab. Empezamos en null para no mostrar 0 antes
  // de que sepamos (mejor mostrar el tab sin badge que parpadear "0" → "N").
  const [pendingCount, setPendingCount] = useState(null);

  function selectMainTab(id) {
    setMainTab(id);
    // Preservamos los params existentes que no sean 'tab' (drill-down de
    // desglose 360, etc.) y solo tocamos la key 'tab'.
    const next = new URLSearchParams(searchParams);
    if (id === 'productos') next.delete('tab');
    else next.set('tab', id);
    setSearchParams(next, { replace: true });
  }

  // ── Counter polling del tab "Pendientes Red B2B" ──────────────────────────
  // PR-X1 eliminó el polling de Shell.jsx (cada 2min para todos los users de
  // un tenant). Acá lo re-introducimos limitado a usuarios con cap
  // cross_tenant.write — los únicos que verán el tab — y a 120s para no
  // sobrecargar el backend. El fetch inicial corre on-mount; los siguientes
  // a intervalo regular. El callback `onCountChange` del Content (al
  // refrescar tras una acción confirmar/mergear) también actualiza este
  // counter sin necesidad de un round-trip extra.
  useEffect(() => {
    if (!canSeeRedB2B) return undefined;
    let cancelled = false;
    async function fetchCount() {
      try {
        const r = await redB2b.productosPendingReview.list();
        if (!cancelled) {
          setPendingCount(Array.isArray(r?.pendientes) ? r.pendientes.length : 0);
        }
      } catch {
        if (!cancelled) setPendingCount(0); // best-effort: si 403/network, no spamear toast
      }
    }
    fetchCount();
    const interval = setInterval(fetchCount, 120000); // 120s
    return () => { cancelled = true; clearInterval(interval); };
  }, [canSeeRedB2B]);

  // Modal alta/edición
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_PRODUCTO);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  // 2026-06-30 #imei-dup: warning inline cuando el IMEI tipeado ya está
  // cargado en otro producto activo. Lo seteamos en onBlur del input para
  // feedback temprano (antes del submit) y lo re-chequeamos en handleSave
  // para bloquear de forma autoritativa. Vacío = sin warning.
  const [imeiWarning, setImeiWarning] = useState('');
  // Flag para evitar disparar el chequeo onBlur dos veces consecutivas con
  // el mismo IMEI (ej. usuario tab-tab-tab por el form), o cuando el blur
  // viene de un IMEI que ya validamos.
  const lastCheckedImeiRef = useRef('');
  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Modal historial (Fase 2 trazabilidad, 2026-06-15)
  const [historialProductoId, setHistorialProductoId] = useState(null);
  const [historialData, setHistorialData] = useState(null);
  const [historialLoading, setHistorialLoading] = useState(false);
  const [historialError, setHistorialError] = useState('');
  const historialModalRef = useRef(null);
  // Modal import
  const [showImport, setShowImport] = useState(false);
  const [importRows, setImportRows] = useState([]);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  // Multi-proveedor (2026-06-14): después de mapear las filas, agrupamos por
  // proveedor para generar una compra por grupo. importGroups guarda la
  // config (proveedor seleccionado, monto, moneda, TC, caja) por grupo.
  // Espejo del modal "Cargar compra" en Proveedores.jsx — un grupo = un movimiento.
  const [importGroups, setImportGroups] = useState([]);
  // Cajas (métodos de pago) — para el selector de cada grupo. Lista lite sin
  // saldos. Cargada una vez en loadCatalogos.
  const [cajasList, setCajasList] = useState([]);

  // Modal catálogos (categorías + depósitos)
  const [showCatalogos, setShowCatalogos] = useState(false);
  const [nuevaCat, setNuevaCat] = useState('');
  const [nuevoDep, setNuevoDep] = useState('');
  const [catError, setCatError] = useState('');

  // useModal hooks — auditoría 2026-06-06 UX B2: Esc cierra los 3 modales
  // (form de producto, import xlsx, catálogos), focus trap, body scroll lock.
  // Antes eran <div className="modal-overlay"> con click-outside pero sin Esc.
  const formModalRef = useRef(null);
  const importModalRef = useRef(null);
  const catalogosModalRef = useRef(null);
  useModal({ open: showForm, onClose: () => setShowForm(false), overlayRef: formModalRef });
  useModal({ open: showImport, onClose: () => !importing && setShowImport(false), overlayRef: importModalRef });
  useModal({ open: showCatalogos, onClose: () => setShowCatalogos(false), overlayRef: catalogosModalRef });
  useModal({
    open: historialProductoId != null,
    onClose: () => { setHistorialProductoId(null); setHistorialData(null); setHistorialError(''); },
    overlayRef: historialModalRef,
  });

  // Fetch del historial cuando el modal se abre. Si el user cambia de producto
  // sin cerrar (caso teórico, no soportamos navegación entre productos hoy),
  // dispara un nuevo fetch.
  useEffect(() => {
    if (historialProductoId == null) return;
    let cancelled = false;
    setHistorialLoading(true);
    setHistorialError('');
    setHistorialData(null);
    inventario.historial(historialProductoId)
      .then(d => { if (!cancelled) setHistorialData(d); })
      .catch(e => { if (!cancelled) setHistorialError(e?.message || 'No se pudo cargar el historial'); })
      .finally(() => { if (!cancelled) setHistorialLoading(false); });
    return () => { cancelled = true; };
  }, [historialProductoId]);

  // ── Carga de datos ──
  const loadProductos = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 50, vista: vistaFiltro };
      // Resolución del tab activo:
      //   - celular / accesorio → params.clase
      //   - tecnico            → params.estado = en_tecnico
      //   - usados             → params.condicion = usado
      //   - cat:<id>           → params.categoria_id
      //   - todos              → sin filtro extra
      if (claseFilter === 'celular' || claseFilter === 'accesorio') params.clase = claseFilter;
      else if (claseFilter === 'tecnico') params.estado = 'en_tecnico';
      else if (claseFilter === 'usados') params.condicion = 'usado';
      else if (claseFilter && claseFilter.startsWith('cat:')) params.categoria_id = claseFilter.slice(4);
      if (dSearch.trim()) params.buscar = dSearch.trim();
      // Drill-down: aplicamos los filtros que vinieron por URL al fetch.
      // El backend rechaza claves desconocidas (Zod), así que sólo pasamos lo válido.
      // Importante: el drill-down sobreescribe la vista a 'todos_ocultos' para que el
      // usuario vea TODO lo que matchea el desglose, no sólo no-vendidos.
      if (Object.keys(drillFilters).length) {
        Object.assign(params, drillFilters);
        params.vista = 'todos_ocultos';
      }
      const res = await inventario.productos(params);
      setProductos(res.data || []);
      setTotal(res.pagination?.total || 0);
      setPages(res.pagination?.pages || 1);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [page, claseFilter, vistaFiltro, dSearch, toast, drillFilters]);

  const loadMetricas = useCallback(async () => {
    try { setMetricas(await inventario.metricas()); } catch (_) {}
  }, []);

  const loadCatalogos = useCallback(async () => {
    try {
      const [c, d, prov, provCat, cajas] = await Promise.all([
        inventario.categorias(),
        inventario.depositos(),
        inventario.proveedoresList().catch(() => []),
        // Catálogo formal de proveedores — paginado, le pedimos un límite alto
        // porque típicamente Lucas tiene <100 proveedores y necesitamos toda la lista
        // para el match del auto-create.
        proveedoresApi.list({ limit: 500 }).catch(() => ({ data: [] })),
        // Cajas (lite, sin saldos) para el selector del modal multi-proveedor
        // de import. Si falla → array vacío (el selector quedará deshabilitado
        // con un mensaje claro).
        cajasApi.listMetodosPago().catch(() => []),
      ]);
      setCategorias(c); setDepositos(d); setProveedoresList(prov || []);
      // El endpoint paginado devuelve { data, pagination }; unwrap defensivo.
      setProveedoresCatalogo(Array.isArray(provCat) ? provCat : (provCat?.data || []));
      setCajasList(Array.isArray(cajas) ? cajas : []);
    } catch (_) {}
  }, []);

  useEffect(() => { loadCatalogos(); loadMetricas(); }, [loadCatalogos, loadMetricas]);
  useEffect(() => { loadProductos(); }, [loadProductos]);

  // Auditoría 2026-06-30 F-26: catOptions/provOptions usados en cada fila
  // del map de la grilla — antes se construían dentro del .map (N veces por
  // render). Con useMemo se construyen 1 sola vez por cambio real de
  // categorias/proveedoresList.
  const catOptions = useMemo(
    () => categorias.map(c => ({ value: c.id, label: c.nombre })),
    [categorias]
  );
  const provOptions = useMemo(
    () => proveedoresList.map(s => ({ value: s, label: s })),
    [proveedoresList]
  );

  // ── Edición inline: PATCH un campo y mergear en memoria ──
  // Optimismo controlado: actualizamos el state ANTES de la respuesta,
  // pero re-cargamos métricas / categorías al final por si cambió costo o categoría
  // (afecta inv_*_usd y productos_count). En caso de error, revertimos.
  const inlineUpdate = useCallback(async (id, field, value) => {
    const before = productos.find(p => p.id === id);
    if (!before) return;
    // Update optimista
    setProductos(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p));
    try {
      const updated = await inventario.updateProducto(id, { [field]: value });
      // Reemplazamos con la fila normalizada por el backend
      // (puede haber rellenado categoria_nombre, etc., si el front sólo conocía categoria_id).
      setProductos(prev => prev.map(p => p.id === id ? { ...p, ...updated, categoria_nombre: categorias.find(c => c.id === updated.categoria_id)?.nombre ?? p.categoria_nombre, deposito_nombre: depositos.find(d => d.id === updated.deposito_id)?.nombre ?? p.deposito_nombre } : p));
      // Recargo métricas (costo/precio/cantidad pueden haber cambiado).
      loadMetricas();
      // Si cambió la categoría → conteo por categoría también cambia.
      if (field === 'categoria_id') loadCatalogos();
      // Si tocaron proveedor → puede haber un nombre nuevo a sumar al combo.
      if (field === 'proveedor') loadCatalogos();
    } catch (e) {
      // Rollback
      setProductos(prev => prev.map(p => p.id === id ? before : p));
      toast.error(e.message || 'No se pudo guardar');
      throw e;
    }
  }, [productos, categorias, depositos, loadMetricas, loadCatalogos, toast]);

  // Cambiar filtros → volver a page 1. Usamos dSearch (no search) para que el
  // reset ocurra junto con el fetch debounceado.
  useEffect(() => { setPage(1); }, [claseFilter, vistaFiltro, dSearch]);

  // ── Modal alta/edición ──
  function openCreate() {
    setEditId(null); setForm(EMPTY_PRODUCTO); setFormError(''); setShowForm(true);
    // 2026-06-30 #imei-dup: limpiar el warning y el cache del último IMEI
    // chequeado al abrir el modal — sino, un alta previa con warning vivo
    // bloquearía la siguiente sesión del modal con un IMEI distinto.
    setImeiWarning('');
    lastCheckedImeiRef.current = '';
  }
  function openEdit(p) {
    setEditId(p.id);
    setForm({
      tipo_carga: p.tipo_carga, clase: p.clase, nombre: p.nombre, imei: p.imei ?? '',
      gb: p.gb ?? '', color: p.color ?? '', bateria: p.bateria ?? '',
      categoria_id: p.categoria_id ?? '', deposito_id: p.deposito_id ?? '', proveedor: p.proveedor ?? '',
      costo: p.costo, costo_moneda: p.costo_moneda, precio_venta: p.precio_venta, precio_moneda: p.precio_moneda,
      cantidad: p.cantidad, estado: p.estado, observaciones: p.observaciones ?? '',
      condicion: p.condicion || 'nuevo',
    });
    setFormError(''); setShowForm(true);
    // En edit no chequeamos: el producto YA existe con ese IMEI por
    // definición, sería un falso positivo. Pre-cargamos el cache para que
    // un onBlur no dispare ruido.
    setImeiWarning('');
    lastCheckedImeiRef.current = (p.imei ?? '').trim();
  }

  // 2026-06-30 #imei-dup: chequeo onBlur del input IMEI en el form de alta.
  // No bloquea por sí solo (handleSave hace el check autoritativo), pero
  // muestra warning temprano para que el operador corrija antes de submit.
  // No corre si: estamos editando (vivimos con el IMEI propio), el IMEI
  // está vacío, o ya lo chequeamos en este abrir-del-modal.
  async function onImeiBlur() {
    const imei = String(form.imei || '').trim();
    if (editId) return;                            // edit: skip (su IMEI = el propio)
    if (!imei) { setImeiWarning(''); return; }     // vacío: limpiar warning si había
    if (imei === lastCheckedImeiRef.current) return; // no re-chequear el mismo
    lastCheckedImeiRef.current = imei;
    try {
      const r = await inventario.checkImei(imei);
      if (r?.exists) {
        setImeiWarning(`Este IMEI ya está cargado en "${r.producto?.nombre || 'otro producto'}" (id ${r.producto?.id}).`);
      } else {
        setImeiWarning('');
      }
    } catch {
      // Si el check falla (network, 5xx) no bloqueamos UX: handleSave hará
      // el check autoritativo. Solo limpiamos cualquier warning vieja.
      setImeiWarning('');
    }
  }

  useEffect(() => {
    setPrimaryAction({ label: 'Agregar producto', onClick: openCreate });
    return () => setPrimaryAction(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPrimaryAction]);

  async function handleSave(e) {
    e.preventDefault();
    if (!form.nombre.trim()) { setFormError('El nombre es obligatorio.'); return; }
    // Categoría requerida al crear (en edits de productos legacy queda opcional para no bloquear).
    if (!editId && !form.categoria_id) { setFormError('La categoría es obligatoria.'); return; }

    // 2026-06-30 #imei-dup: bloqueo autoritativo de IMEI duplicado al crear.
    // El onBlur muestra warning, pero el submit es la única defensa real
    // (el usuario puede haber pegado el IMEI sin perder focus → no dispara
    // onBlur). En edit no chequeamos: el producto ya existe con ese IMEI.
    const imeiTrim = String(form.imei || '').trim();
    if (!editId && imeiTrim) {
      try {
        const r = await inventario.checkImei(imeiTrim);
        if (r?.exists) {
          const msg = `Este IMEI ya está cargado en otro producto activo${r.producto?.nombre ? ` ("${r.producto.nombre}")` : ''}.`;
          toast.error(msg);
          setFormError(msg);
          setImeiWarning(msg);
          return;
        }
      } catch {
        // Si el check falla (network/5xx) NO bloqueamos: dejamos pasar al
        // POST de creación. La consecuencia máxima es un duplicado en DB,
        // que sigue siendo la situación pre-feature.
      }
    }

    setSaving(true); setFormError('');
    const num = (v) => v === '' || v == null ? null : Number(v);
    const payload = {
      tipo_carga: form.tipo_carga, clase: form.clase, nombre: form.nombre.trim(),
      imei: form.imei.trim() || null, gb: form.gb.trim() || null, color: form.color.trim() || null,
      bateria: num(form.bateria), categoria_id: form.categoria_id || null, deposito_id: form.deposito_id || null,
      proveedor: form.proveedor.trim() || null,
      costo: num(form.costo) ?? 0, costo_moneda: form.costo_moneda,
      precio_venta: num(form.precio_venta) ?? 0, precio_moneda: form.precio_moneda,
      cantidad: num(form.cantidad) ?? 1, estado: form.estado,
      observaciones: form.observaciones.trim() || null,
      condicion: form.condicion || 'nuevo',
    };
    try {
      if (editId) await inventario.updateProducto(editId, payload);
      else await inventario.createProducto(payload);
      toast.success(editId ? 'Producto actualizado.' : 'Producto agregado.');
      setShowForm(false);
      await Promise.all([loadProductos(), loadMetricas()]);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(p) {
    const ok = await confirm({ title: 'Eliminar producto', message: `¿Eliminar "${p.nombre}"? Esta acción no se puede deshacer.`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await inventario.deleteProducto(p.id);
      toast.success('Producto eliminado.');
      await Promise.all([loadProductos(), loadMetricas()]);
    } catch (e) { toast.error(e.message); }
  }

  // ── Export / plantilla / import (misma base de columnas que la planilla) ──
  // Convierte un producto a una fila en el orden EXACTO de PLANTILLA_HEADERS.
  function productoARow(p) {
    return [
      p.nombre || '', p.gb || '', p.bateria ?? '', p.color || '',
      p.costo ?? '', p.costo_moneda || '', p.precio_venta ?? '', p.precio_moneda || '',
      p.imei || '', p.tipo_carga === 'lote' ? 'stock' : 'Unitario',
      p.categoria_nombre || '', p.proveedor || '',
      p.clase === 'accesorio' ? (p.cantidad ?? '') : '', p.deposito_id ?? '',
    ];
  }
  // Filas (arrays) → objetos keyed por header, para exportCsv.
  const rowsToObjects = (rows) => rows.map(r => Object.fromEntries(PLANTILLA_HEADERS.map((h, i) => [h, r[i]])));
  const plantillaCols = () => PLANTILLA_HEADERS.map(h => ({ key: h, label: h }));
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  // Exporta TODO el inventario que matchea los filtros activos, no solo la
  // página visible. Antes el botón "Exportar" solo bajaba ~50 productos (la
  // página actual), causando data silenciosamente perdida — bug crítico
  // reportado en testing pre-salida 2026-06-09.
  //
  // Estrategia: iterar páginas en lotes de 200 (max del backend) hasta
  // agotar. Con 863 productos son 5 round-trips. Toast con progreso si tarda.
  async function exportProductos() {
    const params = { vista: vistaFiltro, limit: 200 };
    if (claseFilter === 'celular' || claseFilter === 'accesorio') params.clase = claseFilter;
    else if (claseFilter === 'tecnico') params.estado = 'en_tecnico';
    else if (claseFilter === 'usados') params.condicion = 'usado';
    else if (claseFilter && claseFilter.startsWith('cat:')) params.categoria_id = claseFilter.slice(4);
    if (dSearch.trim()) params.buscar = dSearch.trim();
    if (Object.keys(drillFilters).length) {
      Object.assign(params, drillFilters);
      params.vista = 'todos_ocultos';
    }

    setLoading(true);
    try {
      const acumulado = [];
      let pagina = 1;
      let totalPaginas = 1;
      // Primer llamada — sabemos el total.
      do {
        const res = await inventario.productos({ ...params, page: pagina });
        acumulado.push(...(res.data || []));
        totalPaginas = res.pagination?.pages || 1;
        pagina++;
      } while (pagina <= totalPaginas);

      if (acumulado.length === 0) { toast.error('No hay productos para exportar.'); return; }
      exportCsv('inventario.csv', rowsToObjects(acumulado.map(productoARow)), plantillaCols());
      toast.success(`✓ Exportados ${acumulado.length} productos.`);
    } catch (e) {
      toast.error('Error exportando: ' + (e.message || 'desconocido'));
    } finally {
      setLoading(false);
    }
  }

  function descargarPlantillaXlsx() {
    downloadBlob(writeXlsx([PLANTILLA_HEADERS, ...PLANTILLA_EJEMPLO]), 'plantilla_stock.xlsx');
  }
  function descargarPlantillaCsv() {
    exportCsv('plantilla_stock.csv', rowsToObjects(PLANTILLA_EJEMPLO), plantillaCols());
  }

  function openImport() {
    setImportRows([]); setImportGroups([]); setImportError(''); setShowImport(true);
  }

  // Construye el estado inicial de los grupos a partir de filas válidas mapeadas.
  // Un grupo = un proveedor distinto detectado en el XLSX = una compra a generar.
  // Si el proveedor existe en el catálogo (auto-match por nombre case-insensitive),
  // se preselecciona; sino queda vacío y el usuario lo elige (con opción de crear nuevo).
  function buildImportGroups(mapped) {
    const groups = groupRowsByProveedor(mapped);
    const todayIso = new Date().toISOString().slice(0, 10);
    return groups.map((g, i) => {
      const match = g.proveedor
        ? proveedoresCatalogo.find(p => p.nombre.trim().toLowerCase() === g.proveedor.toLowerCase())
        : null;
      // Sugerencia de monto: suma de costos USD de las filas del grupo. Lucas
      // puede editar (puede haber flete, dto extra, etc.) pero arranca con un
      // valor razonable y no en 0.
      const sugerido = g.rows.reduce((acc, r) => {
        const m = r.body?.costo_moneda;
        // Sólo sumamos USD — si hay ARS necesitaríamos TC, no asumimos.
        return acc + (m === 'USD' ? Number(r.body?.costo || 0) * (r.body?.cantidad || 1) : 0);
      }, 0);
      return {
        key: `g_${i}`,
        proveedor_label: g.proveedor || '— Sin proveedor en XLSX —',
        proveedor_id: match?.id ?? '',
        proveedor_nuevo: !match && g.proveedor ? g.proveedor : '',  // si no matchea, sugerir crear
        fecha: todayIso,
        monto: sugerido > 0 ? String(Math.round(sugerido * 100) / 100) : '',
        moneda: 'USD',
        tc: '',
        caja_id: '',
        rows: g.rows,
      };
    });
  }

  async function onImportFile(e) {
    setImportError('');
    const file = e.target.files?.[0];
    if (!file) return;
    // Tope de tamaño: un .xlsx legítimo de stock está muy por debajo de 10 MB.
    // Evita que un archivo gigante (planilla con imágenes embebidas) cuelgue la pestaña.
    const MAX_MB = 10;
    if (file.size > MAX_MB * 1024 * 1024) {
      setImportError(`El archivo supera ${MAX_MB} MB. Exportá una planilla más liviana o sacale fotos/objetos embebidos.`);
      e.target.value = '';
      return;
    }
    const isXlsx = /\.xlsx$/i.test(file.name);
    try {
      // Lee .xlsx (Excel) nativo o .csv; ambos terminan como filas de celdas.
      const rows = isXlsx
        ? await readXlsxRows(await file.arrayBuffer())
        : parseCsv(await file.text());
      if (!rows || rows.length < 2) { setImportError('El archivo no tiene filas de datos.'); return; }
      const mapped = mapStockRows(rows, { categorias, depositos, proveedores: proveedoresCatalogo });
      if (mapped.length === 0) { setImportError('No se encontraron filas con datos.'); return; }
      setImportRows(mapped);
      // Multi-proveedor: agrupa las filas válidas por proveedor → un movimiento
      // (compra) por grupo. El usuario ajusta monto/caja/etc por grupo antes
      // de confirmar. Si todas las filas tienen el mismo proveedor (o ninguno),
      // queda un solo grupo — el flow se siente igual que antes para ese caso.
      setImportGroups(buildImportGroups(mapped));
    } catch (err) {
      setImportError(isXlsx
        ? 'No se pudo leer el Excel. ¿Es un .xlsx válido?'
        : 'No se pudo leer el archivo. ¿Es un CSV válido?');
    } finally {
      e.target.value = ''; // permite re-seleccionar el mismo archivo
    }
  }

  // Valida que cada grupo tenga los campos requeridos antes de submit.
  // Devuelve string vacío si OK, o un mensaje de error con qué grupo falla.
  function validateImportGroups() {
    if (!importGroups.length) return 'No hay grupos para importar.';
    for (let i = 0; i < importGroups.length; i++) {
      const g = importGroups[i];
      const label = g.proveedor_label;
      // Proveedor: o un id existente o un nombre nuevo a crear.
      if (!g.proveedor_id && !g.proveedor_nuevo.trim()) {
        return `Grupo "${label}": elegí un proveedor existente o creá uno nuevo.`;
      }
      // Monto: requerido > 0 (la compra crea productos en Inventario → backend
      // exige monto > 0, lo replicamos en frontend para feedback inmediato).
      const monto = Number(g.monto);
      if (!(monto > 0)) return `Grupo "${label}": ingresá un monto válido (> 0).`;
      // TC requerido si moneda no es USD
      if (g.moneda !== 'USD' && !(Number(g.tc) > 0)) {
        return `Grupo "${label}": para ${g.moneda} necesitás el tipo de cambio (TC).`;
      }
      // Caja: opcional. Si no eligen, el backend NO genera caja_movimiento
      // (queda como deuda con el proveedor sin tocar caja). Es válido.
    }
    return '';
  }

  async function confirmImport() {
    const validRows = importRows.filter(r => !r.error);
    if (!validRows.length) return;
    const err = validateImportGroups();
    if (err) { setImportError(err); return; }
    setImporting(true);
    setImportError('');
    try {
      // ── Paso 1: bulk resolve-or-create de catálogos ──────────────────────
      // Categorías: necesario porque el body de producto exige categoria_id.
      // Lo hacemos como antes (un solo bulk) para minimizar RTTs.
      const { categorias: catsNuevas } = extractNewCatalogos(validRows);
      const newCatByName = new Map();
      if (catsNuevas.length > 0) {
        try {
          const { map } = await inventario.bulkCategorias(catsNuevas);
          for (const [k, v] of Object.entries(map || {})) newCatByName.set(k, v);
        } catch (e) {
          throw new Error(`No se pudieron crear las categorías: ${e.message}`);
        }
      }

      // ── Paso 2: resolve-or-create de proveedores marcados como nuevos ─────
      // El usuario puede haber escrito un nombre en `proveedor_nuevo` de un
      // grupo (auto-suggest o manual). Los creamos en bulk para obtener su id.
      // Idempotente backend: si ya existe, lo devuelve.
      const nombresProvNuevos = importGroups
        .filter(g => !g.proveedor_id && g.proveedor_nuevo.trim())
        .map(g => g.proveedor_nuevo.trim());
      const provIdByName = new Map(); // lowercase nombre → id
      if (nombresProvNuevos.length > 0) {
        try {
          // El endpoint /api/proveedores/bulk devuelve { proveedores: [{id,nombre},...] }
          // (igual que /api/proveedores/list, idempotente). Lo reaprovechamos
          // para obtener los ids de los recién creados.
          const res = await proveedoresApi.bulk(nombresProvNuevos);
          const arr = res?.proveedores || res?.data || [];
          for (const p of arr) provIdByName.set(p.nombre.trim().toLowerCase(), p.id);
        } catch (e) {
          throw new Error(`No se pudieron crear los proveedores nuevos: ${e.message}`);
        }
      }

      // ── Paso 3: armar el payload bulk multi-movimiento ───────────────────
      // Un movimiento (tipo='compra') por grupo. Lógica pura extraída a
      // buildBulkMovimientosPayload (importStock.js) para poder testarla
      // aislada — el backend crea el producto en Inventario en la misma tx,
      // con proveedor auto-asignado al nombre del proveedor del movimiento.
      const movimientos = buildBulkMovimientosPayload({
        groups: importGroups,
        newCatByName,
        provIdByName,
      });

      // ── Paso 4: bulk multi-movimiento (transacción atómica server-side) ──
      const res = await proveedoresApi.createMovimientosBulk(movimientos);
      const compras = res?.count || movimientos.length;
      const productos = res?.movimientos?.reduce((acc, m) => acc + (m.items_creados || m.items?.length || 0), 0)
        || validRows.length;

      // Toast contextual.
      const extras = [];
      if (catsNuevas.length) extras.push(`${catsNuevas.length} categoría${catsNuevas.length === 1 ? '' : 's'}`);
      if (nombresProvNuevos.length) extras.push(`${nombresProvNuevos.length} proveedor${nombresProvNuevos.length === 1 ? '' : 'es'}`);
      const suffix = extras.length ? ` (+ ${extras.join(' y ')} nueva${extras.length === 1 ? '' : 's'})` : '';
      toast.success(
        `${productos} producto${productos === 1 ? '' : 's'} importado${productos === 1 ? '' : 's'} en ${compras} compra${compras === 1 ? '' : 's'}${suffix}.`
      );
      setShowImport(false);
      // Refresh todo: productos, métricas, y catálogos (las nuevas categorías
      // tienen que aparecer en filtros y selects). Proveedores también puede
      // tener nuevos.
      await Promise.all([loadProductos(), loadMetricas(), loadCatalogos()]);
    } catch (e) {
      setImportError(e.message);
    } finally {
      setImporting(false);
    }
  }

  // Actualiza un campo de un grupo del import por key. Helper para los inputs.
  function updateImportGroup(key, patch) {
    setImportGroups(gs => gs.map(g => g.key === key ? { ...g, ...patch } : g));
  }

  // ── Bulk delete de stock disponible ────────────────────────────────────────
  // Útil para resetear el inventario libre sin perder los vendidos. Acción
  // destructiva — confirma con un modal explícito. Mantiene:
  //   · 'vendido'    (atado a ventas históricas)
  //   · 'en_tecnico' (físicamente en stock, en service)
  //   · 'reservado'  (apartado para un cliente)
  async function handleVaciarStock() {
    const ok = await confirm({
      title: 'Vaciar stock disponible',
      message: 'Se van a eliminar TODOS los productos en estado "disponible". ' +
               'Los vendidos, en técnico y reservados se mantienen. ' +
               'Es reversible vía soporte (soft-delete) pero no hay UI para deshacer. ¿Continuar?',
      confirmLabel: 'Sí, vaciar stock',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await inventario.bulkDeleteDisponibles();
      toast.success(`${res.borrados} producto${res.borrados === 1 ? '' : 's'} eliminado${res.borrados === 1 ? '' : 's'}.`);
      await Promise.all([loadProductos(), loadMetricas()]);
    } catch (e) {
      toast.error(e.message || 'No se pudo vaciar el stock.');
    }
  }

  // ── Variante destructiva pedida por Lucas 2026-06-15 (admin only) ──
  // Vacía el stock disponible Y además borra las compras a proveedores
  // cuyos productos quedaron 100% borrados, revirtiendo sus egresos de
  // caja. Compras parciales (algún producto vendido) NO se tocan.
  async function handleVaciarStockConCompras() {
    const ok = await confirm({
      title: 'Vaciar stock + compras a proveedores',
      message: 'Va a eliminar TODOS los productos en estado "disponible" Y ADEMÁS las ' +
               'compras a proveedores cuyos productos queden completamente borrados. ' +
               'Los egresos de caja de esas compras (al contado) se REVIERTEN — el saldo de la caja vuelve. ' +
               'Las compras con algún producto YA VENDIDO se preservan (no se tocan). ' +
               'Si alguna caja quedaría en negativo al revertir, la operación se cancela sin tocar nada. ' +
               '¿Continuar?',
      confirmLabel: 'Sí, vaciar stock + compras',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await inventario.bulkDeleteDisponiblesConCompras();
      const p = res.borrados;
      const c = res.compras_borradas;
      toast.success(
        `${p} producto${p === 1 ? '' : 's'} eliminado${p === 1 ? '' : 's'} · ` +
        `${c} compra${c === 1 ? '' : 's'} borrada${c === 1 ? '' : 's'}.`
      );
      await Promise.all([loadProductos(), loadMetricas()]);
    } catch (e) {
      toast.error(e.message || 'No se pudo vaciar el stock + compras.');
    }
  }

  // ── Catálogos (categorías / depósitos) ──
  async function addCategoria() {
    setCatError('');
    const nombre = nuevaCat.trim();
    if (!nombre) return;
    try { await inventario.createCategoria({ nombre }); setNuevaCat(''); await loadCatalogos(); }
    catch (e) { setCatError(e.message); }
  }
  async function delCategoria(c) {
    const ok = await confirm({ title: 'Eliminar categoría', message: `¿Eliminar "${c.nombre}"? Los productos quedarán sin categoría.`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await inventario.deleteCategoria(c.id); await loadCatalogos(); } catch (e) { toast.error(e.message); }
  }
  async function addDeposito() {
    setCatError('');
    const nombre = nuevoDep.trim();
    if (!nombre) return;
    try { await inventario.createDeposito({ nombre }); setNuevoDep(''); await loadCatalogos(); }
    catch (e) { setCatError(e.message); }
  }
  async function delDeposito(d) {
    const ok = await confirm({ title: 'Eliminar depósito', message: `¿Eliminar "${d.nombre}"? Los productos quedarán sin depósito.`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await inventario.deleteDeposito(d.id); await loadCatalogos(); } catch (e) { toast.error(e.message); }
  }

  const importValidos = useMemo(() => importRows.filter(r => !r.error), [importRows]);
  const importErrores = useMemo(() => importRows.filter(r => r.error), [importRows]);
  // 2026-06-30 #imei-dup: IMEIs duplicados DENTRO del XLSX. Si hay alguno,
  // bloqueamos el submit del import — el operador tiene que corregir el
  // archivo. Filas sin IMEI (accesorios) son legítimas y se ignoran.
  const importDupImeis = useMemo(() => findDuplicateImeis(importRows), [importRows]);

  function estadoBadge(s) {
    const d = ESTADO_DISPLAY[s] || { label: s, tone: 'default' };
    return <Badge tone={d.tone}>{d.label}</Badge>;
  }

  return (
    <div>
      {/* ── Page head — 2026-06-19 Lucas: los 9 botones de acciones
          quedaban apretados en el header. Solución: page-head solo título +
          subtítulo; los botones bajan a una toolbar dedicada debajo, con
          espacio para respirar. ── */}
      <div className="page-head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 className="page-title">Inventario</h1>
            <Link to="/inventario/desglose" className="btn btn-ghost btn-sm" title="Vista 360 de tu stock por categoría, proveedor, modelo y más">
              Desglose 360 →
            </Link>
          </div>
          <div className="page-sub">Stock de equipos y accesorios · costos, depósitos y proveedores</div>
        </div>
      </div>

      {/* ── Tabs principales (PR-X3 #465) ─────────────────────────────────
          "Productos" es el contenido histórico (grilla + filtros + KPIs).
          "Pendientes Red B2B" sólo aparece si el user tiene cap
          cross_tenant.write — el contenido se delega a
          RedB2BPendingReviewContent (named export del archivo del feature). */}
      {canSeeRedB2B && (
        <div className="tabs" role="tablist" aria-label="Secciones de Inventario" style={{ marginBottom: 16 }}>
          <button
            type="button"
            role="tab"
            aria-selected={mainTab === 'productos'}
            className={`tab ${mainTab === 'productos' ? 'active' : ''}`}
            onClick={() => selectMainTab('productos')}
          >
            Productos
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mainTab === 'red-b2b-pending'}
            className={`tab ${mainTab === 'red-b2b-pending' ? 'active' : ''}`}
            onClick={() => selectMainTab('red-b2b-pending')}
          >
            Pendientes Red B2B
            {pendingCount != null && pendingCount > 0 && (
              <span className="badge" style={{ marginLeft: 8 }}>{pendingCount}</span>
            )}
          </button>
        </div>
      )}

      {/* Tab "Pendientes Red B2B" — Content embebido. setPendingCount como
          callback para que cualquier acción del Content (confirmar / mergear)
          mantenga el badge sincronizado sin un fetch adicional. */}
      {mainTab === 'red-b2b-pending' && canSeeRedB2B && (
        <RedB2BPendingReviewContent onCountChange={setPendingCount} />
      )}

      {/* Tab "Productos" — todo el contenido histórico de Inventario. Lo
          envolvemos en un fragment condicional para que el código previo
          (toolbar + KPIs + filtros + tabla + modales) se siga renderando
          tal cual cuando el tab activo es 'productos'. Las modales (form,
          import, catálogos, historial) viven fuera del flujo principal
          pero las dejamos dentro del condicional para que no sean
          interactivas mientras estás en el otro tab. */}
      {mainTab === 'productos' && (<>


      {/* Toolbar de acciones — fila dedicada, sin pelearse con el header.
          Los botones se distribuyen: refresh/data ops a la izquierda,
          destructivos al medio, primary action a la derecha.
          2026-06-24 mobile: en <=640px se ocultan los 7 botones secundarios
          (plantillas, importar, exportar, categorías, vaciar stock) vía
          .mobile-hide; quedan solo Actualizar + Agregar producto. El resto
          se accede desde desktop hasta que decidamos un menú overflow. */}
      <div className="page-actions" style={{ marginBottom: 18, justifyContent: 'flex-start' }}>
        <button className="btn" onClick={() => { loadProductos(); loadMetricas(); }}>
          <Icons.Refresh size={14} /> Actualizar
        </button>
        <button className="btn mobile-hide" onClick={descargarPlantillaXlsx}><Icons.Download size={14} /> Plantilla .xlsx</button>
        <button className="btn mobile-hide" onClick={descargarPlantillaCsv}><Icons.Download size={14} /> Plantilla .csv</button>
        <button className="btn mobile-hide" onClick={openImport}><Icons.Upload size={14} /> Importar</button>
        {/* Recepción con scanner móvil: la pantalla (/inventario/recepcion)
            y el componente BarcodeScanner viven en el repo, accesibles por
            URL directa. Botón oculto a propósito hasta que decidamos retomar
            esa feature — primero validamos el resto del producto en la
            prueba con equipo (junio 2026). Para reactivar, descomentar el
            <Link/> y listo. */}
        <button className="btn mobile-hide" onClick={exportProductos}><Icons.Download size={14} /> Exportar</button>
        <button className="btn mobile-hide" onClick={() => { setCatError(''); setShowCatalogos(true); }}><Icons.Sliders size={14} /> Categorías &amp; Depósitos</button>
        {/* Acción destructiva — separada visualmente con color rojo del ícono y
            texto en variante ghost. El ConfirmModal con danger:true protege
            contra clicks accidentales. */}
        <button className="btn btn-ghost mobile-hide" style={{ color: 'var(--neg)' }} onClick={handleVaciarStock}>
          <Icons.Trash size={14} /> Vaciar stock
        </button>
        {/* Variante destructiva admin: stock + compras a proveedor. Sólo
            visible para role=admin para que un operador no la dispare por
            error — el backend igualmente revalida con adminOnly. */}
        {isAdmin && (
          <button
            className="btn btn-ghost mobile-hide"
            style={{ color: 'var(--neg)' }}
            onClick={handleVaciarStockConCompras}
            title="Admin · vacía stock + borra compras a proveedores asociadas + revierte cajas"
          >
            <Icons.Trash size={14} /> Vaciar stock + compras
          </button>
        )}
        {/* Spacer empuja Agregar producto a la derecha de la toolbar */}
        <span style={{ marginLeft: 'auto' }} />
        <button className="btn btn-primary" onClick={openCreate}><Icons.Plus size={14} /> Agregar producto</button>
      </div>

      {/* ── KPIs ── */}
      {/* 2026-06-24 mobile fix: usar .kpi-grid (no .row) — heredamos el
          breakpoint <880px → repeat(2, 1fr) del styles.css:1150, que evita
          que los 4 cards se exprimen a ~70px en SE/S20. */}
      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">En técnico</div>
          <div className="kpi-value mono" style={{ color: 'var(--warn)' }}>{metricas ? metricas.en_tecnico_count : '—'}</div>
          <div className="muted tiny" style={{ marginTop: 6 }}>{metricas ? money(metricas.en_tecnico_usd, 'USD') : ''}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Stock disponible</div>
          <div className="kpi-value mono pos">{metricas ? fmt(metricas.stock_disponible) : '—'}</div>
          <div className="muted tiny" style={{ marginTop: 6 }}>unidades</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Inversión equipos</div>
          <div className="kpi-value"><span className="ccy">USD</span><span className="mono">{metricas ? fmt(metricas.inv_equipos_usd) : '—'}</span></div>
          <div className="muted tiny" style={{ marginTop: 6 }}>{metricas ? `${metricas.equipos_count} equipos` : ''}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Inversión accesorios</div>
          <div className="kpi-value"><span className="ccy">USD</span><span className="mono">{metricas ? fmt(metricas.inv_accesorios_usd) : '—'}</span></div>
          <div className="muted tiny" style={{ marginTop: 6 }}>{metricas ? `${metricas.accesorios_count} unidades` : ''}</div>
        </div>
      </div>

      {/* ── Filtros ──
            Fila 1: tabs (clase fija + 'Usados' + 1 tab por categoría administrable).
                    Se hacen scroll horizontal si no entran en el ancho disponible.
            Fila 2: selector de vista (estado + ocultos) + buscador.            */}
      <div style={{ marginBottom: 14 }}>
        {/* #F-4: ScrollFadeX reactivo — muestra el fade SOLO si hay overflow
            real, y a la izquierda solo si el user ya scrolleó. Reemplaza al
            scroll-fade-x permanente original (#M-09). */}
        <ScrollFadeX style={{ marginBottom: 10 }}>
          <Seg
            value={claseFilter}
            options={[
              { value: 'todos', label: 'Todos' },
              { value: 'celular', label: 'Celulares' },
              { value: 'accesorio', label: 'Accesorios' },
              { value: 'tecnico', label: 'En técnico' },
              { value: 'usados', label: 'Usados' },
              // Categorías administrables → 1 tab por cada una (orden alfabético).
              // El usuario las crea/edita desde "Gestionar categorías" sin tocar código.
              ...[...categorias].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
                .map(c => ({ value: `cat:${c.id}`, label: c.nombre })),
            ]}
            onChange={setClaseFilter}
          />
        </ScrollFadeX>
        <div className="flex-between" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div className="flex-row" style={{ gap: 8, alignItems: 'center' }}>
            <label className="field-label" style={{ marginBottom: 0, marginRight: 4 }}>Vista</label>
            <select
              className="input"
              value={vistaFiltro}
              onChange={e => setVistaFiltro(e.target.value)}
              style={{ width: 240 }}
            >
              {VISTAS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
          </div>
          <div className="input-group" style={{ width: 300 }}>
            <span className="addon addon-l"><Icons.Search size={14} /></span>
            <input className="input" placeholder="Buscar nombre, IMEI, color, GB…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      {/* ── Chip de drill-down ── */}
      {hasDrillDown && (
        <div className="card card-tight" style={{ marginBottom: 12, background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Icons.Filter size={14} />
          <span className="muted tiny">Filtrado desde Desglose 360:</span>
          {Object.entries(drillFilters).map(([k, v]) => {
            // Mostramos el nombre humano cuando podamos resolverlo
            let label = v;
            if (k === 'categoria_id') label = categorias.find(c => String(c.id) === String(v))?.nombre || `Categoría #${v}`;
            if (k === 'deposito_id')  label = depositos.find(d => String(d.id) === String(v))?.nombre || `Depósito #${v}`;
            if (k === 'estado')       label = ({ disponible: 'Disponible', vendido: 'Vendido', en_tecnico: 'En técnico', reservado: 'Reservado' }[v]) || v;
            const niceKey = ({ categoria_id: 'Categoría', deposito_id: 'Depósito', estado: 'Estado', proveedor: 'Proveedor', nombre: 'Modelo', gb: 'GB', color: 'Color' })[k] || k;
            return (
              <span key={k} className="badge badge-info" style={{ fontSize: 12 }}>{niceKey}: {label}</span>
            );
          })}
          <button className="btn btn-sm" onClick={clearDrillDown} title="Limpiar filtro y ver todo">
            <Icons.X size={13} /> Limpiar
          </button>
        </div>
      )}

      {/* ── Tabla ── */}
      {/* 2026-06-24 mobile lote E: tabla con 15 columnas + minWidth implícito
          ~1200px. Hint visible solo en <=640px (de Lote C) para que el user
          mobile sepa que tiene que scrollear horizontalmente. */}
      <div className="bulk-spreadsheet-hint">↔ Desliza horizontalmente para ver todas las columnas</div>
      {loading ? (
        // Skeleton de la grilla: 5 filas con la cantidad de columnas reales
        // (15) para que el layout no salte al llegar el dato.
        // aria-busy para lectores de pantalla. U-12 auditoría 2026-06-10.
        <div className="card card-flush" style={{ overflowX: 'auto' }} aria-busy="true" aria-live="polite">
          <table className="table">
            <thead>
              {/* Widths ajustados 2026-06-15: la columna IMEI/Serial se estiraba
                  desproporcionadamente y "Proveedor" wrappeaba en 2 líneas con
                  nombres largos (ej. "Francisco de la Torre"). minWidth fija un
                  piso por columna; el resto del ancho se reparte entre las que
                  más lo necesitan (Nombre, Categoría, Proveedor). */}
              <tr>
                <th style={{ width: 32 }} aria-label="Historial"></th>
                <th style={{ minWidth: 180 }}>Nombre</th>
                <th style={{ width: 56 }}>GB</th>
                <th style={{ width: 70 }}>Batería</th>
                <th style={{ width: 96 }}>Color</th>
                <th style={{ width: 84, textAlign: 'right' }}>Costo</th>
                <th style={{ width: 68 }}>Mon. Costo</th>
                <th style={{ width: 96, textAlign: 'right' }}>Precio Venta</th>
                <th style={{ width: 72 }}>Mon. Venta</th>
                <th style={{ width: 142, whiteSpace: 'nowrap' }}>IMEI/Serial</th>
                <th style={{ width: 84 }}>Tipo</th>
                <th style={{ minWidth: 130 }}>Categoría</th>
                <th style={{ minWidth: 150, whiteSpace: 'nowrap' }}>Proveedor</th>
                <th style={{ width: 60, textAlign: 'right' }}>Stock</th>
                <th style={{ width: 110 }}>Estado</th>
                <th style={{ width: 110 }}></th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={16} />
              ))}
            </tbody>
          </table>
        </div>
      ) : productos.length === 0 ? (
        // 2026-06-25 UX-2 (audit pre-live): empty state con CTA en lugar del
        // texto mudo "Sin productos". Distingue dos casos:
        //  · Hay filtros activos → "Limpiar filtros" como acción primaria.
        //  · Inventario vacío de verdad → "Agregar producto" + texto guía.
        // El primer caso es lo que ve un user con stock que se equivocó al
        // filtrar. El segundo es lo que ve un cliente nuevo en su primer login.
        (() => {
          const hasFilters = !!(dSearch || vistaFiltro !== 'todos' || hasDrillDown);
          if (hasFilters) {
            return (
              <div className="empty" style={{ padding: '28px 16px' }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Sin resultados</div>
                <div className="muted tiny" style={{ marginBottom: 14 }}>
                  No hay productos que coincidan con los filtros aplicados.
                </div>
                <button
                  className="btn btn-sm"
                  /* Auditoría 2026-06-30 F-08: limpiar TODO via setSearchParams.
                     Forzamos vista='todos' explícito (override del default
                     'no_vendidos') para que el user vea efectivamente todos los
                     productos al limpiar, no solo los "en stock visible". El
                     comportamiento previo (3 setters en cascada) era frágil
                     porque sólo el último ganaba. */
                  onClick={() => { setSearchParams({ vista: 'todos' }, { replace: true }); }}
                >
                  Limpiar filtros
                </button>
              </div>
            );
          }
          return (
            <div className="empty" style={{ padding: '32px 16px' }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Todavía no cargaste productos</div>
              <div className="muted tiny" style={{ marginBottom: 14 }}>
                Empezá con tu primer equipo o accesorio — necesitás al menos uno para registrar ventas.
              </div>
              <button className="btn btn-primary btn-sm" onClick={openCreate}>
                <Icons.Plus size={13} /> Agregar producto
              </button>
            </div>
          );
        })()
      ) : (
        <div className="card card-flush" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              {/* Widths ajustados 2026-06-15: la columna IMEI/Serial se estiraba
                  desproporcionadamente y "Proveedor" wrappeaba en 2 líneas con
                  nombres largos (ej. "Francisco de la Torre"). minWidth fija un
                  piso por columna; el resto del ancho se reparte entre las que
                  más lo necesitan (Nombre, Categoría, Proveedor). */}
              <tr>
                <th style={{ width: 32 }} aria-label="Historial"></th>
                <th style={{ minWidth: 180 }}>Nombre</th>
                <th style={{ width: 56 }}>GB</th>
                <th style={{ width: 70 }}>Batería</th>
                <th style={{ width: 96 }}>Color</th>
                <th style={{ width: 84, textAlign: 'right' }}>Costo</th>
                <th style={{ width: 68 }}>Mon. Costo</th>
                <th style={{ width: 96, textAlign: 'right' }}>Precio Venta</th>
                <th style={{ width: 72 }}>Mon. Venta</th>
                <th style={{ width: 142, whiteSpace: 'nowrap' }}>IMEI/Serial</th>
                <th style={{ width: 84 }}>Tipo</th>
                <th style={{ minWidth: 130 }}>Categoría</th>
                <th style={{ minWidth: 150, whiteSpace: 'nowrap' }}>Proveedor</th>
                <th style={{ width: 60, textAlign: 'right' }}>Stock</th>
                <th style={{ width: 110 }}>Estado</th>
                <th style={{ width: 110 }}></th>
              </tr>
            </thead>
            <tbody>
              {productos.map(p => {
                const save = (field) => (val) => inlineUpdate(p.id, field, val);
                // Auditoría 2026-06-30 F-26: catOptions/provOptions ahora
                // viven arriba en useMemo — antes se reconstruían por fila.
                // Atenuamos la fila si el producto está oculto: pista visual rápida
                // sin agregar una columna nueva en una tabla que ya es ancha.
                return (
                  <tr key={p.id} style={p.oculto ? { opacity: 0.55 } : undefined}>
                    {/* Botón Historial — ÚNICA forma de abrir el modal (decisión
                        UX 2026-06-15): toda la grilla son EditableCells, así que
                        click en fila chocaría con edit-inline. Una columna
                        dedicada con ícono es discoverable + 0 conflicto. */}
                    <td style={{ width: 32, padding: '4px 8px' }}>
                      <button className="icon-btn"
                        title="Ver detalle e historial del producto"
                        onClick={() => setHistorialProductoId(p.id)}>
                        <Icons.FileText size={14} />
                      </button>
                    </td>
                    <EditableCell
                      value={p.nombre}
                      type="text"
                      align="left"
                      className="cell-strong"
                      onSave={save('nombre')}
                      inputProps={{ maxLength: 200 }}
                      emptyToNull={false}
                    />
                    <EditableCell
                      value={p.gb || ''}
                      type="text"
                      align="left"
                      className="mono"
                      onSave={save('gb')}
                      inputProps={{ maxLength: 20 }}
                    />
                    <EditableCell
                      value={p.bateria}
                      display={p.bateria != null ? p.bateria + '%' : '—'}
                      type="number" onKeyDown={blockInvalidNumberKeys}
                      align="left"
                      className="mono"
                      onSave={save('bateria')}
                      parse={v => v === '' ? null : Number(v)}
                      inputProps={{ min: 0, max: 100, step: 1 }}
                    />
                    <EditableCell
                      value={p.color || ''}
                      type="text"
                      align="left"
                      onSave={save('color')}
                      inputProps={{ maxLength: 60 }}
                    />
                    <EditableCell
                      value={p.costo}
                      display={fmt(p.costo)}
                      type="number" onKeyDown={blockInvalidNumberKeys}
                      align="right"
                      className="mono"
                      onSave={save('costo')}
                      parse={v => v === '' ? 0 : Number(v)}
                      emptyToNull={false}
                      inputProps={{ min: 0, step: 1 }}
                    />
                    <EditableCell
                      value={p.costo_moneda}
                      display={<span className="ccy">{p.costo_moneda}</span>}
                      type="select"
                      options={Array.from(new Set(['USD', monedaLocal, p.costo_moneda, p.precio_moneda].filter(Boolean))).map(m => ({ value: m, label: m }))}
                      onSave={save('costo_moneda')}
                      emptyToNull={false}
                    />
                    <EditableCell
                      value={p.precio_venta}
                      display={<span className="pos" style={{ fontWeight: 600 }}>{fmt(p.precio_venta)}</span>}
                      type="number" onKeyDown={blockInvalidNumberKeys}
                      align="right"
                      className="mono"
                      onSave={save('precio_venta')}
                      parse={v => v === '' ? 0 : Number(v)}
                      emptyToNull={false}
                      inputProps={{ min: 0, step: 1 }}
                    />
                    <EditableCell
                      value={p.precio_moneda}
                      display={<span className="ccy">{p.precio_moneda}</span>}
                      type="select"
                      options={Array.from(new Set(['USD', monedaLocal, p.costo_moneda, p.precio_moneda].filter(Boolean))).map(m => ({ value: m, label: m }))}
                      onSave={save('precio_moneda')}
                      emptyToNull={false}
                    />
                    <EditableCell
                      value={p.imei || ''}
                      type="text"
                      align="left"
                      className="mono tiny nowrap"
                      onSave={save('imei')}
                      inputProps={{ maxLength: 50 }}
                    />
                    <EditableCell
                      value={p.tipo_carga}
                      display={<span className="muted">{p.tipo_carga === 'lote' ? 'Stock' : 'Unitario'}</span>}
                      type="select"
                      options={[{ value: 'unitario', label: 'Unitario' }, { value: 'lote', label: 'Stock' }]}
                      onSave={save('tipo_carga')}
                      emptyToNull={false}
                    />
                    <EditableCell
                      value={p.categoria_id}
                      display={<span className="muted">{p.categoria_nombre || '—'}</span>}
                      type="combo"
                      options={catOptions}
                      onSave={save('categoria_id')}
                      parse={v => v === '' ? null : Number(v)}
                    />
                    <EditableCell
                      value={p.proveedor || ''}
                      display={<span className="muted">{p.proveedor || '—'}</span>}
                      type="combo"
                      options={provOptions}
                      className="nowrap"
                      onSave={save('proveedor')}
                      inputProps={{ maxLength: 200 }}
                    />
                    <EditableCell
                      value={p.cantidad}
                      type="number" onKeyDown={blockInvalidNumberKeys}
                      align="right"
                      className="mono"
                      onSave={save('cantidad')}
                      parse={v => v === '' ? 0 : Number(v)}
                      emptyToNull={false}
                      inputProps={{ min: 0, step: 1 }}
                    />
                    <EditableCell
                      value={p.estado}
                      display={estadoBadge(p.estado)}
                      type="select"
                      options={Object.entries(ESTADO_DISPLAY).map(([v, m]) => ({ value: v, label: m.label }))}
                      onSave={save('estado')}
                      emptyToNull={false}
                    />
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="icon-btn"
                        title={p.oculto ? 'Mostrar (sacar de ocultos)' : 'Ocultar de la vista por defecto'}
                        onClick={() => inlineUpdate(p.id, 'oculto', !p.oculto).catch(() => {})}
                      >
                        {p.oculto ? <Icons.EyeOff size={14} /> : <Icons.Eye size={14} />}
                      </button>
                      <button className="icon-btn" title="Editar (modal completo)" onClick={() => openEdit(p)}><Icons.Edit size={14} /></button>
                      <button className="icon-btn" title="Eliminar" style={{ color: 'var(--neg)' }} onClick={() => handleDelete(p)}><Icons.Trash size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Paginación ── */}
      {!loading && pages > 1 && (
        <div className="flex-row" style={{ gap: 8, justifyContent: 'center', marginTop: 14 }}>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹ Anterior</button>
          <span className="muted tiny" style={{ alignSelf: 'center' }}>{page} / {pages} · {total} productos</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Siguiente ›</button>
        </div>
      )}

      {/* ── Modal alta/edición ── */}
      {showForm && (
        <div ref={formModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowForm(false)}>
          <div
            className="modal"
            style={{ maxWidth: 620 }}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="prod-modal-title"
          >
            <div className="modal-hd">
              <h3 id="prod-modal-title">{editId ? 'Editar producto' : 'Agregar producto'}</h3>
              <button type="button" className="icon-btn" onClick={() => setShowForm(false)} aria-label="Cerrar" title="Cerrar"><Icons.X size={16} /></button>
            </div>
            <form onSubmit={handleSave}>
              <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                <div className="stack" style={{ gap: 14 }}>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Tipo de carga</label>
                      <select className="input" value={form.tipo_carga} onChange={e => setF('tipo_carga', e.target.value)}>
                        <option value="unitario">Unitario (ej. celulares)</option>
                        <option value="lote">Con stock / lote</option>
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Clase</label>
                      <select className="input" value={form.clase} onChange={e => setF('clase', e.target.value)}>
                        <option value="celular">Celular</option>
                        <option value="accesorio">Accesorio</option>
                      </select>
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">Nombre <span style={{ color: 'var(--neg)' }}>*</span></label>
                    <input className="input" placeholder="ej. iPhone 15 Pro" value={form.nombre} onChange={e => setF('nombre', e.target.value)} autoFocus />
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Batería (%)</label><input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="85" value={form.bateria} onChange={e => setF('bateria', e.target.value)} /></div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">GB</label><input className="input" placeholder="128" value={form.gb} onChange={e => setF('gb', e.target.value)} /></div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Color</label><input className="input" placeholder="Natural" value={form.color} onChange={e => setF('color', e.target.value)} /></div>
                  </div>
                  <div className="field">
                    <label className="field-label">IMEI (opcional)</label>
                    {/* 2026-06-30 #imei-dup: onBlur dispara warning temprano
                        si el IMEI ya está en otro producto activo. handleSave
                        hace el check autoritativo. Reset del warning al cambiar
                        el valor para no quedar mostrando uno stale. */}
                    <input
                      className="input mono"
                      placeholder="356938035643809"
                      value={form.imei}
                      onChange={e => { setF('imei', e.target.value); if (imeiWarning) setImeiWarning(''); }}
                      onBlur={onImeiBlur}
                      aria-invalid={!!imeiWarning}
                      aria-describedby={imeiWarning ? 'imei-warning' : undefined}
                    />
                    {imeiWarning && (
                      <div
                        id="imei-warning"
                        role="alert"
                        style={{ color: 'var(--neg)', fontSize: 12, marginTop: 4 }}
                      >
                        {imeiWarning}
                      </div>
                    )}
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Categoría <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <select className="input" value={form.categoria_id} onChange={e => setF('categoria_id', e.target.value)} required>
                        <option value="">— Elegir —</option>
                        {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Depósito</label>
                      <select className="input" value={form.deposito_id} onChange={e => setF('deposito_id', e.target.value)}>
                        <option value="">Sin depósito</option>
                        {depositos.map(d => <option key={d.id} value={d.id}>{d.nombre}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Costo</label>
                      <div className="flex-row" style={{ gap: 6 }}>
                        <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="0" value={form.costo} onChange={e => setF('costo', e.target.value)} style={{ flex: 1 }} />
                        {/* 2026-06-29 Multi-país F3: USD + moneda local del tenant. */}
                        <select className="input" style={{ width: 80 }} value={form.costo_moneda} onChange={e => setF('costo_moneda', e.target.value)}>
                          {Array.from(new Set(['USD', monedaLocal, form.costo_moneda].filter(Boolean)))
                            .map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Precio de venta</label>
                      <div className="flex-row" style={{ gap: 6 }}>
                        <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="0" value={form.precio_venta} onChange={e => setF('precio_venta', e.target.value)} style={{ flex: 1 }} />
                        <select className="input" style={{ width: 80 }} value={form.precio_moneda} onChange={e => setF('precio_moneda', e.target.value)}>
                          {Array.from(new Set(['USD', monedaLocal, form.precio_moneda].filter(Boolean)))
                            .map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Cantidad</label><input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" value={form.cantidad} onChange={e => setF('cantidad', e.target.value)} /></div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Estado</label>
                      <select className="input" value={form.estado} onChange={e => setF('estado', e.target.value)}>
                        <option value="disponible">Disponible</option>
                        <option value="en_tecnico">En técnico</option>
                        <option value="reservado">Reservado</option>
                        <option value="vendido">Vendido</option>
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Condición</label>
                      <select className="input" value={form.condicion} onChange={e => setF('condicion', e.target.value)}>
                        <option value="nuevo">Nuevo</option>
                        <option value="usado">Usado</option>
                      </select>
                    </div>
                  </div>
                  <div className="field"><label className="field-label">Proveedor</label><input className="input" placeholder="ej. Juan Distribuidor" value={form.proveedor} onChange={e => setF('proveedor', e.target.value)} /></div>
                  <div className="field"><label className="field-label">Observaciones</label><input className="input" placeholder="ej. pantalla rota, batería hinchada…" value={form.observaciones} onChange={e => setF('observaciones', e.target.value)} /></div>
                  {formError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{formError}</div>}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancelar</button>
                {/* 2026-06-30 #imei-dup: si hay warning de IMEI duplicado,
                    deshabilitamos el submit. handleSave también valida (defensa
                    en profundidad para casos donde el state queda stale). */}
                <button type="submit" className="btn btn-primary" disabled={saving || !!imeiWarning}>{saving ? 'Guardando…' : 'Guardar'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal import ── */}
      {/* Refactor 2026-06-14 #multi-proveedor:
          - Antes: una sola sección "validar filas + Importar" que generaba productos en Inventario.
          - Ahora: tras subir el XLSX se agrupa por columna `proveedor` y se muestra
            una card por grupo para configurar la compra (proveedor, monto, moneda, TC, caja).
            Al confirmar, el backend genera N movimientos de compra en una sola transacción
            atómica vía POST /api/proveedores/movimientos/bulk — los productos quedan
            trazables a su compra de origen. */}
      {showImport && (
        <div ref={importModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && !importing && setShowImport(false)}>
          <div className="modal" style={{ maxWidth: 760 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>Importar stock desde planilla</h3>
              <button type="button" className="icon-btn" onClick={() => setShowImport(false)} disabled={importing} aria-label="Cerrar" title="Cerrar"><Icons.X size={16} /></button>
            </div>
            <div className="modal-body" style={{ maxHeight: '75vh', overflowY: 'auto' }}>
              <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
                Subí un <strong>.xlsx</strong> o <strong>.csv</strong>. La columna <strong>proveedor</strong> define el agrupamiento:
                cada proveedor distinto se vuelve <strong>una compra</strong> en su CC, con sus productos como ítems trazables.
                Las categorías que no existan se crean automáticamente.
              </p>
              <div className="flex-row" style={{ gap: 6, marginBottom: 12 }}>
                <button className="btn btn-sm" onClick={descargarPlantillaXlsx}><Icons.Download size={13} /> Plantilla .xlsx</button>
                <button className="btn btn-sm" onClick={descargarPlantillaCsv}><Icons.Download size={13} /> Plantilla .csv</button>
              </div>
              <div className="field">
                <label className="field-label">Archivo (.xlsx o .csv)</label>
                <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="input" onChange={onImportFile} />
              </div>
              {importRows.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
                    <span className="pos">{importValidos.length} válidos</span> · <span className="neg">{importErrores.length} con error</span> · {importRows.length} filas
                    {importGroups.length > 0 && (
                      <> · <strong>{importGroups.length} compra{importGroups.length === 1 ? '' : 's'}</strong> a generar</>
                    )}
                  </div>
                  {/* 2026-06-30 #imei-dup: BLOCK banner — IMEIs duplicados
                      dentro del XLSX bloquean el submit. Aparece arriba para
                      que sea lo primero que ven y muestra qué filas chocan
                      (rowIndex + 2 porque rows[0] es header y rowIndex es
                      0-based; mostramos números humanos = línea en Excel). */}
                  {importDupImeis.length > 0 && (
                    <div style={{
                      marginBottom: 10, padding: '8px 12px',
                      background: 'rgba(239, 68, 68, 0.12)',
                      border: '1px solid rgba(239, 68, 68, 0.45)',
                      borderRadius: 6, color: 'var(--neg)', fontSize: 12,
                    }} role="alert">
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>
                        ⚠ {importDupImeis.length} IMEI{importDupImeis.length === 1 ? '' : 's'} duplicado{importDupImeis.length === 1 ? '' : 's'} en este archivo
                      </div>
                      <div style={{ marginBottom: 4 }}>
                        Corregilos antes de continuar. La importación queda bloqueada.
                      </div>
                      <div style={{ maxHeight: 100, overflowY: 'auto' }}>
                        {importDupImeis.map((d, i) => (
                          <div key={i} className="mono" style={{ fontSize: 11 }}>
                            · IMEI <strong>{d.imei}</strong> aparece en filas{' '}
                            {d.rowIndices.map(idx => idx + 2).join(', ')}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Errores: si los hay, se mostrarán pero NO bloquean. Las filas
                      con error simplemente no entran a ningún grupo (el agrupador
                      las ignora). El usuario decide si seguir o corregir la planilla. */}
                  {importErrores.length > 0 && (
                    <div style={{
                      fontSize: 11, color: 'var(--neg)', maxHeight: 80, overflowY: 'auto',
                      marginBottom: 10, padding: '6px 10px',
                      background: 'rgba(239, 68, 68, 0.06)',
                      border: '1px solid rgba(239, 68, 68, 0.18)',
                      borderRadius: 6,
                    }}>
                      <strong>Filas con error (se omiten):</strong>
                      {importErrores.slice(0, 20).map((r, i) => (
                        <div key={i}>· {r.body.nombre || 'sin nombre'}: {r.error}</div>
                      ))}
                      {importErrores.length > 20 && <div className="muted">+ {importErrores.length - 20} más…</div>}
                    </div>
                  )}

                  {/* ── Cards de compras a generar (una por proveedor) ── */}
                  {importGroups.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      <div style={{
                        fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
                        color: 'var(--text-muted)', marginBottom: 8,
                      }}>
                        COMPRAS A GENERAR ({importGroups.length})
                      </div>
                      {importGroups.map(g => {
                        const monedaSel = g.moneda;
                        const provExistente = !!g.proveedor_id;
                        return (
                          <div key={g.key} style={{
                            border: '1px solid var(--border)', borderRadius: 8,
                            padding: 12, marginBottom: 10,
                            background: 'var(--surface-2, rgba(255,255,255,0.02))',
                          }}>
                            <div style={{
                              fontSize: 12, fontWeight: 700,
                              color: 'var(--accent)', marginBottom: 6,
                              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                            }}>
                              <span>📦 {g.proveedor_label}</span>
                              <span className="muted tiny" style={{ fontWeight: 500 }}>
                                {g.rows.length} producto{g.rows.length === 1 ? '' : 's'}
                              </span>
                            </div>

                            <div className="row">
                              <div className="field" style={{ flex: 2 }}>
                                <label className="field-label">
                                  Proveedor <span style={{ color: 'var(--neg)' }}>*</span>
                                </label>
                                <select className="input" value={g.proveedor_id}
                                  onChange={e => updateImportGroup(g.key, {
                                    proveedor_id: e.target.value ? Number(e.target.value) : '',
                                    // Si elige uno existente, limpiamos el "nuevo".
                                    proveedor_nuevo: e.target.value ? '' : g.proveedor_nuevo,
                                  })}>
                                  <option value="">— Elegir existente o crear nuevo —</option>
                                  {proveedoresCatalogo.map(p => (
                                    <option key={p.id} value={p.id}>{p.nombre}</option>
                                  ))}
                                </select>
                                {/* Quick-add: solo si NO eligió uno existente.
                                    Auto-rellena con el nombre del XLSX si no había match. */}
                                {!provExistente && (
                                  <input className="input" style={{ marginTop: 6 }}
                                    placeholder="O escribí el nombre del nuevo proveedor"
                                    value={g.proveedor_nuevo}
                                    onChange={e => updateImportGroup(g.key, { proveedor_nuevo: e.target.value })} />
                                )}
                              </div>
                              <div className="field" style={{ flex: '0 0 130px' }}>
                                <label className="field-label">Fecha</label>
                                <input type="date" className="input" value={g.fecha}
                                  onChange={e => updateImportGroup(g.key, { fecha: e.target.value })} />
                              </div>
                            </div>

                            <div className="row">
                              <div className="field" style={{ flex: 1 }}>
                                <label className="field-label">
                                  Monto ({monedaSel}) <span style={{ color: 'var(--neg)' }}>*</span>
                                </label>
                                <input type="number" onKeyDown={blockInvalidNumberKeys} min="0"
                                  className="input mono" placeholder="0"
                                  value={g.monto}
                                  onChange={e => updateImportGroup(g.key, { monto: e.target.value })} />
                              </div>
                              <div className="field" style={{ flex: '0 0 100px' }}>
                                <label className="field-label">Moneda</label>
                                {/* 2026-06-29 Multi-país F3: monedas según país del tenant. */}
                                <select className="input" value={g.moneda}
                                  onChange={e => updateImportGroup(g.key, { moneda: e.target.value, tc: e.target.value === 'USD' ? '' : g.tc })}>
                                  {Array.from(new Set([...monedas, g.moneda].filter(Boolean)))
                                    .map(m => <option key={m} value={m}>{m}</option>)}
                                </select>
                              </div>
                              {monedaSel !== 'USD' && (
                                <div className="field" style={{ flex: '0 0 130px' }}>
                                  <label className="field-label">
                                    TC {monedaSel}→USD <span style={{ color: 'var(--neg)' }}>*</span>
                                  </label>
                                  <input type="number" onKeyDown={blockInvalidNumberKeys}
                                    min="0" step="0.01" className="input mono"
                                    placeholder="1000" value={g.tc}
                                    onChange={e => updateImportGroup(g.key, { tc: e.target.value })} />
                                </div>
                              )}
                            </div>

                            <div className="field">
                              <label className="field-label">
                                Caja (opcional — si se carga, registra el egreso)
                              </label>
                              <select className="input" value={g.caja_id}
                                onChange={e => updateImportGroup(g.key, { caja_id: e.target.value })}>
                                <option value="">Sin caja (queda como deuda al proveedor)</option>
                                {cajasList.map(c => (
                                  <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>
                                ))}
                              </select>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {importError && <div style={{ color: 'var(--neg)', fontSize: 13, marginTop: 10 }}>{importError}</div>}
            </div>
            <div className="modal-ft">
              <button className="btn btn-ghost" onClick={() => setShowImport(false)}>Cancelar</button>
              {/* 2026-06-30 #imei-dup: bloqueamos si hay IMEIs duplicados en
                  el XLSX. Mismo criterio que el form alta — la integridad de
                  la carga es prioridad sobre velocidad. */}
              <button className="btn btn-primary"
                disabled={importing || importValidos.length === 0 || importGroups.length === 0 || importDupImeis.length > 0}
                onClick={confirmImport}>
                {importing
                  ? 'Importando…'
                  : importGroups.length > 0
                    ? `Importar ${importGroups.length} compra${importGroups.length === 1 ? '' : 's'}`
                    : 'Importar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal catálogos ── */}
      {showCatalogos && (
        <div ref={catalogosModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowCatalogos(false)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>Categorías &amp; Depósitos</h3>
              <button type="button" className="icon-btn" onClick={() => setShowCatalogos(false)} aria-label="Cerrar" title="Cerrar"><Icons.X size={16} /></button>
            </div>
            <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
              <div className="row">
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Categorías</div>
                  <div className="flex-row" style={{ gap: 6, marginBottom: 8 }}>
                    <input className="input" placeholder="Nueva categoría" value={nuevaCat} onChange={e => setNuevaCat(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCategoria(); } }} />
                    <button className="btn btn-sm" onClick={addCategoria}><Icons.Plus size={13} /></button>
                  </div>
                  <div className="stack" style={{ gap: 4 }}>
                    {categorias.length === 0 && <div className="muted tiny">Sin categorías</div>}
                    {categorias.map(c => {
                      const count = Number(c.productos_count ?? 0);
                      const stock = Number(c.stock_disponible ?? 0);
                      return (
                        <div key={c.id} className="flex-between" style={{ fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--hairline)' }}>
                          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.nombre}>{c.nombre}</span>
                          <span className="muted tiny" style={{ marginRight: 8, whiteSpace: 'nowrap' }} title={`${count} producto${count === 1 ? '' : 's'} cargado${count === 1 ? '' : 's'} · ${stock} unidad${stock === 1 ? '' : 'es'} en stock`}>
                            {count} prod · {stock} u
                          </span>
                          <button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => delCategoria(c)}><Icons.Trash size={13} /></button>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Depósitos</div>
                  <div className="flex-row" style={{ gap: 6, marginBottom: 8 }}>
                    <input className="input" placeholder="Nuevo depósito" value={nuevoDep} onChange={e => setNuevoDep(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDeposito(); } }} />
                    <button className="btn btn-sm" onClick={addDeposito}><Icons.Plus size={13} /></button>
                  </div>
                  <div className="stack" style={{ gap: 4 }}>
                    {depositos.length === 0 && <div className="muted tiny">Sin depósitos</div>}
                    {depositos.map(d => (
                      <div key={d.id} className="flex-between" style={{ fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--hairline)' }}>
                        <span>{d.nombre}</span>
                        <button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => delDeposito(d)}><Icons.Trash size={13} /></button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              {catError && <div style={{ color: 'var(--neg)', fontSize: 13, marginTop: 10 }}>{catError}</div>}
            </div>
            <div className="modal-ft">
              <button className="btn btn-primary" onClick={() => setShowCatalogos(false)}>Listo</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Historial del producto (Fase 2 trazabilidad, 2026-06-15) ── */}
      {/* Tabs Detalle / Historial:
            Detalle: campos clave del producto seleccionado en la grilla.
            Historial: compra de origen (match por IMEI en proveedor_movimiento_items)
                       + venta (FK producto_id en venta_items / items_movimiento_cc).
          El producto base viene del state productos (no necesita otro request) —
          solo el historial se fetchea on-demand. */}
      {mainTab === 'productos' && historialProductoId != null && (() => {
        const producto = productos.find(p => p.id === historialProductoId);
        return (
          <div ref={historialModalRef} className="modal-overlay"
            onClick={e => e.target === e.currentTarget && setHistorialProductoId(null)}>
            <div className="modal" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
              <div className="modal-hd">
                <h3>
                  {producto?.nombre || 'Producto'}
                  {producto?.imei && (
                    <span className="mono muted" style={{ fontSize: 12, fontWeight: 500, marginLeft: 10 }}>
                      {producto.imei}
                    </span>
                  )}
                </h3>
                <button type="button" className="icon-btn"
                  onClick={() => setHistorialProductoId(null)}
                  aria-label="Cerrar" title="Cerrar">
                  <Icons.X size={16} />
                </button>
              </div>
              <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                {/* Tabs simples (Detalle | Historial) usando el componente Seg. */}
                <HistorialModalContent
                  producto={producto}
                  data={historialData}
                  loading={historialLoading}
                  error={historialError}
                  categorias={categorias}
                  depositos={depositos}
                />
              </div>
              <div className="modal-ft">
                <button className="btn btn-primary" onClick={() => setHistorialProductoId(null)}>Cerrar</button>
              </div>
            </div>
          </div>
        );
      })()}
      </>)}
    </div>
  );
}

// Sub-componente del modal Historial. Aislado para tener su propio state de tab
// activo sin polucionar el componente principal de Inventario.
//
// Diseñado para que el Detalle muestre los campos clave del producto sin
// duplicar info que el usuario ya ve en la grilla; el Historial muestra la
// trazabilidad cross-módulo (compra de origen + venta).
function HistorialModalContent({ producto, data, loading, error, categorias, depositos }) {
  const [tab, setTab] = useState('detalle');
  if (!producto) return <div className="muted">Producto no encontrado.</div>;

  const cat = categorias.find(c => c.id === producto.categoria_id);
  const dep = depositos.find(d => d.id === producto.deposito_id);
  const fmtUSD = n => n != null ? `USD ${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : '—';
  const fmtFecha = f => f ? new Date(f).toLocaleDateString('es-AR') : '—';

  return (
    <>
      <Seg
        value={tab}
        onChange={setTab}
        options={[
          { value: 'detalle',   label: 'Detalle' },
          { value: 'historial', label: 'Historial' },
        ]}
      />

      {tab === 'detalle' && (
        <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <DetalleField label="Clase" value={producto.clase} />
          <DetalleField label="Estado" value={producto.estado} />
          <DetalleField label="Condición" value={producto.condicion || 'nuevo'} />
          <DetalleField label="Categoría" value={cat?.nombre || '—'} />
          <DetalleField label="Depósito" value={dep?.nombre || '—'} />
          <DetalleField label="Proveedor" value={producto.proveedor || '—'} />
          {producto.imei && <DetalleField label="IMEI/Serial" value={producto.imei} mono />}
          {producto.gb && <DetalleField label="GB" value={producto.gb} />}
          {producto.color && <DetalleField label="Color" value={producto.color} />}
          {producto.bateria != null && <DetalleField label="Batería" value={`${producto.bateria}%`} />}
          <DetalleField label="Costo"
            value={`${Number(producto.costo).toLocaleString('es-AR')} ${producto.costo_moneda}`} mono />
          <DetalleField label="Precio venta"
            value={`${Number(producto.precio_venta).toLocaleString('es-AR')} ${producto.precio_moneda}`} mono />
          <DetalleField label="Cantidad" value={producto.cantidad} />
          {producto.observaciones && (
            <div style={{ gridColumn: '1 / -1' }}>
              <DetalleField label="Observaciones" value={producto.observaciones} />
            </div>
          )}
        </div>
      )}

      {tab === 'historial' && (
        <div style={{ marginTop: 14 }}>
          {loading && <div className="muted">Cargando historial…</div>}
          {error && <div className="neg">Error: {error}</div>}
          {!loading && !error && data && (
            <>
              {/* ── Compra de origen ── */}
              <div style={{
                border: '1px solid var(--border)', borderRadius: 8,
                padding: 14, marginBottom: 12,
              }}>
                <div style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
                  color: 'var(--text-muted)', marginBottom: 10,
                }}>
                  📦 COMPRA DE ORIGEN
                </div>
                {data.compra ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <DetalleField label="Fecha" value={fmtFecha(data.compra.fecha)} />
                    <DetalleField label="Proveedor" value={data.compra.proveedor_nombre} />
                    <DetalleField label="Valor del ítem" value={fmtUSD(data.compra.valor_item)} mono />
                    <DetalleField label="Total compra" value={fmtUSD(data.compra.monto_usd)} mono />
                    {data.compra.descripcion && (
                      <div style={{ gridColumn: '1 / -1' }}>
                        <DetalleField label="Descripción" value={data.compra.descripcion} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="muted tiny">
                    {producto.imei
                      ? 'No se encontró compra de origen para este IMEI (puede ser anterior al sistema de trazabilidad).'
                      : 'Sin trazabilidad de compra (producto sin IMEI individual).'}
                  </div>
                )}
              </div>

              {/* ── Venta ── */}
              <div style={{
                border: '1px solid var(--border)', borderRadius: 8, padding: 14,
              }}>
                <div style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
                  color: 'var(--text-muted)', marginBottom: 10,
                }}>
                  🏷 VENTA
                </div>
                {data.venta ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <DetalleField label="Fecha" value={fmtFecha(data.venta.fecha)} />
                    <DetalleField label="Cliente" value={data.venta.cliente_nombre || '—'} />
                    <DetalleField label="Precio cobrado"
                      value={`${Number(data.venta.precio_vendido).toLocaleString('es-AR')} ${data.venta.moneda}`} mono />
                    <DetalleField label="Canal"
                      value={data.venta.tipo === 'b2b' ? 'B2B (cuenta corriente)' : 'Retail'} />
                    {data.venta.ganancia_usd != null && (
                      <DetalleField label="Ganancia (venta)" value={fmtUSD(data.venta.ganancia_usd)} mono />
                    )}
                    {data.venta.estado && (
                      <DetalleField label="Estado" value={data.venta.estado} />
                    )}
                  </div>
                ) : (
                  <div className="muted tiny">
                    Sin ventas registradas. El producto sigue en stock.
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// Mini-componente helper para mostrar pares label/value uniformes en Detalle/Historial.
function DetalleField({ label, value, mono = false }) {
  return (
    <div>
      <div className="muted tiny" style={{ marginBottom: 2 }}>{label}</div>
      <div className={mono ? 'mono' : ''} style={{ fontSize: 13, fontWeight: 500 }}>{value}</div>
    </div>
  );
}
