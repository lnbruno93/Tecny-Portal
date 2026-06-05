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
// Montado en /api/tarjetas con requireAuth + requirePermission('tarjetas') (app.js).
const router   = require('express').Router();
const db       = require('../config/database');
const validate = require('../lib/validate');
const audit    = require('../lib/audit');
const parseId  = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { round2, computeNeto } = require('../lib/money');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const { createLiquidacionSchema, createLiquidacionMultipleSchema, createCobroInicialSchema, updateMovimientoSchema } = require('../schemas/tarjetas');

// Grupo de moneda (USD y USDT son intercambiables; ARS es su propio grupo).
const grupoMoneda = (m) => (m === 'ARS' ? 'ARS' : 'USD');

// Resumen por tarjeta. Acepta desde/hasta opcionales.
//
// Diseño operativo (decidido tras feedback del PO 2026-06):
//   · saldo:            SIEMPRE histórico. Es el saldo real que la financiera
//                       nos debe HOY. No tiene sentido filtrarlo por fecha
//                       (no es agregado de operaciones, es un balance presente).
//   · comision_total:   filtrado por rango si se manda desde/hasta. "Cuánto
//                       pagué en comisiones en el período X".
//   · bruto_total:      filtrado por rango. "Cuánto facturé en el período X".
//   · liquidado_total:  filtrado por rango. "Cuánto me liquidó la financiera
//                       en el período X" (suma de neto de tipo='liquidacion').
//   · movimientos:      count filtrado por rango (coherente con la tabla).
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
    COALESCE(SUM(CASE WHEN m.tipo='cobro'        THEN m.monto_neto ELSE 0 END),0)
    - COALESCE(SUM(CASE WHEN m.tipo='liquidacion' THEN m.monto_neto ELSE 0 END),0) AS saldo,
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
    const { rows } = await db.query(
      `SELECT mp.id, mp.nombre, mp.moneda, mp.comision_pct, mp.activo, ${resumenSql(1, 2)}
         FROM metodos_pago mp
         LEFT JOIN tarjeta_movimientos m ON m.metodo_pago_id = mp.id AND m.deleted_at IS NULL
        WHERE mp.es_tarjeta = true AND mp.deleted_at IS NULL
        GROUP BY mp.id
        ORDER BY mp.nombre`,
      [desde, hasta]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Saldos agregados por moneda — consumido por 360 & Capital para sumar al
// patrimonio total los netos pendientes de liquidación. Una sola query, sin
// paginar. Agrupa USD y USDT en el mismo "grupoMoneda" porque conceptualmente
// son equivalentes 1:1.
router.get('/saldos-resumen', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN mp.moneda = 'ARS' THEN
           CASE WHEN m.tipo='cobro' THEN m.monto_neto ELSE -m.monto_neto END
         ELSE 0 END), 0) AS saldo_ars,
         COALESCE(SUM(CASE WHEN mp.moneda IN ('USD','USDT') THEN
           CASE WHEN m.tipo='cobro' THEN m.monto_neto ELSE -m.monto_neto END
         ELSE 0 END), 0) AS saldo_usd
       FROM tarjeta_movimientos m
       JOIN metodos_pago mp ON mp.id = m.metodo_pago_id
       -- mp.es_tarjeta=true es defense-in-depth: hoy no debería haber
       -- tarjeta_movimientos con métodos no-tarjeta, pero si alguien futuro
       -- introduce un bug que inserta uno (ej. seed mal escrito), Capital
       -- mentiría sumando "saldos" de cuentas que no son tarjetas.
       WHERE m.deleted_at IS NULL AND mp.deleted_at IS NULL AND mp.es_tarjeta = true`
    );
    // Devolvemos números (no strings de pg) — el front suma directo sin Number().
    res.json({
      saldo_ars: Number(rows[0].saldo_ars || 0),
      saldo_usd: Number(rows[0].saldo_usd || 0),
    });
  } catch (err) { next(err); }
});

// Estado de cuenta unificado (paginado): movimientos de todas las tarjetas con su
// saldo acumulado calculado en el server (window) para que sea correcto aun paginando.
router.get('/movimientos', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });
    // Filtro opcional por rango de fechas. Importante: el saldo_acum SIEMPRE
    // se calcula sobre TODOS los movimientos del histórico (no filtrado) —
    // si filtráramos en la CTE base, el saldo acumulado mentiría al mostrar
    // un rango parcial. Filtramos solo en el outer SELECT (y en el count
    // para que coincida con lo visible).
    const { desde, hasta } = req.query;
    const params = [];
    const outerFiltros = [];
    if (desde) { params.push(desde); outerFiltros.push(`b.fecha >= $${params.length}`); }
    if (hasta) { params.push(hasta); outerFiltros.push(`b.fecha <= $${params.length}`); }
    const whereExtra = outerFiltros.length ? ' WHERE ' + outerFiltros.join(' AND ') : '';
    const countParams = [];
    let countWhere = ' WHERE deleted_at IS NULL';
    if (desde) { countParams.push(desde); countWhere += ` AND fecha >= $${countParams.length}`; }
    if (hasta) { countParams.push(hasta); countWhere += ` AND fecha <= $${countParams.length}`; }
    const [countRes, dataRes] = await Promise.all([
      db.query('SELECT COUNT(*) FROM tarjeta_movimientos' + countWhere, countParams),
      db.query(
        `WITH base AS (
           SELECT m.id, m.metodo_pago_id, m.fecha, m.tipo, m.moneda, m.monto_bruto, m.pct,
                  m.monto_comision, m.monto_neto, m.caja_id, m.venta_id,
                  SUM(CASE WHEN m.tipo='cobro' THEN m.monto_neto ELSE -m.monto_neto END)
                      OVER (ORDER BY m.fecha, m.id) AS saldo_acum
             FROM tarjeta_movimientos m
            WHERE m.deleted_at IS NULL
         )
         SELECT b.*, mp.nombre AS metodo_nombre, mc.nombre AS caja_nombre, v.order_id AS venta_order_id
           FROM base b
           JOIN metodos_pago mp ON mp.id = b.metodo_pago_id
           LEFT JOIN metodos_pago mc ON mc.id = b.caja_id
           LEFT JOIN ventas v ON v.id = b.venta_id
          ${whereExtra}
          ORDER BY b.fecha DESC, b.id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const desde = req.query.desde || null;
    const hasta = req.query.hasta || null;
    const { rows: mp } = await db.query(
      'SELECT id, nombre, moneda, comision_pct, activo FROM metodos_pago WHERE id = $1 AND es_tarjeta = true AND deleted_at IS NULL', [id]
    );
    if (!mp[0]) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    // $1 = id (filtro fijo). $2/$3 son las fechas del rango opcional, que
    // el resumenSql usa para Comisión/Cobrado/Movimientos. Saldo sigue sin
    // filtrar (es estado actual, no agregado de período).
    const { rows: tot } = await db.query(
      `SELECT ${resumenSql(2, 3)} FROM tarjeta_movimientos m WHERE m.metodo_pago_id = $1 AND m.deleted_at IS NULL`,
      [id, desde, hasta]
    );
    res.json({ ...mp[0], resumen: tot[0] });
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
    const [countRes, dataRes] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FROM tarjeta_movimientos m
          WHERE m.metodo_pago_id = $1 AND m.deleted_at IS NULL${whereFecha}`,
        params
      ),
      db.query(
        `SELECT m.*, mp.nombre AS caja_nombre, v.order_id AS venta_order_id
           FROM tarjeta_movimientos m
           LEFT JOIN metodos_pago mp ON mp.id = m.caja_id
           LEFT JOIN ventas v ON v.id = m.venta_id
          WHERE m.metodo_pago_id = $1 AND m.deleted_at IS NULL${whereFecha}
          ORDER BY m.fecha DESC, m.id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
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
router.post('/cobros-iniciales', validate(createCobroInicialSchema), async (req, res, next) => {
  // Audit-in-tx (patrón H6): si el INSERT se commitea pero el audit falla, el
  // movimiento quedaba sin traza. Envolvemos ambos en la misma tx con savepoint
  // (audit.js lo maneja cuando recibe el client). Mismo patrón que el resto
  // del archivo (liquidación, PATCH, DELETE) — esta era una regresión.
  const client = await db.connect();
  try {
    const { metodo_pago_id, fecha, monto_bruto, pct, comentarios } = req.body;
    await client.query('BEGIN');
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
    await audit(client, 'tarjeta_movimientos', 'INSERT', rows[0].id, {
      despues: rows[0], tipo: 'cobro_inicial', user_id: req.user.id,
    });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// Liquidación: nos depositan el neto → ingreso a una caja real (origen 'tarjeta').
router.post('/liquidaciones', validate(createLiquidacionSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { metodo_pago_id, fecha, monto, caja_id, comentarios } = req.body;
    await client.query('BEGIN');
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
      `INSERT INTO tarjeta_movimientos (metodo_pago_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, caja_id, comentarios, user_id)
       VALUES ($1,$2,'liquidacion',$3,$4,0,0,$4,$5,$6,$7) RETURNING *`,
      [metodo_pago_id, fecha, moneda, m, caja_id, comentarios ?? null, req.user.id]
    );
    await postCajaMovimiento(client, {
      caja_id, fecha, tipo: 'ingreso', monto: m, moneda, tc: null,
      origen: 'tarjeta', ref_tabla: 'tarjeta_movimientos', ref_id: rows[0].id,
      concepto: 'Liquidación tarjeta', user_id: req.user.id,
    });
    await audit(client, 'tarjeta_movimientos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
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
// Body: { fecha, caja_id, repartos: [{ metodo_pago_id, monto }], comentarios? }
router.post('/liquidaciones-multiples', validate(createLiquidacionMultipleSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { fecha, caja_id, comentarios, repartos } = req.body;
    await client.query('BEGIN');

    // 1. Validar caja destino.
    const caja = await client.query(
      'SELECT moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL', [caja_id]
    );
    if (!caja.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La caja seleccionada no existe.' });
    }
    const monedaCaja = caja.rows[0].moneda;

    // 2. Cargar todas las tarjetas en una sola query y validar que (a) existen,
    //    (b) son tarjetas activas, (c) todas tienen moneda compatible con la caja.
    //    El "compatible" usa grupoMoneda (USD/USDT son intercambiables, ARS es su
    //    propio grupo) — mismo criterio que la liquidación simple.
    const ids = repartos.map(r => r.metodo_pago_id);
    const mps = await client.query(
      'SELECT id, moneda, nombre FROM metodos_pago WHERE id = ANY($1) AND es_tarjeta = true AND deleted_at IS NULL',
      [ids]
    );
    if (mps.rows.length !== ids.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Alguna tarjeta no existe o no está activa.' });
    }
    const incompat = mps.rows.find(mp => grupoMoneda(mp.moneda) !== grupoMoneda(monedaCaja));
    if (incompat) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `La caja (${monedaCaja}) no coincide con la moneda de "${incompat.nombre}" (${incompat.moneda}).` });
    }

    // 3. Crear N filas + N ingresos a la caja + N audit logs.
    //    Reusamos exactamente el patrón de POST /liquidaciones (1 mov por reparto).
    //    Cada concepto en la caja queda etiquetado con el nombre de la tarjeta
    //    para que la conciliación bancaria muestre el desglose claro.
    const created = [];
    for (const reparto of repartos) {
      const mp = mps.rows.find(m => m.id === reparto.metodo_pago_id);
      const m = round2(Number(reparto.monto));
      const { rows } = await client.query(
        `INSERT INTO tarjeta_movimientos (metodo_pago_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, caja_id, comentarios, user_id)
         VALUES ($1,$2,'liquidacion',$3,$4,0,0,$4,$5,$6,$7) RETURNING *`,
        [reparto.metodo_pago_id, fecha, mp.moneda, m, caja_id, comentarios ?? null, req.user.id]
      );
      await postCajaMovimiento(client, {
        caja_id, fecha, tipo: 'ingreso', monto: m, moneda: mp.moneda, tc: null,
        origen: 'tarjeta', ref_tabla: 'tarjeta_movimientos', ref_id: rows[0].id,
        concepto: `Liquidación ${mp.nombre}`, user_id: req.user.id,
      });
      // Audit con marker `batch: 'liquidacion_multiple'` para distinguir estos
      // movs en el audit log de las liquidaciones individuales — útil si en el
      // futuro hay que undo masivo o auditar el conjunto. audit() mergea las
      // props extra (cualquier key fuera de antes/despues/user_id) en `despues`.
      await audit(client, 'tarjeta_movimientos', 'INSERT', rows[0].id, {
        despues: rows[0],
        batch: 'liquidacion_multiple',
        total_repartos: repartos.length,
        user_id: req.user.id,
      });
      created.push(rows[0]);
    }

    await client.query('COMMIT');
    const total = created.reduce((a, r) => a + Number(r.monto_neto), 0);
    res.status(201).json({ movimientos: created, total });
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
router.patch('/movimientos/:id', validate(updateMovimientoSchema), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
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
    } else if (mov.tipo === 'liquidacion') {
      // Liquidación: si cambia fecha/monto/caja_id, hay que actualizar el ledger
      // de cajas. Estrategia: revert (soft-delete del caja_movimiento existente
      // con validación de saldo) + repost (con la nueva caja_id/monto/fecha).
      // Es la misma mecánica que usa el DELETE de venta cuando hay cobros.
      const fecha   = body.fecha   ?? mov.fecha;
      const monto   = round2(Number(body.monto ?? mov.monto_neto));
      const caja_id = body.caja_id != null ? Number(body.caja_id) : Number(mov.caja_id);
      if (!(monto > 0)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El monto debe ser mayor a 0.' }); }
      const caja = await client.query('SELECT moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL', [caja_id]);
      if (!caja.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'La caja seleccionada no existe.' }); }
      const moneda = caja.rows[0].moneda;
      if (grupoMoneda(moneda) !== grupoMoneda(mov.metodo_moneda)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `La caja (${moneda}) no coincide con la moneda de la tarjeta (${mov.metodo_moneda}).` });
      }
      const comentarios = body.comentarios === undefined ? mov.comentarios : (body.comentarios ?? null);

      // 1) Soft-delete del caja_movimiento previo (revierte la caja vieja).
      // Si esto dejara la caja en negativo, throwea 409 → propagamos al cliente.
      await reverseCajaMovimientos(client, 'tarjeta_movimientos', id);

      // 2) Update del movimiento de tarjeta con los nuevos valores.
      const { rows } = await client.query(
        `UPDATE tarjeta_movimientos
            SET fecha = $2, monto_bruto = $3, monto_neto = $3, caja_id = $4, moneda = $5, comentarios = $6
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING *`,
        [id, fecha, monto, caja_id, moneda, comentarios]
      );
      updated = rows[0];

      // 3) Postear el nuevo caja_movimiento con los nuevos valores.
      await postCajaMovimiento(client, {
        caja_id, fecha, tipo: 'ingreso', monto, moneda, tc: null,
        origen: 'tarjeta', ref_tabla: 'tarjeta_movimientos', ref_id: id,
        concepto: 'Liquidación tarjeta', user_id: req.user.id,
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
    if (err.status === 409) return res.status(409).json({ error: err.message });
    next(err);
  } finally { client.release(); }
});

router.delete('/movimientos/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
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
