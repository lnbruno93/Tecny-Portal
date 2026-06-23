/**
 * Migration: proyecciones_mensuales — bruto proyectado del mes por tenant.
 *
 * Contexto:
 *   Feature nueva — módulo "Sanidad del Negocio" (decidido con Lucas
 *   2026-06-23). El módulo cruza:
 *     - Gastos proyectados: ya viven en `egresos_recurrentes` (existente).
 *     - Gastos reales:      ya viven en `egresos` con estado='pagado'.
 *     - Bruto real del mes: sale de `ventas` (no canceladas).
 *     - Bruto PROYECTADO:   no existe en ningún lado todavía — esta tabla.
 *
 *   Cada mes el dueño del tenant carga UN número: "este mes espero
 *   facturar X USD". El módulo lo compara contra el bruto real para
 *   mostrar desvío.
 *
 * Esquema:
 *   tenant_id              INT  FK→tenants ON DELETE CASCADE (un tenant
 *                          borrado pierde sus proyecciones, no quedan
 *                          huérfanas)
 *   periodo                TEXT 'YYYY-MM' (mismo formato que usa el resto
 *                          del portal — egresos.periodo, dashboards, etc.)
 *                          CHECK valida el formato a nivel DB para que un
 *                          bug en el backend no inserte basura.
 *   bruto_proyectado_usd   NUMERIC(14,2) >= 0 (un input >= 0; cero es
 *                          válido y significa "mes sin facturación esperada")
 *   created_at, updated_at TIMESTAMPTZ default NOW
 *
 *   PK COMPUESTA (tenant_id, periodo): a lo sumo una fila por tenant/mes.
 *   El endpoint PUT hace UPSERT con ON CONFLICT.
 *
 * RLS:
 *   Mismo patrón estricto del resto del portal (fail-closed sin fallback
 *   NULL, ver 20260615000002 + 20260616000002). USING + WITH CHECK con
 *   current_setting('app.current_tenant')::int.
 *
 * Default conservador:
 *   No seedeamos NADA. Tenants nuevos arrancan sin filas. El módulo
 *   muestra "—" en el bruto proyectado de meses sin fila — el usuario lo
 *   carga cuando quiera (input inline en la pantalla).
 *
 * Reversible: down dropea la tabla. No hay datos críticos (es UX/análisis,
 * no contabilidad). Si en prod hay tenants con proyecciones cargadas las
 * pierden — backup antes del down.
 */

exports.shorthands = undefined;

const PREDICATE_CLOSED = `tenant_id = current_setting('app.current_tenant', true)::int`;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS proyecciones_mensuales (
      tenant_id              INTEGER       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      periodo                TEXT          NOT NULL,
      bruto_proyectado_usd   NUMERIC(14,2) NOT NULL CHECK (bruto_proyectado_usd >= 0),
      created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, periodo),
      CONSTRAINT proyecciones_mensuales_periodo_format
        CHECK (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
    );

    COMMENT ON TABLE proyecciones_mensuales IS
      'Bruto proyectado por tenant por mes — input manual del módulo Sanidad del Negocio. Una fila por (tenant_id, periodo).';
    COMMENT ON COLUMN proyecciones_mensuales.periodo IS
      'Mes en formato YYYY-MM (ej: "2026-06"). Mismo formato que egresos.periodo.';
    COMMENT ON COLUMN proyecciones_mensuales.bruto_proyectado_usd IS
      'Lo que el operador espera facturar ese mes, en USD. Se compara contra ventas.total_usd reales para mostrar desvío en el dashboard de Sanidad.';

    -- Trigger para updated_at automático en UPSERT/UPDATE. El portal ya
    -- tiene este pattern en otras tablas — replicamos por consistencia.
    CREATE OR REPLACE FUNCTION trg_proyecciones_mensuales_updated_at()
    RETURNS TRIGGER AS $func$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;

    CREATE TRIGGER proyecciones_mensuales_set_updated_at
      BEFORE UPDATE ON proyecciones_mensuales
      FOR EACH ROW EXECUTE FUNCTION trg_proyecciones_mensuales_updated_at();

    -- RLS estricto, fail-closed (sin fallback NULL — ver TANDA 0c #294).
    ALTER TABLE proyecciones_mensuales ENABLE ROW LEVEL SECURITY;
    ALTER TABLE proyecciones_mensuales FORCE ROW LEVEL SECURITY;

    CREATE POLICY tenant_isolation ON proyecciones_mensuales
      FOR ALL TO PUBLIC
      USING (${PREDICATE_CLOSED})
      WITH CHECK (${PREDICATE_CLOSED});
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS proyecciones_mensuales;
    DROP FUNCTION IF EXISTS trg_proyecciones_mensuales_updated_at();
  `);
};
