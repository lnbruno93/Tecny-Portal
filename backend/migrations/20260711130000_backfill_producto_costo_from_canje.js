/**
 * 20260711130000_backfill_producto_costo_from_canje.js
 *
 * Backfill: productos ingresados por canje ANTES de junio 2026 tenían
 * costo=0 hardcodeado en el backend (routes/ventas.js). En junio 2026
 * se ampliaron los campos del canje para persistir el valor_toma como
 * `costo` del producto (feature #canje-completo). Los canjes viejos
 * quedaron con costo=0 y aparecen mal en Inventario.
 *
 * Bug reportado por Lucas 2026-07-11: venta de junio con canje que valía
 * USD 300 aparecía en Inventario con costo=0.
 *
 * Fix: por cada producto que es `producto_id` de un canje con valor_toma>0
 * y tiene `costo=0` (o NULL), setear costo = valor_toma del canje asociado.
 * costo_moneda se toma del canje también (defensa: si el producto ya tiene
 * moneda seteada la mantenemos).
 *
 * Idempotente: solo actualiza filas con costo=0 o NULL. Re-correr no cambia
 * los productos que ya tienen costo correcto.
 *
 * Rollback: NO reversible. Un `down` que reasigne costo=0 es destructivo
 * porque no sabemos si algún user editó el costo manualmente post-backfill.
 */

exports.up = async (pgm) => {
  pgm.sql(`
    UPDATE productos p
       SET costo        = c.valor_toma,
           costo_moneda = COALESCE(NULLIF(p.costo_moneda, ''), c.moneda)
      FROM canjes c
     WHERE c.producto_id = p.id
       AND c.valor_toma > 0
       AND (p.costo IS NULL OR p.costo = 0)
       AND p.deleted_at IS NULL;
  `);
};

exports.down = async () => {
  // NO reversible — ver comentario del header. Down es no-op para no
  // destruir data que un user pudo haber editado manualmente después.
};
