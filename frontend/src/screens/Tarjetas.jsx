import { useState, useEffect, useMemo, useRef } from 'react';
import { Icons } from '../components/Icons';
import { tarjetas as tarjetasApi, cajas as cajasApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';
import { round2 } from '../lib/money';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import CajaSelectHint from '../components/CajaSelectHint';
import TcWarning from '../components/TcWarning';
import useModal from '../lib/useModal';
import { rangeToParams, rangeLabel, RANGE_PRESETS } from '../lib/dateRange';
import { generarTarjetasResumenPdf } from '../lib/generarTarjetasResumenPdf';
import { generarTarjetasResumenXlsx } from '../lib/generarTarjetasResumenXlsx';



const todayISO = () => new Date().toLocaleDateString('sv');
const sym = (m) => (m === 'ARS' ? '$' : 'u$s');

// Color para mostrar saldo: positivo → accent (azul), negativo → neg (rojo),
// cero → muted. El saldo "Te deben" puede ser negativo cuando el operador
// filtra por un período donde liquidó más de lo cobrado (movimiento neto
// del período < 0). Sin este helper, los 4 puntos donde se muestra el saldo
// pintaban negativo en azul-positivo, visualmente engañoso.
// CSP hardening (Sprint 69): retorna la utility class equivalente al color
// original. Los 4 callsites usan className en vez de inline color.
const saldoClass = (v) => {
  const n = Number(v) || 0;
  if (n > 0) return 'u-tone-accent';
  if (n < 0) return 'u-tone-neg';
  return 'u-tone-text-muted';
};

// Sentinel para la "tarjeta virtual" Todas las tarjetas (junio 2026). Cuando
// selectedId === ALL_TARJETAS, el Detalle muestra KPIs sumados de todas las
// tarjetas y un form de liquidación múltiple (la financiera deposita un solo
// monto que cubre cupones de varias modalidades). String para no chocar con
// los IDs numéricos de las tarjetas reales.
const ALL_TARJETAS = 'todas';

export default function Tarjetas() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const { setPrimaryAction } = usePageActions();

  const [vista, setVista] = useState('general'); // 'general' (las 3) | 'detalle' (una)
  const [list, setList] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [allMovs, setAllMovs] = useState([]);     // estado de cuenta unificado
  const [selectedId, setSelectedId] = useState(null);
  const [detalle, setDetalle] = useState(null);   // { ...metodo, resumen }
  const [movs, setMovs] = useState([]);
  const [cajas, setCajas] = useState([]);

  // Filtro de período compartido entre vista General y Detalle. Afecta TODOS
  // los KPIs (Te deben, Comisión, Cobrado, Liquidado, Movimientos) — el saldo
  // del período = cobros del rango − liqs del rango. Con preset 'todo'
  // coincide con el histórico real; con un rango específico puede ser negativo
  // si en ese período se liquidaron cobros viejos. Persistido en localStorage;
  // default 'todo' para que el operador vea el panorama completo al entrar.
  // El "saldo histórico real" (cuánto te deben HOY independiente del filtro)
  // sigue disponible vía /api/tarjetas/saldos-resumen para 360 & Capital.
  const TARJ_RANGE_KEY = 'tarj_range';
  const [tarjRange, setTarjRange] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(TARJ_RANGE_KEY) || 'null');
      if (saved && saved.preset) return saved;
    } catch { /* ignore */ }
    return { preset: 'todo', desde: '', hasta: '' };
  });
  useEffect(() => {
    try { localStorage.setItem(TARJ_RANGE_KEY, JSON.stringify(tarjRange)); } catch { /* ignore */ }
  }, [tarjRange]);

  // Liquidación (cuando nos pagan)
  const [liq, setLiq] = useState({ fecha: todayISO(), monto: '', caja_id: '' });
  // 2026-07-12 (auditoría TOTAL Financiero P1-1, Pattern G):
  // Idempotency-Key para la liquidación individual. Se genera al montar el
  // form y se regenera después de cada submit exitoso — así el próximo
  // submit desde el mismo modal usa un key fresco.
  const [liqIdempotencyKey, setLiqIdempotencyKey] = useState(() => crypto.randomUUID());
  const [savingLiq, setSavingLiq] = useState(false);

  // Liquidación múltiple (junio 2026): para la vista "Todas las tarjetas".
  // El depósito de la financiera viene desglosado por modalidad — el operador
  // ingresa total + monto por tarjeta. La suma de repartos debe igualar al
  // total recibido. `repartos` es un dict {tarjetaId: stringMonto} para que
  // los inputs se manejen como texto (vacío = 0, no se envía).
  //
  // Conversión a USD (junio 2026 v3): 3 inputs editables enlazados con
  // auto-cálculo cruzado. Flujo visual: USD recibido | TC | Total ARS.
  //   · usd_recibido: lo que efectivamente entra a la caja USD.
  //   · tc:           TC informado por la financiera.
  //   · monto (ARS):  lo que descuenta del saldo de las tarjetas (planilla).
  //
  // Cuando el operador edita uno, los otros se auto-completan si hay info
  // suficiente (USD×TC=ARS). Si el operador sobreescribe manualmente uno,
  // el sistema respeta ese valor sin recalcularlo a menos que vuelva a
  // tocarlo. Esto permite reflejar exactamente lo que dice la planilla
  // cuando el USD recibido no cuadra matemáticamente con ARS/TC por
  // redondeo a centavos del dólar.
  //
  // La elección convertir_usd se persiste en localStorage (Lucas convierte
  // "casi siempre"). periodo_desde/hasta opcionales.
  const TARJ_LIQ_USD_KEY = 'tarj_liq_convertir_usd';
  const initialConvertirUSD = (() => {
    try {
      const v = localStorage.getItem(TARJ_LIQ_USD_KEY);
      return v === '1';
    } catch { return false; }
  })();
  const [multiLiq, setMultiLiq] = useState({
    fecha: todayISO(),
    monto: '',           // ARS total que descuenta del saldo (planilla)
    caja_id: '',
    comentarios: '',
    repartos: {},
    convertir_usd: initialConvertirUSD,
    tc: '',
    usd_recibido: '',    // USD que entra a la caja USD destino
    periodo_desde: '',
    periodo_hasta: '',
  });
  const [savingMultiLiq, setSavingMultiLiq] = useState(false);
  // Persistir la elección convertir_usd en cuanto cambia para que sea el
  // default al volver a la pantalla.
  useEffect(() => {
    try { localStorage.setItem(TARJ_LIQ_USD_KEY, multiLiq.convertir_usd ? '1' : '0'); } catch { /* ignore */ }
  }, [multiLiq.convertir_usd]);

  // `round2` viene de '../lib/money' (Hygiene H1 auditoría 2026-06-06).
  // Math.round((x + Number.EPSILON) * 100) / 100 evita el clásico
  // 0.1 + 0.2 = 0.30000000000000004 de IEEE-754 al mostrar/guardar montos.

  // Handlers que actualizan un campo y recalculan los otros cuando hay info
  // suficiente. Solo el handler del campo editado dispara el recálculo —
  // evita loops circulares. Si el operador borra un campo, los otros NO se
  // tocan (no perdemos valores que ya tenía cargados).
  const setMontoArs = (v) => {
    setMultiLiq(f => {
      const ars = Number(v);
      const tc = Number(f.tc);
      const next = { ...f, monto: v };
      if (Number.isFinite(ars) && ars > 0 && Number.isFinite(tc) && tc > 0) {
        next.usd_recibido = String(round2(ars / tc));
      }
      return next;
    });
  };
  const setTcMulti = (v) => {
    setMultiLiq(f => {
      const tc = Number(v);
      const usd = Number(f.usd_recibido);
      const ars = Number(f.monto);
      const next = { ...f, tc: v };
      if (Number.isFinite(tc) && tc > 0) {
        // Si hay USD, ARS es derivado (USD es la "verdad concreta" que
        // entra a la caja). Si no hay USD pero hay ARS, completar USD.
        if (Number.isFinite(usd) && usd > 0) {
          next.monto = String(round2(usd * tc));
        } else if (Number.isFinite(ars) && ars > 0) {
          next.usd_recibido = String(round2(ars / tc));
        }
      }
      return next;
    });
  };
  const setUsdRecibido = (v) => {
    setMultiLiq(f => {
      const usd = Number(v);
      const tc = Number(f.tc);
      const next = { ...f, usd_recibido: v };
      if (Number.isFinite(usd) && usd > 0 && Number.isFinite(tc) && tc > 0) {
        next.monto = String(round2(usd * tc));
      }
      return next;
    });
  };

  // Cobro previo (saldos de ventas anteriores al sistema — junio 2026)
  const EMPTY_COBRO_PREV = {
    metodo_pago_id: '', fecha: todayISO(), monto_bruto: '', pct: '', comentarios: '',
  };
  const [showCobroPrev, setShowCobroPrev] = useState(false);
  const [cobroPrev, setCobroPrev] = useState(EMPTY_COBRO_PREV);
  const [savingCobroPrev, setSavingCobroPrev] = useState(false);
  const [cobroPrevError, setCobroPrevError] = useState('');

  // Editar un movimiento existente. `editMov` guarda el row original; `editForm`
  // tiene los campos editables según el tipo. Cobros de venta NO entran acá
  // (botón oculto): se ajustan editando la venta.
  const [editMov, setEditMov] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState('');

  // Refs para useModal (a11y: Esc cierra, body scroll lock, focus inicial).
  // Antes los modales se hacían a mano sin Esc handler — auditoría TANDA 1.
  const cobroPrevModalRef = useRef(null);
  const editModalRef      = useRef(null);
  useModal({
    open: showCobroPrev,
    onClose: () => !savingCobroPrev && setShowCobroPrev(false),
    overlayRef: cobroPrevModalRef,
  });
  useModal({
    open: !!editMov,
    onClose: () => !savingEdit && setEditMov(null),
    overlayRef: editModalRef,
  });

  // KPIs por tarjeta (list y detalle.resumen) responden al filtro de período
  // en TODO: saldo, Comisión, Cobrado, Liquidado, Movimientos. El saldo del
  // período = cobros del rango − liqs del rango (puede ser negativo si en el
  // período se liquidaron cobros viejos; con preset 'todo' coincide con el
  // histórico real). Decidido 2026-06-05 tras feedback PO en uso operativo:
  // priorizamos coherencia visual entre KPIs sobre la lectura "estado actual".
  function loadList() {
    setLoadingList(true);
    tarjetasApi.list(rangeToParams(tarjRange))
      .then(r => setList(r || []))
      .catch(e => toast.error(e.message))
      .finally(() => setLoadingList(false));
    tarjetasApi.movimientosAll({ ...rangeToParams(tarjRange), limit: 500 })
      .then(r => setAllMovs(r.data || [])).catch(() => {});
  }
  useEffect(() => { loadList(); }, [tarjRange]); // eslint-disable-line
  useEffect(() => { cajasApi.listCajas().then(r => setCajas(Array.isArray(r) ? r : [])).catch(() => {}); }, []);
  useEffect(() => {
    setPrimaryAction(null);
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]);
  // Al entrar al Detalle por primera vez, default a "Todas las tarjetas" — es
  // la vista panorama (4 KPIs sumados + ledger unificado + form de liquidación
  // múltiple), que es lo que el operador usa más seguido cuando la financiera
  // le deposita un único monto que cubre las 3 modalidades.
  useEffect(() => { if (list.length > 0 && !selectedId) setSelectedId(ALL_TARJETAS); }, [list]); // eslint-disable-line

  function loadDetalle() {
    // En la vista "Todas" no cargamos detalle de una tarjeta puntual — los
    // datos ya están en `list` (KPIs agregados) y `allMovs` (ledger unificado).
    if (!selectedId || selectedId === ALL_TARJETAS) { setDetalle(null); setMovs([]); return; }
    Promise.all([
      tarjetasApi.get(selectedId, rangeToParams(tarjRange)),
      tarjetasApi.movimientos(selectedId, { ...rangeToParams(tarjRange), limit: 500 }),
    ])
      .then(([det, m]) => { setDetalle(det); setMovs(m.data || []); })
      .catch(e => toast.error(e.message));
  }
  useEffect(() => { loadDetalle(); setLiq({ fecha: todayISO(), monto: '', caja_id: '' }); }, [selectedId, tarjRange]); // eslint-disable-line

  // Totales globales (suma de las tarjetas). Todos los campos vienen ya
  // filtrados por el server según el rango — esto solo agrega entre tarjetas.
  const global = useMemo(() => list.reduce((a, t) => {
    a.bruto     += Number(t.bruto_total     || 0);
    a.comision  += Number(t.comision_total  || 0);
    a.saldo     += Number(t.saldo           || 0);
    a.liquidado += Number(t.liquidado_total || 0);
    return a;
  }, { bruto: 0, comision: 0, saldo: 0, liquidado: 0 }), [list]);

  // El estado de cuenta viene del server ya ordenado (más reciente arriba) y con el
  // saldo acumulado calculado (window sobre todo el historial), así que se usa tal cual.
  const estadoCuenta = allMovs;

  // Export del Estado de cuenta del período (PDF + XLSX). Único state
  // ('pdf'|'xlsx'|null) para mostrar "Generando…" en el botón activo y
  // disable el otro. Réplica del patrón de Financiera/Comprobantes.
  const [exportingTarj, setExportingTarj] = useState(null);

  // Trae TODO el período (no solo lo paginado a 500) + totales agregados.
  // Tope 5000 — si el rango pasa de ese número, error claro al operador.
  async function fetchTodoElPeriodoTarj() {
    const p = rangeToParams(tarjRange);
    const [movsRes, totales] = await Promise.all([
      tarjetasApi.movimientosAll({ ...p, limit: 5000 }),
      tarjetasApi.movimientosTotales(p),
    ]);
    if ((totales.count || 0) > 5000) {
      throw new Error(`El período tiene ${totales.count} movimientos (tope 5000). Refiná el filtro de fecha y exportá por partes.`);
    }
    return { movimientos: movsRes.data || [], totales };
  }

  async function exportPdfTarj() {
    setExportingTarj('pdf');
    try {
      const { movimientos, totales } = await fetchTodoElPeriodoTarj();
      if (!movimientos.length) {
        toast.error('No hay movimientos en el período seleccionado.');
        return;
      }
      await generarTarjetasResumenPdf({
        movimientos,
        totales,
        periodoLabel: rangeLabel(tarjRange),
      });
      toast.success('PDF generado');
    } catch (err) {
      toast.error(err);
    } finally {
      setExportingTarj(null);
    }
  }

  async function exportXlsxTarj() {
    setExportingTarj('xlsx');
    try {
      const { movimientos, totales } = await fetchTodoElPeriodoTarj();
      if (!movimientos.length) {
        toast.error('No hay movimientos en el período seleccionado.');
        return;
      }
      generarTarjetasResumenXlsx({
        movimientos,
        totales,
        periodoLabel: rangeLabel(tarjRange),
      });
      toast.success('Planilla generada');
    } catch (err) {
      toast.error(err);
    } finally {
      setExportingTarj(null);
    }
  }

  async function handleLiquidar(e) {
    e.preventDefault();
    if (!liq.caja_id) { toast.error('Elegí la caja donde entra el dinero.'); return; }
    if (!(parseFloat(liq.monto) > 0)) { toast.error('Ingresá el monto recibido.'); return; }
    setSavingLiq(true);
    try {
      await tarjetasApi.createLiquidacion(
        { metodo_pago_id: selectedId, fecha: liq.fecha, monto: Number(liq.monto), caja_id: Number(liq.caja_id) },
        liqIdempotencyKey,
      );
      setLiq({ fecha: liq.fecha, monto: '', caja_id: '' });
      // Pattern G: regenerar UUID después del éxito para que el próximo
      // submit desde el mismo form use un key fresco.
      setLiqIdempotencyKey(crypto.randomUUID());
      loadList(); loadDetalle();
      toast.success('Liquidación registrada.');
    } catch (err) { toast.error(err.message); } finally { setSavingLiq(false); }
  }

  // ── Liquidación múltiple (vista "Todas las tarjetas") ──
  // Suma de los repartos = lo que el operador asignó a cada tarjeta.
  // La validación clave: sumaRepartos === monto total recibido (con tolerancia
  // 0.01 por el redondeo cuando alguien hace el FIFO automático).
  const sumaRepartos = useMemo(() => {
    return Object.values(multiLiq.repartos).reduce((a, v) => a + (Number(v) || 0), 0);
  }, [multiLiq.repartos]);

  const totalMulti = Number(multiLiq.monto) || 0;
  const deltaRepartos = sumaRepartos - totalMulti;
  // Conversión USD: el operador edita libremente USD, TC y ARS (los 3 se
  // auto-completan entre sí cuando hay info suficiente, pero cada uno puede
  // sobreescribirse para reflejar exacto la planilla cuando hay redondeo de
  // centavos del dólar). Lo que IMPORTA al guardar:
  //   · monto (ARS) → descuenta del saldo de las tarjetas (= los repartos).
  //   · usd_recibido → entra a la caja USD destino.
  //   · tc → se persiste en cada mov para trazabilidad (no se usa para
  //     recalcular en backend si usd_recibido está cargado).
  const tcNum         = Number(multiLiq.tc) || 0;
  const usdRecibidoN  = Number(multiLiq.usd_recibido) || 0;
  const tcOk          = !multiLiq.convertir_usd || tcNum > 0;
  const usdOk         = !multiLiq.convertir_usd || usdRecibidoN > 0;
  const multiOk =
    totalMulti > 0 &&
    Math.abs(deltaRepartos) < 0.01 &&
    !!multiLiq.caja_id &&
    tcOk && usdOk;

  // FIFO sugerido: ordena las tarjetas por la fecha del cobro pendiente más
  // viejo y asigna del total disponible hasta agotar (o saturar el saldo de la
  // tarjeta). Es una ayuda — el operador puede sobreescribir cualquier monto.
  // Heurística: usamos allMovs para encontrar la fecha del primer cobro de cada
  // tarjeta. Tarjetas con saldo 0 se omiten.
  function sugerirFifo() {
    const total = Number(multiLiq.monto) || 0;
    if (total <= 0) { toast.error('Cargá primero el monto total recibido.'); return; }
    const ordered = list
      .filter(t => Number(t.saldo) > 0)
      .map(t => {
        const cobrosT = allMovs.filter(m => m.metodo_pago_id === t.id && m.tipo === 'cobro');
        // Si no hay cobros conocidos en allMovs (raro), poner una fecha lejana
        // para que vaya último — preferimos asignar a tarjetas con cobros viejos.
        const oldest = cobrosT.length
          ? cobrosT.reduce((a, c) => (c.fecha < a ? c.fecha : a), cobrosT[0].fecha)
          : '9999-12-31';
        return { id: t.id, saldo: Number(t.saldo), oldest };
      })
      .sort((a, b) => a.oldest.localeCompare(b.oldest));
    let restante = total;
    const repartos = {};
    for (const t of ordered) {
      if (restante <= 0) break;
      const asignar = Math.round(Math.min(restante, t.saldo) * 100) / 100;
      if (asignar > 0) repartos[t.id] = String(asignar);
      restante = Math.round((restante - asignar) * 100) / 100;
    }
    setMultiLiq(f => ({ ...f, repartos }));
    if (restante > 0.01) {
      // toast.warn siempre existe (ToastContext); el `?.` que estaba antes era
      // ruido sin defensa real — quitado en auditoría 2026-06-06.
      toast.warn(`El total supera el saldo pendiente por ${fmt(restante)}. Ajustá manualmente.`);
    }
  }

  function setReparto(tarjetaId, valor) {
    setMultiLiq(f => ({
      ...f,
      repartos: { ...f.repartos, [tarjetaId]: valor },
    }));
  }

  async function handleLiquidarMultiple(e) {
    e.preventDefault();
    if (!multiLiq.caja_id) { toast.error('Elegí la caja donde entra el dinero.'); return; }
    if (totalMulti <= 0) { toast.error('Ingresá el total ARS (descuenta del saldo).'); return; }
    if (multiLiq.convertir_usd) {
      if (tcNum <= 0) { toast.error('Cargá el TC del día.'); return; }
      if (usdRecibidoN <= 0) { toast.error('Cargá el USD recibido (lo que entra a la caja).'); return; }
    }
    if (!multiOk) {
      toast.error(`La suma de los repartos (${fmt(sumaRepartos)}) no coincide con el total ARS (${fmt(totalMulti)}).`);
      return;
    }
    // Filtramos repartos con monto > 0 — el backend rechaza ceros y vacíos.
    const repartosArr = Object.entries(multiLiq.repartos)
      .map(([id, v]) => ({ metodo_pago_id: Number(id), monto: Number(v) || 0 }))
      .filter(r => r.monto > 0);
    if (repartosArr.length === 0) {
      toast.error('Asigná al menos una tarjeta con monto > 0.');
      return;
    }
    // Período cubierto: solo lo mando si ambos extremos están completos. El
    // backend rechaza "solo uno"; acá silenciamos antes para no enviar ruido.
    const periodoCompleto = multiLiq.periodo_desde && multiLiq.periodo_hasta;
    setSavingMultiLiq(true);
    try {
      const payload = {
        fecha: multiLiq.fecha,
        caja_id: Number(multiLiq.caja_id),
        repartos: repartosArr,
        comentarios: multiLiq.comentarios.trim() || null,
        convertir_usd: !!multiLiq.convertir_usd,
        // Cuando convertimos: SIEMPRE mandamos total_usd_efectivo = lo que
        // el operador cargó como USD recibido. Esto le dice al backend
        // "no recalcules USD desde ARS/TC — usá este valor exacto". Garantiza
        // que la caja USD reciba exactamente lo que dice la planilla, incluso
        // si los 3 valores no son matemáticamente consistentes por redondeo.
        ...(multiLiq.convertir_usd ? {
          tc: tcNum,
          total_usd_efectivo: usdRecibidoN,
        } : {}),
        ...(periodoCompleto ? {
          periodo_desde: multiLiq.periodo_desde,
          periodo_hasta: multiLiq.periodo_hasta,
        } : {}),
      };
      await tarjetasApi.createLiquidacionMultiple(payload);
      // Reset parcial y refresh. Mantenemos fecha + caja + convertir_usd
      // para liquidaciones encadenadas del mismo día (lunes/jueves vienen 2
      // liquidaciones en la misma planilla, con SU PROPIO TC pero misma
      // fecha de depósito). Limpiamos TC también — la segunda liquidación
      // tiene un TC distinto al de la primera y sino el ARS se autocompleta
      // con el TC viejo y queda mal.
      setMultiLiq(f => ({
        ...f,
        monto: '', usd_recibido: '', tc: '', repartos: {}, comentarios: '',
        periodo_desde: '', periodo_hasta: '',
      }));
      loadList();
      toast.success(`Liquidación registrada (${repartosArr.length} ${repartosArr.length === 1 ? 'tarjeta' : 'tarjetas'}).`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingMultiLiq(false);
    }
  }

  // Borrar con contexto del movimiento (fecha + tipo + monto) en el confirm.
  // Sin contexto, el usuario veía un texto genérico fuera del row y podía
  // equivocarse de operación. Acepta el row entero (no solo id).
  async function handleDeleteMov(m) {
    const tipoLabel = m.tipo === 'cobro' ? 'cobro previo' : 'liquidación';
    const monto = `${sym(m.moneda)} ${fmt(m.monto_neto)}`;
    const ok = await confirm({
      title: `Eliminar ${tipoLabel}`,
      message: `Fecha ${fmtFecha(m.fecha)} · Neto ${monto}.\n${m.tipo === 'liquidacion' ? 'Se revierte el ingreso a la caja.' : 'Se quita del saldo pendiente de la tarjeta.'}`,
      confirmLabel: 'Eliminar', danger: true,
    });
    if (!ok) return;
    try { await tarjetasApi.deleteMovimiento(m.id); loadList(); loadDetalle(); } catch (err) { toast.error(err.message); }
  }

  // Cobro previo: carga un saldo pendiente de venta anterior al sistema.
  // Al elegir la tarjeta, el % comisión se pre-carga del método (editable).
  function openCobroPrevio() {
    setCobroPrev(EMPTY_COBRO_PREV);
    setCobroPrevError('');
    setShowCobroPrev(true);
  }

  // Cuando cambia la tarjeta seleccionada, pre-cargar el % comisión del método.
  function setCobroPrevTarjeta(id) {
    const t = list.find(x => String(x.id) === String(id));
    setCobroPrev(f => ({ ...f, metodo_pago_id: id, pct: t ? String(t.comision_pct ?? '') : '' }));
  }

  // Cálculo client-side del neto para preview en el modal (el server recalcula
  // al guardar — esto es solo informativo).
  const cobroPrevCalc = useMemo(() => {
    const bruto = Number(cobroPrev.monto_bruto) || 0;
    const pct = Number(cobroPrev.pct) || 0;
    const comision = Math.round(bruto * pct) / 100;
    const neto = Math.round((bruto - comision) * 100) / 100;
    return { bruto, comision, neto };
  }, [cobroPrev.monto_bruto, cobroPrev.pct]);

  async function handleCobroPrevSave(e) {
    e?.preventDefault?.();
    setCobroPrevError('');
    if (!cobroPrev.metodo_pago_id) { setCobroPrevError('Elegí la tarjeta.'); return; }
    if (!(Number(cobroPrev.monto_bruto) > 0)) { setCobroPrevError('El bruto debe ser mayor a 0.'); return; }
    setSavingCobroPrev(true);
    try {
      await tarjetasApi.createCobroInicial({
        metodo_pago_id: Number(cobroPrev.metodo_pago_id),
        fecha:          cobroPrev.fecha,
        monto_bruto:    Number(cobroPrev.monto_bruto),
        pct:            cobroPrev.pct === '' ? undefined : Number(cobroPrev.pct),
        comentarios:    cobroPrev.comentarios.trim() || null,
      });
      setShowCobroPrev(false);
      loadList();
      if (selectedId === Number(cobroPrev.metodo_pago_id)) loadDetalle();
      toast.success('Cobro previo registrado.');
    } catch (err) {
      setCobroPrevError(err.message || 'No se pudo registrar el cobro previo.');
    } finally {
      setSavingCobroPrev(false);
    }
  }

  // ── Edición de movimientos ──
  // Cobros de venta (venta_id != null) NO se editan acá. El botón se oculta.
  const canEdit = (m) => !(m.tipo === 'cobro' && m.venta_id != null);

  function openEdit(m) {
    setEditError('');
    // metodo_nombre solo viene en la vista General (all-movs). Para la vista
    // Detalle, fallback al nombre de la tarjeta seleccionada.
    setEditMov({ ...m, metodo_nombre: m.metodo_nombre || detalle?.nombre || '' });
    if (m.tipo === 'cobro') {
      // Cobro previo (venta_id IS NULL): editar bruto + pct + fecha + comentarios.
      setEditForm({
        fecha:       (m.fecha || '').slice(0, 10),
        monto_bruto: String(m.monto_bruto ?? ''),
        pct:         String(m.pct ?? ''),
        comentarios: m.comentarios || '',
      });
    } else {
      // Liquidación: editar monto (neto recibido) + caja + fecha + comentarios.
      setEditForm({
        fecha:       (m.fecha || '').slice(0, 10),
        monto:       String(m.monto_neto ?? ''),
        caja_id:     String(m.caja_id ?? ''),
        comentarios: m.comentarios || '',
      });
    }
  }

  // Preview client-side del recálculo en cobros previos (igual que en alta).
  const editCobroCalc = useMemo(() => {
    if (!editMov || editMov.tipo !== 'cobro') return { bruto: 0, comision: 0, neto: 0 };
    const bruto = Number(editForm.monto_bruto) || 0;
    const pct = Number(editForm.pct) || 0;
    const comision = Math.round(bruto * pct) / 100;
    const neto = Math.round((bruto - comision) * 100) / 100;
    return { bruto, comision, neto };
  }, [editMov, editForm.monto_bruto, editForm.pct]);

  async function handleEditSave(e) {
    e?.preventDefault?.();
    if (!editMov) return;
    setEditError('');
    let payload;
    if (editMov.tipo === 'cobro') {
      if (!(Number(editForm.monto_bruto) > 0)) { setEditError('El bruto debe ser mayor a 0.'); return; }
      payload = {
        fecha:       editForm.fecha,
        monto_bruto: Number(editForm.monto_bruto),
        pct:         editForm.pct === '' ? null : Number(editForm.pct),
        comentarios: (editForm.comentarios || '').trim() || null,
      };
    } else {
      if (!(Number(editForm.monto) > 0)) { setEditError('El monto debe ser mayor a 0.'); return; }
      if (!editForm.caja_id) { setEditError('Elegí la caja donde entra.'); return; }
      payload = {
        fecha:       editForm.fecha,
        monto:       Number(editForm.monto),
        caja_id:     Number(editForm.caja_id),
        comentarios: (editForm.comentarios || '').trim() || null,
      };
    }
    setSavingEdit(true);
    try {
      await tarjetasApi.updateMovimiento(editMov.id, payload);
      setEditMov(null);
      loadList(); loadDetalle();
      toast.success('Movimiento actualizado.');
    } catch (err) {
      setEditError(err.message || 'No se pudo actualizar.');
    } finally {
      setSavingEdit(false);
    }
  }

  const r = detalle?.resumen || {};
  const mon = detalle?.moneda || 'ARS';
  const sinTarjetas = !loadingList && list.length === 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Tarjetas de Crédito</h1>
          <div className="page-sub">Se carga solo desde Ventas · comisión de la financiera, neto que te deben y liquidaciones</div>
        </div>
        {!sinTarjetas && (
          <div className="page-actions">
            {/* Cobro previo: carga saldos pendientes de ventas anteriores al
                sistema. Útil al arrancar — sin obligar a re-cargar ventas
                históricas para tener el saldo correcto en cada tarjeta. */}
            <button className="btn btn-sm" onClick={openCobroPrevio}>
              <Icons.Plus size={13} /> Cobro previo
            </button>
            <div className="tabs">
              <button className={'tab' + (vista === 'general' ? ' active' : '')} onClick={() => setVista('general')}>General</button>
              <button className={'tab' + (vista === 'detalle' ? ' active' : '')} onClick={() => setVista('detalle')}>Detalle</button>
            </div>
          </div>
        )}
      </div>

      {/* Filtro de período compartido por las vistas General y Detalle.
          Afecta a TODOS los KPIs (Te deben, Comisión, Cobrado, Ya recibido,
          Movimientos) y al ledger. Con preset 'todo' los KPIs coinciden con
          el histórico real; con un rango específico reflejan el movimiento
          neto del período (puede dar negativo si se liquidaron más cobros
          de los que entraron en ese rango). */}
      {!sinTarjetas && (
        <div className="card card-tight u-mb-14">
          <div className="flex-row u-gap-6-wrap-center">
            <span className="muted tiny u-mr-4">Período (ledger):</span>
            {RANGE_PRESETS.map(p => (
              <button key={p.v}
                      className={'btn btn-sm ' + (tarjRange.preset === p.v ? 'btn-primary' : 'btn-ghost')}
                      onClick={() => setTarjRange(r => ({ ...r, preset: p.v }))}>
                {p.l}
              </button>
            ))}
            {tarjRange.preset === 'custom' && (
              <>
                <input type="date" className="input u-w-140-ml-6"
                       value={tarjRange.desde}
                       onChange={e => setTarjRange(r => ({ ...r, desde: e.target.value }))} />
                <span className="muted tiny">a</span>
                <input type="date" className="input u-w-140"
                       value={tarjRange.hasta}
                       onChange={e => setTarjRange(r => ({ ...r, hasta: e.target.value }))} />
              </>
            )}
          </div>
        </div>
      )}

      {sinTarjetas ? (
        // 2026-06-24 lote F: padding fluido — 14px mobile / 24px desktop.
        <div className="card u-p-clamp-14-24">
          <div className="u-fw-600-mb-6">Todavía no hay tarjetas configuradas</div>
          <div className="muted u-fs-13">
            Creá los métodos de pago tarjeta en <b>Cajas → Config Cajas</b> (tildá "Es tarjeta" y poné su % de comisión).
            Después, cada venta cobrada con ellos impacta acá automáticamente.
          </div>
        </div>
      ) : vista === 'general' ? (
        <>
          {/* KPIs globales */}
          <div className="row u-mb-14">
            <div className="card card-tight u-flex-1">
              <div className="kpi-label">Saldo a tu favor</div>
              <div className={`kpi-value mono ${saldoClass(global.saldo)}`}>$ {fmt(global.saldo)}</div>
            </div>
            <div className="card card-tight u-flex-1">
              <div className="kpi-label">Comisión financiera</div>
              <div className="kpi-value mono u-color-neg">$ {fmt(global.comision)}</div>
            </div>
            <div className="card card-tight u-flex-1">
              <div className="kpi-label">Ya recibido (liquidado)</div>
              <div className="kpi-value mono">$ {fmt(global.liquidado)}</div>
            </div>
            <div className="card card-tight u-flex-1">
              <div className="kpi-label">Cobrado bruto</div>
              <div className="kpi-value mono">$ {fmt(global.bruto)}</div>
            </div>
          </div>

          {/* Resumen por tarjeta */}
          <div className="card card-flush u-mb-14">
            <div className="card-hd"><div className="u-fs-14-fw-600">Por tarjeta</div></div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Tarjeta</th><th className="u-text-right">Comisión</th>
                  <th className="u-text-right">Cobrado bruto</th><th className="u-text-right">Comisión $</th><th className="u-text-right">Te deben</th>
                </tr>
              </thead>
              <tbody>
                {list.map(t => (
                  <tr key={t.id} className="u-cursor-pointer" onClick={() => { setSelectedId(t.id); setVista('detalle'); }}>
                    <td className="u-fw-600">{t.nombre}</td>
                    <td className="mono tiny u-text-right">{Number(t.comision_pct || 0)}%</td>
                    <td className="mono u-text-right">$ {fmt(t.bruto_total)}</td>
                    <td className="mono u-color-neg-text-right">$ {fmt(t.comision_total)}</td>
                    <td className="mono u-td-right-fw-700-accent">$ {fmt(t.saldo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Estado de cuenta unificado */}
          <div className="card card-flush">
            <div className="card-hd">
              <div className="u-fs-14-fw-600">
                Estado de cuenta
                <span className="muted tiny u-ml-8-fw-400">· {rangeLabel(tarjRange)} ({estadoCuenta.length})</span>
              </div>
              {/* Export del período actual — mismo patrón que Comprobantes/Financiera.
                  Sin ZIP porque Tarjetas no tiene archivos físicos asociados. */}
              <div className="flex-row u-gap-8">
                <button className="btn btn-sm btn-ghost" onClick={exportPdfTarj}
                        disabled={!!exportingTarj} title="PDF con KPIs + tabla detalle del período">
                  <Icons.FileText size={13} />
                  {exportingTarj === 'pdf' ? ' Generando PDF…' : ' PDF resumen'}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={exportXlsxTarj}
                        disabled={!!exportingTarj} title="Planilla Excel con KPIs + detalle (montos como números)">
                  <Icons.Sheet size={13} />
                  {exportingTarj === 'xlsx' ? ' Generando XLSX…' : ' XLSX resumen'}
                </button>
              </div>
            </div>
            <div className="u-overflow-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Fecha</th><th>Tarjeta</th><th>Tipo</th>
                    {/* Bruto: para que el operador pueda chequear cupón por cupón
                        contra el resumen físico de la financiera. El neto solo no
                        alcanza porque la financiera factura sobre el bruto. */}
                    <th className="u-text-right">Bruto</th>
                    <th className="u-text-right">Neto</th>
                    <th className="u-text-right">Saldo acum.</th>
                    <th>Origen</th>
                    {/* Acciones: editar + eliminar. Solo para cobros previos y liquidaciones —
                        los cobros de venta (venta_id != null) NO se tocan acá. */}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {estadoCuenta.length === 0 && <tr><td colSpan={8} className="empty">Sin movimientos todavía.</td></tr>}
                  {estadoCuenta.map(m => (
                    <tr key={m.id}>
                      <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                      <td className="tiny">{m.metodo_nombre}</td>
                      <td><span className={'badge ' + (m.tipo === 'cobro' ? '' : 'badge-info')}>{m.tipo === 'cobro' ? 'Cobro' : 'Liquidación'}</span></td>
                      {/* Bruto: solo tiene sentido en cobros (en liquidaciones bruto=neto y se entiende como neto recibido). */}
                      <td className="mono tiny u-text-right">
                        {m.tipo === 'cobro' ? `${sym(m.moneda)} ${fmt(m.monto_bruto)}` : '—'}
                      </td>
                      <td className={`mono u-text-right ${m.tipo === 'cobro' ? 'u-tone-accent' : 'u-tone-neg'}`}>
                        {m.tipo === 'cobro' ? '+' : '−'} {sym(m.moneda)} {fmt(m.monto_neto)}
                      </td>
                      <td className="mono u-td-right-fw-700">$ {fmt(m.saldo_acum)}</td>
                      <td className="tiny">{m.venta_order_id ? `Venta ${m.venta_order_id}` : (m.caja_nombre || '—')}</td>
                      <td className="u-text-right-nowrap">
                        {canEdit(m) ? (
                          <>
                            <button className="icon-btn" title="Editar" aria-label="Editar movimiento" onClick={() => openEdit(m)}>
                              <Icons.Edit size={13} />
                            </button>
                            <button className="icon-btn u-color-neg" title="Eliminar" aria-label="Eliminar movimiento" onClick={() => handleDeleteMov(m)}>
                              <Icons.Trash size={13} />
                            </button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        // 2026-06-24 mobile lote D: usar .split-master-detail (de Lote A) que
        // colapsa a single col en <=720px. Sin esto, en 375px el master
        // 300px = 80% del ancho y el detail queda en 75px ilegible.
        <div className="split-master-detail u-tarj-master-detail">
          {/* Lista de tarjetas (métodos de pago) + ítem virtual "Todas las
              tarjetas" al inicio para ver el resumen agregado y registrar
              la liquidación múltiple (un depósito que cubre N modalidades). */}
          <div className="card card-flush u-mh-78vh-o-auto">
            <div
              onClick={() => setSelectedId(ALL_TARJETAS)}
              className={`u-tarj-item ${selectedId === ALL_TARJETAS ? 'u-tarj-item-active' : ''}`}
            >
              <div className="u-fw-700-fs-13">Todas las tarjetas</div>
              <div className="muted tiny u-mt-2">{list.length} {list.length === 1 ? 'modalidad' : 'modalidades'} · resumen + liquidación múltiple</div>
              <div className={`mono tiny u-mt-2 ${saldoClass(global.saldo)}`}>
                Te deben: $ {fmt(global.saldo)}
              </div>
            </div>
            {list.map((t) => (
              <div
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`u-tarj-item ${selectedId === t.id ? 'u-tarj-item-active' : ''}`}
              >
                <div className="u-fs-13-fw-600">{t.nombre}</div>
                <div className="muted tiny u-mt-2">Comisión {Number(t.comision_pct || 0)}%</div>
                <div className={`mono tiny u-mt-2 ${saldoClass(t.saldo)}`}>
                  Te deben: {sym(t.moneda)} {fmt(t.saldo)}
                </div>
              </div>
            ))}
          </div>

          {/* Detalle */}
          {selectedId === ALL_TARJETAS ? (
            // ── Vista "Todas las tarjetas" — KPIs sumados + form de liquidación
            //    múltiple + ledger unificado. Pensada para registrar el depósito
            //    de la financiera que cubre N modalidades en una sola operación. ──
            <div className="stack u-gap-14">
              <div className="card">
                <div className="u-fs-18-fw-700">Todas las tarjetas</div>
                <div className="muted tiny u-mt-4">
                  Resumen agregado de las {list.length} {list.length === 1 ? 'modalidad activa' : 'modalidades activas'}.
                </div>
              </div>

              {/* KPIs sumados — mismos 4 cards que cada tarjeta individual,
                  pero con los totales globales del rango elegido. */}
              <div className="row">
                <div className="card card-tight u-flex-1">
                  <div className="kpi-label">Te deben (falta cobrar)</div>
                  <div className="kpi-value mono u-color-accent">$ {fmt(global.saldo)}</div>
                </div>
                <div className="card card-tight u-flex-1">
                  <div className="kpi-label">Comisión financiera</div>
                  <div className="kpi-value mono u-color-neg">$ {fmt(global.comision)}</div>
                </div>
                <div className="card card-tight u-flex-1">
                  <div className="kpi-label">Cobrado (bruto)</div>
                  <div className="kpi-value mono">$ {fmt(global.bruto)}</div>
                </div>
                <div className="card card-tight u-flex-1">
                  <div className="kpi-label">Movimientos</div>
                  <div className="kpi-value mono">{estadoCuenta.length}</div>
                </div>
              </div>

              {/* ── Liquidación múltiple ──
                  La financiera deposita un solo monto que cubre cupones de
                  varios planes (Lucas confirma que viene desglosado en el
                  comprobante). Form: total + caja + N inputs por modalidad
                  con validación en vivo de "suma === total". */}
              <div className="card">
                <div className="card-hd"><div className="u-fs-14-fw-600">Registrar liquidación múltiple</div></div>
                <form onSubmit={handleLiquidarMultiple} className="stack u-gap-10">
                  {/* Fila 1: fecha del depósito + período cubierto (opcional,
                      lo que la planilla de la financiera dice tipo "26-27/5"). */}
                  <div className="flex-row u-gap-8-wrap-flex-end">
                    <div className="field u-w-150px">
                      <label className="field-label tiny">Fecha depósito</label>
                      <input type="date" className="input"
                             value={multiLiq.fecha}
                             onChange={e => setMultiLiq(f => ({ ...f, fecha: e.target.value }))} />
                    </div>
                    <div className="field u-w-150px">
                      <label className="field-label tiny">Período desde (opc.)</label>
                      <input type="date" className="input"
                             value={multiLiq.periodo_desde}
                             onChange={e => setMultiLiq(f => ({ ...f, periodo_desde: e.target.value }))} />
                    </div>
                    <div className="field u-w-150px">
                      <label className="field-label tiny">Período hasta (opc.)</label>
                      <input type="date" className="input"
                             value={multiLiq.periodo_hasta}
                             onChange={e => setMultiLiq(f => ({ ...f, periodo_hasta: e.target.value }))} />
                    </div>
                    <label className="flex-row u-label-ml-auto">
                      <input type="checkbox"
                             checked={multiLiq.convertir_usd}
                             onChange={e => setMultiLiq(f => ({
                               ...f,
                               convertir_usd: e.target.checked,
                               // Reset: el filtro de cajas cambia con la moneda.
                               // Si DESACTIVA el toggle, además limpiamos TC y USD
                               // para que no queden valores fantasma ocultos en el
                               // state (la fila con los 3 inputs se desmonta).
                               caja_id: '',
                               ...(e.target.checked ? {} : { tc: '', usd_recibido: '' }),
                             }))} />
                      <span className="u-fs-13-fw-600">Convertir a USD</span>
                    </label>
                  </div>

                  {/* Fila 2 — flujo USD → TC → ARS (solo si convertir_usd).
                      Los 3 inputs son editables; cuando el operador edita
                      uno, los otros se auto-completan vía USD×TC=ARS. Cada
                      uno puede sobreescribirse para reflejar la planilla
                      exacta (ej. ARS de la planilla con redondeo distinto
                      al matemático USD×TC). */}
                  {multiLiq.convertir_usd && (
                    <>
                    {/* Anchos fluidos (`flex: 1 1 140px`) en vez de fijos para
                        que en mobile (<480px) cada input se acomode en su
                        propia línea sin salirse. Símbolos `×` y `=` tienen
                        aria-hidden por ser decorativos (lectores no los
                        anuncian sueltos). U4/U11 auditoría 2026-06-06. */}
                    <div className="flex-row u-gap-8-wrap-flex-end">
                      <div className="field u-flex-11-140-mw-140">
                        <label htmlFor="multiliq-usd" className="field-label tiny">USD recibido (caja)</label>
                        <input id="multiliq-usd" type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01" className="input mono"
                               placeholder="0"
                               value={multiLiq.usd_recibido}
                               onChange={e => setUsdRecibido(e.target.value)} />
                      </div>
                      <div className="flex-row u-align-center-mb-8" aria-hidden="true">
                        <span className="muted u-fs-18-fw-700">×</span>
                      </div>
                      <div className="field u-flex-11-120-mw-120">
                        <label htmlFor="multiliq-tc" className="field-label tiny">TC del día</label>
                        <input id="multiliq-tc" type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01" className="input mono"
                               placeholder="0"
                               value={multiLiq.tc}
                               onChange={e => setTcMulti(e.target.value)} />
                        {/* U13: alerta TC fuera de rango si el operador
                            configuró un TC de referencia en Alertas. */}
                        <TcWarning tc={multiLiq.tc} />
                      </div>
                      <div className="flex-row u-align-center-mb-8" aria-hidden="true">
                        <span className="muted u-fs-18-fw-700">=</span>
                      </div>
                      <div className="field u-flex-11-160-mw-160">
                        <label htmlFor="multiliq-ars" className="field-label tiny">Total ARS (descuenta del saldo)</label>
                        <input id="multiliq-ars" type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono"
                               placeholder="0"
                               value={multiLiq.monto}
                               onChange={e => setMontoArs(e.target.value)} />
                      </div>
                    </div>
                    {/* U6: indicador de descalce entre USD×TC y el ARS cargado.
                        Lucas EXPLICITAMENTE puede dejar los 3 inconsistentes
                        para reflejar el comprobante exacto con redondeos —
                        este chip solo informa, no bloquea. Útil para detectar
                        un cero de más (USD 500 × TC 1100 = $550.000, no
                        $5.500.000). */}
                    {(() => {
                      const usd = Number(multiLiq.usd_recibido) || 0;
                      const tc  = Number(multiLiq.tc) || 0;
                      const ars = Number(multiLiq.monto) || 0;
                      if (!(usd > 0 && tc > 0 && ars > 0)) return null;
                      const arsCalc = usd * tc;
                      const delta = ars - arsCalc;
                      if (Math.abs(delta) < 0.01) return null; // matchea exacto
                      const deltaClass = Math.abs(delta) < 100 ? 'u-tone-text-muted' : 'u-tone-warn';
                      return (
                        <div className={`mono tiny u-mt-neg-2 ${deltaClass}`} role="status">
                          USD × TC = $ {fmt(arsCalc)} (Δ {delta >= 0 ? '+' : ''}{fmt(delta)})
                          {Math.abs(delta) >= 100 && ' — revisá si es lo que dice la planilla.'}
                        </div>
                      );
                    })()}
                    </>
                  )}

                  {/* Si no se convierte a USD: solo input ARS (flujo simple). */}
                  {!multiLiq.convertir_usd && (
                    <div className="field u-w-220">
                      <label htmlFor="multiliq-ars-only" className="field-label tiny">Total ARS recibido</label>
                      <input id="multiliq-ars-only" type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono"
                             placeholder="0"
                             value={multiLiq.monto}
                             onChange={e => setMultiLiq(f => ({ ...f, monto: e.target.value }))} />
                    </div>
                  )}

                  {/* Fila 3: caja destino. El filtro depende del toggle —
                      cuando convertís a USD solo mostramos cajas USD/USDT. */}
                  <div className="field u-w-100">
                    <label className="field-label tiny">Entra a la caja {multiLiq.convertir_usd ? '(USD)' : '(ARS)'}</label>
                    <select className="input"
                            value={multiLiq.caja_id}
                            onChange={e => setMultiLiq(f => ({ ...f, caja_id: e.target.value }))}>
                      <option value="">Elegí la caja…</option>
                      {cajas
                        .filter(c => !c.es_tarjeta)
                        .filter(c => multiLiq.convertir_usd
                          ? (c.moneda === 'USD' || c.moneda === 'USDT')
                          : c.moneda === 'ARS')
                        .map(c => (
                          <option key={c.id} value={c.id}>{c.nombre}{c.moneda ? ' · ' + c.moneda : ''}</option>
                        ))}
                      <CajaSelectHint />
                    </select>
                  </div>

                  {/* Reparto por modalidad: 1 fila por tarjeta con saldo > 0.
                      Si no hay saldo pendiente en ninguna, mostramos un empty state
                      en vez del editor (no tiene sentido liquidar contra cero). */}
                  {list.filter(t => Number(t.saldo) > 0).length === 0 ? (
                    <div className="empty u-p-12">
                      No hay saldo pendiente en ninguna tarjeta. Cargá ventas o cobros previos primero.
                    </div>
                  ) : (
                    <>
                      <div className="muted tiny u-fw-600-mt-4">
                        Reparto por modalidad (suma debe ser igual al total):
                      </div>
                      <div className="stack u-gap-6">
                        {list.filter(t => Number(t.saldo) > 0).map(t => (
                          <div key={t.id} className="flex-row u-gap-8-center">
                            <div className="u-flex-1-minw-0">
                              <div className="u-fs-13-fw-600">{t.nombre}</div>
                              <div className="muted tiny mono">Saldo pendiente: {sym(t.moneda)} {fmt(t.saldo)}</div>
                            </div>
                            <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0"
                                   className="input mono u-w-160-right"
                                   placeholder="0"
                                   value={multiLiq.repartos[t.id] ?? ''}
                                   onChange={e => setReparto(t.id, e.target.value)} />
                          </div>
                        ))}
                      </div>

                      {/* Validador en vivo + (si aplica) preview del USD que
                          va a entrar a la caja. Si delta ≈ 0 → verde; sino
                          mostrar cuánto falta o sobra. */}
                      <div className="flex-row u-flex-gap-12-center-mt-4-wrap">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={sugerirFifo}
                                disabled={!(Number(multiLiq.monto) > 0)}>
                          Sugerir reparto (FIFO)
                        </button>
                        <div className={`mono tiny u-fw-600 ${totalMulti <= 0 ? 'u-tone-text-muted' : (multiOk ? 'u-tone-pos' : 'u-tone-neg')}`}>
                          {totalMulti <= 0
                            ? 'Cargá el total recibido para empezar.'
                            : multiOk
                              ? `Suma OK: $ ${fmt(sumaRepartos)}`
                              : (deltaRepartos > 0
                                  ? `Te sobran $ ${fmt(deltaRepartos)} sin asignar al total`
                                  : `Te faltan $ ${fmt(-deltaRepartos)} para llegar al total`)}
                        </div>
                        {multiLiq.convertir_usd && usdRecibidoN > 0 && (
                          <div className="mono tiny u-color-accent-fw-600">
                            · Caja USD recibe: u$s {fmt(usdRecibidoN)}
                          </div>
                        )}
                        <div className="u-flex-1" />
                        <button className="btn btn-primary btn-sm"
                                disabled={savingMultiLiq || !multiOk}
                                type="submit">
                          {savingMultiLiq ? '…' : 'Registrar liquidación'}
                        </button>
                      </div>
                    </>
                  )}
                </form>
              </div>

              {/* Ledger unificado — todos los movs de las 3 tarjetas con su
                  saldo acumulado real (window calculado en el server). */}
              <div className="card card-flush">
                <div className="card-hd">
                  <div className="u-fs-14-fw-600">
                    Estado de cuenta unificado
                    <span className="muted tiny u-ml-8-fw-400">· {rangeLabel(tarjRange)} ({estadoCuenta.length})</span>
                  </div>
                </div>
                <div className="u-overflow-auto">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Fecha</th><th>Tarjeta</th><th>Tipo</th>
                        <th className="u-text-right">Bruto</th>
                        <th className="u-text-right">Comisión</th>
                        <th className="u-text-right">Neto</th>
                        <th>Origen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {estadoCuenta.length === 0 && <tr><td colSpan={7} className="empty">Sin movimientos en este período.</td></tr>}
                      {estadoCuenta.map(m => (
                        <tr key={m.id}>
                          <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                          <td className="tiny">{m.metodo_nombre}</td>
                          <td><span className={'badge ' + (m.tipo === 'cobro' ? '' : 'badge-info')}>{m.tipo === 'cobro' ? 'Cobro' : 'Liquidación'}</span></td>
                          <td className="mono u-text-right">
                            {m.tipo === 'cobro' ? `${sym(m.moneda)} ${fmt(m.monto_bruto)}` : '—'}
                          </td>
                          <td className="mono tiny u-color-neg-text-right">
                            {Number(m.monto_comision) > 0 ? sym(m.moneda) + ' ' + fmt(m.monto_comision) : '—'}
                          </td>
                          <td className="mono u-td-right-fw-700">{sym(m.moneda)} {fmt(m.monto_neto)}</td>
                          <td className="tiny">{m.venta_order_id ? `Venta ${m.venta_order_id}` : (m.caja_nombre || '—')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : !detalle ? (
            <div className="card u-empty-state-grid">Elegí una tarjeta</div>
          ) : (
            <div className="stack u-gap-14">
              <div className="card">
                <div className="u-fs-18-fw-700">{detalle.nombre}</div>
                <div className="muted tiny u-mt-4">Comisión de la financiera: {Number(detalle.comision_pct || 0)}%</div>
              </div>

              <div className="row">
                <div className="card card-tight u-flex-1">
                  <div className="kpi-label">Te deben (falta cobrar)</div>
                  <div className={`kpi-value mono ${saldoClass(r.saldo)}`}>{sym(mon)} {fmt(r.saldo)}</div>
                </div>
                <div className="card card-tight u-flex-1">
                  <div className="kpi-label">Comisión financiera</div>
                  <div className="kpi-value mono u-color-neg">{sym(mon)} {fmt(r.comision_total)}</div>
                </div>
                <div className="card card-tight u-flex-1">
                  <div className="kpi-label">Cobrado (bruto)</div>
                  <div className="kpi-value mono">{sym(mon)} {fmt(r.bruto_total)}</div>
                </div>
                <div className="card card-tight u-flex-1">
                  <div className="kpi-label">Movimientos</div>
                  <div className="kpi-value mono">{r.movimientos || 0}</div>
                </div>
              </div>

              {/* Registrar liquidación (cuando nos pagan) */}
              <div className="card">
                <div className="card-hd"><div className="u-fs-14-fw-600">Registrar liquidación (te pagaron)</div></div>
                <form onSubmit={handleLiquidar} className="flex-row u-gap-8-wrap-flex-end">
                  <div className="field u-w-150px"><label className="field-label tiny">Fecha</label><input type="date" className="input" value={liq.fecha} onChange={e => setLiq(f => ({ ...f, fecha: e.target.value }))} /></div>
                  <div className="field u-w-150px"><label className="field-label tiny">Monto recibido</label><input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono" placeholder="0" value={liq.monto} onChange={e => setLiq(f => ({ ...f, monto: e.target.value }))} /></div>
                  <div className="field u-flex-1-mw-160"><label className="field-label tiny">Entra a la caja</label>
                    <select className="input" value={liq.caja_id} onChange={e => setLiq(f => ({ ...f, caja_id: e.target.value }))}>
                      <option value="">Elegí la caja…</option>
                      {cajas.filter(c => !c.es_tarjeta).map(c => <option key={c.id} value={c.id}>{c.nombre}{c.moneda ? ' · ' + c.moneda : ''}</option>)}
                      <CajaSelectHint />
                    </select>
                  </div>
                  <button className="btn btn-primary btn-sm" disabled={savingLiq} type="submit">{savingLiq ? '…' : 'Registrar'}</button>
                </form>
              </div>

              {/* Movimientos */}
              <div className="card card-flush">
                <div className="u-overflow-auto">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Fecha</th><th>Tipo</th><th className="u-text-right">Bruto</th><th className="u-text-right">Comisión</th>
                        <th className="u-text-right">Neto</th><th>Origen</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {movs.length === 0 && <tr><td colSpan={7} className="empty">Sin movimientos. Cobrá una venta con esta tarjeta.</td></tr>}
                      {movs.map(m => (
                        <tr key={m.id}>
                          <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                          <td><span className={'badge ' + (m.tipo === 'cobro' ? '' : 'badge-info')}>{m.tipo === 'cobro' ? 'Cobro' : 'Liquidación'}</span></td>
                          {/* Bruto: solo tiene sentido en cobros (en liquidaciones bruto=neto y es ruido).
                              Mismo criterio que la vista General de Estado de cuenta — antes esta
                              tabla mostraba el monto para liquidaciones también, inconsistente. */}
                          <td className="mono u-text-right">
                            {m.tipo === 'cobro' ? `${sym(m.moneda)} ${fmt(m.monto_bruto)}` : '—'}
                          </td>
                          <td className="mono tiny u-color-neg-text-right">{Number(m.monto_comision) > 0 ? sym(m.moneda) + ' ' + fmt(m.monto_comision) : '—'}</td>
                          <td className="mono u-td-right-fw-700">{sym(m.moneda)} {fmt(m.monto_neto)}</td>
                          <td className="tiny">{m.venta_order_id ? `Venta ${m.venta_order_id}` : (m.caja_nombre || '—')}</td>
                          <td className="u-text-right-nowrap">
                            {canEdit(m) ? (
                              <>
                                <button className="icon-btn" title="Editar" aria-label="Editar movimiento" onClick={() => openEdit(m)}>
                                  <Icons.Edit size={13} />
                                </button>
                                <button className="icon-btn u-color-neg" title="Eliminar" aria-label="Eliminar movimiento" onClick={() => handleDeleteMov(m)}>
                                  <Icons.Trash size={13} />
                                </button>
                              </>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Modal: Cobro previo (saldos de ventas anteriores al sistema) ── */}
      {showCobroPrev && (
        <div ref={cobroPrevModalRef} className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cobro-prev-title"
             onClick={(e) => { if (e.target === e.currentTarget && !savingCobroPrev) setShowCobroPrev(false); }}>
          <div className="modal u-mw-480" onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3 id="cobro-prev-title">Registrar cobro previo</h3>
              <button className="icon-btn" aria-label="Cerrar modal" onClick={() => setShowCobroPrev(false)} disabled={savingCobroPrev}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleCobroPrevSave}>
              <div className="modal-body">
                <fieldset disabled={savingCobroPrev} className="fieldset-inline">
                <div className="muted tiny u-lh-15-mb-14">
                  Para saldos pendientes de ventas anteriores al sistema. NO genera
                  una venta — solo agrega saldo a cobrar de la financiera. Una
                  liquidación futura lo cancela igual que cualquier otro cobro.
                </div>
                <div className="stack u-gap-12">
                  <div className="field">
                    <label className="field-label">Tarjeta <span className="u-color-neg">*</span></label>
                    <select className="input" value={cobroPrev.metodo_pago_id}
                            onChange={e => setCobroPrevTarjeta(e.target.value)} autoFocus>
                      <option value="">— Seleccionar —</option>
                      {list.map(t => (
                        <option key={t.id} value={t.id}>
                          {t.nombre} ({t.moneda} · {Number(t.comision_pct).toFixed(1)}% comisión)
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="row u-gap-8">
                    <div className="field u-flex-1">
                      <label className="field-label">Fecha del cobro</label>
                      <input type="date" className="input" value={cobroPrev.fecha}
                             onChange={e => setCobroPrev(f => ({ ...f, fecha: e.target.value }))} />
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label">Monto bruto <span className="u-color-neg">*</span></label>
                      <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01"
                             className="input mono" placeholder="0"
                             value={cobroPrev.monto_bruto}
                             onChange={e => setCobroPrev(f => ({ ...f, monto_bruto: e.target.value }))} />
                    </div>
                    <div className="field u-w-100px">
                      <label className="field-label">% comisión</label>
                      <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" max="100" step="0.01"
                             className="input mono" placeholder="0"
                             value={cobroPrev.pct}
                             onChange={e => setCobroPrev(f => ({ ...f, pct: e.target.value }))} />
                    </div>
                  </div>
                  {/* Preview client-side del cálculo (el server recalcula al guardar). */}
                  {Number(cobroPrev.monto_bruto) > 0 && (
                    <div className="u-fin-manual-summary">
                      <div className="flex-between"><span className="muted">Bruto:</span><span className="mono">{fmt(cobroPrevCalc.bruto)}</span></div>
                      <div className="flex-between"><span className="muted">Comisión ({cobroPrev.pct || 0}%):</span><span className="mono u-color-neg">− {fmt(cobroPrevCalc.comision)}</span></div>
                      <div className="flex-between u-divider-top-4">
                        <strong>Neto a cobrar:</strong>
                        <span className="mono u-color-accent-fw-700">{fmt(cobroPrevCalc.neto)}</span>
                      </div>
                    </div>
                  )}
                  <div className="field">
                    <label className="field-label">Comentarios</label>
                    <input className="input" placeholder="ej. Ventas de mayo 2026, previas al sistema"
                           value={cobroPrev.comentarios}
                           onChange={e => setCobroPrev(f => ({ ...f, comentarios: e.target.value }))} />
                  </div>
                  {cobroPrevError && <div className="u-color-neg-fs-13">{cobroPrevError}</div>}
                </div>
                </fieldset>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowCobroPrev(false)} disabled={savingCobroPrev}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingCobroPrev}>
                  {savingCobroPrev ? 'Guardando…' : 'Registrar cobro'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Modal: Editar movimiento (cobro previo o liquidación) ── */}
      {editMov && (
        <div ref={editModalRef} className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="edit-mov-title"
             onClick={(e) => { if (e.target === e.currentTarget && !savingEdit) setEditMov(null); }}>
          <div className="modal u-mw-480" onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3 id="edit-mov-title">Editar {editMov.tipo === 'cobro' ? 'cobro previo' : 'liquidación'}</h3>
              <button className="icon-btn" aria-label="Cerrar modal" onClick={() => setEditMov(null)} disabled={savingEdit}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleEditSave}>
              <div className="modal-body">
                {/* fieldset[disabled] propaga a todos los inputs/selects internos:
                    durante el save no se puede seguir tipeando (evita race con
                    el toast de éxito + cierre que pisaba cambios). */}
                <fieldset disabled={savingEdit} className="fieldset-inline">
                <div className="muted tiny u-lh-15-mb-14">
                  Tarjeta: <b>{editMov.metodo_nombre}</b>
                  {editMov.tipo === 'liquidacion' && (
                    <> · Si cambiás caja o monto, se revierte el ingreso anterior y se postea el nuevo.</>
                  )}
                </div>
                <div className="stack u-gap-12">
                  {editMov.tipo === 'cobro' ? (
                    <>
                      <div className="row u-gap-8">
                        <div className="field u-flex-1">
                          <label className="field-label">Fecha</label>
                          <input type="date" className="input" value={editForm.fecha || ''}
                                 onChange={e => setEditForm(f => ({ ...f, fecha: e.target.value }))} />
                        </div>
                        <div className="field u-flex-1">
                          <label className="field-label">Monto bruto <span className="u-color-neg">*</span></label>
                          <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01"
                                 className="input mono" value={editForm.monto_bruto || ''}
                                 onChange={e => setEditForm(f => ({ ...f, monto_bruto: e.target.value }))} />
                        </div>
                        <div className="field u-w-100px">
                          <label className="field-label">% comisión</label>
                          <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" max="100" step="0.01"
                                 className="input mono" value={editForm.pct || ''}
                                 onChange={e => setEditForm(f => ({ ...f, pct: e.target.value }))} />
                        </div>
                      </div>
                      {Number(editForm.monto_bruto) > 0 && (
                        <div className="u-fin-manual-summary">
                          <div className="flex-between"><span className="muted">Bruto:</span><span className="mono">{fmt(editCobroCalc.bruto)}</span></div>
                          <div className="flex-between"><span className="muted">Comisión ({editForm.pct || 0}%):</span><span className="mono u-color-neg">− {fmt(editCobroCalc.comision)}</span></div>
                          <div className="flex-between u-divider-top-4">
                            <strong>Neto a cobrar:</strong>
                            <span className="mono u-color-accent-fw-700">{fmt(editCobroCalc.neto)}</span>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="row u-gap-8">
                      <div className="field u-w-150px">
                        <label className="field-label">Fecha</label>
                        <input type="date" className="input" value={editForm.fecha || ''}
                               onChange={e => setEditForm(f => ({ ...f, fecha: e.target.value }))} />
                      </div>
                      <div className="field u-w-150px">
                        <label className="field-label">Monto recibido <span className="u-color-neg">*</span></label>
                        <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01"
                               className="input mono" value={editForm.monto || ''}
                               onChange={e => setEditForm(f => ({ ...f, monto: e.target.value }))} />
                      </div>
                      <div className="field u-flex-1-mw-160">
                        <label className="field-label">Entra a la caja</label>
                        <select className="input" value={editForm.caja_id || ''}
                                onChange={e => setEditForm(f => ({ ...f, caja_id: e.target.value }))}>
                          <option value="">Elegí la caja…</option>
                          {cajas.filter(c => !c.es_tarjeta).map(c => (
                            <option key={c.id} value={c.id}>{c.nombre}{c.moneda ? ' · ' + c.moneda : ''}</option>
                          ))}
                          <CajaSelectHint />
                        </select>
                      </div>
                    </div>
                  )}
                  <div className="field">
                    <label className="field-label">Comentarios</label>
                    <input className="input" value={editForm.comentarios || ''}
                           onChange={e => setEditForm(f => ({ ...f, comentarios: e.target.value }))} />
                  </div>
                  {editError && <div className="u-color-neg-fs-13">{editError}</div>}
                </div>
                </fieldset>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setEditMov(null)} disabled={savingEdit}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingEdit}>
                  {savingEdit ? 'Guardando…' : 'Guardar cambios'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
