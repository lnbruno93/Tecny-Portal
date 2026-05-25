import { useState, useEffect, useMemo, useRef } from 'react';
import { Icons } from '../components/Icons';
import { cuentas } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmt(n) {
  // Siempre número completo con separador de miles — ej: 30.450
  return Math.round(Math.abs(Number(n))).toLocaleString('es-AR');
}
function fmtUSD(n) { return 'USD ' + fmt(n); }
function fmtFecha(iso) {
  if (!iso) return '—';
  // Acepta 'YYYY-MM-DD' e ISO completo ('2026-05-23T03:00:00.000Z')
  const s = String(iso).slice(0, 10);
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function todayISO() { return new Date().toLocaleDateString('sv'); }

const TIPO_DISPLAY = {
  compra:             { label: 'Compra',        tone: 'neg',  signo: +1 },
  pago:               { label: 'Pago',          tone: 'pos',  signo: -1 },
  devolucion:         { label: 'Devolución',     tone: 'pos',  signo: -1 },
  parte_de_pago:      { label: 'Parte pago',     tone: 'pos',  signo: -1 },
  entrega_mercaderia: { label: 'Entrega',        tone: 'info', signo: -1 },
};
const CAT_TONE = { 'VIP': 'accent', 'A+': 'pos', 'A-': 'default' };

function Badge({ tone = 'default', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
function Status({ tone = 'default', children }) {
  return <span className={`status s-${tone}`}>{children}</span>;
}
function Seg({ value, options, onChange }) {
  return (
    <div className="seg">
      {options.map(o => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
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
    } catch (e) { setError(e.message || 'Error al guardar.'); setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
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

// ─── Datalists para desplegables de producto ─────────────────────────────────
// Se renderizan una vez fuera de la tabla y los inputs los referencian por id.

const CC_DATALISTS = (
  <>
    <datalist id="cc-dl-producto">
      <option value="iPhone" />
      <option value="MacBook Air" />
      <option value="MacBook Pro" />
      <option value="Neo" />
      <option value="AirPods" />
      <option value="Apple Watch" />
      <option value="iPad" />
      <option value="AirTag" />
      <option value="RayBan Meta" />
      <option value="Cargador" />
      <option value="SuperHub" />
      <option value="Accesorios" />
      <option value="PS 5" />
      <option value="Nintendo" />
      <option value="XBox" />
      <option value="Pencil" />
      <option value="Samsung" />
    </datalist>
    <datalist id="cc-dl-modelo">
      <option value="16 Pro Max" /><option value="16 Pro" /><option value="16 Plus" /><option value="16" />
      <option value="15 Pro Max" /><option value="15 Pro" /><option value="15 Plus" /><option value="15" />
      <option value="14 Pro Max" /><option value="14 Pro" /><option value="14 Plus" /><option value="14" />
      <option value="13 Pro Max" /><option value="13 Pro" /><option value="13" />
      <option value="SE (3ra gen)" />
      <option value="S25 Ultra" /><option value="S25+" /><option value="S25" />
      <option value="S24 Ultra" /><option value="S24+" /><option value="S24" />
      <option value="A55" /><option value="A35" /><option value="A15" />
      <option value="Pro 11 M4" /><option value="Pro 13 M4" /><option value="Air M2" />
      <option value="Air 13 M3" /><option value="Mini 7" />
    </datalist>
    <datalist id="cc-dl-tamano">
      <option value="64GB" />
      <option value="128GB" />
      <option value="256GB" />
      <option value="512GB" />
      <option value="1TB" />
      <option value="2TB" />
      <option value="825GB" />
      <option value="S/D" />
    </datalist>
    <datalist id="cc-dl-color">
      <option value="Negro" /><option value="Blanco" /><option value="Azul" />
      <option value="Rosa" /><option value="Verde" /><option value="Rojo" />
      <option value="Dorado" /><option value="Plateado" /><option value="Violeta" />
      <option value="Natural Titanium" /><option value="Desert Titanium" />
      <option value="Black Titanium" /><option value="White Titanium" />
      <option value="Grafito" /><option value="Medianoche" /><option value="Blanco Estelar" />
    </datalist>
  </>
);

// ─── INLINE ADD ROWS (planilla — 5 filas siempre visibles) ───────────────────
// Compra / Devolución → columnas de producto completas.
// Pago / Parte pago / Entrega → $ ARS ÷ TC → USD (auto-calculado).
//   · ARS + TC rellenos: USD = ARS / TC (campo USD de solo lectura, fondo verde).
//   · ARS vacío + USD directo: registra ese monto sin conversión.
// Tab en último campo → guarda y pasa a la siguiente fila.
// Enter en el campo de monto/USD → guarda esa fila.

const ROW_COUNT  = 5;
const ITEM_TIPOS = ['compra', 'devolucion'];

const mkRow = (prev = null) => ({
  _id:         Math.random().toString(36).slice(2),
  fecha:       prev?.fecha || todayISO(),
  tipo:        prev?.tipo  || 'compra',
  // Producto (solo ITEM_TIPOS)
  producto: '', modelo: '', tamano: '', color: '', imei_serial: '',
  verificado: false,
  // Monto final en USD (todos los tipos)
  monto: '',
  // Solo pagos: ARS + TC → monto se auto-calcula
  ars: '', tc: '',
});

function InlineAddRows({ clienteId, onSave, onSaveDone, onSaveError }) {
  const [rows, setRows] = useState(() => Array.from({ length: ROW_COUNT }, () => mkRow()));
  const [errs, setErrs] = useState({});

  const cr = useRef({});
  const setRef    = (i, col) => el => { cr.current[`${i}_${col}`] = el; };
  const focusCell = (i, col) => cr.current[`${i}_${col}`]?.focus();

  function upd(i, field, val) {
    setRows(rs => rs.map((r, idx) => {
      if (idx !== i) return r;
      const next = { ...r, [field]: val };
      // Cambio de tipo → limpia campos del modo anterior
      if (field === 'tipo') {
        if (ITEM_TIPOS.includes(val)) { next.ars = ''; next.tc = ''; }
        else { next.producto = ''; next.modelo = ''; next.tamano = '';
               next.color = ''; next.imei_serial = ''; next.monto = ''; }
      }
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
    const row    = rows[i];
    const isPago = !ITEM_TIPOS.includes(row.tipo);
    if (isPago && parseFloat(row.ars) > 0 && !(parseFloat(row.tc) > 0)) {
      setErrs(e => ({ ...e, [i]: 'Ingresá el tipo de cambio' })); return;
    }
    if (!row.monto || Number(row.monto) <= 0) return;

    const tempId  = `_tmp_${Date.now()}_${i}`;
    const isItem  = ITEM_TIPOS.includes(row.tipo);
    const itemData = {
      producto: row.producto || null, modelo: row.modelo || null,
      tamano: row.tamano || null,     color: row.color || null,
      imei_serial: row.imei_serial || null,
      valor: Number(row.monto),       verificado: row.verificado,
    };

    // 1. Reset inmediato → usuario puede seguir sin esperar
    setRows(rs => rs.map((r, idx) =>
      idx === i ? mkRow({ fecha: r.fecha, tipo: r.tipo }) : r
    ));
    setErrs(e => { const n = { ...e }; delete n[i]; return n; });
    setTimeout(() => focusCell((i + 1) % ROW_COUNT, 'first'), 20);

    // 2. Actualización optimista instantánea en la lista
    onSave({
      id: tempId, _pending: true,
      fecha: row.fecha, tipo: row.tipo,
      monto_total: Number(row.monto), descripcion: null, notas: null,
      items: isItem ? [{ id: `${tempId}_item`, ...itemData }] : [],
    });

    // 3. API en segundo plano — no bloquea la UI
    cuentas.createMovimiento({
      cliente_cc_id: clienteId,
      fecha: row.fecha, tipo: row.tipo, monto_total: Number(row.monto),
      items: isItem ? [itemData] : [],
    })
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
        const isPago  = !ITEM_TIPOS.includes(row.tipo);
        const autoUSD = isPago && parseFloat(row.ars) > 0 && parseFloat(row.tc) > 0;
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

            {/* Tipo */}
            <td style={{ padding: '4px 5px' }}>
              <select style={{ ...inp, cursor: 'pointer' }}
                value={row.tipo}
                onChange={e => upd(i, 'tipo', e.target.value)}>
                <option value="compra">+ Compra</option>
                <option value="pago">− Pago</option>
                <option value="devolucion">− Devolución</option>
                <option value="parte_de_pago">− Parte pago</option>
                <option value="entrega_mercaderia">− Entrega</option>
              </select>
            </td>

            {isPago ? (
              /* ── Pago: $ ARS ÷ TC → USD ──────────────────────────────── */
              <td colSpan={6} style={{ padding: '4px 12px' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>$ ARS</span>
                  <input
                    ref={setRef(i, 'first')}
                    type="number" min="0"
                    style={{ ...inp, flex: '1.6 1 0', textAlign: 'right' }}
                    placeholder="0"
                    value={row.ars}
                    onChange={e => upd(i, 'ars', e.target.value)}
                  />
                  <span style={{ color: 'var(--text-muted)', fontSize: 14, userSelect: 'none' }}>÷</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>TC</span>
                  <input
                    type="number" min="0"
                    style={{ ...inp, flex: '1 1 0', textAlign: 'right' }}
                    placeholder="1200"
                    value={row.tc}
                    onChange={e => upd(i, 'tc', e.target.value)}
                  />
                  <span style={{ color: 'var(--text-muted)', fontSize: 14, userSelect: 'none' }}>→</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--pos)', whiteSpace: 'nowrap' }}>USD</span>
                  <input
                    ref={setRef(i, 'monto')}
                    type="number" min="0"
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
                </div>
              </td>
            ) : (
              /* ── Compra / Devolución: columnas de producto ───────────── */
              <>
                <td style={{ padding: '4px 5px' }}>
                  <input ref={setRef(i, 'first')} list="cc-dl-producto" style={inp} placeholder="iPhone"
                    value={row.producto}
                    onChange={e => upd(i, 'producto', e.target.value)} />
                </td>
                <td style={{ padding: '4px 5px' }}>
                  <input list="cc-dl-modelo" style={inp} placeholder="16 Pro Max"
                    value={row.modelo}
                    onChange={e => upd(i, 'modelo', e.target.value)} />
                </td>
                <td style={{ padding: '4px 5px' }}>
                  <input list="cc-dl-tamano" style={inp} placeholder="256GB"
                    value={row.tamano}
                    onChange={e => upd(i, 'tamano', e.target.value)} />
                </td>
                <td style={{ padding: '4px 5px' }}>
                  <input list="cc-dl-color" style={inp} placeholder="Negro"
                    value={row.color}
                    onChange={e => upd(i, 'color', e.target.value)} />
                </td>
                <td style={{ padding: '4px 5px' }}>
                  <input style={{ ...inp, fontFamily: 'monospace', fontSize: 12 }}
                    placeholder="358123…"
                    value={row.imei_serial}
                    onChange={e => upd(i, 'imei_serial', e.target.value)} />
                </td>
                <td style={{ padding: '4px 5px' }}>
                  <input
                    ref={setRef(i, 'monto')}
                    type="number" min="0"
                    style={{ ...inp, textAlign: 'right', fontWeight: 700 }}
                    placeholder="0"
                    value={row.monto}
                    onChange={e => upd(i, 'monto', e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); saveRow(i); }
                      else handleLastKey(e, i);
                    }}
                  />
                </td>
              </>
            )}

            {/* Verificado */}
            <td style={{ padding: '4px 8px', textAlign: 'center' }}>
              <input type="checkbox"
                checked={row.verificado}
                onChange={e => upd(i, 'verificado', e.target.checked)}
                onKeyDown={e => handleLastKey(e, i)}
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
  provincia: '', localidad: '', direccion: '', categoria: 'A-', notas: '',
};

export default function CuentasCC() {
  const { toast } = useToast();
  const confirm   = useConfirm();

  const [tab, setTab]             = useState('clientes');
  const [catFilter, setCatFilter] = useState('todas');
  const [search, setSearch]       = useState('');
  const [clientes, setClientes]   = useState([]);
  const [selectedId, setSelectedId]       = useState(null);
  const [clienteDetail, setClienteDetail] = useState(null);
  const [rgData, setRgData]       = useState(null);
  const [loadingClientes, setLoadingClientes] = useState(true);
  const [loadingDetail, setLoadingDetail]     = useState(false);

  const [showEdit, setShowEdit]             = useState(false);
  const [showClienteModal, setShowClienteModal] = useState(false);
  const [clienteForm, setClienteForm]       = useState(EMPTY_CLIENTE);
  const [clienteCreating, setClienteCreating] = useState(false);
  const [clienteError, setClienteError]     = useState('');

  const { setPrimaryAction } = usePageActions();
  const notasTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(notasTimerRef.current), []);

  // ── Cargar lista ──
  useEffect(() => {
    setLoadingClientes(true);
    const params = {};
    if (catFilter !== 'todas') params.categoria = catFilter;
    cuentas.clientes(params)
      .then(setClientes).catch(console.error)
      .finally(() => setLoadingClientes(false));
  }, [catFilter]);

  useEffect(() => {
    if (clientes.length > 0 && !selectedId) setSelectedId(clientes[0].id);
  }, [clientes]); // eslint-disable-line

  // ── Cargar detalle ──
  useEffect(() => {
    if (!selectedId) return;
    setLoadingDetail(true);
    setClienteDetail(null);
    Promise.all([cuentas.resumen(selectedId), cuentas.movimientos(selectedId)])
      .then(([resumen, movimientos]) => setClienteDetail({ resumen, movimientos }))
      .catch(console.error)
      .finally(() => setLoadingDetail(false));
  }, [selectedId]);

  useEffect(() => {
    if (tab !== 'resumen') return;
    cuentas.resumenGeneral().then(setRgData).catch(console.error);
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
      } catch (e) { console.warn('notas autosave:', e); }
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
      });
      setClientes(prev => [nuevo, ...prev]);
      setSelectedId(nuevo.id);
      setShowClienteModal(false);
    } catch (e) { setClienteError(e.message || 'Error al crear el cliente.'); setClienteCreating(false); }
  }

  function reloadDetail() {
    if (!selectedId) return;
    setLoadingDetail(true);
    Promise.all([cuentas.resumen(selectedId), cuentas.movimientos(selectedId)])
      .then(([resumen, movimientos]) => {
        setClienteDetail({ resumen, movimientos });
        setClientes(prev => prev.map(c => c.id === selectedId ? { ...c, saldo: resumen.saldo } : c));
      })
      .catch(console.error)
      .finally(() => setLoadingDetail(false));
  }

  // ── Handlers optimistas para InlineAddRows ──────────────────────────────
  // onSave: actualización inmediata sin esperar la API
  function handleOptimisticSave(optMov) {
    const signo = TIPO_DISPLAY[optMov.tipo]?.signo ?? 1;
    const delta  = signo * Number(optMov.monto_total);
    setClienteDetail(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        movimientos: [...prev.movimientos, optMov],
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

  function catBadge(cat) {
    return <Badge tone={CAT_TONE[cat] || 'default'}>{cat}</Badge>;
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
            <div className="tabs">
              {['clientes', 'resumen'].map(t => (
                <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                  {t === 'clientes' ? 'Clientes' : 'Resumen general'}
                </button>
              ))}
            </div>
          </div>
        </div>
        {!rgData ? (
          <div className="muted" style={{ padding: '12px 0', fontSize: 13 }}>Cargando…</div>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 20 }}>
              {[
                { label: 'Deuda total · USD', val: <span className="mono neg">{fmt(rgData.total_deuda)}</span>, sub: 'clientes que nos deben' },
                { label: 'Clientes activos', val: <span className="mono">{rgData.cant_clientes}</span>, sub: 'en cuenta corriente' },
                { label: 'Crédito a favor · USD', val: <span className="mono pos">{fmt(rgData.total_credito)}</span>, sub: 'les debemos a clientes' },
                { label: 'Neto · USD', val: <span className={'mono ' + (Number(rgData.neto) >= 0 ? 'neg' : 'pos')}>{fmt(rgData.neto)}</span>, sub: Number(rgData.neto) >= 0 ? 'a cobrar (neto)' : 'a pagar (neto)' },
              ].map(k => (
                <div key={k.label} className="card card-tight" style={{ flex: 1 }}>
                  <div className="kpi-label">{k.label}</div>
                  <div className="kpi-value"><span className="muted" style={{ fontSize: 12 }}>USD </span>{k.val}</div>
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
  // Orden ASC (cronológico, como un libro mayor) para que la fila nueva quede al pie
  const movimientos = detail ? [...(detail.movimientos || [])].reverse() : [];

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
          <div className="tabs">
            {['clientes', 'resumen'].map(t => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t === 'clientes' ? 'Clientes' : 'Resumen general'}
              </button>
            ))}
          </div>
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
                  <button className="icon-btn" title="Editar cliente" onClick={() => setShowEdit(true)}>
                    <Icons.Edit size={15} />
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
              {CC_DATALISTS}
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
                  <col style={{ width: 94  }} />{/* Monto ARS    */}
                  <col style={{ width: 30  }} />{/* ✓            */}
                  <col style={{ width: 48  }} />{/* Acción       */}
                </colgroup>

                <thead>
                  <tr style={{ background: 'var(--surface-2)', position: 'sticky', top: 0, zIndex: 1 }}>
                    {['Fecha', 'Tipo', 'Producto', 'Modelo', 'Cap.', 'Color', 'IMEI / Serial', 'Monto USD', '✓', ''].map((h, i) => (
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
                      <td colSpan={10} style={{ padding: '24px 16px', color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
                        Sin movimientos — completá la fila azul para agregar el primero
                      </td>
                    </tr>
                  )}

                  {movimientos.map(m => {
                    const t    = TIPO_DISPLAY[m.tipo] || { label: m.tipo, tone: 'default', signo: 1 };
                    const item = m.items?.[0];
                    const extra = m.items?.length > 1 ? ` +${m.items.length - 1}` : '';
                    return (
                      <tr key={m.id} style={{ borderBottom: '1px solid var(--hairline)', opacity: m._pending ? 0.55 : 1 }}>
                        <td style={cell} className="muted mono">{fmtFecha(m.fecha)}</td>
                        <td style={cell}><Status tone={t.tone}>{t.label}</Status></td>
                        <td style={cell}>
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
                          <span className={t.signo > 0 ? 'neg' : 'pos'}>
                            {t.signo > 0 ? '+' : '−'}USD {fmt(m.monto_total)}
                          </span>
                        </td>
                        <td style={{ ...cell, textAlign: 'center' }}>
                          {item?.verificado
                            ? <span style={{ color: 'var(--pos)', fontSize: 14 }}>✓</span>
                            : <span className="dim" style={{ fontSize: 11 }}>—</span>}
                        </td>
                        <td style={{ padding: '7px 6px' }}>
                          {!m._pending && (
                            <button className="icon-btn" title="Eliminar" onClick={() => handleDeleteMovimiento(m.id)}>
                              <Icons.Trash size={13} />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {/* ── Fila de entrada inline ── */}
                  <InlineAddRows
                    key={selectedId}
                    clienteId={selectedId}
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
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowClienteModal(false)}>
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
    </div>
  );
}
