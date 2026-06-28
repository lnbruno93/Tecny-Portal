/**
 * Migration: Red B2B F5 — email_prefs per-tenant + grant permission.
 *
 * Diseño en docs/design/red-b2b-cross-tenant.md sección 8.F5 + decisión #13
 * ("Email cross-tenant: sí para 5 events críticos, default ON, gate por
 *  config del tenant").
 *
 * Decisión durable: **jsonb en tenants** vs tabla nueva.
 *
 *   Optamos por una columna JSONB `red_b2b_email_prefs` en `tenants` por:
 *     1. Cardinalidad 1-a-1 con tenant (no es multi-row, es una bolsa de flags).
 *     2. Read-modify-write atómico sin JOIN — el lookup de prefs siempre va
 *        de la mano con el lookup del tenant para el email destinatario.
 *     3. No necesitamos índices por flag (no queremos "tenants con X=false").
 *     4. Schema-less: agregar un 6° flag (ej. partnership_revoked en F6) es
 *        UPDATE puntual desde código sin migration.
 *     5. Backup/restore atomic con tenants. Cero churn operativo.
 *
 *   Tabla nueva sería justificada si:
 *     - tuviéramos prefs por usuario (no es el caso — owner-only en F5).
 *     - quisiéramos audit por cambio (lo manejamos via tenant_admin_actions
 *       en futuras iteraciones si hace falta).
 *
 * Default value: TODOS los flags arrancan en true. Decisión #13 dice "default
 * ON" → el operador puede desactivar puntualmente desde Config si los emails
 * molestan. Más viralidad / menos sorpresa al recibir la primera operación.
 *
 * 5 flags (matchean los 5 events que mandan email — los otros 5 types de
 * cross_tenant_notifications quedan solo in-app):
 *   - invitation_received
 *   - invitation_accepted
 *   - operation_received
 *   - operation_cancelled
 *   - payment_received
 *
 * NOTA sobre `cross_tenant_notifications` permissions:
 *   La tabla ya existe desde F1 (migration 20260627000001). En este F5
 *   agregamos endpoints GET/POST sobre ella — el role `ipro_app` ya tiene
 *   GRANT SELECT/INSERT/UPDATE/DELETE sobre todas las tablas via el GRANT
 *   global de migrations base. No necesitamos GRANT extra acá.
 *
 * Reversible: down dropea la columna. Si en producción algún tenant tenía
 * config customizada, se pierde — riesgo aceptable porque default es true
 * y el feature es nuevo (no hay tenants con prefs reales aún).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Default JSONB con los 5 flags arrancando en TRUE (decisión #13).
    -- Stored as jsonb (no json) para indexable / operador @> / GIN si lo
    -- necesitáramos en el futuro. Per ahora ningún query lo indexa — el
    -- lookup va siempre por tenant_id (PK).
    ALTER TABLE tenants
      ADD COLUMN red_b2b_email_prefs JSONB NOT NULL
        DEFAULT '{
          "invitation_received":  true,
          "invitation_accepted":  true,
          "operation_received":   true,
          "operation_cancelled":  true,
          "payment_received":     true
        }'::jsonb;

    COMMENT ON COLUMN tenants.red_b2b_email_prefs IS
      'Red B2B F5: per-tenant flags para gating de emails cross-tenant. 5 booleans (uno por type). Default true. Modificable via PATCH /api/red-b2b/config/email-prefs.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants DROP COLUMN IF EXISTS red_b2b_email_prefs;
  `);
};
