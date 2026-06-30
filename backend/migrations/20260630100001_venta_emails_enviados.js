/**
 * Migration: venta_emails_enviados (#475 — comprobante venta retail por email).
 *
 * Tabla de historial / audit de los envíos por email del comprobante PDF de
 * una venta retail. Cada envío (alta y reenvío) inserta una row. El detalle de
 * venta lista esta historia para que el operador vea cuándo / a quién / qué
 * status.
 *
 * Diseño:
 *   - status: 'sent' cuando Resend respondió OK, 'failed' cuando hubo error.
 *     CHECK rígido para que `error_msg` solo sea populado cuando status=failed
 *     (defensa-en-profundidad — el caller respeta el invariante; el CHECK lo
 *     impone igual).
 *   - resend_msg_id: id que devuelve Resend (`result.data.id`). Sirve para
 *     correlacionar con su dashboard si hay queja de bounces / spam. Nullable
 *     porque (a) en modo stub no hay msg id real (se usa 'stub-...') y (b) en
 *     failed no hay tampoco.
 *   - sent_by_user_id: quién apretó el botón (alta o reenvío). FK SET NULL
 *     para no perder la row si el user se elimina (purge GDPR).
 *   - reenvio_de_id: FK auto-referencial al primer envío. NULL para envíos
 *     "primarios" (alta) y populado para reenvíos. Permite armar cadena de
 *     reenvíos si Lucas alguna vez quiere visualizarla (hoy solo se muestra
 *     plano en el detalle).
 *
 * RLS: tenant-scoped estándar. Mismo patrón que el resto de tablas tenantizadas
 * (ej. venta_comprobantes 20260524000003) — FORCE RLS + policy con
 * `current_setting('app.current_tenant')`.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE venta_emails_enviados (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      venta_id        INTEGER NOT NULL REFERENCES ventas(id)  ON DELETE CASCADE,
      email_to        TEXT    NOT NULL,
      sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status          TEXT    NOT NULL CHECK (status IN ('sent','failed')),
      resend_msg_id   TEXT,
      error_msg       TEXT,
      sent_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reenvio_de_id   INTEGER REFERENCES venta_emails_enviados(id) ON DELETE SET NULL,
      -- invariante de consistencia: error_msg solo cuando status='failed'.
      CONSTRAINT chk_error_msg_when_failed
        CHECK ((status = 'failed') OR (status = 'sent' AND error_msg IS NULL))
    );

    -- Lookup principal: "todos los envíos de la venta X, más reciente primero".
    -- Usado por GET /api/ventas/:id/emails-enviados (detalle).
    CREATE INDEX idx_venta_emails_venta_id ON venta_emails_enviados (venta_id, sent_at DESC);

    -- Lookup admin / observabilidad: feed por tenant ordenado por sent_at DESC.
    -- Sirve si se hace un panel "últimos N emails de comprobante del tenant".
    CREATE INDEX idx_venta_emails_tenant_sent ON venta_emails_enviados (tenant_id, sent_at DESC);

    -- RLS estándar (tenant-scoped). FORCE para que ni siquiera el role owner
    -- pueda saltarse — solo BYPASSRLS (admin pool) ve cross-tenant.
    ALTER TABLE venta_emails_enviados ENABLE ROW LEVEL SECURITY;
    ALTER TABLE venta_emails_enviados FORCE  ROW LEVEL SECURITY;
    CREATE POLICY venta_emails_tenant_isolation ON venta_emails_enviados
      USING (tenant_id = current_setting('app.current_tenant', true)::integer);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP POLICY IF EXISTS venta_emails_tenant_isolation ON venta_emails_enviados;
    DROP INDEX IF EXISTS idx_venta_emails_tenant_sent;
    DROP INDEX IF EXISTS idx_venta_emails_venta_id;
    DROP TABLE IF EXISTS venta_emails_enviados;
  `);
};
