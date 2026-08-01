/**
 * Migration: backfill ganancia_usd sumando el vuelto que se había restado
 *
 * ── Contexto ────────────────────────────────────────────────────────────
 *
 * PR #620 (2026-07-14, "vuelto_tc + ganancia real descuenta el vuelto")
 * introdujo el descuento del `vuelto_monto` (convertido a USD) al
 * calcular `ventas.ganancia_usd`. La premisa era: "el vuelto sale del
 * comercio → resta ganancia".
 *
 * Lucas (PO) aclaró el 2026-08-01: la regla es la opuesta. El vuelto es
 * SOLO dinero devuelto al cliente (cambio); NO impacta rentabilidad de
 * la venta. Es una línea informativa en UI/comprobante, nada más.
 *
 * Task #272 revierte el descuento en el código (backend + frontend). Esta
 * migration corrige el histórico: SUMA de vuelta el vueltoUsd a
 * `ganancia_usd` de las ventas que tienen `vuelto_monto NOT NULL` — el
 * mismo valor que en el momento del INSERT se había restado.
 *
 * ── Fórmula del backfill ────────────────────────────────────────────────
 *
 *   vueltoUsd = CASE
 *     WHEN vuelto_moneda IN ('USD','USDT') THEN vuelto_monto
 *     WHEN vuelto_moneda IN ('ARS','UYU') AND vuelto_tc > 0
 *       THEN vuelto_monto / vuelto_tc
 *     ELSE 0
 *   END
 *
 *   ganancia_usd_nueva = ganancia_usd + vueltoUsd
 *
 * Espejo exacto del helper `computeVueltoUsd` del frontend y de la lógica
 * pre-fix de `calcularTotales` del backend. Si vuelto_tc es NULL o 0 en
 * una fila ARS/UYU (edge case defensive), no se suma nada.
 *
 * ── Idempotencia ────────────────────────────────────────────────────────
 *
 * Este backfill NO es idempotente por diseño: si se corre 2 veces, suma
 * el vuelto dos veces. Guard-rail: usamos una columna marker
 * `ganancia_backfilled_at_v272` que registra el timestamp del backfill.
 * El UPDATE la filtra: solo procesa filas donde la columna es NULL. En
 * un segundo run, la migration completa sin actualizar filas (todas ya
 * marcadas). Post-verificación, se puede opcionalmente dropear la
 * columna, pero la dejamos como audit trail permanente.
 *
 * ── RLS (2026-08-01 P0 lesson learned — ver runbook) ────────────────────
 *
 * `ventas` tiene RLS con `tenant_isolation` + **FORCE ROW LEVEL
 * SECURITY** activo (patrón usado en 53 de 57 tablas RLS del proyecto).
 * El migration runner corre como `ipro_app` — que es owner de la tabla
 * pero **NOSUPERUSER sin BYPASSRLS**.
 *
 * Con FORCE RLS activo, ni siquiera el owner puede bypasear las policies
 * usando `SET LOCAL row_security = off` — Postgres tira:
 *
 *   ERROR: query would be affected by row-level security policy for
 *          table "ventas"
 *   HINT: To disable the policy for the table's owner, use
 *         ALTER TABLE NO FORCE ROW LEVEL SECURITY.
 *
 * (La versión previa de esta migration usaba `SET LOCAL row_security = off`
 *  → rompió los deploys Railway prod 2026-08-01 desde ~05:15 UTC hasta
 *  ~15:44 UTC. 10h de downtime para todos los tenants. Ver
 *  `docs/RUNBOOK-migration-rls-force.md`.)
 *
 * Solución canónica (el hint literal de Postgres): desactivar
 * temporalmente FORCE, hacer el UPDATE, restaurar FORCE. Todo dentro
 * de la transacción de la migration → si algo falla, ROLLBACK deja la
 * tabla con FORCE ROW LEVEL SECURITY de vuelta (invariante preservado).
 *
 *   ALTER TABLE ventas NO FORCE ROW LEVEL SECURITY;
 *   UPDATE ventas SET ...;
 *   ALTER TABLE ventas FORCE ROW LEVEL SECURITY;
 *
 * El owner (`ipro_app`) SÍ puede ejecutar ambos ALTER — verificado
 * empíricamente contra prod DB antes de escribir esta migration.
 *
 * ── Cross-tenant ────────────────────────────────────────────────────────
 *
 * El backfill afecta ventas de TODOS los tenants — no hay filtro
 * `tenant_id = X` porque es un fix de fórmula global. Todos los tenants
 * que tenían ventas con vuelto tenían la ganancia mal.
 *
 * ── Consecuencia visible ────────────────────────────────────────────────
 *
 * Las ventas históricas con vuelto van a ver la ganancia SUBIR por el
 * monto del vuelto. En el caso típico (cliente paga u$s1000 por venta
 * u$s990, vuelto u$s10 al cambio) la ganancia sube +u$s10 — pero el
 * comprobante nunca cambió (siempre mostró bruta=990-costo), así que
 * el operador puede notarlo en el Dashboard/histórico y preguntarse por
 * qué subió. El release notes debe explicarlo.
 */

exports.up = async (pgm) => {
  // Marker column para idempotencia. Se agrega, se usa en el WHERE del
  // UPDATE, queda como audit trail. Idempotente vía IF NOT EXISTS.
  pgm.sql(`
    ALTER TABLE ventas
      ADD COLUMN IF NOT EXISTS ganancia_backfilled_at_v272 TIMESTAMPTZ;
  `);

  // Backfill con RLS bypass — patrón "NO FORCE + UPDATE + FORCE".
  //
  // node-pg-migrate envuelve el up() en una transacción por default,
  // entonces si algo falla acá, ROLLBACK restaura FORCE ROW LEVEL SECURITY.
  // El invariante "todas las tablas RLS tienen FORCE" queda preservado.
  //
  // El WHERE filtra:
  //   - deleted_at IS NULL (no queremos backfillear soft-deleted)
  //   - vuelto_monto IS NOT NULL AND vuelto_monto > 0 (tiene vuelto real)
  //   - ganancia_backfilled_at_v272 IS NULL (no fue backfilled aún)
  //
  // La expresión del CASE espeja `computeVueltoUsd` frontend y la
  // lógica pre-fix de `calcularTotales` backend.
  pgm.sql(`ALTER TABLE ventas NO FORCE ROW LEVEL SECURITY;`);

  pgm.sql(`
    UPDATE ventas
       SET ganancia_usd = ganancia_usd + CASE
             WHEN vuelto_moneda IN ('USD','USDT')             THEN vuelto_monto
             WHEN vuelto_moneda IN ('ARS','UYU')
                  AND vuelto_tc IS NOT NULL AND vuelto_tc > 0 THEN vuelto_monto / vuelto_tc
             ELSE 0
           END,
           ganancia_backfilled_at_v272 = NOW()
     WHERE deleted_at IS NULL
       AND vuelto_monto IS NOT NULL
       AND vuelto_monto > 0
       AND ganancia_backfilled_at_v272 IS NULL;
  `);

  pgm.sql(`ALTER TABLE ventas FORCE ROW LEVEL SECURITY;`);

  // Nota informativa post-backfill (sale en los logs de deploy).
  pgm.sql(`
    DO $$
    BEGIN
      RAISE NOTICE
        '[Migration 20260801100000] Backfill ganancia_usd sin vuelto — filas actualizadas: %',
        (SELECT COUNT(*) FROM ventas WHERE ganancia_backfilled_at_v272 IS NOT NULL);
    END $$;
  `);
};

exports.down = async (pgm) => {
  // Rollback: RESTAR el vuelto que sumamos (volver al estado pre-backfill),
  // y limpiar el marker. Mismo patrón NO FORCE + UPDATE + FORCE.
  pgm.sql(`ALTER TABLE ventas NO FORCE ROW LEVEL SECURITY;`);

  pgm.sql(`
    UPDATE ventas
       SET ganancia_usd = ganancia_usd - CASE
             WHEN vuelto_moneda IN ('USD','USDT')             THEN vuelto_monto
             WHEN vuelto_moneda IN ('ARS','UYU')
                  AND vuelto_tc IS NOT NULL AND vuelto_tc > 0 THEN vuelto_monto / vuelto_tc
             ELSE 0
           END,
           ganancia_backfilled_at_v272 = NULL
     WHERE ganancia_backfilled_at_v272 IS NOT NULL;
  `);

  pgm.sql(`ALTER TABLE ventas FORCE ROW LEVEL SECURITY;`);

  pgm.sql(`ALTER TABLE ventas DROP COLUMN IF EXISTS ganancia_backfilled_at_v272;`);
};
