// saldoCC.js — fórmula canónica para calcular el saldo de cuenta corriente
// (clientes B2B). FUENTE ÚNICA DE VERDAD.
//
// 2026-06-11 S-03 — Hasta hoy, el módulo de Cuentas (routes/cuentas.js) y el
// dashboard mensual (lib/dashboardMensual.js) usaban fórmulas DISTINTAS:
//   · El módulo descontaba como "no deuda" los movimientos `compra` con
//     `caja_id IS NOT NULL` (venta de contado vía caja — no genera deuda).
//   · El dashboard sumaba TODOS los `compra` como deuda, sin distinguir.
// Resultado: el "total deuda CC" del dashboard ERA MAYOR que el de la pantalla
// operativa cada vez que había B2B pagadas de contado. Decisiones de cash-flow
// viciadas.
//
// La fórmula correcta es la del módulo:
//   - `saldo_inicial`             → +monto (es deuda heredada al alta del cliente)
//   - `compra` con caja_id        → 0 (pagado de contado, no genera deuda)
//   - `compra` sin caja_id        → +monto (deuda real)
//   - resto (pago, ajuste, etc.)  → -monto (reduce deuda)
//
// Exporta dos variantes según el contexto del SQL:
//   · SALDO_CASE       → para queries sin alias (`FROM movimientos_cc`).
//   · SALDO_CASE_M     → para queries con alias `m` (`FROM movimientos_cc m`).

// 2026-07-17: agregado `pago_a_cliente` como suma (opuesto al ELSE catch-all
// que resta). Cuando NOSOTROS le damos dinero al cliente el saldo SUBE (queda
// debiéndonos más O canceló su crédito a favor). El ELSE sigue cubriendo
// pago / parte_de_pago / devolucion / entrega_mercaderia / mercaderia_recibida
// (todos restan al saldo del cliente).
const SALDO_CASE = `
  CASE
    WHEN tipo = 'saldo_inicial'                       THEN  monto_total
    WHEN tipo = 'compra' AND caja_id IS NOT NULL      THEN  0
    WHEN tipo = 'compra'                              THEN  monto_total
    WHEN tipo = 'pago_a_cliente'                      THEN  monto_total
    ELSE -monto_total
  END
`;

const SALDO_CASE_M = `
  CASE
    WHEN m.tipo = 'saldo_inicial'                     THEN  m.monto_total
    WHEN m.tipo = 'compra' AND m.caja_id IS NOT NULL  THEN  0
    WHEN m.tipo = 'compra'                            THEN  m.monto_total
    WHEN m.tipo = 'pago_a_cliente'                    THEN  m.monto_total
    ELSE -m.monto_total
  END
`;

module.exports = { SALDO_CASE, SALDO_CASE_M };
