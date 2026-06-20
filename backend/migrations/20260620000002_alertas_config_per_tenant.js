/**
 * Migration: alertas_config — unique per-tenant + seed defaults (#343).
 *
 * Contexto:
 *   La tabla `alertas_config` se creó en 2026-06-03 (single-tenant) con
 *   `tipo TEXT NOT NULL UNIQUE`. Cuando agregamos multi-tenancy en
 *   2026-06-15, le agregamos `tenant_id INTEGER NOT NULL DEFAULT 1` y
 *   backfilleamos a tenant 1 — pero la UNIQUE quedó solo en `tipo`. Eso
 *   significa que SOLO tenant 1 puede tener config: cualquier INSERT para
 *   un tenant nuevo viola la unique constraint.
 *
 *   Hoy esto no afecta a nadie porque prod solo tiene tenant 1, pero con
 *   el bot conversacional (#340) y el plan de signup público multi-tenant
 *   ya muy próximo, es un gating issue. Además es la causa de que las
 *   tools del bot que dependen de alertas_config devuelvan vacío para
 *   tenants nuevos.
 *
 * Esta migration:
 *   1. Dropea la UNIQUE global `tipo`.
 *   2. Crea UNIQUE compuesta `(tenant_id, tipo)`.
 *   3. Seedea defaults para CADA tenant existente que aún no los tenga.
 *   4. (Doc-only) Recordatorio para el onboarding flow nuevo: seedear
 *      alertas_config al crear un tenant.
 *
 * Idempotente: ON CONFLICT DO NOTHING en el seed, IF EXISTS en el drop.
 *
 * Defaults (mismo set que el seed original):
 *   - tc_referencia       (activa=true,  parametros={tc:null,fecha:null})
 *   - caja_negativa       (activa=true,  parametros={})
 *   - stock_bajo          (activa=true,  parametros={umbral_unidades:5})
 *   - cc_mora             (activa=true,  parametros={dias_sin_pago:30})
 *   - proveedor_atrasado  (activa=true,  parametros={dias_sin_movimiento:30})
 *
 * Down:
 *   Restaura UNIQUE global en `tipo` — peligroso si hay tenant != 1 con
 *   filas (haría falla la migration de up del original). Borrar cualquier
 *   fila no-tenant-1 antes del down. Documentado en el bloque de abajo.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Drop la UNIQUE global. El nombre del constraint depende de cuándo se
    -- creó: prod lo tiene como alertas_config_tipo_key (auto-generado por PG).
    -- Usamos DROP CONSTRAINT IF EXISTS por las dudas (defensive contra
    -- migrations re-runs en entornos viejos).
    ALTER TABLE alertas_config
      DROP CONSTRAINT IF EXISTS alertas_config_tipo_key;

    -- 2. UNIQUE compuesto (tenant_id, tipo). Cada tenant puede tener su
    -- propia config independiente de los otros.
    ALTER TABLE alertas_config
      ADD CONSTRAINT alertas_config_tenant_tipo_unique UNIQUE (tenant_id, tipo);

    -- 3. Seed defaults para cada tenant que falte.
    --
    -- 2026-06-20 INCIDENT FIX: el CROSS JOIN original fallaba en prod/staging
    -- con error 42501 "new row violates row-level security policy for table
    -- alertas_config" porque:
    --   - alertas_config tiene FORCE RLS desde 20260616000002_rls_fail_closed.
    --   - La policy es WITH CHECK (tenant_id = current_setting(app.current_tenant
    --     , true)::int). Sin app.current_tenant seteado, el setting devuelve
    --     NULL -> tenant_id = NULL evalua NULL (no TRUE) -> INSERT rechazado.
    --   - FORCE RLS aplica al OWNER tambien — SET row_security = off NO la
    --     bypassa (a diferencia de RLS sin FORCE).
    --   - En local funcionaba porque el role dev es SUPERUSER + BYPASSRLS;
    --     en prod/staging el role es NOSUPERUSER (TANDA 0c #294).
    --
    -- Fix: loop DO ... que setea app.current_tenant antes de cada INSERT,
    -- asi el WITH CHECK pasa para cada tenant. set_config(..., true) es
    -- transaction-local (se descarta al COMMIT, no contamina el client pool).
    DO $$
    DECLARE
      t_id INT;
    BEGIN
      FOR t_id IN SELECT id FROM tenants WHERE deleted_at IS NULL ORDER BY id LOOP
        PERFORM set_config('app.current_tenant', t_id::text, true);
        INSERT INTO alertas_config (tenant_id, tipo, activa, parametros) VALUES
          (t_id, 'tc_referencia',      true, '{"tc":null,"fecha":null}'::jsonb),
          (t_id, 'caja_negativa',      true, '{}'::jsonb),
          (t_id, 'stock_bajo',         true, '{"umbral_unidades":5}'::jsonb),
          (t_id, 'cc_mora',            true, '{"dias_sin_pago":30}'::jsonb),
          (t_id, 'proveedor_atrasado', true, '{"dias_sin_movimiento":30}'::jsonb)
        ON CONFLICT (tenant_id, tipo) DO NOTHING;
      END LOOP;
    END $$;
  `);
};

exports.down = (pgm) => {
  // CUIDADO: si hay filas de más de 1 tenant, este DROP falla por violación
  // de UNIQUE al re-agregar el constraint global. En ese caso primero hay que
  // borrar filas no-tenant-1.
  pgm.sql(`
    ALTER TABLE alertas_config
      DROP CONSTRAINT IF EXISTS alertas_config_tenant_tipo_unique;
    -- Borrar filas de tenants != 1 para no romper la re-creación de la global.
    DELETE FROM alertas_config WHERE tenant_id <> 1;
    ALTER TABLE alertas_config
      ADD CONSTRAINT alertas_config_tipo_key UNIQUE (tipo);
  `);
};
