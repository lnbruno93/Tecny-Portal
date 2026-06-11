/* eslint-disable camelcase */
/**
 * Migración — Tabla de feature_flags (M-08 GRAN auditoría 2026-06-10).
 *
 * Sistema minimalista de feature flags para habilitar rollouts graduales y
 * kill-switches sin requerir un deploy. Solo on/off global por flag (sin
 * targeting por user / role / rollout %, sin variantes A/B). Si en el futuro
 * se necesita targeting, se extiende la tabla — la migración no asume nada
 * más allá del modelo MVP.
 *
 *   · `name` PK varchar(64): snake_case lowercase, regex validado a nivel
 *     aplicación (`^[a-z][a-z0-9_]*$`). La PK garantiza unicidad sin índice
 *     adicional. 64 chars es deliberadamente acotado para forzar nombres
 *     legibles (un flag debe describir qué activa, no contar una historia).
 *   · `enabled` boolean default false: el default seguro es "apagado".
 *     Cualquier flag recién creado no impacta hasta que un admin lo prenda.
 *   · `description` text opcional (max 500 chars enforced en Zod): para que
 *     en 3 meses sepas qué hacía ese flag sin tener que git-blamear.
 *   · `created_at` / `updated_at` timestamptz: trazabilidad mínima. La
 *     auditoría granular (quién prendió qué flag cuándo) ya la cubre
 *     `audit_logs` desde la route (TANDA 2 S-05 patrón audit-in-tx).
 *
 * Seed: 1 flag de demostración (`demo_flag`, false) para que el endpoint
 * GET devuelva algo desde el día 1 y los tests/diagnóstico tengan un row
 * conocido contra el cual probar. Borrarlo cuando exista el primer flag real.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE feature_flags (
      name         VARCHAR(64) PRIMARY KEY,
      enabled      BOOLEAN NOT NULL DEFAULT false,
      description  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Seed de demostración. Permite que GET /api/feature-flags devuelva un
    -- map no vacío desde el deploy. Borrar cuando exista el primer flag real.
    INSERT INTO feature_flags (name, enabled, description) VALUES
      ('demo_flag', false, 'Flag de demostración — borrar cuando se use el primero real')
    ON CONFLICT (name) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS feature_flags;`);
};
