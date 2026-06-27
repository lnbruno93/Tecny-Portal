/**
 * Helpers de Red B2B partnerships (F1).
 *
 * Convención central: la tabla `tenant_partnerships` enforza
 * `tenant_a_id < tenant_b_id` SIEMPRE. Eso evita tener (A,B) y (B,A) como
 * filas distintas para el mismo vínculo. Cualquier código que consulte o
 * inserte partnerships DEBE pasar primero los IDs por `orderTenantIds`
 * para alinearse con la convención.
 *
 * Diseño completo en docs/design/red-b2b-cross-tenant.md sección 4.3.
 */

/**
 * Ordena dos tenant IDs ascendente.
 *
 * @param {number} t1
 * @param {number} t2
 * @returns {[number, number]} — [a, b] con a < b
 * @throws {Error} si los IDs son iguales (vínculo a sí mismo)
 */
function orderTenantIds(t1, t2) {
  if (!Number.isInteger(t1) || !Number.isInteger(t2)) {
    throw new Error(`orderTenantIds: IDs deben ser enteros (got ${t1}, ${t2})`);
  }
  if (t1 === t2) {
    throw new Error(`orderTenantIds: tenant no puede vincularse consigo mismo (${t1})`);
  }
  return t1 < t2 ? [t1, t2] : [t2, t1];
}

/**
 * Busca partnership ACTIVA entre dos tenants. Devuelve la fila o null.
 *
 * Acepta los IDs en cualquier orden — se reordenan internamente. Pensado
 * para el caso "¿hay vínculo vigente entre A y B?" sin que el caller tenga
 * que conocer la convención.
 *
 * @param {object} client — pg.Client (puede ser admin con BYPASSRLS o normal)
 * @param {number} tenantX
 * @param {number} tenantY
 * @returns {Promise<object|null>}
 */
async function getActivePartnership(client, tenantX, tenantY) {
  const [a, b] = orderTenantIds(tenantX, tenantY);
  const { rows } = await client.query(
    `SELECT * FROM tenant_partnerships
       WHERE tenant_a_id = $1 AND tenant_b_id = $2
         AND status = 'active'`,
    [a, b]
  );
  return rows[0] || null;
}

/**
 * Busca una partnership por id, devolviéndola sólo si `tenantId` participa
 * (es tenant_a_id o tenant_b_id). Sino, null. Pensado para validar que el
 * caller tiene autoridad sobre la partnership antes de mutarla.
 *
 * Sin restricción de status — devuelve pending/active/revoked indistinto.
 * Los handlers chequean el status que necesitan después (e.g. accept exige
 * pending, revoke exige active).
 *
 * @param {object} client — pg.Client
 * @param {number} partnershipId
 * @param {number} tenantId
 * @returns {Promise<object|null>}
 */
async function getActivePartnershipById(client, partnershipId, tenantId) {
  const { rows } = await client.query(
    `SELECT * FROM tenant_partnerships
       WHERE id = $1
         AND (tenant_a_id = $2 OR tenant_b_id = $2)`,
    [partnershipId, tenantId]
  );
  return rows[0] || null;
}

module.exports = {
  orderTenantIds,
  getActivePartnership,
  getActivePartnershipById,
};
