/**
 * Migration: egresos_recurrentes_overrides — presupuesto mensual variable por
 * recurrente.
 *
 * Contexto:
 *   El módulo Sanidad cruza el bruto proyectado vs gastos proyectados (los
 *   recurrentes activos). Hasta hoy `egresos_recurrentes.monto` era ÚNICO
 *   para todo el rango — si en marzo el alquiler subía de $1000 a $1200,
 *   editar el monto reescribía la historia: enero y febrero pasaban a
 *   mostrar $1200 también, perdiendo la realidad de esos meses.
 *
 *   Esta tabla habilita "overrides" por (recurrente, mes). Sanidad resuelve
 *   el presupuesto del mes con la regla:
 *     1. Si hay override para (recurrente_id, periodo) → usar ese monto.
 *     2. Si no → usar el `monto` default del recurrente (path actual).
 *
 *   El 80% de los casos sigue sin overrides (alquiler $1200/mes constante).
 *   Para los cambios puntuales (aumento salarial, ajuste de alquiler, etc.)
 *   se agrega un override del mes-desde-el-cual cambia y los meses
 *   anteriores quedan intactos.
 *
 * Esquema:
 *   tenant_id      INT  FK→tenants ON DELETE CASCADE
 *   recurrente_id  INT  FK→egresos_recurrentes ON DELETE CASCADE
 *                  (si se borra el recurrente, sus overrides también — no
 *                  tienen sentido huérfanos)
 *   periodo        TEXT 'YYYY-MM' (mismo formato que el resto del portal)
 *   monto          NUMERIC(12,2) >= 0
 *   moneda         TEXT ('USD'|'ARS'|'USDT') — independiente del recurrente,
 *                  permite cambiar la moneda con la que se proyecta
 *                  (escenario real: alquiler dolarizado que pasa a pesos).
 *   tc             NUMERIC(14,4) — solo relevante si moneda='ARS' (mismo
 *                  patrón que egresos_recurrentes.tc, ver 20260531000001).
 *   created_at,
 *   updated_at     TIMESTAMPTZ
 *
 *   PK COMPUESTA (tenant_id, recurrente_id, periodo): a lo sumo un override
 *   por recurrente/mes. El endpoint PUT hace UPSERT con ON CONFLICT.
 *
 * RLS:
 *   Igual que las otras tablas Sanidad (proyecciones_mensuales): fail-closed
 *   sin fallback NULL.
 *
 * Reversible: down dropea la tabla. Si hay overrides cargados en prod, se
 * pierden — Sanidad vuelve a usar el monto único del recurrente para todos
 * los meses.
 */

exports.shorthands = undefined;

const PREDICATE_CLOSED = `tenant_id = current_setting('app.current_tenant', true)::int`;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS egresos_recurrentes_overrides (
      tenant_id      INTEGER       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      recurrente_id  INTEGER       NOT NULL REFERENCES egresos_recurrentes(id) ON DELETE CASCADE,
      periodo        TEXT          NOT NULL,
      monto          NUMERIC(12,2) NOT NULL CHECK (monto >= 0),
      moneda         TEXT          NOT NULL DEFAULT 'USD' CHECK (moneda IN ('USD','ARS','USDT')),
      tc             NUMERIC(14,4),
      created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, recurrente_id, periodo),
      CONSTRAINT egresos_recurrentes_overrides_periodo_format
        CHECK (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
    );

    COMMENT ON TABLE egresos_recurrentes_overrides IS
      'Override del monto presupuestado de un recurrente para un mes específico. Sanidad usa este monto si existe; si no, cae al default del recurrente.';
    COMMENT ON COLUMN egresos_recurrentes_overrides.periodo IS
      'Mes en formato YYYY-MM (ej: "2026-06"). Mismo formato que egresos.periodo y proyecciones_mensuales.periodo.';
    COMMENT ON COLUMN egresos_recurrentes_overrides.moneda IS
      'Moneda del override — puede diferir del recurrente padre (caso: alquiler dolarizado que pasa a pesos un mes específico).';
    COMMENT ON COLUMN egresos_recurrentes_overrides.tc IS
      'Tipo de cambio ARS→USD aplicado al override. Solo relevante si moneda=ARS. NULL si moneda=USD o USDT.';

    -- Índice para acelerar el lookup por (tenant, rango de periodos) que
    -- hace Sanidad al cargar la grilla. La PK ya cubre (tenant, recurrente,
    -- periodo) pero queremos buscar por rango de periodo dentro del tenant.
    CREATE INDEX IF NOT EXISTS idx_eror_tenant_periodo
      ON egresos_recurrentes_overrides (tenant_id, periodo);

    -- Trigger updated_at (mismo patrón que proyecciones_mensuales).
    CREATE OR REPLACE FUNCTION trg_egresos_recurrentes_overrides_updated_at()
    RETURNS TRIGGER AS $func$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql;

    CREATE TRIGGER egresos_recurrentes_overrides_set_updated_at
      BEFORE UPDATE ON egresos_recurrentes_overrides
      FOR EACH ROW EXECUTE FUNCTION trg_egresos_recurrentes_overrides_updated_at();

    -- RLS estricto, fail-closed.
    ALTER TABLE egresos_recurrentes_overrides ENABLE ROW LEVEL SECURITY;
    ALTER TABLE egresos_recurrentes_overrides FORCE ROW LEVEL SECURITY;

    CREATE POLICY tenant_isolation ON egresos_recurrentes_overrides
      FOR ALL TO PUBLIC
      USING (${PREDICATE_CLOSED})
      WITH CHECK (${PREDICATE_CLOSED});
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS egresos_recurrentes_overrides;
    DROP FUNCTION IF EXISTS trg_egresos_recurrentes_overrides_updated_at();
  `);
};
