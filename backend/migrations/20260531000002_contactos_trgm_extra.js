// La búsqueda de contactos hace ILIKE sobre nombre, apellido, email, teléfono y DNI.
// Ya hay GIN trgm en nombre/apellido (migración 000012); sumamos los otros 3 para
// que el ILIKE use índice y no fuerce seq scan en agendas grandes.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_contactos_email_trgm    ON contactos USING GIN (email gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_contactos_telefono_trgm ON contactos USING GIN (telefono gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_contactos_dni_trgm      ON contactos USING GIN (dni gin_trgm_ops);
  `);
};
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_contactos_email_trgm;
    DROP INDEX IF EXISTS idx_contactos_telefono_trgm;
    DROP INDEX IF EXISTS idx_contactos_dni_trgm;
  `);
};
