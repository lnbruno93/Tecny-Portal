/**
 * Migration: Admin Tenants — schema foundation (#353 Fase 1).
 *
 * Habilita el módulo Super-Admin para que Lucas pueda gestionar tenants
 * (clientes Tecny) desde `admin.tecnyapp.com`. Diseño completo en
 * `docs/ADMIN_TENANTS_DESIGN.md`.
 *
 * Cambios:
 *
 *   1. `users.is_super_admin BOOLEAN` — flag que da acceso al admin app.
 *      Default false. NO se setea via API — solo vía `setSuperAdmin.js`
 *      script (audit trail manual). Bootstrap: Lucas (user id 1) se marca
 *      como super-admin después de aplicar esta migration. Index parcial
 *      para que el lookup `WHERE is_super_admin = true` sea O(super-admins),
 *      no O(users totales).
 *
 *   2. `tenants` — 5 columnas nuevas para gestión:
 *        - `suspended_at TIMESTAMPTZ` — NULL = activo, set = login bloqueado.
 *        - `suspended_reason TEXT` — opcional, para soporte.
 *        - `trial_until DATE` — cuando expira el trial (solo si plan='trial').
 *        - `custom_mrr_usd NUMERIC(10,2)` — pricing custom para enterprise.
 *        - `notes TEXT` — campo libre del admin (CRM-like).
 *
 *      CHECK constraints garantizan consistencia:
 *        - trial_until SOLO puede estar set si plan = 'trial'.
 *        - custom_mrr_usd SOLO puede estar set si plan = 'enterprise'.
 *      Sin estos chequeos, un PATCH mal hecho dejaría datos sin sentido
 *      (ej. plan='pro' + trial_until=2027 → ¿qué quiere decir?).
 *
 *   3. `tenant_admin_actions` — audit trail forense de cambios admin.
 *      Cada PATCH a un tenant (cambio plan, suspend, extend-trial, etc)
 *      inserta una fila acá con before/after JSONB. Sirve para:
 *        - Soporte: "¿quién cambió el plan de Tenant X y cuándo?"
 *        - Forense: investigar churn — qué pasó antes de la baja.
 *        - Compliance: trail completo de acciones administrativas.
 *      Por defecto sin RLS — solo super-admin puede leer/escribir y eso
 *      lo garantiza el middleware del endpoint, no la policy.
 *
 * Reversible: la `down` borra todo lo agregado. Si en prod hay datos
 * (suspensiones reales, notes, audit actions), el `down` los pierde —
 * el operador debe hacer backup antes de revertir si le importa.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. users.is_super_admin
    ALTER TABLE users
      ADD COLUMN is_super_admin BOOLEAN NOT NULL DEFAULT false;

    -- Partial index: super-admins son ínfimos vs total users. Sin parcial,
    -- el index pesa lo mismo que toda la tabla. Con parcial, ocupa <1KB.
    CREATE INDEX idx_users_super_admin
      ON users(id) WHERE is_super_admin = true;

    -- 2. tenants — campos admin
    ALTER TABLE tenants
      ADD COLUMN suspended_at      TIMESTAMPTZ,
      ADD COLUMN suspended_reason  TEXT,
      ADD COLUMN trial_until       DATE,
      ADD COLUMN custom_mrr_usd    NUMERIC(10,2),
      ADD COLUMN notes             TEXT;

    -- CHECK: trial_until solo aplica si plan='trial'. Defensa contra PATCH
    -- inconsistente (ej. cambiar a 'pro' pero olvidar limpiar trial_until).
    ALTER TABLE tenants ADD CONSTRAINT chk_trial_until_only_for_trial
      CHECK (trial_until IS NULL OR plan = 'trial');

    -- CHECK: custom_mrr_usd solo aplica si plan='enterprise'. Los otros planes
    -- tienen precio hardcodeado en lib/planPricing.js.
    ALTER TABLE tenants ADD CONSTRAINT chk_custom_mrr_only_for_enterprise
      CHECK (custom_mrr_usd IS NULL OR plan = 'enterprise');

    -- Index: filtrar tenants suspendidos es operación frecuente del admin
    -- dashboard ("ver activos" / "ver suspendidos"). Partial = solo trackea
    -- los suspendidos (raros).
    CREATE INDEX idx_tenants_suspended
      ON tenants(suspended_at DESC) WHERE suspended_at IS NOT NULL;

    -- Index: tenants en trial — para alertas "trial vence en 3 días".
    CREATE INDEX idx_tenants_trial_until
      ON tenants(trial_until) WHERE trial_until IS NOT NULL;

    -- 3. tenant_admin_actions — audit trail
    CREATE TABLE tenant_admin_actions (
      id                    BIGSERIAL PRIMARY KEY,
      tenant_id             INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      super_admin_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      action                TEXT NOT NULL CHECK (action IN (
        'plan_change',
        'suspend',
        'reactivate',
        'trial_extend',
        'note_update',
        'custom_mrr_update',
        'bootstrap_super_admin'
      )),
      before_state          JSONB,
      after_state           JSONB,
      reason                TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Index principal: query "histórico de acciones admin para tenant X".
    CREATE INDEX idx_tenant_admin_actions_tenant
      ON tenant_admin_actions(tenant_id, created_at DESC);

    -- Index secundario: query "qué hizo el super-admin Y en los últimos N días".
    CREATE INDEX idx_tenant_admin_actions_admin
      ON tenant_admin_actions(super_admin_user_id, created_at DESC);

    -- NO RLS en tenant_admin_actions: el acceso se garantiza por el
    -- middleware requireSuperAdmin en el endpoint, no por policy DB.
    -- Cualquier query a esta tabla DEBE pasar por db.adminQuery() (que usa
    -- el role tecny_admin con BYPASSRLS — defense in depth: incluso si
    -- alguien usara el role app por error, la tabla NO tiene policy que
    -- la oculte por tenant_id, así que vería todo. Eso ES el comportamiento
    -- esperado para audit trail super-admin).
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS tenant_admin_actions;

    ALTER TABLE tenants
      DROP CONSTRAINT IF EXISTS chk_trial_until_only_for_trial,
      DROP CONSTRAINT IF EXISTS chk_custom_mrr_only_for_enterprise;

    DROP INDEX IF EXISTS idx_tenants_suspended;
    DROP INDEX IF EXISTS idx_tenants_trial_until;

    ALTER TABLE tenants
      DROP COLUMN IF EXISTS suspended_at,
      DROP COLUMN IF EXISTS suspended_reason,
      DROP COLUMN IF EXISTS trial_until,
      DROP COLUMN IF EXISTS custom_mrr_usd,
      DROP COLUMN IF EXISTS notes;

    DROP INDEX IF EXISTS idx_users_super_admin;
    ALTER TABLE users DROP COLUMN IF EXISTS is_super_admin;
  `);
};
