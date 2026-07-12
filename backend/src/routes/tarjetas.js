// Módulo Tarjetas de Crédito.
// La "tarjeta" es un método de pago marcado como tal en Cajas (es_tarjeta, con su
// comision_pct) — la configuración vive ahí. Los cobros se generan SOLOS desde
// Ventas (lib/tarjetas.js): bruto → comisión de la financiera → neto que nos deben.
// Este módulo:
//   · Muestra el saldo pendiente por método (cobros − liquidaciones).
//   · Registra liquidaciones (cuando la financiera paga → ingresa a una caja real).
//   · Registra cobros previos (saldos de ventas anteriores al sistema; venta_id=NULL).
//   · Permite editar y eliminar cobros previos y liquidaciones. Los cobros
//     que vienen de una venta NO se editan acá (se ajustan desde la venta).
//   · Expone /saldos-resumen agregado para 360 & Capital.
// Montado en /api/tarjetas con requireAuth + requireCapability('tarjetas.trabajar') (app.js).
const router   = require('express').Router();
const db       = require('../config/database');
const validate = require('../lib/validate');
const audit    = require('../lib/audit');
const parseId  = require('../lib/parseId');
const requireCapability = require('../middleware/requireCapability');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { round2, computeNeto } = require('../lib/money');
const { postCajaMovimiento, reverseCajaMovimientos, grupoMoneda } = require('../lib/cajaLedger');
const { postCajaMovimientoTarjeta } = require('../lib/tarjetas');
const { saldoNetoCase } = require('../lib/tarjetasSaldo');
const { createLiquidacionSchema, createLiquidacionMultipleSchema, createCobroInicialSchema, updateMovimientoSchema } = require('../schemas/tarjetas');
const {
  parseIdempotencyKey,
  findExistingByIdempotencyKey,
  isIdempotencyConflict,
} = require('../lib/idempotency');

// Grupo de moneda (USD y USDT son intercambiables; ARS es su propio grupo).
// 2026-07-12 (auditoría TOTAL Financiero P3-6): removida versión local
// (drift) — ahora importamos el canónico de cajaLedger que soporta UYU
// (3 grupos: ARS, UYU, USD). La versión local tenía solo 2 grupos y
// tratal UYU como USD, corrompiendo cajas de tenants UY.

// Resumen por tarjeta. Acepta desde/hasta opcionales.
//
// Diseño operativo (decidido 2026-06-05 tras segundo feedback del PO):
//   · saldo:            "Saldo del período" = cobros del rango − liqs del rango.
//                       Si el rango es 'todo' (NULL/NULL), el saldo coincide
//                       con el histórico real (= lo que la financiera te debe
//                       HOY). Si filtrás por rango, refleja el MOVIMIENTO NETO
//                       del período (puede ser negativo si en ese rango se
//                       liquidaron más cobros de los que entraron — ej. mes
//                       donde le pagaron atrasos viejos).
//   · comision_total:   filtrado por rango. "Cuánto pagué en comisiones en X".
//   · bruto_total:      filtrado por rango. "Cuánto facturé en el período X".
//   · liquidado_total:  filtrado por rango. "Cuánto me liquidó la financiera
//                       en el período X" (suma de neto de tipo='liquidacion').
//   · movimientos:      count filtrado por rango (coherente con la tabla).
//
// El "estado actual real" (lo que te deben HOY sin importar filtro) sigue
// disponible vía /api/tarjetas/saldos-resumen — ese endpoint no toca el
// rango y lo usa 360 & Capital para sumar al patrimonio.
//
// El patrón "($N::date IS NULL OR m.fecha >= $N)" permite usar la misma
// query con o sin filtro — pasamos NULL cuando no hay rango y los CASE WHEN
// se cumplen siempre. Más limpio que tener dos variantes de SQL.
//
// resumenSql(d, h) genera el SQL con los placeholders de fecha en las
// posiciones d y h. Cada caller adapta según los params previos: en `/`
// son $1/$2; en `/:id` el $1 ya es el id, así que se usa $2/$3.
function resumenSql(d, h) {
  return `
    COALESCE(SUM(
      CASE WHEN m.tipo='cobro'
           AND ($${d}::date IS NULL OR m.fecha >= $${d}::date)
           AND ($${h}::date IS NULL OR m.fecha <= $${h}::date)
           THEN m.monto_neto ELSE 0 END
    ),0)
    - COALESCE(SUM(
      CASE WHEN m.tipo='liquidacion'
           AND ($${d}::date IS NULL OR m.fecha >= $${d}::date)
           AND ($${h}::date IS NULL OR m.fecha <= $${h}::date)
           THEN m.monto_neto ELSE 0 END
    ),0) AS saldo,
    COALESCE(SUM(
      CASE WHEN m.tipo='cobro'
           AND ($${d}::date IS NULL OR m.fecha >= $${d}::date)
           AND ($${h}::date IS NULL OR m.fecha <= $${h}::date)
           THEN m.monto_comision ELSE 0 END
    ),0) AS comision_total,
    COALESCE(SUM(
      CASE WHEN m.tipo='cobro'
           AND ($${d}::date IS NULL OR m.fecha >= $${d}::date)
           AND ($${h}::date IS NULL OR m.fecha <= $${h}::date)
           THEN m.monto_bruto ELSE 0 END
    ),0) AS bruto_total,
    COALESCE(SUM(
      CASE WHEN m.tipo='liquidacion'
           AND ($${d}::date IS NULL OR m.fecha >= $${d}::date)
           AND ($${h}::date IS NULL OR m.fecha <= $${h}::date)
           THEN m.monto_neto ELSE 0 END
    ),0) AS liquidado_total,
    COUNT(
      CASE WHEN ($${d}::date IS NULL OR m.fecha >= $${d}::date)
                AND ($${h}::date IS NULL OR m.fecha <= $${h}::date)
           THEN 1 END
    ) AS movimientos`;
}

// Lista de tarjetas = métodos de pago marcados como tarjeta, con su saldo pendiente.
router.get('/', async (req, res, next) => {
  try {
    const desde = req.query.desde || null;
    const hasta = req.query.hasta || null;
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT mp.id, mp.nombre, mp.moneda, mp.comision_pct, mp.activo, ${resumenSql(1, 2)}
           FROM metodos_pago mp
           LEFT JOIN tarjeta_movimientos m ON m.metodo_pago_id = mp.id AND m.deleted_at IS NULL
          WHERE mp.es_tarjeta = true AND mp.deleted_at IS NULL
          GROUP BY mp.id
          ORDER BY mp.nombre`,
        [desde, hasta]
      );
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

// Saldos agregados por moneda — consumido por 360 & Capital para sumar al
// patrimonio total los netos pendientes de liquidación. Una sola query, sin
// paginar. Agrupa USD y USDT en el mismo "grupoMoneda" porque conceptualmente
// son equivalentes 1:1.
router.get('/saldos-resumen', async (req, res, next) => {
  try {
    const row = await db.withTenant(req.tenantId, async (client) => {
      // 2026-06-21 TANDA 2 #341 DRY: usa saldoNetoCase canónico de
      // lib/tarjetasSaldo.js — single source of truth con bot y lista
      // paginada. Wrapped en CASE moneda para particionar el SUM en
      // 2 buckets (ARS / USD+USDT) sin re-evaluar la lógica.
      const { rows } = await client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN mp.moneda = 'ARS' THEN ${saldoNetoCase('m')} ELSE 0 END), 0) AS saldo_ars,
           COALESCE(SUM(CASE WHEN mp.moneda IN ('USD','USDT') THEN ${saldoNetoCase('m')} ELSE 0 END), 0) AS saldo_usd
         FROM tarjeta_movimientos m
         JOIN metodos_pago mp ON mp.id = m.metodo_pago_id
         -- mp.es_tarjeta=true es defense-in-depth: hoy no debería haber
         -- tarjeta_movimientos con métodos no-tarjeta, pero si alguien futuro
         -- introduce un bug que inserta uno (ej. seed mal escrito), Capital
         -- mentiría sumando "saldos" de cuentas que no son tarjetas.
         WHERE mp.deleted_at IS NULL AND mp.es_tarjeta = true`
      );
      return rows[0];
    });
    // Devolvemos números (no strings de pg) — el front suma directo sin Number().
    res.json({
      saldo_ars: Number(row.saldo_ars || 0),
      saldo_usd: Number(row.saldo_usd || 0),
    });
  } catch (err) { next(err); }
});

// Estado de cuenta unificado (paginado): movimientos de todas las tarjetas con su
// saldo acumulado calculado en el server (window) para que sea correcto aun paginando.
// maxLimit subido a 5000 (mismo techo que comprobantes) para el caso de export:
// la UI normal sigue pidiendo limit=500, el export PDF/XLSX hace re-fetch con 5000
// para incluir TODO el período (no solo lo paginado en pantalla).
router.get('/movimientos', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 5000 });
    // Filtro opcional por rango de fechas. Importante: el saldo_acum debe
    // reflejar el histórico real (cobros − liquidaciones desde el principio
    // del tiempo hasta el movimiento corriente), pero la window function NO
    // necesita correr sobre toda la tabla.
    //
    // Auditoría 2026-06-30 E-02 — perf: la implementación anterior hacía
    // `SUM(...) OVER (ORDER BY m.fecha, m.id)` en una CTE que escaneaba TODA
    // la tabla `tarjeta_movimientos WHERE deleted_at IS NULL` y solo filtraba
    // el rango en el outer SELECT. Postgres materializaba la window sobre el
    // universo entero antes de descartar lo que estaba fuera del rango → a
    // ~100k filas la query medía 200-500ms. Con el rediseño:
    //   · saldo_inicial: agregado acotado por `fecha < $desde` (un solo
    //     número, usa idx (tenant_id, fecha) si existe).
    //   · rango: window function corre solo sobre filas del rango pedido
    //     (no del histórico entero) calculando un `delta` parcial.
    //   · saldo_acum = saldo_inicial + delta — matemáticamente equivalente
    //     a la window global.
    // Cuando no hay `desde` el saldo_inicial es 0 (no hay PRE-rango) y el
    // resultado coincide con el comportamiento previo.
    const { desde, hasta } = req.query;
    const rangoParams = [];
    const rangoFiltros = ['m.deleted_at IS NULL'];
    if (desde) { rangoParams.push(desde); rangoFiltros.push(`m.fecha >= $${rangoParams.length}`); }
    if (hasta) { rangoParams.push(hasta); rangoFiltros.push(`m.fecha <= $${rangoParams.length}`); }
    const rangoWhere = ' WHERE ' + rangoFiltros.join(' AND ');

    const countParams = [];
    let countWhere = ' WHERE deleted_at IS NULL';
    if (desde) { countParams.push(desde); countWhere += ` AND fecha >= $${countParams.length}`; }
    if (hasta) { countParams.push(hasta); countWhere += ` AND fecha <= $${countParams.length}`; }

    // saldo_inicial: si hay `desde`, suma cobros − liquidaciones de TODO lo
    // anterior al rango (placeholder $1 = desde). Si no hay `desde`, la query
    // se skipea (saldo_inicial=0). Misma fórmula que la window: 'cobro'
    // suma monto_neto, todo lo demás (liquidacion) lo resta.
    const saldoInicialParams = desde ? [desde] : [];
    const saldoInicialSql = desde
      ? `SELECT COALESCE(SUM(CASE WHEN tipo='cobro' THEN monto_neto ELSE -monto_neto END), 0) AS saldo
           FROM tarjeta_movimientos
          WHERE deleted_at IS NULL AND fecha < $1`
      : null;

    const { count, dataRows } = await db.withTenant(req.tenantId, async (client) => {
      // count + saldo_inicial + rango se ejecutan secuencialmente sobre el
      // mismo client (obligatorio con pg@9+: no se pueden ejecutar queries
      // concurrentes sobre el mismo client — el protocolo Postgres es
      // secuencial, así que Promise.all no daba paralelismo real). La query
      // de `rango` inyecta el saldo_inicial como parámetro literal —
      // alternativa con subquery aumentaba el plan sin beneficio.
      const countRes = await client.query('SELECT COUNT(*) FROM tarjeta_movimientos' + countWhere, countParams);
      const saldoIniRes = saldoInicialSql
        ? await client.query(saldoInicialSql, saldoInicialParams)
        : { rows: [{ saldo: 0 }] };
      const saldoInicial = Number(saldoIniRes.rows[0]?.saldo || 0);
      const dataRes = await client.query(
        `WITH rango AS (
           SELECT m.id, m.metodo_pago_id, m.fecha, m.tipo, m.moneda, m.monto_bruto, m.pct,
                  m.monto_comision, m.monto_neto, m.caja_id, m.venta_id,
                  SUM(CASE WHEN m.tipo='cobro' THEN m.monto_neto ELSE -m.monto_neto END)
                      OVER (ORDER BY m.fecha, m.id) AS delta
             FROM tarjeta_movimientos m
            ${rangoWhere}
         )
         SELECT r.id, r.metodo_pago_id, r.fecha, r.tipo, r.moneda, r.monto_bruto, r.pct,
                r.monto_comision, r.monto_neto, r.caja_id, r.venta_id,
                ($${rangoParams.length + 1}::numeric + r.delta) AS saldo_acum,
                mp.nombre AS metodo_nombre, mc.nombre AS caja_nombre, v.order_id AS venta_order_id
           FROM rango r
           JOIN metodos_pago mp ON mp.id = r.metodo_pago_id
           LEFT JOIN metodos_pago mc ON mc.id = r.caja_id
           LEFT JOIN ventas v ON v.id = r.venta_id
          ORDER BY r.fecha DESC, r.id DESC
          LIMIT $${rangoParams.length + 2} OFFSET $${rangoParams.length + 3}`,
        [...rangoParams, saldoInicial, limit, offset]
      );
      return { count: parseInt(countRes.rows[0].count), dataRows: dataRes.rows };
    });
    res.json(paginatedResponse(dataRows, count, { page, limit }));
  } catch (err) { next(err); }
});

// Totales por período — agregado del estado de cuenta unificado para el header
// del export PDF/XLSX. Devuelve KPIs separados por moneda (ARS/USD/USDT) porque
// Tarjetas mezcla las tres y sumarlas todas falsea el "neto a recibir".
//
// El saldo NO se incluye acá (es histórico, no del período); para presentar
// "te deben" del período el helper lo calcula a partir de cobros − liquidaciones
// dentro del rango. Si querés saldo histórico, usá GET /api/tarjetas (resumen).
router.get('/movimientos/totales', async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;
    const params = [];
    let where = ' WHERE deleted_at IS NULL';
    if (desde) { params.push(desde); where += ` AND fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta); where += ` AND fecha <= $${params.length}`; }

    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT
           moneda,
           COUNT(*) FILTER (WHERE tipo = 'cobro')                                         AS cobros_count,
           COALESCE(SUM(monto_bruto)    FILTER (WHERE tipo = 'cobro'), 0)                 AS cobros_bruto,
           COALESCE(SUM(monto_comision) FILTER (WHERE tipo = 'cobro'), 0)                 AS comision,
           COALESCE(SUM(monto_neto)     FILTER (WHERE tipo = 'cobro'), 0)                 AS cobros_neto,
           COUNT(*) FILTER (WHERE tipo = 'liquidacion')                                   AS liquidaciones_count,
           COALESCE(SUM(monto_neto)     FILTER (WHERE tipo = 'liquidacion'), 0)           AS liquidado,
           COUNT(*)                                                                       AS total_count
         FROM tarjeta_movimientos
         ${where}
         GROUP BY moneda`,
        params
      );
      return rows;
    });

    // Estructura por moneda: facilita render condicional en el helper (si una
    // moneda no tiene movimientos, no aparece como sección).
    const init = () => ({
      cobros_count: 0, cobros_bruto: 0, comision: 0, cobros_neto: 0,
      liquidaciones_count: 0, liquidado: 0, total_count: 0,
      saldo_periodo: 0, // = cobros_neto − liquidado
    });
    const out = { ARS: init(), USD: init(), USDT: init(), count: 0 };
    for (const r of rows) {
      const k = (r.moneda || 'ARS').toUpperCase();
      if (!out[k]) continue; // moneda desconocida — defensivo, no debería pasar
      out[k] = {
        cobros_count:        parseInt(r.cobros_count),
        cobros_bruto:        parseFloat(r.cobros_bruto),
        comision:            parseFloat(r.comision),
        cobros_neto:         parseFloat(r.cobros_neto),
        liquidaciones_count: parseInt(r.liquidaciones_count),
        liquidado:           parseFloat(r.liquidado),
        total_count:         parseInt(r.total_count),
        saldo_periodo:       parseFloat(r.cobros_neto) - parseFloat(r.liquidado),
      };
      out.count += parseInt(r.total_count);
    }
    res.json(out);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const desde = req.query.desde || null;
    const hasta = req.query.hasta || null;
    const data = await db.withTenant(req.tenantId, async (client) => {
      const { rows: mp } = await client.query(
        'SELECT id, nombre, moneda, comision_pct, activo FROM metodos_pago WHERE id = $1 AND es_tarjeta = true AND deleted_at IS NULL', [id]
      );
      if (!mp[0]) return { notFound: true };
      // $1 = id (filtro fijo). $2/$3 son las fechas del rango opcional, que
      // el resumenSql usa para Comisión/Cobrado/Movimientos. Saldo sigue sin
      // filtrar (es estado actual, no agregado de período).
      const { rows: tot } = await client.query(
        `SELECT ${resumenSql(2, 3)} FROM tarjeta_movimientos m WHERE m.metodo_pago_id = $1 AND m.deleted_at IS NULL`,
        [id, desde, hasta]
      );
      return { tarjeta: mp[0], resumen: tot[0] };
    });
    if (data.notFound) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    res.json({ ...data.tarjeta, resumen: data.resumen });
  } catch (err) { next(err); }
});

router.get('/:id/movimientos', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });
    // Filtro opcional por fecha (vista Detalle de una tarjeta específica).
    // Acá no hay saldo_acum sobre window — el saldo total está en /tarjetas/:id
    // y se calcula sin filtro; la tabla del detalle solo lista movs del rango.
    const { desde, hasta } = req.query;
    const params = [id];
    const fechaClauses = [];
    if (desde) { params.push(desde); fechaClauses.push(`m.fecha >= $${params.length}`); }
    if (hasta) { params.push(hasta); fechaClauses.push(`m.fecha <= $${params.length}`); }
    const whereFecha = fechaClauses.length ? ' AND ' + fechaClauses.join(' AND ') : '';
    const { count, dataRows } = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query(
        `SELECT COUNT(*) FROM tarjeta_movimientos m
          WHERE m.metodo_pago_id = $1 AND m.deleted_at IS NULL${whereFecha}`,
        params
      );
      const dataRes = await client.query(
        `SELECT m.*, mp.nombre AS caja_nombre, v.order_id AS venta_order_id
           FROM tarjeta_movimientos m
           LEFT JOIN metodos_pago mp ON mp.id = m.caja_id
           LEFT JOIN ventas v ON v.id = m.venta_id
          WHERE m.metodo_pago_id = $1 AND m.deleted_at IS NULL${whereFecha}
          ORDER BY m.fecha DESC, m.id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      return { count: parseInt(countRes.rows[0].count), dataRows: dataRes.rows };
    });
    res.json(paginatedResponse(dataRows, count, { page, limit }));
  } catch (err) { next(err); }
});

// Cobro inicial / previo: saldo pendiente de ventas anteriores al sistema.
//
// Caso de uso: el operador arranca con el portal y ya tiene cobros pendientes
// en sus tarjetas de crédito de meses anteriores (ventas que no están
// registradas como tales en el sistema). En lugar de re-cargar todas esas
// ventas históricas, carga un "saldo inicial" por tarjeta.
//
// Crea un movimiento `tipo='cobro'` con `venta_id=NULL` (marker manual).
// Suma al saldo pendiente igual que cualquier otro cobro. Liquidaciones
// futuras lo cancelan sin distinción. El DELETE manual está permitido para
// estos (a diferencia de los cobros de venta) — ver comentario en DELETE.
//
// El neto se calcula server-side: bruto * (1 - pct/100). pct opcional: si
// no viene, se usa el comision_pct del método. Esto evita que el cliente
// pueda manipular el neto sin pasar por el cálculo correcto.
// 2026-06-23 F5a: gate inline. Registrar un cobro previo (saldo previo al
// sistema, sin venta_id asociada) es operación delicada — capability propia
// `tarjetas.cobro_previo`. Encargado/lectura/vendedor NO la tienen en
// default; owner/admin del tenant bypassean.
router.post('/cobros-iniciales', requireCapability('tarjetas.cobro_previo'), validate(createCobroInicialSchema), async (req, res, next) => {
  // Audit-in-tx (patrón H6): si el INSERT se commitea pero el audit falla, el
  // movimiento quedaba sin traza. Envolvemos ambos en la misma tx con savepoint
  // (audit.js lo maneja cuando recibe el client). Mismo patrón que el resto
  // del archivo (liquidación, PATCH, DELETE) — esta era una regresión.
  const client = await db.connect();
  try {
    const { metodo_pago_id, fecha, monto_bruto, pct, comentarios } = req.body;
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    const mp = await client.query(
      'SELECT moneda, comision_pct FROM metodos_pago WHERE id = $1 AND es_tarjeta = true AND deleted_at IS NULL',
      [metodo_pago_id]
    );
    if (!mp.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tarjeta no encontrada' }); }

    // Resolver el % efectivo: prioriza el del request, fallback al del método.
    const pctEfectivo = pct != null ? Number(pct) : Number(mp.rows[0].comision_pct || 0);
    const { bruto, comision, neto, pct: pctNorm } = computeNeto(monto_bruto, pctEfectivo);
    // Re-asignamos pctEfectivo a la versión normalizada (round2) que se persiste.
    const pctFinal = pctNorm;

    const { rows } = await client.query(
      `INSERT INTO tarjeta_movimientos
        (metodo_pago_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto,
         venta_id, caja_id, comentarios, user_id)
       VALUES ($1, $2, 'cobro', $3, $4, $5, $6, $7, NULL, NULL, $8, $9)
       RETURNING *`,
      [metodo_pago_id, fecha, mp.rows[0].moneda, bruto, pctFinal, comision, neto,
       comentarios ?? null, req.user.id]
    );

    // +ingreso por monto_neto en la caja-tarjeta (trazabilidad junio 2026).
    // Si la moneda del cobro no coincide con la de la tarjeta, postCaja
    // Movimiento throwea 400; el ROLLBACK del catch deja todo limpio.
    await postCajaMovimientoTarjeta(client, {
      metodo_pago_id, fecha, tipo: 'ingreso', monto: neto, moneda: mp.rows[0].moneda,
      ref_id: rows[0].id, concepto: 'Cobro previo', user_id: req.user.id,
    });

    await audit(client, 'tarjeta_movimientos', 'INSERT', rows[0].id, {
      despues: rows[0], tipo: 'cobro_inicial', user_id: req.user.id,
    });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { client.release(); }
});

// Liquidación: nos depositan el neto → ingreso a una caja real (origen 'tarjeta').
router.post('/liquidaciones', validate(createLiquidacionSchema), async (req, res, next) => {
  // 2026-07-12 (auditoría TOTAL Financiero P1-1, Pattern G): Idempotency-Key.
  const idem = parseIdempotencyKey(req);
  if (idem.error) {
    return res.status(400).json({ error: idem.error, reason: 'idempotency_key_invalid' });
  }

  const client = await db.connect();
  try {
    const { metodo_pago_id, fecha, monto, caja_id, comentarios } = req.body;
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    // Idempotency replay antes de tocar cajas/tarjeta.
    if (idem.key) {
      const existing = await findExistingByIdempotencyKey(client, 'tarjeta_movimientos', idem.key);
      if (existing) {
        await client.query('ROLLBACK');
        return res.status(200).json({ ...existing, idempotent_replay: true });
      }
    }

    const mp = await client.query('SELECT moneda FROM metodos_pago WHERE id = $1 AND es_tarjeta = true AND deleted_at IS NULL', [metodo_pago_id]);
    if (!mp.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tarjeta no encontrada' }); }
    const caja = await client.query('SELECT moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL', [caja_id]);
    if (!caja.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'La caja seleccionada no existe.' }); }
    const moneda = caja.rows[0].moneda;
    // La liquidación debe entrar a una caja de la misma moneda que la tarjeta;
    // si no, el saldo pendiente (que está en la moneda de los cobros) se corrompería.
    if (grupoMoneda(moneda) !== grupoMoneda(mp.rows[0].moneda)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `La caja (${moneda}) no coincide con la moneda de la tarjeta (${mp.rows[0].moneda}).` });
    }
    const m = round2(Number(monto));
    const { rows } = await client.query(
      `INSERT INTO tarjeta_movimientos (metodo_pago_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, caja_id, comentarios, user_id, client_generated_id)
       VALUES ($1,$2,'liquidacion',$3,$4,0,0,$4,$5,$6,$7,$8) RETURNING *`,
      [metodo_pago_id, fecha, moneda, m, caja_id, comentarios ?? null, req.user.id, idem.key]
    );
    // Ingreso a la caja destino (lo que ya existía).
    await postCajaMovimiento(client, {
      caja_id, fecha, tipo: 'ingreso', monto: m, moneda, tc: null,
      origen: 'tarjeta', ref_tabla: 'tarjeta_movimientos', ref_id: rows[0].id,
      concepto: 'Liquidación tarjeta', user_id: req.user.id,
    });
    // Egreso de la caja-tarjeta (trazabilidad junio 2026 — mismo ref_tabla/
    // ref_id, así reverseCajaMovimientos en DELETE revierte AMBOS en bloque).
    await postCajaMovimientoTarjeta(client, {
      metodo_pago_id, fecha, tipo: 'egreso', monto: m, moneda,
      ref_id: rows[0].id, concepto: 'Liquidación tarjeta', user_id: req.user.id,
    });
    await audit(client, 'tarjeta_movimientos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    // Race window Pattern G — UNIQUE atrapa al 2do concurrente.
    if (isIdempotencyConflict(err)) {
      return res.status(409).json({
        error: 'Otro request con la misma Idempotency-Key está en curso. Reintentá en un instante.',
        reason: 'idempotency_conflict',
      });
    }
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { client.release(); }
});

// Liquidación múltiple: la financiera deposita UN solo monto que cubre cupones
// de varios planes (TC | 1 Cuota + 3 Cuotas + 6 Cuotas en el mismo depósito).
// El operador desglosa el reparto en el front (le llega desglosado por la
// financiera) y este endpoint crea N movs + N ingresos a la caja destino,
// todo en UNA sola tx. Si cualquier reparto falla (ej. moneda incompatible
// con la caja), rollback completo — no querés un depósito a medias en
// producción. Audit-in-tx por cada movimiento creado.
//
// Conversión a USD (junio 2026): si convertir_usd=true + tc, las liquidaciones
// se siguen registrando en ARS en tarjeta_movimientos (bajan el pendiente
// correcto), pero el ingreso a la caja destino va en USD usando el TC.
// total_usd_efectivo (opcional) override del cálculo automático ARS/TC —
// útil cuando la financiera te depositó X USD con un redondeo distinto al
// matemático. Se distribuye proporcional al peso de cada reparto sobre el
// total ARS, preservando la suma exacta de USD en la caja.
//
// Body: { fecha, caja_id, repartos: [{ metodo_pago_id, monto }],
//         comentarios?, convertir_usd?, tc?, total_usd_efectivo?,
//         periodo_desde?, periodo_hasta? }
router.post('/liquidaciones-multiples', validate(createLiquidacionMultipleSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const {
      fecha, caja_id, comentarios, repartos,
      convertir_usd, tc, total_usd_efectivo,
      periodo_desde, periodo_hasta,
    } = req.body;
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    // 1. Validar caja destino.
    const caja = await client.query(
      'SELECT moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL', [caja_id]
    );
    if (!caja.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La caja seleccionada no existe.' });
    }
    const monedaCaja = caja.rows[0].moneda;

    // 2. Cargar todas las tarjetas en una sola query y validar (a) existen,
    //    (b) son tarjetas activas, (c) todas son de la MISMA moneda entre sí
    //    (no permitimos mezclar ARS + USD en un mismo reparto — sería ambiguo
    //    distribuir el TC). Cuando convertir_usd: la caja debe ser USD/USDT
    //    y las tarjetas deben ser ARS (operativamente: convertís pesos a
    //    dólares; los demás casos no se dan en la práctica). Cuando NO
    //    convertir_usd: caja y tarjetas deben coincidir en grupoMoneda
    //    (mismo criterio que la liquidación simple, retrocompat).
    const ids = repartos.map(r => r.metodo_pago_id);
    const mps = await client.query(
      'SELECT id, moneda, nombre FROM metodos_pago WHERE id = ANY($1) AND es_tarjeta = true AND deleted_at IS NULL',
      [ids]
    );
    if (mps.rows.length !== ids.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Alguna tarjeta no existe o no está activa.' });
    }
    const monedasTarjetas = new Set(mps.rows.map(m => m.moneda));
    if (monedasTarjetas.size > 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No se pueden mezclar tarjetas de distintas monedas en un mismo reparto.' });
    }
    const monedaTarjetas = mps.rows[0].moneda;

    if (convertir_usd) {
      // Solo soportamos ARS → USD (el caso real). Si el operador eligió
      // convertir pero la tarjeta ya está en USD, no hay nada que convertir.
      if (grupoMoneda(monedaTarjetas) === 'USD') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Las tarjetas ya están en USD; no hay nada que convertir.' });
      }
      if (grupoMoneda(monedaCaja) !== 'USD') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Si convertís a USD, la caja destino debe ser USD/USDT (es ${monedaCaja}).` });
      }
    } else {
      // Sin conversión: caja y tarjetas en mismo grupoMoneda (comportamiento
      // pre-existente para no romper liquidaciones que no convierten).
      if (grupoMoneda(monedaTarjetas) !== grupoMoneda(monedaCaja)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `La caja (${monedaCaja}) no coincide con la moneda de las tarjetas (${monedaTarjetas}).` });
      }
    }

    // 3. Calcular el reparto USD si aplica. Math:
    //    totalARS = suma(reparto.monto)
    //    totalUSD = total_usd_efectivo (override) ?? totalARS / tc
    //    USD_de_cada_reparto = (reparto.monto / totalARS) * totalUSD
    //    El último reparto absorbe el residuo de redondeo para preservar
    //    la suma exacta = totalUSD (evitar que la caja USD reciba 0.01 menos).
    const totalArs = round2(repartos.reduce((a, r) => a + Number(r.monto), 0));
    let usdPorReparto = null; // Map<metodo_pago_id, montoUsd> si convertir_usd
    if (convertir_usd) {
      const totalUsdRaw = total_usd_efectivo != null
        ? Number(total_usd_efectivo)
        : (totalArs / Number(tc));
      const totalUsd = round2(totalUsdRaw);
      usdPorReparto = new Map();
      let acumUsd = 0;
      for (let i = 0; i < repartos.length; i++) {
        const r = repartos[i];
        let usd;
        if (i === repartos.length - 1) {
          // Último → residuo exacto, no se redondea (cuadra la suma).
          usd = round2(totalUsd - acumUsd);
        } else {
          usd = round2((Number(r.monto) / totalArs) * totalUsd);
          acumUsd = round2(acumUsd + usd);
        }
        if (usd <= 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `El reparto USD para uno de los repartos quedó en 0 o negativo (revisá TC y montos).` });
        }
        usdPorReparto.set(r.metodo_pago_id, usd);
      }
    }

    // 4. Crear N filas + N ingresos a la caja + N audit logs.
    //    En tarjeta_movimientos el monto_neto sigue en ARS (es lo que baja
    //    el saldo pendiente de la tarjeta). El TC y el período se guardan
    //    en las columnas nuevas para trazabilidad (reverso, conciliación).
    //    El ingreso a caja va en USD si convertir_usd, sino en la moneda
    //    de la tarjeta (igual que antes).
    const created = [];
    for (const reparto of repartos) {
      const mp = mps.rows.find(m => m.id === reparto.metodo_pago_id);
      const m = round2(Number(reparto.monto));
      const tcGuardado = convertir_usd ? Number(tc) : null;
      const { rows } = await client.query(
        `INSERT INTO tarjeta_movimientos (
           metodo_pago_id, fecha, tipo, moneda,
           monto_bruto, pct, monto_comision, monto_neto,
           caja_id, comentarios, user_id,
           periodo_desde, periodo_hasta, tc
         )
         VALUES ($1,$2,'liquidacion',$3,$4,0,0,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          reparto.metodo_pago_id, fecha, mp.moneda,
          m,
          caja_id, comentarios ?? null, req.user.id,
          periodo_desde ?? null, periodo_hasta ?? null, tcGuardado,
        ]
      );
      const montoIngresoCaja = convertir_usd ? usdPorReparto.get(mp.id) : m;
      await postCajaMovimiento(client, {
        caja_id, fecha, tipo: 'ingreso',
        monto: montoIngresoCaja, moneda: monedaCaja, tc: tcGuardado,
        origen: 'tarjeta', ref_tabla: 'tarjeta_movimientos', ref_id: rows[0].id,
        concepto: `Liquidación ${mp.nombre}`, user_id: req.user.id,
      });
      // Egreso de la caja-tarjeta (trazabilidad junio 2026). Monto en ARS
      // (m), igual al que se descuenta del saldo pendiente.
      await postCajaMovimientoTarjeta(client, {
        metodo_pago_id: reparto.metodo_pago_id, fecha, tipo: 'egreso',
        monto: m, moneda: mp.moneda,
        ref_id: rows[0].id,
        concepto: `Liquidación ${mp.nombre} (múltiple)`, user_id: req.user.id,
      });
      // Audit con marker `batch: 'liquidacion_multiple'`. Si hubo conversión,
      // guardamos el USD efectivo del reparto para reconstruir la operación
      // desde el audit log si fuese necesario.
      await audit(client, 'tarjeta_movimientos', 'INSERT', rows[0].id, {
        despues: rows[0],
        batch: 'liquidacion_multiple',
        total_repartos: repartos.length,
        convertir_usd: !!convertir_usd,
        monto_caja: montoIngresoCaja,
        user_id: req.user.id,
      });
      created.push(rows[0]);
    }

    await client.query('COMMIT');
    const total = created.reduce((a, r) => a + Number(r.monto_neto), 0);
    res.status(201).json({
      movimientos: created,
      total,
      ...(convertir_usd ? { total_usd: Array.from(usdPorReparto.values()).reduce((a, v) => a + v, 0) } : {}),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// Edita un movimiento existente. Política simétrica al DELETE:
//   - cobros de venta (venta_id IS NOT NULL) → 400 (se ajusta editando la venta).
//   - cobros previos (venta_id IS NULL): se reescriben fecha, monto_bruto, pct,
//     comentarios y se recalculan comisión/neto server-side. No tocan cajas.
//   - liquidaciones: se reescriben fecha, monto, caja_id, comentarios. Como
//     impactan en cajas, se revierte el caja_movimiento previo y se postea uno
//     nuevo, todo dentro de la misma tx. Si la nueva caja difiere en moneda de
//     la tarjeta, 400. La validación de "no dejar caja en negativo" la aplica
//     reverseCajaMovimientos (mismo helper que DELETE).
//
// ⚠️ IMPORTANTE: NO optimizar el flow "reverse + repost" a un UPDATE in-place
// sobre caja_movimientos. Los caja_movimientos son ledger inmutable con
// trazabilidad — el reverseCajaMovimientos hace soft-delete de los rows viejos
// y postCajaMovimiento inserta rows nuevos. Esto preserva el histórico y
// permite auditoría contable. Un UPDATE in-place "más eficiente" rompería la
// invariante.
//
// 2026-07-12 (auditoría TOTAL Financiero P1-3): el catch abajo distingue el
// 409 según origen — antes decía "la caja X quedaría negativa" sin explicar
// por qué. Ahora dice "no se puede cambiar la caja destino porque..." cuando
// aplica.
router.patch('/movimientos/:id', validate(updateMovimientoSchema), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    const { rows: before } = await client.query(
      `SELECT m.*, mp.comision_pct AS metodo_comision_pct, mp.moneda AS metodo_moneda
         FROM tarjeta_movimientos m
         JOIN metodos_pago mp ON mp.id = m.metodo_pago_id
        WHERE m.id = $1 AND m.deleted_at IS NULL FOR UPDATE`,
      [id]
    );
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    const mov = before[0];

    // Misma regla que DELETE: los cobros de venta no se editan a mano.
    if (mov.tipo === 'cobro' && mov.venta_id != null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este cobro proviene de una venta. Se ajusta editando o cancelando la venta, no desde acá.' });
    }

    const body = req.body;
    let updated;

    if (mov.tipo === 'cobro') {
      // Cobro previo: recalcular comisión/neto a partir del nuevo bruto/pct.
      const fecha       = body.fecha       ?? mov.fecha;
      const pctInput    = body.pct != null ? Number(body.pct) : Number(mov.pct);
      if (pctInput < 0 || pctInput > 100) { await client.query('ROLLBACK'); return res.status(400).json({ error: '% comisión inválido.' }); }
      const { bruto, comision, neto, pct: pctFinal } = computeNeto(body.monto_bruto ?? mov.monto_bruto, pctInput);
      if (!(bruto > 0))     { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El bruto debe ser mayor a 0.' }); }
      const comentarios = body.comentarios === undefined ? mov.comentarios : (body.comentarios ?? null);
      const { rows } = await client.query(
        `UPDATE tarjeta_movimientos
            SET fecha = $2, monto_bruto = $3, pct = $4, monto_comision = $5, monto_neto = $6, comentarios = $7
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING *`,
        [id, fecha, bruto, pctFinal, comision, neto, comentarios]
      );
      updated = rows[0];

      // Trazabilidad junio 2026: si cambió el neto o la fecha, revertimos el
      // ingreso viejo en la caja-tarjeta y posteamos uno nuevo. Si solo cambió
      // metadata (comentarios), no tocamos la caja. reverseCajaMovimientos
      // valida que el saldo no quede negativo — si ya hubo una liquidación
      // que consumió este cobro, devuelve 409 con mensaje claro.
      const netoCambio  = Number(mov.monto_neto) !== neto;
      const fechaCambio = String(mov.fecha).slice(0, 10) !== String(fecha).slice(0, 10);
      if (netoCambio || fechaCambio) {
        await reverseCajaMovimientos(client, 'tarjeta_movimientos', id);
        await postCajaMovimientoTarjeta(client, {
          metodo_pago_id: mov.metodo_pago_id,
          fecha, tipo: 'ingreso', monto: neto, moneda: mov.moneda,
          ref_id: id, concepto: 'Cobro previo (editado)', user_id: req.user.id,
        });
      }
    } else if (mov.tipo === 'liquidacion') {
      // Liquidación: si cambia fecha/monto/caja_id, hay que actualizar el ledger
      // de cajas. Estrategia: revert (soft-delete del caja_movimiento existente
      // con validación de saldo) + repost (con la nueva caja_id/monto/fecha).
      // Es la misma mecánica que usa el DELETE de venta cuando hay cobros.
      //
      // #444 (2026-06-26): cuando la liquidación tiene conversión USD (mov.tc
      // IS NOT NULL), aceptamos editar tc y monto_usd además de los campos
      // ARS. El ingreso a la caja destino va en USD (monto_usd o monto_ars/tc).
      // Si no se manda tc/monto_usd en el body, se mantienen los valores
      // actuales — permite cambios parciales (ej. solo la fecha).
      const isUsd = mov.tc != null;

      const fecha   = body.fecha   ?? mov.fecha;
      const monto   = round2(Number(body.monto ?? mov.monto_neto));
      const caja_id = body.caja_id != null ? Number(body.caja_id) : Number(mov.caja_id);
      if (!(monto > 0)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El monto debe ser mayor a 0.' }); }
      const caja = await client.query('SELECT moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL', [caja_id]);
      if (!caja.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'La caja seleccionada no existe.' }); }
      const moneda = caja.rows[0].moneda;

      // Reglas de coherencia caja↔tarjeta:
      //   · liquidación sin USD: caja y tarjeta deben coincidir en grupoMoneda
      //   · liquidación USD: caja debe ser USD/USDT y tarjeta ARS (mismo
      //     criterio que el POST /liquidaciones-multiples con convertir_usd).
      //     Si el operador cambia la caja a una ARS, rechazamos — debería
      //     usar el DELETE+recrear path en ese caso (cambia toda la operación).
      if (isUsd) {
        if (grupoMoneda(moneda) !== 'USD') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Esta liquidación es con conversión USD; la caja destino debe ser USD/USDT (la elegida es ${moneda}).` });
        }
        if (grupoMoneda(mov.metodo_moneda) === 'USD') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Inconsistencia: la tarjeta está en USD pero el movimiento tiene tc — no debería existir.' });
        }
      } else {
        if (grupoMoneda(moneda) !== grupoMoneda(mov.metodo_moneda)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `La caja (${moneda}) no coincide con la moneda de la tarjeta (${mov.metodo_moneda}).` });
        }
      }

      // #444: TC y monto_usd. Si no vienen en body, mantenemos los actuales.
      // El monto_usd se calcula automáticamente como ARS/TC si no se manda
      // override explícito — mismo comportamiento que el POST multiple.
      let tcNuevo = null;
      let montoUsdParaCaja = null;
      if (isUsd) {
        tcNuevo = body.tc != null ? Number(body.tc) : Number(mov.tc);
        if (!(tcNuevo > 0)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'TC debe ser mayor a 0.' });
        }
        montoUsdParaCaja = body.monto_usd != null
          ? round2(Number(body.monto_usd))
          : round2(monto / tcNuevo);
        if (!(montoUsdParaCaja > 0)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Monto USD calculado quedó en 0 o negativo (revisá TC y monto ARS).' });
        }
      }

      const comentarios = body.comentarios === undefined ? mov.comentarios : (body.comentarios ?? null);

      // 1) Soft-delete de TODOS los caja_movimientos del mov (ingreso destino
      //    + egreso caja-tarjeta). reverseCajaMovimientos revierte por
      //    ref_tabla='tarjeta_movimientos' AND ref_id=id, así que pesca AMBOS.
      //    Si el egreso reverse dejara la caja-tarjeta en negativo, throwea 409.
      //
      // 2026-07-12 (Financiero P1-3): capturamos el flag "cambio caja destino"
      // para poder mejorar el mensaje del 409 en el catch. Si el usuario cambió
      // caja_id, un 409 aquí NO es "ROLLBACK/no puedo deshacer una cancelación"
      // — es "la caja original ya gastó el dinero, no puedo cambiar destino".
      const cambioCaja = Number(mov.caja_id) !== caja_id;
      // Guardar en el req para que el catch abajo lo consulte.
      req._patchCambioCaja = cambioCaja;
      req._patchCajaOrigId = mov.caja_id;
      await reverseCajaMovimientos(client, 'tarjeta_movimientos', id);

      // 2) Update del movimiento de tarjeta con los nuevos valores. moneda en
      //    tarjeta_movimientos sigue siendo la de la tarjeta (no de la caja
      //    destino) — el monto_neto sigue en ARS para liquidaciones USD,
      //    consistente con el POST.
      const monedaTarjetaMov = isUsd ? mov.metodo_moneda : moneda;
      const { rows } = await client.query(
        `UPDATE tarjeta_movimientos
            SET fecha = $2, monto_bruto = $3, monto_neto = $3, caja_id = $4,
                moneda = $5, comentarios = $6, tc = $7
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING *`,
        [id, fecha, monto, caja_id, monedaTarjetaMov, comentarios, isUsd ? tcNuevo : null]
      );
      updated = rows[0];

      // 3) Postear de nuevo AMBOS caja_movimientos: ingreso destino + egreso
      //    caja-tarjeta (trazabilidad junio 2026). Si USD: ingreso en USD
      //    usando monto_usd, egreso en ARS usando monto.
      await postCajaMovimiento(client, {
        caja_id, fecha, tipo: 'ingreso',
        monto: isUsd ? montoUsdParaCaja : monto,
        moneda,
        tc: isUsd ? tcNuevo : null,
        origen: 'tarjeta', ref_tabla: 'tarjeta_movimientos', ref_id: id,
        concepto: 'Liquidación tarjeta', user_id: req.user.id,
      });
      await postCajaMovimientoTarjeta(client, {
        metodo_pago_id: mov.metodo_pago_id, fecha, tipo: 'egreso',
        monto, moneda: mov.metodo_moneda,
        ref_id: id, concepto: 'Liquidación tarjeta (editado)', user_id: req.user.id,
      });
    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Tipo de movimiento no soportado.' });
    }

    // Pick de columnas reales de tarjeta_movimientos: `mov` viene de un JOIN
    // con metodos_pago (alias metodo_comision_pct, metodo_moneda) que NO son
    // columnas de la tabla auditada. Sin pick, esos aliases ensucian el
    // audit_logs.datos_antes y rompen simetría con `despues` (que viene del
    // RETURNING limpio).
    const movClean = { ...mov };
    delete movClean.metodo_comision_pct;
    delete movClean.metodo_moneda;
    await audit(client, 'tarjeta_movimientos', 'UPDATE', id, { antes: movClean, despues: updated, user_id: req.user.id });
    await client.query('COMMIT');
    res.json(updated);
  } catch (err) {
    await client.query('ROLLBACK');
    // 2026-07-12 (Financiero P1-3): mejorar el mensaje del 409 cuando el
    // reverseCajaMovimientos falla porque la caja original ya gastó el dinero.
    // Antes decía "la caja X quedaría negativa" sin decir por qué le importa
    // al operador (que solo quería cambiar destino). Ahora explica y sugiere
    // fix.
    if (err.status === 409 && req._patchCambioCaja) {
      return res.status(409).json({
        error:
          'No se puede cambiar la caja destino: la caja original ya gastó ' +
          'ese dinero y no se puede revertir el ingreso. Sugerencia: creá ' +
          'una liquidación nueva con la caja correcta y ajustá la caja ' +
          'original manualmente para reflejar la corrección.',
        reason: 'edit_caja_destino_locked',
        caja_original_id: req._patchCajaOrigId,
      });
    }
    // postCajaMovimiento(Tarjeta) y reverseCajaMovimientos throwean con
    // err.status (400 moneda mal/saldo insuficiente, 409 quedar negativo).
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { client.release(); }
});

router.delete('/movimientos/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    const { rows: before } = await client.query('SELECT tipo, venta_id FROM tarjeta_movimientos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    // Los cobros que provienen de una venta NO se borran a mano (desincronizaría
    // la venta). Pero los cobros iniciales/manuales (venta_id IS NULL — cargados
    // desde "Registrar cobro previo") SÍ se pueden borrar — son saldos manuales
    // que el operador agregó y puede revertir si se equivocó.
    if (before[0].tipo === 'cobro' && before[0].venta_id != null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este cobro proviene de una venta. Se ajusta editando o cancelando la venta, no desde acá.' });
    }
    const { rows } = await client.query('UPDATE tarjeta_movimientos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    await reverseCajaMovimientos(client, 'tarjeta_movimientos', id); // revierte la caja si era una liquidación
    // H6 auditoría 2026-06: audit DENTRO de la tx (con SAVEPOINT) — atómico
    // con el soft-delete y la reversión de caja. Antes audit corría DESPUÉS
    // del COMMIT con el pool global — si el proceso moría entre COMMIT y
    // audit (error de red, OOM kill, etc.), el cambio se persistía SIN trazas.
    // Patrón ya aplicado al resto de tarjetas.js y al resto del módulo.
    await audit(client, 'tarjeta_movimientos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

module.exports = router;
