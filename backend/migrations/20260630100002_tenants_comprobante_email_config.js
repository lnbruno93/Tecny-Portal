/**
 * Migration: tenants.comprobante_email_footer (#475 — footer custom per tenant).
 *
 * Footer plain-text custom para el body del email de comprobante de venta
 * retail. El operador (super-admin) lo setea desde el back office. NULL =
 * usar el footer default ("Gracias por confiar en {tenant.nombre} —
 * powered by Tecny").
 *
 * Decisión durable:
 *   - Plain text (no HTML). Razones:
 *       (a) Evita XSS al renderizar — el footer va inline en el HTML del email
 *           sin escape sería un vector abierto. Mantener TEXT obliga al render
 *           a escapar antes de inyectar (lo hace `_esc` en email.js).
 *       (b) Lucas pidió "preview de cómo se ve" — con plain-text es trivial,
 *           con HTML habría que sandboxear el preview con dompurify, etc.
 *   - Max 500 chars (enforced en Zod, no a nivel DB). 500 chars son ~10 líneas
 *     de texto = más que suficiente para datos de contacto + tagline + redes.
 *     Sin CHECK constraint a nivel DB porque el cap es "soft policy" — si
 *     mañana queremos subir a 1000, no quiero migración. Zod en el endpoint
 *     es la frontera.
 *   - Default NULL (no string vacío). NULL = "no configurado, usar default".
 *     String vacío = "el operador explícitamente quiso footer vacío" — pero
 *     no es un caso interesante hoy (la UI fuerza set-to-null cuando trim()
 *     da empty). Mantenemos NULL como única forma de "no override".
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants
      ADD COLUMN comprobante_email_footer TEXT DEFAULT NULL;

    COMMENT ON COLUMN tenants.comprobante_email_footer IS
      'Footer custom para emails de comprobante de venta retail (#475). Plain text, max 500 chars (enforced via Zod). NULL = footer default del portal.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants DROP COLUMN IF EXISTS comprobante_email_footer;
  `);
};
