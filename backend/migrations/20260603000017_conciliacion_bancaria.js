/* eslint-disable camelcase */
/**
 * Migración — Conciliación bancaria
 *
 * Tablas nuevas:
 *   - conciliaciones: una "sesión" de conciliación (caja + período + archivo).
 *   - conciliacion_lineas: cada fila del extracto bancario importado.
 *     Estado por línea: pending | matched | ignored. matched_caja_mov_id es FK
 *     al movimiento de caja correspondiente.
 *
 * Campos nuevos en caja_movimientos:
 *   - conciliado_en TIMESTAMPTZ: cuándo se cerró la conciliación que lo confirmó.
 *   - conciliacion_id INTEGER FK: qué conciliación lo cerró.
 *
 * Política:
 *   - Mientras conciliado_en IS NULL, el movimiento puede aparecer en una conciliación.
 *   - Cuando una conciliación se cierra, todos sus movimientos matched quedan
 *     "congelados" (conciliado_en = NOW()).
 *   - Borrar una conciliación (soft-delete) liberá sus movimientos (conciliado_en
 *     vuelve a NULL en la lógica del route DELETE).
 *
 * Permiso: 'cajas' (reuse del módulo Cajas).
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Sesión de conciliación
    CREATE TABLE IF NOT EXISTS conciliaciones (
      id              SERIAL PRIMARY KEY,
      caja_id         INTEGER NOT NULL REFERENCES metodos_pago(id) ON DELETE RESTRICT,
      fecha_desde     DATE NOT NULL,
      fecha_hasta     DATE NOT NULL,
      archivo_nombre  TEXT,
      archivo_hash    TEXT,
      cerrado_en      TIMESTAMPTZ,
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      deleted_at      TIMESTAMPTZ,
      CONSTRAINT conciliaciones_fecha_check CHECK (fecha_desde <= fecha_hasta)
    );

    CREATE INDEX IF NOT EXISTS idx_conciliaciones_caja
      ON conciliaciones (caja_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_conciliaciones_periodo
      ON conciliaciones (fecha_desde, fecha_hasta) WHERE deleted_at IS NULL;

    -- Línea del extracto bancario importado
    CREATE TABLE IF NOT EXISTS conciliacion_lineas (
      id                  SERIAL PRIMARY KEY,
      conciliacion_id     INTEGER NOT NULL REFERENCES conciliaciones(id) ON DELETE CASCADE,
      fecha               DATE NOT NULL,
      monto               NUMERIC(14,2) NOT NULL,
      -- monto positivo = ingreso (crédito en la cuenta); negativo = egreso (débito).
      descripcion         TEXT,
      matched_caja_mov_id INTEGER REFERENCES caja_movimientos(id) ON DELETE SET NULL,
      ignorada            BOOLEAN NOT NULL DEFAULT false,
      nota                TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_concil_lineas_conc
      ON conciliacion_lineas (conciliacion_id);
    CREATE INDEX IF NOT EXISTS idx_concil_lineas_matched
      ON conciliacion_lineas (matched_caja_mov_id) WHERE matched_caja_mov_id IS NOT NULL;

    -- Estado de conciliación en cada movimiento de caja
    ALTER TABLE caja_movimientos
      ADD COLUMN IF NOT EXISTS conciliado_en      TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS conciliacion_id    INTEGER REFERENCES conciliaciones(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_caja_mov_conciliado
      ON caja_movimientos (conciliado_en) WHERE conciliado_en IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_caja_mov_conciliado;
    ALTER TABLE caja_movimientos
      DROP COLUMN IF EXISTS conciliacion_id,
      DROP COLUMN IF EXISTS conciliado_en;

    DROP INDEX IF EXISTS idx_concil_lineas_matched;
    DROP INDEX IF EXISTS idx_concil_lineas_conc;
    DROP TABLE IF EXISTS conciliacion_lineas;

    DROP INDEX IF EXISTS idx_conciliaciones_periodo;
    DROP INDEX IF EXISTS idx_conciliaciones_caja;
    DROP TABLE IF EXISTS conciliaciones;
  `);
};
