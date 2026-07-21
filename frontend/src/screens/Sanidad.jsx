// Sanidad del Negocio (feature 2026-06-23) — V2 refactor.
//
// V1 metía 30 recurrentes × 12 meses en una sola tabla — ruido visual y
// hard de leer. V2 separa la pantalla en dos secciones:
//
//   1. RESUMEN MENSUAL (arriba): tabla compacta de 5 filas × N meses con
//      solo totales: Bruto / Gastos / Neto / Neto diario. La idea es que
//      mires la sanidad en un vistazo.
//
//   2. MIS GASTOS PROYECTADOS (abajo, en panel desplegable): donde Lucas
//      gestiona su lista de recurrentes — el equivalente a su sheet con
//      "Detalle | Monto $ ARS | Monto USD". Reusa los endpoints CRUD de
//      egresos.recurrentes que ya existen.
//
// El "Total gastos proyectado" de la tabla de arriba sale de la suma de
// los recurrentes que se editan abajo. Cuando Lucas agrega/edita/borra un
// gasto en el panel desplegable, refrescamos el dashboard.

import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import { Icons } from '../components/Icons';
import { sanidad as sanidadApi, egresos as egresosApi } from '../lib/api';
import { fmt } from '../lib/format';
import useModal from '../lib/useModal';
// 2026-06-29 Multi-país F3: dropdown moneda del recurrente gated por país.
import { useMonedasTenant } from '../lib/useMonedasTenant';
// 2026-06-30 Auditoría F-01 (P0): useConfirm reemplaza window.confirm() en
// el delete de recurrentes (línea 387 antes). El nativo bloquea el thread,
// ignora dark mode y se ve mal en mobile — el resto del portal (28+ screens)
// usa el design system. Mantener la inconsistencia rompía UX en una
// operación destructiva (gastos recurrentes proyectados).
import { useConfirm } from '../components/ConfirmModal';

// Helper: nombre del mes corto a partir de 'YYYY-MM'.
function labelMes(periodo) {
  const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const [y, m] = periodo.split('-').map(Number);
  return `${meses[m - 1]} ${String(y).slice(2)}`;
}

// Helper: clase CSS de color para desvío. `isGasto=true` invierte la lógica
// (gastar menos es bueno).
function desvio(real, proyectado, isGasto = false) {
  if (real == null || proyectado == null || proyectado === 0) return '';
  const ratio = real / proyectado;
  if (isGasto) {
    if (ratio <= 1.0) return 'sanidad-pos';
    if (ratio > 1.1)  return 'sanidad-neg';
    return 'sanidad-warn';
  } else {
    if (ratio >= 1.0) return 'sanidad-pos';
    if (ratio < 0.9)  return 'sanidad-neg';
    return 'sanidad-warn';
  }
}

// Variación porcentual mes-a-mes (proy vs proy del mes anterior, idem real).
// Devuelve un número (positivo = subió, negativo = bajó) o null si no se
// puede calcular (sin mes anterior, o anterior = 0).
function variacionPct(actual, anterior) {
  if (actual == null || anterior == null) return null;
  if (Math.abs(Number(anterior)) < 0.01) return null;
  return ((Number(actual) - Number(anterior)) / Math.abs(Number(anterior))) * 100;
}

// Conversión a USD para un recurrente que tiene monto+moneda+tc (mirror
// del helper backend lib/money.js toUsd — replicado acá porque la pantalla
// recibe los recurrentes "raw" del CRUD endpoint y necesita mostrar el USD
// equivalente sin esperar al refresh del dashboard).
//
// 2026-07-08 Multi-país F2: antes solo cubría ARS → un tenant UY veía USD 0
// para todos sus recurrentes UYU (aunque en DB tuvieran tc>0 válido), y los
// subtotales/total del panel quedaban subestimados. `MONEDAS_CON_TC` es
// mirror del backend `schemas/_common.js` (mantener alineado si se agrega
// una nueva fiat local en el futuro).
const MONEDAS_CON_TC = ['ARS', 'UYU'];
function montoUsd(monto, moneda, tc) {
  const m = Number(monto) || 0;
  if (moneda === 'USD' || moneda === 'USDT') return m;
  if (MONEDAS_CON_TC.includes(moneda) && tc && Number(tc) > 0) return m / Number(tc);
  return 0;
}

// Render de un monto con prefijo "USD" para que cada celda tenga la misma
// "anchura visual" sin importar si el número es de 5 o 7 dígitos. El "USD"
// va con color muted — protagonista es el número, USD es contexto.
//
// Negativos (típico en Rdo Neto cuando gastos > bruto): anteponemos "−"
// al número y pintamos toda la celda en color "neg" (rojo del tema) para
// que el desvío sea inmediatamente visible. fmt() devuelve magnitud, así
// que el signo lo agregamos manualmente acá.
function MoneyCell({ value, className = '', placeholder = '—', variacion = null, isGasto = false }) {
  if (value == null) {
    return <span className="muted tiny" style={{ opacity: 0.5 }}>{placeholder}</span>;
  }
  const isNeg = Number(value) < 0;
  // Color del % según contexto: para gastos, subir es malo (rojo); para
  // bruto/neto, subir es bueno (verde). Sub-umbral 0.1% no se muestra.
  let pctClass = '';
  const showPct = variacion != null && Math.abs(variacion) >= 0.1;
  if (showPct) {
    if (isGasto) pctClass = variacion > 0 ? 'sanidad-pct-neg' : 'sanidad-pct-pos';
    else         pctClass = variacion > 0 ? 'sanidad-pct-pos' : 'sanidad-pct-neg';
  }
  return (
    <div className="u-flex-col-end-gap-2">
      <span className={'sanidad-money ' + (isNeg ? 'sanidad-money-neg ' : '') + className}>
        <span className="sanidad-money-prefix">USD</span>
        <span className="sanidad-money-amount">
          {isNeg ? '−' : ''}{fmt(value, 0)}
        </span>
      </span>
      {showPct && (
        <span className={'sanidad-pct ' + pctClass}>
          {variacion > 0 ? '+' : ''}{variacion.toFixed(1)}%
        </span>
      )}
    </div>
  );
}

// ─── Editable inline para el monto presupuestado de UN gasto recurrente en ──
// UN mes específico. Wrapper sobre BrutoProyectadoEditable que agrega:
//   · Indicador visual cuando el valor es un override (vs default del recurrente).
//   · Acción "Restaurar default" (borra el override → cae al monto base).
//
// 2026-06-24: feature de presupuesto variable por mes. El backend resuelve
// el monto efectivo (override si hay, default si no) y manda is_override +
// default_usd en el payload de cada gasto, por mes.
function GastoProyectadoCell({ periodo, recurrente_id, value, isOverride, defaultUsd, onSave, onReset }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  function startEdit() {
    setDraft(value != null ? String(value) : '');
    setEditing(true);
  }
  async function commit() {
    const n = Number(draft);
    setEditing(false);
    if (!Number.isFinite(n) || n < 0) return;
    if (n === value) return;
    // Si el user borra el valor (NaN) o lo deja igual al default → reset.
    // Si no → save override.
    if (Math.abs(n - defaultUsd) < 0.005) {
      if (isOverride) await onReset(recurrente_id, periodo);
    } else {
      await onSave(recurrente_id, periodo, n);
    }
  }
  function cancel() { setEditing(false); setDraft(''); }

  if (editing) {
    return (
      <div className="u-pos-rel">
        <input
          autoFocus
          type="number" inputMode="decimal" min="0" step="100"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
          className="input mono"
          style={{ width: '100%', maxWidth: 130, padding: '4px 8px', fontSize: 13, textAlign: 'right' }}
        />
        <div className="muted" style={{ fontSize: 9, marginTop: 2, textAlign: 'right' }}>
          default USD {fmt(defaultUsd, 0)}
        </div>
      </div>
    );
  }
  return (
    <button
      type="button" onClick={startEdit}
      title={isOverride
        ? `Override del default (USD ${fmt(defaultUsd, 0)}). Click para editar, dejá en el default para restaurar.`
        : 'Click para editar el monto de este mes (no afecta los demás meses)'}
      className="sanidad-edit-cell"
      style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        padding: '2px 6px', borderRadius: 4, textAlign: 'right', width: '100%',
        font: 'inherit', color: 'inherit',
        position: 'relative',
      }}
    >
      <div className="u-flex-col-end-gap-2">
        <span className="sanidad-money u-fs-13">
          <span className="sanidad-money-prefix">USD</span>
          <span className="sanidad-money-amount">{fmt(value, 0)}</span>
          {isOverride && (
            <span
              title="Este mes tiene un monto distinto al default del recurrente"
              style={{
                marginLeft: 4, fontSize: 8, verticalAlign: 'super',
                color: 'var(--accent)', fontWeight: 700,
              }}
            >●</span>
          )}
        </span>
      </div>
    </button>
  );
}

// ─── Editable inline para el Bruto proyectado de un mes ──────────────────────
function BrutoProyectadoEditable({ periodo, value, onSave, variacion = null, isGasto = false }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState('');

  function startEdit() {
    setDraft(value != null ? String(value) : '');
    setEditing(true);
  }
  async function commit() {
    const n = Number(draft);
    setEditing(false);
    if (!Number.isFinite(n) || n < 0) return;
    if (n !== value) await onSave(periodo, n);
  }
  function cancel() { setEditing(false); setDraft(''); }

  if (editing) {
    return (
      <input
        autoFocus
        type="number" inputMode="decimal" min="0" step="100"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter')  { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        className="input mono"
        // 110px max → 130px max para que 999.999 entre sin clipping.
        style={{ width: '100%', maxWidth: 130, padding: '4px 8px', fontSize: 14, textAlign: 'right' }}
      />
    );
  }
  return (
    <button
      type="button" onClick={startEdit} title="Click para editar" className="sanidad-edit-cell"
      style={{
        background:'transparent', border:'none', cursor:'pointer',
        padding:'2px 6px', borderRadius:4, textAlign:'right', width:'100%',
        // CRÍTICO: font:inherit — los <button> tienen estilos default del
        // browser (weight, family, color) que rompen la consistencia con
        // las cells normales. Heredamos TODO de la celda padre para que
        // "USD 10.000" del Bruto editable se renderee exactamente igual
        // a "USD 27.775" del Gastos no-editable.
        font: 'inherit',
        color: 'inherit',
      }}
    >
      {value != null
        ? (() => {
            // Mismo render que MoneyCell: USD + monto + (opcional) % de variación.
            const showPct = variacion != null && Math.abs(variacion) >= 0.1;
            const pctClass = showPct
              ? (isGasto
                  ? (variacion > 0 ? 'sanidad-pct-neg' : 'sanidad-pct-pos')
                  : (variacion > 0 ? 'sanidad-pct-pos' : 'sanidad-pct-neg'))
              : '';
            return (
              <div className="u-flex-col-end-gap-2">
                <span className="sanidad-money">
                  <span className="sanidad-money-prefix">USD</span>
                  <span className="sanidad-money-amount">{fmt(value, 0)}</span>
                </span>
                {showPct && (
                  <span className={'sanidad-pct ' + pctClass}>
                    {variacion > 0 ? '+' : ''}{variacion.toFixed(1)}%
                  </span>
                )}
              </div>
            );
          })()
        : <span className="muted tiny" style={{ opacity: 0.6 }}>+ cargar</span>}
    </button>
  );
}

// ─── Panel "Mis gastos proyectados" — CRUD inline + agrupación por categoría ──
function ProyeccionGastosPanel({ onChange }) {
  const [recurrentes, setRecurrentes] = useState([]);
  const [categorias, setCategorias]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  // F-01: confirm imperativo (modal del design system, no el nativo del browser).
  const confirmAsk = useConfirm();
  // Grupos expandidos (accordion). Set de keys (categoria_id || 'sin').
  // Default vacío: todos colapsados — el usuario ve el resumen y abre
  // solo lo que le interesa.
  const [expanded, setExpanded] = useState(() => new Set());

  function toggleGroup(key) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Form draft: incluye categoria_id (null = sin categorizar).
  const emptyDraft = { concepto: '', monto: '', moneda: 'USD', tc: '', categoria_id: '' };
  const [draft, setDraft] = useState(emptyDraft);

  async function load() {
    setLoading(true);
    setError('');
    try {
      // Carga paralela: recurrentes + categorías.
      const [rows, cats] = await Promise.all([
        egresosApi.recurrentes(),
        egresosApi.categorias(),
      ]);
      setRecurrentes(rows.filter(r => r.activo && !r.deleted_at));
      setCategorias(cats);
    } catch (err) {
      setError(err?.message || 'No pudimos cargar tus gastos proyectados.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  function startAdd() {
    setDraft(emptyDraft);
    setAdding(true);
    setEditingId(null);
  }
  function startEdit(r) {
    setDraft({
      concepto: r.concepto,
      monto:    String(r.monto),
      moneda:   r.moneda,
      tc:       r.tc != null ? String(r.tc) : '',
      categoria_id: r.categoria_id != null ? String(r.categoria_id) : '',
    });
    setEditingId(r.id);
    setAdding(false);
    // Auto-expandir el grupo del ítem que estoy editando (si está colapsado
    // no veo el input). Si su categoría está cargada, expando esa; sino, 'sin'.
    const groupKey = r.categoria_id == null ? 'sin' : r.categoria_id;
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(groupKey);
      return next;
    });
  }
  function cancel() {
    setAdding(false);
    setEditingId(null);
    setDraft(emptyDraft);
  }

  function validate() {
    if (!draft.concepto.trim()) return 'Falta el concepto.';
    const m = Number(draft.monto);
    if (!Number.isFinite(m) || m < 0) return 'Monto inválido.';
    // 2026-07-08 Multi-país F2: antes solo pedía TC para ARS. Ahora también
    // UYU (tenants UY). Mensaje incluye la moneda concreta para claridad.
    if (MONEDAS_CON_TC.includes(draft.moneda)) {
      const tc = Number(draft.tc);
      if (!Number.isFinite(tc) || tc <= 0) {
        return `Para gastos en ${draft.moneda} necesitamos el TC para pasar a USD.`;
      }
    }
    return null;
  }

  async function save() {
    const err = validate();
    if (err) { setError(err); return; }
    setError('');
    const payload = {
      concepto: draft.concepto.trim(),
      monto:    Number(draft.monto),
      moneda:   draft.moneda,
      // 2026-07-08 Multi-país F2: antes forzaba tc:null para todo lo que no
      // era ARS → recurrentes UYU perdían el TC aunque el usuario lo tipeara.
      tc:       MONEDAS_CON_TC.includes(draft.moneda) ? Number(draft.tc) : null,
      categoria_id: draft.categoria_id ? Number(draft.categoria_id) : null,
      activo:   true,
    };
    try {
      if (editingId) {
        await egresosApi.updateRecurrente(editingId, payload);
      } else {
        await egresosApi.createRecurrente(payload);
      }
      cancel();
      await load();
      onChange?.();
    } catch (err) {
      setError(err?.message || 'No pudimos guardar el gasto.');
    }
  }

  async function remove(r) {
    const ok = await confirmAsk({
      title: `¿Borrar el gasto recurrente "${r.concepto}"?`,
      message: 'Los egresos pasados que ya quedaron pagados se mantienen — solo dejas de proyectarlo para los próximos meses.',
      confirmLabel: 'Borrar',
      danger: true,
    });
    if (!ok) return;
    try {
      await egresosApi.deleteRecurrente(r.id);
      await load();
      onChange?.();
    } catch (err) {
      setError(err?.message || 'No pudimos borrar.');
    }
  }

  // Crear categoría nueva inline. Se muestra como opción "+ Nueva categoría…"
  // en el dropdown del editor de un recurrente.
  async function createCategoria(nombre) {
    const n = (nombre || '').trim();
    if (!n) return null;
    try {
      const newCat = await egresosApi.createCategoria({ nombre: n });
      setCategorias((prev) => [...prev, newCat].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')));
      return newCat.id;
    } catch (err) {
      setError(err?.message || 'No pudimos crear la categoría.');
      return null;
    }
  }

  // Total USD del proyectado (todos los gastos).
  const totalUsd = recurrentes.reduce(
    (acc, r) => acc + montoUsd(r.monto, r.moneda, r.tc), 0);

  // Agrupamos recurrentes por categoria_id. Los sin categoría van al
  // bucket especial 'sin'. Cada grupo trae sus items + subtotal + % del
  // total. Orden: por subtotal descendente (los rubros más pesados primero).
  const grupos = (() => {
    const map = new Map(); // key = categoria_id || 'sin'
    for (const r of recurrentes) {
      const key = r.categoria_id == null ? 'sin' : r.categoria_id;
      if (!map.has(key)) {
        const cat = categorias.find(c => c.id === r.categoria_id);
        map.set(key, {
          key,
          nombre: cat?.nombre ?? 'Sin categorizar',
          items: [],
          subtotal_usd: 0,
        });
      }
      const g = map.get(key);
      g.items.push(r);
      g.subtotal_usd += montoUsd(r.monto, r.moneda, r.tc);
    }
    return Array.from(map.values()).sort((a, b) => b.subtotal_usd - a.subtotal_usd);
  })();

  return (
    <div>
      {error && (
        <div role="alert" className="banner" style={{
          background: 'var(--neg-soft)', color: 'var(--neg)',
          padding: 8, borderRadius: 6, fontSize: 12.5, marginBottom: 10,
        }}>{error}</div>
      )}

      {loading
        ? <div className="muted tiny">Cargando…</div>
        : (
          // Wrapper con scroll interno — la lista crece sin estirar la página.
          <div className="sanidad-presupuesto-scroll">
            <table className="sanidad-presupuesto-table">
              {/* colgroup con widths explícitos — bajo `table-layout: fixed`
                  el browser respeta estos anchos a rajatabla. Las filas del
                  body (incluyendo group headers con colSpan) se alinean
                  perfectas. */}
              <colgroup>
                <col className="u-w-auto" />
                <col style={{ width: 170 }} />
                <col className="u-w-200" />
                <col className="u-w-110px" />
              </colgroup>
              <thead>
                <tr>
                  <th className="u-td-left">Detalle</th>
                  <th className="u-text-right">Monto $ (ARS)</th>
                  <th className="u-text-right">Monto USD</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recurrentes.length === 0 && !adding && (
                  <tr><td colSpan={4} className="muted tiny u-p-16-text-center">
                    Todavía no tenés gastos proyectados. Empezá agregando los fijos del mes (alquiler, sueldos, etc.).
                  </td></tr>
                )}

                {grupos.map((g) => {
                  const pct = totalUsd > 0 ? (g.subtotal_usd / totalUsd) * 100 : 0;
                  const isOpen = expanded.has(g.key);
                  return (
                    <Fragment key={g.key}>
                      {/* Header del grupo: click → expandir/colapsar. Cursor pointer
                          + chevron a la izquierda indica el estado. */}
                      <tr
                        className="sanidad-group-header"
                        onClick={() => toggleGroup(g.key)}
                        className="u-cursor-pointer"
                        aria-expanded={isOpen}
                      >
                        <td colSpan={2}>
                          <div className="u-flex-center-gap-10">
                            <Icons.ChevronDown
                              size={14}
                              style={{
                                transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                                transition: 'transform .15s ease-out',
                                opacity: 0.7,
                              }}
                            />
                            <span className="u-fs-13-fw-600">{g.nombre}</span>
                            <span className="muted tiny">{g.items.length} ítem{g.items.length === 1 ? '' : 's'}</span>
                          </div>
                        </td>
                        <td className="sanidad-num-cell u-text-right">
                          <div className="u-fw-600">${fmt(g.subtotal_usd, 2)} USD</div>
                          <div className="muted tiny" style={{ fontSize: 11, marginTop: 2 }}>
                            {pct.toFixed(1)}% del total
                          </div>
                        </td>
                        <td>
                          <div className="sanidad-pct-bar">
                            <div className="sanidad-pct-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
                          </div>
                        </td>
                      </tr>

                      {/* Items del grupo — solo cuando está expandido */}
                      {isOpen && g.items.map(r => editingId === r.id ? (
                        <RecurrenteEditRow
                          key={r.id} draft={draft} setDraft={setDraft}
                          categorias={categorias} onCreateCategoria={createCategoria}
                          onSave={save} onCancel={cancel}
                        />
                      ) : (
                        <tr key={r.id}>
                          <td className="u-pl-36">{r.concepto}</td>
                          <td className="sanidad-num-cell u-text-right">
                            {r.moneda === 'ARS'
                              ? <span className="sanidad-money"><span className="sanidad-money-prefix">ARS</span><span className="sanidad-money-amount">{fmt(Number(r.monto), 0)}</span></span>
                              : <span className="muted tiny">—</span>}
                          </td>
                          <td className="sanidad-num-cell" style={{ textAlign:'right', fontWeight: 500 }}>
                            <span className="sanidad-money"><span className="sanidad-money-prefix">USD</span><span className="sanidad-money-amount">{fmt(montoUsd(r.monto, r.moneda, r.tc), 2)}</span></span>
                          </td>
                          <td>
                            <div className="flex-row u-gap-4-justify-end">
                              <button className="btn btn-sm" onClick={() => startEdit(r)} title="Editar">
                                <Icons.Edit size={12} />
                              </button>
                              <button className="btn btn-sm" onClick={() => remove(r)} title="Borrar"
                                      className="u-color-neg">
                                <Icons.Trash size={12} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}

                {adding && (
                  <RecurrenteEditRow
                    draft={draft} setDraft={setDraft}
                    categorias={categorias} onCreateCategoria={createCategoria}
                    onSave={save} onCancel={cancel}
                  />
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2} style={{ paddingTop: 14 }}>
                    {!adding && !editingId && (
                      <button className="btn btn-sm" onClick={startAdd}>
                        <Icons.Plus size={12} /> Agregar gasto
                      </button>
                    )}
                  </td>
                  <td style={{ textAlign:'right', paddingTop:14, fontWeight:600, fontVariantNumeric:'tabular-nums', fontSize: 15 }}>
                    Total: ${fmt(totalUsd, 2)} USD
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )
      }
    </div>
  );
}

// Sub-componente: row editable (crear nuevo o editar existente).
function RecurrenteEditRow({ draft, setDraft, categorias, onCreateCategoria, onSave, onCancel }) {
  // 2026-06-29 Multi-país F3: monedas según país del tenant.
  const { monedas } = useMonedasTenant();
  // 2026-06-25 UX-4 (audit pre-live): reemplazamos `window.prompt()` por un
  // mini-modal in-app. El prompt nativo rompe el theme dark (popup blanco) y
  // no soporta validación. Ahora: select "+ Nueva categoría…" abre el modal,
  // el user tipea el nombre, Crear llama onCreateCategoria y setea draft.
  const [showNewCat, setShowNewCat] = useState(false);
  const [newCatNombre, setNewCatNombre] = useState('');
  const [creatingCat, setCreatingCat] = useState(false);
  const newCatModalRef = useRef(null);
  useModal({ open: showNewCat, onClose: () => setShowNewCat(false), overlayRef: newCatModalRef });

  function handleCategoriaChange(value) {
    if (value === '__new__') {
      setNewCatNombre('');
      setShowNewCat(true);
    } else {
      setDraft({ ...draft, categoria_id: value });
    }
  }

  async function handleCreateCat(e) {
    e?.preventDefault?.();
    const nombre = newCatNombre.trim();
    if (!nombre) return;
    setCreatingCat(true);
    try {
      const newId = await onCreateCategoria(nombre);
      if (newId) setDraft({ ...draft, categoria_id: String(newId) });
      setShowNewCat(false);
      setNewCatNombre('');
    } finally {
      setCreatingCat(false);
    }
  }

  return (
    <Fragment>
    <tr className="u-bg-surface-2">
      <td>
        <div className="flex-row" style={{ gap: 6, flexDirection: 'column', alignItems: 'stretch' }}>
          <input
            className="input" autoFocus
            placeholder='ej: "Sueldo Gonza L"'
            value={draft.concepto}
            onChange={(e) => setDraft({ ...draft, concepto: e.target.value })}
            style={{ width: '100%', fontSize: 14, padding: '6px 10px' }}
          />
          <select
            className="input"
            value={draft.categoria_id}
            onChange={(e) => handleCategoriaChange(e.target.value)}
            style={{ width: '100%', fontSize: 12.5, padding: '4px 8px' }}
            title="Categorizá para ver el desglose por rubro"
          >
            <option value="">— Sin categorizar —</option>
            {(categorias || []).map(c => (
              <option key={c.id} value={c.id}>{c.nombre}</option>
            ))}
            <option value="__new__">+ Nueva categoría…</option>
          </select>
        </div>
      </td>
      <td>
        {draft.moneda === 'ARS' ? (
          <input
            className="input mono" type="number" inputMode="decimal" min="0" step="1000"
            placeholder="Monto ARS"
            value={draft.monto}
            onChange={(e) => setDraft({ ...draft, monto: e.target.value })}
            style={{ width: '100%', fontSize: 14, textAlign:'right', padding:'6px 10px' }}
          />
        ) : (
          <span className="muted tiny">—</span>
        )}
      </td>
      <td>
        <div className="flex-row" style={{ gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
          <select
            className="input" value={draft.moneda}
            onChange={(e) => setDraft({ ...draft, moneda: e.target.value })}
            style={{ width: 78, fontSize: 13, padding: '6px 8px' }}
          >
            {Array.from(new Set([...monedas, draft.moneda].filter(Boolean)))
              .map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          {/* 2026-06-29 Multi-país F3: si la moneda es la local (ARS o UYU),
              mostrar input TC para convertir a USD. Antes ARS-only. */}
          {(draft.moneda === 'ARS' || draft.moneda === 'UYU') ? (
            <input
              className="input mono" type="number" inputMode="decimal" min="0" step="50"
              placeholder="TC"
              title="Tipo de cambio para pasar el monto ARS a USD"
              value={draft.tc}
              onChange={(e) => setDraft({ ...draft, tc: e.target.value })}
              style={{ flex: 1, minWidth: 120, fontSize: 14, textAlign:'right', padding:'6px 10px' }}
            />
          ) : (
            <input
              className="input mono" type="number" inputMode="decimal" min="0" step="10"
              placeholder="Monto USD"
              value={draft.monto}
              onChange={(e) => setDraft({ ...draft, monto: e.target.value })}
              style={{ flex: 1, minWidth: 120, fontSize: 14, textAlign:'right', padding:'6px 10px' }}
            />
          )}
        </div>
      </td>
      <td>
        <div className="flex-row u-gap-4-justify-end">
          <button className="btn btn-sm btn-primary" onClick={onSave} title="Guardar">
            <Icons.Check size={12} />
          </button>
          <button className="btn btn-sm" onClick={onCancel} title="Cancelar">
            ✕
          </button>
        </div>
      </td>
    </tr>
    {showNewCat && (
      <tr><td colSpan={4} className="u-p-0">
        <div
          ref={newCatModalRef}
          className="modal-overlay"
          onClick={e => e.target === e.currentTarget && setShowNewCat(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="sanidad-new-cat-title"
        >
          <form className="modal" style={{ maxWidth: 360 }} onSubmit={handleCreateCat} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3 id="sanidad-new-cat-title">Nueva categoría</h3>
              <button type="button" className="icon-btn" onClick={() => setShowNewCat(false)} aria-label="Cerrar">
                <Icons.X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <label className="lbl">Nombre <span className="u-color-neg">*</span></label>
              <input
                className="input"
                autoFocus
                value={newCatNombre}
                onChange={e => setNewCatNombre(e.target.value)}
                placeholder='ej: "Servicios", "Comisiones"'
                maxLength={60}
              />
            </div>
            <div className="modal-ft">
              <button type="button" className="btn btn-ghost" onClick={() => setShowNewCat(false)}>Cancelar</button>
              <button type="submit" className="btn btn-primary" disabled={creatingCat || !newCatNombre.trim()}>
                {creatingCat ? 'Creando…' : 'Crear'}
              </button>
            </div>
          </form>
        </div>
      </td></tr>
    )}
    </Fragment>
  );
}

// ─── Pantalla principal ──────────────────────────────────────────────────────
export default function Sanidad() {
  const [meses, setMeses]     = useState(6);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [panelOpen, setPanelOpen] = useState(true);
  // 2026-06-24: toggle del desglose por gasto. Default colapsado para no
  // saturar la vista resumen; el user lo abre para editar overrides puntuales.
  const [showGastosDetail, setShowGastosDetail] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await sanidadApi.list(meses);
      setData(r.meses || []);
    } catch (err) {
      setError(err?.message || 'No pudimos cargar los datos.');
    } finally {
      setLoading(false);
    }
  }, [meses]);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleSaveProyeccion(periodo, monto) {
    try {
      await sanidadApi.upsertProyeccion(periodo, monto);
      // Optimistic: actualizamos solo ese mes en memoria.
      // Defensive `prev || []` (2026-07-08 Sentry #7599311233): si el fetch
      // inicial falló y `data` quedó null, este save llegaría con prev=null
      // y crashearía. En ese path el usuario probablemente no puede ni
      // llegar al handler, pero el guard es barato y evita un crash del
      // ErrorBoundary si algún flow raro lo dispara.
      setData((prev) => (prev || []).map((mes) => {
        if (mes.periodo !== periodo) return mes;
        const totalGastosProy = mes.total_gastos.proyectado_usd;
        const netoProyectado  = monto - totalGastosProy;
        return {
          ...mes,
          bruto: { ...mes.bruto, proyectado_usd: monto },
          neto:  { ...mes.neto,  proyectado_usd: netoProyectado },
          daily: {
            ...mes.daily,
            // Defensive audit 2026-07-06: `mes.dias_mes` siempre viene del
            // backend con 28-31 pero un guard es barato y evita mostrar
            // `Infinity` en la grilla si el backend regresa 0/null por bug
            // futuro. Fallback null → el MoneyCell renderiza "—".
            bruto_proyectado_usd: mes.dias_mes > 0 ? monto / mes.dias_mes : null,
            neto_proyectado_usd:  mes.dias_mes > 0 ? netoProyectado / mes.dias_mes : null,
          },
        };
      }));
    } catch (err) {
      setError(err?.message || 'No pudimos guardar la proyección.');
      fetchData();
    }
  }

  // 2026-06-24: handlers de override. Save/reset son simétricos en términos
  // de UI: ambos refetch para que el backend recompute los totales agregados
  // (total_gastos / neto / daily). Optimistic update de solo la celda
  // editada quedaría inconsistente con los totales — al usuario lo confunde
  // más que el refetch ágil.
  async function handleSaveOverride(recurrente_id, periodo, monto) {
    try {
      await sanidadApi.upsertOverride(recurrente_id, periodo, monto);
      await fetchData();
    } catch (err) {
      setError(err?.message || 'No pudimos guardar el override.');
    }
  }
  async function handleResetOverride(recurrente_id, periodo) {
    try {
      await sanidadApi.deleteOverride(recurrente_id, periodo);
      await fetchData();
    } catch (err) {
      setError(err?.message || 'No pudimos restaurar el default.');
    }
  }

  // Estado sin data (loading inicial O error del primer fetch).
  //
  // Bug 2026-07-08 (Sentry issue #7599311233, "null is not an object
  // evaluating 'n.map'"): el guard anterior era `loading && !data`. Si el
  // primer fetch fallaba (Safari 1AM, network hiccup), el catch seteaba
  // `error` sin tocar `data`, y `finally` bajaba `loading` a false. Segundo
  // render: `loading=false, data=null` → guard NO aplicaba → caía al render
  // principal → `data.map(...)` (líneas 886/896/etc) crasheaba el
  // ErrorBoundary y el user veía la pantalla de fallback global.
  //
  // Fix: cortar sobre `!data` — si no hay data (por cualquier motivo:
  // loading inicial o fetch fallido) mostramos el chrome de la página con
  // "Cargando…" o el `error` si existe. Los `.map()` posteriores quedan
  // garantizados con data:array.
  if (!data) {
    return (
      <div>
        <div className="page-head u-mb-20">
          <div>
            <h1 className="page-title">Sanidad del Negocio</h1>
            <div className="page-sub">{error ? '' : 'Cargando…'}</div>
          </div>
        </div>
        {error && (
          <div role="alert" className="banner" style={{
            background: 'var(--neg-soft)', color: 'var(--neg)',
            padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12,
          }}>
            {error}
            <button
              type="button"
              className="btn btn-sm"
              onClick={fetchData}
              style={{ marginLeft: 12 }}
            >Reintentar</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="page-head u-mb-16">
        <div>
          <h1 className="page-title">Sanidad del Negocio</h1>
          <div className="page-sub">
            Presupuesto vs ejecución mes a mes · cierra en USD · cargá tu bruto y proyectá tus gastos
          </div>
        </div>
        <div className="flex-row u-gap-8">
          <button
            className={'btn ' + (meses === 6 ? 'btn-primary' : '')}
            onClick={() => setMeses(6)}
          >6 meses</button>
          <button
            className={'btn ' + (meses === 12 ? 'btn-primary' : '')}
            onClick={() => setMeses(12)}
          >12 meses</button>
        </div>
      </div>

      {error && (
        <div role="alert" className="banner" style={{
          background: 'var(--neg-soft)', color: 'var(--neg)',
          padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12,
        }}>{error}</div>
      )}

      {/* ─── Tabla resumen mensual ────────────────────────────────────────── */}
      <div className="card" style={{ overflow: 'auto', padding: 0, marginBottom: 16 }}>
        <table className="sanidad-resumen-table">
          <thead>
            <tr>
              <th className="sanidad-th-concepto" rowSpan={2}></th>
              {data.map((mes) => (
                <th key={mes.periodo} colSpan={2} className="sanidad-th-mes">
                  {labelMes(mes.periodo)}
                  <div className="muted tiny" style={{ fontWeight: 400, marginTop: 2 }}>
                    {mes.dias_mes} días
                  </div>
                </th>
              ))}
            </tr>
            <tr>
              {data.map((mes) => (
                <Fragment key={mes.periodo}>
                  <th className="sanidad-th-sub">Proyectado</th>
                  <th className="sanidad-th-sub">Real</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Bruto — variación proy vs proy del mes anterior, real vs real */}
            <tr className="sanidad-row-bruto">
              <td className="sanidad-td-concepto">
                <strong>Facturación bruta</strong>
              </td>
              {data.map((mes, idx) => {
                const prev = data[idx - 1];
                return (
                  <Fragment key={mes.periodo}>
                    <td className="sanidad-td-num">
                      <BrutoProyectadoEditable
                        periodo={mes.periodo} value={mes.bruto.proyectado_usd}
                        variacion={variacionPct(mes.bruto.proyectado_usd, prev?.bruto.proyectado_usd)}
                        isGasto={false}
                        onSave={handleSaveProyeccion}
                      />
                    </td>
                    <td className="sanidad-td-num">
                      <MoneyCell
                        value={mes.bruto.real_usd}
                        variacion={variacionPct(mes.bruto.real_usd, prev?.bruto.real_usd)}
                        isGasto={false}
                      />
                      {(mes.bruto.real_retail_usd > 0 || mes.bruto.real_b2b_usd > 0) && (
                        <div className="muted tiny" style={{ marginTop: 2, fontSize: 10 }}>
                          R {fmt(mes.bruto.real_retail_usd, 0)} · B {fmt(mes.bruto.real_b2b_usd, 0)}
                        </div>
                      )}
                    </td>
                  </Fragment>
                );
              })}
            </tr>
            {/* Gastos — subir = malo (rojo) / bajar = bueno (verde) */}
            <tr>
              <td className="sanidad-td-concepto">
                <button
                  type="button"
                  onClick={() => setShowGastosDetail(o => !o)}
                  aria-expanded={showGastosDetail}
                  title={showGastosDetail ? 'Ocultar detalle por gasto' : 'Ver detalle por gasto · permite editar el monto de un mes específico'}
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    padding: 0, font: 'inherit', color: 'inherit',
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                  }}
                >
                  <Icons.ChevronDown size={12}
                    style={{ transform: showGastosDetail ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }} />
                  Gastos e inversiones
                </button>
              </td>
              {data.map((mes, idx) => {
                const prev = data[idx - 1];
                return (
                  <Fragment key={mes.periodo}>
                    <td className="sanidad-td-num">
                      <MoneyCell
                        value={mes.total_gastos.proyectado_usd}
                        variacion={variacionPct(mes.total_gastos.proyectado_usd, prev?.total_gastos.proyectado_usd)}
                        isGasto={true}
                      />
                    </td>
                    <td className="sanidad-td-num">
                      <MoneyCell
                        value={mes.total_gastos.real_usd}
                        variacion={variacionPct(mes.total_gastos.real_usd, prev?.total_gastos.real_usd)}
                        isGasto={true}
                      />
                    </td>
                  </Fragment>
                );
              })}
            </tr>
            {/* 2026-06-24: detalle por recurrente cuando el toggle está abierto.
                Cada fila muestra un recurrente; las celdas de "Proy" son
                editables (override mensual). "Real" sigue siendo read-only
                (sale de los egresos pagados). */}
            {showGastosDetail && data[0]?.gastos
              ?.filter(g => g.recurrente_id != null) // skip "Otros" (no se puede override)
              .map(refGasto => (
                <tr key={refGasto.recurrente_id} className="u-bg-surface-2">
                  <td className="sanidad-td-concepto" style={{ paddingLeft: 24, fontSize: 12, fontWeight: 400 }}>
                    {refGasto.concepto}
                  </td>
                  {data.map(mes => {
                    // Buscamos el gasto correspondiente en cada mes. Si por
                    // alguna razón no está (recurrente borrado entre meses),
                    // mostramos placeholder.
                    const g = mes.gastos.find(x => x.recurrente_id === refGasto.recurrente_id);
                    if (!g) {
                      return (
                        <Fragment key={mes.periodo}>
                          <td className="sanidad-td-num"><span className="muted tiny">—</span></td>
                          <td className="sanidad-td-num"><span className="muted tiny">—</span></td>
                        </Fragment>
                      );
                    }
                    return (
                      <Fragment key={mes.periodo}>
                        <td className="sanidad-td-num">
                          <GastoProyectadoCell
                            periodo={mes.periodo}
                            recurrente_id={g.recurrente_id}
                            value={g.proyectado_usd}
                            isOverride={!!g.is_override}
                            defaultUsd={g.default_usd}
                            onSave={handleSaveOverride}
                            onReset={handleResetOverride}
                          />
                        </td>
                        <td className="sanidad-td-num">
                          {g.real_usd != null
                            ? <MoneyCell value={g.real_usd} isGasto={true} />
                            : <span className="muted tiny" style={{ opacity: 0.5 }}>—</span>}
                        </td>
                      </Fragment>
                    );
                  })}
                </tr>
              ))}
            {/* Neto — subir = bueno / bajar = malo */}
            <tr className="sanidad-row-neto">
              <td className="sanidad-td-concepto">
                <strong>Resultado neto</strong>
                <div className="muted tiny" style={{ fontSize: 10, fontWeight: 400 }}>
                  Facturación bruta − Gastos e inversiones
                </div>
              </td>
              {data.map((mes, idx) => {
                const prev = data[idx - 1];
                return (
                  <Fragment key={mes.periodo}>
                    <td className="sanidad-td-num">
                      <MoneyCell
                        value={mes.neto.proyectado_usd}
                        variacion={variacionPct(mes.neto.proyectado_usd, prev?.neto.proyectado_usd)}
                        isGasto={false}
                      />
                    </td>
                    <td className="sanidad-td-num">
                      <MoneyCell
                        value={mes.neto.real_usd}
                        variacion={variacionPct(mes.neto.real_usd, prev?.neto.real_usd)}
                        isGasto={false}
                      />
                    </td>
                  </Fragment>
                );
              })}
            </tr>
            {/* Neto diario — misma lógica que Neto */}
            <tr className="sanidad-row-daily">
              <td className="sanidad-td-concepto">
                Resultado neto diario
                <div className="muted tiny" style={{ fontSize: 10 }}>Resultado neto / días</div>
              </td>
              {data.map((mes, idx) => {
                const prev = data[idx - 1];
                return (
                  <Fragment key={mes.periodo}>
                    <td className="sanidad-td-num">
                      <MoneyCell
                        value={mes.daily.neto_proyectado_usd}
                        variacion={variacionPct(mes.daily.neto_proyectado_usd, prev?.daily.neto_proyectado_usd)}
                        isGasto={false}
                      />
                    </td>
                    <td className="sanidad-td-num">
                      <MoneyCell
                        value={mes.daily.neto_real_usd}
                        variacion={variacionPct(mes.daily.neto_real_usd, prev?.daily.neto_real_usd)}
                        isGasto={false}
                      />
                    </td>
                  </Fragment>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      {/* ─── Panel desplegable "Mis gastos proyectados" ───────────────────── */}
      <div className="card u-p-0">
        <button
          type="button"
          onClick={() => setPanelOpen(o => !o)}
          className="sanidad-panel-toggle"
          aria-expanded={panelOpen}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Icons.ChevronDown size={14}
              style={{ transform: panelOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }} />
            <strong>Mis gastos proyectados</strong>
            <span className="muted tiny">— editá tu presupuesto de gastos fijos</span>
          </span>
        </button>
        {panelOpen && (
          <div style={{ padding: '12px 16px 16px', borderTop: '1px solid var(--border)' }}>
            <ProyeccionGastosPanel onChange={fetchData} />
          </div>
        )}
      </div>

      <div className="muted tiny" style={{ marginTop: 12, lineHeight: 1.6 }}>
        <strong>Cómo funciona:</strong> el bruto real sale de tus ventas no canceladas
        (R = retail, B = cuenta corriente B2B). Los gastos reales salen de
        los egresos marcados como pagados. Cargá tu bruto esperado del mes
        haciendo click en la celda "Proy." y proyectá tus gastos fijos abajo.
      </div>
    </div>
  );
}
