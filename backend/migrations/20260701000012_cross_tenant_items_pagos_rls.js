/**
 * Migration: RLS policies sobre cross_tenant_operation_items + cross_tenant_pagos.
 *
 * Auditoría 2026-06-30 S-04 (defense-in-depth, no explotable hoy).
 *
 * Contexto:
 *   Las tablas `cross_tenant_operation_items` y `cross_tenant_pagos` se
 *   crearon en 20260627000001_red_b2b_partnerships.js SIN RLS. La
 *   justificación (líneas 222-223 y 253-254 del migration original) fue
 *   "Sin RLS propio — acceso siempre via JOIN con cross_tenant_operations
 *   (cuya RLS filtra)".
 *
 *   Eso es correcto SI todos los call-sites siempre hacen JOIN. Pero si
 *   alguien escribe `SELECT * FROM cross_tenant_operation_items WHERE
 *   cross_tenant_operation_id = $1` SIN join (lo cual es válido y
 *   tentador — el FK ya es a la op), no hay RLS que limite — la tabla está
 *   ABIERTA cross-tenant.
 *
 *   Hoy NO es explotable porque los 2 únicos call-sites GET en el portal
 *   (operations.js + pagos.js) usan adminQuery (BYPASSRLS) o join inline
 *   con cross_tenant_operations. Pero el día de mañana, un nuevo endpoint
 *   de reporting que lea pagos directamente por op_id pasaría sin RLS.
 *
 * Fix:
 *   ENABLE ROW LEVEL SECURITY + policy basada en JOIN a la op padre. El
 *   SELECT solo retorna rows cuyo op padre tiene seller_tenant_id O
 *   buyer_tenant_id matching current_tenant.
 *
 *   NO FORCE: el admin pool (tecny_admin con BYPASSRLS) debe seguir
 *   pudiendo escribir items + pagos cross-tenant en la misma tx que crea
 *   la op (operations.js POST CORE y pagos.js POST), sin pegarle al
 *   WITH CHECK. Mismo patrón que cross_tenant_operations + partnerships
 *   (que tampoco tienen FORCE — ver 20260627000001:148 y 197).
 *
 *   Policy solo USING (no WITH CHECK) porque:
 *     · Sin FORCE, el OWNER de la tabla (ipro_app) bypassea WITH CHECK
 *       (FORCE es lo que hace WITH CHECK aplicar al owner). Como no
 *       ponemos FORCE para no romper adminQuery, WITH CHECK no aporta nada
 *       acá.
 *     · Las escrituras pasan SIEMPRE por adminQuery (BYPASSRLS) — la
 *       defensa real es el código del endpoint que valida partnership +
 *       seller/buyer ANTES del INSERT.
 *
 * Reversible: down dropea las policies y disable RLS (estado original).
 */

/* eslint-disable camelcase */

exports.shorthands = undefined;

// Predicate: el row es visible si su op padre tiene seller_tenant_id O
// buyer_tenant_id matching current_tenant. Se evalúa via EXISTS subquery —
// O(1) por row dado el index en cross_tenant_operations(id) (PK).
//
// NULLIF fail-closed (igual que el resto del portal): sin SET LOCAL el
// predicate evalúa a FALSE (NULL::int → la comparación nunca matchea).
const PREDICATE_VIA_OP = (col) => `
  EXISTS (
    SELECT 1 FROM cross_tenant_operations o
    WHERE o.id = ${col}
      AND (
        o.seller_tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int
        OR
        o.buyer_tenant_id  = NULLIF(current_setting('app.current_tenant', true), '')::int
      )
  )
`;

exports.up = (pgm) => {
  pgm.sql(`
    -- ─── cross_tenant_operation_items ───────────────────────────────────
    -- Auditoría 2026-06-30 S-04: RLS via JOIN al op padre.
    ALTER TABLE cross_tenant_operation_items ENABLE ROW LEVEL SECURITY;
    -- NO FORCE — ver header del migration.

    DROP POLICY IF EXISTS cross_op_items_select ON cross_tenant_operation_items;
    CREATE POLICY cross_op_items_select ON cross_tenant_operation_items
      FOR SELECT TO PUBLIC
      USING (${PREDICATE_VIA_OP('cross_tenant_operation_items.cross_tenant_operation_id')});

    -- ─── cross_tenant_pagos ─────────────────────────────────────────────
    -- Auditoría 2026-06-30 S-04: RLS via JOIN al op padre.
    ALTER TABLE cross_tenant_pagos ENABLE ROW LEVEL SECURITY;
    -- NO FORCE — ver header del migration.

    DROP POLICY IF EXISTS cross_pagos_select ON cross_tenant_pagos;
    CREATE POLICY cross_pagos_select ON cross_tenant_pagos
      FOR SELECT TO PUBLIC
      USING (${PREDICATE_VIA_OP('cross_tenant_pagos.cross_tenant_operation_id')});
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP POLICY IF EXISTS cross_op_items_select ON cross_tenant_operation_items;
    ALTER TABLE cross_tenant_operation_items DISABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS cross_pagos_select ON cross_tenant_pagos;
    ALTER TABLE cross_tenant_pagos DISABLE ROW LEVEL SECURITY;
  `);
};
