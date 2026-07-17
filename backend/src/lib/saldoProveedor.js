// saldoProveedor.js — fórmula canónica para calcular el saldo de un proveedor
// (cuentas por pagar). FUENTE ÚNICA DE VERDAD, espejo de `saldoCC.js`.
//
// 2026-07-17 — Hasta hoy la fórmula estaba duplicada en 4 lugares con
// divergencias silenciosas:
//   · routes/proveedores.js#GET / (listado)      — completa
//   · routes/proveedores.js#GET /resumen/saldos  — completa
//   · lib/chat-tools.js#get_proveedores_pendientes — completa
//   · lib/dashboardMensual.js#deudaProveedores   — INCOMPLETA (bug)
// El dashboard mensual NO distinguía `compra` con caja_id (pagada de contado)
// vs sin caja_id (a crédito) — sumaba todas las compras como deuda. Efecto: la
// deuda del dashboard mensual quedaba INFLADA cada vez que había una compra
// pagada de contado. Cash flow reports viciados.
//
// La fórmula correcta (ya vigente en /proveedores + /resumen + chat-tools):
//   - `saldo_inicial`                    → +monto_usd (deuda heredada)
//   - `compra` con caja_id               → 0 (contado, no genera deuda)
//   - `compra` sin caja_id               → +monto_usd (deuda real)
//   - `pago`                             → -monto_usd (reduce deuda)
//   - `devolucion` (cross-tenant COR-2)  → -monto_usd (reduce deuda)
//   - otros                              → 0 (defensivo: si mañana alguien
//     agrega un tipo al CHECK sin tocar este helper, el saldo NO se corrompe
//     silenciosamente — se ignora hasta actualizar).
//
// Convención: monto positivo = les debemos al proveedor. Monto negativo = el
// proveedor nos debe (típico cuando adelantamos y aún no recibimos mercadería).
//
// Exporta dos variantes según el contexto del SQL:
//   · SALDO_CASE       → queries sin alias (`FROM proveedor_movimientos`).
//   · SALDO_CASE_M     → queries con alias `m` (`FROM proveedor_movimientos m`).

const SALDO_CASE = `
  CASE
    WHEN tipo = 'saldo_inicial'                        THEN  monto_usd
    WHEN tipo = 'compra' AND caja_id IS NOT NULL       THEN  0
    WHEN tipo = 'compra'                               THEN  monto_usd
    WHEN tipo = 'pago'                                 THEN -monto_usd
    WHEN tipo = 'devolucion'                           THEN -monto_usd
    ELSE 0
  END
`;

const SALDO_CASE_M = `
  CASE
    WHEN m.tipo = 'saldo_inicial'                      THEN  m.monto_usd
    WHEN m.tipo = 'compra' AND m.caja_id IS NOT NULL   THEN  0
    WHEN m.tipo = 'compra'                             THEN  m.monto_usd
    WHEN m.tipo = 'pago'                               THEN -m.monto_usd
    WHEN m.tipo = 'devolucion'                         THEN -m.monto_usd
    ELSE 0
  END
`;

module.exports = { SALDO_CASE, SALDO_CASE_M };
