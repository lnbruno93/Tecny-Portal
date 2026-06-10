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

const router = require('express').Router();
const db = require('../config/database');

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, nombre, moneda, es_financiera, es_tarjeta, comision_pct, orden
         FROM metodos_pago
        WHERE deleted_at IS NULL AND activo = true
        ORDER BY orden, nombre`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
