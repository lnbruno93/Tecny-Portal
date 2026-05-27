// Bug: al borrar un usuario (soft-delete) no se podía recrear con el mismo username
// (ni email), porque el UNIQUE total de la columna ignoraba deleted_at y la fila
// borrada seguía "ocupando" el valor. Se reemplazan por índices únicos PARCIALES
// que solo aplican entre usuarios activos.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username_activo
      ON users (username) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_activo
      ON users (email) WHERE deleted_at IS NULL AND email IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS uq_users_username_activo;
    DROP INDEX IF EXISTS uq_users_email_activo;
    ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
    ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
  `);
};
