/**
 * Red B2B — conciliación bilateral (F4 #457, decisión #12).
 *
 * Endpoint:
 *   GET /api/red-b2b/partnerships/:id/conciliation
 *
 * Computa los saldos bilaterales entre dos partners:
 *   - Total de operaciones (sum total_usd de active ops, excluyendo cancelled)
 *   - Total pagado por buyer (sum cross_tenant_pagos.monto_usd)
 *   - Saldo según seller: lo que el seller cree que le deben (CC clientes de
 *     ese partner) — leído de movimientos_cc del seller
 *   - Saldo según buyer: lo que el buyer cree que debe — leído de
 *     proveedor_movimientos del buyer
 *   - Diferencias: si los dos saldos no matchean, lista las ops con diff
 *
 * NO CACHE (decisión PR-D #463):
 *   F4 originalmente usaba Map<partnership_id, {data, expiresAt}> EN MEMORIA
 *   del proceso con TTL 60s. Lucas decidió eliminarlo en PR-D por:
 *     1. Multi-instance bug REAL — Railway puede tener N réplicas; la
 *        invalidación local desde POST /pagos no propaga a las otras
 *        réplicas, así que un usuario puede ver datos stale post-pago según
 *        en qué réplica le toque (race entre invalidate y siguiente GET).
 *     2. Ratio de hit muy bajo — endpoint visitado ~1x/sesión por admin,
 *        no es hot path. Las 4-5 queries que ahorra el cache no son
 *        catastróficas; el query plan es sano (queries por partnership_id +
 *        índices en cross_tenant_operations, movimientos_cc, etc.).
 *     3. Simpler code wins. Migrar a Redis (cacheTtl wrapper) era opción
 *        pero agregaba un punto de coordinación (cache key, TTL, invalidate
 *        coordinator) sin valor real dado el ratio de hit. Si en el futuro
 *        el volumen lo justifica, se reintroduce con Redis.
 *
 * Multi-tenant:
 *   Usa adminQuery (BYPASSRLS) porque debe leer movimientos_cc del seller
 *   Y proveedor_movimientos del buyer (dos tenants distintos). El caller
 *   participa en la partnership — filtramos inline + via getPartnershipByIdForTenant.
 */

const router = require('express').Router();
const db = require('../../config/database');
const parseId = require('../../lib/parseId');
const { getPartnershipByIdForTenant } = require('../../lib/partnership');
const { round2 } = require('../../lib/money');

// ──────────────────────────────────────────────────────────────────────────
// GET /api/red-b2b/partnerships/:id/conciliation
//
// Devuelve:
//   {
//     partnership: { id, partner: { id, nombre, slug, plan }, my_side, status },
//     totales: {
//       operaciones_usd: N, ops_count: N,
//       pagado_usd: N, pagos_count: N,
//       saldo_neto_usd: N, // operaciones - pagos
//     },
//     saldos_bilaterales: {
//       segun_seller: { saldo_usd: N, source: 'movimientos_cc' },
//       segun_buyer:  { saldo_usd: N, source: 'proveedor_movimientos' },
//       difieren: bool,
//       diferencia_usd: N,
//     },
//     ops_diferencias: [...]  // sólo si difieren
//   }
//
// Sin cache — cada GET recomputa (decisión PR-D #463). Frontend conserva
// botón "Recargar" como acción explícita del usuario; ya no hay
// `?refresh=true` ni `cached` / `cached_at` en el response.
// ──────────────────────────────────────────────────────────────────────────
router.get('/:id/conciliation', async (req, res, next) => {
  const myTenantId = req.tenantId;
  const partnershipId = parseId(req.params.id);
  if (!partnershipId) return res.status(400).json({ error: 'id inválido' });

  try {
    const data = await db.adminQuery(async (client) => {
      // A. Lookup partnership + verificar caller participa.
      const partnership = await getPartnershipByIdForTenant(client, partnershipId, myTenantId);
      if (!partnership) return { notFound: true };

      // Determinar quién es seller/buyer para esta conciliación. Como las
      // operaciones cross-tenant pueden tener el seller en cualquier lado
      // (no fijo por partnership), buscamos quién es seller/buyer SUMANDO
      // todas las ops — pero F4 simplifica: en cada op el seller es el que
      // creó. Devolvemos saldos por dirección agregados.
      //
      // Para conciliación simple: lo que el caller "ve" depende de su rol
      // en cada op. Para la vista de conciliación elegimos:
      //   - tenant_a y tenant_b son fijos (partnership convention a<b)
      //   - my_side = 'a' o 'b' según mi tenant_id
      //   - segun_seller / segun_buyer se computa por op:
      //       para cada op donde tenant_a es seller → segun_seller = saldo
      //         desde movimientos_cc del tenant_a
      //       para cada op donde tenant_b es seller → segun_seller = saldo
      //         desde movimientos_cc del tenant_b
      //
      // Para F4 simplificamos: agregamos por dirección (sum de todas las ops
      // independiente de quién fue seller/buyer en cada una).

      const tenantA = partnership.tenant_a_id;
      const tenantB = partnership.tenant_b_id;

      // B. Lookup partner info (el otro tenant).
      const partnerId = myTenantId === tenantA ? tenantB : tenantA;
      const partnerQ = await client.query(
        `SELECT id, nombre, slug, plan FROM tenants WHERE id = $1`,
        [partnerId]
      );
      const partner = partnerQ.rows[0];

      // C. Lookup todas las ops activas de esta partnership (excluyendo
      // cancelled). Esto incluye devoluciones (parent_op_id NOT NULL, total
      // negativo) que neutralizan parcialmente.
      const opsQ = await client.query(
        `SELECT id, seller_tenant_id, buyer_tenant_id, status,
                total_usd, total_ars, tc_used, created_at,
                parent_op_id
           FROM cross_tenant_operations
           WHERE partnership_id = $1
             AND status != 'cancelled'`,
        [partnershipId]
      );
      const ops = opsQ.rows;

      // D. Lookup pagos de todas estas ops.
      let pagos = [];
      if (ops.length > 0) {
        const opIds = ops.map((o) => o.id);
        const pagosQ = await client.query(
          `SELECT id, cross_tenant_operation_id, monto_usd, registered_at
             FROM cross_tenant_pagos
             WHERE cross_tenant_operation_id = ANY($1::bigint[])`,
          [opIds]
        );
        pagos = pagosQ.rows;
      }

      // E. Totales agregados.
      const totalOpsUsd = round2(ops.reduce((acc, o) => acc + Number(o.total_usd), 0));
      const totalPagosUsd = round2(pagos.reduce((acc, p) => acc + Number(p.monto_usd), 0));
      const saldoNetoUsd = round2(totalOpsUsd - totalPagosUsd);

      // F. Saldos bilaterales: leemos de movimientos_cc del seller (de
      // cualquier op cross-tenant) y proveedor_movimientos del buyer.
      //
      // El saldo del seller cross-tenant = SUM(compra) - SUM(pago) -
      //   SUM(devolucion) limited a movimientos con cross_tenant_operation_id
      //   IN (ops de esta partnership).
      //
      // Para cada lado de la partnership, sumamos lo que ese tenant ve.
      const opIds = ops.map((o) => o.id);

      // Saldo según TENANT_A en movimientos_cc (rol seller cuando él vendió).
      // movimientos_cc.tipo='compra' = venta nuestra (suma deuda cliente).
      // 'pago' = baja deuda. 'devolucion' = revierte.
      let saldoMovCcTenantA = 0;
      let saldoMovCcTenantB = 0;
      let saldoProvMovTenantA = 0;
      let saldoProvMovTenantB = 0;

      if (opIds.length > 0) {
        // Saldo según movimientos_cc por tenant.
        //
        // 2026-07-11 (auditoría Red B2B P1-5): agregado `entrega_mercaderia`
        // con signo negativo. El CHECK de `movimientos_cc.tipo` acepta 5
        // valores: compra, pago, devolucion, parte_de_pago, entrega_mercaderia
        // (más saldo_inicial, que NO aplica a rows cross-tenant). Cross-tenant
        // hoy solo GENERA compra/pago/devolucion, pero un operador que edite
        // manualmente un mov_cc cross-tenant a `entrega_mercaderia` dejaba
        // este CASE cayendo al ELSE 0 → el saldo del seller quedaba inflado
        // silenciosamente y la conciliación reportaba OK. Ahora lo cubrimos
        // explícito. Sigue una convención: cross-tenant NO debe usar la
        // canónica SALDO_CASE_M (lib/saldoCC.js) porque esa maneja la
        // casuística `compra AND caja_id IS NOT NULL` (contado no genera
        // deuda) que no aplica al mundo cross-tenant (siempre deuda). Si
        // mañana aparece otro tipo, el ELSE 0 lo silencia — auditar y
        // agregarlo explícitamente si eso pasa (no ampliar la wildcard).
        // 2026-07-11 (auditoría Red B2B P3-3): COALESCE defensive. El CASE
        // tiene ELSE 0 y el for loop abajo hace `Number(x) || 0` → sin bug
        // real (todos los caminos dan 0). Pero el COALESCE deja el default
        // explícito en SQL para consistencia con otras SUMs del mismo file
        // (línea 261 del branch difieren=true ya usa el patrón).
        const movCcQ = await client.query(
          `SELECT tenant_id,
                  COALESCE(SUM(CASE WHEN tipo = 'compra' THEN monto_total
                                    WHEN tipo IN ('pago', 'parte_de_pago') THEN -monto_total
                                    WHEN tipo = 'devolucion' THEN -monto_total
                                    WHEN tipo = 'entrega_mercaderia' THEN -monto_total
                                    ELSE 0 END), 0) AS saldo
             FROM movimientos_cc
             WHERE cross_tenant_operation_id = ANY($1::bigint[])
               AND deleted_at IS NULL
               AND tenant_id IN ($2, $3)
             GROUP BY tenant_id`,
          [opIds, tenantA, tenantB]
        );
        for (const r of movCcQ.rows) {
          if (Number(r.tenant_id) === tenantA) saldoMovCcTenantA = Number(r.saldo) || 0;
          else if (Number(r.tenant_id) === tenantB) saldoMovCcTenantB = Number(r.saldo) || 0;
        }

        // Saldo según proveedor_movimientos por tenant.
        // COR-2 audit 2026-07-06 (hotfix post-merge): tras extender el CHECK
        // de proveedor_movimientos.tipo con 'devolucion', las devoluciones
        // cross-tenant se registran con ese tipo (antes falseaban como 'pago').
        // Si acá no lo contemplamos, el saldo del buyer queda inflado en la
        // conciliación bilateral — reporta discrepancia con el saldo del
        // seller (que en movimientos_cc arriba SÍ suma 'devolucion' con -monto).
        // P3-3: COALESCE defensive (idem movCcQ arriba).
        const provMovQ = await client.query(
          `SELECT tenant_id,
                  COALESCE(SUM(CASE WHEN tipo = 'compra' THEN monto_usd
                                    WHEN tipo = 'pago' THEN -monto_usd
                                    WHEN tipo = 'devolucion' THEN -monto_usd
                                    ELSE 0 END), 0) AS saldo
             FROM proveedor_movimientos
             WHERE cross_tenant_operation_id = ANY($1::bigint[])
               AND deleted_at IS NULL
               AND tenant_id IN ($2, $3)
             GROUP BY tenant_id`,
          [opIds, tenantA, tenantB]
        );
        for (const r of provMovQ.rows) {
          if (Number(r.tenant_id) === tenantA) saldoProvMovTenantA = Number(r.saldo) || 0;
          else if (Number(r.tenant_id) === tenantB) saldoProvMovTenantB = Number(r.saldo) || 0;
        }
      }

      // G. Conciliación: el saldo "según seller" es el saldo de CC clientes
      // del seller en cada op. Como puede haber ops en ambas direcciones,
      // agregamos:
      //   "lo que tenant_a debe a tenant_b" = saldoProvMov de tenant_a
      //     (proveedor_mov de tenant_a registra deuda a tenant_b cuando b vende)
      //   "lo que tenant_b cree que tenant_a debe" = saldoMovCc de tenant_b
      //     (movimiento_cc de tenant_b cuando b vendió a a)
      // Estos dos SHOULD matchear si todo está sincronizado.
      //
      // Análogamente:
      //   "lo que tenant_b debe a tenant_a" = saldoProvMov tenant_b
      //   "lo que tenant_a cree que tenant_b debe" = saldoMovCc tenant_a

      const debeAAseguntenantB = round2(saldoMovCcTenantB);   // tenant_b vendió a tenant_a, registró en CC
      const debeAAseguntenantA = round2(saldoProvMovTenantA); // tenant_a registra a tenant_b como proveedor
      const debeBSeguntenantA = round2(saldoMovCcTenantA);    // tenant_a vendió a tenant_b
      const debeBSeguntenantB = round2(saldoProvMovTenantB);  // tenant_b registra tenant_a como proveedor

      const diffDirA = round2(debeAAseguntenantB - debeAAseguntenantA);
      const diffDirB = round2(debeBSeguntenantA - debeBSeguntenantB);
      const difieren = Math.abs(diffDirA) >= 0.01 || Math.abs(diffDirB) >= 0.01;
      const diferencia_usd = round2(diffDirA + diffDirB);

      // H. Si difieren, listar las ops con discrepancia (granularidad por op).
      let opsDiferencias = [];
      if (difieren && opIds.length > 0) {
        // Por op: total_usd vs sum pagos vs movimientos_cc/proveedor_movimientos.
        //
        // 2026-07-11 (bug pre-existente detectado al testear P1-5):
        // `movimientos_cc` NO tiene columna `updated_at` — solo `created_at`
        // (ver migration 20260522000008_cuentas-corrientes.js). El branch
        // `difieren=true` fallaba con "column updated_at does not exist"
        // en runtime pero estaba dormido: los tests de conciliation solo
        // cubrían `difieren=false` y en prod nunca se detectó porque la
        // conciliación cuadraba (F4 sano). Los movs cross-tenant son
        // append-only (no se editan post-creación), así que `created_at`
        // es equivalente semánticamente a "última actividad" acá. La CTE
        // hermana `op_prov_mov` ya usaba `created_at` → dejamos consistente.
        const detalleQ = await client.query(
          `WITH op_pagos AS (
             SELECT cross_tenant_operation_id AS op_id, COALESCE(SUM(monto_usd), 0) AS pagos
               FROM cross_tenant_pagos
               WHERE cross_tenant_operation_id = ANY($1::bigint[])
               GROUP BY 1
           ),
           op_mov_cc AS (
             SELECT cross_tenant_operation_id AS op_id, tenant_id, MAX(created_at) AS ultima
               FROM movimientos_cc
               WHERE cross_tenant_operation_id = ANY($1::bigint[])
                 AND deleted_at IS NULL
               GROUP BY 1, 2
           ),
           op_prov_mov AS (
             SELECT cross_tenant_operation_id AS op_id, tenant_id, MAX(created_at) AS ultima
               FROM proveedor_movimientos
               WHERE cross_tenant_operation_id = ANY($1::bigint[])
                 AND deleted_at IS NULL
               GROUP BY 1, 2
           )
           SELECT op.id, op.total_usd, op.seller_tenant_id, op.buyer_tenant_id,
                  op.created_at, op.parent_op_id,
                  COALESCE(p.pagos, 0) AS pagado_usd,
                  GREATEST(mcc.ultima, pm.ultima) AS ultima_actividad
             FROM cross_tenant_operations op
             LEFT JOIN op_pagos p ON p.op_id = op.id
             LEFT JOIN op_mov_cc mcc ON mcc.op_id = op.id AND mcc.tenant_id = op.seller_tenant_id
             LEFT JOIN op_prov_mov pm ON pm.op_id = op.id AND pm.tenant_id = op.buyer_tenant_id
             WHERE op.id = ANY($1::bigint[])
             ORDER BY op.id DESC`,
          [opIds]
        );
        opsDiferencias = detalleQ.rows.map((r) => ({
          op_id: r.id,
          total_usd: Number(r.total_usd),
          pagado_usd: Number(r.pagado_usd),
          restante_usd: round2(Number(r.total_usd) - Number(r.pagado_usd)),
          seller_tenant_id: r.seller_tenant_id,
          buyer_tenant_id: r.buyer_tenant_id,
          ultima_actividad: r.ultima_actividad,
          is_devolucion: r.parent_op_id != null,
          created_at: r.created_at,
        }));
      }

      return {
        partnership,
        partner,
        ops_count: ops.length,
        pagos_count: pagos.length,
        totalOpsUsd,
        totalPagosUsd,
        saldoNetoUsd,
        saldos: {
          // Tenant A's view: what tenant_b owes A (segun cc del A as seller)
          // and what A owes B (segun prov_mov of A as buyer)
          tenant_a_id: tenantA,
          tenant_b_id: tenantB,
          tenant_b_debe_a_A_segun_A: debeAAseguntenantA, // 0 si A no compró nada
          tenant_b_debe_a_A_segun_B: debeAAseguntenantB, // wait — debeAAseguntenantB is what?
          tenant_a_debe_a_B_segun_A: debeBSeguntenantA,
          tenant_a_debe_a_B_segun_B: debeBSeguntenantB,
          diff_dir_a: diffDirA,
          diff_dir_b: diffDirB,
          difieren,
          diferencia_usd,
        },
        opsDiferencias,
      };
    });

    if (data.notFound) {
      return res.status(404).json({ error: 'Partnership no encontrada', reason: 'not_found' });
    }

    const tenantAId = data.partnership.tenant_a_id;
    const mySide = myTenantId === tenantAId ? 'a' : 'b';

    const payload = {
      partnership: {
        id: data.partnership.id,
        partner: {
          id: data.partner.id,
          nombre: data.partner.nombre,
          slug: data.partner.slug,
          plan: data.partner.plan,
        },
        my_side: mySide,
        status: data.partnership.status,
      },
      totales: {
        operaciones_usd: data.totalOpsUsd,
        ops_count: data.ops_count,
        pagado_usd: data.totalPagosUsd,
        pagos_count: data.pagos_count,
        saldo_neto_usd: data.saldoNetoUsd,
      },
      saldos_bilaterales: data.saldos,
      ops_diferencias: data.opsDiferencias,
    };

    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
