/**
 * Idempotency para POST /api/red-b2b/operations/:id/devolucion.
 *
 * Motivación (audit 2026-07-11 P1-3): sin `Idempotency-Key`, un doble-click
 * en el modal Devolución o un retry por 502 crea 2 devoluciones parciales
 * idénticas. Ejemplo: buyer devuelve 5 de 10 unidades. Doble-click → 2da
 * request devuelve OTRAS 5 (la validación H3 `totalUsdDev ≤ maxDevolvibleUsd`
 * cubre el caso del 100% pero no la duplicidad parcial). Stock del seller
 * queda +10, del buyer −10, pero el buyer solo intentó devolver 5. Rollback
 * a mano es doloroso: hay que borrar la 2da op, revertir 2 movs_cc + 2
 * proveedor_movs + ajustar stock en 2 tenants.
 *
 * Estrategia (mismo patrón que COR-1 en `cross_tenant_pagos`):
 *   1. Columna `client_generated_id` UUID nullable en `cross_tenant_operations`.
 *      El frontend genera un UUID al abrir el modal Devolución. Cada retry
 *      (doble-click, 502, network hiccup) manda el MISMO UUID como header
 *      `Idempotency-Key`.
 *   2. UNIQUE index PARCIAL: (`parent_op_id`, `client_generated_id`)
 *      WHERE `parent_op_id IS NOT NULL AND client_generated_id IS NOT NULL`.
 *      - Solo aplica a DEVOLUCIONES (parent_op_id NOT NULL). Ops originales
 *        (POST /operations) no se ven afectadas — tienen su propia lógica
 *        y no requieren idempotency hoy.
 *      - Filas legacy (client_generated_id NULL) se ignoran → backwards compat.
 *      - Con key: 2do INSERT con misma key para el mismo parent → violación
 *        23505 → rollback + refetch (early-check devuelve el existente).
 *   3. Handler POST /devolucion consume el header, early-check dentro de
 *      la tx, y catch de 23505 para el race entre 2 requests paralelos.
 *
 * Alternativa descartada: hash del body como key. Rechazado por la misma
 * razón que COR-1 — un legítimo "devuelvo estos 5 items dos veces seguidas"
 * (raro pero posible en un uso legítimo con 2 lotes de la misma merca)
 * quedaría bloqueado por 24h de cache.
 *
 * Nota sobre el partial WHERE: el índice condicional es CRÍTICO. Sin él,
 * ops originales (parent_op_id NULL) con client_generated_id NULL colisionarían
 * porque (NULL, NULL) sí es distinguible por Postgres para UNIQUE (dos filas
 * (NULL, NULL) son consideradas distintas — es específicamente el caso de
 * NULL que Postgres trata como "unknown != unknown"). Pero preferimos ser
 * explícitos con `IS NOT NULL` para evitar sorpresas si en el futuro se
 * relaja el criterio.
 */

exports.up = async (pgm) => {
  pgm.addColumns('cross_tenant_operations', {
    client_generated_id: { type: 'uuid', notNull: false },
  });

  pgm.createIndex(
    'cross_tenant_operations',
    ['parent_op_id', 'client_generated_id'],
    {
      name: 'idx_ct_ops_devolucion_idempotency',
      unique: true,
      where: 'parent_op_id IS NOT NULL AND client_generated_id IS NOT NULL',
    }
  );
};

exports.down = async (pgm) => {
  pgm.dropIndex('cross_tenant_operations', ['parent_op_id', 'client_generated_id'], {
    name: 'idx_ct_ops_devolucion_idempotency',
    ifExists: true,
  });
  pgm.dropColumns('cross_tenant_operations', ['client_generated_id']);
};
