// Módulo Conciliación bancaria.
// Permite importar el extracto del banco (parseado en el frontend),
// matchear cada línea con movimientos del ledger de una caja, e
// idealmente cerrar la conciliación para "congelar" esos movimientos.
//
// Flow típico:
//   1. POST /api/conciliacion: el frontend envía las líneas del extracto + caja + período.
//      Backend: crea la conciliación, inserta líneas, intenta auto-match
//      (fecha ± tolerancia, monto exacto, no conciliado previamente).
//   2. GET  /api/conciliacion/:id: detalle con líneas + movimientos disponibles del período.
//   3. PUT  /api/conciliacion/:id/lineas/:lineaId: match manual, unmatch, ignorar, anotar.
//   4. POST /api/conciliacion/:id/cerrar: marca conciliado_en + conciliacion_id en cada
//      caja_mov matched. Después de esto, esos movimientos NO aparecen en futuras
//      conciliaciones.
//   5. DELETE /api/conciliacion/:id: soft-delete; libera los movimientos conciliados
//      (conciliado_en → NULL).

const router = require('express').Router();
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { createConciliacionSchema, updateLineaSchema } = require('../schemas/conciliacion');

// Rate-limit POST /conciliacion (creación + auto-match). La query escanea
// caja_movimientos en el período + tolerancia y hace una pasada O(L*M) para
// auto-match. Un cliente podría disparar muchas creaciones simultáneas y
// saturar la DB. 10 por 15 min por usuario es suficiente para flujo humano.
const conciliacionPostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // ipKeyGenerator: helper oficial para fallback IP-safe a IPv6. Sin él,
  // express-rate-limit warnea ERR_ERL_KEY_GEN_IPV6 (bypass IPv6 posible).
  keyGenerator: (req) => req.user?.id != null
    ? `conciliacion:create:${req.user.id}`
    : `conciliacion:create:ip:${ipKeyGenerator(req)}`,
  message: { error: 'Demasiadas conciliaciones creadas. Esperá unos minutos.' },
  // En tests skipeamos para no entorpecer el flujo de error-paths.
  skip: () => process.env.NODE_ENV === 'test',
});

// ──────────────────────────────────────────────────────────────────────
// Auto-match — pairing líneas del extracto con caja_movimientos.
//
// Reglas: monto exacto con signo (ingreso = +, egreso = -), fecha dentro
// de tolerancia ±N días, cada mov se usa max 1 vez.
//
// Complejidad: O(M + L * K) donde:
//   M = movimientos del rango
//   L = líneas del extracto
//   K = movs por bucket de monto (típicamente 1-3)
//
// Antes era O(L * M) por hacer Array.find en lineas.length iteraciones.
// Con N=1000 líneas y M=1000 movs → 10⁶ comparaciones. El nuevo plan
// indexa los movs por monto-con-signo (clave entera × 100 para evitar
// problemas de coma flotante) → lookup O(K).
//
// La tolerancia de fecha se chequea dentro del bucket (no se puede usar
// el monto como key sin perder precisión: redondeamos a centavos × 100).
// ──────────────────────────────────────────────────────────────────────
async function autoMatchLineas(client, conciliacionId, cajaId, lineas, toleranciaDias) {
  const fechaMin = lineas.reduce((min, l) => l.fecha < min ? l.fecha : min, lineas[0].fecha);
  const fechaMax = lineas.reduce((max, l) => l.fecha > max ? l.fecha : max, lineas[0].fecha);

  const { rows: movs } = await client.query(
    `SELECT id, fecha, tipo, monto, conciliado_en
       FROM caja_movimientos
      WHERE caja_id = $1
        AND deleted_at IS NULL
        AND conciliado_en IS NULL
        AND fecha BETWEEN ($2::date - $4::int * INTERVAL '1 day')::date
                      AND ($3::date + $4::int * INTERVAL '1 day')::date
      ORDER BY fecha, id`,
    [cajaId, fechaMin, fechaMax, toleranciaDias]
  );

  // Index: monto-con-signo (en centavos × 100, redondeado) → array de movs
  // disponibles con ese monto. Mantenemos el orden por fecha (vino del ORDER BY)
  // así el primer match es el cronológico — coherente con el comportamiento
  // anterior basado en Array.find.
  //
  // Por qué centavos × 100: comparar floats con tolerancia (0.001) en cada
  // línea es caro; preferimos Math.round(monto * 100) para clave entera exacta.
  const indexByMonto = new Map();
  for (const m of movs) {
    const signed = m.tipo === 'ingreso' ? Number(m.monto) : -Number(m.monto);
    const key = Math.round(signed * 100);
    if (!indexByMonto.has(key)) indexByMonto.set(key, []);
    indexByMonto.get(key).push({ id: m.id, fecha: m.fecha });
  }

  const usados = new Set();
  const matches = [];

  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    const keyLinea = Math.round(Number(l.monto) * 100);
    const candidatos = indexByMonto.get(keyLinea);
    if (!candidatos || candidatos.length === 0) continue;

    // Dentro del bucket: primer mov no usado con fecha dentro de tolerancia.
    // Iterar el bucket es O(K) donde K es típicamente 1-3 movs con el mismo monto.
    const fechaLinea = new Date(l.fecha).getTime();
    const candidato = candidatos.find(m => {
      if (usados.has(m.id)) return false;
      const diffDias = Math.abs((new Date(m.fecha).getTime() - fechaLinea) / 86400000);
      return diffDias <= toleranciaDias;
    });
    if (candidato) {
      usados.add(candidato.id);
      matches.push({ lineaIdx: i, movId: candidato.id });
    }
  }
  return matches;
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/conciliacion — crear + auto-match
// ──────────────────────────────────────────────────────────────────────
router.post('/', conciliacionPostLimiter, validate(createConciliacionSchema), async (req, res, next) => {
  const { caja_id, fecha_desde, fecha_hasta, archivo_nombre, archivo_hash,
          tolerancia_dias, lineas } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Validar caja existe.
    const { rows: c } = await client.query(
      'SELECT id, nombre, moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL',
      [caja_id]
    );
    if (!c[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La caja seleccionada no existe.' });
    }

    // Crear sesión de conciliación.
    const { rows: [conc] } = await client.query(
      `INSERT INTO conciliaciones (caja_id, fecha_desde, fecha_hasta, archivo_nombre, archivo_hash, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [caja_id, fecha_desde, fecha_hasta, archivo_nombre ?? null, archivo_hash ?? null, req.user.id]
    );

    // Insertar líneas en batch (UNNEST). Construimos los 3 arrays paralelos
    // y validamos que sean del mismo tamaño y que no tengan valores inválidos
    // antes de mandarlos a postgres: UNNEST tolera arrays de distinto tamaño
    // pero produce filas con NULLs implícitos, lo cual rompería NOT NULL del
    // schema y bloquearía toda la TX con un error confuso.
    const fechasArr = lineas.map(l => l.fecha);
    const montosArr = lineas.map(l => Number(l.monto));
    const descsArr  = lineas.map(l => l.descripcion ?? null);
    if (fechasArr.length !== montosArr.length || montosArr.length !== descsArr.length) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Internal: arrays paralelos desincronizados' });
    }
    // Re-validación defensiva: el schema ya lo hace (z.coerce.number con refine),
    // pero si llegara una línea con monto NaN/0, abortamos antes del INSERT.
    for (let i = 0; i < lineas.length; i++) {
      if (!Number.isFinite(montosArr[i]) || Math.abs(montosArr[i]) < 0.005) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Línea ${i + 1}: monto inválido` });
      }
      if (!fechasArr[i] || !/^\d{4}-\d{2}-\d{2}$/.test(fechasArr[i])) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Línea ${i + 1}: fecha inválida` });
      }
    }
    const { rows: lineasIns } = await client.query(
      `INSERT INTO conciliacion_lineas (conciliacion_id, fecha, monto, descripcion)
       SELECT $1, u.f, u.m, u.d
         FROM UNNEST($2::date[], $3::numeric[], $4::text[]) AS u(f, m, d)
       RETURNING id`,
      [conc.id, fechasArr, montosArr, descsArr]
    );

    // Auto-match (calculado contra el ledger).
    const matches = await autoMatchLineas(client, conc.id, caja_id, lineas, tolerancia_dias);
    for (const m of matches) {
      await client.query(
        'UPDATE conciliacion_lineas SET matched_caja_mov_id = $1 WHERE id = $2',
        [m.movId, lineasIns[m.lineaIdx].id]
      );
    }

    await audit(client, 'conciliaciones', 'INSERT', conc.id,
                { despues: conc, lineas: lineas.length, auto_matched: matches.length, user_id: req.user.id });
    await client.query('COMMIT');
    res.status(201).json({
      ...conc,
      lineas_total:      lineas.length,
      lineas_matched:    matches.length,
      lineas_pendientes: lineas.length - matches.length,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/conciliacion — lista paginada
// ──────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50 });
    const conditions = ['c.deleted_at IS NULL'];
    const params = [];
    if (req.query.caja_id) {
      params.push(Number(req.query.caja_id));
      conditions.push(`c.caja_id = $${params.length}`);
    }
    const where = conditions.join(' AND ');
    // LEFT JOIN a metodos_pago + COALESCE: si la caja fue soft-deleted después
    // de crear la conciliación, no queremos que la conciliación desaparezca
    // del listado (sería confuso para auditoría). Mostramos "(caja eliminada)"
    // en su lugar.
    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM conciliaciones c WHERE ${where}`, params),
      db.query(
        `SELECT c.*,
                COALESCE(mp.nombre, '(caja eliminada)') AS caja_nombre,
                mp.moneda AS caja_moneda,
                COUNT(cl.id)::int AS lineas_total,
                COUNT(cl.id) FILTER (WHERE cl.matched_caja_mov_id IS NOT NULL)::int AS lineas_matched,
                COUNT(cl.id) FILTER (WHERE cl.ignorada)::int AS lineas_ignoradas
           FROM conciliaciones c
           LEFT JOIN metodos_pago mp ON mp.id = c.caja_id AND mp.deleted_at IS NULL
           LEFT JOIN conciliacion_lineas cl ON cl.conciliacion_id = c.id
          WHERE ${where}
          GROUP BY c.id, mp.nombre, mp.moneda
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/conciliacion/:id — detalle con líneas + movs disponibles
// ──────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // LEFT JOIN: si la caja fue soft-deleted, queremos seguir mostrando la
    // conciliación (con "(caja eliminada)" en nombre). Antes era INNER JOIN
    // y un delete de la caja hacía desaparecer todas las conciliaciones
    // ligadas — pérdida de visibilidad de auditoría.
    const { rows: c } = await db.query(
      `SELECT c.*,
              COALESCE(mp.nombre, '(caja eliminada)') AS caja_nombre,
              mp.moneda AS caja_moneda
         FROM conciliaciones c
         LEFT JOIN metodos_pago mp ON mp.id = c.caja_id AND mp.deleted_at IS NULL
        WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id]
    );
    if (!c[0]) return res.status(404).json({ error: 'Conciliación no encontrada' });

    // Líneas con info del mov matched (si hay).
    const { rows: lineas } = await db.query(
      `SELECT cl.*,
              cm.fecha AS mov_fecha, cm.tipo AS mov_tipo, cm.monto AS mov_monto,
              cm.origen AS mov_origen, cm.concepto AS mov_concepto
         FROM conciliacion_lineas cl
         LEFT JOIN caja_movimientos cm ON cm.id = cl.matched_caja_mov_id
        WHERE cl.conciliacion_id = $1
        ORDER BY cl.fecha, cl.id`,
      [id]
    );

    // Movimientos de la caja en el período, NO conciliados todavía o
    // ya matcheados en esta conciliación. Tolerancia ± 7 días por ahora.
    const { rows: movs } = await db.query(
      `SELECT cm.id, cm.fecha, cm.tipo, cm.monto, cm.origen, cm.concepto,
              cm.conciliado_en, cm.conciliacion_id,
              (cm.tipo = 'ingreso')::int * 2 - 1 AS signo
         FROM caja_movimientos cm
        WHERE cm.caja_id = $1
          AND cm.deleted_at IS NULL
          AND cm.fecha BETWEEN ($2::date - INTERVAL '7 day')::date
                           AND ($3::date + INTERVAL '7 day')::date
          AND (cm.conciliado_en IS NULL OR cm.conciliacion_id = $4)
        ORDER BY cm.fecha, cm.id`,
      [c[0].caja_id, c[0].fecha_desde, c[0].fecha_hasta, id]
    );

    res.json({ ...c[0], lineas, movimientos_disponibles: movs });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────
// PUT /api/conciliacion/:id/lineas/:lineaId — match/unmatch/ignorar/nota
// ──────────────────────────────────────────────────────────────────────
router.put('/:id/lineas/:lineaId', validate(updateLineaSchema), async (req, res, next) => {
  const concId  = parseId(req.params.id);
  const lineaId = parseId(req.params.lineaId);
  if (!concId || !lineaId) return res.status(400).json({ error: 'ID inválido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // La conciliación debe existir y no estar cerrada/borrada.
    const { rows: c } = await client.query(
      'SELECT id, cerrado_en, caja_id FROM conciliaciones WHERE id = $1 AND deleted_at IS NULL',
      [concId]
    );
    if (!c[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Conciliación no encontrada' }); }
    if (c[0].cerrado_en) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'La conciliación ya está cerrada. No se puede editar.' });
    }

    // La línea debe pertenecer a esta conciliación. Leemos estado actual para
    // validar cross-request: el schema rechaza payloads `ignorada=true + match`
    // en la misma request, pero falta el caso "línea ya ignorada y ahora se
    // intenta matchear sin desmarcar ignorada" (o viceversa).
    const { rows: l } = await client.query(
      'SELECT id, ignorada, matched_caja_mov_id FROM conciliacion_lineas WHERE id = $1 AND conciliacion_id = $2',
      [lineaId, concId]
    );
    if (!l[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Línea no encontrada' }); }

    // Validar estado resultante: línea no puede quedar simultáneamente
    // `ignorada=true` AND `matched_caja_mov_id != null`. Si el request setea
    // uno pero no el otro, se mantiene el valor previo — controlamos ese cruce.
    const ignoradaFinal = req.body.ignorada !== undefined ? req.body.ignorada : l[0].ignorada;
    const matchFinal = req.body.matched_caja_mov_id !== undefined
      ? req.body.matched_caja_mov_id
      : l[0].matched_caja_mov_id;
    if (ignoradaFinal === true && matchFinal != null) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'No podés ignorar una línea matcheada. Primero desmatcheala (matched_caja_mov_id: null) o no la ignores.',
      });
    }

    // Si nos pasaron matched_caja_mov_id, validar que el mov pertenezca a la
    // caja correcta, no esté borrado, y no esté ya matched en otra línea de
    // esta misma conciliación (cada mov solo se matchea una vez).
    if (req.body.matched_caja_mov_id !== undefined && req.body.matched_caja_mov_id !== null) {
      const movId = req.body.matched_caja_mov_id;
      const { rows: m } = await client.query(
        `SELECT id FROM caja_movimientos
          WHERE id = $1 AND caja_id = $2 AND deleted_at IS NULL
            AND (conciliado_en IS NULL OR conciliacion_id = $3)`,
        [movId, c[0].caja_id, concId]
      );
      if (!m[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'El movimiento no existe, es de otra caja, o ya está conciliado.' });
      }
      const { rows: dup } = await client.query(
        `SELECT id FROM conciliacion_lineas
          WHERE conciliacion_id = $1 AND matched_caja_mov_id = $2 AND id <> $3`,
        [concId, movId, lineaId]
      );
      if (dup[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Ese movimiento ya está matcheado a otra línea de esta conciliación.' });
      }
    }

    // Aplicar updates. Construimos SET dinámico con los campos presentes.
    const sets = [];
    const params = [];
    if (req.body.matched_caja_mov_id !== undefined) {
      params.push(req.body.matched_caja_mov_id);
      sets.push(`matched_caja_mov_id = $${params.length}`);
    }
    if (req.body.ignorada !== undefined) {
      params.push(req.body.ignorada);
      sets.push(`ignorada = $${params.length}`);
    }
    if (req.body.nota !== undefined) {
      params.push(req.body.nota);
      sets.push(`nota = $${params.length}`);
    }
    params.push(lineaId);
    const { rows } = await client.query(
      `UPDATE conciliacion_lineas SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/conciliacion/:id/cerrar — confirma y "congela" matches
// ──────────────────────────────────────────────────────────────────────
router.post('/:id/cerrar', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: c } = await client.query(
      'SELECT id, cerrado_en FROM conciliaciones WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [id]
    );
    if (!c[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Conciliación no encontrada' }); }
    if (c[0].cerrado_en) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'La conciliación ya está cerrada.' });
    }

    // H5 auditoría 2026-06: validar que NO queden líneas pendientes (sin match
    // y sin ignorar) antes de cerrar. La invariante `conciliacion_cerrada_con_
    // lineas_pending` detecta esto 24h después como severity 'alta', pero el
    // código permitía dejar la conciliación en estado inválido. Mejor rechazar
    // ANTES del UPDATE en lugar de generar una alerta diferida.
    const { rows: pendientes } = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM conciliacion_lineas
        WHERE conciliacion_id = $1
          AND matched_caja_mov_id IS NULL
          AND ignorada = false`,
      [id]
    );
    if (pendientes[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `No se puede cerrar — quedan ${pendientes[0].n} línea(s) sin matchear y sin ignorar. ` +
               `Resolvelas primero (matcheá o marcá como ignorada).`,
        lineas_pendientes: pendientes[0].n,
      });
    }

    // Race condition fix: dos conciliaciones distintas podrían intentar cerrar
    // simultáneamente, ambas matcheando el mismo caja_movimiento. Sin lock,
    // ambas UPDATEs ven `conciliado_en IS NULL` y la última pisaría el match
    // de la primera (silenciosamente, porque WHERE conciliado_en IS NULL en
    // un UPDATE no es snapshot-isolated en READ COMMITTED).
    //
    // Fix: SELECT ... FOR UPDATE primero — adquiere row-locks. Si otra TX
    // tenía la fila, esperamos (o detectamos que ya quedó conciliada y la
    // excluimos del UPDATE).
    const { rows: movsLockeados } = await client.query(
      `SELECT cm.id FROM caja_movimientos cm
        WHERE cm.id IN (
          SELECT matched_caja_mov_id FROM conciliacion_lineas
           WHERE conciliacion_id = $1 AND matched_caja_mov_id IS NOT NULL
        )
        AND cm.conciliado_en IS NULL
        AND cm.deleted_at IS NULL
        FOR UPDATE`,
      [id]
    );
    const idsACerrar = movsLockeados.map(m => m.id);

    let cerrados = 0;
    if (idsACerrar.length > 0) {
      const r = await client.query(
        `UPDATE caja_movimientos
            SET conciliado_en = NOW(), conciliacion_id = $1
          WHERE id = ANY($2::int[])`,
        [id, idsACerrar]
      );
      cerrados = r.rowCount;
    }

    // Cerrar la conciliación.
    const { rows: cerrada } = await client.query(
      'UPDATE conciliaciones SET cerrado_en = NOW() WHERE id = $1 RETURNING *',
      [id]
    );

    await audit(client, 'conciliaciones', 'UPDATE', id,
                { despues: cerrada[0], movs_cerrados: cerrados, user_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ...cerrada[0], movimientos_cerrados: cerrados });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /api/conciliacion/:id — soft-delete + libera movimientos
// ──────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: c } = await client.query(
      'SELECT id FROM conciliaciones WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [id]
    );
    if (!c[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Conciliación no encontrada' }); }

    // Si estaba cerrada, liberar los movimientos que cerró.
    await client.query(
      `UPDATE caja_movimientos
          SET conciliado_en = NULL, conciliacion_id = NULL
        WHERE conciliacion_id = $1`,
      [id]
    );
    await client.query(
      'UPDATE conciliaciones SET deleted_at = NOW() WHERE id = $1',
      [id]
    );
    await audit(client, 'conciliaciones', 'DELETE', id,
                { antes: c[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

module.exports = router;
