/**
 * SLOs (Service Level Objectives) por scenario del load test.
 *
 * Fuente única de verdad — el runner (`run.js`) los enforcea con el flag
 * `--check-slo`, y `docs/LOAD_BASELINE.md` los referencia sin duplicarlos.
 *
 * Sprint post-audit 2026-07-20 (Rec proactiva #1).
 *
 * ── Cómo se eligen los valores ────────────────────────────────────────
 *
 * Los thresholds NO son "lo que aspiramos" — son "el techo aceptable
 * antes de que un usuario perciba lag". Ejemplo:
 *   - p50 300ms → mediana. La mitad de los usuarios responde dentro de eso.
 *     300ms es la latencia máxima que un humano NO percibe como "lento"
 *     (ver Google's RAIL model: 100ms para interactive, 300ms para load).
 *   - p90 800ms → el 10% peor. Ese percentil sí se percibe como lento pero
 *     todavía usable. Si p90 > 1s consistentemente, el portal "se siente
 *     lento" a la gente.
 *   - p99 3s → outliers. Si el 1% peor pasa 3s, algún usuario cada tanto
 *     ve la app trabada 3 seg. Molesto pero tolerable a nuestro scale.
 *   - error_rate 0.5% → mucho menor sería aspiracional. 0.5% cubre timeouts
 *     ocasionales de la infra Railway sin ruidear el signal.
 *
 * Los valores están **AJUSTADOS al piso de latencia AR ↔ California
 * (~225ms)** documentado en LOAD_BASELINE.md sección "Investigación piso".
 * Cuando/si migremos a South America East, bajar todos ~150ms.
 *
 * ── Cómo interpretar breach ───────────────────────────────────────────
 *
 * Un breach de SLO en un scenario NO es un incidente automático — es una
 * señal para investigar. Chequear en orden:
 *
 * 1. ¿Es un endpoint que empeoró vs baseline previa? → regresión de código
 *    reciente. `git bisect` sobre la última semana.
 * 2. ¿Es un endpoint que siempre estuvo cerca del threshold? → gap del SLO;
 *    quizás el threshold estaba mal calibrado o el crecimiento de datos
 *    empujó el endpoint por encima del gap.
 * 3. ¿Todos los endpoints degradaron a la vez? → problema de infra
 *    (DB CPU, pool saturation, network). Chequear Sentry APM + Railway
 *    dashboard.
 *
 * ── Aumentar / bajar thresholds ───────────────────────────────────────
 *
 * Cambios acá impactan CI (si eventualmente lo integramos) + reporte
 * manual. Documentar el motivo del cambio en el commit — "loosened SLO
 * de dashboard p90 de 500 a 800ms" debe venir con razón, no arbitrario.
 */

/**
 * Umbrales por scenario. Todos los valores en ms excepto errorRate (fracción).
 * Los scenarios sin entry usan defaults (`_default`).
 */
module.exports = {
  // Defaults conservadores — cualquier scenario nuevo sin config custom
  // usa estos. Fuerza a que agregar scenario nuevo obligue a evaluar SLOs.
  _default: {
    p50:       300, // mediana — antes de "lento perceptible"
    p90:       800, // 10% peor — todavía usable
    p99:      3000, // outliers — 1% ocasional trabado
    errorRate: 0.005, // 0.5% — timeouts razonables de infra
  },

  // Liveness probe — casi zero-cost. p50/p90 deben estar en el piso de
  // latencia (network + TLS overhead). Un pico acá indica infra rota.
  health: {
    p50:      500,  // baseline mayo era 226ms; margen 2× para no flakear
    p90:      800,
    p99:     8000,  // permitir 1 cold start ocasional (baseline mostró 7255ms una vez)
    errorRate: 0.001, // /health no debería errores casi nunca
  },

  // Endpoint más visitado del portal. Vendedores lo abren constantemente.
  // p50 lento acá degrada TODA la UX.
  inventario_list: {
    p50:      350,
    p90:      700,
    p99:     2000,
    errorRate: 0.005,
  },

  // Cacheado TTL 60s — el primer hit es el caro. En load test SOSTENIDO,
  // >90% de hits deberían caer en cache → p50/p90 rápidos. p99 refleja
  // los cold-cache hits.
  dashboard_resumen_mensual: {
    p50:      350,
    p90:      600,
    p99:     2500, // permite algún primer-hit caro con 8 queries paralelas
    errorRate: 0.005,
  },

  // Similar a dashboard — cacheado TTL 5min.
  alertas_eval: {
    p50:      350,
    p90:      600,
    p99:     2500,
    errorRate: 0.005,
  },

  // Saldo agregado por cliente — JOIN pesado sobre movimientos_cc.
  // p90 más permisivo por ser SQL agregation cost.
  cuentas_clientes: {
    p50:      400,
    p90:      900,
    p99:     3000,
    errorRate: 0.005,
  },

  // Idem cuentas — LEFT JOIN sobre proveedor_movimientos.
  proveedores_list: {
    p50:      400,
    p90:      900,
    p99:     3000,
    errorRate: 0.005,
  },

  // Search ILIKE — depende del índice GIN trigram. p50 rápido si el índice
  // funciona; lento indica que dropeó el índice o se hizo un table scan.
  contactos_search: {
    p50:      350,
    p90:      600,
    p99:     1500,
    errorRate: 0.005,
  },
};
