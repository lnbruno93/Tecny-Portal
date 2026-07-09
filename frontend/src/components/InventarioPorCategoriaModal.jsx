// InventarioPorCategoriaModal.jsx — 2026-07-09 F3-Fase2b
//
// Modal de detalle del KPI "Total valorizado". Consume `inv_por_clase[]` del
// endpoint /api/inventario/productos/metricas (Fase 2a). Muestra el breakdown
// granular del stock disponible por categoría del tenant.
//
// Contexto: los 4 cards KPI del header de Inventario colapsan la data en 2
// buckets (equipos / accesorios). Este modal levanta esa restricción y
// muestra cuánto stock hay en cada categoría del catálogo del tenant + la
// fila "Sin categoría" si hay productos huérfanos.
//
// Shape esperado de cada fila (viene tal cual del backend):
//   { clase_id, nombre, emoji, es_base, es_sin_categoria, slug_legacy,
//     count, usd, ars }
// - `usd` / `ars` pueden ser null si el user carece de `inventario.ver_costos`
//   (redact caps en el endpoint). En ese caso mostramos "—" en el monto.
// - `count` siempre presente — un vendedor puede saber CUÁNTOS equipos hay.
// - Backend ordena por orden ASC → USD DESC → nombre ASC. Preservamos.

import { useRef } from 'react';
import { useModal } from '../lib/useModal';
import { Icons } from './Icons';

// Formatea número con separadores locales, sin decimales (mismo criterio
// que `fmt` en Inventario.jsx). Null / undefined → "—".
function fmtMoney(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('es-AR', { maximumFractionDigits: 0 });
}

export default function InventarioPorCategoriaModal({ open, onClose, invPorClase }) {
  const overlayRef = useRef(null);
  useModal({ open, onClose, overlayRef });

  if (!open) return null;

  const filas = Array.isArray(invPorClase) ? invPorClase : [];
  // Filtrar filas con count 0 Y usd 0 para no mostrar ruido (categorías
  // sin stock). Si el usuario quiere ver "todas las cats. existan o no",
  // que abra el modal de gestión desde el botón principal.
  const filasVisibles = filas.filter(r => (r.count > 0) || (Number(r.usd) > 0) || (Number(r.ars) > 0));

  // Totales para el footer — usan Number() para tolerar strings de PG y
  // filas con null (redacted). null se cuenta como 0 acá, la UI del footer
  // muestra el total real (SI hay ver_costos) o queda oculto (si no).
  const totalUsd = filasVisibles.reduce((s, r) => s + (Number(r.usd) || 0), 0);
  const totalArs = filasVisibles.reduce((s, r) => s + (Number(r.ars) || 0), 0);
  const totalCount = filasVisibles.reduce((s, r) => s + (Number(r.count) || 0), 0);
  // Detectar redact: si TODAS las filas visibles tienen `usd === null`, el
  // backend redactó. No mostramos totales monetarios en ese caso.
  const redacted = filasVisibles.length > 0 && filasVisibles.every(r => r.usd === null);

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal"
        role="dialog"
        aria-labelledby="inv-por-cat-title"
        aria-modal="true"
        style={{ maxWidth: 560, width: '92vw' }}
      >
        <div className="modal-hd">
          <h3 id="inv-por-cat-title">Inversión por categoría</h3>
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
          <p className="muted tiny" style={{ marginBottom: 12 }}>
            Stock disponible por categoría. Las categorías con 0 unidades y $0 valorizado se ocultan.
            El detalle usa el catálogo editable del tenant — modificalo desde "Categorías" en el header.
          </p>

          {filasVisibles.length === 0 ? (
            <p className="muted">Sin categorías con stock disponible.</p>
          ) : (
            <div className="cat-breakdown">
              {filasVisibles.map((r, i) => (
                <div key={r.clase_id || `null-${i}`} className="cat-row">
                  <span className="cat-em" aria-hidden="true">{r.emoji || (r.es_sin_categoria ? '📦' : '·')}</span>
                  <span className="cat-name">
                    {r.nombre}
                    {r.es_sin_categoria && (
                      <span className="muted tiny" style={{ marginLeft: 6 }}>sin categoría</span>
                    )}
                  </span>
                  <span className="cat-count mono">{fmtMoney(r.count)} u</span>
                  <span className="cat-value mono">
                    <span className="ccy">USD</span>{fmtMoney(r.usd)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {filasVisibles.length > 0 && !redacted && (
            <div
              className="cat-totales"
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: '1px solid var(--border)',
                display: 'grid',
                gridTemplateColumns: 'auto 1fr auto auto',
                gap: 12,
                alignItems: 'center',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              <span aria-hidden="true">∑</span>
              <span>Total</span>
              <span className="mono muted">{fmtMoney(totalCount)} u</span>
              <span className="mono">
                <span className="ccy" style={{ marginRight: 4, fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>USD</span>
                {fmtMoney(totalUsd)}
              </span>
            </div>
          )}

          {totalArs > 0 && !redacted && (
            <div
              className="muted tiny"
              style={{ marginTop: 4, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
            >
              + ARS {fmtMoney(totalArs)} en costos locales
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
          grid-template-columns: auto 1fr auto auto;
          align-items: center;
          gap: 12px;
          padding: 10px 0;
          border-bottom: 1px solid var(--border);
          font-size: 13.5px;
        }
        .cat-row:last-child { border-bottom: none; }
        .cat-em { font-size: 16px; line-height: 1; }
        .cat-name { font-weight: 500; }
        .cat-count { color: var(--text-muted); font-size: 12.5px; }
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
