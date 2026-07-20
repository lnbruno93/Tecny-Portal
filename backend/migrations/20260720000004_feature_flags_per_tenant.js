/* eslint-disable camelcase */
/**
 * Feature Flags per-tenant — F1 (Rec proactiva #3 post-audit 2026-07-20).
 *
 * Design doc: docs/design/feature-flags-per-tenant.md
 *
 * ── Contexto ──────────────────────────────────────────────────────────
 *
 * Ya existe `feature_flags` (name PK + enabled + description, migration
 * 20260611000003) con flags GLOBALES (on/off para todos los tenants).
 *
 * Escenarios que hoy NO se pueden hacer:
 *   · Canary rollout: activar feature para 3 tenants confiables, después
 *     full rollout.
 *   · Feature por plan: reventa exclusiva del Pro.
 *   · A/B testing: 50% con nueva UI, 50% con la vieja.
 *   · Kill switch por tenant: un cliente rompe un flow → apagar solo
 *     para él sin redeploy.
 *
 * ── Cambios de este PR (F1) ───────────────────────────────────────────
 *
 * 1. `feature_flags_tenants` — overrides explícitos por (flag, tenant).
 * 2. `feature_flags_plans` — overrides por (flag, plan). Plan es el
 *    string existente en `tenants.plan` ('trial', 'pro', 'enterprise').
 * 3. `feature_flags.rollout_pct` — % de tenants con la feature ON via
 *    hash determinístico (rollout gradual sin tocar código).
 *
 * ── Precedencia del resolver ──────────────────────────────────────────
 *
 *   1. Tenant override      (feature_flags_tenants) — el más específico
 *   2. Plan override        (feature_flags_plans)
 *   3. Rollout %            (feature_flags.rollout_pct + hash tenant_id)
 *   4. Default global       (feature_flags.enabled)
 *
 * Implementado en `backend/src/lib/featureFlags.js` (fase 2 de F1).
 *
 * ── Auditoría ─────────────────────────────────────────────────────────
 *
 * Los overrides por tenant llevan updated_at + updated_by (super-admin
 * que hizo el cambio). El audit_logs granular (payload con prev/next)
 * lo agregan los endpoints de F2 cuando los expongamos.
 *
 * ── Rollback ──────────────────────────────────────────────────────────
 *
 * `down()` DROP las 2 tablas nuevas + REMOVE `rollout_pct`. El sistema
 * queda como el actual (solo global on/off). Cero data loss porque las
 * tablas están vacías al momento del rollback (feature no está en uso).
 * Si se rolleó con datos, restore desde backup B2.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // 1. feature_flags_tenants — overrides explícitos por (flag, tenant).
  //    PK compuesta (flag_name, tenant_id) garantiza unicidad + evita
  //    duplicados sin necesidad de UNIQUE constraint separada.
  //
  //    ON DELETE CASCADE en flag_name: si borramos un flag globalmente,
  //    todos los overrides asociados se van (no queda basura).
  //    ON DELETE CASCADE en tenant_id: si deleteamos un tenant, sus
  //    overrides desaparecen (evita FK huérfana).
  pgm.sql(`
    CREATE TABLE feature_flags_tenants (
      flag_name    VARCHAR(64) NOT NULL REFERENCES feature_flags(name) ON DELETE CASCADE,
      tenant_id    INTEGER     NOT NULL REFERENCES tenants(id)         ON DELETE CASCADE,
      enabled      BOOLEAN     NOT NULL,
      reason       TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by   INTEGER              REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (flag_name, tenant_id)
    );

    -- Index para el lookup del resolver: dado un tenant_id, listar todos
    -- sus overrides activos (para primar cache o auditoría). El PK ya
    -- optimiza el lookup (flag_name, tenant_id) del resolver caliente,
    -- pero este agrega el índice "por tenant" para las listas del admin.
    CREATE INDEX idx_ff_tenants_by_tenant
      ON feature_flags_tenants (tenant_id);
  `);

  // 2. feature_flags_plans — overrides por (flag, plan).
  //    plan_id VARCHAR matchea el enum de `tenants.plan` ('trial', 'pro',
  //    'enterprise', etc.). No FK a una tabla de planes porque hoy los
  //    planes viven como enum implícito en el código (lib/planPricing.js).
  //    Si en el futuro creamos tabla plans, agregar FK acá.
  pgm.sql(`
    CREATE TABLE feature_flags_plans (
      flag_name    VARCHAR(64) NOT NULL REFERENCES feature_flags(name) ON DELETE CASCADE,
      plan_id      VARCHAR(32) NOT NULL,
      enabled      BOOLEAN     NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (flag_name, plan_id)
    );
  `);

  // 3. rollout_pct: valor NULL significa "no rollout, usar enabled". Valor
  //    0-100 significa "hash(flag:tenant) % 100 < rollout_pct → enabled".
  //    Diseño determinístico: mismo tenant + mismo flag = mismo resultado
  //    para siempre (hasta que se cambie el flag).
  pgm.sql(`
    ALTER TABLE feature_flags
      ADD COLUMN rollout_pct INTEGER
        CHECK (rollout_pct IS NULL OR (rollout_pct >= 0 AND rollout_pct <= 100));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE feature_flags DROP COLUMN IF EXISTS rollout_pct;
    DROP TABLE IF EXISTS feature_flags_plans;
    DROP TABLE IF EXISTS feature_flags_tenants;
  `);
};
