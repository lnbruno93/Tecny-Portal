/* eslint-disable camelcase */
/**
 * Migration: UNIQUE PARCIAL sobre productos(tenant_id, imei) para productos
 * disponibles vivos.
 *
 * Auditoría 2026-06-30 IMEI race — el bulk import (POST /productos/bulk)
 * chequea IMEIs duplicados con un SELECT previo + INSERT, y POST single
 * (POST /productos) hasta ahora NO tenía check. Dos requests concurrentes
 * podían pasar el check y luego ambos INSERT sin restricción de DB.
 *
 * Decisión durable (Lucas, 2026-06-30): el check de aplicación SIEMPRE va a
 * tener una ventana de race. Necesitamos defensa final en DB.
 *
 * Diseño del UNIQUE:
 *   - Parcial: SOLO sobre productos `disponibles` vivos. Un producto vendido
 *     conserva su IMEI (no debe bloquear el reingreso de stock vía canje), y
 *     un soft-deleted tampoco bloquea (puede haber sido un alta errónea).
 *   - Scope (tenant_id, imei) para multi-tenant: cada tenant puede tener su
 *     propio "356938...000" sin colisión cross-tenant.
 *   - Condicional: `imei IS NOT NULL` — accesorios sin IMEI no chocan.
 *
 * El índice existente `idx_productos_imei` (creado en 20260524000001) es de
 * búsqueda (no UNIQUE), con WHERE `deleted_at IS NULL AND imei IS NOT NULL`
 * — coexisten sin problema (PG permite múltiples índices sobre las mismas
 * columnas con diferentes predicados/uniqueness).
 *
 * NOTA sobre CONCURRENTLY:
 *   La spec original sugería `CREATE UNIQUE INDEX CONCURRENTLY`, pero
 *   node-pg-migrate envuelve cada migración en una TX (default) y CONCURRENTLY
 *   no funciona dentro de TX. El patrón del repo (migration 20260611000002 lo
 *   documenta) es `CREATE [UNIQUE] INDEX IF NOT EXISTS` plano: a escala actual
 *   se crea en segundos. Si en el futuro la tabla productos crece a 1M+ filas
 *   y el lock molesta, se corre a mano con CONCURRENTLY (la migration
 *   IF NOT EXISTS la vuelve no-op).
 *
 * Backfill / pre-existing dupes:
 *   En staging puede haber filas duplicadas pre-fix (pre-bulk check). Si la
 *   creación falla con "could not create unique index", deduplicar a mano
 *   antes (UPDATE productos SET estado='vendido' WHERE id IN (...)). En prod
 *   no debería haber duplicados (el bulk check los bloqueaba), pero el riesgo
 *   real es race en POST single — y el ataque/bug requiere concurrencia
 *   precisa; cualquier dup pre-existente fue creado por bulk-bypass via DB
 *   directo, que no es flow de Lucas hoy.
 *
 * Auditoría 2026-06-30 UYU — además extiende CHECK de
 * cross_tenant_pagos.moneda_pago a ('USD','ARS','UYU') para soportar pagos
 * cross-frontera cuando partnership AR↔UY se concrete. El handler
 * (routes/redB2b/pagos.js) ya llama `assertMonedaValidaParaPais` para gate
 * país-aware; este CHECK levanta el techo DB-side para que UYU no rebote en
 * 23514.
 *
 * Reversible. Down drop el UNIQUE + revierte CHECK a ('USD','ARS').
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- ─── IMEI UNIQUE PARCIAL ──────────────────────────────────────────────
    -- (tenant_id, imei) WHERE imei IS NOT NULL AND deleted_at IS NULL
    --   AND estado = 'disponible'
    --
    -- Razón del filtro 'disponible' (en vez de "no vendido"): explícito y
    -- exclusivo. Si un IMEI está en estado='vendido' / 'en_tecnico' /
    -- 'reservado', NO compite por el slot del UNIQUE — distintos estados
    -- representan distintos ciclos de vida del mismo equipo físico, y el
    -- producto disponible es el único que un alta nueva podría duplicar.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_productos_imei_unique
      ON productos (tenant_id, imei)
      WHERE imei IS NOT NULL
        AND deleted_at IS NULL
        AND estado = 'disponible';

    COMMENT ON INDEX idx_productos_imei_unique IS
      'Auditoría 2026-06-30: defensa final contra IMEI duplicado en productos disponibles vivos (race condition entre check de aplicación y INSERT). El bulk import y POST single chequean preventivamente; este índice cierra la ventana de race.';

    -- ─── cross_tenant_pagos.moneda_pago — extender a UYU ─────────────────
    -- Auditoría 2026-06-30 UYU. La migration original
    -- 20260628100000_red_b2b_pagos_multidivisa.js dejó el CHECK como
    -- ('USD','ARS') esperando una extensión futura. F1 multi-país habilitó
    -- UYU en otras tablas pero excluyó esta — el handler ya gate por
    -- assertMonedaValidaParaPais, solo falta levantar el techo DB.
    ALTER TABLE cross_tenant_pagos
      DROP CONSTRAINT IF EXISTS cross_tenant_pagos_moneda_pago_check;
    ALTER TABLE cross_tenant_pagos
      ADD CONSTRAINT cross_tenant_pagos_moneda_pago_check
        CHECK (moneda_pago IN ('USD', 'ARS', 'UYU'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Revertir CHECK a ('USD','ARS') — original F4.
    ALTER TABLE cross_tenant_pagos
      DROP CONSTRAINT IF EXISTS cross_tenant_pagos_moneda_pago_check;
    ALTER TABLE cross_tenant_pagos
      ADD CONSTRAINT cross_tenant_pagos_moneda_pago_check
        CHECK (moneda_pago IN ('USD', 'ARS'));

    DROP INDEX IF EXISTS idx_productos_imei_unique;
  `);
};
