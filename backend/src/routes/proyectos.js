// Módulo Proyectos — agrupa proyectos y trackea desarrollo + inversiones.
// Montado en /api/proyectos con requireAuth + requirePermission('proyectos') (app.js).
const router  = require('express').Router();
const db      = require('../config/database');
const validate = require('../lib/validate');
const audit    = require('../lib/audit');
const parseId  = require('../lib/parseId');
const { toUsd, round2 } = require('../lib/money');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const { createProyectoSchema, updateProyectoSchema, createMovimientoProyectoSchema } = require('../schemas/proyectos');

// Calcula el monto en USD de un movimiento: si hay $ + tc → $/tc; si no, el USD directo.
function calcUsd({ monto, tc, monto_usd }) {
  if (Number(monto) > 0 && Number(tc) > 0) return round2(toUsd(Number(monto), 'ARS', Number(tc)));
  if (Number(monto_usd) > 0) return round2(Number(monto_usd));
  return 0;
}

// Inserta participantes en un solo INSERT multi-fila (evita N+1).
async function insertParticipantes(client, proyectoId, participantes) {
  const ids = [...new Set((participantes || []).map(Number).filter(Boolean))];
  if (ids.length === 0) return;
  const values = ids.map((_, i) => `($1, $${i + 2})`).join(', ');
  await client.query(
    `INSERT INTO proyecto_participantes (proyecto_id, contacto_id) VALUES ${values} ON CONFLICT DO NOTHING`,
    [proyectoId, ...ids]
  );
}

// ─── PROYECTOS ──────────────────────────────────────────────────────────────

// Lista de proyectos con totales invertidos ($ y USD) y cantidad de movimientos.
router.get('/', async (req, res, next) => {
  try {
    const { buscar } = req.query;
    const params = [];
    const filters = ['p.deleted_at IS NULL'];
    if (buscar) { params.push(`%${buscar}%`); filters.push(`(p.nombre ILIKE $${params.length} OR p.objetivo ILIKE $${params.length})`); }
    const { rows } = await db.query(
      `SELECT p.*,
              COALESCE(m.total_ars, 0) AS total_ars,
              COALESCE(m.total_usd, 0) AS total_usd,
              COALESCE(m.cant, 0)      AS cant_movimientos
       FROM proyectos p
       LEFT JOIN (
         SELECT proyecto_id, SUM(monto) AS total_ars, SUM(monto_usd) AS total_usd, COUNT(*) AS cant,
                MIN(fecha) AS desde, MAX(fecha) AS hasta
         FROM proyecto_movimientos WHERE deleted_at IS NULL GROUP BY proyecto_id
       ) m ON m.proyecto_id = p.id
       WHERE ${filters.join(' AND ')}
       ORDER BY p.fecha_creacion DESC, p.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Detalle: proyecto + participantes (con nombre) + totales + rango de fechas de movimientos.
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows: p } = await db.query('SELECT * FROM proyectos WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!p[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });

    const [{ rows: parts }, { rows: tot }] = await Promise.all([
      db.query(
        `SELECT c.id, c.nombre, c.apellido FROM proyecto_participantes pp
           JOIN contactos c ON c.id = pp.contacto_id
          WHERE pp.proyecto_id = $1 ORDER BY c.nombre, c.apellido`, [id]
      ),
      db.query(
        `SELECT COALESCE(SUM(monto), 0) AS total_ars, COALESCE(SUM(monto_usd), 0) AS total_usd,
                COUNT(*) AS cant_movimientos, MIN(fecha) AS desde, MAX(fecha) AS hasta
           FROM proyecto_movimientos WHERE proyecto_id = $1 AND deleted_at IS NULL`, [id]
      ),
    ]);
    res.json({ ...p[0], participantes: parts, resumen: tot[0] });
  } catch (err) { next(err); }
});

router.post('/', validate(createProyectoSchema), async (req, res, next) => {
  const { nombre, objetivo, fecha_creacion, participantes = [] } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO proyectos (nombre, objetivo, fecha_creacion)
       VALUES ($1, $2, COALESCE($3, CURRENT_DATE)) RETURNING *`,
      [nombre, objetivo ?? null, fecha_creacion ?? null]
    );
    const proyecto = rows[0];
    await insertParticipantes(client, proyecto.id, participantes);
    await client.query('COMMIT');
    await audit('proyectos', 'INSERT', proyecto.id, { despues: proyecto, user_id: req.user.id });
    res.status(201).json({ ...proyecto, total_ars: 0, total_usd: 0, cant_movimientos: 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.put('/:id', validate(updateProyectoSchema), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const { nombre, objetivo, fecha_creacion, participantes } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE proyectos SET
         nombre = COALESCE($1, nombre), objetivo = COALESCE($2, objetivo),
         fecha_creacion = COALESCE($3, fecha_creacion)
       WHERE id = $4 AND deleted_at IS NULL RETURNING *`,
      [nombre ?? null, objetivo ?? null, fecha_creacion ?? null, id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Proyecto no encontrado' }); }
    if (participantes !== undefined) {
      await client.query('DELETE FROM proyecto_participantes WHERE proyecto_id = $1', [id]);
      await insertParticipantes(client, id, participantes);
    }
    await client.query('COMMIT');
    await audit('proyectos', 'UPDATE', id, { despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE proyectos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });
    await audit('proyectos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── MOVIMIENTOS (hoja del proyecto) ─────────────────────────────────────────

router.get('/:id/movimientos', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });
    const [countRes, dataRes] = await Promise.all([
      db.query('SELECT COUNT(*) FROM proyecto_movimientos WHERE proyecto_id = $1 AND deleted_at IS NULL', [id]),
      db.query(
        `SELECT m.*,
                (c.nombre || COALESCE(' ' || c.apellido, '')) AS inversor_nombre,
                mp.nombre AS caja_nombre,
                mp.moneda AS caja_moneda
           FROM proyecto_movimientos m
           LEFT JOIN contactos c       ON c.id  = m.inversor_contacto_id
           LEFT JOIN metodos_pago mp   ON mp.id = m.caja_id
          WHERE m.proyecto_id = $1 AND m.deleted_at IS NULL
          ORDER BY m.fecha DESC, m.id DESC
          LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      ),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) { next(err); }
});

router.post('/movimientos', validate(createMovimientoProyectoSchema), async (req, res, next) => {
  const { proyecto_id, fecha, detalle, categoria, monto, tc, monto_usd,
          inversor_contacto_id, comentarios, caja_id, tipo } = req.body;
  // Validación previa fuera de TX: proyecto existe.
  const { rows: p } = await db.query('SELECT id FROM proyectos WHERE id = $1 AND deleted_at IS NULL', [proyecto_id]);
  if (!p[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });
  const usd = calcUsd({ monto, tc, monto_usd });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Si vino caja_id, leer la moneda de la caja para validar coherencia y
    // decidir qué monto postear al ledger. La moneda del ledger se debe
    // matchear con la moneda de la caja (cajaLedger.js valida por grupo
    // ARS vs USD/USDT; si no coincide tira 400).
    let cajaMoneda = null;
    if (caja_id) {
      const { rows: cj } = await client.query(
        'SELECT id, moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL',
        [caja_id]
      );
      if (!cj[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'La caja seleccionada no existe.' });
      }
      cajaMoneda = cj[0].moneda;
    }

    // INSERT del movimiento (incluyendo caja_id + tipo si vinieron).
    const { rows } = await client.query(
      `INSERT INTO proyecto_movimientos
         (proyecto_id, fecha, detalle, categoria, monto, tc, monto_usd,
          inversor_contacto_id, comentarios, caja_id, tipo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [proyecto_id, fecha, detalle ?? null, categoria ?? null,
       Number(monto) || 0, tc ?? null, usd,
       inversor_contacto_id ?? null, comentarios ?? null,
       caja_id ?? null, tipo ?? null]
    );

    // Si vino caja_id, postear al ledger. La elección del monto/moneda
    // depende de la moneda de la caja:
    //   - Caja ARS: usar `monto` (ARS). Si no hay monto ARS, no se postea.
    //   - Caja USD/USDT: usar `monto_usd` (preferido si vino); si vino monto
    //     en ARS + tc, postear el monto_usd calculado (`usd`).
    if (caja_id) {
      let montoLedger, monedaLedger, tcLedger;
      if (cajaMoneda === 'ARS') {
        montoLedger = Number(monto) || 0;
        monedaLedger = 'ARS';
        tcLedger = tc ? Number(tc) : null;
      } else { // USD o USDT
        // monto_usd directo si vino; si no, el calculado a partir de monto+tc.
        montoLedger = Number(monto_usd) > 0 ? Number(monto_usd) : usd;
        monedaLedger = cajaMoneda; // USD o USDT, da igual al grupo
        tcLedger = null;
      }
      if (montoLedger > 0) {
        await postCajaMovimiento(client, {
          caja_id,
          fecha,
          tipo, // ingreso | egreso
          monto: montoLedger,
          moneda: monedaLedger,
          tc: tcLedger,
          origen: 'proyecto',
          ref_tabla: 'proyecto_movimientos',
          ref_id: rows[0].id,
          concepto: detalle || categoria || `Proyecto #${proyecto_id}`,
          user_id: req.user.id,
        });
      }
    }

    await audit(client, 'proyecto_movimientos', 'INSERT', rows[0].id,
                { despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    // err400 de cajaLedger (saldo insuficiente, moneda no coincide) viene con
    // status. Pasarlo al front directo.
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
    const { rows: before } = await client.query(
      'SELECT * FROM proyecto_movimientos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]
    );
    if (!before[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }

    // Revertir el ledger ANTES del soft-delete del movimiento. Si dejaría la
    // caja en negativo, reverseCajaMovimientos tira 409 y abortamos la TX.
    await reverseCajaMovimientos(client, 'proyecto_movimientos', id);

    await client.query('UPDATE proyecto_movimientos SET deleted_at = NOW() WHERE id = $1', [id]);
    await audit(client, 'proyecto_movimientos', 'DELETE', id,
                { antes: before[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { client.release(); }
});

module.exports = router;
