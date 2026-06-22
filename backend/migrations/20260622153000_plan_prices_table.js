/**
 * Migration: plan_prices table (Sub-fase C.1 #353).
 *
 * Mueve los precios de los planes de Tecny SaaS de hardcoded en
 * `lib/planPricing.js` a una tabla editable desde el admin app.
 *
 * Motivación:
 *   Hasta ahora, cambiar un precio requería editar planPricing.js +
 *   Landing.jsx + redeploy (backend + frontend). Con esta tabla:
 *     - Lucas edita desde admin.tecnyapp.com → /planes (UI en C.1.3)
 *     - El backend refresca cache cada 5 min sin redeploy
 *     - La landing fetchea endpoint público `/api/public/pricing` (C.1.4)
 *     - El admin Resumen muestra MRR con el precio nuevo automáticamente
 *
 * Cambios:
 *
 *   1. `plan_prices` — config global de pricing:
 *      - `plan` PRIMARY KEY: slug del plan (mismo conjunto cerrado que
 *        `tenants.plan`: trial | starter | pro | enterprise)
 *      - `price_usd NUMERIC(10,2)` NULL para enterprise (custom per-tenant
 *        en `tenants.custom_mrr_usd`)
 *      - `active BOOLEAN` para soft-disable (no borrar registros: si
 *        Lucas decide retirar un plan, lo marca inactive y los tenants
 *        existentes en ese plan siguen funcionando con el último precio
 *        conocido en cache)
 *      - `notes TEXT` libre — útil para auditoría manual ("subido 10%
 *        por inflación junio 2026")
 *      - `updated_at` + `updated_by` (FK users) — trail básico; el audit
 *        forense detallado va en `tenant_admin_actions` con before/after
 *      - Sin RLS: es config global de la plataforma. Pool app (`ipro_app`)
 *        necesita SELECT para que el cache de planPricing.js se primee en
 *        startup. Pool admin (`tecny_admin`) tiene CRUD via BYPASSRLS.
 *
 *   2. Seed inicial: los valores actuales de planPricing.js (trial=0,
 *      starter=39, pro=189, enterprise=NULL). Sin esto, el cache del
 *      backend se quedaría vacío post-migration y MRR mostraría 0
 *      en el período entre deploy + primer UPDATE manual.
 *
 *   3. `tenant_admin_actions` — agregar `'plan_price_change'` al CHECK
 *      enum. Los endpoint admin PATCH que cambien precios van a insertar
 *      acciones con este `action` value (action es global, no per-tenant
 *      — pero la tabla acepta `tenant_id` NULL... no, tiene NOT NULL.
 *      Decisión: insertar con tenant_id=1 (Tecny — el tenant del operador)
 *      como anchor. Es config global pero queda ligado al super-admin que
 *      lo hizo, en el contexto de su propio tenant. Mejor opción que
 *      cambiar el schema para aceptar tenant_id NULL ahora — eso es feature
 *      separada si aparece el caso).
 *
 * Reversible: la `down` borra la tabla y revierte el CHECK enum (sin las
 * filas con action='plan_price_change' que existan — borrarlas si las hay
 * antes de revertir).
 *
 * Compat con planPricing.js actual:
 *   La constante `PLAN_PRICES_USD` queda como fallback en código (los
 *   mismos valores del seed) para el caso edge donde el cache no se
 *   pudo primar (DB down al startup, p.ej.). En operación normal, el
 *   cache se llena en startup desde esta tabla.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. plan_prices — config global de precios
    CREATE TABLE plan_prices (
      plan         VARCHAR(50) PRIMARY KEY
                   CHECK (plan IN ('trial', 'starter', 'pro', 'enterprise')),
      price_usd    NUMERIC(10, 2),
      active       BOOLEAN NOT NULL DEFAULT true,
      notes        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
    );

    -- CHECK explícito: enterprise siempre con price_usd NULL (custom per-tenant).
    -- Defensa contra editar enterprise desde el admin y meterle un número
    -- (eso confundiría al getTenantMrr — usaría el number en vez del
    -- tenants.custom_mrr_usd).
    ALTER TABLE plan_prices ADD CONSTRAINT chk_enterprise_no_fixed_price
      CHECK (plan != 'enterprise' OR price_usd IS NULL);

    -- CHECK: precios no-negativos (defensive — UI ya valida).
    ALTER TABLE plan_prices ADD CONSTRAINT chk_price_nonneg
      CHECK (price_usd IS NULL OR price_usd >= 0);

    -- 2. Seed con los valores actuales de planPricing.js (2026-06-22).
    -- El INSERT corre con el role que ejecuta migrations (ipro_app post
    -- TANDA 0c). updated_by NULL inicialmente — no hay user "sistema"
    -- todavía. El primer UPDATE desde el admin va a llenar el campo.
    INSERT INTO plan_prices (plan, price_usd, notes) VALUES
      ('trial',      0,    'Trial siempre gratis. NO editar desde admin (la UI lo deshabilita).'),
      ('starter',    39,   'Plan inicial. Precio mock del handoff de Claude Design.'),
      ('pro',        189,  'Plan medio. Precio mock del handoff de Claude Design.'),
      ('enterprise', NULL, 'Custom per-tenant en tenants.custom_mrr_usd. Esta fila es marker.');

    -- 3. Agregar 'plan_price_change' al CHECK de tenant_admin_actions.action.
    -- Postgres no permite ALTER CHECK directamente — hay que DROP + ADD.
    ALTER TABLE tenant_admin_actions DROP CONSTRAINT tenant_admin_actions_action_check;
    ALTER TABLE tenant_admin_actions ADD CONSTRAINT tenant_admin_actions_action_check
      CHECK (action IN (
        'plan_change',
        'suspend',
        'reactivate',
        'trial_extend',
        'note_update',
        'custom_mrr_update',
        'bootstrap_super_admin',
        'plan_price_change'
      ));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Revertir CHECK de tenant_admin_actions a la versión sin 'plan_price_change'.
    -- IMPORTANTE: si hay filas con action='plan_price_change', el ADD CONSTRAINT
    -- va a fallar. El operador debe DELETE esas filas primero si quiere revertir.
    ALTER TABLE tenant_admin_actions DROP CONSTRAINT tenant_admin_actions_action_check;
    ALTER TABLE tenant_admin_actions ADD CONSTRAINT tenant_admin_actions_action_check
      CHECK (action IN (
        'plan_change',
        'suspend',
        'reactivate',
        'trial_extend',
        'note_update',
        'custom_mrr_update',
        'bootstrap_super_admin'
      ));

    DROP TABLE IF EXISTS plan_prices;
  `);
};
