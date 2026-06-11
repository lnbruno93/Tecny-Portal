import { useState, useEffect, useMemo, useRef } from 'react';
import { silentReport } from '../lib/reportError';
import { Icons } from '../components/Icons';
import { envios, cajas as cajasApi, inventario, cuentas as cuentasApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';
import { toUsd } from '../lib/money';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import TcWarning from '../components/TcWarning';
import BarrioCombobox from '../components/BarrioCombobox';
import useModal from '../lib/useModal';


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
};
// Default USD: los productos del inventario son típicamente USD y los precios
// del envío "tipo Ventas" se manejan en USD. El usuario puede cambiar a ARS/USDT.
// Los campos con prefijo `_` son solo para mostrar en la UI — no se envían al
// backend. Los seteamos al pickear un producto del inventario para que el
// operador vea modelo/capacidad/color/IMEI/costo sin tener que abrir Inventario.
const EMPTY_ITEM = { tipo: 'producto', descripcion: '', monto: '', metodo_pago: '', metodo_pago_id: '', producto_id: '', moneda: 'USD', tc: '', es_cuenta_corriente: false, _imei: '', _nombre: '', _gb: '', _color: '', _costo: '', _costo_moneda: '' };

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

// ─── Helper components ────────────────────────────────────────────────────────
function Badge({ tone = 'default', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function Seg({ value, options, onChange }) {
  return (
    <div className="seg">
      {options.map(o => (
        <button
          key={o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function Envios() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const [enviosList, setEnviosList] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [estadoFilter, setEstadoFilter] = useState('todos');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  // dateFilter: null = todos | 'YYYY-MM-DD' = día específico
  const [dateFilter, setDateFilter] = useState(null);
  // TODAS las cajas activas (incluye financieras y tarjetas). Las cajas
  // financiera/tarjeta y la opción CC requieren "Registrar como venta" — el
  // frontend lo marca con un disabled/warning cuando aplica.
  const [cajasPago, setCajasPago] = useState([]);
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
  const [form, setForm] = useState(EMPTY_FORM);
  const [items, setItems] = useState([{ ...EMPTY_ITEM }]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  // useModal — auditoría 2026-06-06 UX B2: Esc cierra el modal de "Nuevo
  // envío", focus trap, body scroll lock.
  const createModalRef = useRef(null);
  useModal({
    open: showCreate,
    onClose: () => !creating && setShowCreate(false),
    overlayRef: createModalRef,
  });

  const setF = (field, val) => setForm(f => ({ ...f, [field]: val }));
  const addItem = () => setItems(i => [...i, { ...EMPTY_ITEM }]);
  const addProducto = () => setItems(i => [...i, { ...EMPTY_ITEM, tipo: 'producto' }]);
  // 2026-06-10 — Default del pago pasa a USD (era ARS). Footgun: si el operador
  // no cambiaba el dropdown, el pago quedaba como ARS aunque la venta fuera USD.
  // USD es la moneda predominante del negocio (iPhones, accesorios premium).
  const addPago = () => setItems(i => [...i, { ...EMPTY_ITEM, tipo: 'pago', moneda: 'USD' }]);
  const rmItem = (idx) => setItems(i => i.filter((_, j) => j !== idx));
  const setItem = (idx, field, val) =>
    setItems(i => i.map((it, j) => j === idx ? { ...it, [field]: val } : it));

  // Resumen del envío en USD: convierte cada monto según su moneda y el TC del item / envío.
  // USD/USDT → 1:1; ARS → divide por (item.tc || form.tc).
  const summary = useMemo(() => {
    let totalUsd = 0, pagosUsd = 0;
    for (const it of items) {
      const usd = toUsd(it.monto, it.moneda || 'ARS', it.tc || form.tc);
      if (it.tipo === 'producto') totalUsd += usd;
      else if (it.tipo === 'pago') pagosUsd += usd;
    }
    return { totalUsd, pagosUsd, diferenciaUsd: totalUsd - pagosUsd };
  }, [items, form.tc]);
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
      _imei: p.imei || '',
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
  // Setea el método del pago: caja del catálogo o "Cuenta corriente" (__CC__).
  // La moneda se infiere de la caja (debe coincidir con el grupo de la caja).
  // Para CC, default a USD (es la moneda de movimientos_cc).
  function pickCajaPago(idx, value) {
    if (value === '__CC__') {
      setItems(i => i.map((it, j) => j !== idx ? it : ({
        ...it,
        metodo_pago_id: '', es_cuenta_corriente: true,
        moneda: it.moneda && it.moneda !== 'ARS' ? it.moneda : 'USD',
        tc: '',
      })));
      return;
    }
    const c = cajasPago.find(x => String(x.id) === String(value));
    setItems(i => i.map((it, j) => j !== idx ? it : ({
      ...it,
      metodo_pago_id: value, es_cuenta_corriente: false,
      moneda: c ? c.moneda : (it.moneda || 'ARS'),
      tc: c && c.moneda !== 'ARS' ? '' : it.tc,
    })));
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setItems([{ ...EMPTY_ITEM }]);
    setCreateError('');
    setEditingId(null);
    setModalMode('create');
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
    });
    const mappedItems = (envio.items || []).map(i => ({
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
    setItems(mappedItems.length ? mappedItems : [{ ...EMPTY_ITEM }]);
    setCreateError('');
    setEditingId(envio.id);
    setModalMode('edit');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.cliente.trim()) { setCreateError('El cliente es obligatorio.'); return; }
    if (!form.direccion.trim()) { setCreateError('La dirección es obligatoria.'); return; }
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
      if (modalMode === 'edit' && editingId) {
        // PUT: el backend resincroniza venta_items + venta_pagos + caja
        // automáticamente desde actualizarVentaDesdeEnvio. cliente_cc_id no
        // se manda — ya no se usa CC en Envíos y el backend mantiene el viejo.
        const actualizado = await envios.update(editingId, payload);
        setEnviosList(prev => prev.map(x => x.id === editingId ? { ...actualizado, items: payload.items } : x));
        setSelectedId(editingId);
      } else {
        // POST: siempre registrar como venta (regla del flujo).
        const nuevo = await envios.create({ ...payload, registrar_venta: true, cliente_cc_id: null });
        setEnviosList(prev => [{ ...nuevo, items: payload.items }, ...prev]);
        setSelectedId(nuevo.id);
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
        <div className="page-actions" style={{ display: 'flex', gap: 8 }}>
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
      <div className="row" style={{ marginBottom: 18 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Total</div>
          <div className="kpi-value mono">{kpiTotal}</div>
          <div className="muted tiny" style={{ marginTop: 6 }}>en sistema</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Entregados</div>
          <div className="kpi-value mono pos">{kpiEntregados}</div>
          <div className="muted tiny" style={{ marginTop: 6 }}>esta semana</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">En camino</div>
          <div className="kpi-value mono" style={{ color: 'var(--info)' }}>{kpiEnCamino}</div>
          <div className="muted tiny" style={{ marginTop: 6 }}>ahora</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Pendientes</div>
          <div className="kpi-value mono" style={{ color: 'var(--warn)' }}>{kpiPendientes}</div>
          <div className="muted tiny" style={{ marginTop: 6 }}>por despachar</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Cobros en ruta</div>
          <div className="kpi-value">
            <span className="ccy">u$s</span>
            <span className="mono pos">{fmt(kpiCobros)}</span>
          </div>
          <div className="muted tiny" style={{ marginTop: 6 }}>items tipo "pago"</div>
        </div>
      </div>

      {/* ── Date nav + search + filter ── */}
      <div className="flex-between" style={{ marginBottom: 14 }}>
        <div className="flex-row" style={{ gap: 8 }}>
          <button
            className="icon-btn"
            title="Día anterior"
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
        <div className="flex-row" style={{ gap: 8 }}>
          <div className="input-group" style={{ width: 280 }}>
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

      {/* ── Loading state ── */}
      {loading && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>Cargando…</div>
      )}

      {/* ── Split layout ── */}
      {!loading && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '340px 1fr',
            gap: 12,
            alignItems: 'start',
          }}
        >
          {/* ── Left: envío list ── */}
          <div
            className="stack"
            style={{
              gap: 8,
              maxHeight: 'calc(100vh - 340px)',
              overflowY: 'auto',
              paddingRight: 2,
            }}
          >
            {filtered.length === 0 && (
              <div className="empty">Sin envíos</div>
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
                  <div className="flex-between" style={{ marginBottom: 8 }}>
                    <div className="flex-row" style={{ gap: 8 }}>
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
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{e.cliente}</div>
                  <div className="muted tiny" style={{ marginTop: 2 }}>{e.direccion}{e.barrio ? ' · ' + e.barrio : ''}</div>
                  <div className="flex-row" style={{ gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
                    {productos.length > 0 && (
                      <div className="flex-row" style={{ gap: 5, fontSize: 12 }}>
                        <Icons.Box size={13} className="muted" />
                        <span className="muted">{productos.length} {productos.length === 1 ? 'producto' : 'productos'}</span>
                      </div>
                    )}
                    {pagos.length > 0 && (
                      <div className="flex-row" style={{ gap: 5, fontSize: 12 }}>
                        <Icons.Dollar size={13} style={{ color: 'var(--pos)' }} />
                        <span className="pos mono" style={{ fontWeight: 600 }}>
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                <div className="stack" style={{ gap: 8 }}>
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
                      <span style={{ fontWeight: 500 }}>{value}</span>
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
                      <div className="flex-row" style={{ gap: 10 }}>
                        {it.tipo === 'producto' ? (
                          <>
                            <Icons.Box size={14} className="muted" />
                            <span style={{ fontWeight: 600, fontSize: 13 }}>
                              {it.descripcion || '(sin descripción)'}
                            </span>
                          </>
                        ) : (
                          <>
                            <Icons.Dollar size={14} style={{ color: 'var(--pos)' }} />
                            <span style={{ fontWeight: 600, fontSize: 13 }} className="pos">
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
          <div className="modal" style={{ maxWidth: 760 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>{modalMode === 'edit' ? `Editar envío #${editingId}` : 'Nuevo envío'}</h3>
              <button type="button" className="icon-btn" onClick={() => setShowCreate(false)} disabled={creating} aria-label="Cerrar" title="Cerrar">
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                <div className="stack" style={{ gap: 16 }}>

                  {/* Fila 1: fecha + estado + prioridad */}
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Fecha <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input type="date" className="input" value={form.fecha}
                        onChange={e => setF('fecha', e.target.value)} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Estado</label>
                      <select className="input" value={form.estado} onChange={e => setF('estado', e.target.value)}>
                        <option>Pendiente</option>
                        <option>En camino</option>
                        <option>Entregado</option>
                        <option>Cancelado</option>
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
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
                    <div className="field" style={{ flex: 2 }}>
                      <label className="field-label">Cliente <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input className="input" placeholder="Nombre del cliente"
                        value={form.cliente} onChange={e => setF('cliente', e.target.value)} autoFocus />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Teléfono</label>
                      <input className="input" placeholder="ej. 3416123456"
                        value={form.telefono} onChange={e => setF('telefono', e.target.value)} />
                    </div>
                  </div>

                  {/* Fila 3: dirección + barrio */}
                  <div className="row">
                    <div className="field" style={{ flex: 2 }}>
                      <label className="field-label">Dirección <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input className="input" placeholder="ej. San Martín 450"
                        value={form.direccion} onChange={e => setF('direccion', e.target.value)} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
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
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Horario</label>
                      <input className="input" placeholder="ej. 10:00-12:00"
                        value={form.horario} onChange={e => setF('horario', e.target.value)} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
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
                    <div className="flex-between" style={{ marginBottom: 10 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>Items del envío</div>
                      <button type="button" className="btn btn-sm" onClick={addProducto}>
                        <Icons.Plus size={13} /> Agregar producto
                      </button>
                    </div>
                    <div className="stack" style={{ gap: 8 }}>
                      {items.map((it, idx) => ({ it, idx })).filter(({ it }) => it.tipo === 'producto').map(({ it, idx }) => (
                        <div key={`p-${idx}`} className="card card-tight" style={{ padding: '12px 14px' }}>
                          {/* 2026-06-10 (Lucas eligió layout "Hero card con chips"):
                              · Sin linkear → grilla compacta de 4 col: buscador + monto + moneda + ✕.
                              · Linkeado → 2 niveles:
                                  hero (modelo grande + chips capacidad/color/costo)
                                  → línea IMEI tenue
                                  → fila de controles (precio venta + moneda + ✕). */}
                          {!it.producto_id ? (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 90px auto', gap: 8, alignItems: 'end' }}>
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
                                        <div style={{ fontWeight: 600, fontSize: 13 }}>{[p.nombre, gbLabel(p.gb), p.color].filter(Boolean).join(' · ')}</div>
                                        <div className="muted tiny mono">{p.imei ? 'IMEI ' + p.imei : '—'} · cantidad {p.cantidad ?? 0} · ${fmt(p.precio_venta)}</div>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div className="field" style={{ marginBottom: 0 }}>
                                <label className="field-label">Monto</label>
                                <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="0"
                                  value={it.monto} onChange={e => setItem(idx, 'monto', e.target.value)} />
                              </div>
                              <div className="field" style={{ marginBottom: 0 }}>
                                <label className="field-label">Moneda</label>
                                <select className="input" value={it.moneda || 'USD'} onChange={e => setItem(idx, 'moneda', e.target.value)}>
                                  <option>USD</option><option>ARS</option><option>USDT</option>
                                </select>
                              </div>
                              <button type="button" className="icon-btn" style={{ marginBottom: 1 }} onClick={() => rmItem(idx)}>
                                <Icons.X size={14} />
                              </button>
                            </div>
                          ) : (
                            <>
                              {/* HERO: solo título + Cambiar. Los chips, IMEI y controles
                                  bajan a una única fila debajo (variante V2 elegida por Lucas). */}
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>
                                    Producto seleccionado
                                  </div>
                                  <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: -0.2, color: 'var(--text)' }}>
                                    {it._nombre || it.descripcion}
                                  </div>
                                </div>
                                <button type="button" className="btn btn-ghost btn-sm" onClick={() => unpickProducto(idx)}>Cambiar</button>
                              </div>
                              {/* Fila única: chips + IMEI a la izquierda, Precio + Moneda + ✕ a la
                                  derecha. Los chips quedan baseline-alineados con los inputs
                                  gracias al paddingBottom que compensa la altura del label. */}
                              <div style={{
                                display: 'grid',
                                gridTemplateColumns: '1fr 140px 90px auto',
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
                                <div className="field" style={{ marginBottom: 0 }}>
                                  <label className="field-label">Precio venta</label>
                                  <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="0"
                                    value={it.monto} onChange={e => setItem(idx, 'monto', e.target.value)} />
                                </div>
                                <div className="field" style={{ marginBottom: 0 }}>
                                  <label className="field-label">Moneda</label>
                                  <select className="input" value={it.moneda || 'USD'} onChange={e => setItem(idx, 'moneda', e.target.value)}>
                                    <option>USD</option><option>ARS</option><option>USDT</option>
                                  </select>
                                </div>
                                <button type="button" className="icon-btn" style={{ marginBottom: 1 }} onClick={() => rmItem(idx)}>
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
                    <div className="flex-between" style={{ marginBottom: 10 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>Pagos</div>
                      <button type="button" className="btn btn-sm" onClick={addPago}>
                        <Icons.Plus size={13} /> Agregar método
                      </button>
                    </div>
                    <div className="stack" style={{ gap: 6 }}>
                      {items.map((it, idx) => ({ it, idx })).filter(({ it }) => it.tipo === 'pago').map(({ it, idx }) => (
                        <div key={`pg-${idx}`}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 90px 100px auto', gap: 6, alignItems: 'center' }}>
                            <select className="input" value={it.es_cuenta_corriente ? '__CC__' : it.metodo_pago_id}
                                    onChange={e => pickCajaPago(idx, e.target.value)}>
                              <option value="">Método…</option>
                              {cajasPago.map(c => (
                                <option key={c.id} value={c.id}>{c.nombre}</option>
                              ))}
                              {/* 2026-06-10: Cuenta corriente removida del modal de Envíos
                                  por pedido de Lucas — no se vende a consumidor final con CC.
                                  La lógica detrás (es_cuenta_corriente) queda por compatibilidad
                                  con envíos legacy, pero no se ofrece como opción nueva. */}
                            </select>
                            <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="Monto"
                                   value={it.monto} onChange={e => setItem(idx, 'monto', e.target.value)} />
                            <select className="input" value={it.moneda || 'ARS'} onChange={e => setItem(idx, 'moneda', e.target.value)}>
                              <option>ARS</option><option>USD</option><option>USDT</option>
                            </select>
                            <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="TC"
                                   value={it.tc} onChange={e => setItem(idx, 'tc', e.target.value)} />
                            <button type="button" className="icon-btn" onClick={() => rmItem(idx)}>
                              <Icons.X size={14} />
                            </button>
                          </div>
                          <TcWarning tc={it.tc} />
                        </div>
                      ))}
                      {items.filter(i => i.tipo === 'pago').length === 0 && (
                        <div className="muted tiny" style={{ padding: '4px 0' }}>Sin pagos cargados. Sumá un método con "Agregar método".</div>
                      )}
                    </div>
                  </div>

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
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label className="field-label">Tipo de cambio (TC) del envío <span className="muted tiny">opcional · necesario si hay items en ARS</span></label>
                    <input type="number" onKeyDown={blockInvalidNumberKeys} className="input mono" placeholder="Ej: 1000"
                           value={form.tc} onChange={e => setF('tc', e.target.value)} />
                  </div>

                  {createError && (
                    <div style={{ color: 'var(--neg)', fontSize: 13 }}>{createError}</div>
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
