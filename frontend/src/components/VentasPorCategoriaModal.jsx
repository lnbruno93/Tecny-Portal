// VentasPorCategoriaModal.jsx — 2026-07-09 (refactor 2026-07-11)
//
// Modal de detalle del KPI "Unidades vendidas" del Dashboard de Ventas.
// Consume `unidades_por_clase[]` del endpoint /api/ventas/dashboard.
//
// Post-2026-07-11: refactor a thin wrapper sobre `PorCategoriaBreakdownModal`
// (componente base compartido con `InventarioPorCategoriaModal`). Comportamiento
// visual y funcional idéntico al pre-refactor.
//
// Shape esperado de cada fila (viene del backend):
//   { clase_id, nombre, emoji, n }
// - `n` siempre presente (int, unidades vendidas).
// - `emoji` puede ser null (categoría sin emoji configurado).
// - Sin valorización monetaria — el Dashboard cuenta unidades, no plata.

import PorCategoriaBreakdownModal from './PorCategoriaBreakdownModal';

export default function VentasPorCategoriaModal({ open, onClose, unidadesPorClase }) {
  return (
    <PorCategoriaBreakdownModal
      open={open}
      onClose={onClose}
      titleId="ventas-por-cat-title"
      title="Unidades vendidas por categoría"
      subtitle='Volumen del rango, ordenado por cantidad. El detalle usa el catálogo editable del tenant — si querés renombrar / reordenar categorías, hacelo desde "Categorías" en Inventario.'
      emptyMessage="Sin ventas por categoría en el rango."
      items={unidadesPorClase}
      countKey="n"
      countLabel="u"
      // moneyKey=null → sin columna monetaria (base lo maneja).
      showPercentage={true}
      // Sort: solo por count (n) DESC — no hay moneyKey. Default del base
      // ya hace eso cuando moneyKey es null. Filtra filas con n=0.
    />
  );
}
