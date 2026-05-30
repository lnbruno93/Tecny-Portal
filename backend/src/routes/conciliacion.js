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
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { createConciliacionSchema, updateLineaSchema } = require('../schemas/conciliacion');

// ──────────────────────────────────────────────────────────────────────
// Auto-match: para cada línea del extracto, busca el primer movimiento
// de caja sin conciliar con monto idéntico (con signo) y fecha dentro
// de tolerancia. Marca matched_caja_mov_id en la línea. Cada movimiento
// solo se usa una vez (set de "ya usados" en memoria por sesión).
// ──────────────────────────────────────────────────────────────────────
async function autoMatchLineas(client, conciliacionId, cajaId, lineas, toleranciaDias) {
  // Movimientos disponibles de la caja: en el rango ampliado por tolerancia
  // y sin conciliar previamente.
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

  // Para cada movimiento del ledger, su "monto con signo": ingreso=+, egreso=-.
  const movsConSigno = movs.map(m => ({
    id:    m.id,
    fecha: m.fecha,
    montoSigned: m.tipo === 'ingreso' ? Number(m.monto) : -Number(m.monto),
  }));

  // Map para tracking de matches ya hechos (cada mov se usa max 1 vez).
  const usados = new Set();
  const matches = []; // { lineaIdx, movId }

  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    const montoLinea = Number(l.monto);
    // Buscar el primer mov del ledger que: 1) no esté usado, 2) tenga monto
    // exacto con signo, 3) fecha dentro de tolerancia.
    const candidato = movsConSigno.find(m => {
      if (usados.has(m.id)) return false;
      if (Math.abs(m.montoSigned - montoLinea) > 0.001) return false;
      const diffDias = Math.abs((new Date(m.fecha) - new Date(l.fecha)) / 86400000);
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
router.post('/', validate(createConciliacionSchema), async (req, res, next) => {
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

    // Insertar líneas en batch (UNNEST).
    const fechasArr = lineas.map(l => l.fecha);
    const montosArr = lineas.map(l => Number(l.monto));
    const descsArr  = lineas.map(l => l.descripcion ?? null);
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
    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM conciliaciones c WHERE ${where}`, params),
      db.query(
        `SELECT c.*, mp.nombre AS caja_nombre, mp.moneda AS caja_moneda,
                COUNT(cl.id)::int AS lineas_total,
                COUNT(cl.id) FILTER (WHERE cl.matched_caja_mov_id IS NOT NULL)::int AS lineas_matched,
                COUNT(cl.id) FILTER (WHERE cl.ignorada)::int AS lineas_ignoradas
           FROM conciliaciones c
           JOIN metodos_pago mp ON mp.id = c.caja_id
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

    const { rows: c } = await db.query(
      `SELECT c.*, mp.nombre AS caja_nombre, mp.moneda AS caja_moneda
         FROM conciliaciones c
         JOIN metodos_pago mp ON mp.id = c.caja_id
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

    // La línea debe pertenecer a esta conciliación.
    const { rows: l } = await client.query(
      'SELECT id FROM conciliacion_lineas WHERE id = $1 AND conciliacion_id = $2',
      [lineaId, concId]
    );
    if (!l[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Línea no encontrada' }); }

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

    // Marcar conciliado_en + conciliacion_id en cada caja_mov matched
    // (que no estuviese ya conciliado por otra sesión).
    const { rowCount: cerrados } = await client.query(
      `UPDATE caja_movimientos
          SET conciliado_en = NOW(), conciliacion_id = $1
        WHERE id IN (
          SELECT matched_caja_mov_id FROM conciliacion_lineas
           WHERE conciliacion_id = $1 AND matched_caja_mov_id IS NOT NULL
        )
        AND conciliado_en IS NULL`,
      [id]
    );

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
