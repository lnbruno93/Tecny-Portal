import { Fragment, useState, useEffect, useMemo, useRef } from 'react';
import { silentReport } from '../lib/reportError';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icons } from '../components/Icons';
import { cajas, contactos as contactosApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import { Skeleton, SkeletonRow } from '../components/Skeleton';
import useModal from '../lib/useModal';
import ContactoPickerEmbedded from '../components/ContactoPickerEmbedded';
import Badge from '../components/Badge';
// 2026-06-29 Multi-país F3: monedas según país del tenant en form alta caja.
import { useMonedasTenant } from '../lib/useMonedasTenant';


// ─── Formatters ───────────────────────────────────────────────────────────────
function todayISO() {
  return new Date().toLocaleDateString('sv'); // YYYY-MM-DD
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const TIPO_TONE  = { amigo: 'info', familiar: 'accent', cliente: 'pos', inversor: 'warn', 'ipro team': 'default' };
// El value 'ipro team' es legacy (constraint DB pre-rebrand 2026-06-18 #324).
// Mantenemos el value para no romper rows existentes; solo cambia el display.
const TIPO_LABEL = { amigo: 'Amigo', familiar: 'Familiar', cliente: 'Cliente', inversor: 'Inversor', 'ipro team': 'Tecny team' };

// Badge ahora vive en frontend/src/components/Badge.jsx (U-13 dedup,
// auditoría 2026-06-10) — importado arriba.
function Status({ tone = 'default', children }) {
  return <span className={`status s-${tone}`}>{children}</span>;
}

// Group deuda movements by contacto_id, compute net saldo
function groupDeudas(movs) {
  const map = {};
  movs.forEach(m => {
    const id = m.contacto_id;
    if (!map[id]) {
      map[id] = {
        contacto_id: id,
        nombre: m.nombre,
        apellido: m.apellido,
        contacto_tipo: m.contacto_tipo,
        saldo_ars: 0,
        saldo_usd: 0,
        movimientos: 0,
        ultima: null,
      };
    }
    const sign = m.mov_tipo === 'debe' ? 1 : -1;
    map[id].saldo_ars += sign * (parseFloat(m.monto_ars) || 0);
    map[id].saldo_usd += sign * (parseFloat(m.monto_usd) || 0);
    map[id].movimientos++;
    if (!map[id].ultima || m.fecha > map[id].ultima) map[id].ultima = m.fecha;
  });
  return Object.values(map).sort((a, b) => b.saldo_ars - a.saldo_ars);
}

// `contactoMode` permite alternar entre "elegir contacto existente" (default)
// y "crear uno nuevo en el mismo form" (mega-form). Si mode='nuevo', los campos
// `nuevoNombre/Apellido/Tipo` se usan al guardar para crear el contacto antes
// del movimiento. Esto evita el patrón "modal sobre modal" para users que
// prefieren todo en un solo step.
const EMPTY_DEUDA = () => ({
  fecha: todayISO(), contacto_id: '', tipo: 'debe', monto_ars: '', monto_usd: '', concepto: '',
  contactoMode: 'existente', nuevoNombre: '', nuevoApellido: '', nuevoTipo: 'amigo',
});
const EMPTY_INV = () => ({
  fecha: todayISO(), contacto_id: '', monto: '', tasa: '',
  contactoMode: 'existente', nuevoNombre: '', nuevoApellido: '', nuevoTipo: 'inversor',
});

// ─── Main component ───────────────────────────────────────────────────────────
export default function Cajas() {
  const { toast } = useToast();
  // 2026-06-29 Multi-país F3: monedas disponibles para nueva caja según tenant.
  const { monedas, monedaLocal } = useMonedasTenant();
  const confirm   = useConfirm();
  const navigate  = useNavigate();
  // Audit 2026-07-04 P2: deep-link `?tab=X` para compartir/bookmarkear una tab
  // específica de Cajas (config | deudas | inversiones). Sin esto el usuario
  // siempre aterriza en Config aunque venga de un link "ir a Cajas > Deudas".
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (() => {
    const t = searchParams.get('tab');
    return ['config', 'deudas', 'inversiones'].includes(t) ? t : 'config';
  })();
  const [tab, setTab] = useState(initialTab);

  // Sincronizamos el tab con la URL cuando el user cambia de pestaña, con
  // `replace: true` para no llenar el history stack con cada click. Reset al
  // default no ensucia la URL con `?tab=config`.
  useEffect(() => {
    const current = searchParams.get('tab');
    if (tab === 'config') {
      if (current) {
        const next = new URLSearchParams(searchParams);
        next.delete('tab');
        setSearchParams(next, { replace: true });
      }
    } else if (current !== tab) {
      const next = new URLSearchParams(searchParams);
      next.set('tab', tab);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Deudas
  const [deudaMovs, setDeudaMovs] = useState([]);
  const [selectedContactoId, setSelectedContactoId] = useState(null);
  const [loadingDeudas, setLoadingDeudas] = useState(false);
  const [contactoMovs, setContactoMovs] = useState([]);
  const [loadingContactoMovs, setLoadingContactoMovs] = useState(false);

  // Inversiones
  const [inversiones, setInversiones] = useState([]);
  const [loadingInv, setLoadingInv] = useState(false);

  // All contacts for dropdowns (loaded once)
  const [allContacts, setAllContacts] = useState([]);
  useEffect(() => {
    // Contactos ahora paginado (post-audit). Unwrap defensivo para soportar
    // ambos shapes — el endpoint devuelve { data, pagination }.
    contactosApi.list({ limit: 500 })
      .then(r => setAllContacts(Array.isArray(r) ? r : (r?.data ?? [])))
      .catch(silentReport);
  }, []);

  // ── Crear contacto ────────────────────────────────────────────────────────
  // El modal de "Nuevo contacto" se invoca solo desde el botón "+ Nuevo contacto"
  // de la barra principal — para crear contactos standalone sin un movimiento
  // asociado. Inversión/Deuda ya tienen su propio mega-form con creación inline.
  const [showContacto, setShowContacto] = useState(false);
  const [cForm, setCForm] = useState({ nombre: '', apellido: '', tipo: 'amigo' });
  const [cCreating, setCCreating] = useState(false);
  const [cError, setCError] = useState('');

  // ── Crear movimiento de deuda ─────────────────────────────────────────────
  const [showDeuda, setShowDeuda] = useState(false);
  const [deudaForm, setDeudaForm] = useState(EMPTY_DEUDA);
  const [deudaCreating, setDeudaCreating] = useState(false);
  const [deudaError, setDeudaError] = useState('');

  // ── Crear inversión ───────────────────────────────────────────────────────
  const [showInv, setShowInv] = useState(false);
  const [invForm, setInvForm] = useState(EMPTY_INV);
  const [invCreating, setInvCreating] = useState(false);
  const [invError, setInvError] = useState('');

  // ── Config Cajas (cuentas de dinero = metodos_pago) ───────────────────────
  const [cajasList, setCajasList] = useState([]);
  const [loadingCajas, setLoadingCajas] = useState(false);
  // 2026-06-29 Multi-país F3: initial state usa 'ARS' por compat con el
  // mount inicial sync (cuando user todavía no hidrató). El effect abajo
  // sincroniza a monedaLocal cuando el hook está listo.
  const [cajaForm, setCajaForm] = useState({ nombre: '', moneda: 'ARS', saldo_inicial: '', es_tarjeta: false, comision_pct: '' });
  useEffect(() => {
    setCajaForm(f => f.moneda === 'ARS' && monedaLocal !== 'ARS' && !f.nombre ? { ...f, moneda: monedaLocal } : f);
  }, [monedaLocal]);
  const [cajaSaving, setCajaSaving] = useState(false);
  const [cajaError, setCajaError] = useState('');
  // Ledger de una caja (modal con movimientos + ajuste manual + saldo inicial)
  const [cajaSel, setCajaSel] = useState(null);
  const [cajaMovs, setCajaMovs] = useState([]);
  const [ajusteForm, setAjusteForm] = useState({ fecha: todayISO(), tipo: 'ingreso', monto: '', tc: '', concepto: '' });
  const [ajusteSaving, setAjusteSaving] = useState(false);

  // Refs para useModal (TANDA 1 post-auditoría 2026-06-03): los 4 modales
  // de esta pantalla se hacían sin Esc handler, focus-trap ni scroll-lock.
  // El hook se encarga de los 3 patterns + foco al primer input.
  const ledgerModalRef    = useRef(null);
  const contactoModalRef  = useRef(null);
  const deudaModalRef     = useRef(null);
  const invModalRef       = useRef(null);
  useModal({ open: !!cajaSel,    onClose: () => !ajusteSaving && setCajaSel(null),    overlayRef: ledgerModalRef });
  useModal({ open: showContacto, onClose: () => !cCreating && setShowContacto(false), overlayRef: contactoModalRef });
  useModal({ open: showDeuda,    onClose: () => !deudaCreating && setShowDeuda(false), overlayRef: deudaModalRef });
  useModal({ open: showInv,      onClose: () => !invCreating && setShowInv(false),     overlayRef: invModalRef });

  // (El ledger global / historial de movimientos vive ahora en la pantalla "360 & Capital".)

  // ── Tab-aware primary action ──────────────────────────────────────────────
  const { setPrimaryAction } = usePageActions();
  useEffect(() => {
    if (tab === 'deudas') {
      setPrimaryAction({
        label: 'Nuevo movimiento',
        onClick: () => { setDeudaForm(EMPTY_DEUDA()); setDeudaError(''); setShowDeuda(true); },
      });
    } else if (tab === 'inversiones') {
      setPrimaryAction({
        label: 'Nueva inversión',
        onClick: () => { setInvForm(EMPTY_INV()); setInvError(''); setShowInv(true); },
      });
    } else {
      setPrimaryAction(null); // Config Cajas usa formulario inline
    }
    return () => setPrimaryAction(null);
  }, [tab, setPrimaryAction]);

  // 2026-07-16 (task #144 UX A): estado de error persistente para el load
  // de cajas. Antes: solo toast que desaparece en 5s → user perdía la señal
  // y no podía reintentar sin refrescar la página completa.
  const [cajasError, setCajasError] = useState(null);

  // Cargar cajas al entrar a la hoja Config
  async function loadCajas() {
    setLoadingCajas(true);
    setCajasError(null);
    try { setCajasList(await cajas.listCajas() || []); }
    catch (e) {
      // Auditoría 2026-06-30 Q-08: era console.error silencioso.
      // El user veía la lista vacía sin entender por qué (cualquier 5xx /
      // network error pasaba mudo). Ahora reportamos a Sentry y avisamos.
      silentReport(e, { context: 'Cajas.loadCajas' });
      // 2026-07-16 (#144): además del toast (visibilidad inmediata), guardamos
      // el error en state para renderizar banner + Reintentar persistente.
      const msg = 'No pudimos cargar las cajas. Reintentá.';
      toast.error(msg);
      setCajasError(msg);
    }
    finally { setLoadingCajas(false); }
  }
  useEffect(() => { if (tab === 'config') loadCajas(); }, [tab]);

  // B1 trazabilidad: tras correr backfill en Config → Mantenimiento, el
  // backend invalida su cache pero acá tenemos saldos en state local. Refresh
  // si la pantalla está montada cuando llega el evento.
  useEffect(() => {
    const onCajasChanged = () => { if (tab === 'config') loadCajas(); };
    window.addEventListener('cajas-changed', onCajasChanged);
    return () => window.removeEventListener('cajas-changed', onCajasChanged);
  }, [tab]);


  // ── Handlers ─────────────────────────────────────────────────────────────
  async function handleCreateContacto(e) {
    e.preventDefault();
    if (!cForm.nombre.trim()) { setCError('El nombre es obligatorio.'); return; }
    setCCreating(true); setCError('');
    try {
      const nuevo = await contactosApi.create({
        nombre: cForm.nombre.trim(),
        apellido: cForm.apellido.trim() || null,
        tipo: cForm.tipo,
      });
      // Agregamos a la lista maestra para que aparezca en selects de movimientos.
      setAllContacts(prev => [...prev, nuevo]);
      // Agregamos placeholder en la grilla de deudas para feedback visual
      // inmediato y saltamos a esa tab si no estamos ya ahí.
      setDeudaMovs(prev => [...prev, {
        contacto_id: nuevo.id, nombre: nuevo.nombre, apellido: nuevo.apellido,
        contacto_tipo: nuevo.tipo, mov_tipo: 'debe', monto_ars: 0, monto_usd: 0, fecha: null,
        id: -nuevo.id, concepto: null, created_at: null,
      }]);
      setSelectedContactoId(nuevo.id);
      setShowContacto(false);
      if (tab !== 'deudas') setTab('deudas');
      toast.success('Contacto creado.');
    } catch (err) { setCError(err.message); }
    finally { setCCreating(false); }
  }

  // Helper compartido: resuelve el contacto_id que va a recibir un movimiento.
  // Si form.contactoMode === 'nuevo', crea el contacto en el momento y devuelve
  // su id. Si es 'existente', devuelve el id ya seleccionado en el select.
  //
  // Tira error con mensaje legible si los datos son inválidos — el caller lo
  // captura y muestra en el error del modal.
  //
  // Construye el payload de contacto para el endpoint mega-form transaccional.
  // El backend hace contacto + movimiento en una sola tx, así que NO creamos
  // el contacto por separado. Antes esta función creaba un contacto HTTP y
  // devolvía solo el id — si después fallaba el INSERT del movimiento, el
  // contacto quedaba huérfano. Ahora le pasamos los datos al backend y él
  // decide si crear o reusar.
  //
  // Retorna: { contacto_id } | { contacto_nuevo: { nombre, apellido, tipo } }
  function buildContactoPayload(form) {
    if (form.contactoMode === 'nuevo') {
      const nombre = (form.nuevoNombre || '').trim();
      if (!nombre) {
        const e = new Error('Ingresá el nombre del contacto nuevo.'); e.tag = 'validation'; throw e;
      }
      return {
        contacto_nuevo: {
          nombre,
          apellido: (form.nuevoApellido || '').trim() || null,
          tipo: form.nuevoTipo || 'amigo',
        },
      };
    }
    if (!form.contacto_id) {
      const e = new Error('Seleccioná un contacto o creá uno nuevo.'); e.tag = 'validation'; throw e;
    }
    return { contacto_id: Number(form.contacto_id) };
  }

  async function handleCreateDeuda(e) {
    e.preventDefault();
    const monto_ars = parseFloat(deudaForm.monto_ars) || 0;
    const monto_usd = parseFloat(deudaForm.monto_usd) || 0;
    if (!monto_ars && !monto_usd) { setDeudaError('Ingresá al menos un monto.'); return; }

    setDeudaCreating(true); setDeudaError('');
    try {
      // Backend hace contacto + movimiento en una sola tx (atómico).
      // buildContactoPayload puede tirar 'validation' error si nombre/select faltan.
      const contactoPayload = buildContactoPayload(deudaForm);

      const movimiento = await cajas.createDeuda({
        fecha:       deudaForm.fecha,
        ...contactoPayload,
        tipo:        deudaForm.tipo,
        monto_ars,
        monto_usd,
        concepto:    deudaForm.concepto.trim() || null,
      });
      const cid = movimiento.contacto_id;
      // Si se creó contacto nuevo, refrescamos la lista para próximos selects.
      if (contactoPayload.contacto_nuevo) {
        contactosApi.list({ limit: 500 }).then(r => setAllContacts(r.data || [])).catch(() => {});
      }
      setShowDeuda(false);
      toast.success(
        deudaForm.contactoMode === 'nuevo'
          ? `${deudaForm.nuevoNombre.trim()} creado y movimiento registrado.`
          : 'Movimiento registrado.'
      );

      // Refresh global deuda list
      setLoadingDeudas(true);
      cajas.deudas({ limit: 500 })
        .then(res => setDeudaMovs(res.data || []))
        .catch(silentReport)
        .finally(() => setLoadingDeudas(false));

      // Auto-select the contacto and refresh its detail
      setSelectedContactoId(cid);
      setLoadingContactoMovs(true);
      cajas.deudas({ contacto_id: cid, limit: 200 })
        .then(res => setContactoMovs(res.data || []))
        .catch(silentReport)
        .finally(() => setLoadingContactoMovs(false));
    } catch (err) { setDeudaError(err.message); }
    finally { setDeudaCreating(false); }
  }

  async function handleCreateInversion(e) {
    e.preventDefault();
    const monto = parseFloat(invForm.monto);
    if (!monto || monto <= 0) { setInvError('El monto debe ser mayor a 0.'); return; }

    setInvCreating(true); setInvError('');
    try {
      // Backend hace contacto + movimiento en una sola tx (atómico).
      const contactoPayload = buildContactoPayload(invForm);

      const movimiento = await cajas.createInversion({
        fecha:       invForm.fecha,
        ...contactoPayload,
        monto,
        tasa:        invForm.tasa.trim() || null,
      });
      const cid = movimiento.contacto_id;
      if (contactoPayload.contacto_nuevo) {
        contactosApi.list({ limit: 500 }).then(r => setAllContacts(r.data || [])).catch(() => {});
      }
      setShowInv(false);
      toast.success(
        invForm.contactoMode === 'nuevo'
          ? `${invForm.nuevoNombre.trim()} creado e inversión registrada.`
          : 'Inversión registrada.'
      );

      // Refresh inversiones list
      setLoadingInv(true);
      cajas.inversiones({ limit: 200 })
        .then(res => setInversiones(res.data || []))
        .catch(silentReport)
        .finally(() => setLoadingInv(false));
    } catch (err) { setInvError(err.message); }
    finally { setInvCreating(false); }
  }

  // Load deudas
  useEffect(() => {
    if (tab !== 'deudas') return;
    setLoadingDeudas(true);
    cajas.deudas({ limit: 500 })
      .then(res => setDeudaMovs(res.data || []))
      .catch(silentReport)
      .finally(() => setLoadingDeudas(false));
  }, [tab]);

  // Load contacto movements when selected
  useEffect(() => {
    if (!selectedContactoId) { setContactoMovs([]); return; }
    setLoadingContactoMovs(true);
    cajas.deudas({ contacto_id: selectedContactoId, limit: 200 })
      .then(res => setContactoMovs(res.data || []))
      .catch(silentReport)
      .finally(() => setLoadingContactoMovs(false));
  }, [selectedContactoId]);

  // Load inversiones
  useEffect(() => {
    if (tab !== 'inversiones') return;
    setLoadingInv(true);
    cajas.inversiones({ limit: 200 })
      .then(res => setInversiones(res.data || []))
      .catch(silentReport)
      .finally(() => setLoadingInv(false));
  }, [tab]);

  // Group deudas by contacto
  const contactosDeuda = useMemo(() => groupDeudas(deudaMovs), [deudaMovs]);
  const selectedContacto = useMemo(
    () => contactosDeuda.find(c => c.contacto_id === selectedContactoId),
    [contactosDeuda, selectedContactoId]
  );

  // KPIs for deudas
  const totalDeudaARS     = useMemo(() => contactosDeuda.filter(c => c.saldo_ars > 0).reduce((s, c) => s + c.saldo_ars, 0), [contactosDeuda]);
  const totalDeudaUSD     = useMemo(() => contactosDeuda.filter(c => c.saldo_usd > 0).reduce((s, c) => s + c.saldo_usd, 0), [contactosDeuda]);
  const conDeuda          = useMemo(() => contactosDeuda.filter(c => c.saldo_ars > 0 || c.saldo_usd > 0).length, [contactosDeuda]);
  const mayorSaldo        = useMemo(() => contactosDeuda.length ? Math.max(...contactosDeuda.map(c => c.saldo_ars)) : 0, [contactosDeuda]);

  // KPIs for inversiones
  const totalInvUSD       = useMemo(() => inversiones.reduce((s, m) => s + (parseFloat(m.monto) || 0), 0), [inversiones]);
  const inversoresActivos = useMemo(() => new Set(inversiones.map(m => m.contacto_id)).size, [inversiones]);

  // Agrupado por inversor (2026-06-15): un mismo contacto puede tener N inversiones.
  // Antes se mostraban como N filas separadas; ahora se muestran como 1 fila resumen
  // (total acumulado, último ingreso, cantidad) con sub-filas expandibles para el
  // desglose de cada movimiento individual.
  const inversionesAgrupadas = useMemo(() => {
    const grupos = new Map(); // contacto_id → { nombre, contacto_tipo, items, totalUsd, tasas }
    for (const m of inversiones) {
      const key = m.contacto_id ?? `__sin_${m.id}`; // defensivo: fila sin contacto (caso edge)
      if (!grupos.has(key)) {
        grupos.set(key, {
          contacto_id: m.contacto_id,
          nombre: `${m.nombre || ''} ${m.apellido || ''}`.trim() || '—',
          contacto_tipo: m.contacto_tipo,
          items: [],
          totalUsd: 0,
          tasasDistintas: new Set(),  // si todos comparten tasa, mostramos 1 sola; sino "varias"
          ultimaFecha: null,
        });
      }
      const g = grupos.get(key);
      g.items.push(m);
      g.totalUsd += parseFloat(m.monto) || 0;
      if (m.tasa) g.tasasDistintas.add(String(m.tasa).trim());
      if (!g.ultimaFecha || new Date(m.fecha) > new Date(g.ultimaFecha)) g.ultimaFecha = m.fecha;
    }
    // Orden: el grupo cuyo último ingreso es más reciente primero (matchea la
    // sensación de "qué pasó recién" — igual que la vista plana original).
    return [...grupos.values()].sort((a, b) => new Date(b.ultimaFecha) - new Date(a.ultimaFecha));
  }, [inversiones]);

  // State de grupos expandidos. Set<contacto_id> — un click en el chevron
  // toggle. Por default todos colapsados (mostramos el resumen).
  const [inversoresExpandidos, setInversoresExpandidos] = useState(() => new Set());
  const toggleInversor = (key) => setInversoresExpandidos(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // Delete handlers
  async function handleDeleteDeuda(id) {
    const ok = await confirm({ title: 'Eliminar movimiento', message: 'Esta acción no se puede deshacer.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await cajas.deleteDeuda(id);
      setContactoMovs(prev => prev.filter(m => m.id !== id));
      cajas.deudas({ limit: 500 }).then(res => setDeudaMovs(res.data || []));
      toast.success('Movimiento eliminado.');
    } catch (e) { toast.error(e.message); }
  }

  async function handleDeleteInversion(id) {
    const ok = await confirm({ title: 'Eliminar inversión', message: 'Esta acción no se puede deshacer.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await cajas.deleteInversion(id);
      setInversiones(prev => prev.filter(m => m.id !== id));
      toast.success('Inversión eliminada.');
    } catch (e) { toast.error(e.message); }
  }

  // ── Config Cajas handlers ──────────────────────────────────────────────────
  async function handleCreateCaja(e) {
    e.preventDefault();
    if (!cajaForm.nombre.trim()) { setCajaError('El nombre es obligatorio.'); return; }
    setCajaSaving(true); setCajaError('');
    try {
      await cajas.createCaja({
        nombre: cajaForm.nombre.trim(), moneda: cajaForm.moneda,
        saldo_inicial: cajaForm.saldo_inicial ? Number(cajaForm.saldo_inicial) : 0,
        es_tarjeta: !!cajaForm.es_tarjeta,
        comision_pct: cajaForm.es_tarjeta && cajaForm.comision_pct !== '' ? Number(cajaForm.comision_pct) : null,
      });
      // 2026-06-29 Multi-país F3: default moneda local del tenant (ARS o UYU).
      setCajaForm({ nombre: '', moneda: monedaLocal, saldo_inicial: '', es_tarjeta: false, comision_pct: '' });
      toast.success('Caja creada.');
      loadCajas();
    } catch (e) { setCajaError(e.message || 'No se pudo crear la caja.'); }
    finally { setCajaSaving(false); }
  }

  async function handleToggleCaja(c) {
    try { await cajas.updateCaja(c.id, { activo: !c.activo }); loadCajas(); }
    catch (e) { toast.error(e.message); }
  }

  async function handleToggleFinanciera(c) {
    try { await cajas.updateCaja(c.id, { es_financiera: !c.es_financiera }); loadCajas(); }
    catch (e) { toast.error(e.message); }
  }

  async function handleDeleteCaja(c) {
    const ok = await confirm({ title: 'Eliminar caja', message: `¿Eliminar "${c.nombre}"? No afecta movimientos ya registrados.`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await cajas.deleteCaja(c.id); toast.success('Caja eliminada.'); loadCajas(); }
    catch (e) { toast.error(e.message); }
  }

  // ── Ledger de caja ──
  async function openCajaLedger(c) {
    setCajaSel(c);
    setAjusteForm({ fecha: todayISO(), tipo: 'ingreso', monto: '', tc: '', concepto: '' });
    try { const r = await cajas.cajaMovimientos(c.id); setCajaMovs(r.data || []); }
    catch (e) { toast.error(e.message); setCajaMovs([]); }
  }
  async function handleSaldoInicial(c, valor) {
    const v = valor === '' ? 0 : Number(valor);
    if (Number(c.saldo_inicial) === v) return;
    try { await cajas.updateCaja(c.id, { saldo_inicial: v }); loadCajas(); }
    catch (e) { toast.error(e.message); }
  }
  async function handleCreateAjuste(e) {
    e.preventDefault();
    if (!ajusteForm.monto || Number(ajusteForm.monto) <= 0) { toast.error('El monto debe ser mayor a 0.'); return; }
    if (cajaSel.moneda === 'ARS' && (!ajusteForm.tc || Number(ajusteForm.tc) <= 0)) { toast.error('Para una caja en ARS ingresá el TC.'); return; }
    setAjusteSaving(true);
    try {
      await cajas.createCajaAjuste(cajaSel.id, {
        fecha: ajusteForm.fecha, tipo: ajusteForm.tipo, monto: Number(ajusteForm.monto),
        tc: cajaSel.moneda === 'ARS' ? Number(ajusteForm.tc) : null,
        concepto: ajusteForm.concepto || null,
      });
      toast.success('Ajuste registrado.');
      setAjusteForm({ fecha: todayISO(), tipo: 'ingreso', monto: '', tc: '', concepto: '' });
      { const r = await cajas.cajaMovimientos(cajaSel.id); setCajaMovs(r.data || []); }
      loadCajas();
    } catch (e) { toast.error(e.message || 'No se pudo registrar.'); }
    finally { setAjusteSaving(false); }
  }
  async function handleDeleteCajaMov(m) {
    try { await cajas.deleteCajaMov(m.id); setCajaMovs(prev => prev.filter(x => x.id !== m.id)); loadCajas(); }
    catch (e) { toast.error(e.message); }
  }

  return (
    <div>
      {/* Page head */}
      <div className="page-head" style={{ marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 className="page-title">Cajas</h1>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/capital')} title="Ir a 360 & Capital">
              360 &amp; Capital →
            </button>
          </div>
          <div className="page-sub">Deudas e inversiones por contacto</div>
        </div>
        <div className="page-actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="tabs">
            {[{ value: 'config', label: 'Config Cajas' }, { value: 'deudas', label: 'Deudas a cobrar' }, { value: 'inversiones', label: 'Inversiones' }].map(t => (
              <button key={t.value} className={'tab' + (tab === t.value ? ' active' : '')}
                      onClick={() => { setTab(t.value); setSelectedContactoId(null); }}>
                {t.label}
              </button>
            ))}
          </div>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => { setCForm({ nombre: '', apellido: '', tipo: 'amigo' }); setCError(''); setShowContacto(true); }}
          >
            + Contacto
          </button>
        </div>
      </div>

      {/* ── DEUDAS TAB ─────────────────────────────────────────────────── */}
      {tab === 'deudas' && (
        <>
          {/* KPIs — 2026-06-24 mobile lote E: .row → .kpi-grid responsive */}
          <div className="kpi-grid" style={{ marginBottom: 20, gap: 12 }}>
            {[
              { label: 'Total deuda · ARS', value: <><span className="ccy">ARS</span><span className="mono neg">{fmt(totalDeudaARS)}</span></>, sub: `${conDeuda} contactos` },
              { label: 'Total deuda · USD', value: <><span className="ccy">USD</span><span className="mono neg">{fmt(totalDeudaUSD)}</span></>, sub: 'en divisas' },
              { label: 'Contactos con deuda', value: <span className="mono">{conDeuda}</span>, sub: `de ${contactosDeuda.length} total` },
              { label: 'Mayor saldo', value: <><span className="ccy">ARS</span><span className="mono">{fmt(mayorSaldo)}</span></>, sub: 'deuda individual más alta' },
            ].map(k => (
              <div key={k.label} className="card card-tight u-flex-1">
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-value">{k.value}</div>
                <div className="muted tiny u-mt-6">{k.sub}</div>
              </div>
            ))}
          </div>

          {/* Layout vertical: lista full-width + detail debajo cuando hay
              contacto seleccionado.
              2026-07-15 (task #133): antes usábamos split-master-detail 300px
              lateral — pero la tabla de la lista tiene 5 columnas (Contacto,
              Tipo, Saldo ARS, Saldo USD, Último) que en 300px quedaban
              pisadas ("SALD ARS" cortado, nombres a 2 líneas). Ahora la
              lista mantiene su ancho completo (como en la vista sin
              drill-down) y el detail se expande abajo. Feedback textual:
              "La sección de deudas de clientes se rompe" — Lucas remite al
              primer screenshot (sin drill-down) que se ve bien y quería
              conservar esa vista siempre. */}
          <div className="stack" style={{ gap: 'var(--gap)' }}>
            {/* Lista */}
            <div className="card card-flush">
              {/* Header del card con botón contextual de acción primaria.
                  El mismo botón existe en el Shell (icono "+" arriba) — esta
                  versión es más descubrible para users nuevos. Útil sobre todo
                  cuando NO hay contacto seleccionado: el "+Movimiento" del
                  detalle a la derecha requiere primero clickear un contacto. */}
              <div className="card-hd flex-between" style={{ alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>Por contacto</h3>
                <button className="btn btn-primary btn-sm"
                        onClick={() => { setDeudaForm(EMPTY_DEUDA()); setDeudaError(''); setShowDeuda(true); }}>
                  <Icons.Plus size={13} /> Nuevo movimiento
                </button>
              </div>
              {loadingDeudas ? (
                <div className="empty">Cargando…</div>
              ) : contactosDeuda.length === 0 ? (
                <div className="empty">Sin movimientos</div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Contacto</th>
                      <th>Tipo</th>
                      <th className="num">Saldo ARS</th>
                      <th className="num">Saldo USD</th>
                      <th>Último</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contactosDeuda.map(c => (
                      <tr key={c.contacto_id}
                          className="tbl-row-click"
                          onClick={() => setSelectedContactoId(c.contacto_id === selectedContactoId ? null : c.contacto_id)}
                          style={{ background: c.contacto_id === selectedContactoId ? 'var(--surface-2)' : undefined }}>
                        <td className="u-fw-600">{c.nombre} {c.apellido || ''}</td>
                        <td><Badge tone={TIPO_TONE[c.contacto_tipo] || 'default'}>{TIPO_LABEL[c.contacto_tipo] || c.contacto_tipo}</Badge></td>
                        <td className="num mono" style={{ color: c.saldo_ars > 0 ? 'var(--neg)' : c.saldo_ars < 0 ? 'var(--pos)' : 'var(--text-muted)', fontWeight: 600 }}>
                          {c.saldo_ars !== 0 ? fmt(c.saldo_ars) : <span className="dim">—</span>}
                        </td>
                        <td className="num mono" style={{ color: c.saldo_usd > 0 ? 'var(--neg)' : c.saldo_usd < 0 ? 'var(--pos)' : 'var(--text-muted)' }}>
                          {c.saldo_usd !== 0 ? fmt(c.saldo_usd) : <span className="dim">—</span>}
                        </td>
                        <td className="muted tiny">{fmtFecha(c.ultima)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Detalle de movimientos del contacto seleccionado */}
            {selectedContactoId && selectedContacto && (
              <div className="card card-flush">
                <div className="card-hd">
                  <div>
                    <h3>{selectedContacto.nombre} {selectedContacto.apellido || ''}</h3>
                    <div className="muted tiny u-mt-2">
                      <Badge tone={TIPO_TONE[selectedContacto.contacto_tipo] || 'default'}>
                        {TIPO_LABEL[selectedContacto.contacto_tipo] || selectedContacto.contacto_tipo}
                      </Badge>
                      <span style={{ marginLeft: 8 }}>
                        Saldo ARS: <strong className={selectedContacto.saldo_ars > 0 ? 'neg' : 'pos'}>{fmt(selectedContacto.saldo_ars)}</strong>
                        {selectedContacto.saldo_usd !== 0 && <> · USD: <strong>{fmt(selectedContacto.saldo_usd)}</strong></>}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 12, padding: '4px 10px' }}
                      onClick={() => {
                        setDeudaForm({ ...EMPTY_DEUDA(), contacto_id: String(selectedContactoId) });
                        setDeudaError('');
                        setShowDeuda(true);
                      }}
                    >
                      + Movimiento
                    </button>
                    <button className="icon-btn" onClick={() => setSelectedContactoId(null)}>
                      <Icons.X size={15} />
                    </button>
                  </div>
                </div>
                {/* 2026-06-25 UX-3 (audit pre-live): skeleton rows en lugar
                    de "Cargando…" plano. */}
                {loadingContactoMovs ? (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Tipo</th>
                        <th className="num">Monto ARS</th>
                        <th className="num">Monto USD</th>
                        <th>Concepto</th>
                        <th style={{ width: 40 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: 4 }).map((_, i) => <SkeletonRow key={i} columns={6} />)}
                    </tbody>
                  </table>
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Tipo</th>
                        <th className="num">Monto ARS</th>
                        <th className="num">Monto USD</th>
                        <th>Concepto</th>
                        <th style={{ width: 40 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {contactoMovs.map(m => (
                        <tr key={m.id}>
                          <td className="muted mono tiny">{fmtFecha(m.fecha)}</td>
                          <td>
                            <Status tone={m.mov_tipo === 'debe' ? 'neg' : 'pos'}>
                              {m.mov_tipo === 'debe' ? 'Debe' : 'Pago'}
                            </Status>
                          </td>
                          <td className="num mono" style={{ fontWeight: 600, color: m.mov_tipo === 'debe' ? 'var(--neg)' : 'var(--pos)' }}>
                            {parseFloat(m.monto_ars) ? fmt(m.monto_ars) : <span className="dim">—</span>}
                          </td>
                          <td className="num mono">
                            {parseFloat(m.monto_usd) ? fmt(m.monto_usd) : <span className="dim">—</span>}
                          </td>
                          <td className="muted">{m.concepto || <span className="dim">—</span>}</td>
                          <td>
                            <button className="icon-btn" onClick={() => handleDeleteDeuda(m.id)}>
                              <Icons.Trash size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {contactoMovs.length === 0 && (
                        <tr><td colSpan={6} className="empty">Sin movimientos</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── INVERSIONES TAB ────────────────────────────────────────────── */}
      {tab === 'inversiones' && (
        <>
          {/* KPIs — 2026-06-24 mobile lote E: .row → .kpi-grid responsive */}
          <div className="kpi-grid" style={{ marginBottom: 20, gap: 12 }}>
            {[
              { label: 'Total invertido · USD', value: <><span className="ccy">USD</span><span className="mono">{fmt(totalInvUSD)}</span></>, sub: `${inversiones.length} movimientos` },
              { label: 'Inversores activos', value: <span className="mono">{inversoresActivos}</span>, sub: 'contactos únicos' },
              { label: 'Último ingreso', value: <span className="mono" style={{ fontSize: 16 }}>{inversiones[0] ? fmtFecha(inversiones[0].fecha) : '—'}</span>, sub: inversiones[0]?.nombre || '' },
            ].map(k => (
              <div key={k.label} className="card card-tight u-flex-1">
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-value">{k.value}</div>
                <div className="muted tiny u-mt-6">{k.sub}</div>
              </div>
            ))}
          </div>

          <div className="card card-flush">
            {/* Header del card con botón contextual de acción primaria.
                El mismo botón existe en el Shell (icono "+" arriba a la derecha)
                — esta versión es más descubrible para users nuevos que esperan
                el botón DENTRO de la pantalla, al lado del título. */}
            <div className="card-hd flex-between" style={{ alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>Inversiones — {inversiones.length}</h3>
              <button className="btn btn-primary btn-sm"
                      onClick={() => { setInvForm(EMPTY_INV()); setInvError(''); setShowInv(true); }}>
                <Icons.Plus size={13} /> Nueva inversión
              </button>
            </div>
            {loadingInv ? (
              <div className="empty">Cargando…</div>
            ) : inversiones.length === 0 ? (
              <div className="empty">Sin inversiones registradas</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 32 }} aria-label="Expandir"></th>
                    <th>Último ingreso</th>
                    <th>Inversor</th>
                    <th>Tipo</th>
                    <th>Tasa</th>
                    <th className="num">Total USD</th>
                    <th className="num" style={{ width: 90 }}>Movs</th>
                    <th style={{ width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {/* Agrupado por inversor (2026-06-15): una fila resumen por
                      contacto + sub-filas expandibles con los movimientos
                      individuales. Permite ver al toque cuánto invirtió cada
                      uno en total, y profundizar si se necesita detalle. */}
                  {inversionesAgrupadas.map(g => {
                    const key = g.contacto_id ?? g.nombre;  // key estable
                    const expandido = inversoresExpandidos.has(key);
                    const tasaResumen = g.tasasDistintas.size === 0
                      ? null
                      : g.tasasDistintas.size === 1
                        ? [...g.tasasDistintas][0]
                        : 'varias';
                    return (
                      <Fragment key={key}>
                        {/* Fila resumen del inversor — click en cualquier parte
                            (excepto el botón de borrar) toggle el expand. */}
                        <tr
                          onClick={() => g.items.length > 1 && toggleInversor(key)}
                          style={{ cursor: g.items.length > 1 ? 'pointer' : 'default' }}
                        >
                          <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                            {g.items.length > 1 && (
                              <span style={{ fontSize: 11, fontWeight: 700 }}>
                                {expandido ? '▾' : '▸'}
                              </span>
                            )}
                          </td>
                          <td className="muted mono tiny">{fmtFecha(g.ultimaFecha)}</td>
                          <td className="u-fw-600">{g.nombre}</td>
                          <td><Badge tone={TIPO_TONE[g.contacto_tipo] || 'default'}>{TIPO_LABEL[g.contacto_tipo] || g.contacto_tipo}</Badge></td>
                          <td>
                            {tasaResumen
                              ? tasaResumen === 'varias'
                                ? <span className="muted tiny" style={{ fontStyle: 'italic' }}>varias</span>
                                : <span className="badge badge-info" style={{ fontSize: 11 }}>{tasaResumen}</span>
                              : <span className="dim">—</span>}
                          </td>
                          <td className="num mono" style={{ fontWeight: 700 }}>u$s {fmt(g.totalUsd)}</td>
                          <td className="num muted tiny">{g.items.length}</td>
                          <td>
                            {/* Si hay 1 sola inversión, mostramos delete acá
                                directo (no hay desglose útil). Si hay varias,
                                el delete vive en cada sub-fila. */}
                            {g.items.length === 1 && (
                              <button className="icon-btn"
                                onClick={(e) => { e.stopPropagation(); handleDeleteInversion(g.items[0].id); }}>
                                <Icons.Trash size={13} />
                              </button>
                            )}
                          </td>
                        </tr>

                        {/* Sub-filas: solo si está expandido y hay >1 movs */}
                        {expandido && g.items.length > 1 && g.items.map(m => (
                          <tr key={m.id} style={{ background: 'var(--surface-2)' }}>
                            <td></td>
                            <td className="muted mono tiny" style={{ paddingLeft: 24 }}>
                              └ {fmtFecha(m.fecha)}
                            </td>
                            <td colSpan={2} className="muted tiny">
                              {m.notas || <span className="dim">— sin nota —</span>}
                            </td>
                            <td>
                              {m.tasa
                                ? <span className="badge badge-info" style={{ fontSize: 11 }}>{m.tasa}</span>
                                : <span className="dim">—</span>}
                            </td>
                            <td className="num mono" style={{ fontWeight: 500 }}>u$s {fmt(m.monto)}</td>
                            <td></td>
                            <td>
                              <button className="icon-btn" onClick={() => handleDeleteInversion(m.id)}>
                                <Icons.Trash size={13} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ── CONFIG CAJAS TAB ───────────────────────────────────────────── */}
      {tab === 'config' && (
        <>
          <div className="card card-tight u-mb-16">
            <div className="card-hd"><h3>Nueva caja</h3></div>
            <form onSubmit={handleCreateCaja} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', padding: '4px 2px' }}>
              <div className="field" style={{ flex: 2, minWidth: 220 }}>
                <label className="field-label">Nombre</label>
                <input className="input" placeholder="ej. USD Efectivo, Banco Galicia, Mercado Pago"
                       value={cajaForm.nombre} onChange={e => setCajaForm(f => ({ ...f, nombre: e.target.value }))} />
              </div>
              <div className="field" style={{ width: 110 }}>
                <label className="field-label">Moneda</label>
                {/* 2026-06-29 Multi-país F3: monedas según país (UY ve UYU). */}
                <select className="input" value={cajaForm.moneda} onChange={e => setCajaForm(f => ({ ...f, moneda: e.target.value }))}>
                  {Array.from(new Set([...monedas, cajaForm.moneda].filter(Boolean)))
                    .map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="field" style={{ width: 140 }}>
                <label className="field-label">Saldo inicial</label>
                <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} step="0.01" className="input" placeholder="0"
                       value={cajaForm.saldo_inicial} onChange={e => setCajaForm(f => ({ ...f, saldo_inicial: e.target.value }))} />
              </div>
              <label className="field" style={{ width: 'auto', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={cajaForm.es_tarjeta} onChange={e => setCajaForm(f => ({ ...f, es_tarjeta: e.target.checked, comision_pct: '' }))} style={{ accentColor: 'var(--accent)' }} />
                <span className="u-fs-12">Es tarjeta</span>
              </label>
              {cajaForm.es_tarjeta && (
                <div className="field" style={{ width: 120 }}>
                  <label className="field-label">% comisión</label>
                  <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" max="100" step="0.1" className="input mono" placeholder="23.5"
                         value={cajaForm.comision_pct} onChange={e => setCajaForm(f => ({ ...f, comision_pct: e.target.value }))} />
                </div>
              )}
              <button className="btn btn-primary" type="submit" disabled={cajaSaving}>
                {cajaSaving ? 'Guardando…' : '+ Agregar caja'}
              </button>
            </form>
            {cajaError && <div style={{ color: 'var(--neg)', fontSize: 13, marginTop: 8 }}>{cajaError}</div>}
          </div>

          <div className="card card-flush">
            <div className="card-hd"><h3>Cajas — {cajasList.length}</h3></div>
            {loadingCajas ? (
              <div className="empty">Cargando…</div>
            ) : cajasError ? (
              // 2026-07-16 (task #144 UX A): banner con retry visible cuando
              // el load falla, en vez de dejar la tabla vacía y solo el toast
              // efímero. El user tiene forma de reintentar sin refrescar.
              <div style={{ padding: 20, textAlign: 'center' }}>
                <div style={{ color: 'var(--neg)', fontSize: 13, marginBottom: 10 }}>
                  {cajasError}
                </div>
                <button className="btn btn-sm" onClick={loadCajas}>
                  <Icons.Refresh size={13} /> Reintentar
                </button>
              </div>
            ) : cajasList.length === 0 ? (
              <div className="empty">Sin cajas. Creá la primera arriba.</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Moneda</th>
                    <th className="num">Saldo inicial</th>
                    <th className="num">Saldo actual</th>
                    <th>Estado</th>
                    <th>Financiera</th>
                    <th>Tarjeta</th>
                    <th style={{ width: 80 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {cajasList.map(c => (
                    <tr key={c.id} style={{ opacity: c.activo ? 1 : 0.55 }}>
                      <td className="u-fw-600">{c.nombre}</td>
                      <td><span className="ccy">{c.moneda}</span></td>
                      <td className="num">
                        <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} step="0.01" defaultValue={Number(c.saldo_inicial) || 0}
                               key={`si-${c.id}-${c.saldo_inicial}`}
                               className="input num" style={{ maxWidth: 110, textAlign: 'right' }}
                               onBlur={e => handleSaldoInicial(c, e.target.value)}
                               title="Saldo de apertura — editá y salí del campo para guardar" />
                      </td>
                      <td className="num mono" style={{ fontWeight: 700 }}>
                        {Number(c.saldo_actual || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 })}
                      </td>
                      <td>
                        <button className={'badge ' + (c.activo ? 'badge-pos' : 'badge-warn')}
                                style={{ cursor: 'pointer', border: 'none' }}
                                onClick={() => handleToggleCaja(c)}
                                title="Click para activar / desactivar">
                          {c.activo ? 'Activa' : 'Inactiva'}
                        </button>
                      </td>
                      <td>
                        <button className={'badge ' + (c.es_financiera ? 'badge-accent' : '')}
                                style={{ cursor: 'pointer', border: 'none', background: c.es_financiera ? undefined : 'transparent' }}
                                onClick={() => handleToggleFinanciera(c)}
                                title="Marcar como la caja de la financiera (genera auto-comprobante al vender con ella)">
                          {c.es_financiera ? '★ Financiera' : <span className="dim">marcar</span>}
                        </button>
                      </td>
                      <td>
                        {c.es_tarjeta
                          ? <span className="badge badge-info" title="Método tarjeta — comisión de la financiera">Tarjeta · {Number(c.comision_pct || 0)}%</span>
                          : <span className="dim">—</span>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="icon-btn" title="Movimientos / ajuste" onClick={() => openCajaLedger(c)}>
                          <Icons.Eye size={14} />
                        </button>
                        <button className="icon-btn" title="Eliminar caja" onClick={() => handleDeleteCaja(c)}>
                          <Icons.Trash size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="muted tiny" style={{ padding: '10px 14px' }}>
              Las cajas son las cuentas donde caen los pagos (Ventas, B2B, Financiera, Envíos). Las inactivas no aparecen al cargar nuevos pagos.
            </div>
          </div>
        </>
      )}

      {/* ── Modal: Ledger de caja (movimientos + ajuste) ─────────────── */}
      {cajaSel && (
        <div ref={ledgerModalRef} className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="ledger-modal-title"
             onClick={(e) => { if (e.target === e.currentTarget && !ajusteSaving) setCajaSel(null); }}>
          <div className="modal" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3 id="ledger-modal-title">{cajaSel.nombre} <span className="ccy">{cajaSel.moneda}</span></h3>
              <button className="icon-btn" aria-label="Cerrar modal" onClick={() => setCajaSel(null)}><Icons.X size={16} /></button>
            </div>
            <div className="modal-body">
              {/* Ajuste manual */}
              <form onSubmit={handleCreateAjuste} className="card card-tight u-mb-14">
                <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div className="field" style={{ width: 120 }}><label className="field-label">Tipo</label>
                    <select className="input" value={ajusteForm.tipo} onChange={e => setAjusteForm(f => ({ ...f, tipo: e.target.value }))}>
                      <option value="ingreso">Ingreso (+)</option>
                      <option value="egreso">Egreso (−)</option>
                    </select></div>
                  <div className="field" style={{ width: 130 }}><label className="field-label">Fecha</label>
                    <input type="date" className="input" value={ajusteForm.fecha} onChange={e => setAjusteForm(f => ({ ...f, fecha: e.target.value }))} /></div>
                  <div className="field" style={{ width: 110 }}><label className="field-label">Monto</label>
                    <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} step="0.01" className="input" value={ajusteForm.monto} onChange={e => setAjusteForm(f => ({ ...f, monto: e.target.value }))} /></div>
                  {cajaSel.moneda === 'ARS' && (
                    <div className="field" style={{ width: 90 }}><label className="field-label">TC</label>
                      <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} step="0.01" className="input" value={ajusteForm.tc} onChange={e => setAjusteForm(f => ({ ...f, tc: e.target.value }))} /></div>
                  )}
                  <div className="field" style={{ flex: 1, minWidth: 120 }}><label className="field-label">Concepto</label>
                    <input className="input" placeholder="ej. arqueo, retiro" value={ajusteForm.concepto} onChange={e => setAjusteForm(f => ({ ...f, concepto: e.target.value }))} /></div>
                  <button className="btn btn-primary btn-sm" type="submit" disabled={ajusteSaving}>{ajusteSaving ? '…' : 'Agregar'}</button>
                </div>
                <div className="muted tiny u-mt-6">Ajuste manual de caja (arqueo, corrección, retiro). Los movimientos de otros módulos se reflejan automáticamente (Fase 2b).</div>
              </form>

              {/* Historial */}
              {cajaMovs.length === 0 ? (
                <div className="empty">Sin movimientos todavía.</div>
              ) : (
                <table className="tbl">
                  <thead><tr><th>Fecha</th><th>Tipo</th><th>Origen</th><th>Concepto</th><th className="num">Monto</th><th style={{ width: 32 }}></th></tr></thead>
                  <tbody>
                    {cajaMovs.map(m => (
                      <tr key={m.id}>
                        <td className="muted mono tiny">{fmtFecha(m.fecha)}</td>
                        <td><span className={'badge ' + (m.tipo === 'ingreso' ? 'badge-pos' : 'badge-warn')}>{m.tipo === 'ingreso' ? 'Ingreso' : 'Egreso'}</span></td>
                        <td className="tiny muted">{m.origen}</td>
                        <td className="tiny">{m.concepto || '—'}</td>
                        <td className="num mono u-fw-600">
                          <span className={m.tipo === 'ingreso' ? 'pos' : 'neg'}>{m.tipo === 'ingreso' ? '+' : '−'}{Number(m.monto).toLocaleString('es-AR', { maximumFractionDigits: 2 })}</span>
                        </td>
                        <td>{m.origen === 'ajuste' && <button className="icon-btn" onClick={() => handleDeleteCajaMov(m)}><Icons.Trash size={12} /></button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}


      {/* ── Modal: Nuevo contacto ────────────────────────────────────────
          Solo se invoca desde el botón "+ Nuevo contacto" de la barra
          principal — para crear contactos sin un movimiento asociado.
          Los modales de Inversión y Deuda ya tienen el toggle Existente/
          Nuevo embebido (mega-form) y no necesitan este modal. */}
      {showContacto && (
        <div ref={contactoModalRef} className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="contacto-modal-title"
             onClick={(e) => { if (e.target === e.currentTarget && !cCreating) setShowContacto(false); }}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3 id="contacto-modal-title">Nuevo contacto</h3>
              <button className="icon-btn" aria-label="Cerrar modal"
                      onClick={() => setShowContacto(false)} disabled={cCreating}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreateContacto}>
              <div className="modal-body">
                <div className="stack u-gap-14">
                  <div className="row">
                    <div className="field u-flex-1">
                      <label className="field-label">Nombre <span className="u-color-neg">*</span></label>
                      <input className="input" placeholder="ej. Martín"
                        value={cForm.nombre} onChange={e => setCForm(f => ({ ...f, nombre: e.target.value }))} autoFocus />
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label">Apellido</label>
                      <input className="input" placeholder="ej. García"
                        value={cForm.apellido} onChange={e => setCForm(f => ({ ...f, apellido: e.target.value }))} />
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">Tipo de contacto</label>
                    <select className="input" value={cForm.tipo} onChange={e => setCForm(f => ({ ...f, tipo: e.target.value }))}>
                      <option value="amigo">Amigo</option>
                      <option value="familiar">Familiar</option>
                      <option value="cliente">Cliente</option>
                      <option value="inversor">Inversor</option>
                      <option value="ipro team">Tecny Team</option>
                    </select>
                  </div>
                  {cError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{cError}</div>}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost"
                        onClick={() => setShowContacto(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={cCreating}>
                  {cCreating ? 'Guardando…' : 'Crear contacto'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Nuevo movimiento de deuda ────────────────────────── */}
      {showDeuda && (
        <div ref={deudaModalRef} className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="deuda-modal-title"
             onClick={(e) => { if (e.target === e.currentTarget && !deudaCreating) setShowDeuda(false); }}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3 id="deuda-modal-title">Nuevo movimiento de deuda</h3>
              <button className="icon-btn" aria-label="Cerrar modal" onClick={() => setShowDeuda(false)} disabled={deudaCreating}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreateDeuda}>
              <div className="modal-body">
                <div className="stack u-gap-14">
                  <div className="row">
                    <div className="field u-flex-1">
                      <label className="field-label">Fecha <span className="u-color-neg">*</span></label>
                      <input type="date" className="input"
                        value={deudaForm.fecha}
                        onChange={e => setDeudaForm(f => ({ ...f, fecha: e.target.value }))} />
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label">Tipo <span className="u-color-neg">*</span></label>
                      <select className="input"
                        value={deudaForm.tipo}
                        onChange={e => setDeudaForm(f => ({ ...f, tipo: e.target.value }))}>
                        <option value="debe">Debe (deuda nueva)</option>
                        <option value="pago">Pago (cancela deuda)</option>
                      </select>
                    </div>
                  </div>
                  {/* Picker compartido con modal Inversión — toggle Existente/+Nuevo. */}
                  <ContactoPickerEmbedded form={deudaForm} setForm={setDeudaForm} allContacts={allContacts} />
                  <div className="row">
                    <div className="field u-flex-1">
                      <label className="field-label">Monto ARS</label>
                      <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01" className="input" placeholder="0"
                        value={deudaForm.monto_ars}
                        onChange={e => setDeudaForm(f => ({ ...f, monto_ars: e.target.value }))} />
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label">Monto USD</label>
                      <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01" className="input" placeholder="0"
                        value={deudaForm.monto_usd}
                        onChange={e => setDeudaForm(f => ({ ...f, monto_usd: e.target.value }))} />
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">Concepto</label>
                    <input className="input" placeholder="ej. Préstamo viaje, Compra materiales…"
                      value={deudaForm.concepto}
                      onChange={e => setDeudaForm(f => ({ ...f, concepto: e.target.value }))} />
                  </div>
                  {deudaError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{deudaError}</div>}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowDeuda(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={deudaCreating}>
                  {deudaCreating ? 'Guardando…' : 'Registrar movimiento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Nueva inversión ───────────────────────────────────── */}
      {showInv && (
        <div ref={invModalRef} className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="inv-modal-title"
             onClick={(e) => { if (e.target === e.currentTarget && !invCreating) setShowInv(false); }}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3 id="inv-modal-title">Nueva inversión</h3>
              <button className="icon-btn" aria-label="Cerrar modal" onClick={() => setShowInv(false)} disabled={invCreating}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreateInversion}>
              <div className="modal-body">
                <div className="stack u-gap-14">
                  <div className="field">
                    <label className="field-label">Fecha <span className="u-color-neg">*</span></label>
                    <input type="date" className="input"
                      value={invForm.fecha}
                      onChange={e => setInvForm(f => ({ ...f, fecha: e.target.value }))} />
                  </div>
                  {/* Picker compartido con modal Deuda — toggle Existente/+Nuevo. */}
                  <ContactoPickerEmbedded form={invForm} setForm={setInvForm} allContacts={allContacts} />
                  <div className="field">
                    <label className="field-label">Monto USD <span className="u-color-neg">*</span></label>
                    <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="1" step="0.01" className="input" placeholder="ej. 5000"
                      value={invForm.monto}
                      onChange={e => setInvForm(f => ({ ...f, monto: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="field-label">Tasa / condición</label>
                    <input className="input" placeholder="ej. 5% mensual, TNA 60%…"
                      value={invForm.tasa}
                      onChange={e => setInvForm(f => ({ ...f, tasa: e.target.value }))} />
                  </div>
                  {invError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{invError}</div>}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowInv(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={invCreating}>
                  {invCreating ? 'Guardando…' : 'Registrar inversión'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
