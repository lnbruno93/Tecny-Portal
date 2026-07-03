/**
 * Migration: ventas.vendedor_nombre (#509 — edición focalizada post-emisión).
 *
 * Contexto: el comprobante PDF renderiza la línea "ATENDIDO POR ..." a partir
 * del `vendedor_id` del primer item con vendedor. Ese join a `vendedores.nombre`
 * queda fijo al momento de imprimir. Owners piden poder editar el nombre
 * mostrado (o las iniciales) sin tocar el catálogo de vendedores real.
 *
 * Diseño:
 *   - Columna `vendedor_nombre TEXT` nullable en `ventas`.
 *   - NULL = no hay override → el PDF cae al fallback derivado del vendedor_id
 *     del item (comportamiento actual, sin cambio).
 *   - Non-NULL = override explícito → el PDF prefiere este valor.
 *   - Se puede setear al alta (POST /api/ventas) o via PATCH focalizado
 *     (/api/ventas/:id/vendedor-nombre) post-emisión, en cualquier momento.
 *
 * Por qué denormalizar acá y no en `venta_items`:
 *   - El comprobante es UNO por venta y muestra un solo "atendido por".
 *   - Editar el label en un lugar (ventas.vendedor_nombre) es más simple que
 *     tocar N items o crear un endpoint por item.
 *   - No rompe reportería que agrupa por vendedor_id (ese sigue intacto en
 *     los items). Este campo es puramente presentacional.
 *
 * RLS: `ventas` ya tiene policy tenant-scoped (migration 20260615000002),
 * no hace falta cambiar nada acá — la nueva columna hereda la protección.
 *
 * Rollback: DROP COLUMN. No hay data pérdida crítica porque el fallback al
 * vendedor_id del item cubre el 100% de los casos históricos.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE ventas
      ADD COLUMN IF NOT EXISTS vendedor_nombre TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE ventas
      DROP COLUMN IF EXISTS vendedor_nombre;
  `);
};
