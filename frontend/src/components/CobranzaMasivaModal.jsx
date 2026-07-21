/**
 * Modal "Cobranza masiva" — registra N pagos de distintos clientes en bloque.
 *
 * Flujo típico: fin de mes, varios clientes mayoristas pagan parte o todo
 * lo que deben. En lugar de abrir el modal de pago N veces, se carga TODO
 * en una planilla y se guarda en una sola TX.
 *
 * Reglas:
 *   - Cada fila tiene su cliente, monto, caja y TC (si la caja no es USD).
 *   - Si el monto supera el saldo del cliente → alerta ámbar pero permite
 *     guardar (sobrepago = cliente queda con saldo a favor).
 *   - Si algo falla (cliente inválido, caja inválida) → rollback total.
 *   - Cliente picker filtra por saldo > 0 por defecto, toggle "Mostrar
 *     todos" para incluir saldo = 0 (parte_de_pago anticipado).
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import useModal from '../lib/useModal'; // U2 auditoría 2026-06
import { Icons } from './Icons';
import { cuentas as cuentasApi, cajas as cajasApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmModal';
import AutocompletePicker from './AutocompletePicker';
import { cellInp, headerTh as th, catalogosErrorBanner } from '../lib/spreadsheetStyles';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #M-11
import useSpreadsheetRows from '../lib/useSpreadsheetRows'; // #F-5
import TcWarning from './TcWarning';
import CajaSelectHint from './CajaSelectHint';


function todayISO() { return new Date().toLocaleDateString('sv'); }

const INITIAL_ROWS = 8;
const ADD_BATCH    = 5;

const mkRow = (defaults = {}) => ({
  _id: Math.random().toString(36).slice(2),
  cliente_id: null,
  cliente_nombre: '',
  saldo_actual: null,    // del backend al elegir cliente
  monto: '',
  caja_id: defaults.caja_id || '',
  tc:      defaults.tc      || '',
  tipo:    'pago',
});

const isUsedRow = (r) => !!(r.cliente_id || r.cliente_nombre?.trim() || Number(r.monto) > 0);

export default function CobranzaMasivaModal({ onClose, onSaved }) {
  const { toast } = useToast();
  const confirm = useConfirm();

  // #B-09: confirm-on-close si hay data cargada
  async function tryClose() {
    const usadas = rows.filter(isUsedRow).length;
    if (usadas === 0) return onClose();
    const ok = await confirm({
      title: 'Cerrar sin guardar',
      message: `Vas a perder ${usadas} cobranza${usadas > 1 ? 's' : ''} cargada${usadas > 1 ? 's' : ''}. ¿Seguro?`,
      confirmLabel: 'Cerrar y perder cambios',
      danger: true,
    });
    if (ok) onClose();
  }

  // ── Cabecera (defaults aplicados a filas nuevas) ────────────────────
  const [fecha, setFecha]       = useState(todayISO());
  const [cajaDefault, setCD]    = useState('');
  const [tcDefault,   setTCD]   = useState('');

  // ── Planilla ─────────────────────────────────────────────────────────
  // #F-5: state + handlers comunes vienen del hook (R-01). applyDefaultsToEmpty
  // se mantiene custom porque acá solo afecta caja_id/tc, no la fila completa.
  const { rows, setRows, updCell, removeRow } = useSpreadsheetRows({
    mkRow,
    isUsedRow,
    initialCount: INITIAL_ROWS,
    addBatch: ADD_BATCH,
  });

  // ── Catálogos ────────────────────────────────────────────────────────
  // #P-05: solo cajas se carga al abrir. Los clientes se buscan por demanda
  // vía endpoint /clientes/search en el ClientePicker.
  const [cajas,    setCajas]    = useState([]);
  const [showZero, setShowZero] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [catalogosError, setCatalogosError] = useState(null);

  useEffect(() => {
    cajasApi.listCajas()
      .then(r => setCajas((r || []).filter(c => c.activo !== false)))
      .catch(() => { setCajas([]); setCatalogosError(['cajas']); });
  }, []);

  const totalUsd = useMemo(() => {
    return rows.reduce((acc, r) => {
      if (!isUsedRow(r) || !Number(r.monto)) return acc;
      const caja = cajas.find(c => String(c.id) === String(r.caja_id));
      const moneda = caja?.moneda || 'USD';
      if (moneda === 'USD') return acc + Number(r.monto);
      const tcN = Number(r.tc);
      if (!tcN) return acc;
      return acc + Number(r.monto) / tcN;
    }, 0);
  }, [rows, cajas]);

  // ── Handlers ─────────────────────────────────────────────────────────
  // updCell / removeRow vienen del hook. addRows va custom porque siempre
  // mete defaults runtime (caja + tc). applyDefaultsToEmpty también custom
  // (merge semantics propio).
  function pickCliente(idx, c) {
    setRows(rs => rs.map((r, i) => i !== idx ? r : {
      ...r,
      cliente_id: c.id,
      cliente_nombre: [c.nombre, c.apellido].filter(Boolean).join(' '),
      saldo_actual: Number(c.saldo || 0),
    }));
  }
  function clearCliente(idx) {
    setRows(rs => rs.map((r, i) => i !== idx ? r : {
      ...r, cliente_id: null, saldo_actual: null,
    }));
  }
  function addRows(n = ADD_BATCH) {
    setRows(rs => [...rs, ...Array.from({ length: n }, () => mkRow({ caja_id: cajaDefault, tc: tcDefault }))]);
  }
  // #M-10: solo pisar campos vacíos/falsy de filas no-usadas. Antes el
  // spread escribía caja_id/tc aunque el usuario los hubiera tipeado
  // en una fila sin cliente todavía, perdiendo trabajo silenciosamente.
  function applyDefaultsToEmpty() {
    setRows(rs => rs.map(r => {
      if (isUsedRow(r)) return r;
      const merged = { ...r };
      if (merged.caja_id === '' || merged.caja_id == null) merged.caja_id = cajaDefault;
      if (merged.tc      === '' || merged.tc      == null) merged.tc      = tcDefault;
      return merged;
    }));
  }

  function validar() {
    if (!fecha) return 'Falta la fecha';
    const used = rows.filter(isUsedRow);
    if (used.length === 0) return 'Cargá al menos una cobranza';
    for (let i = 0; i < used.length; i++) {
      const r = used[i];
      if (!r.cliente_id) return `Fila ${i + 1}: elegí el cliente`;
      if (!Number(r.monto) || Number(r.monto) <= 0) return `Fila ${i + 1}: cargá el monto`;
      if (!r.caja_id) return `Fila ${i + 1}: elegí caja`;
      const caja = cajas.find(c => String(c.id) === String(r.caja_id));
      const moneda = caja?.moneda || 'USD';
      if (moneda !== 'USD' && (!Number(r.tc) || Number(r.tc) <= 0))
        return `Fila ${i + 1}: caja ${moneda}, cargá el TC`;
    }
    return null;
  }

  async function handleGuardar() {
    const err = validar();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const used = rows.filter(isUsedRow);
      const payload = {
        cobranzas: used.map(r => {
          const caja = cajas.find(c => String(c.id) === String(r.caja_id));
          const moneda = caja?.moneda || 'USD';
          return {
            cliente_cc_id: Number(r.cliente_id),
            fecha,
            monto: Number(r.monto),
            moneda,
            tc: moneda === 'USD' ? null : Number(r.tc),
            caja_id: Number(r.caja_id),
            tipo: r.tipo,
            descripcion: null,
          };
        }),
      };
      const res = await cuentasApi.cobranzaMasiva(payload);
      toast.success(`Cobranza masiva guardada · ${res.creados} pagos · USD ${totalUsd.toLocaleString('es-AR', { maximumFractionDigits: 2 })}`);
      onSaved?.(res);
      onClose();
    } catch (e) {
      // El backend manda detalles cuando hay refs inválidas
      const msg = e.message || 'No se pudo guardar';
      toast.error(msg.length > 200 ? msg.slice(0, 200) + '…' : msg);
    } finally {
      setSaving(false);
    }
  }

  // U2 auditoría 2026-06: useModal aplicado.
  const overlayRef = useRef(null);
  useModal({ open: true, onClose: tryClose, overlayRef });

  // Estilos compartidos vienen de lib/spreadsheetStyles
  return (
    <div ref={overlayRef} className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cobranza-masiva-modal-title"
         onClick={(e) => { if (e.target === e.currentTarget) tryClose(); }}>
      <div className="modal" style={{ maxWidth: 1400, width: '96vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <h3 id="cobranza-masiva-modal-title">Cobranza masiva</h3>
          <button className="icon-btn" onClick={tryClose} aria-label="Cerrar modal"><Icons.X size={16} /></button>
        </div>

        <div className="modal-body" style={{ maxHeight: '82vh', overflowY: 'auto' }}>
          {/* #H-12: banner si catálogos fallaron */}
          {catalogosError && (
            <div style={catalogosErrorBanner}>
              ⚠ No se pudieron cargar: <strong>{catalogosError.join(', ')}</strong>.
              Cerrá/abrí el modal después de revisar tu conexión.
            </div>
          )}
          {/* ── Cabecera + defaults ── */}
          <div className="row u-mb-12">
            <div className="field" style={{ flex: '0 0 150px' }}>
              <label className="field-label">Fecha</label>
              <input type="date" className="input" value={fecha} onChange={e => setFecha(e.target.value)} />
            </div>
            <div className="field u-flex-1">
              <label className="field-label">Caja por defecto</label>
              <select className="input" value={cajaDefault} onChange={e => setCD(e.target.value)}>
                <option value="">— Sin default —</option>
                {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>)}
                <CajaSelectHint />
              </select>
            </div>
            <div className="field" style={{ flex: '0 0 140px' }}>
              <label className="field-label">TC por defecto</label>
              <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01" className="input mono"
                value={tcDefault} onChange={e => setTCD(e.target.value)} placeholder="0" />
              <TcWarning tc={tcDefault} />
            </div>
            <div className="field" style={{ flex: '0 0 140px', alignSelf: 'flex-end' }}>
              <button className="btn btn-sm btn-ghost u-w-100" onClick={applyDefaultsToEmpty}
                title="Aplica los defaults a las filas aún vacías">
                Aplicar a vacías
              </button>
            </div>
          </div>

          {/* ── Acciones de la planilla ── */}
          <div className="flex-between u-mb-8">
            <div className="u-fs-13-fw-600">
              Cobranzas · {rows.filter(isUsedRow).length} usadas / {rows.length} filas
            </div>
            <div className="flex-row" style={{ gap: 6, alignItems: 'center' }}>
              <label className="flex-row" style={{ gap: 6, fontSize: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={showZero} onChange={e => setShowZero(e.target.checked)} />
                Mostrar todos los clientes (incluso saldo 0)
              </label>
              <button className="btn btn-sm" onClick={() => addRows(ADD_BATCH)}>
                + {ADD_BATCH} filas
              </button>
            </div>
          </div>

          {/* ── Planilla ── */}
          {/* 2026-06-24 mobile lote C: planilla con minWidth 1200 (~9 columnas).
              Hint visible solo en mobile para indicar scroll horizontal. */}
          <div className="bulk-spreadsheet-hint">↔ Desliza horizontalmente para ver todas las columnas</div>
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1200, tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: 32 }} />   {/* # */}
                <col style={{ width: 280 }} />  {/* Cliente */}
                <col style={{ width: 100 }} />  {/* Saldo */}
                <col style={{ width: 110 }} />  {/* Monto */}
                <col style={{ width: 200 }} />  {/* Caja */}
                <col style={{ width: 90 }} />   {/* TC */}
                <col style={{ width: 110 }} />  {/* Subtotal USD */}
                <col style={{ width: 110 }} />  {/* Tipo */}
                <col style={{ width: 36 }} />   {/* X */}
              </colgroup>
              <thead>
                <tr>
                  {['#','Cliente *','Saldo','Monto *','Caja *','TC','Subtotal USD','Tipo',''].map((h, i) =>
                    <th key={i} style={{ ...th, textAlign: i === 0 ? 'center' : 'left' }}>{h}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const used = isUsedRow(r);
                  const caja = cajas.find(c => String(c.id) === String(r.caja_id));
                  const moneda = caja?.moneda || 'USD';
                  const needsTc = r.caja_id && moneda !== 'USD';
                  const subUsd  = Number(r.monto) > 0
                    ? (moneda === 'USD' ? Number(r.monto) : (Number(r.tc) > 0 ? Number(r.monto) / Number(r.tc) : 0))
                    : 0;
                  const sobrepago = r.saldo_actual != null && subUsd > 0 && subUsd > r.saldo_actual;
                  const diferencia = sobrepago ? (subUsd - r.saldo_actual).toFixed(2) : 0;
                  return (
                    // data-testid agregado para E2E (TANDA 5 cobranza masiva):
                    // la planilla arranca con 8 filas vacías; el spec scopea cada
                    // fila por índice (nth(0), nth(1)) para no acoplarse al
                    // texto del cliente o al placeholder.
                    <tr key={r._id} data-testid="cobranza-row" style={{
                      background: used ? 'rgba(99,102,241,0.04)' : 'transparent',
                      borderTop: '1px solid var(--hairline)',
                    }}>
                      <td style={{ padding: '3px 6px', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>{idx + 1}</td>
                      <td style={{ padding: '3px 4px' }}>
                        <ClientePicker
                          value={r.cliente_nombre}
                          locked={!!r.cliente_id}
                          showZero={showZero}
                          onPick={c => pickCliente(idx, c)}
                          onClear={() => clearCliente(idx)}
                          onChange={v => updCell(idx, 'cliente_nombre', v)}
                          cellInp={cellInp}
                        />
                      </td>
                      <td style={{ padding: '3px 4px', textAlign: 'right', fontSize: 12 }}>
                        {r.saldo_actual != null
                          ? <span className={r.saldo_actual > 0 ? 'neg' : r.saldo_actual < 0 ? 'pos' : 'muted'} className="u-fw-600">
                              USD {r.saldo_actual.toLocaleString('es-AR', { maximumFractionDigits: 2 })}
                            </span>
                          : <span className="dim">—</span>}
                      </td>
                      <td style={{ padding: '3px 4px' }}>
                        <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" style={{ ...cellInp, textAlign: 'right', fontWeight: 700,
                          borderColor: sobrepago ? 'var(--warn, #d97706)' : 'var(--border)',
                        }}
                          value={r.monto} placeholder="0"
                          onChange={e => updCell(idx, 'monto', e.target.value)} />
                      </td>
                      <td style={{ padding: '3px 4px' }}>
                        <select style={{ ...cellInp, cursor: 'pointer' }} value={r.caja_id}
                          onChange={e => updCell(idx, 'caja_id', e.target.value)}>
                          <option value="">—</option>
                          {cajas.map(c => <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>)}
                          <CajaSelectHint />
                        </select>
                      </td>
                      <td style={{ padding: '3px 4px' }}>
                        {needsTc ? (
                          <>
                            <input type="number" onKeyDown={blockInvalidNumberKeys} min="0" step="0.01" style={{ ...cellInp, textAlign: 'right' }}
                              value={r.tc} placeholder={moneda}
                              onChange={e => updCell(idx, 'tc', e.target.value)} />
                            <TcWarning tc={r.tc} />
                          </>
                        ) : <span className="dim" style={{ fontSize: 11, paddingLeft: 6 }}>—</span>}
                      </td>
                      <td style={{ padding: '3px 4px', textAlign: 'right', fontSize: 12, fontWeight: 600 }}>
                        {subUsd > 0 ? (
                          <div>
                            <div>USD {subUsd.toLocaleString('es-AR', { maximumFractionDigits: 2 })}</div>
                            {sobrepago && <div style={{ fontSize: 10, color: 'var(--warn, #d97706)' }}>+a favor USD {diferencia}</div>}
                          </div>
                        ) : <span className="dim">—</span>}
                      </td>
                      <td style={{ padding: '3px 4px' }}>
                        <select style={{ ...cellInp, cursor: 'pointer' }} value={r.tipo}
                          onChange={e => updCell(idx, 'tipo', e.target.value)}>
                          <option value="pago">Pago</option>
                          <option value="parte_de_pago">Parte pago</option>
                        </select>
                      </td>
                      <td style={{ padding: '3px 4px', textAlign: 'center' }}>
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

          {/* ── Total ── */}
          <div className="flex-row" style={{ marginTop: 12, justifyContent: 'flex-end', alignItems: 'center', gap: 16 }}>
            <div className="u-text-right">
              <div className="muted tiny">Total cobrado</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 800 }}>
                {/* #M-13: guion en vez de "USD 0" cuando no hay filas usadas. */}
                {rows.filter(isUsedRow).length === 0
                  ? <span className="muted">—</span>
                  : <>USD {totalUsd.toLocaleString('es-AR', { maximumFractionDigits: 2 })}</>}
              </div>
            </div>
          </div>
        </div>

        <div className="modal-ft">
          <button className="btn btn-ghost" onClick={tryClose}>Cancelar</button>
          <button className="btn btn-primary" data-testid="cobranza-submit"
            disabled={saving} onClick={handleGuardar}>
            {saving ? 'Guardando…' : `Guardar cobranzas (${rows.filter(isUsedRow).length})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Cliente Picker ──────────────────────────────────────────────────────
// #P-05 + #R-03: usa el endpoint /api/cuentas/clientes/search y se monta
// sobre AutocompletePicker genérico. Antes era ~120 líneas casi idénticas
// al ProductoPicker.
const CLIENTE_SEARCH_LIMIT = 15;
function ClientePicker({ value, locked, showZero, onPick, onClear, onChange, cellInp }) {
  const fetchOptions = (q) =>
    cuentasApi.clientesSearch(q, !showZero).then(res => res.data || []);
  return (
    <AutocompletePicker
      value={value} onChange={onChange}
      locked={locked} onClear={onClear} onPick={onPick}
      fetchOptions={fetchOptions}
      getOptionKey={(c) => c.id}
      placeholder="Buscar cliente…"
      emptyText={showZero ? 'Sin coincidencias' : 'Sin coincidencias con deuda'}
      limit={CLIENTE_SEARCH_LIMIT}
      cellInp={cellInp}
      renderOption={(c) => {
        const saldo = Number(c.saldo || 0);
        const tono = saldo > 0 ? 'neg' : saldo < 0 ? 'pos' : 'muted';
        return (
          <>
            <div className="u-fw-600">
              {[c.nombre, c.apellido].filter(Boolean).join(' ')}
              {c.categoria && <span className="muted tiny" style={{ marginLeft: 6 }}>· {c.categoria}</span>}
            </div>
            <div className={`tiny ${tono}`}>Saldo USD {saldo.toLocaleString('es-AR', { maximumFractionDigits: 2 })}</div>
          </>
        );
      }}
    />
  );
}
