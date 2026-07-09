// VentasPorCategoriaModal.jsx — 2026-07-09
//
// Modal de detalle del KPI "Unidades vendidas" del Dashboard de Ventas.
// Consume `unidades_por_clase[]` del endpoint /api/ventas/dashboard (shape
// mergeado en F3.c-2 PR-2 #533). Muestra el breakdown granular de las
// unidades vendidas en el rango por categoría real del tenant.
//
// Contexto: el card KPI del Dashboard hoy renderiza chips inline con
// emoji + nombre + count por categoría. Con muchas categorías vendidas
// (10+) el card se desbalancea vs. los otros 3 de la fila. Este modal
// levanta esa restricción — el card queda compacto (Opción C mockup) y
// el detalle vive acá con orden por count desc.
//
// Shape esperado de cada fila (viene del backend):
//   { clase_id, nombre, emoji, n }
// - `n` siempre presente (int, unidades vendidas).
// - `emoji` puede ser null (categoría sin emoji configurado).
// - No hay valorización monetaria acá — es un dashboard de conteo por
//   categoría, no de valorizado (ese vive en Inventario/Capital).
//
// Consistente con `InventarioPorCategoriaModal.jsx` (Fase 2b): mismo
// patrón visual (modal-overlay + modal-hd/body/ft), mismo useModal hook,
// mismo CSS de las filas cat-row (reutilizado inline en <style>).

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

export default function VentasPorCategoriaModal({ open, onClose, unidadesPorClase }) {
  const overlayRef = useRef(null);
  useModal({ open, onClose, overlayRef });

  if (!open) return null;

  const filas = Array.isArray(unidadesPorClase) ? unidadesPorClase : [];
  // Filtrar filas con n=0 (no aportan info al breakdown). El backend suele
  // omitirlas ya, pero defensivo.
  const filasVisibles = filas
    .filter(r => Number(r.n) > 0)
    // Orden por n DESC — categorías más vendidas arriba. Alfabético como
    // desempate. Backend ya viene ordenado según F3.c-2 PR-2, pero por si
    // acaso reordenamos acá también.
    .sort((a, b) => (Number(b.n) || 0) - (Number(a.n) || 0) || String(a.nombre).localeCompare(String(b.nombre)));

  const totalUnidades = filasVisibles.reduce((s, r) => s + (Number(r.n) || 0), 0);

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal"
        role="dialog"
        aria-labelledby="ventas-por-cat-title"
        aria-modal="true"
        style={{ maxWidth: 520, width: '92vw' }}
      >
        <div className="modal-hd">
          <h3 id="ventas-por-cat-title">Unidades vendidas por categoría</h3>
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
            Volumen del rango, ordenado por cantidad. El detalle usa el catálogo editable del tenant —
            si querés renombrar / reordenar categorías, hacelo desde "Categorías" en Inventario.
          </p>

          {filasVisibles.length === 0 ? (
            <p className="muted">Sin ventas por categoría en el rango.</p>
          ) : (
            <div className="cat-breakdown">
              {filasVisibles.map((r) => {
                const pct = totalUnidades > 0 ? (Number(r.n) / totalUnidades) * 100 : 0;
                return (
                  <div key={r.clase_id || r.nombre} className="cat-row">
                    <span className="cat-em" aria-hidden="true">{r.emoji || '·'}</span>
                    <span className="cat-name">{r.nombre}</span>
                    <span className="cat-pct mono">{pct.toFixed(1)}%</span>
                    <span className="cat-count mono">
                      <strong>{fmtN(r.n)}</strong>
                      <span className="muted"> {r.n === 1 ? 'u' : 'u'}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {filasVisibles.length > 0 && (
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
              <span className="muted tiny">{filasVisibles.length} cat.</span>
              <span className="mono">
                <strong>{fmtN(totalUnidades)}</strong>
                <span className="muted"> u</span>
              </span>
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
        .cat-pct { color: var(--text-muted); font-size: 12px; min-width: 44px; text-align: right; }
        .cat-count { font-variant-numeric: tabular-nums; min-width: 64px; text-align: right; }
      `}</style>
    </div>
  );
}
