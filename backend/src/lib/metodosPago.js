// Auditoría 2026-06-30 Q-12:
// Helper compartido para consultar el catálogo de métodos de pago
// (= cajas activas) en su forma "lite": sólo lo que necesita un selector
// (id, nombre, moneda, flags, comisión, orden). NO incluye saldos ni
// movimientos — datos sensibles que sí requieren capability cajas.
//
// ¿Por qué un helper y no consolidar los 2 endpoints en uno?
// Los dos endpoints conviven a propósito (decisión documentada en cada
// route file). Se diferencian por capability/scope:
//
//   1. GET /api/ventas/metodos-pago  (routes/ventas-extra.js)
//      Gateado por capability `ventas`. Usado por la pantalla de Ventas
//      vía `ventas.metodosPago()`. Vive bajo /api/ventas/* para mantener
//      el binding histórico del shape devuelto al frontend de ventas y
//      el versionado del contrato del módulo.
//
//   2. GET /api/metodos-pago         (routes/metodos-pago.js)
//      Sin capability extra: cualquier user logueado puede listarlas.
//      Necesario porque operadores con permiso `envios` pero SIN `cajas`
//      ni `ventas` igual tienen que elegir caja para cobrar un envío.
//      (Bug 2026-06-10 reportado por Lucas — ver comment en metodos-pago.js)
//
// Consolidarlos rompería el gate de capability o el contrato de la ruta
// histórica. Por eso lo dejamos así y compartimos SOLO la query, que es
// el punto donde una drift entre ambos endpoints sería peligrosa (un
// cambio de whitelist de columnas que no replique en el otro vuelve a
// leakear `saldo_inicial`, exactamente el bug que Q-02/Q-03 cerró).

/**
 * Ejecuta el SELECT canónico del catálogo de métodos de pago activos.
 * Devuelve filas con shape: { id, nombre, moneda, es_financiera, es_tarjeta,
 * comision_pct, orden }. Whitelist explícito — no usar `SELECT *` acá:
 * `saldo_inicial` no debe llegar a la respuesta de ninguno de los 2 endpoints.
 *
 * @param {import('pg').PoolClient} client Cliente bajo `db.withTenant` (RLS).
 * @returns {Promise<Array<object>>}
 */
async function listMetodosPagoQuery(client) {
  const { rows } = await client.query(
    `SELECT id, nombre, moneda, es_financiera, es_tarjeta, comision_pct, orden
       FROM metodos_pago
      WHERE deleted_at IS NULL AND activo = true
      ORDER BY orden, nombre`
  );
  return rows;
}

module.exports = { listMetodosPagoQuery };
