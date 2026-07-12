/**
 * Idempotency-Key para 5 endpoints POST del módulo Financiero.
 *
 * 2026-07-12 (auditoría TOTAL Financiero P1-1, Pattern G):
 *
 * Contexto: 5 endpoints POST del portal principal crean documentos de dinero
 * y NO tienen Idempotency-Key. Doble-click, retry por 502 de Netlify, o dos
 * pestañas del mismo user con el mismo submit → 2 documentos idénticos +
 * side effects duplicados (stock 2×, CC 2×, cajas 2×, etc.).
 *
 * Los 5 endpoints y sus tablas destino:
 *   1. POST /api/ventas                     → ventas
 *   2. POST /api/cuentas/movimientos        → movimientos_cc
 *   3. POST /api/proveedores/movimientos    → proveedor_movimientos
 *   4. POST /api/tarjetas/movimientos       → tarjeta_movimientos
 *   5. POST /api/cambios/movimientos        → cambio_movimientos
 *
 * Pattern: SAME AS Red B2B (COR-1 + P1-3 audit 2026-07-06/11):
 *   1. Columna `client_generated_id UUID` nullable — el frontend genera el
 *      UUID al abrir el modal y lo manda como header `Idempotency-Key`.
 *      Cada retry del mismo submit usa el MISMO UUID.
 *   2. Índice UNIQUE PARCIAL (tenant_id, client_generated_id) WHERE
 *      client_generated_id IS NOT NULL.
 *      - Filas legacy (NULL) ignoradas → backwards compat total.
 *      - Con key: 2do POST con misma key colisiona → server intercepta y
 *        devuelve replay del 1er documento (SIN re-ejecutar side effects).
 *      - `tenant_id` en la key evita colisiones cross-tenant si dos tenants
 *        generan el mismo UUID (colisión probabilísticamente imposible pero
 *        defense-in-depth barato).
 *   3. Path server-side: al recibir POST con header, ANTES del INSERT
 *      chequeamos si ya existe fila con (tenant_id, client_generated_id).
 *      Si sí, devolvemos el mismo response que la 1ra vez.
 *
 * ALTA ATÓMICA — 5 columnas + 5 índices en una sola migration para que si
 * algo falla, todo revierte. Cada ADD COLUMN es <1s en tablas de tamaño
 * actual (~10k rows máx).
 *
 * SIN backfill — todas las filas legacy quedan con NULL en la nueva columna.
 * El WHERE en el índice UNIQUE las excluye del check.
 *
 * SAFE DEPLOY — sin cambios de código; las 5 nuevas columnas quedan
 * ignoradas por el backend actual. Los PRs de código (H.2 backend + H.3
 * frontend) vienen DESPUÉS de que esta migration esté aplicada en prod.
 *
 * NOTA multi-tenant: las 5 tablas tienen tenant_id + RLS. El índice UNIQUE
 * incluye tenant_id, lo que garantiza que la UNIQUE opera dentro del scope
 * del tenant. Sin tenant_id en el índice, un UUID generado en tenant A
 * podría colisionar con otro en tenant B — probabilísticamente imposible
 * pero conceptualmente inconsistente.
 */

// Tablas que van a tener client_generated_id. Todas comparten el mismo
// pattern: agregar columna + índice UNIQUE parcial con tenant_id.
const TABLAS = [
  'ventas',
  'movimientos_cc',
  'proveedor_movimientos',
  'tarjeta_movimientos',
  'cambio_movimientos',
];

exports.up = (pgm) => {
  for (const tabla of TABLAS) {
    pgm.addColumns(tabla, {
      client_generated_id: { type: 'uuid', notNull: false },
    });

    // Índice UNIQUE PARCIAL scopeado por tenant_id.
    // Naming: idx_<tabla>_idempotency (patrón que Red B2B ya usa —
    // `idx_ct_pagos_idempotency`).
    pgm.createIndex(
      tabla,
      ['tenant_id', 'client_generated_id'],
      {
        name: `idx_${tabla}_idempotency`,
        unique: true,
        where: 'client_generated_id IS NOT NULL',
      }
    );
  }
};

exports.down = (pgm) => {
  // Reversa en orden inverso — dropear el índice antes de la columna
  // (aunque node-pg-migrate lo maneja, es más explícito).
  for (const tabla of TABLAS.slice().reverse()) {
    pgm.dropIndex(tabla, ['tenant_id', 'client_generated_id'], {
      name: `idx_${tabla}_idempotency`,
      ifExists: true,
    });
    pgm.dropColumns(tabla, ['client_generated_id']);
  }
};
