// Módulo Sanidad del Negocio (feature 2026-06-23, decidido con Lucas).
//
// Dashboard de presupuesto vs ejecución mensual. Cruza:
//   · Bruto PROYECTADO (input manual del usuario, en `proyecciones_mensuales`).
//   · Bruto REAL       (suma de ventas no canceladas, columna `total_usd`).
//   · Gastos PROYECTADOS (plantillas activas en `egresos_recurrentes` con su
//                          monto pasado a USD).
//   · Gastos REALES     (suma de egresos pagados, agrupados por `recurrente_id`
//                          — los que no vienen de plantilla van a "Otros").
//
// Filosofía multi-moneda: todos los montos de output se devuelven en USD.
// Los registros del portal guardan su `monto_usd` denormalizado al momento
// de la operación (TC al instante), así que NO recalculamos acá — confiamos
// en el dato persistido. Para egresos_recurrentes (plantillas) calculamos
// el monto_usd al vuelo con el TC del recurrente si la moneda es ARS.
//
// Permisos: 'cajas' (mismo que Egresos — quien carga gastos ve sanidad).
// Multi-tenant: pattern estándar `db.withTenant(req.tenantId, ...)` — RLS
// filtra todo automáticamente.

const router   = require('express').Router();
const db       = require('../config/database');
const validate = require('../lib/validate');
const audit    = require('../lib/audit');
const { toUsd, round2 } = require('../lib/money');
const { queryListadoSchema, upsertProyeccionSchema, upsertOverrideSchema } = require('../schemas/sanidad');

// Devuelve la lista de los últimos N meses como strings 'YYYY-MM', ordenados
// del más viejo al más reciente (orientado al display en la pantalla). Calcula
// con UTC para evitar drift por timezone (el portal opera en ART pero el
// concepto de "mes calendario" es timezone-agnostic para este ejercicio).
function listarPeriodos(meses) {
  const periodos = [];
  const hoy = new Date();
  for (let i = meses - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - i, 1));
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    periodos.push(`${yyyy}-${mm}`);
  }
  return periodos;
}

// Días del mes calendario para un periodo 'YYYY-MM'. Usado para el promedio
// diario (bruto/dias y neto/dias). new Date(year, month, 0) devuelve el
// último día del mes anterior, que con month=mes_target da los días del mes.
function diasDelMes(periodo) {
  const [y, m] = periodo.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

// Rango de fechas ISO 'YYYY-MM-DD' para el periodo. Inclusive en ambos
// extremos (consistente con BETWEEN de Postgres usado en el resto del portal).
function rangoMes(periodo) {
  const [y, m] = periodo.split('-').map(Number);
  const ultimoDia = diasDelMes(periodo);
  return {
    desde: `${periodo}-01`,
    hasta: `${periodo}-${String(ultimoDia).padStart(2, '0')}`,
  };
}

// ─── GET /api/sanidad?meses=6 ────────────────────────────────────────────────
// Devuelve un array de meses (más viejo → más reciente), cada uno con su
// bruto proyectado/real (+ desglose retail/B2B), lista de gastos por recurrente
// (proyectado + real del mes), entrada "Otros" con egresos no-recurrentes,
// neto y promedios diarios.

router.get('/', validate(queryListadoSchema, 'query'), async (req, res, next) => {
  try {
    const { meses } = req.query;
    const periodos = listarPeriodos(meses);
    const desdeGlobal = `${periodos[0]}-01`;
    const hastaGlobal = `${periodos[periodos.length - 1]}-${String(diasDelMes(periodos[periodos.length - 1])).padStart(2, '0')}`;

    const data = await db.withTenant(req.tenantId, async (client) => {
      // 1. Proyecciones del bruto (las que estén cargadas; el resto va null).
      const proyeccionesQ = client.query(
        `SELECT periodo, bruto_proyectado_usd
           FROM proyecciones_mensuales
          WHERE periodo BETWEEN $1 AND $2`,
        [periodos[0], periodos[periodos.length - 1]]
      );

      // 2. Recurrentes activos del tenant (el "presupuesto de gastos"). Los
      // soft-deleted los excluimos — mostramos solo lo que hoy está vigente
      // como expectativa de gasto. Los meses anteriores donde aún estaba
      // activo se reflejan en sus egresos reales linkeados (con recurrente_id),
      // que sí salen aunque hoy el recurrente esté deleted_at — porque salen
      // de `egresos`, no de `egresos_recurrentes`.
      const recurrentesQ = client.query(
        `SELECT id, concepto, monto, moneda, tc, categoria_id
           FROM egresos_recurrentes
          WHERE activo = true AND deleted_at IS NULL
          ORDER BY id`
      );

      // 3. Ventas agregadas por mes — total + desglose retail/B2B. Definición
      // simple V1: B2B = ventas con cliente_cc_id (cuenta corriente) seteado;
      // resto es retail. Envíos no se segrega en V1 (queda dentro del bucket
      // según el cliente_cc_id de la venta asociada).
      // GROUP BY mes con to_char en YYYY-MM para joinear contra el array de
      // periodos. Filtramos canceladas (consistente con dashboardMensual).
      const ventasQ = client.query(
        `SELECT
           to_char(fecha, 'YYYY-MM')                                        AS periodo,
           COALESCE(SUM(total_usd) FILTER (
             WHERE estado <> 'cancelado'), 0)                               AS bruto_real_usd,
           COALESCE(SUM(total_usd) FILTER (
             WHERE estado <> 'cancelado' AND cliente_cc_id IS NULL), 0)     AS retail_usd,
           COALESCE(SUM(total_usd) FILTER (
             WHERE estado <> 'cancelado' AND cliente_cc_id IS NOT NULL), 0) AS b2b_usd
         FROM ventas
         WHERE fecha BETWEEN $1 AND $2 AND deleted_at IS NULL
         GROUP BY to_char(fecha, 'YYYY-MM')`,
        [desdeGlobal, hastaGlobal]
      );

      // 3.5. Overrides de presupuesto mensual por recurrente (2026-06-24).
      // Permiten variar el monto presupuestado de un recurrente sin
      // reescribir su `monto` default — caso típico: aumento de alquiler
      // o salario que aplica desde un mes específico. Sanidad resuelve
      // por mes: si hay override → usa ese; si no → cae al default del
      // recurrente.
      //
      // Buscamos solo overrides dentro del rango de periodos visible (no
      // todo el histórico). El índice idx_eror_tenant_periodo cubre.
      const overridesQ = client.query(
        `SELECT recurrente_id, periodo, monto, moneda, tc
           FROM egresos_recurrentes_overrides
          WHERE periodo BETWEEN $1 AND $2`,
        [periodos[0], periodos[periodos.length - 1]]
      );

      // 4. Egresos pagados del rango, agrupados por mes y por recurrente_id.
      // recurrente_id NULL = gasto extraordinario (no viene de plantilla).
      // El campo `periodo` del egreso puede usarse para los que vienen de
      // recurrente (con dia_del_mes que cae en mes X pero pagado en mes X+1).
      // V1: agrupamos por mes-DE-PAGO (fecha), no por periodo. La intuición
      // es "cuánto plata efectivamente salió este mes". Si después aparece
      // la necesidad de "mes que pertenece el gasto" (matching contable),
      // se cambia a periodo.
      const egresosQ = client.query(
        `SELECT
           to_char(fecha, 'YYYY-MM') AS periodo,
           recurrente_id,
           COALESCE(SUM(monto_usd), 0) AS real_usd
         FROM egresos
         WHERE fecha BETWEEN $1 AND $2
           AND estado = 'pagado'
           AND deleted_at IS NULL
         GROUP BY to_char(fecha, 'YYYY-MM'), recurrente_id`,
        [desdeGlobal, hastaGlobal]
      );

      const [
        { rows: proyeccionesRows },
        { rows: recurrentesRows },
        { rows: overridesRows },
        { rows: ventasRows },
        { rows: egresosRows },
      ] = await Promise.all([proyeccionesQ, recurrentesQ, overridesQ, ventasQ, egresosQ]);

      // Index por periodo para lookup O(1).
      const proyeccionesByPer = new Map(proyeccionesRows.map(r => [r.periodo, Number(r.bruto_proyectado_usd)]));
      const ventasByPer       = new Map(ventasRows.map(r => [r.periodo, r]));
      // egresos: agrupados por periodo → Map<recurrente_id|null, monto>
      const egresosByPer = new Map();
      for (const r of egresosRows) {
        if (!egresosByPer.has(r.periodo)) egresosByPer.set(r.periodo, new Map());
        // Key 'extras' para los recurrente_id NULL (no se puede usar null como Map key segura).
        const key = r.recurrente_id == null ? 'extras' : r.recurrente_id;
        egresosByPer.get(r.periodo).set(key, Number(r.real_usd));
      }

      // Recurrentes con metadata + monto DEFAULT en USD (fallback si no hay
      // override para el mes que estamos calculando).
      const recurrentesNorm = recurrentesRows.map(r => ({
        recurrente_id: r.id,
        concepto:      r.concepto,
        categoria_id:  r.categoria_id,
        default_usd:   round2(toUsd(Number(r.monto), r.moneda, r.tc)),
      }));

      // 2026-06-24: lookup de overrides indexado por periodo → Map<recurrente_id, usd>.
      // Pre-convertimos cada override a USD (toUsd respeta la moneda+tc del
      // override, no del recurrente padre — soporta el caso "alquiler
      // dolarizado que pasa a pesos un mes específico").
      const overridesByPer = new Map();
      for (const o of overridesRows) {
        if (!overridesByPer.has(o.periodo)) overridesByPer.set(o.periodo, new Map());
        overridesByPer.get(o.periodo).set(
          o.recurrente_id,
          round2(toUsd(Number(o.monto), o.moneda, o.tc)),
        );
      }

      // Armado del payload final: un objeto por mes con todo cruzado.
      return periodos.map(periodo => {
        const v = ventasByPer.get(periodo) || {};
        const egresosMes = egresosByPer.get(periodo) || new Map();

        const bruto_proyectado_usd = proyeccionesByPer.has(periodo)
          ? round2(proyeccionesByPer.get(periodo))
          : null;
        const bruto_real_usd = round2(Number(v.bruto_real_usd) || 0);

        // Gastos: una entrada por cada recurrente (proyectado + real si hay).
        // 2026-06-24: el proyectado por recurrente PARA ESTE MES se resuelve
        // así: override si hay → default del recurrente si no. El flag
        // `is_override` lo manda al frontend para mostrarlo visualmente.
        const overridesMes = overridesByPer.get(periodo) || new Map();
        const gastos = recurrentesNorm.map(rec => {
          const overrideUsd = overridesMes.get(rec.recurrente_id);
          const proyectado_usd = overrideUsd != null ? overrideUsd : rec.default_usd;
          return {
            recurrente_id:  rec.recurrente_id,
            concepto:       rec.concepto,
            categoria_id:   rec.categoria_id,
            proyectado_usd,
            is_override:    overrideUsd != null,
            default_usd:    rec.default_usd,
            real_usd:       egresosMes.has(rec.recurrente_id)
                              ? round2(egresosMes.get(rec.recurrente_id))
                              : null,
          };
        });

        // Línea "Otros" — egresos no asociados a un recurrente. Solo se
        // incluye si HAY extras en este mes (si no, no contamina la grilla).
        const extrasReal = egresosMes.get('extras');
        if (extrasReal != null && extrasReal > 0) {
          gastos.push({
            recurrente_id:  null,
            concepto:       'Otros (no recurrentes)',
            categoria_id:   null,
            proyectado_usd: null,
            real_usd:       round2(extrasReal),
          });
        }

        // Totales gastos.
        const sumGastosProyectados = gastos.reduce(
          (acc, g) => acc + (g.proyectado_usd || 0), 0);
        const sumGastosReales = gastos.reduce(
          (acc, g) => acc + (g.real_usd || 0), 0);

        // Netos: bruto - gastos. Si no hay proyección del bruto, neto
        // proyectado queda null (no inventamos un neto sin un bruto).
        const neto_proyectado_usd = bruto_proyectado_usd != null
          ? round2(bruto_proyectado_usd - sumGastosProyectados)
          : null;
        const neto_real_usd = round2(bruto_real_usd - sumGastosReales);

        const dias = diasDelMes(periodo);

        return {
          periodo,
          dias_mes: dias,
          bruto: {
            proyectado_usd:  bruto_proyectado_usd,
            real_usd:        bruto_real_usd,
            real_retail_usd: round2(Number(v.retail_usd) || 0),
            real_b2b_usd:    round2(Number(v.b2b_usd) || 0),
          },
          gastos,
          total_gastos: {
            proyectado_usd: round2(sumGastosProyectados),
            real_usd:       round2(sumGastosReales),
          },
          neto: {
            proyectado_usd: neto_proyectado_usd,
            real_usd:       neto_real_usd,
          },
          // Defensive audit 2026-07-06: `dias` siempre viene de
          // `diasDelMes(periodo)` que retorna 28-31 con periodo válido, pero
          // si el schema Zod dejara pasar un periodo malformed (o el JS
          // Date devuelve NaN por un edge exotic), evitamos propagar
          // `Infinity`/`NaN` al frontend — que ya no puede diferenciar
          // "no hay datos" (null) de "tenemos un bug".
          daily: {
            bruto_proyectado_usd: (bruto_proyectado_usd != null && dias > 0) ? round2(bruto_proyectado_usd / dias) : null,
            bruto_real_usd:       dias > 0 ? round2(bruto_real_usd / dias)   : null,
            neto_proyectado_usd:  (neto_proyectado_usd  != null && dias > 0) ? round2(neto_proyectado_usd  / dias) : null,
            neto_real_usd:        dias > 0 ? round2(neto_real_usd / dias)    : null,
          },
        };
      });
    });

    res.json({ meses: data });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/sanidad/proyeccion ─────────────────────────────────────────────
// Upsert del bruto proyectado de UN mes. Body: { periodo, bruto_proyectado_usd }.
// ON CONFLICT update — el usuario edita el valor cuantas veces quiera.

router.put('/proyeccion', validate(upsertProyeccionSchema), async (req, res, next) => {
  try {
    const { periodo, bruto_proyectado_usd } = req.body;
    const row = await db.withTenant(req.tenantId, async (client) => {
      // Truco PG: `xmax = 0` cuando la fila se acaba de INSERTAR, distinto
      // de 0 si fue UPDATE por ON CONFLICT. Permite distinguir INSERT vs
      // UPDATE para el audit log (el CHECK constraint de audit_logs no
      // acepta 'UPSERT', solo INSERT/UPDATE/DELETE).
      const { rows } = await client.query(
        `INSERT INTO proyecciones_mensuales (tenant_id, periodo, bruto_proyectado_usd)
         VALUES (current_setting('app.current_tenant')::int, $1, $2)
         ON CONFLICT (tenant_id, periodo) DO UPDATE
           SET bruto_proyectado_usd = EXCLUDED.bruto_proyectado_usd
         RETURNING periodo, bruto_proyectado_usd, updated_at, (xmax = 0) AS inserted`,
        [periodo, bruto_proyectado_usd]
      );
      const accion = rows[0].inserted ? 'INSERT' : 'UPDATE';
      await audit(client, 'proyecciones_mensuales', accion, null, {
        despues: { periodo: rows[0].periodo, bruto_proyectado_usd: rows[0].bruto_proyectado_usd },
        user_id: req.user.id,
      });
      return rows[0];
    });
    res.json({
      periodo: row.periodo,
      bruto_proyectado_usd: Number(row.bruto_proyectado_usd),
      updated_at: row.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/sanidad/proyeccion/:periodo ─────────────────────────────────
// Borrar la proyección de un mes (= "no tengo expectativa cargada para este mes").
// Idempotente: si no existe, devuelve 204 igual — el cliente no necesita saber.

router.delete('/proyeccion/:periodo', async (req, res, next) => {
  try {
    const periodo = req.params.periodo;
    if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(periodo)) {
      return res.status(400).json({ error: 'Periodo inválido (formato YYYY-MM)' });
    }
    await db.withTenant(req.tenantId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM proyecciones_mensuales WHERE periodo = $1`,
        [periodo]
      );
      if (rowCount > 0) {
        await audit(client, 'proyecciones_mensuales', 'DELETE', null, {
          antes: { periodo },
          user_id: req.user.id,
        });
      }
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/sanidad/override ───────────────────────────────────────────────
// Upsert del monto presupuestado de UN recurrente para UN mes específico.
// Body: { recurrente_id, periodo, monto, moneda?, tc? }.
//
// Caso de uso: el alquiler subió en marzo. El operador click en la celda del
// recurrente "Alquiler" en el mes marzo del grid → ingresa el nuevo monto →
// se guarda este override SOLO para marzo (los meses anteriores quedan
// usando el default del recurrente, que sigue siendo el viejo monto).
//
// `recurrente_id` se valida a nivel DB con FK (ON DELETE CASCADE) — un id
// que no pertenece al tenant o que apunta a un recurrente borrado tira 23503.
// El handler atrapa ese caso para devolver 400 con mensaje legible (en vez
// del 500 default del error handler).
router.put('/override', validate(upsertOverrideSchema), async (req, res, next) => {
  try {
    const { recurrente_id, periodo, monto, moneda, tc } = req.body;
    // tc solo aplica si moneda='ARS'; el schema lo deja pasar opcional, lo
    // normalizamos acá para no guardar tc=null con moneda=ARS (que dejaría
    // el override sin forma de calcular USD).
    if (moneda === 'ARS' && (tc == null || tc <= 0)) {
      return res.status(400).json({ error: 'Para moneda ARS, debe especificarse un tc > 0.' });
    }
    const tcFinal = moneda === 'ARS' ? tc : null;
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO egresos_recurrentes_overrides (tenant_id, recurrente_id, periodo, monto, moneda, tc)
         VALUES (current_setting('app.current_tenant')::int, $1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, recurrente_id, periodo) DO UPDATE
           SET monto = EXCLUDED.monto,
               moneda = EXCLUDED.moneda,
               tc = EXCLUDED.tc
         RETURNING recurrente_id, periodo, monto, moneda, tc, updated_at, (xmax = 0) AS inserted`,
        [recurrente_id, periodo, monto, moneda, tcFinal]
      );
      const accion = rows[0].inserted ? 'INSERT' : 'UPDATE';
      await audit(client, 'egresos_recurrentes_overrides', accion, null, {
        despues: {
          recurrente_id: rows[0].recurrente_id,
          periodo: rows[0].periodo,
          monto: rows[0].monto,
          moneda: rows[0].moneda,
          tc: rows[0].tc,
        },
        user_id: req.user.id,
      });
      return rows[0];
    });
    res.json({
      recurrente_id: row.recurrente_id,
      periodo: row.periodo,
      monto: Number(row.monto),
      moneda: row.moneda,
      tc: row.tc != null ? Number(row.tc) : null,
      updated_at: row.updated_at,
    });
  } catch (err) {
    // FK violation: recurrente_id no existe o no pertenece al tenant (RLS).
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Recurrente inválido o inexistente.' });
    }
    next(err);
  }
});

// ─── DELETE /api/sanidad/override/:recurrenteId/:periodo ─────────────────────
// Borra el override → ese mes vuelve a usar el monto default del recurrente.
// Idempotente: si no existe, 204 igual.
router.delete('/override/:recurrenteId/:periodo', async (req, res, next) => {
  try {
    const recurrenteId = Number(req.params.recurrenteId);
    const periodo = req.params.periodo;
    if (!Number.isInteger(recurrenteId) || recurrenteId <= 0) {
      return res.status(400).json({ error: 'recurrenteId inválido' });
    }
    if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(periodo)) {
      return res.status(400).json({ error: 'Periodo inválido (formato YYYY-MM)' });
    }
    await db.withTenant(req.tenantId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM egresos_recurrentes_overrides
          WHERE recurrente_id = $1 AND periodo = $2`,
        [recurrenteId, periodo]
      );
      if (rowCount > 0) {
        await audit(client, 'egresos_recurrentes_overrides', 'DELETE', null, {
          antes: { recurrente_id: recurrenteId, periodo },
          user_id: req.user.id,
        });
      }
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
