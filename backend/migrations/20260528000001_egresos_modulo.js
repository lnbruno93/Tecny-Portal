// Módulo Egresos (bajo Cajas): categorías + recurrentes + estado pendiente/pagado.
// Extiende la tabla `egresos` existente (no la reemplaza) y suma dos tablas de apoyo.
exports.up = (pgm) => {
  pgm.sql(`
    -- Categorías de egreso (gestionables)
    CREATE TABLE IF NOT EXISTS egreso_categorias (
      id         SERIAL PRIMARY KEY,
      nombre     TEXT NOT NULL,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_egreso_cat_nombre
      ON egreso_categorias (lower(nombre)) WHERE deleted_at IS NULL;

    -- Categorías base
    INSERT INTO egreso_categorias (nombre)
    SELECT v FROM (VALUES ('Alquiler'),('Expensas'),('Sueldos'),('Servicios'),('Impuestos'),('Otros')) AS x(v)
    WHERE NOT EXISTS (SELECT 1 FROM egreso_categorias);

    -- Plantillas de egresos recurrentes (mensuales)
    CREATE TABLE IF NOT EXISTS egresos_recurrentes (
      id             SERIAL PRIMARY KEY,
      categoria_id   INTEGER REFERENCES egreso_categorias(id) ON DELETE SET NULL,
      concepto       TEXT NOT NULL,
      monto          NUMERIC(12,2) NOT NULL DEFAULT 0,
      moneda         TEXT NOT NULL DEFAULT 'USD' CHECK (moneda IN ('USD','ARS','USDT')),
      metodo_pago_id INTEGER REFERENCES metodos_pago(id) ON DELETE SET NULL,
      dia_del_mes    INTEGER NOT NULL DEFAULT 1 CHECK (dia_del_mes BETWEEN 1 AND 31),
      activo         BOOLEAN NOT NULL DEFAULT true,
      deleted_at     TIMESTAMPTZ,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_egresos_recurrentes_activo
      ON egresos_recurrentes (activo) WHERE deleted_at IS NULL;

    -- Extender egresos: categoría, estado, vínculo a recurrente y período
    ALTER TABLE egresos
      ADD COLUMN IF NOT EXISTS categoria_id  INTEGER REFERENCES egreso_categorias(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS estado        TEXT NOT NULL DEFAULT 'pagado' CHECK (estado IN ('pendiente','pagado')),
      ADD COLUMN IF NOT EXISTS recurrente_id INTEGER REFERENCES egresos_recurrentes(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS periodo       TEXT;  -- 'YYYY-MM' para egresos generados por un recurrente

    -- Evita generar dos veces el mismo recurrente en un período
    CREATE UNIQUE INDEX IF NOT EXISTS uq_egreso_recurrente_periodo
      ON egresos (recurrente_id, periodo)
      WHERE recurrente_id IS NOT NULL AND deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_egresos_estado   ON egresos (estado)       WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_egresos_categoria ON egresos (categoria_id) WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_egresos_categoria;
    DROP INDEX IF EXISTS idx_egresos_estado;
    DROP INDEX IF EXISTS uq_egreso_recurrente_periodo;
    ALTER TABLE egresos
      DROP COLUMN IF EXISTS categoria_id,
      DROP COLUMN IF EXISTS estado,
      DROP COLUMN IF EXISTS recurrente_id,
      DROP COLUMN IF EXISTS periodo;
    DROP TABLE IF EXISTS egresos_recurrentes;
    DROP TABLE IF EXISTS egreso_categorias;
  `);
};
