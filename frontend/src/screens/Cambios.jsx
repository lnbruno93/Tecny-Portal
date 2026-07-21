import { useState, useEffect, useMemo, useRef } from 'react';
import { Icons } from '../components/Icons';
import { cambios as cambiosApi, cajas as cajasApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import { Skeleton } from '../components/Skeleton';
import useLoadingAction from '../lib/useLoadingAction';
import TcWarning from '../components/TcWarning';
import CajaSelectHint from '../components/CajaSelectHint';
import useModal from '../lib/useModal';
import useFormFields from '../lib/useFormFields';
import { useAuth } from '../contexts/AuthContext';
import Seg from '../components/Seg';



const todayISO = () => new Date().toLocaleDateString('sv');

// UYU follow-up audit 2026-07-06: helpers derivados del país del tenant.
// El módulo Cambios de Divisa nació 100% para ARS/USD, pero desde F1-F5
// multi-país los tenants UY operan en UYU. Backend PR #514 ya soporta el
// par UYU/USD via CHECK constraint extendido + tipos 'entrega_uyu' /
// 'recibo_usd_uy'.
//
// 2026-07-14 (feature dirección inversa): agregamos los 4 tipos "les damos
// USD, nos devuelven pesos". Ahora hay 4 tipos por país (2 direcciones ×
// 2 operaciones — entrega/recibo):
//   Dirección A (les damos pesos, nos deben USD):
//     · entregaLocal    → entrega_ars / entrega_uyu
//     · reciboUsd       → recibo_usd / recibo_usd_uy
//   Dirección B (les damos USD, nos deben pesos):
//     · entregaUsd      → entrega_usd_por_ars / entrega_usd_por_uyu
//     · reciboLocal     → recibo_ars / recibo_uyu
function tiposPorPais(pais) {
  return pais === 'UY'
    ? {
        entregaLocal: 'entrega_uyu',
        reciboUsd:    'recibo_usd_uy',
        entregaUsd:   'entrega_usd_por_uyu',
        reciboLocal:  'recibo_uyu',
      }
    : {
        entregaLocal: 'entrega_ars',
        reciboUsd:    'recibo_usd',
        entregaUsd:   'entrega_usd_por_ars',
        reciboLocal:  'recibo_ars',
      };
}

// Etiqueta corta del tipo — para el badge en la grilla histórica. Soporta
// tanto los tipos AR como UY (una financiera en AR nunca tendrá filas UY
// y viceversa, pero el switch es defensivo por si alguna migración cambia
// el país del tenant a mitad de camino).
function labelTipo(tipo) {
  if (tipo === 'entrega_ars') return 'Entrega ARS → USD';
  if (tipo === 'entrega_uyu') return 'Entrega UYU → USD';
  if (tipo === 'recibo_usd' || tipo === 'recibo_usd_uy') return 'Recibo USD';
  if (tipo === 'entrega_usd_por_ars') return 'Entrega USD → ARS';
  if (tipo === 'entrega_usd_por_uyu') return 'Entrega USD → UYU';
  if (tipo === 'recibo_ars') return 'Recibo ARS';
  if (tipo === 'recibo_uyu') return 'Recibo UYU';
  return tipo;
}

// Categorías: usan monto local? USD? tc? — helpers reutilizados por la UI.
const isEntregaLocalTipo = (t) => t === 'entrega_ars' || t === 'entrega_uyu';
const isEntregaUsdTipo   = (t) => t === 'entrega_usd_por_ars' || t === 'entrega_usd_por_uyu';
const isReciboUsdTipo    = (t) => t === 'recibo_usd' || t === 'recibo_usd_uy';
const isReciboLocalTipo  = (t) => t === 'recibo_ars' || t === 'recibo_uyu';
// Qué moneda va la caja de este movimiento (USD o la local).
const monedaCajaDelTipo  = (t, monedaLocal) =>
  (isEntregaUsdTipo(t) || isReciboUsdTipo(t)) ? 'USD' : monedaLocal;

// 2026-07-14 (UX B): separamos el "tipo" persistido (8 valores enum) en dos
// dimensiones ortogonales para el UI: `direccion` (A/B) × `operacion` (E/R).
// El backend sigue recibiendo un `tipo` único; estos helpers hacen la trad.
// Dirección A: "les damos pesos → nos deben USD"
// Dirección B: "les damos USD → nos deben pesos"
const dirDeTipo = (t) =>
  (isEntregaLocalTipo(t) || isReciboUsdTipo(t)) ? 'A' : 'B';
const opDeTipo = (t) =>
  (isEntregaLocalTipo(t) || isEntregaUsdTipo(t)) ? 'entrega' : 'recibo';
// Reverse: dado (direccion, operacion, TIPOS), devuelve el tipo enum.
function tipoDe(direccion, operacion, TIPOS) {
  if (direccion === 'A' && operacion === 'entrega') return TIPOS.entregaLocal;
  if (direccion === 'A' && operacion === 'recibo')  return TIPOS.reciboUsd;
  if (direccion === 'B' && operacion === 'entrega') return TIPOS.entregaUsd;
  if (direccion === 'B' && operacion === 'recibo')  return TIPOS.reciboLocal;
  return TIPOS.entregaLocal; // fallback
}

export default function Cambios() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const { setPrimaryAction } = usePageActions();

  // UYU follow-up: derivamos país + moneda local del user auth. Guard igual
  // al pattern de otras screens (Ventas.jsx, Envios.jsx, EgresosPanel.jsx):
  // user puede ser null en mount inicial o si /me falló. Default AR para
  // no romper el flow en ese edge.
  const { user } = useAuth() || {};
  const pais        = user?.tenant?.pais || 'AR';
  const monedaLocal = user?.tenant?.moneda_local || 'ARS';
  const TIPOS       = useMemo(() => tiposPorPais(pais), [pais]);

  const EMPTY_MOV = useMemo(
    () => ({
      tipo: TIPOS.entregaLocal, fecha: todayISO(),
      monto_ars: '', tc: '', monto_usd: '',
      caja_id: '', comentarios: '',
    }),
    [TIPOS.entregaLocal]
  );

  const [list, setList] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  // 2026-07-16 (task #144 UX A): antes usábamos `toast.error(e.message)`
  // que desaparece en 5s — si la red falló, el user no puede reintentar
  // sin refrescar la página. Ahora persistimos el error en state para
  // renderizar un banner con botón Reintentar (pattern de Inicio.jsx).
  const [listError, setListError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detalle, setDetalle] = useState(null);
  const [movs, setMovs] = useState([]);
  const [cajas, setCajas] = useState([]);

  const [showCreate, setShowCreate] = useState(false);
  const [nombre, setNombre] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const createModalRef = useRef(null);
  useModal({ open: showCreate, onClose: () => setShowCreate(false), overlayRef: createModalRef });

  // 2026-07-16 (task #147 UX B.2): validación inline con useFormFields.
  // Antes: `if (!mov.caja_id) { toast.error('Elegí la caja.'); return; }`
  // → user veía UN error a la vez (toast que desaparece). Ahora todos los
  // campos requeridos (variables según el tipo de movimiento) muestran su
  // error debajo, y se limpian al empezar a corregir.
  //
  // Requeridos según el tipo:
  //   entrega local (ars/uyu)  → monto_ars + tc + caja
  //   entrega USD (usd_por_*)  → monto_usd + tc + caja
  //   recibo local (ars/uyu)   → monto_ars + caja
  //   recibo USD (usd/usd_uy)  → monto_usd + caja
  const {
    form: mov,
    setForm: setMov,
    setField: setMovField,
    fieldErrors: movErrors,
    validate: validateMov,
    resetErrors: resetMovErrors,
  } = useFormFields(EMPTY_MOV, (m) => {
    const errs = {};
    const t = m.tipo;
    const needsLocal = isEntregaLocalTipo(t) || isReciboLocalTipo(t);
    const needsUsd   = isEntregaUsdTipo(t) || isReciboUsdTipo(t);
    const needsTc    = isEntregaLocalTipo(t) || isEntregaUsdTipo(t);
    if (needsLocal && (!m.monto_ars || Number(m.monto_ars) <= 0)) {
      errs.monto_ars = 'Ingresá un monto mayor a 0.';
    }
    if (needsUsd && (!m.monto_usd || Number(m.monto_usd) <= 0)) {
      errs.monto_usd = 'Ingresá un monto mayor a 0.';
    }
    if (needsTc && (!m.tc || Number(m.tc) <= 0)) {
      errs.tc = 'Ingresá el TC.';
    }
    if (!m.caja_id) errs.caja_id = 'Elegí la caja.';
    return Object.keys(errs).length ? errs : null;
  });
  // 2026-07-12 (auditoría TOTAL Financiero P1-1, Pattern G):
  // Idempotency-Key para POST /cambios/movimientos. Se regenera después de
  // cada submit exitoso para permitir múltiples movimientos consecutivos
  // desde el mismo form (cada uno con su propio key).
  const [movIdempotencyKey, setMovIdempotencyKey] = useState(() => crypto.randomUUID());
  // Post-audit: migración a useLoadingAction (DRY + anti-click-spam free).
  const { loading: savingMov, run: withSavingMov } = useLoadingAction();

  function loadList() {
    setLoadingList(true);
    setListError(null);
    cambiosApi.entidades()
      .then(r => setList(r || []))
      .catch(e => setListError(e.message || 'No se pudieron cargar las financieras.'))
      .finally(() => setLoadingList(false));
  }
  useEffect(() => { loadList(); }, []); // eslint-disable-line
  useEffect(() => { cajasApi.listCajas().then(r => setCajas(Array.isArray(r) ? r : [])).catch(() => {}); }, []);

  useEffect(() => {
    setPrimaryAction({ label: 'Nueva financiera', onClick: () => { setNombre(''); setCreateError(''); setShowCreate(true); } });
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]);

  useEffect(() => { if (list.length > 0 && !selectedId) setSelectedId(list[0].id); }, [list]); // eslint-disable-line

  function loadDetalle() {
    if (!selectedId) { setDetalle(null); setMovs([]); return; }
    Promise.all([cambiosApi.entidad(selectedId), cambiosApi.movimientos(selectedId)])
      .then(([det, m]) => { setDetalle(det); setMovs(m.data || []); })
      .catch(e => toast.error(e.message));
  }
  useEffect(() => { loadDetalle(); setMov(EMPTY_MOV); resetMovErrors(); }, [selectedId, EMPTY_MOV]); // eslint-disable-line

  // 2026-07-14 (dirección inversa): cajas filtradas por moneda según tipo.
  //   · Movimientos USD (entrega_usd_por_* / recibo_usd*): cajas USD.
  //   · Movimientos locales (entrega_local / recibo_local): cajas moneda local.
  const cajaMonedaEsperada = monedaCajaDelTipo(mov.tipo, monedaLocal);
  const cajasFiltradas = useMemo(
    () => cajas.filter(c => c.moneda === cajaMonedaEsperada),
    [cajas, cajaMonedaEsperada]
  );

  // Preview del USD equivalente / deuda local — depende del tipo:
  //   · entrega local: usd = monto_local / tc     (nos deben esa USD)
  //   · entrega USD:   local = monto_usd × tc     (nos deben esa cantidad local)
  //   · recibo USD/local: solo el monto tal cual, sin conversión
  const usdPreview = useMemo(() => {
    if (isEntregaLocalTipo(mov.tipo)) {
      const a = parseFloat(mov.monto_ars), t = parseFloat(mov.tc);
      return (a > 0 && t > 0) ? Math.round((a / t) * 100) / 100 : 0;
    }
    if (isEntregaUsdTipo(mov.tipo)) {
      // Para entrega USD el input es USD directo — no hay preview cross-moneda
      // en la columna USD (usamos la columna local para mostrar la deuda).
      return parseFloat(mov.monto_usd) || 0;
    }
    return parseFloat(mov.monto_usd) || 0;
  }, [mov]);
  // Preview local: solo aplica a entrega_usd_por_* (la deuda es en local).
  const localPreview = useMemo(() => {
    if (isEntregaUsdTipo(mov.tipo)) {
      const u = parseFloat(mov.monto_usd), t = parseFloat(mov.tc);
      return (u > 0 && t > 0) ? Math.round((u * t) * 100) / 100 : 0;
    }
    return null;
  }, [mov]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!nombre.trim()) { setCreateError('El nombre es obligatorio.'); return; }
    setCreating(true); setCreateError('');
    try {
      const nueva = await cambiosApi.createEntidad({ nombre: nombre.trim() });
      setList(prev => [...prev, nueva]);
      setSelectedId(nueva.id); setShowCreate(false);
      toast.success('Financiera creada.');
    } catch (err) { setCreateError(err.message); } finally { setCreating(false); }
  }

  async function handleAddMov(e) {
    e.preventDefault();
    // 2026-07-16 (task #147): validación inline consolidada — todos los
    // errores relevantes al tipo actual aparecen JUNTOS bajo su input.
    if (!validateMov()) return;
    await withSavingMov(async () => {
      try {
        // 2026-07-14 (dirección inversa): payload adaptado por tipo.
        //   · entrega local: monto_ars (monto local) + tc (para calcular USD deuda)
        //   · entrega USD:   monto_usd + tc (para calcular deuda local — server-side)
        //   · recibo USD:    monto_usd solo
        //   · recibo local:  monto_ars solo
        // `monto_ars` es alias legacy — contiene monto en la moneda local
        // (ARS o UYU según país + tipo específico).
        const t = mov.tipo;
        const needsLocalInput = isEntregaLocalTipo(t) || isReciboLocalTipo(t);
        const needsUsdInput   = isEntregaUsdTipo(t) || isReciboUsdTipo(t);
        const needsTc         = isEntregaLocalTipo(t) || isEntregaUsdTipo(t);
        await cambiosApi.createMovimiento({
          entidad_id: selectedId, fecha: mov.fecha, tipo: t,
          monto_ars: needsLocalInput ? Number(mov.monto_ars) || 0 : 0,
          tc:        needsTc         ? Number(mov.tc) || null   : null,
          monto_usd: needsUsdInput   ? Number(mov.monto_usd) || 0 : 0,
          caja_id: Number(mov.caja_id), comentarios: mov.comentarios.trim() || null,
        }, movIdempotencyKey);
        setMov({ ...EMPTY_MOV, tipo: mov.tipo, fecha: mov.fecha });
        // Pattern G: regenerar UUID después del éxito para el próximo submit.
        setMovIdempotencyKey(crypto.randomUUID());
        loadList(); loadDetalle();
        toast.success('Movimiento registrado.');
      } catch (err) { toast.error(err.message); }
    });
  }

  async function handleDeleteMov(id) {
    const ok = await confirm({ title: 'Eliminar movimiento', message: 'Se revertirá el movimiento en la caja.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await cambiosApi.deleteMovimiento(id); loadList(); loadDetalle(); } catch (err) { toast.error(err.message); }
  }

  async function handleDeleteEntidad() {
    if (!detalle) return;
    const ok = await confirm({ title: 'Eliminar financiera', message: `Se eliminará "${detalle.nombre}" y sus movimientos.`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await cambiosApi.deleteEntidad(detalle.id);
      setList(prev => prev.filter(e => e.id !== detalle.id));
      setSelectedId(null); setDetalle(null);
      toast.success('Financiera eliminada.');
    } catch (err) { toast.error(err.message); }
  }

  const r = detalle?.resumen || {};
  // 2026-07-14 (dirección inversa): 4 categorías de tipo. Cada una habilita
  // distintos inputs (local vs USD, con o sin TC).
  const isEntregaLocal = isEntregaLocalTipo(mov.tipo);
  const isEntregaUsd   = isEntregaUsdTipo(mov.tipo);
  const isReciboUsd    = isReciboUsdTipo(mov.tipo);
  const isReciboLocal  = isReciboLocalTipo(mov.tipo);
  const inputLocalActivo = isEntregaLocal || isReciboLocal; // input "$ Local"
  const inputUsdActivo   = isEntregaUsd || isReciboUsd;     // input "USD"
  const inputTcActivo    = isEntregaLocal || isEntregaUsd;  // input "TC"

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Cambios de Divisa</h1>
          <div className="page-sub">
            Cuenta corriente con financieras de cambio · entregás {monedaLocal} y te devuelven USD, o entregás USD y te devuelven {monedaLocal}
          </div>
        </div>
      </div>

      <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, alignItems: 'start' }}>
        {/* Lista de financieras */}
        <div className="card card-flush u-mh-78vh-o-auto">
          {/* 2026-06-25 UX-3 (audit pre-live): skeleton bars en lugar del
              "Cargando…" plano. Mantiene la altura del card estable mientras
              llega la lista, evita el "salto" visual al renderizar. */}
          {loadingList ? (
            <div style={{ padding: 8 }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} style={{ padding: '10px 13px', borderBottom: i < 4 ? '1px solid var(--hairline)' : 0 }}>
                  <Skeleton width="60%" height={14} />
                  <div className="u-mt-6"><Skeleton width="40%" height={11} /></div>
                </div>
              ))}
            </div>
          )
            : listError ? (
              // 2026-07-16 (task #144 UX A): banner de error con retry visible,
              // en vez del toast que desaparece a los 5s. Si la red falla, el
              // user tiene forma de reintentar sin refrescar la página.
              <div className="u-p-20-text-center">
                <div style={{ color: 'var(--neg)', fontSize: 13, marginBottom: 10 }}>
                  {listError}
                </div>
                <button className="btn btn-sm" onClick={loadList}>
                  <Icons.Refresh size={13} /> Reintentar
                </button>
              </div>
            )
            : list.length === 0 ? <div className="empty">Sin financieras. Creá la primera con "Nueva financiera".</div>
            : list.map((e, i) => (
              <div key={e.id} onClick={() => setSelectedId(e.id)} style={{
                padding: '10px 13px', cursor: 'pointer',
                borderBottom: i < list.length - 1 ? '1px solid var(--hairline)' : 0,
                background: selectedId === e.id ? 'var(--surface-2)' : 'transparent',
                borderLeft: selectedId === e.id ? '3px solid var(--accent)' : '3px solid transparent',
              }}>
                <div className="u-fs-13-fw-600">{e.nombre}{!e.activo && <span className="muted tiny"> (inactiva)</span>}</div>
                {/* 2026-07-14 (dirección inversa): puede haber saldos en 3 monedas
                   simultáneamente. Mostramos los que son != 0 (o solo USD si
                   no hay deuda local, para no romper la altura de la card). */}
                <div className="mono tiny" style={{ marginTop: 2, color: Number(e.saldo_usd) > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                  Te deben: u$s {fmt(e.saldo_usd)}
                </div>
                {Number(e.saldo_ars) > 0 && (
                  <div className="mono tiny u-mt-2-color-accent">
                    + $ {fmt(e.saldo_ars)} ARS
                  </div>
                )}
                {Number(e.saldo_uyu) > 0 && (
                  <div className="mono tiny u-mt-2-color-accent">
                    + $U {fmt(e.saldo_uyu)} UYU
                  </div>
                )}
              </div>
            ))}
        </div>

        {/* Detalle */}
        {!detalle ? (
          <div className="card u-empty-state-grid">Elegí una financiera</div>
        ) : (
          <div className="stack u-gap-14">
            <div className="card">
              <div className="flex-between u-align-items-flex-start">
                <div className="u-fs-18-fw-700">{detalle.nombre}</div>
                <button className="icon-btn u-color-neg" title="Eliminar financiera" onClick={handleDeleteEntidad}><Icons.Trash size={15} /></button>
              </div>
            </div>

            <div className="row">
              <div className="card card-tight u-flex-1">
                <div className="kpi-label">Te deben · USD</div>
                <div className="kpi-value mono" style={{ color: Number(r.saldo_usd) > 0 ? 'var(--accent)' : 'inherit' }}>u$s {fmt(r.saldo_usd)}</div>
              </div>
              {/* 2026-07-14 (dirección inversa): saldos en moneda local, solo
                 si != 0 para no llenar de "0" a users que no usan la inversa. */}
              {Number(r.saldo_ars) !== 0 && (
                <div className="card card-tight u-flex-1">
                  <div className="kpi-label">Te deben · ARS</div>
                  <div className="kpi-value mono" style={{ color: Number(r.saldo_ars) > 0 ? 'var(--accent)' : 'inherit' }}>$ {fmt(r.saldo_ars)}</div>
                </div>
              )}
              {Number(r.saldo_uyu) !== 0 && (
                <div className="card card-tight u-flex-1">
                  <div className="kpi-label">Te deben · UYU</div>
                  <div className="kpi-value mono" style={{ color: Number(r.saldo_uyu) > 0 ? 'var(--accent)' : 'inherit' }}>$U {fmt(r.saldo_uyu)}</div>
                </div>
              )}
              <div className="card card-tight u-flex-1">
                <div className="kpi-label">Entregado · USD equiv.</div>
                <div className="kpi-value mono">u$s {fmt(r.entregado_usd)}</div>
              </div>
              <div className="card card-tight u-flex-1">
                <div className="kpi-label">Recibido · USD</div>
                <div className="kpi-value mono">u$s {fmt(r.recibido_usd)}</div>
              </div>
              <div className="card card-tight u-flex-1">
                <div className="kpi-label">Movimientos</div>
                <div className="kpi-value mono">{r.movimientos || 0}</div>
              </div>
            </div>

            {/* 2026-07-14 (UX B): Sección de carga separada del histórico.
               2 segmented controls (dirección + operación) determinan qué
               tipo enum se persiste. La fila de inputs debajo muestra SOLO
               los campos relevantes según el tipo — cada uno con label y
               espacio propio. La tabla del histórico queda para lectura. */}
            <div className="card" style={{ padding: 14 }}>
              <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}>
                <div className="u-flex-center-gap-12-wrap">
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', minWidth: 78 }}>Dirección:</span>
                  <Seg
                    value={dirDeTipo(mov.tipo)}
                    options={[
                      { value: 'A', label: `↑ Entregás ${monedaLocal} → USD` },
                      { value: 'B', label: `↓ Entregás USD → ${monedaLocal}` },
                    ]}
                    onChange={(dir) => {
                      // Al cambiar dirección/operación reseteamos los campos
                      // que dependen del tipo (los inputs se re-renderean).
                      // Uso setForm (setMov) del hook con el objeto entero
                      // para actualizar múltiples campos en un solo tick.
                      setMov({
                        ...mov,
                        tipo: tipoDe(dir, opDeTipo(mov.tipo), TIPOS),
                        caja_id: '', monto_ars: '', monto_usd: '', tc: '',
                      });
                      resetMovErrors();
                    }}
                  />
                </div>
                <div className="u-flex-center-gap-12-wrap">
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', minWidth: 78 }}>Operación:</span>
                  <Seg
                    value={opDeTipo(mov.tipo)}
                    options={[
                      { value: 'entrega', label: 'Entrega' },
                      { value: 'recibo',  label: 'Recibo' },
                    ]}
                    onChange={(op) => {
                      setMov({
                        ...mov,
                        tipo: tipoDe(dirDeTipo(mov.tipo), op, TIPOS),
                        caja_id: '', monto_ars: '', monto_usd: '', tc: '',
                      });
                      resetMovErrors();
                    }}
                  />
                </div>
              </div>

              {/* Fila de inputs — cada campo con label + espacio. Los inputs
                 no relevantes al tipo se ocultan (grid dinámico) para que la
                 UI muestre solo lo que hay que llenar. */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: inputTcActivo
                  ? '130px 1fr 100px 1fr 220px 1fr 110px'
                  : '130px 1fr 220px 1fr 110px',
                gap: 10,
                alignItems: 'end',
                borderTop: '1px solid var(--hairline)',
                paddingTop: 12,
              }}>
                <div>
                  <div className="muted tiny" style={{ marginBottom: 3, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Fecha</div>
                  <input type="date" className="input" value={mov.fecha} onChange={e => setMovField('fecha', e.target.value)} />
                </div>

                {/* Input del monto principal — depende del tipo */}
                {(isEntregaLocal || isReciboLocal) && (
                  <div>
                    <div className="muted tiny" style={{ marginBottom: 3, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Monto {monedaLocal}
                    </div>
                    <input
                      type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0"
                      className={'input mono' + (movErrors.monto_ars ? ' input-error' : '')}
                      placeholder="0"
                      value={mov.monto_ars}
                      onChange={e => setMovField('monto_ars', e.target.value)}
                      aria-invalid={!!movErrors.monto_ars}
                    />
                    {movErrors.monto_ars && <div className="field-error">{movErrors.monto_ars}</div>}
                  </div>
                )}
                {(isEntregaUsd || isReciboUsd) && (
                  <div>
                    <div className="muted tiny" style={{ marginBottom: 3, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Monto USD {isEntregaUsd ? '(egreso)' : ''}
                    </div>
                    <input
                      type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0"
                      className={'input mono' + (movErrors.monto_usd ? ' input-error' : '')}
                      placeholder="0"
                      value={mov.monto_usd}
                      onChange={e => setMovField('monto_usd', e.target.value)}
                      aria-invalid={!!movErrors.monto_usd}
                    />
                    {movErrors.monto_usd && <div className="field-error">{movErrors.monto_usd}</div>}
                  </div>
                )}

                {/* TC — solo entregas */}
                {inputTcActivo && (
                  <div>
                    <div className="muted tiny" style={{ marginBottom: 3, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      TC
                    </div>
                    <input
                      type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0"
                      className={'input mono' + (movErrors.tc ? ' input-error' : '')}
                      placeholder="Ej 1000"
                      value={mov.tc}
                      onChange={e => setMovField('tc', e.target.value)}
                      aria-invalid={!!movErrors.tc}
                    />
                    {movErrors.tc
                      ? <div className="field-error">{movErrors.tc}</div>
                      : <TcWarning tc={mov.tc} />}
                  </div>
                )}

                {/* Preview del equiv en la otra moneda (readonly, calculado) */}
                {(isEntregaLocal || isEntregaUsd) && (
                  <div>
                    <div className="muted tiny" style={{ marginBottom: 3, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      {isEntregaLocal ? 'Equiv. USD (te deben)' : `Equiv. ${monedaLocal} (te deben)`}
                    </div>
                    <input
                      type="text" readOnly
                      className="input mono"
                      style={{ background: 'rgba(56,182,255,0.08)', cursor: 'default' }}
                      value={isEntregaLocal ? (usdPreview ? `u$s ${usdPreview}` : '—') : (localPreview ? `$ ${localPreview}` : '—')}
                    />
                  </div>
                )}

                {/* Caja destino/origen */}
                <div>
                  <div className="muted tiny" style={{ marginBottom: 3, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Caja ({cajaMonedaEsperada})
                  </div>
                  <select
                    className={'input' + (movErrors.caja_id ? ' input-error' : '')}
                    value={mov.caja_id}
                    onChange={e => setMovField('caja_id', e.target.value)}
                    aria-invalid={!!movErrors.caja_id}
                  >
                    <option value="">Elegí caja…</option>
                    {cajasFiltradas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                  {movErrors.caja_id
                    ? <div className="field-error">{movErrors.caja_id}</div>
                    : <CajaSelectHint />}
                </div>

                {/* Comentarios */}
                <div>
                  <div className="muted tiny" style={{ marginBottom: 3, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Comentarios
                  </div>
                  <input className="input" placeholder="Opcional" value={mov.comentarios} onChange={e => setMovField('comentarios', e.target.value)} />
                </div>

                {/* Botón Agregar */}
                <div>
                  <div className="muted tiny" style={{ marginBottom: 3, fontSize: 10.5, visibility: 'hidden' }}>·</div>
                  <button className="btn btn-primary u-w-100" disabled={savingMov} onClick={handleAddMov}>
                    {savingMov ? 'Guardando…' : 'Agregar'}
                  </button>
                </div>
              </div>
            </div>

            <div className="card card-flush">
              <div className="u-overflow-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Fecha</th><th>Tipo</th><th className="u-text-right">$ {monedaLocal}</th><th className="u-text-right">TC</th>
                      <th className="u-text-right">USD</th><th>Caja</th><th>Comentarios</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {movs.map(m => {
                      // 2026-07-14 (dirección inversa): 4 categorías. El color
                      // del badge diferencia: entrega/recibo × local/USD.
                      const cat = isEntregaLocalTipo(m.tipo) ? 'ent-loc'
                                : isEntregaUsdTipo(m.tipo)   ? 'ent-usd'
                                : isReciboUsdTipo(m.tipo)    ? 'rec-usd'
                                : 'rec-loc';
                      const badgeCls = cat === 'ent-loc' ? '' : 'badge-info';
                      return (
                        <tr key={m.id}>
                          <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                          <td><span className={'badge ' + badgeCls}>{labelTipo(m.tipo)}</span></td>
                          <td className="mono u-text-right">{Number(m.monto_ars) > 0 ? '$ ' + fmt(m.monto_ars) : '—'}</td>
                          <td className="mono tiny u-text-right">{m.tc ? fmt(m.tc) : '—'}</td>
                          <td className="mono u-td-right-fw-700-accent">u$s {fmt(m.monto_usd)}</td>
                          <td className="tiny">{m.caja_nombre || '—'}</td>
                          <td className="muted tiny">{m.comentarios || '—'}</td>
                          <td><button className="icon-btn u-color-neg" title="Eliminar movimiento" aria-label="Eliminar movimiento" onClick={() => handleDeleteMov(m.id)}><Icons.Trash size={13} /></button></td>
                        </tr>
                      );
                    })}

                    {/* Fila de carga movida a card separada ARRIBA (2026-07-14 UX B).
                       El histórico queda para lectura pura, sin inputs mezclados. */}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Modal nueva financiera */}
      {showCreate && (
        <div ref={createModalRef} className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal u-mw-420" onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>Nueva financiera de cambio</h3><button className="icon-btn" onClick={() => setShowCreate(false)}><Icons.X size={16} /></button></div>
            <form onSubmit={handleCreate}>
              <div className="modal-body">
                <div className="field">
                  <label className="field-label">Nombre <span className="u-color-neg">*</span></label>
                  <input className="input" placeholder="Ej: El Dorado" value={nombre} onChange={e => setNombre(e.target.value)} autoFocus />
                </div>
                {createError && <div style={{ color: 'var(--neg)', fontSize: 13, marginTop: 8 }}>{createError}</div>}
              </div>
              <div className="modal-ft"><button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancelar</button><button type="submit" className="btn btn-primary" disabled={creating}>{creating ? 'Creando…' : 'Crear'}</button></div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
