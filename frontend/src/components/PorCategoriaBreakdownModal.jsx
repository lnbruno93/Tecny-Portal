// PorCategoriaBreakdownModal.jsx — 2026-07-11
//
// Componente base para modales que muestran un breakdown de items por
// categoría (clases_producto). Refactor consolidado de:
//   · InventarioPorCategoriaModal (F3-Fase2b): "Inversión por categoría"
//     con columnas count + USD, ordenado por USD DESC, con redact caps.
//   · VentasPorCategoriaModal (Dashboard rediseño): "Unidades vendidas por
//     categoría" con columnas porcentaje + count, ordenado por count DESC,
//     sin redact caps.
//
// Ambos comparten:
//   - Estructura modal-overlay + modal-hd/body/ft
//   - useModal hook (Esc + focus trap + scroll lock)
//   - CSS de cat-row (emoji + nombre + valor grid)
//   - Filtrado de filas vacías, orden, totales, estado vacío
//
// Las diferencias (título, subtítulo, columnas, orden, redact) quedan
// parametrizadas como props. Los 2 wrappers específicos ahora son
// adaptadores finos (~30 LOC c/u) que composean este base.
//
// Diseño de props:
//   · Los `items` vienen crudos del backend — el componente no asume shape
//     específico. Los accessors (`countKey`, `moneyKey`) se pasan como
//     strings — permite reusar con cualquier shape futuro.
//   · `filterFn` y `sortFn` son opcionales — defaults sensatos si no
//     vienen (filtra filas con count/money=0, ordena por count DESC).
//   · `redactable=true` activa el chequeo "si todas las filas del money
//     column son null, ocultá el footer y mostrá — en la fila". Útil
//     cuando el backend redacta por capabilities.

import { useRef } from 'react';
import { useModal } from '../lib/useModal';
import { Icons } from './Icons';

// Formatea número con separadores locales, sin decimales. Null/undefined → "—".
function fmtN(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('es-AR', { maximumFractionDigits: 0 });
}

export default function PorCategoriaBreakdownModal({
  open,
  onClose,
  // ── Textos ───────────────────────────────────────────────────────
  title,                    // "Inversión por categoría" / "Unidades vendidas por categoría"
  subtitle,                 // texto del bloque de descripción (arriba de la lista)
  emptyMessage,             // texto cuando no hay filas visibles
  // ── Data + accessors ─────────────────────────────────────────────
  items,                    // array crudo del backend
  countKey = 'count',       // key del count numérico en cada fila
  countLabel = 'u',         // sufijo del count ("u" para unidades)
  moneyKey = null,          // key del monto USD (null si no hay columna monetaria)
  moneyLabel = 'USD',       // prefijo del monto (ej: "USD")
  moneyKeyAlt = null,       // key del monto en moneda alternativa (ARS) — opcional, aparece como
                            // línea adicional debajo del total si > 0
  moneyLabelAlt = 'ARS',    // prefijo del monto alternativo
  // ── Comportamiento ───────────────────────────────────────────────
  showPercentage = false,   // muestra porcentaje relativo por fila (ventas usan esto)
  redactable = false,       // si moneyKey === null en TODAS las filas, oculta totales
  filterFn,                 // (fila) => bool — default: count > 0 || money > 0
  sortFn,                   // (a, b) => number — default: ordenar por moneyKey desc, luego countKey desc
  totalLabel = 'Total',     // label de la fila de totales del footer
  // ── ID DOM para aria-labelledby (opcional para tests) ────────────
  titleId = 'por-cat-breakdown-title',
}) {
  const overlayRef = useRef(null);
  useModal({ open, onClose, overlayRef });

  if (!open) return null;

  const filas = Array.isArray(items) ? items : [];

  // Filter default: fila visible si tiene count > 0 O money > 0 en cualquier
  // moneda. Sin esto, las categorías vacías ensucian la vista.
  const defaultFilter = (r) => {
    const c = Number(r[countKey]) || 0;
    const m = moneyKey ? (Number(r[moneyKey]) || 0) : 0;
    const mAlt = moneyKeyAlt ? (Number(r[moneyKeyAlt]) || 0) : 0;
    return c > 0 || m > 0 || mAlt > 0;
  };
  const filasVisibles = filas.filter(filterFn || defaultFilter);

  // Sort default: si hay moneyKey → USD DESC, luego count DESC.
  //                si no hay moneyKey → count DESC.
  //                empate → nombre ASC (alfabético).
  const defaultSort = (a, b) => {
    if (moneyKey) {
      const diff = (Number(b[moneyKey]) || 0) - (Number(a[moneyKey]) || 0);
      if (diff !== 0) return diff;
    }
    const diffCount = (Number(b[countKey]) || 0) - (Number(a[countKey]) || 0);
    if (diffCount !== 0) return diffCount;
    return String(a.nombre).localeCompare(String(b.nombre));
  };
  const filasOrdenadas = filasVisibles.slice().sort(sortFn || defaultSort);

  // Totales del footer.
  const totalCount = filasOrdenadas.reduce((s, r) => s + (Number(r[countKey]) || 0), 0);
  const totalMoney = moneyKey
    ? filasOrdenadas.reduce((s, r) => s + (Number(r[moneyKey]) || 0), 0)
    : 0;
  const totalMoneyAlt = moneyKeyAlt
    ? filasOrdenadas.reduce((s, r) => s + (Number(r[moneyKeyAlt]) || 0), 0)
    : 0;

  // Redact detection: si `redactable=true` y TODAS las filas visibles tienen
  // moneyKey === null (explícito, no undefined), asumimos que el backend
  // redactó por capabilities → ocultamos los totales monetarios.
  const redacted = redactable
    && moneyKey
    && filasOrdenadas.length > 0
    && filasOrdenadas.every(r => r[moneyKey] === null);

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal"
        role="dialog"
        aria-labelledby={titleId}
        aria-modal="true"
        style={{ maxWidth: 560, width: '92vw' }}
      >
        <div className="modal-hd">
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Cerrar"
            title="Cerrar"
          >
            <Icons.X size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          {subtitle && (
            <p className="muted tiny u-mb-12">
              {subtitle}
            </p>
          )}

          {filasOrdenadas.length === 0 ? (
            <p className="muted">{emptyMessage}</p>
          ) : (
            <div className="cat-breakdown">
              {filasOrdenadas.map((r, i) => {
                const pct = showPercentage && totalCount > 0
                  ? (Number(r[countKey]) / totalCount) * 100
                  : null;
                const count = Number(r[countKey]) || 0;
                const money = moneyKey ? r[moneyKey] : null;
                return (
                  <div key={r.clase_id || `null-${i}`} className="cat-row">
                    <span className="cat-em" aria-hidden="true">
                      {r.emoji || (r.es_sin_categoria ? '📦' : '·')}
                    </span>
                    <span className="cat-name">
                      {r.nombre}
                      {r.es_sin_categoria && !r.emoji && (
                        <span className="muted tiny" style={{ marginLeft: 6 }}>sin categoría</span>
                      )}
                    </span>
                    {pct != null && (
                      <span className="cat-pct mono">{pct.toFixed(1)}%</span>
                    )}
                    <span className="cat-count mono">
                      {moneyKey ? (
                        <>{fmtN(count)} {countLabel}</>
                      ) : (
                        <><strong>{fmtN(count)}</strong><span className="muted"> {countLabel}</span></>
                      )}
                    </span>
                    {moneyKey && (
                      <span className="cat-value mono">
                        <span className="ccy">{moneyLabel}</span>{fmtN(money)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {filasOrdenadas.length > 0 && !redacted && (
            <div
              className="cat-totales"
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: '1px solid var(--border)',
                display: 'grid',
                gridTemplateColumns: moneyKey
                  ? 'auto 1fr auto auto'
                  : (showPercentage
                      ? 'auto 1fr auto auto'
                      : 'auto 1fr auto auto'),
                gap: 12,
                alignItems: 'center',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              <span aria-hidden="true">∑</span>
              <span>{totalLabel}</span>
              {moneyKey ? (
                <>
                  <span className="mono muted">{fmtN(totalCount)} {countLabel}</span>
                  <span className="mono">
                    <span className="ccy" style={{ marginRight: 4, fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>{moneyLabel}</span>
                    {fmtN(totalMoney)}
                  </span>
                </>
              ) : (
                <>
                  <span className="muted tiny">{filasOrdenadas.length} cat.</span>
                  <span className="mono">
                    <strong>{fmtN(totalCount)}</strong>
                    <span className="muted"> {countLabel}</span>
                  </span>
                </>
              )}
            </div>
          )}

          {moneyKeyAlt && totalMoneyAlt > 0 && !redacted && (
            <div
              className="muted tiny"
              style={{ marginTop: 4, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
            >
              + {moneyLabelAlt} {fmtN(totalMoneyAlt)} en costos locales
            </div>
          )}
        </div>

        <div className="modal-ft">
          <button type="button" className="btn" onClick={onClose}>Cerrar</button>
        </div>
      </div>

      <style>{`
        .cat-breakdown {
          display: flex;
          flex-direction: column;
        }
        .cat-row {
          display: grid;
          grid-template-columns: auto 1fr ${showPercentage ? 'auto ' : ''}auto${moneyKey ? ' auto' : ''};
          align-items: center;
          gap: 12px;
          padding: 10px 0;
          border-bottom: 1px solid var(--border);
          font-size: 13.5px;
        }
        .cat-row:last-child { border-bottom: none; }
        .cat-em { font-size: 16px; line-height: 1; }
        .cat-name { font-weight: 500; }
        .cat-pct { color: var(--text-muted); font-size: 12px; min-width: 44px; text-align: right; }
        .cat-count {
          ${moneyKey ? 'color: var(--text-muted); font-size: 12.5px;' : 'font-variant-numeric: tabular-nums; min-width: 64px; text-align: right;'}
        }
        .cat-value { font-weight: 500; font-variant-numeric: tabular-nums; }
        .cat-value .ccy {
          font-size: 11.5px;
          color: var(--text-muted);
          font-weight: 500;
          margin-right: 4px;
        }
      `}</style>
    </div>
  );
}
