// InventarioPorCategoriaModal.jsx — 2026-07-09 F3-Fase2b (refactor 2026-07-11)
//
// Modal de detalle del KPI "Total valorizado" de Inventario. Consume
// `inv_por_clase[]` del endpoint /api/inventario/productos/metricas (Fase 2a).
//
// Post-2026-07-11: refactor a thin wrapper sobre `PorCategoriaBreakdownModal`
// (componente base compartido con `VentasPorCategoriaModal`). Comportamiento
// visual y funcional idéntico al pre-refactor — la lógica de filas + orden +
// totales + redact caps + estado vacío vive en el base.
//
// Shape esperado de cada fila (viene del backend):
//   { clase_id, nombre, emoji, es_base, es_sin_categoria, slug_legacy,
//     count, usd, ars }
// - `usd` / `ars` pueden ser null si el user carece de `inventario.ver_costos`
//   (redact caps en el endpoint). El base detecta y oculta totales.
// - `count` siempre presente.

import PorCategoriaBreakdownModal from './PorCategoriaBreakdownModal';

export default function InventarioPorCategoriaModal({ open, onClose, invPorClase }) {
  return (
    <PorCategoriaBreakdownModal
      open={open}
      onClose={onClose}
      titleId="inv-por-cat-title"
      title="Inversión por categoría"
      subtitle="Stock disponible por categoría. Las categorías con 0 unidades y $0 valorizado se ocultan. El detalle usa el catálogo editable del tenant — modificalo desde &quot;Categorías&quot; en el header."
      emptyMessage="Sin categorías con stock disponible."
      items={invPorClase}
      countKey="count"
      countLabel="u"
      moneyKey="usd"
      moneyLabel="USD"
      moneyKeyAlt="ars"
      moneyLabelAlt="ARS"
      redactable={true}
      // Sin showPercentage — no aplica al inventario valorizado.
      // Sort default del base (moneyKey DESC → count DESC → nombre) es
      // el correcto acá: primero las categorías con más plata valorizada.
    />
  );
}
