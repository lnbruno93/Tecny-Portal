// Lista lite de métodos de pago (= cajas activas) para usar como selector en
// otros módulos (Envíos, Ventas, B2B, etc.).
//
// 2026-06-10 — bug reportado por Lucas: un operador con permiso `envios` pero
// SIN permiso `cajas` no podía elegir caja al cobrar un envío. El endpoint
// /api/cajas y /api/ventas/metodos-pago requieren los permisos `cajas` y
// `ventas` respectivamente, y se servían 403 → el frontend de Envíos quedaba
// con la lista vacía y solo aparecía "Cuenta corriente" en el select.
//
// Este endpoint es público para cualquier usuario logueado: devuelve SOLO la
// info necesaria para usar la caja como medio de cobro (id, nombre, moneda,
// flags es_financiera/es_tarjeta, comisión, orden). NO incluye saldos ni
// movimientos — datos sensibles que sí requieren permiso `cajas` para verse.
//
// Auditoría 2026-06-30 Q-12: la query la comparte con /api/ventas/metodos-pago
// (routes/ventas-extra.js) vía lib/metodosPago.js. NO se consolidan en un
// único endpoint a propósito: son 2 capabilities distintas (este es público
// para todos los logueados; el otro requiere cap `ventas`). Compartir la
// query evita drift de columnas — un olvido aquí re-leakearía `saldo_inicial`.

const router = require('express').Router();
const db = require('../config/database');
const { listMetodosPagoQuery } = require('../lib/metodosPago');

router.get('/', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, (client) => listMetodosPagoQuery(client));
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
