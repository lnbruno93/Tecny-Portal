/**
 * UNIQUE constraint en caja_movimientos para proteger el invariante del ledger:
 *   "como mucho 1 movimiento ACTIVO por (ref_tabla, ref_id, caja_id, tipo)".
 *
 * Hoy el invariante lo garantiza solo la convención de código (reverse + repost
 * en `lib/cajaLedger.js`). Cualquier bug o módulo nuevo que olvide reverse
 * duplica saldos sin que la DB lo detecte.
 *
 * Antes de crear el índice único, hacemos un soft-delete defensivo de duplicados
 * conservando solo el más reciente: si por una concurrencia previa quedaron
 * (ref_tabla, ref_id, caja_id, tipo) duplicados entre activos, se preservan los
 * de mayor `id` y se marcan como deleted_at los más viejos. Operación idempotente
 * (si no hay dups, no toca nada).
 */
exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Limpieza defensiva: si hay duplicados activos por (ref_tabla, ref_id, caja_id, tipo),
    --    conservamos el de mayor id y soft-deleteamos los demás.
    WITH dups AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY ref_tabla, ref_id, caja_id, tipo
        ORDER BY id DESC
      ) AS rn
      FROM caja_movimientos
      WHERE deleted_at IS NULL
        AND ref_tabla IS NOT NULL
        AND ref_id IS NOT NULL
    )
    UPDATE caja_movimientos cm
       SET deleted_at = NOW()
      FROM dups
     WHERE cm.id = dups.id
       AND dups.rn > 1;
  `);

  pgm.sql(`
    -- 2. UNIQUE partial: como mucho 1 movimiento activo por (origen, caja, tipo).
    --    'tipo' está incluido porque un mismo origen podría querer postear ingreso+egreso
    --    (no es el caso hoy, pero deja la puerta abierta sin perder integridad).
    CREATE UNIQUE INDEX IF NOT EXISTS uq_caja_mov_origen_activo
      ON caja_movimientos (ref_tabla, ref_id, caja_id, tipo)
      WHERE deleted_at IS NULL
        AND ref_tabla IS NOT NULL
        AND ref_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS uq_caja_mov_origen_activo');
  // El soft-delete de duplicados no se revierte (no hay forma segura).
};
