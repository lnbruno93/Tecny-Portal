import { useState, useEffect, useMemo, useRef } from 'react';
import { silentReport } from '../lib/reportError';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Icons } from '../components/Icons';
import { cuentas, cajas as cajasApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { useAuth } from '../contexts/AuthContext';
import { userHasCap } from '../lib/userHasCap';
import { fmt, fmtSigned, fmtFecha } from '../lib/format';
import VentaB2BModal from '../components/VentaB2BModal';
import CobranzaMasivaModal from '../components/CobranzaMasivaModal';
import MercaderiaRecibidaModal from '../components/MercaderiaRecibidaModal';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import CajaSelectHint from '../components/CajaSelectHint';
import TcWarning from '../components/TcWarning';
import Badge from '../components/Badge';
import useModal from '../lib/useModal';
import Seg from '../components/Seg';
import { RedB2BConciliacionContent } from './RedB2BConciliacion';



// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtUSD(n) { return 'USD ' + fmt(n); }
function todayISO() { return new Date().toLocaleDateString('sv'); }

const TIPO_DISPLAY = {
  compra:              { label: 'Compra',            tone: 'pos',     signo: +1 },
  // 2026-07-17: renombrado el label a "Me pagan" para dropdown inline coherente
  // con la simetría "Me pagan / Le pago" (ver debajo). El value backend sigue
  // siendo 'pago', esto es sólo el label visible al user.
  pago:                { label: 'Me pagan',          tone: 'neg',     signo: -1 },
  // tone='neg' (rojo) — la devolución reduce la venta original, visualmente
  // es una "salida". signo=-1 sigue indicando que RESTA del saldo del cliente.
  devolucion:          { label: 'Devolución',        tone: 'neg',     signo: -1 },
  parte_de_pago:       { label: 'Parte pago',        tone: 'neg',     signo: -1 },
  entrega_mercaderia:  { label: 'Entrega',           tone: 'info',    signo: -1 },
  saldo_inicial:       { label: 'Saldo inicial',     tone: 'default', signo: +1 },
  // 2026-07-17 (task #155): el cliente entrega productos que cancelan deuda.
  // Ingresa stock + baja saldo (mismo efecto contable que un pago). Tono
  // `info` para diferenciarlo visualmente del pago (rojo) — es un ingreso,
  // no una salida de dinero.
  mercaderia_recibida: { label: 'Recibí mercadería', tone: 'info',    signo: -1 },
  // 2026-07-17 (bis): NOSOTROS le damos dinero al cliente (reembolso, ajuste).
  // Sale plata de una caja (EGRESO) y sube el saldo del cliente. Tono `pos`
  // porque suma al saldo (mismo tono que compra), signo +1.
  pago_a_cliente:      { label: 'Le pago',           tone: 'pos',     signo: +1 },
};
const CAT_TONE = { 'VIP': 'accent', 'A+': 'pos', 'A-': 'default' };

// Badge y Seg ahora viven en frontend/src/components/ (U-13 dedup,
// auditoría 2026-06-10) — importados arriba.
function Status({ tone = 'default', children }) {
  return <span className={`status s-${tone}`}>{children}</span>;
}

// ─── EDITAR CLIENTE MODAL ─────────────────────────────────────────────────────

function EditarClienteModal({ cliente, onClose, onSuccess }) {
  const [form, setForm] = useState({
    nombre:      cliente.nombre      || '',
    apellido:    cliente.apellido    || '',
    contacto:    cliente.contacto    || '',
    marca_redes: cliente.marca_redes || '',
    provincia:   cliente.provincia   || '',
    localidad:   cliente.localidad   || '',
    direccion:   cliente.direccion   || '',
    categoria:   cliente.categoria   || 'A-',
    notas:       cliente.notas       || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const set = f => e => setForm(p => ({ ...p, [f]: e.target.value }));
  const editClienteModalRef = useRef(null);
  useModal({ open: true, onClose, overlayRef: editClienteModalRef });

  async function handleSave() {
    if (!form.nombre.trim()) { setError('El nombre es obligatorio.'); return; }
    setSaving(true); setError('');
    try {
      const updated = await cuentas.updateCliente(cliente.id, {
        nombre:      form.nombre.trim(),
        apellido:    form.apellido.trim()    || null,
        contacto:    form.contacto.trim()    || null,
        marca_redes: form.marca_redes.trim() || null,
        provincia:   form.provincia.trim()   || null,
        localidad:   form.localidad.trim()   || null,
        direccion:   form.direccion.trim()   || null,
        categoria:   form.categoria,
        notas:       form.notas.trim()       || null,
      });
      onSuccess(updated);
    } catch (e) {
      setError(e.message || 'Error al guardar.');
    } finally {
      // Hygiene 2026-06-22: setSaving(false) en finally. Antes solo se hacía
      // en el catch — el happy path dejaba saving=true. Como el modal se
      // cierra desde el parent (onSuccess), el botón quedaba invisible —
      // pero si por algún flujo el modal se reabría con la misma entidad
      // sin remontarse, el botón quedaba congelado en "Guardando…".
      // Mismo pattern del bug encontrado en Planes.jsx del admin-frontend.
      setSaving(false);
    }
  }

  return (
    <div ref={editClienteModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-hd">
          <h3>Editar cliente</h3>
          <button className="icon-btn" onClick={onClose}><Icons.X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="stack" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label className="field-label">Nombre <span style={{ color: 'var(--neg)' }}>*</span></label>
                <input type="text" className="input" value={form.nombre} onChange={set('nombre')} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label className="field-label">Apellido</label>
                <input type="text" className="input" value={form.apellido} onChange={set('apellido')} />
              </div>
            </div>
            <div className="row" style={{ gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label className="field-label">Contacto</label>
                <input type="text" className="input" placeholder="Tel / WhatsApp / email" value={form.contacto} onChange={set('contacto')} />
              </div>
              <div className="field" style={{ width: 100 }}>
                <label className="field-label">Categoría <span style={{ color: 'var(--neg)' }}>*</span></label>
                <select className="input" value={form.categoria} onChange={set('categoria')}>
                  <option value="VIP">VIP</option>
                  <option value="A+">A+</option>
                  <option value="A-">A-</option>
                </select>
              </div>
            </div>
            <div className="row" style={{ gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label className="field-label">Provincia</label>
                <input type="text" className="input" value={form.provincia} onChange={set('provincia')} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label className="field-label">Localidad</label>
                <input type="text" className="input" value={form.localidad} onChange={set('localidad')} />
              </div>
            </div>
            <div className="field">
              <label className="field-label">Dirección</label>
              <input type="text" className="input" value={form.direccion} onChange={set('direccion')} />
            </div>
            <div className="field">
              <label className="field-label">Redes sociales</label>
              <input type="text" className="input" placeholder="@usuario" value={form.marca_redes} onChange={set('marca_redes')} />
            </div>
            <div className="field">
              <label className="field-label">Notas internas</label>
              <input type="text" className="input" value={form.notas} onChange={set('notas')} />
            </div>
            {error && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{error}</div>}
          </div>
        </div>
        <div className="modal-ft">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancelar</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}


// ─── INLINE ADD ROWS (planilla — 5 filas siempre visibles, SOLO pagos) ──────
// Decisión (mayo-2026): las ventas (compra/devolución/entrega) se cargan por
// el modal grande "Cargar venta" con picker de stock — descuenta inventario,
// suma deuda o ingresa caja según el caso. La planilla inline queda
// dedicada SOLO a pagos rápidos del cliente:
//   - Pago / Parte pago → $ ARS ÷ TC → USD (auto-calculado).
//   - ARS + TC rellenos: USD = ARS / TC (campo USD de solo lectura, fondo verde).
//   - ARS vacío + USD directo: registra ese monto sin conversión.
//   - Caja obligatoria si querés que el ingreso impacte una caja real.
// Tab en último campo → guarda y pasa a la siguiente fila.
// Enter en el campo de monto/USD → guarda esa fila.

const ROW_COUNT  = 5;
// La planilla inline acepta SOLO pagos. Las ventas/devoluciones/entregas
// se cargan por VentaB2BModal. Por eso `producto/modelo/...` quedaron
// dead-code y se limpiaron en TANDA 4 #R-04.

const mkRow = (prev = null) => ({
  _id:         Math.random().toString(36).slice(2),
  fecha:       prev?.fecha || todayISO(),
  tipo:        prev?.tipo  || 'pago',
  // Monto final en USD (auto-calculado desde ARS ÷ TC si se llenan)
  monto: '',
  ars: '', tc: '',
  // Caja donde ingresa/sale el dinero
  caja_id: prev?.caja_id || '',
  // 2026-07-17: comentarios opcionales por movimiento — para que el user pueda
  // dejar contexto de por qué se hizo (ej: "Devolución excedente", "Cliente
  // pagó con USD y USDT"). Se envía como `notas` al backend.
  notas: '',
  // 2026-07-12 (auditoría TOTAL Financiero P1-1, Pattern G):
  // Idempotency-Key por row. Cada fila de esta planilla es un movimiento
  // independiente — si el user hace Tab dos veces por accidente sobre la
  // misma fila (doble submit), el backend devuelve la misma fila sin
  // duplicar el pago. crypto.randomUUID() es SecureContext-only; en jsdom
  // viejo o no-secure caemos al fallback random (menos seguro pero funcional
  // para dev). En prod HTTPS siempre está disponible.
  idempotency_key: (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
});

function InlineAddRows({ clienteId, cajas = [], onSave, onSaveDone, onSaveError }) {
  const [rows, setRows] = useState(() => Array.from({ length: ROW_COUNT }, () => mkRow()));
  const [errs, setErrs] = useState({});

  const cr = useRef({});
  const setRef    = (i, col) => el => { cr.current[`${i}_${col}`] = el; };
  const focusCell = (i, col) => cr.current[`${i}_${col}`]?.focus();

  function upd(i, field, val) {
    setRows(rs => rs.map((r, idx) => {
      if (idx !== i) return r;
      const next = { ...r, [field]: val };
      // Auto-calcula USD cuando cambian ARS o TC
      if (field === 'ars' || field === 'tc') {
        const ars = parseFloat(next.ars);
        const tc  = parseFloat(next.tc);
        if (ars > 0 && tc > 0) next.monto = (Math.round(ars / tc * 100) / 100).toString();
        else if (field === 'ars' && !val) next.monto = '';
      }
      return next;
    }));
    if (errs[i]) setErrs(e => { const n = { ...e }; delete n[i]; return n; });
  }

  function saveRow(i) {
    const row = rows[i];
    if (parseFloat(row.ars) > 0 && !(parseFloat(row.tc) > 0)) {
      setErrs(e => ({ ...e, [i]: 'Ingresá el tipo de cambio' }));
      // Destildar visualmente el check para que vuelva a estar disponible.
      if (row._confirming) upd(i, '_confirming', false);
      return;
    }
    if (!row.monto || Number(row.monto) <= 0) {
      // Bug 2026-06-09: antes era un return silencioso — el operador marcaba
      // el check con fila vacía y "no pasaba nada". Ahora avisamos.
      setErrs(e => ({ ...e, [i]: 'Ingresá el monto en USD (o ARS + TC)' }));
      if (row._confirming) upd(i, '_confirming', false);
      return;
    }

    const tempId  = `_tmp_${Date.now()}_${i}`;

    // 1. Reset inmediato → usuario puede seguir sin esperar
    setRows(rs => rs.map((r, idx) =>
      idx === i ? mkRow({ fecha: r.fecha, tipo: r.tipo, caja_id: r.caja_id }) : r
    ));
    setErrs(e => { const n = { ...e }; delete n[i]; return n; });
    setTimeout(() => focusCell((i + 1) % ROW_COUNT, 'first'), 20);

    const notasTrim = row.notas ? row.notas.trim() : '';
    const notasFinal = notasTrim || null;

    // 2. Actualización optimista instantánea en la lista
    onSave({
      id: tempId, _pending: true,
      fecha: row.fecha, tipo: row.tipo,
      monto_total: Number(row.monto), descripcion: null, notas: notasFinal,
      items: [], // pagos no tienen items
    });

    // 3. API en segundo plano — no bloquea la UI
    // Pattern G: pasamos idempotency_key único por row para prevenir doble
    // submit de la misma fila (ej. usuario presiona Tab dos veces por reflex).
    cuentas.createMovimiento({
      cliente_cc_id: clienteId,
      fecha: row.fecha, tipo: row.tipo, monto_total: Number(row.monto),
      caja_id: row.caja_id ? Number(row.caja_id) : null,
      notas: notasFinal,
      items: [], // pagos no tienen items
    }, row.idempotency_key)
    .then(real => onSaveDone(tempId, real))
    .catch(err  => onSaveError(tempId, err.message || 'Error al guardar'));
  }

  function handleLastKey(e, i) {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const row = rows[i];
    if (row.monto && Number(row.monto) > 0) saveRow(i);
    else focusCell((i + 1) % ROW_COUNT, 'first');
  }

  const inp = {
    padding: '4px 7px', fontSize: 13, height: 30,
    border: '1px solid var(--border)', background: 'var(--surface)',
    color: 'var(--text)', borderRadius: 5, width: '100%',
    outline: 'none', boxSizing: 'border-box',
  };

  return (
    <>
      {rows.map((row, i) => {
        // Siempre pago en esta planilla (ventas van por VentaB2BModal)
        const autoUSD = parseFloat(row.ars) > 0 && parseFloat(row.tc) > 0;
        return (
          <tr key={row._id} style={{
            background: 'rgba(99,102,241,0.04)',
            borderTop: i === 0 ? '2px solid var(--accent)' : '1px solid var(--hairline)',
          }}>

            {/* Fecha */}
            <td style={{ padding: '4px 5px' }}>
              <input type="date" style={inp}
                value={row.fecha}
                onChange={e => upd(i, 'fecha', e.target.value)} />
            </td>

            {/* Tipo — la planilla inline ya sólo carga pagos.
                  Ventas (compras/devoluciones/entregas) se hacen vía
                  "Cargar venta" arriba. */}
            <td style={{ padding: '4px 5px' }}>
              {/* 2026-07-17: labels renombrados post-Lucas request:
                    Pago       → "Me pagan" (el cliente me paga)
                    Le pago    → "pago_a_cliente" (yo le doy dinero)
                    Doy        → "entrega_mercaderia" (yo le entrego productos,
                                 abre modal en un follow-up, hoy disabled).
                  "Parte pago" (parte_de_pago) removido del dropdown por
                  simplificar — sigue soportado por backend, solo no está
                  expuesto en la planilla inline. */}
              <select style={{ ...inp, cursor: 'pointer' }}
                value={row.tipo}
                onChange={e => upd(i, 'tipo', e.target.value)}>
                <option value="pago">− Me pagan</option>
                <option value="pago_a_cliente">+ Le pago</option>
                <option value="entrega_mercaderia" disabled>− Doy (próximamente)</option>
              </select>
            </td>

            {/* Pago: $ ARS ÷ TC → USD (solo modo). Columnas Producto/Modelo/
                Cap/Color/IMEI quedan absorbidas por el colSpan. */}
            <td colSpan={6} style={{ padding: '4px 12px' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>$ ARS</span>
                  <input
                    ref={setRef(i, 'first')}
                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0"
                    style={{ ...inp, flex: '1.6 1 0', textAlign: 'right' }}
                    placeholder="0"
                    value={row.ars}
                    onChange={e => upd(i, 'ars', e.target.value)}
                  />
                  <span style={{ color: 'var(--text-muted)', fontSize: 14, userSelect: 'none' }}>÷</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>TC</span>
                  <input
                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0"
                    style={{ ...inp, flex: '1 1 0', textAlign: 'right' }}
                    placeholder="1200"
                    value={row.tc}
                    onChange={e => upd(i, 'tc', e.target.value)}
                  />
                  <span style={{ color: 'var(--text-muted)', fontSize: 14, userSelect: 'none' }}>→</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--pos)', whiteSpace: 'nowrap' }}>USD</span>
                  <input
                    ref={setRef(i, 'monto')}
                    type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0"
                    style={{
                      ...inp, flex: '1.6 1 0', textAlign: 'right', fontWeight: 700,
                      color:      autoUSD ? 'var(--pos)' : 'inherit',
                      background: autoUSD ? 'rgba(34,197,94,0.08)' : 'var(--surface)',
                    }}
                    placeholder="0"
                    value={row.monto}
                    readOnly={autoUSD}
                    onChange={e => { if (!autoUSD) upd(i, 'monto', e.target.value); }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); saveRow(i); }
                      else handleLastKey(e, i);
                    }}
                  />
                  <span style={{ color: 'var(--text-muted)', fontSize: 14, userSelect: 'none' }}>→</span>
                  <select
                    style={{ ...inp, flex: '1.4 1 0', cursor: 'pointer' }}
                    title="Caja donde ingresa el pago"
                    value={row.caja_id}
                    onChange={e => upd(i, 'caja_id', e.target.value)}>
                    <option value="">Caja (opcional)…</option>
                    {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                    <CajaSelectHint />
                  </select>
                </div>
                {/* TC warning debajo del row: solo se muestra si el TC ARS tipeado
                    está por debajo del umbral configurado en Alertas. */}
                {parseFloat(row.ars) > 0 && <TcWarning tc={row.tc} />}
              </td>

            {/* Confirmar fila — el check dispara saveRow al marcarse.
                Bug reportado 2026-06-09 (testing pre-salida): antes solo
                seteaba `row.verificado` (campo interno sin uso); el operador
                marcaba el check esperando guardar y no pasaba nada. Ahora el
                click guarda y, si saveRow tiene éxito, la fila se resetea y
                el check vuelve a falso por consecuencia. */}
            <td style={{ padding: '4px 8px', textAlign: 'center' }}>
              <input type="checkbox"
                aria-label="Confirmar y guardar fila"
                title="Confirmar pago y guardar"
                checked={!!row._confirming}
                onChange={e => {
                  if (e.target.checked) {
                    upd(i, '_confirming', true);
                    saveRow(i);
                  } else {
                    upd(i, '_confirming', false);
                  }
                }}
                onKeyDown={e => handleLastKey(e, i)}
              />
            </td>

            {/* 2026-07-17: Comentarios opcionales por movimiento */}
            <td style={{ padding: '4px 5px' }}>
              <input
                type="text"
                className="input"
                style={{ ...inp, fontSize: 12 }}
                placeholder="—"
                title="Comentarios (opcional)"
                value={row.notas || ''}
                onChange={e => upd(i, 'notas', e.target.value)}
                maxLength={1000}
              />
            </td>

            {/* Estado */}
            <td style={{ padding: '4px 5px', textAlign: 'center' }}>
              {errs[i] && <span style={{ color: 'var(--neg)', fontSize: 11 }} title={errs[i]}>⚠</span>}
            </td>
          </tr>
        );
      })}
    </>
  );
}

// ─── MAIN SCREEN ──────────────────────────────────────────────────────────────

const EMPTY_CLIENTE = {
  nombre: '', apellido: '', contacto: '', marca_redes: '',
  provincia: '', localidad: '', direccion: '', categoria: 'A-', notas: '', saldo_inicial: '',
};

export default function CuentasCC() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  // PR-X2 Red B2B: rows con cross_tenant_operation_id navegan al detalle
  // cross-tenant en /red-b2b/operaciones/:id (las rows no-cross-tenant siguen
  // sin handler — el módulo CC nunca tuvo click-to-detail tradicional).
  const navigate  = useNavigate();
  // PR-X3 Red B2B: tab "Conciliación Red B2B" sólo visible si user tiene cap
  // cross_tenant.write. Necesitamos useAuth() para el chequeo.
  const { user } = useAuth() || {};
  const canSeeRedB2B = userHasCap(user, 'cross_tenant.write');

  // PR-X3: ?tab=conciliacion abre directo el tab nuevo (desde redirect de
  // ruta legacy /red-b2b/conciliacion o desde un bookmark). ?partnership=:id
  // se delega al RedB2BConciliacionContent que abre el detalle directo.
  // Mantenemos `clientes` como default histórico para usuarios que entran
  // por sidebar.
  const tabFromUrlRaw = (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') : null);
  const initialTab = (tabFromUrlRaw === 'conciliacion' && canSeeRedB2B)
    ? 'conciliacion'
    : tabFromUrlRaw === 'resumen'
      ? 'resumen'
      : 'clientes';
  const [tab, setTab]             = useState(initialTab);
  const [catFilter, setCatFilter] = useState('todas');
  const [search, setSearch]       = useState('');
  const [clientes, setClientes]   = useState([]);
  // Deep-link desde Ventas: /cuentas?cliente=<id> abre directo ese cliente.
  // Usado por la grilla de Ventas cuando el operador edita una fila B2B.
  // PR-X3: searchParams reactivo también para el tab Conciliación Red B2B
  // (sync con ?partnership= cuando el user navega adentro del tab).
  const [searchParams, setSearchParams] = useSearchParams();

  // Helper: setear tab + sincronizar URL. Preservamos otros query params
  // (?cliente=<id>, ?partnership=<id>) — sólo tocamos 'tab' y, al salir
  // de Conciliación, limpiamos 'partnership' para no contaminar el state
  // de los otros tabs.
  function selectTab(next) {
    setTab(next);
    const sp = new URLSearchParams(searchParams);
    if (next === 'clientes') sp.delete('tab');
    else sp.set('tab', next);
    if (next !== 'conciliacion') sp.delete('partnership');
    setSearchParams(sp, { replace: true });
  }
  const initialClienteParam = searchParams.get('cliente');
  const [selectedId, setSelectedId]       = useState(initialClienteParam ? Number(initialClienteParam) : null);
  const [clienteDetail, setClienteDetail] = useState(null);
  const [rgData, setRgData]       = useState(null);
  const [loadingClientes, setLoadingClientes] = useState(true);
  const [loadingDetail, setLoadingDetail]     = useState(false);
  const [cajasUsd, setCajasUsd] = useState([]); // cajas USD/USDT para los pagos (monto en USD)
  const [clientesPag, setClientesPag] = useState({ page: 1, pages: 1, total: 0 }); // paginación del listado
  const [movsPag, setMovsPag]         = useState({ page: 1, pages: 1, total: 0 }); // paginación de movimientos
  const [loadingMasMovs, setLoadingMasMovs] = useState(false);

  // Junio 2026: Set de movimiento_id expandidos en la grilla. Cada uno muestra
  // un desglose completo con costo + precio mayorista + ganancia por item.
  const [expandedMovIds, setExpandedMovIds] = useState(() => new Set());
  const toggleExpand = (id) => {
    setExpandedMovIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const [showEdit, setShowEdit]             = useState(false);
  const [showClienteModal, setShowClienteModal] = useState(false);
  const [showVentaModal,   setShowVentaModal]   = useState(false);
  const [showCobranzaMasiva, setShowCobranzaMasiva] = useState(false);
  // 2026-07-17 (task #155) — cliente cancela deuda entregando mercadería.
  // Los items ingresan al Inventario + el saldo del cliente baja. Sólo se
  // ofrece el botón si el cliente tiene saldo distinto de 0.
  const [showMercaderiaRecibida, setShowMercaderiaRecibida] = useState(false);
  const [clienteForm, setClienteForm]       = useState(EMPTY_CLIENTE);
  const [clienteCreating, setClienteCreating] = useState(false);
  const [clienteError, setClienteError]     = useState('');
  const clienteModalRef = useRef(null);
  useModal({ open: showClienteModal, onClose: () => setShowClienteModal(false), overlayRef: clienteModalRef });

  const { setPrimaryAction } = usePageActions();
  const notasTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(notasTimerRef.current), []);

  // ── Cargar cajas (para asignar el pago a una caja USD) ──
  useEffect(() => {
    cajasApi.listCajas()
      .then(list => setCajasUsd((list || []).filter(c => c.activo !== false && (c.moneda === 'USD' || c.moneda === 'USDT'))))
      .catch(silentReport);
  }, []);

  // ── Cargar lista (paginada con "ver más") ──
  function loadClientes(page = 1, append = false) {
    setLoadingClientes(true);
    const params = { page, limit: 100 };
    if (catFilter !== 'todas') params.categoria = catFilter;
    cuentas.clientes(params)
      .then(r => {
        const data = r.data || [];
        setClientes(prev => append ? [...prev, ...data] : data);
        setClientesPag(r.pagination || { page: 1, pages: 1, total: data.length });
      })
      .catch(silentReport)
      .finally(() => setLoadingClientes(false));
  }
  useEffect(() => { loadClientes(1, false); /* eslint-disable-next-line */ }, [catFilter]);

  useEffect(() => {
    if (clientes.length > 0 && !selectedId) setSelectedId(clientes[0].id);
  }, [clientes]); // eslint-disable-line

  // ── Cargar detalle (movimientos paginados) ──
  useEffect(() => {
    if (!selectedId) return;
    setLoadingDetail(true);
    setClienteDetail(null);
    Promise.all([cuentas.resumen(selectedId), cuentas.movimientos(selectedId, { page: 1, limit: 100 })])
      .then(([resumen, movsResp]) => {
        setClienteDetail({ resumen, movimientos: movsResp.data || [] });
        setMovsPag(movsResp.pagination || { page: 1, pages: 1, total: 0 });
      })
      .catch(silentReport)
      .finally(() => setLoadingDetail(false));
  }, [selectedId]);

  // Cargar más movimientos antiguos (append)
  function loadMasMovimientos() {
    if (!selectedId || loadingMasMovs) return;
    setLoadingMasMovs(true);
    cuentas.movimientos(selectedId, { page: movsPag.page + 1, limit: 100 })
      .then(r => {
        // Guard 2026-07-05 (Sentry P2): `prev.movimientos` puede ser undefined
        // si el fetch inicial falló silenciosamente y solo populó `resumen`.
        // Sin guard, el spread tira "Cannot read properties of undefined
        // (reading 'Symbol(Symbol.iterator)')" al hacer "Ver más".
        setClienteDetail(prev => prev ? {
          ...prev,
          movimientos: [...(Array.isArray(prev.movimientos) ? prev.movimientos : []), ...(r.data || [])],
        } : prev);
        setMovsPag(r.pagination || movsPag);
      })
      .catch(silentReport)
      .finally(() => setLoadingMasMovs(false));
  }

  useEffect(() => {
    if (tab !== 'resumen') return;
    cuentas.resumenGeneral().then(setRgData).catch(silentReport);
  }, [tab]);

  const filtered = useMemo(() => {
    if (!search) return clientes;
    const q = search.toLowerCase();
    return clientes.filter(c =>
      (c.nombre + ' ' + (c.apellido || '') + ' ' + (c.contacto || '') + ' ' + (c.marca_redes || ''))
        .toLowerCase().includes(q)
    );
  }, [clientes, search]);

  // ── Notas autosave ──
  function handleNotasChange(val) {
    setClienteDetail(prev => prev ? {
      ...prev,
      resumen: { ...prev.resumen, cliente: { ...prev.resumen.cliente, notas: val } },
    } : prev);
    clearTimeout(notasTimerRef.current);
    const id = selectedId;
    notasTimerRef.current = setTimeout(async () => {
      try {
        await cuentas.updateCliente(id, { notas: val || null });
        setClientes(prev => prev.map(c => c.id === id ? { ...c, notas: val } : c));
      } catch (e) {
        // Auditoría 2026-06-30 Q-08: era console.warn silencioso.
        // Las notas son edit-by-typing con debounce 700ms: si el save falla, el
        // user creía haber guardado sin saber. Ahora reportamos a Sentry +
        // toast para que sepa reintentar (la UI ya quedó con el texto local).
        silentReport(e, { context: 'CuentasCC.notasAutosave' });
        toast.error('No pudimos guardar las notas. Revisá la conexión.');
      }
    }, 700);
  }

  useEffect(() => {
    setPrimaryAction({
      label: 'Nuevo cliente',
      onClick: () => { setClienteForm(EMPTY_CLIENTE); setClienteError(''); setShowClienteModal(true); },
    });
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]); // eslint-disable-line

  async function handleCreateCliente() {
    if (!clienteForm.nombre.trim()) { setClienteError('El nombre es obligatorio.'); return; }
    setClienteCreating(true); setClienteError('');
    try {
      const nuevo = await cuentas.createCliente({
        nombre:      clienteForm.nombre.trim(),
        apellido:    clienteForm.apellido.trim()    || null,
        contacto:    clienteForm.contacto.trim()    || null,
        marca_redes: clienteForm.marca_redes.trim() || null,
        provincia:   clienteForm.provincia.trim()   || null,
        localidad:   clienteForm.localidad.trim()   || null,
        direccion:   clienteForm.direccion.trim()   || null,
        categoria:   clienteForm.categoria,
        notas:       clienteForm.notas.trim()       || null,
        saldo_inicial: clienteForm.saldo_inicial !== '' ? Number(clienteForm.saldo_inicial) : 0,
      });
      setClientes(prev => [nuevo, ...prev]);
      setSelectedId(nuevo.id);
      setShowClienteModal(false);
    } catch (e) {
      setClienteError(e.message || 'Error al crear el cliente.');
    } finally {
      // Fix 2026-06-30: antes setClienteCreating(false) solo se llamaba en
      // el catch — el path success dejaba el flag en true. El operador
      // reportó que el modal "queda cargando" al reabrirlo (botón seguía
      // en "Creando…" porque el estado nunca se reseteó). Mover al finally
      // garantiza el reset en ambos paths.
      setClienteCreating(false);
    }
  }

  function reloadDetail() {
    if (!selectedId) return;
    setLoadingDetail(true);
    Promise.all([cuentas.resumen(selectedId), cuentas.movimientos(selectedId)])
      .then(([resumen, movimientos]) => {
        setClienteDetail({ resumen, movimientos });
        setClientes(prev => prev.map(c => c.id === selectedId ? { ...c, saldo: resumen.saldo } : c));
      })
      .catch(silentReport)
      .finally(() => setLoadingDetail(false));
  }

  // ── Handlers optimistas para InlineAddRows ──────────────────────────────
  // onSave: actualización inmediata sin esperar la API
  function handleOptimisticSave(optMov) {
    const signo = TIPO_DISPLAY[optMov.tipo]?.signo ?? 1;
    const delta  = signo * Number(optMov.monto_total);
    setClienteDetail(prev => {
      if (!prev) return prev;
      // Guard 2026-07-05 (Sentry P2): mismo motivo que loadMasMovimientos.
      const prevMovs = Array.isArray(prev.movimientos) ? prev.movimientos : [];
      return {
        ...prev,
        movimientos: [...prevMovs, optMov],
        resumen: {
          ...prev.resumen,
          saldo:            Number(prev.resumen.saldo) + delta,
          total_compras:    optMov.tipo === 'compra'
            ? Number(prev.resumen.total_compras || 0) + Number(optMov.monto_total)
            : prev.resumen.total_compras,
          cant_movimientos: (prev.resumen.cant_movimientos || 0) + 1,
        },
      };
    });
    setClientes(prev => prev.map(c =>
      c.id === selectedId ? { ...c, saldo: Number(c.saldo) + delta } : c
    ));
  }

  // onSaveDone: reemplaza el movimiento temporal con el real devuelto por la API
  function handleSaveDone(tempId, real) {
    setClienteDetail(prev => {
      if (!prev) return prev;
      // Guard 2026-07-05 (Sentry P2): mismo motivo que loadMasMovimientos.
      if (!Array.isArray(prev.movimientos)) return prev;
      return {
        ...prev,
        movimientos: prev.movimientos.map(m => m.id === tempId ? real : m),
      };
    });
  }

  // onSaveError: revierte el optimista y muestra toast
  function handleSaveError(tempId, errorMsg) {
    toast.error(errorMsg || 'Error al guardar');
    setClienteDetail(prev => {
      if (!prev) return prev;
      // Guard 2026-07-05 (Sentry P2): sin array no hay nada que revertir.
      if (!Array.isArray(prev.movimientos)) return prev;
      const failed = prev.movimientos.find(m => m.id === tempId);
      if (!failed) return prev;
      const signo = TIPO_DISPLAY[failed.tipo]?.signo ?? 1;
      const delta  = signo * Number(failed.monto_total);
      setClientes(cs => cs.map(c =>
        c.id === selectedId ? { ...c, saldo: Number(c.saldo) - delta } : c
      ));
      return {
        ...prev,
        movimientos: prev.movimientos.filter(m => m.id !== tempId),
        resumen: {
          ...prev.resumen,
          saldo:            Number(prev.resumen.saldo) - delta,
          total_compras:    failed.tipo === 'compra'
            ? Math.max(0, Number(prev.resumen.total_compras || 0) - Number(failed.monto_total))
            : prev.resumen.total_compras,
          cant_movimientos: Math.max(0, (prev.resumen.cant_movimientos || 0) - 1),
        },
      };
    });
  }

  // Devolución inline de un item del desglose B2B (PR 2026-06-09).
  // Flow: confirm con resumen → POST devolverItem → refresh detail.
  async function handleDevolverItem(movId, item) {
    const desc = [item.producto, item.imei_serial && `IMEI ${item.imei_serial}`].filter(Boolean).join(' · ') || 'este item';
    const monto = Number(item.valor || 0);
    const ok = await confirm({
      title: 'Devolver al stock',
      message: `Vas a devolver ${desc}.\n\n• Vuelve al Inventario como disponible.\n• Se descuenta USD ${monto.toLocaleString('es-AR')} del saldo del cliente.\n• El item queda tachado en el desglose para mantener la trazabilidad.\n\nNo se puede deshacer.`,
      confirmLabel: 'Devolver al stock',
      danger: true,
    });
    if (!ok) return;
    try {
      await cuentas.devolverItem(movId, item.id);
      toast.success(`Item devuelto. Stock restaurado y USD ${monto.toLocaleString('es-AR')} descontados del saldo.`);
      // Refrescar resumen + movimientos del cliente para ver tachado y saldo nuevo.
      if (selectedId) {
        const [resumen, movsResp] = await Promise.all([
          cuentas.resumen(selectedId),
          cuentas.movimientos(selectedId, { page: 1, limit: 100 }),
        ]);
        setClienteDetail({ resumen, movimientos: movsResp.data || [] });
      }
    } catch (e) {
      toast.error(e.message || 'No se pudo devolver el item.');
    }
  }

  function handleEditSuccess(updated) {
    setShowEdit(false);
    setClientes(prev => prev.map(c => c.id === updated.id ? { ...c, ...updated } : c));
    setClienteDetail(prev => prev ? {
      ...prev,
      resumen: { ...prev.resumen, cliente: { ...prev.resumen.cliente, ...updated } },
    } : prev);
    toast.success('Cliente actualizado.');
  }

  async function handleDeleteMovimiento(movId) {
    const ok = await confirm({ title: 'Eliminar movimiento', message: 'Esta acción no se puede deshacer.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await cuentas.deleteMovimiento(movId);
      reloadDetail();
      toast.success('Movimiento eliminado.');
    } catch (e) { toast.error(e.message); }
  }

  // Soft-delete del cliente B2B con cascada en backend (2026-06-09): cancela
  // todos sus movimientos vivos, restaura stock y revierte caja en la misma
  // TX. ANTES de la confirmación, traemos el preview con números concretos
  // para que el operador sepa exactamente qué va a pasar — la copia previa
  // ("histórico queda guardado") era engañosa y llevó a Lucas a borrar
  // iConnect el 2026-06-09 esperando que el stock vuelva.
  async function handleDeleteCliente() {
    const cli = clienteDetail?.resumen?.cliente;
    if (!cli) return;
    let preview;
    try {
      preview = await cuentas.deleteClientePreview(cli.id);
    } catch (e) {
      toast.error(e.message || 'No se pudo cargar el preview.');
      return;
    }
    const nombre = [cli.nombre, cli.apellido].filter(Boolean).join(' ');
    const lineas = [
      `Esta acción no se puede deshacer.`,
      ``,
      preview.movimientos_a_cancelar > 0
        ? `Al borrar el cliente se van a cancelar AUTOMÁTICAMENTE en la misma operación:`
        : `Este cliente no tiene movimientos vivos: solo se borra la ficha.`,
    ];
    if (preview.movimientos_a_cancelar > 0) {
      lineas.push(`• ${preview.movimientos_a_cancelar} movimiento(s) B2B`);
      if (preview.productos_a_restaurar > 0) {
        lineas.push(`• ${preview.productos_a_restaurar} producto(s) volverán al stock`);
      }
      if (preview.caja_a_revertir_usd > 0) {
        lineas.push(`• USD ${preview.caja_a_revertir_usd.toLocaleString('es-AR')} se revertirán de las cajas`);
      }
    }
    const ok = await confirm({
      title: `Eliminar cliente "${nombre}"`,
      message: lineas.join('\n'),
      confirmLabel: 'Eliminar cliente',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await cuentas.deleteCliente(cli.id);
      const cascade = r?.cascade;
      if (cascade?.movimientos_cancelados > 0) {
        toast.success(`Cliente eliminado. Se cancelaron ${cascade.movimientos_cancelados} movs y se restauraron ${cascade.productos_restaurados} productos.`);
      } else {
        toast.success('Cliente eliminado.');
      }
      setClientes(prev => prev.filter(c => c.id !== cli.id));
      setSelectedId(null);
      setClienteDetail(null);
    } catch (e) { toast.error(e.message); }
  }

  function catBadge(cat) {
    return <Badge tone={CAT_TONE[cat] || 'default'}>{cat}</Badge>;
  }

  // ════════════════════════════════════════════════════════
  // CONCILIACIÓN RED B2B (PR-X3 #465)
  // ════════════════════════════════════════════════════════
  // Tab nuevo: vista de saldos cruzados por partnership. El partnership
  // activo se lee de ?partnership=<id> (deep-link desde redirect de la
  // ruta legacy o desde un Click en la lista). Las acciones de seleccionar
  // / volver se delegan al Content vía callbacks que mutan el query param.
  if (tab === 'conciliacion' && canSeeRedB2B) {
    const partnershipParam = searchParams.get('partnership') || null;
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">Venta & Gestión B2B</h1>
            <div className="page-sub">Conciliación bilateral con partners Red B2B</div>
          </div>
          <div className="page-actions">
            <RedB2BTabsBar tab={tab} canSeeRedB2B={canSeeRedB2B} onSelect={selectTab} />
          </div>
        </div>
        <RedB2BConciliacionContent
          partnershipId={partnershipParam}
          onSelectPartnership={(id) => {
            const sp = new URLSearchParams(searchParams);
            sp.set('tab', 'conciliacion');
            sp.set('partnership', String(id));
            setSearchParams(sp, { replace: false });
          }}
          onClearPartnership={() => {
            const sp = new URLSearchParams(searchParams);
            sp.set('tab', 'conciliacion');
            sp.delete('partnership');
            setSearchParams(sp, { replace: false });
          }}
        />
      </div>
    );
  }

  // ════════════════════════════════════════════════════════
  // RESUMEN GENERAL
  // ════════════════════════════════════════════════════════
  if (tab === 'resumen') {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">Venta & Gestión B2B</h1>
            <div className="page-sub">Vista global de saldos B2B</div>
          </div>
          <div className="page-actions">
            <RedB2BTabsBar tab={tab} canSeeRedB2B={canSeeRedB2B} onSelect={selectTab} />
          </div>
        </div>
        {!rgData ? (
          <div className="muted" style={{ padding: '12px 0', fontSize: 13 }}>Cargando…</div>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 20 }}>
              {/*
                Cada KPI declara su `unit` por separado. Antes el "USD " se
                renderizaba hardcoded para TODOS los cards — incluyendo
                "Clientes activos" que es un conteo entero, no un monto.
                Fix 2026-06-30: `unit: null` en Clientes activos para que
                el prefijo solo aparezca en los KPIs monetarios. Limpiamos
                también el sufijo "· USD" del label porque ahora el unit
                ya lo indica visualmente.
              */}
              {[
                { label: 'Deuda total',     unit: 'USD', val: <span className="mono neg">{fmt(rgData.total_deuda)}</span>, sub: 'clientes que nos deben' },
                { label: 'Clientes activos', unit: null,  val: <span className="mono">{rgData.cant_clientes}</span>, sub: 'en cuenta corriente' },
                { label: 'Crédito a favor', unit: 'USD', val: <span className="mono pos">{fmt(rgData.total_credito)}</span>, sub: 'les debemos a clientes' },
                { label: 'Neto',            unit: 'USD', val: <span className={'mono ' + (Number(rgData.neto) >= 0 ? 'neg' : 'pos')}>{fmtSigned(rgData.neto)}</span>, sub: Number(rgData.neto) >= 0 ? 'a cobrar (neto)' : 'a pagar (neto)' },
              ].map(k => (
                <div key={k.label} className="card card-tight" style={{ flex: 1 }}>
                  <div className="kpi-label">{k.label}</div>
                  <div className="kpi-value">
                    {k.unit && <span className="muted" style={{ fontSize: 12 }}>{k.unit} </span>}
                    {k.val}
                  </div>
                  <div className="muted tiny" style={{ marginTop: 6 }}>{k.sub}</div>
                </div>
              ))}
            </div>
            <div className="card card-flush">
              <div className="card-hd"><h3>Top 10 deudores</h3></div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>#</th><th>Cliente</th><th>Categoría</th>
                    <th className="num">Saldo</th><th style={{ width: 120 }}>Proporción</th>
                  </tr>
                </thead>
                <tbody>
                  {(rgData.top_deudores || []).map((c, i) => {
                    const pct = Math.min(100, Math.round((Number(c.saldo) / (Number(rgData.total_deuda) || 1)) * 100));
                    return (
                      <tr key={c.id} className="tbl-row-click"
                        onClick={() => { setSelectedId(c.id); setTab('clientes'); }}>
                        <td className="muted mono">{String(i + 1).padStart(2, '0')}</td>
                        <td><div style={{ fontWeight: 600 }}>{c.nombre} {c.apellido}</div></td>
                        <td>{catBadge(c.categoria)}</td>
                        <td className="num mono neg" style={{ fontWeight: 700 }}>USD {fmt(c.saldo)}</td>
                        <td>
                          <div className="bar-track" style={{ height: 6 }}><div className="bar-fill" style={{ width: pct + '%' }} /></div>
                          <div className="muted tiny mono" style={{ marginTop: 3, textAlign: 'right' }}>{pct}%</div>
                        </td>
                      </tr>
                    );
                  })}
                  {!rgData.top_deudores?.length && <tr><td colSpan={5} className="empty">Sin deudores</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════
  // CLIENTES TAB — layout spreadsheet
  // ════════════════════════════════════════════════════════

  const detail      = clienteDetail;
  const cliente     = detail?.resumen?.cliente || null;
  const resumen     = detail?.resumen || null;
  // Orden ASC (cronológico, como un libro mayor) para que la fila nueva quede al pie.
  //
  // Defensive Array.isArray() 2026-07-08 (Sentry #7587853566): antes usábamos
  // `detail.movimientos || []`, que asume que `movimientos` es array o falsy.
  // Sentry registró 3 crashes con "(Xe.movimientos || []) is not iterable" —
  // el fallback `|| []` NO protege cuando el valor es `{}` u otro objeto no-
  // array (un objeto vacío es truthy → se retorna tal cual → `[...{}]`
  // explota porque los objetos planos no tienen Symbol.iterator).
  //
  // Se dispara si el backend responde con un shape inesperado (ej. body de
  // error `{}` en vez del payload normal) — el frontend debe degradar a lista
  // vacía en vez de tumbar el ErrorBoundary.
  const movimientos = detail && Array.isArray(detail.movimientos)
    ? [...detail.movimientos].reverse()
    : [];

  // Estilo de celda en tabla existente
  const cell = { padding: '7px 8px', fontSize: 13 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Page head */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Venta & Gestión B2B</h1>
          <div className="page-sub">Clientes B2B · registro tipo planilla</div>
        </div>
        <div className="page-actions">
          <RedB2BTabsBar tab={tab} canSeeRedB2B={canSeeRedB2B} onSelect={selectTab} />
          <button className="btn" onClick={() => setShowCobranzaMasiva(true)}>
            <Icons.Dollar size={14} /> Cobranza masiva
          </button>
          <button className="btn btn-primary"
            onClick={() => { setClienteForm(EMPTY_CLIENTE); setClienteError(''); setShowClienteModal(true); }}>
            <Icons.Plus size={14} /> Nuevo cliente
          </button>
        </div>
      </div>

      {/* Split layout */}
      <div style={{
        display: 'grid', gridTemplateColumns: '240px 1fr',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 12, overflow: 'hidden', flex: 1, minHeight: 580,
      }}>

        {/* ── Sidebar ── */}
        <div style={{ borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
            <div className="input-group" style={{ marginBottom: 8 }}>
              <span className="addon addon-l"><Icons.Search size={13} /></span>
              <input className="input" placeholder="Buscar…" value={search}
                onChange={e => setSearch(e.target.value)} />
            </div>
            <Seg
              value={catFilter}
              options={[
                { value: 'todas', label: 'Todas' },
                { value: 'VIP',   label: 'VIP'   },
                { value: 'A+',    label: 'A+'    },
                { value: 'A-',    label: 'A-'    },
              ]}
              onChange={val => { setCatFilter(val); setSelectedId(null); }}
            />
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {loadingClientes ? (
              <div className="empty">Cargando…</div>
            ) : filtered.length === 0 ? (
              <div className="empty">Sin resultados</div>
            ) : filtered.map((c, i) => (
              <div key={c.id} onClick={() => setSelectedId(c.id)} style={{
                padding: '10px 13px',
                borderBottom: i < filtered.length - 1 ? '1px solid var(--hairline)' : 0,
                cursor: 'pointer',
                background: selectedId === c.id ? 'var(--surface-2)' : 'transparent',
                borderLeft: selectedId === c.id ? '3px solid var(--accent)' : '3px solid transparent',
              }}>
                <div className="flex-between" style={{ marginBottom: 3 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{c.nombre} {c.apellido || ''}</div>
                  {catBadge(c.categoria)}
                </div>
                {(c.localidad || c.provincia) && (
                  <div className="muted tiny" style={{ marginBottom: 3 }}>
                    {c.localidad}{c.provincia ? ', ' + c.provincia : ''}
                  </div>
                )}
                <div className="mono" style={{
                  fontSize: 13, fontWeight: 700,
                  color: Number(c.saldo) > 0 ? 'var(--neg)' : Number(c.saldo) < 0 ? 'var(--pos)' : 'var(--text-muted)',
                }}>
                  {Number(c.saldo) !== 0 ? fmtUSD(c.saldo) : 'Sin saldo'}
                </div>
              </div>
            ))}
            {!loadingClientes && clientesPag.page < clientesPag.pages && (
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', margin: '8px 0' }}
                onClick={() => loadClientes(clientesPag.page + 1, true)}>
                Ver más clientes ({clientes.length} de {clientesPag.total})
              </button>
            )}
          </div>
        </div>

        {/* ── Panel derecho ── */}
        {loadingDetail ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Cargando…
          </div>
        ) : !cliente ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Seleccioná un cliente
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>

            {/* ── Header del cliente con KPIs inline ── */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div className="flex-between" style={{ marginBottom: 8 }}>
                {/* Nombre e info */}
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>
                    {cliente.nombre} {cliente.apellido || ''}
                    {' '}{catBadge(cliente.categoria)}
                  </div>
                  {(cliente.contacto || cliente.marca_redes) && (
                    <div className="muted tiny" style={{ marginTop: 2 }}>
                      {[cliente.contacto, cliente.marca_redes].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>

                {/* KPIs compactos + botón editar */}
                <div className="flex-row" style={{ gap: 20, alignItems: 'flex-start' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div className="muted tiny">Saldo</div>
                    <div className={'mono ' + (Number(resumen.saldo) > 0 ? 'neg' : Number(resumen.saldo) < 0 ? 'pos' : 'muted')}
                      // data-testid agregado para E2E (TANDA 5 B2B): después
                      // de cargar la venta el spec assertea que el saldo del
                      // cliente sea -650 (deuda). Múltiples nodos en la página
                      // pueden matchear "USD 650"; el testid lo desambigüa.
                      data-testid="b2b-cliente-saldo"
                      style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.1 }}>
                      USD {fmt(resumen.saldo)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="muted tiny">Total comprado</div>
                    <div className="mono" style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.1 }}>
                      USD {fmt(resumen.total_compras || 0)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="muted tiny">Movimientos</div>
                    <div className="mono" style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.1 }}>
                      {resumen.cant_movimientos || 0}
                    </div>
                  </div>
                  {/* 2026-07-17 (task #155): "Recibí mercadería" — el cliente
                      cancela deuda O adelanta stock a cuenta entregando productos
                      (van al stock + baja el saldo). Siempre visible: cubre
                      también el caso "cliente nuevo que ya me entregó algo antes
                      de deberme" (decisión de Lucas post-merge PR #652). */}
                  <button className="btn btn-sm" onClick={() => setShowMercaderiaRecibida(true)}
                          title="El cliente te entrega productos — entran al stock y bajan su saldo">
                    <Icons.Box size={13} /> Recibí mercadería
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={() => setShowVentaModal(true)}>
                    <Icons.Plus size={13} /> Cargar venta
                  </button>
                  <button className="icon-btn" title="Editar cliente" onClick={() => setShowEdit(true)}>
                    <Icons.Edit size={15} />
                  </button>
                  <button className="icon-btn" title="Eliminar cliente" onClick={handleDeleteCliente}
                    style={{ color: 'var(--neg)' }}>
                    <Icons.Trash size={15} />
                  </button>
                </div>
              </div>

              {/* Notas inline */}
              <input
                type="text"
                className="input"
                placeholder="Notas internas (se guarda solo)…"
                value={cliente.notas || ''}
                onChange={e => handleNotasChange(e.target.value)}
                style={{ fontSize: 12.5, height: 30 }}
              />
            </div>

            {/* ── Tabla spreadsheet ── */}
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
              <table style={{
                width: '100%', borderCollapse: 'collapse',
                tableLayout: 'fixed', minWidth: 860,
                fontSize: 13,
              }}>
                <colgroup>
                  <col style={{ width: 88  }} />{/* Fecha        */}
                  <col style={{ width: 108 }} />{/* Tipo         */}
                  <col style={{ width: 90  }} />{/* Producto     */}
                  <col style={{ width: 130 }} />{/* Modelo       */}
                  <col style={{ width: 66  }} />{/* Cap.         */}
                  <col style={{ width: 76  }} />{/* Color        */}
                  <col style={{ width: 130 }} />{/* IMEI/Serial  */}
                  <col style={{ width: 94  }} />{/* Monto USD    */}
                  <col style={{ width: 30  }} />{/* ✓            */}
                  <col style={{ width: 150 }} />{/* Comentarios  */}
                  <col style={{ width: 48  }} />{/* Acción       */}
                </colgroup>

                <thead>
                  <tr style={{ background: 'var(--surface-2)', position: 'sticky', top: 0, zIndex: 1 }}>
                    {['Fecha', 'Tipo', 'Detalle', 'Modelo', 'Cap.', 'Color', 'IMEI / Serial', 'Monto USD', '✓', 'Comentarios', ''].map((h, i) => (
                      <th key={i} style={{
                        padding: '7px 8px', fontSize: 11, fontWeight: 700,
                        letterSpacing: '0.06em', textTransform: 'uppercase',
                        color: 'var(--text-muted)', textAlign: i === 7 ? 'right' : 'left',
                        borderBottom: '1px solid var(--border)',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {/* Movimientos existentes (ASC — cronológico) */}
                  {movimientos.length === 0 && !loadingDetail && (
                    <tr>
                      <td colSpan={11} style={{ padding: '24px 16px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
                        Sin movimientos — completá la fila azul para agregar el primero
                      </td>
                    </tr>
                  )}

                  {movimientos.map(m => {
                    const t    = TIPO_DISPLAY[m.tipo] || { label: m.tipo, tone: 'default', signo: 1 };
                    const item = m.items?.[0];
                    const nItems = m.items?.length || 0;
                    const extra = nItems > 1 ? ` +${nItems - 1}` : '';
                    // Junio 2026: fila expandible con desglose completo cuando hay
                    // >1 item — permite ver TODOS los productos vendidos en una
                    // venta B2B con costo, precio mayorista y ganancia por unidad.
                    const isExpanded = expandedMovIds.has(m.id);
                    const canExpand = nItems > 1;
                    // PR-X2 Red B2B: rows generadas por una operación cross-tenant
                    // (F3+) muestran un badge "RED B2B" y al click navegan al
                    // detalle de la operación cross-tenant (que tiene el contexto
                    // completo: partner, pagos multidivisa, historial). Para rows
                    // normales B2B no cambia nada — siguen sin click handler.
                    const isCrossTenant = m.cross_tenant_operation_id != null;
                    const handleRowClick = isCrossTenant
                      ? (e) => {
                          // Ignorar clicks que vengan de un botón dentro de la fila
                          // (Trash, chevron de expand) para no pisar sus handlers.
                          if (e.target.closest && e.target.closest('button')) return;
                          navigate(`/red-b2b/operaciones/${m.cross_tenant_operation_id}`);
                        }
                      : undefined;
                    return (
                      <>
                      <tr
                        key={m.id}
                        onClick={handleRowClick}
                        data-testid={isCrossTenant ? `mov-row-cross-tenant-${m.id}` : undefined}
                        style={{
                          borderBottom: isExpanded ? 'none' : '1px solid var(--hairline)',
                          opacity: m._pending ? 0.55 : 1,
                          cursor: isCrossTenant ? 'pointer' : undefined,
                        }}
                      >
                        <td style={cell} className="muted mono">{fmtFecha(m.fecha)}</td>
                        <td style={cell}>
                          <Status tone={t.tone}>{t.label}</Status>
                          {isCrossTenant && (
                            <Badge tone="info" style={{ marginLeft: 6, fontSize: 10 }}>RED B2B</Badge>
                          )}
                        </td>
                        <td style={cell}>
                          {canExpand && (
                            <button
                              onClick={() => toggleExpand(m.id)}
                              aria-label={isExpanded ? 'Ocultar desglose' : 'Ver desglose'}
                              title={isExpanded ? 'Ocultar desglose' : 'Ver desglose'}
                              style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                marginRight: 6, padding: 0, verticalAlign: 'middle',
                              }}
                            >
                              <Icons.ChevronRight size={12}
                                style={{ transform: isExpanded ? 'rotate(90deg)' : 'none',
                                         transition: 'transform .15s' }} />
                            </button>
                          )}
                          {item?.producto
                            ? <>{item.producto}<span className="muted tiny">{extra}</span></>
                            : (m.descripcion || <span className="dim">—</span>)
                          }
                        </td>
                        <td style={{ ...cell, color: 'var(--text-2)' }}>
                          {item?.modelo || <span className="dim">—</span>}
                        </td>
                        <td style={{ ...cell, color: 'var(--text-2)' }}>
                          {item?.tamano || <span className="dim">—</span>}
                        </td>
                        <td style={{ ...cell, color: 'var(--text-2)' }}>
                          {item?.color || <span className="dim">—</span>}
                        </td>
                        <td style={{ ...cell, fontFamily: 'monospace', fontSize: 12 }}>
                          {item?.imei_serial || <span className="dim">—</span>}
                        </td>
                        <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>
                          <span className={t.tone === 'neg' ? 'neg' : 'pos'}>
                            {t.signo > 0 ? '+' : '−'}USD {fmt(m.monto_total)}
                          </span>
                        </td>
                        <td style={{ ...cell, textAlign: 'center' }}>
                          {item?.verificado
                            ? <span style={{ color: 'var(--pos)', fontSize: 14 }}>✓</span>
                            : <span className="dim" style={{ fontSize: 11 }}>—</span>}
                        </td>
                        {/* 2026-07-17: columna Comentarios */}
                        <td style={{ ...cell, color: 'var(--text-2)', fontSize: 12 }}
                            title={m.notas || ''}>
                          {m.notas
                            ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', whiteSpace: 'nowrap' }}>{m.notas}</span>
                            : <span className="dim">—</span>}
                        </td>
                        <td style={{ padding: '7px 6px' }}>
                          {!m._pending && (
                            <button className="icon-btn" title="Eliminar" onClick={() => handleDeleteMovimiento(m.id)}>
                              <Icons.Trash size={13} />
                            </button>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${m.id}-detail`} style={{ borderBottom: '1px solid var(--hairline)' }}>
                          <td colSpan={11} style={{ padding: '4px 12px 12px 36px', background: 'var(--surface-2, rgba(0,0,0,0.02))' }}>
                            <MovimientoDesglose mov={m} onDevolverItem={handleDevolverItem} />
                          </td>
                        </tr>
                      )}
                      </>
                    );
                  })}

                  {movsPag.page < movsPag.pages && (
                    <tr>
                      <td colSpan={11} style={{ textAlign: 'center', padding: '8px' }}>
                        <button className="btn btn-ghost btn-sm" onClick={loadMasMovimientos} disabled={loadingMasMovs}>
                          {loadingMasMovs ? 'Cargando…' : `Ver movimientos más antiguos (${movimientos.length} de ${movsPag.total})`}
                        </button>
                      </td>
                    </tr>
                  )}

                  {/* ── Fila de entrada inline ── */}
                  <InlineAddRows
                    key={selectedId}
                    clienteId={selectedId}
                    cajas={cajasUsd}
                    onSave={handleOptimisticSave}
                    onSaveDone={handleSaveDone}
                    onSaveError={handleSaveError}
                  />
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Editar cliente */}
      {showEdit && cliente && (
        <EditarClienteModal cliente={cliente} onClose={() => setShowEdit(false)} onSuccess={handleEditSuccess} />
      )}

      {/* Nuevo cliente */}
      {showClienteModal && (
        <div ref={clienteModalRef} className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowClienteModal(false)}>
          <div className="modal" style={{ maxWidth: 520 }}>
            <div className="modal-hd">
              <h3>Nuevo cliente</h3>
              <button className="icon-btn" onClick={() => setShowClienteModal(false)}><Icons.X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="stack" style={{ gap: 12 }}>
                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Nombre <span style={{ color: 'var(--neg)' }}>*</span></label>
                    <input type="text" className="input" placeholder="Ej: Juan"
                      value={clienteForm.nombre} onChange={e => setClienteForm(f => ({ ...f, nombre: e.target.value }))} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Apellido</label>
                    <input type="text" className="input" placeholder="Ej: García"
                      value={clienteForm.apellido} onChange={e => setClienteForm(f => ({ ...f, apellido: e.target.value }))} />
                  </div>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Contacto</label>
                    <input type="text" className="input" placeholder="Teléfono / WhatsApp / email"
                      value={clienteForm.contacto} onChange={e => setClienteForm(f => ({ ...f, contacto: e.target.value }))} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Categoría <span style={{ color: 'var(--neg)' }}>*</span></label>
                    <select className="input" value={clienteForm.categoria}
                      onChange={e => setClienteForm(f => ({ ...f, categoria: e.target.value }))}>
                      <option value="VIP">VIP</option>
                      <option value="A+">A+</option>
                      <option value="A-">A-</option>
                    </select>
                  </div>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Provincia</label>
                    <input type="text" className="input" placeholder="Ej: Buenos Aires"
                      value={clienteForm.provincia} onChange={e => setClienteForm(f => ({ ...f, provincia: e.target.value }))} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label">Localidad</label>
                    <input type="text" className="input" placeholder="Ej: Lanús"
                      value={clienteForm.localidad} onChange={e => setClienteForm(f => ({ ...f, localidad: e.target.value }))} />
                  </div>
                </div>
                <div className="field">
                  <label className="field-label">Dirección</label>
                  <input type="text" className="input" placeholder="Ej: Av. Rivadavia 1234"
                    value={clienteForm.direccion} onChange={e => setClienteForm(f => ({ ...f, direccion: e.target.value }))} />
                </div>
                <div className="field">
                  <label className="field-label">Redes sociales</label>
                  <input type="text" className="input" placeholder="@juangarcia"
                    value={clienteForm.marca_redes} onChange={e => setClienteForm(f => ({ ...f, marca_redes: e.target.value }))} />
                </div>
                <div className="field">
                  <label className="field-label">Notas internas</label>
                  <input type="text" className="input" placeholder="Ej: cobra los viernes"
                    value={clienteForm.notas} onChange={e => setClienteForm(f => ({ ...f, notas: e.target.value }))} />
                </div>
                <div className="field">
                  <label className="field-label">Saldo inicial · USD <span className="muted">(opcional)</span></label>
                  <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01" className="input mono" placeholder="0"
                    value={clienteForm.saldo_inicial} onChange={e => setClienteForm(f => ({ ...f, saldo_inicial: e.target.value }))} />
                  <div className="muted tiny" style={{ marginTop: 3 }}>Si el cliente ya nos debe algo, arrancá su cuenta con ese saldo.</div>
                </div>
                {clienteError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{clienteError}</div>}
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-ghost" onClick={() => setShowClienteModal(false)} disabled={clienteCreating}>Cancelar</button>
              <button className="btn btn-primary" onClick={handleCreateCliente} disabled={clienteCreating}>
                {clienteCreating ? 'Guardando…' : 'Crear cliente'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Cobranza Masiva (N pagos en bloque) ── */}
      {showCobranzaMasiva && (
        <CobranzaMasivaModal
          onClose={() => setShowCobranzaMasiva(false)}
          onSaved={() => {
            setShowCobranzaMasiva(false);
            // Refrescar lista de clientes (saldos actualizados) y detalle del seleccionado
            cuentas.clientes(catFilter !== 'todas' ? { categoria: catFilter } : {})
              .then(r => setClientes(r.data || []))
              .catch(() => {});
            if (selectedId) {
              Promise.all([cuentas.resumen(selectedId), cuentas.movimientos(selectedId, { page: 1, limit: 100 })])
                .then(([resumen, movsResp]) => {
                  setClienteDetail({ resumen, movimientos: movsResp.data || [] });
                  setMovsPag(movsResp.pagination || { page: 1, pages: 1, total: 0 });
                })
                .catch(() => {});
            }
          }}
        />
      )}

      {/* ── Modal Cargar Venta B2B (spreadsheet con picker de stock) ── */}
      {showVentaModal && cliente && (
        <VentaB2BModal
          cliente={cliente}
          onClose={() => setShowVentaModal(false)}
          onSaved={() => {
            setShowVentaModal(false);
            // Refrescar detalle + saldo en la lista
            if (selectedId) {
              Promise.all([cuentas.resumen(selectedId), cuentas.movimientos(selectedId, { page: 1, limit: 100 })])
                .then(([resumen, movsResp]) => {
                  setClienteDetail({ resumen, movimientos: movsResp.data || [] });
                  setMovsPag(movsResp.pagination || { page: 1, pages: 1, total: 0 });
                  setClientes(prev => prev.map(c => c.id === selectedId ? { ...c, saldo: resumen.saldo } : c));
                })
                .catch(() => {});
            }
          }}
        />
      )}

      {/* ── Modal Recibí mercadería (task #155, 2026-07-17) ── */}
      {showMercaderiaRecibida && cliente && (
        <MercaderiaRecibidaModal
          cliente={cliente}
          saldoActual={Number(resumen.saldo || 0)}
          onClose={() => setShowMercaderiaRecibida(false)}
          onSaved={() => {
            setShowMercaderiaRecibida(false);
            if (selectedId) {
              Promise.all([cuentas.resumen(selectedId), cuentas.movimientos(selectedId, { page: 1, limit: 100 })])
                .then(([resumen, movsResp]) => {
                  setClienteDetail({ resumen, movimientos: movsResp.data || [] });
                  setMovsPag(movsResp.pagination || { page: 1, pages: 1, total: 0 });
                  setClientes(prev => prev.map(c => c.id === selectedId ? { ...c, saldo: resumen.saldo } : c));
                })
                .catch(() => {});
            }
          }}
        />
      )}
    </div>
  );
}

// PR-X3 #465 — Barra de tabs reutilizable para CuentasCC.
// Renderea Clientes / Resumen + opcional Conciliación Red B2B (sólo si el
// user tiene cap cross_tenant.write). DRY: la usamos en los 3 returns
// (clientes, resumen, conciliacion) para no duplicar el markup.
function RedB2BTabsBar({ tab, canSeeRedB2B, onSelect }) {
  const tabs = [
    { id: 'clientes', label: 'Clientes' },
    { id: 'resumen',  label: 'Resumen general' },
  ];
  if (canSeeRedB2B) tabs.push({ id: 'conciliacion', label: 'Conciliación Red B2B' });
  return (
    <div className="tabs">
      {tabs.map(t => (
        <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => onSelect(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// MovimientoDesglose — sub-tabla con TODOS los items de un movimiento. Muestra
// costo + precio mayorista + ganancia por unidad. Para ventas pre-migración
// (costo_unit NULL) muestra "—" con un asterisco "histórico, sin dato".
//
// Junio 2026 (devolución inline): cada fila tiene botón ↺ que devuelve ese
// item al stock. El item devuelto queda TACHADO + badge "↺ Devuelto" en su
// lugar (no se elimina) para preservar trazabilidad visual de la venta. El
// callback `onDevolverItem(movId, item)` lo maneja el padre.
function MovimientoDesglose({ mov, onDevolverItem }) {
  const items = mov.items || [];
  if (items.length === 0) return <div className="muted" style={{ fontSize: 12 }}>Sin items.</div>;

  const fmtMoney = (n) => (Number(n) || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 });
  // Solo permitimos devolver items de movimientos tipo 'compra'. Backend
  // valida igual — esto evita mostrar botón en un mov de devolución.
  const movEsCompra = mov.tipo === 'compra';

  // Totales: items devueltos NO suman (criterio contable — el monto neto
  // vigente de la venta baja con cada devolución).
  let totalVenta = 0, totalCosto = 0, hayHistoricos = false, hayDevueltos = false;
  items.forEach(it => {
    if (it.devuelto_at) { hayDevueltos = true; return; }
    totalVenta += Number(it.valor) || 0;
    if (it.costo_unit != null) totalCosto += Number(it.costo_unit) * Number(it.cantidad || 1);
    else hayHistoricos = true;
  });
  const totalGanancia = totalVenta - totalCosto;

  return (
    <div>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--hairline)' }}>
            <th style={{ textAlign: 'left',  padding: '6px 8px' }}>Producto</th>
            <th style={{ textAlign: 'left',  padding: '6px 8px' }}>IMEI / Serial</th>
            <th style={{ textAlign: 'left',  padding: '6px 8px' }}>Var.</th>
            <th style={{ textAlign: 'right', padding: '6px 8px' }}>Cant.</th>
            <th style={{ textAlign: 'right', padding: '6px 8px' }}>Costo unit.</th>
            <th style={{ textAlign: 'right', padding: '6px 8px' }}>P. mayorista unit.</th>
            <th style={{ textAlign: 'right', padding: '6px 8px' }}>Subtotal</th>
            <th style={{ textAlign: 'right', padding: '6px 8px' }}>Ganancia</th>
            {movEsCompra && <th style={{ textAlign: 'center', padding: '6px 8px', width: 56 }}>↺</th>}
          </tr>
        </thead>
        <tbody>
          {items.map(it => {
            const cant = Number(it.cantidad) || 1;
            const valor = Number(it.valor) || 0;
            const precioUnit = cant > 0 ? valor / cant : 0;
            const costoUnit = it.costo_unit != null ? Number(it.costo_unit) : null;
            const ganancia = costoUnit != null ? valor - costoUnit * cant : null;
            const devuelto = !!it.devuelto_at;
            const puedeDevolver = movEsCompra && !devuelto && it.producto_id;
            // Items devueltos: tachado + fondo rojo tenue. La fila SIGUE en el
            // DOM para que el operador vea qué se devolvió de esta venta.
            const rowStyle = {
              borderBottom: '1px solid var(--hairline)',
              ...(devuelto && {
                textDecoration: 'line-through',
                color: 'var(--text-muted)',
                background: 'rgba(255, 107, 107, 0.06)',
              }),
            };
            return (
              <tr key={it.id} style={rowStyle}>
                <td style={{ padding: '6px 8px' }}>
                  {it.producto || <span className="dim">—</span>}
                  {devuelto && (
                    <span style={{
                      marginLeft: 8, padding: '1px 6px', borderRadius: 4,
                      background: 'var(--neg)', color: 'white', fontSize: 10,
                      textDecoration: 'none', fontWeight: 600, verticalAlign: 'middle',
                    }}>↺ Devuelto</span>
                  )}
                </td>
                <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 11 }}>{it.imei_serial || <span className="dim">—</span>}</td>
                <td style={{ padding: '6px 8px' }} className="muted tiny">
                  {[it.tamano, it.color].filter(Boolean).join(' · ') || '—'}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{cant}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace' }}>
                  {costoUnit != null ? `USD ${fmtMoney(costoUnit)}` : <span className="dim" title="Venta pre-migración — sin dato de costo histórico">—*</span>}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace' }}>
                  USD {fmtMoney(precioUnit)}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                  USD {fmtMoney(valor)}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600,
                             color: devuelto ? 'var(--text-muted)' : ganancia == null ? 'var(--text-muted)' : ganancia >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
                  {ganancia != null ? `${ganancia >= 0 ? '+' : ''}USD ${fmtMoney(ganancia)}` : '—'}
                </td>
                {movEsCompra && (
                  <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                    {puedeDevolver ? (
                      <button
                        className="icon-btn"
                        title="Devolver este item al stock (resta del saldo del cliente)"
                        onClick={() => onDevolverItem && onDevolverItem(mov.id, it)}
                        style={{ color: 'var(--warn, #f59e0b)', fontSize: 14 }}
                      >↺</button>
                    ) : devuelto ? null : (
                      <span className="dim tiny" title="Sin producto del Inventario — no se puede devolver">—</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--border)' }}>
            <td colSpan={6} style={{ padding: '8px', textAlign: 'right', fontWeight: 700 }}>
              Totales{hayDevueltos ? ' (sin devueltos)' : ''}:
            </td>
            <td style={{ padding: '8px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace' }}>
              USD {fmtMoney(totalVenta)}
            </td>
            <td style={{ padding: '8px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace',
                         color: hayHistoricos ? 'var(--text-muted)' : totalGanancia >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
              {hayHistoricos
                ? <span title="Algunos items pre-migración no tienen costo histórico — ganancia parcial">USD {fmtMoney(totalGanancia)}*</span>
                : `${totalGanancia >= 0 ? '+' : ''}USD ${fmtMoney(totalGanancia)}`}
            </td>
            {movEsCompra && <td></td>}
          </tr>
        </tfoot>
      </table>
      {hayHistoricos && (
        <div className="muted tiny" style={{ marginTop: 6, fontStyle: 'italic' }}>
          * Items pre-migración sin dato de costo histórico — la ganancia mostrada es parcial.
        </div>
      )}
    </div>
  );
}
