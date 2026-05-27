// Simplifica Tarjetas: la comisión vive en el método de pago (caja marcada como
// tarjeta) y los movimientos se agrupan por ese método. Se elimina el esquema
// entidad/plan (no se configura nada dentro de Tarjetas; todo arranca en Cajas).
exports.up = (pgm) => {
  pgm.sql(`
    -- % de comisión de la financiera, por método de pago tarjeta
    ALTER TABLE metodos_pago ADD COLUMN IF NOT EXISTS comision_pct NUMERIC(6,3);

    -- El movimiento de tarjeta se agrupa por el método de pago (la "tarjeta")
    ALTER TABLE tarjeta_movimientos ADD COLUMN IF NOT EXISTS metodo_pago_id INTEGER REFERENCES metodos_pago(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_tarjeta_mov_metodo
      ON tarjeta_movimientos (metodo_pago_id, fecha DESC, id DESC) WHERE deleted_at IS NULL;

    -- Quitar el esquema entidad/plan (ya no se usa)
    ALTER TABLE metodos_pago      DROP COLUMN IF EXISTS tarjeta_entidad_id;
    ALTER TABLE metodos_pago      DROP COLUMN IF EXISTS tarjeta_plan_id;
    ALTER TABLE tarjeta_movimientos DROP COLUMN IF EXISTS entidad_id;
    ALTER TABLE tarjeta_movimientos DROP COLUMN IF EXISTS plan_id;
    DROP TABLE IF EXISTS tarjeta_planes;
    DROP TABLE IF EXISTS tarjeta_entidades;
  `);
};

exports.down = (pgm) => {
  // Rollback best-effort: recrea las tablas vacías y las columnas previas.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS tarjeta_entidades (
      id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, activo BOOLEAN NOT NULL DEFAULT true,
      deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tarjeta_planes (
      id SERIAL PRIMARY KEY, entidad_id INTEGER REFERENCES tarjeta_entidades(id) ON DELETE CASCADE,
      nombre TEXT NOT NULL, pct NUMERIC(6,3) NOT NULL DEFAULT 0, activo BOOLEAN NOT NULL DEFAULT true,
      deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE metodos_pago ADD COLUMN IF NOT EXISTS tarjeta_entidad_id INTEGER REFERENCES tarjeta_entidades(id) ON DELETE SET NULL;
    ALTER TABLE metodos_pago ADD COLUMN IF NOT EXISTS tarjeta_plan_id INTEGER REFERENCES tarjeta_planes(id) ON DELETE SET NULL;
    ALTER TABLE tarjeta_movimientos ADD COLUMN IF NOT EXISTS entidad_id INTEGER REFERENCES tarjeta_entidades(id);
    ALTER TABLE tarjeta_movimientos ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES tarjeta_planes(id);
    DROP INDEX IF EXISTS idx_tarjeta_mov_metodo;
    ALTER TABLE tarjeta_movimientos DROP COLUMN IF EXISTS metodo_pago_id;
    ALTER TABLE metodos_pago DROP COLUMN IF EXISTS comision_pct;
  `);
};
