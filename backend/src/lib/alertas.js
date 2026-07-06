// Evaluador de alertas — corre en runtime las queries de cada tipo activo
// y devuelve los items que disparan cada alerta.
//
// Cada evaluador devuelve un array de "items" — el shape depende del tipo,
// pero todos llevan al menos: id (del recurso afectado), descripcion,
// link_sugerido (donde el front puede llevar al usuario). El front
// renderiza la lista y armar el deep link.
//
// 2026-06-20 #343 — refactor tenant-aware:
//   Pre-fix: las funciones eval* usaban `db.query(...)` directo, sin
//   `SET LOCAL app.current_tenant`. Con la RLS strict (#293/#337) que ya
//   no tolera NULL en la setting, esto resultó en TODAS las queries
//   filtrando 0 rows en prod (Railway corre como rol NOSUPERUSER). El
//   módulo /api/alertas devolvía silenciosamente `{ total_alertas: 0 }`
//   desde el deploy de la migration `rls_fail_closed`. En desarrollo
//   local NO se notaba porque el rol es superuser + bypassrls.
//
//   El fix: cada eval* ahora recibe un `client` ya scopeado a tenant
//   (parte de una `db.withTenant(tenantId, async (client) => ...)`).
//   `evaluarTodas({ tenantId })` es el wrapper público, abre la tx ÚNICA
//   para todos los evaluadores y devuelve la respuesta agregada. Cualquier
//   caller (route, chat tool, cron) DEBE pasar tenantId — no hay path
//   global porque alertas son ESPECÍFICAS del tenant por definición.

// SALDO_CASE_M = fórmula canónica de saldo CC (lib/saldoCC.js).
// 2026-06-20 TANDA 0 fix #341: evalCcMora inlineaba un CASE distinto
// (sumaba 'entrega_mercaderia' como deuda en vez de pago), divergiendo
// del módulo /api/cuentas + del dashboard. Adoptamos la única fuente de
// verdad para que las 3 vistas reporten el mismo número.
const { SALDO_CASE_M } = require('./saldoCC');

// ──────────────────────────────────────────────────────────────────────
// 1. caja_negativa — cualquier caja con saldo actual < 0.
// ──────────────────────────────────────────────────────────────────────
async function evalCajaNegativa(client) {
  const { rows } = await client.query(
    `SELECT mp.id, mp.nombre, mp.moneda,
            mp.saldo_inicial + COALESCE(SUM(
              CASE WHEN cm.tipo = 'ingreso' THEN cm.monto ELSE -cm.monto END
            ), 0) AS saldo
       FROM metodos_pago mp
       LEFT JOIN caja_movimientos cm
              ON cm.caja_id = mp.id AND cm.deleted_at IS NULL
      WHERE mp.deleted_at IS NULL
      GROUP BY mp.id, mp.nombre, mp.moneda, mp.saldo_inicial
      HAVING mp.saldo_inicial + COALESCE(SUM(
               CASE WHEN cm.tipo = 'ingreso' THEN cm.monto ELSE -cm.monto END
             ), 0) < 0
      ORDER BY saldo ASC
      LIMIT 50`
  );
  return rows.map(r => ({
    id: r.id,
    descripcion: `${r.nombre} (${r.moneda}) — saldo ${Number(r.saldo).toFixed(2)}`,
    saldo: Number(r.saldo),
    moneda: r.moneda,
    link: '/cajas',
  }));
}

// ──────────────────────────────────────────────────────────────────────
// 2. stock_bajo — productos con cantidad < umbral.
//    Solo considera productos visibles + activos (no ocultos, no vendidos).
// ──────────────────────────────────────────────────────────────────────
async function evalStockBajo(client, { umbral_unidades = 5 } = {}) {
  const { rows } = await client.query(
    `SELECT p.id, p.nombre, p.cantidad, c.nombre AS categoria,
            COALESCE(p.proveedor, '—') AS proveedor
       FROM productos p
       LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.deleted_at IS NULL
        AND p.estado <> 'vendido'
        AND p.oculto = false
        AND p.trackear_stock = true
        AND p.cantidad < $1
      ORDER BY p.cantidad ASC, p.nombre
      LIMIT 50`,
    [umbral_unidades]
  );
  return rows.map(r => ({
    id: r.id,
    descripcion: `${r.nombre} — ${r.cantidad} ud. (categoría: ${r.categoria || 'sin asignar'})`,
    cantidad: Number(r.cantidad),
    link: `/inventario?search=${encodeURIComponent(r.nombre)}`,
  }));
}

// ──────────────────────────────────────────────────────────────────────
// 3. cc_mora — clientes CC con saldo > 0 (nos deben) cuyo último movimiento
//    de pago fue hace más de N días. Si nunca hubo pago, se usa la fecha
//    del primer movimiento como referencia.
// ──────────────────────────────────────────────────────────────────────
async function evalCcMora(client, { dias_sin_pago = 30 } = {}) {
  const { rows } = await client.query(
    `WITH saldos AS (
       SELECT c.id, c.nombre, c.apellido, c.categoria,
              COALESCE(SUM(${SALDO_CASE_M}), 0) AS saldo,
              MAX(m.fecha) FILTER (WHERE m.tipo IN ('pago', 'parte_de_pago')) AS ultimo_pago,
              MIN(m.fecha) AS primer_mov
         FROM clientes_cc c
         LEFT JOIN movimientos_cc m
                ON m.cliente_cc_id = c.id AND m.deleted_at IS NULL
        WHERE c.deleted_at IS NULL
        GROUP BY c.id, c.nombre, c.apellido, c.categoria
     )
     SELECT id, nombre, apellido, categoria, saldo, ultimo_pago, primer_mov,
            CURRENT_DATE - COALESCE(ultimo_pago, primer_mov) AS dias_sin_pago
       FROM saldos
      WHERE saldo > 0
        AND CURRENT_DATE - COALESCE(ultimo_pago, primer_mov) > $1
      ORDER BY dias_sin_pago DESC, saldo DESC
      LIMIT 50`,
    [dias_sin_pago]
  );
  return rows.map(r => ({
    id: r.id,
    descripcion: `${r.nombre}${r.apellido ? ' ' + r.apellido : ''} — debe USD ${Number(r.saldo).toFixed(2)} · ${r.dias_sin_pago} días sin pago`,
    saldo: Number(r.saldo),
    dias_sin_pago: r.dias_sin_pago,
    link: `/cuentas/${r.id}`,
  }));
}

// ──────────────────────────────────────────────────────────────────────
// 4. proveedor_atrasado — proveedores con saldo > 0 (les debemos) sin
//    movimiento (ni compra ni pago) hace más de N días.
// ──────────────────────────────────────────────────────────────────────
async function evalProveedorAtrasado(client, { dias_sin_movimiento = 30 } = {}) {
  const { rows } = await client.query(
    `WITH saldos AS (
       SELECT p.id, p.nombre,
              COALESCE(SUM(CASE m.tipo
                WHEN 'compra'     THEN m.monto_usd
                WHEN 'pago'       THEN -m.monto_usd
                -- COR-2 audit 2026-07-06: 'devolucion' cross-tenant B2B
                -- baja la deuda al proveedor (equivalente contable a pago).
                WHEN 'devolucion' THEN -m.monto_usd
                ELSE 0
              END), 0) AS saldo,
              MAX(m.fecha) AS ultimo_movimiento
         FROM proveedores p
         LEFT JOIN proveedor_movimientos m
                ON m.proveedor_id = p.id AND m.deleted_at IS NULL
        WHERE p.deleted_at IS NULL
        GROUP BY p.id, p.nombre
     )
     SELECT id, nombre, saldo, ultimo_movimiento,
            CURRENT_DATE - ultimo_movimiento AS dias_sin_movimiento
       FROM saldos
      WHERE saldo > 0
        AND ultimo_movimiento IS NOT NULL
        AND CURRENT_DATE - ultimo_movimiento > $1
      ORDER BY dias_sin_movimiento DESC, saldo DESC
      LIMIT 50`,
    [dias_sin_movimiento]
  );
  return rows.map(r => ({
    id: r.id,
    descripcion: `${r.nombre} — debemos USD ${Number(r.saldo).toFixed(2)} · ${r.dias_sin_movimiento} días sin movimiento`,
    saldo: Number(r.saldo),
    dias_sin_movimiento: r.dias_sin_movimiento,
    link: `/proveedores`,
  }));
}

// ──────────────────────────────────────────────────────────────────────
// Registry: cada tipo apunta a su función evaluadora.
// Para agregar un tipo nuevo: 1) agregar acá; 2) hacer INSERT en alertas_config.
// ──────────────────────────────────────────────────────────────────────
const EVALUADORES = {
  caja_negativa:      evalCajaNegativa,
  stock_bajo:         evalStockBajo,
  cc_mora:            evalCcMora,
  proveedor_atrasado: evalProveedorAtrasado,
};

const TITULOS = {
  caja_negativa:      'Caja en negativo',
  stock_bajo:         'Stock bajo',
  cc_mora:            'Clientes en mora',
  proveedor_atrasado: 'Proveedores con deuda atrasada',
};

const SEVERIDAD = {
  caja_negativa:      'critica',  // dinero faltante = crítico
  stock_bajo:         'media',
  cc_mora:            'alta',
  proveedor_atrasado: 'media',
};

/**
 * Evalúa todas las alertas activas del tenant en paralelo. Devuelve un
 * array de "grupos" — uno por tipo activo evaluable, con items + metadata.
 * Si un evaluador falla, esa alerta queda en error pero las demás siguen.
 *
 * Importante: solo procesa tipos que tienen evaluador en EVALUADORES.
 * Tipos "settings" (ej. tc_referencia, que es solo un valor de referencia
 * consumido por el frontend) NO entran en el array de grupos — no son
 * alertas activas, son configuración global.
 *
 * Todo el cómputo corre en UNA sola transacción con `SET LOCAL
 * app.current_tenant = tenantId`, así RLS filtra automáticamente y
 * compartimos snapshot consistente entre los 4 evaluadores.
 *
 * @param {object} opts
 * @param {number} opts.tenantId — REQUIRED. tenant cuyas alertas evaluamos.
 * @param {object} [opts.db] — opcional, default require('../config/database').
 *   Inyectable para tests que quieran mockear el pool.
 */
async function evaluarTodas({ tenantId, db } = {}) {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(`evaluarTodas: tenantId inválido (${tenantId})`);
  }
  const pool = db || require('../config/database');

  return pool.withTenant(tenantId, async (client) => {
    // Filtro explícito por tenant_id además de RLS — defense in depth.
    // Misma lógica que el fix #336 en /api/historial: si por algún motivo el
    // SET LOCAL no aplica (ej. role superuser+bypassrls en testing local), el
    // WHERE explícito sigue manteniendo el aislamiento.
    const { rows: configs } = await client.query(
      'SELECT tipo, activa, parametros FROM alertas_config WHERE tenant_id = $1 ORDER BY tipo',
      [tenantId]
    );
    // Filtrar: activos Y evaluables (con función registrada).
    const evaluables = configs.filter(c => c.activa && EVALUADORES[c.tipo]);
    // Corremos en paralelo. Todos comparten el MISMO client (misma tx) →
    // se serializan a nivel de conexión PG pero el costo en latencia es
    // menor que abrir 4 transacciones separadas + 4 SET LOCAL.
    const resultados = await Promise.all(evaluables.map(async (cfg) => {
      const fn = EVALUADORES[cfg.tipo];
      try {
        const items = await fn(client, cfg.parametros || {});
        return {
          tipo:        cfg.tipo,
          titulo:      TITULOS[cfg.tipo] || cfg.tipo,
          severidad:   SEVERIDAD[cfg.tipo] || 'media',
          parametros:  cfg.parametros,
          count:       items.length,
          items,
        };
      } catch (err) {
        return { tipo: cfg.tipo, error: err.message, items: [], count: 0 };
      }
    }));
    return resultados;
  });
}

// Set de tipos que son "configuraciones globales" (no listas de items
// que se muestren en /alertas → Activas). Front los renderiza como
// settings cards aparte. La lista vive acá para que el route las pueda
// filtrar/diferenciar al validar el PUT /config/:tipo.
const TIPOS_SETTING = new Set(['tc_referencia']);

module.exports = {
  evaluarTodas,
  EVALUADORES,
  TITULOS,
  SEVERIDAD,
  TIPOS_SETTING,
  // Exportados para tests unitarios per-evaluador
  _internal: {
    evalCajaNegativa,
    evalStockBajo,
    evalCcMora,
    evalProveedorAtrasado,
  },
};
