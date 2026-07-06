/**
 * Idempotency para POST /api/red-b2b/operations/:id/pagos.
 *
 * Motivación (audit 2026-07-06 COR-1): sin `Idempotency-Key`, un doble-click
 * en el modal Pago del portal Red B2B, un retry por 502 de Netlify, o dos
 * pestañas del mismo user con el mismo monto, creaban 2 `cross_tenant_pagos`
 * idénticos + 2 `movimientos_cc` + 2 `proveedor_movimientos` + 2 asientos en
 * Cambios de Divisa. El `FOR UPDATE` sobre la op serializa las 2 txs pero
 * NO impide la 2da si aún queda saldo → ambos pagos "válidos" a nivel schema.
 *
 * Estrategia:
 *   1. Columna `client_generated_id` UUID nullable — el frontend genera el
 *      UUID al abrir el modal y lo manda como header `Idempotency-Key`
 *      en el POST. Cada intento de retry usa el MISMO UUID.
 *   2. UNIQUE index parcial: (`cross_tenant_operation_id`, `client_generated_id`)
 *      WHERE client_generated_id IS NOT NULL.
 *      - Filas legacy (NULL) se ignoran (backwards compat).
 *      - Con key: 2do pago con misma key → violación → rollback + refetch.
 *   3. Path server-side: al recibir el POST con header, ANTES del INSERT
 *      chequeamos si ya existe pago con la key. Si sí, devolvemos el mismo
 *      response que la 1ra vez SIN re-ejecutar side effects.
 *
 * Alternativa descartada: hash del body como key. Rechazado porque un legítimo
 * "quiero pagar 100 USD dos veces seguidas" quedaría bloqueado por 24h.
 */

exports.up = async (pgm) => {
  pgm.addColumns('cross_tenant_pagos', {
    client_generated_id: { type: 'uuid', notNull: false },
  });

  // Index parcial — NULLs no compiten, así que múltiples pagos legacy pueden
  // convivir. Solo pagos con key explícita se testean por unicidad.
  pgm.createIndex(
    'cross_tenant_pagos',
    ['cross_tenant_operation_id', 'client_generated_id'],
    {
      name: 'idx_ct_pagos_idempotency',
      unique: true,
      where: 'client_generated_id IS NOT NULL',
    }
  );
};

exports.down = async (pgm) => {
  pgm.dropIndex('cross_tenant_pagos', ['cross_tenant_operation_id', 'client_generated_id'], {
    name: 'idx_ct_pagos_idempotency',
    ifExists: true,
  });
  pgm.dropColumns('cross_tenant_pagos', ['client_generated_id']);
};
