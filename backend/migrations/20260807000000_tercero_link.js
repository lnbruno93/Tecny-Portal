/* eslint-disable camelcase */
/**
 * Feature: link pragmático clientes_cc ↔ proveedores (task #302).
 *
 * ── Contexto ──────────────────────────────────────────────────────────
 *
 * Bug crónico ("caso Kevin", reportado por Lucas hace meses): un mismo
 * tercero puede ser SIMULTÁNEAMENTE cliente_cc (nos debe) y proveedor (le
 * debemos). Hoy son 2 registros disjuntos en 2 tablas distintas y no hay
 * forma de:
 *   1. Marcar que refieren a la misma persona/entidad.
 *   2. Ver el saldo NETO consolidado ("Kevin nos debe 5000 y le debemos
 *      2500 → saldo neto 2500 a favor").
 *
 * ── Historia de las alternativas ─────────────────────────────────────
 *
 * El refactor "Terceros completo" (task #149, Fase 1 mergeado 2026-08-03
 * como PR #987) crea 3 tablas nuevas — `terceros` + `tercero_movimientos`
 * + `tercero_items` — para unificar el modelo. Ese refactor está en
 * PAUSA por costo/beneficio: son 5+ fases (~40h), migración compleja
 * clientes_cc + proveedores → terceros, sync cross-módulo (cajas, red
 * B2B, dashboard, chat-tools), risk-heavy.
 *
 * Decisión Lucas 2026-08-07: pragmático > perfecto. Esta migration
 * agrega SOLO una tabla mínima de "link" 1:1 entre un cliente_cc y un
 * proveedor. El saldo neto se calcula en el endpoint sin mover data
 * histórica. Cubre el 80% del beneficio (Kevin case + parecidos) sin
 * los 40h del refactor completo.
 *
 * Las tablas `terceros` / `tercero_movimientos` / `tercero_items`
 * creadas por Fase 1 PR #987 quedan vacías sin usar. Backlog: eventual
 * DROP si nunca se retoma el refactor completo (~task futura).
 *
 * ── Cambios de este PR ────────────────────────────────────────────────
 *
 * Nueva tabla `tercero_link` per-tenant:
 *   · `id` SERIAL PK.
 *   · `tenant_id` NOT NULL.
 *   · `cliente_cc_id` NOT NULL FK → clientes_cc(id) ON DELETE CASCADE.
 *   · `proveedor_id`  NOT NULL FK → proveedores(id)  ON DELETE CASCADE.
 *   · `notas` TEXT opcional (contexto humano del link, ej. "empresa
 *     Fulano SA se factura desde IVA distinto para venta vs compra").
 *   · `created_at` + `created_by` (audit trail).
 *   · `deleted_at` (soft delete estándar).
 *
 * Índices UNIQUE parciales (solo rows vivos):
 *   · UNIQUE (tenant_id, cliente_cc_id) WHERE deleted_at IS NULL
 *     — un cliente puede estar linkeado con MÁS de UN proveedor a
 *     lo largo del tiempo (soft-delete y re-link), pero solo UNO
 *     activo por vez. La UI asume 1:1.
 *   · UNIQUE (tenant_id, proveedor_id)  WHERE deleted_at IS NULL
 *     — mismo criterio simétrico.
 *
 * ── Seguridad / RLS ──────────────────────────────────────────────────
 *
 * `enableTenantRlsFor(pgm, 'tercero_link')` aplica ENABLE + FORCE +
 * policy `tenant_isolation` canónica. La tabla `tercero_link` se agrega
 * a `TABLAS_TENANT_SCOPED` en `src/lib/rlsCanonical.js` (mismo commit).
 *
 * Como la tabla arranca 100% vacía (NO hay backfill, NO hay INSERT en
 * esta migration), es SAFE bajo el pattern del runbook 08-01: no puede
 * violar `WITH CHECK (tenant_id = current_tenant)` porque no se
 * insertan filas. Se verificó con el job CI `Migrations from-scratch
 * as ipro_app NOSUPERUSER (owner-of-schema)` (no reproduce el P0 08-01
 * ni el P0 08-03).
 *
 * ── Rollback ─────────────────────────────────────────────────────────
 *
 * `down()`: DROP TABLE tercero_link CASCADE. Los links registrados se
 * pierden pero clientes_cc y proveedores quedan intactos (los FK
 * apuntaban DESDE tercero_link hacia ellos, no al revés). Aceptable en
 * rollback — es rollback.
 */

const { enableTenantRlsFor } = require('../src/lib/rlsCanonical');

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE tercero_link (
      id             SERIAL PRIMARY KEY,
      tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      cliente_cc_id  INTEGER NOT NULL REFERENCES clientes_cc(id) ON DELETE CASCADE,
      proveedor_id   INTEGER NOT NULL REFERENCES proveedores(id) ON DELETE CASCADE,
      notas          TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by     INTEGER REFERENCES users(id),
      deleted_at     TIMESTAMPTZ
    );

    -- UNIQUE parciales: 1 link activo por cliente y 1 por proveedor. Permiten
    -- re-crear un link tras soft-delete (flow "desvincular y re-linkear con
    -- otro"). El deleted_at NULL clause asegura que soft-deleted rows no
    -- bloqueen re-linkeo.
    CREATE UNIQUE INDEX idx_tercero_link_cliente_unique
      ON tercero_link (tenant_id, cliente_cc_id)
      WHERE deleted_at IS NULL;

    CREATE UNIQUE INDEX idx_tercero_link_proveedor_unique
      ON tercero_link (tenant_id, proveedor_id)
      WHERE deleted_at IS NULL;
  `);

  // RLS canónica. Tabla vacía → seguro aplicar FORCE sin seed previo.
  // Ver docstring arriba.
  enableTenantRlsFor(pgm, 'tercero_link');
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS tercero_link CASCADE;`);
};
