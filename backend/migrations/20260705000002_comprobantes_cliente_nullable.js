/* eslint-disable camelcase */
/**
 * Comprobantes: la columna `cliente` pasa a nullable.
 *
 * Motivo (bug prod 2026-06-26 → 2026-07-04, detectado via Sentry issue
 * 7577814718):
 *
 *   `POST /api/ventas/:id/comprobantes` explota con
 *   `null value in column "cliente" of relation "comprobantes" violates
 *   not-null constraint` cuando la venta origen tiene `cliente_nombre = NULL`.
 *
 *   La lógica en `lib/financiera.js:156` hace:
 *     SELECT cliente_nombre FROM ventas WHERE id = $1
 *     INSERT INTO comprobantes(...cliente...) VALUES (..., v[0].cliente_nombre ?? null, ...)
 *
 *   Con `cliente_nombre` en NULL, el INSERT pasa NULL a `comprobantes.cliente`
 *   que era NOT NULL desde la migration inicial → 500 al usuario.
 *
 * Impacto medido en prod (iostoreuy tenant, snapshot 2026-07-05):
 *   · 5 de 23 ventas tienen `ventas.cliente_nombre = NULL` (venta rápida
 *     cash sin identificar).
 *   · 2 de esas 5 tienen pago Financiera → el user intenta subir el
 *     comprobante y falla en cascada. Ha fallado 7 veces con 3 usuarios
 *     afectados.
 *
 * Fix elegido — nullable:
 *
 *   Un comprobante de venta anónima es semánticamente válido (cliente
 *   walk-in que no dio nombre). Persistimos NULL en `comprobantes.cliente`
 *   en vez de forzar strings placeholder que corrompen la data.
 *
 *   Consumers verificados (grep 2026-07-05):
 *     · Backend `routes/comprobantes.js`: ILIKE con NULL es no-op (no rompe),
 *       SELECTs devuelven NULL crudo, POST/PATCH acepta null en body, export
 *       CSV usa `c.cliente || 'sin-cliente'` para slug.
 *     · Frontend `Financiera.jsx`: usa `c.cliente?.toLowerCase()` (safe),
 *       forms usan `c.cliente || ''`. Los renders directos `{c.cliente}`
 *       ahora renderean vacío — se cambia en el mismo PR a "Sin cliente".
 *
 * Alternativas descartadas:
 *   · `?? 'Sin cliente'` en el INSERT → mete data placeholder que después
 *     aparece en búsquedas y exports como si fuera un cliente real.
 *   · Bloquear en Zod que `cliente_nombre` sea obligatorio en ventas →
 *     rompe UX de venta rápida cash (feature real que Lucas usa).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE comprobantes ALTER COLUMN cliente DROP NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Antes de restablecer NOT NULL: convertir NULLs existentes a placeholder
    -- para no romper el ALTER. La data queda "sellada" con esta señal.
    UPDATE comprobantes SET cliente = '(sin cliente)' WHERE cliente IS NULL;
    ALTER TABLE comprobantes ALTER COLUMN cliente SET NOT NULL;
  `);
};
