// Recolección automática (Fase 2): vincula un contacto de la agenda con el
// registro de origen (proveedor, cliente B2B, etc.) para poder sincronizar de
// forma idempotente (sin duplicar) cuando ese registro se crea o edita.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE contactos
      ADD COLUMN IF NOT EXISTS origen_ref_tabla TEXT,
      ADD COLUMN IF NOT EXISTS origen_ref_id    INTEGER;

    -- Un único contacto por registro de origen (idempotencia del upsert).
    -- Parcial: solo aplica a contactos vinculados (origen_ref_id NOT NULL),
    -- los manuales quedan libres.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contactos_origen_ref
      ON contactos (origen_ref_tabla, origen_ref_id)
      WHERE origen_ref_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS uq_contactos_origen_ref;
    ALTER TABLE contactos
      DROP COLUMN IF EXISTS origen_ref_tabla,
      DROP COLUMN IF EXISTS origen_ref_id;
  `);
};
