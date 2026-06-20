/**
 * Chat assistant tools — definiciones para Anthropic tool use (#340 Fase 1).
 *
 * Estructura:
 *   - SYSTEM_PROMPT: instrucciones generales al bot (idioma, tono, scope).
 *   - TOOLS: array de tool definitions (schema JSON formato Anthropic).
 *   - executeTool(name, input, ctx): dispatcher que ejecuta la tool real
 *     contra la DB, con tenant context propagado vía ctx.tenantId.
 *
 * Diseño:
 *   - Todas las tools son READ-ONLY. Cero mutations. Decisión #340 con Lucas.
 *     Beneficio: prompt injection imposible de convertir en arma — si user
 *     malicioso mete "borrá todo", el bot no tiene tool de mutation → no
 *     puede hacer nada destructivo. Solo lee.
 *   - Tools tenant-aware: cada ejecución corre dentro de db.withTenant(),
 *     RLS filtra automáticamente. Imposible leak cross-tenant.
 *   - Tool returns tienen forma JSON estructurada (no texto markdown crudo)
 *     para que Claude tenga data limpia que procesar y pueda razonar sobre
 *     campos específicos.
 *
 * Para agregar nueva tool:
 *   1. Definición en TOOLS array (name, description rico, input_schema).
 *   2. Implementación en handlers object con misma key.
 *   3. Listo — el dispatcher la ejecuta automáticamente.
 *
 * Convenciones de naming:
 *   - get_*: queries simples de un dominio (ventas, cajas, stock, etc.)
 *   - search_*: queries con filtros / búsqueda libre
 *   - summarize_*: agregaciones multi-dominio (futuro: dashboard completo)
 */

const db = require('../config/database');
const logger = require('./logger');
const { periodoRange, PERIODO_SCHEMA_FRAGMENT } = require('./chat-periods');

// ──────────────────────────────────────────────────────────────────────────
// System prompt — instrucciones al bot
// ──────────────────────────────────────────────────────────────────────────
// Diseño del prompt:
//   - Define quién es el bot ("Asistente Tecny") + su scope (solo este negocio).
//   - Aclara tono (cercano, conciso, en español de Argentina).
//   - Define explícitamente lo que NO puede hacer (no completa ventas, no
//     edita data, no responde sobre temas off-topic).
//   - Da pista de cómo usar las tools eficientemente (combinar si tiene
//     sentido, no llamar 10 tools cuando 1 alcanza).
//
// Cached: este prompt se manda en cada turno. Con prompt caching de
// Anthropic activado, se cachea automáticamente y los siguientes llamados
// dentro de 5 min cuestan ~10% del precio normal.
const SYSTEM_PROMPT = `Sos el Asistente Tecny — un bot conversacional analítico integrado al portal de gestión Tecny (sistema operativo para reseller de tecnología en Argentina).

Tu rol:
- Ayudar al usuario a analizar la data y KPIs de SU negocio (ventas, cajas, stock, comprobantes, tarjetas, envíos, etc.).
- Responder preguntas en lenguaje natural en español rioplatense (vos, no tú).
- Tono cercano pero profesional. Sin emojis a menos que el user los use primero.
- Conciso: prefiero 2 oraciones útiles que 5 redundantes.

Lo que SÍ podés hacer:
- Consultar data del tenant del usuario usando las tools disponibles (todas read-only).
- Calcular y comparar (ventas vs período anterior, top productos, saldos, etc.).
- Sugerir próximos pasos basados en la data ("tenés 3 comprobantes pendientes hace +5 días, conviene revisarlos").
- Explicar conceptos del portal si te lo piden ("¿cómo funciona la trazabilidad de cajas?").

Lo que NO podés hacer (importante):
- NO completar ventas, ni registrar pagos, ni modificar nada. Sos solo análisis/lectura.
- NO responder sobre temas que no tengan que ver con el negocio del user (clima, política, etc.) — re-dirigí amablemente al uso del portal.
- NO inventar datos. Si una tool falla o no devuelve info, decílo claramente. No alucines números.
- NO compartir info de OTROS tenants — eso lo asegura el sistema (RLS), pero no asumas y no especules sobre otros negocios.

Uso eficiente de tools:
- Para preguntas de ventas, usá get_ventas_periodo con el periodo apropiado ('hoy', 'semana', 'mes', etc.) — devuelve retail + B2B unificados con ganancia neta.
- Para comparar dos períodos, llamá get_ventas_periodo dos veces con distintos 'periodo' (ej. 'mes' vs 'mes_anterior'). Si pide explícitamente "mes vs mes anterior", get_dashboard_mensual lo hace en una sola llamada.
- Si el user pregunta por envíos pendientes/en calle, get_envios_activos.
- Si pregunta por saldos de cajas / cuánto dinero hay, get_saldos_cajas.
- Si pregunta "qué alertas hay" o "qué tengo que revisar urgente", get_alertas.
- Combiná tools cuando tenga sentido (ej. "cómo viene hoy" → get_ventas_periodo + get_envios_activos + get_alertas en paralelo).
- Si la respuesta del user es ambigua, preguntá antes de llamar tools (ahorra costo y le da control al user).
- Si el user te pide algo que no tenés tool para responder, decílo claramente — no inventes data.

Formato de respuesta:
- Si devolvés números, formatealos con separador de miles ("$ 1.245.300", no "1245300").
- Si devolvés comparativas, mostrá el delta absoluto Y porcentual.
- Si la respuesta tiene varios datos, usá listas o tablas markdown.`;

// ──────────────────────────────────────────────────────────────────────────
// Tool definitions (Anthropic format)
// ──────────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_kpis_hoy',
    description:
      'Devuelve KPIs operativos del día actual del tenant del usuario: ' +
      'monto bruto vendido hoy, comprobantes ingresados hoy, retención ' +
      'financiera, y cantidad de envíos activos. Útil para responder ' +
      'preguntas como "cómo vamos hoy", "cuánto vendí hoy", "actividad ' +
      'del día". No requiere parámetros — siempre devuelve los datos del ' +
      'día actual en zona horaria Argentina (UTC-3).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ── Ventas ───────────────────────────────────────────────────────────────
  {
    name: 'get_ventas_periodo',
    description:
      'Ventas del período especificado (retail + B2B unificadas). Devuelve ' +
      'ingresos en USD, ganancia bruta, ganancia neta (acreditada - costos ' +
      'financieros), cantidad de comprobantes, ticket promedio, y desglose ' +
      'acreditadas vs pendientes. Útil para preguntas como "cuánto vendí ' +
      'esta semana", "cómo viene el mes", "vendí más ayer o hoy". Si el user ' +
      'pide comparar dos períodos, llamá esta tool dos veces con los ' +
      'distintos `periodo`.',
    input_schema: {
      type: 'object',
      properties: PERIODO_SCHEMA_FRAGMENT,
      required: ['periodo'],
    },
  },

  // ── Dashboard mensual (con comparativa mes anterior) ─────────────────────
  {
    name: 'get_dashboard_mensual',
    description:
      'KPIs del mes actual con comparativa contra el mes anterior. Devuelve ' +
      'bruto, neto, ganancia, ticket promedio + el delta absoluto y % vs ' +
      'mes anterior. Útil para "cómo viene el mes vs el pasado", "estamos ' +
      'mejor que el mes pasado". No requiere parámetros — siempre compara ' +
      'mes en curso contra el mes calendario anterior.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ── Envíos activos ───────────────────────────────────────────────────────
  {
    name: 'get_envios_activos',
    description:
      'Lista los envíos NO entregados ni cancelados (estados Pendiente o ' +
      'En camino), ordenados por fecha más vieja primero. Devuelve un ' +
      'resumen + los primeros N (default 10) con cliente, barrio, monto, ' +
      'estado y prioridad. Útil para "cuántos envíos tengo en la calle", ' +
      '"qué entregas tengo pendientes", "qué envío hay que priorizar".',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Máximo de envíos a devolver. Default 10.',
        },
      },
      required: [],
    },
  },

  // ── Saldos de cajas ──────────────────────────────────────────────────────
  {
    name: 'get_saldos_cajas',
    description:
      'Saldo actual de cada caja activa del tenant. Devuelve cada caja con ' +
      'su moneda + el total agrupado por moneda (USD/USDT consolidado, ARS ' +
      'separado — los grupos que usa el módulo Cajas en el portal). Útil ' +
      'para "cuánto tengo en USD", "cuánto cash hay", "qué saldo hay en ' +
      'tal caja". No requiere parámetros.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ── Alertas activas ──────────────────────────────────────────────────────
  {
    name: 'get_alertas',
    description:
      'Resumen de alertas activas del tenant: cajas en negativo, stock ' +
      'bajo de productos, clientes B2B en mora, y proveedores atrasados. ' +
      'Devuelve total + count por tipo + los primeros items críticos. Útil ' +
      'para "qué alertas tengo", "qué pasó hoy que tenga que revisar", ' +
      '"hay algo urgente". No requiere parámetros.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ──────────────────────────────────────────────────────────────────────────
// Handlers — implementación real de cada tool
// ──────────────────────────────────────────────────────────────────────────
// Cada handler recibe (input, ctx) donde:
//   input: objeto validado contra input_schema de la tool definition.
//   ctx:   { tenantId, userId, req? } — context para queries tenant-aware.
//
// Cada handler DEBE:
//   - Correr queries dentro de db.withTenant(ctx.tenantId, ...) para RLS.
//   - Devolver JSON serializable (Claude lo lee como string).
//   - En caso de error, throw — el dispatcher captura y devuelve mensaje
//     friendly al bot que puede reportar al user.
const handlers = {
  async get_kpis_hoy(_input, ctx) {
    return db.withTenant(ctx.tenantId, async (client) => {
      // Día actual en ART (UTC-3). Calculamos start/end del día en TZ AR.
      // Postgres maneja bien TIMESTAMPTZ vs zona horaria.
      // Schema real (verificado contra routes/comprobantes.js):
      //   monto             — monto bruto del comprobante
      //   monto_financiera  — comisión retenida por la financiera (= pct % de monto)
      //   monto_neto        — lo efectivamente cobrado (= monto - monto_financiera)
      //
      // c.fecha es DATE (no TIMESTAMPTZ), pero igual lo comparamos contra el
      // día actual en ART para que un user que ingrese un comprobante con
      // fecha=hoy a las 23:55 ART cuente en el día corriente (no en el
      // siguiente UTC). c.fecha::timestamp + AT TIME ZONE fuerza la
      // interpretación.
      const { rows: kpisRows } = await client.query(`
        SELECT
          COALESCE(SUM(c.monto),            0)::numeric AS bruto_hoy,
          COALESCE(SUM(c.monto_financiera), 0)::numeric AS retencion_hoy,
          COALESCE(SUM(c.monto_neto),       0)::numeric AS neto_hoy,
          COUNT(*)::int                                  AS comprobantes_hoy
        FROM comprobantes c
        WHERE c.fecha = (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
      `);

      // Envíos activos: estado 'Pendiente' o 'En camino' (no terminados).
      const { rows: enviosRows } = await client.query(`
        SELECT COUNT(*)::int AS envios_activos
        FROM envios
        WHERE estado IN ('Pendiente', 'En camino')
      `);

      // Pct financiera (del tenant) — defensive si no hay config.
      const { rows: configRows } = await client.query(`
        SELECT COALESCE(pct_financiera, 3.0)::numeric AS pct_financiera
        FROM config
        LIMIT 1
      `);

      const kpis = kpisRows[0] || {};
      const envios = enviosRows[0] || {};
      const config = configRows[0] || {};

      return {
        bruto_hoy: Number(kpis.bruto_hoy || 0),
        retencion_hoy: Number(kpis.retencion_hoy || 0),
        neto_hoy: Number(kpis.neto_hoy || 0),
        comprobantes_hoy: kpis.comprobantes_hoy || 0,
        envios_activos: envios.envios_activos || 0,
        pct_financiera: Number(config.pct_financiera || 3.0),
        fecha: new Date()
          .toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }),
      };
    });
  },

  // ──────────────────────────────────────────────────────────────────────
  // get_ventas_periodo — retail + B2B unificadas
  // ──────────────────────────────────────────────────────────────────────
  async get_ventas_periodo(input, ctx) {
    const { periodo, desde: desdeIn, hasta: hastaIn } = input || {};
    const { desde, hasta, label } = periodoRange(periodo, {
      desde: desdeIn,
      hasta: hastaIn,
    });

    return db.withTenant(ctx.tenantId, async (client) => {
      // Retail — ventas table. Filtramos cancelado + deleted_at.
      // Estados: 'acreditado', 'pendiente', 'cancelado' (CHECK constraint).
      const { rows: retailRows } = await client.query(
        `SELECT
           COUNT(*)::int                                              AS ventas_count,
           COUNT(*) FILTER (WHERE estado = 'acreditado')::int         AS acreditadas_count,
           COUNT(*) FILTER (WHERE estado = 'pendiente')::int          AS pendientes_count,
           COALESCE(SUM(total_usd), 0)::numeric                       AS ingresos_usd,
           COALESCE(SUM(ganancia_usd), 0)::numeric                    AS ganancia_bruta_usd,
           COALESCE(SUM(ganancia_usd) FILTER
             (WHERE estado = 'acreditado'), 0)::numeric               AS ganancia_acreditada_usd,
           COALESCE(SUM(comision_total_metodos) FILTER
             (WHERE estado = 'acreditado'), 0)::numeric               AS costo_financiero_usd
         FROM ventas
         WHERE fecha >= $1 AND fecha <= $2
           AND estado <> 'cancelado'
           AND deleted_at IS NULL`,
        [desde, hasta]
      );

      // B2B — movimientos_cc tipo='compra'. monto_total ya está en USD.
      // No tiene "estado cancelado", solo soft-delete.
      const { rows: b2bRows } = await client.query(
        `SELECT
           COUNT(*)::int                          AS b2b_count,
           COALESCE(SUM(monto_total), 0)::numeric AS b2b_ingresos_usd
         FROM movimientos_cc
         WHERE fecha >= $1 AND fecha <= $2
           AND tipo = 'compra'
           AND deleted_at IS NULL`,
        [desde, hasta]
      );

      const r = retailRows[0] || {};
      const b = b2bRows[0] || {};
      const totalCount = (r.ventas_count || 0) + (b.b2b_count || 0);
      const ingresosTotalUsd = Number(r.ingresos_usd || 0) + Number(b.b2b_ingresos_usd || 0);
      const gananciaAcreditadaUsd = Number(r.ganancia_acreditada_usd || 0);
      const costoFinancieroUsd = Number(r.costo_financiero_usd || 0);
      const gananciaNetaUsd = gananciaAcreditadaUsd - costoFinancieroUsd;
      const ticketPromedioUsd = totalCount > 0 ? ingresosTotalUsd / totalCount : 0;

      return {
        periodo: { desde, hasta, label },
        retail: {
          ventas_count: r.ventas_count || 0,
          acreditadas: r.acreditadas_count || 0,
          pendientes: r.pendientes_count || 0,
          ingresos_usd: Number(r.ingresos_usd || 0),
          ganancia_bruta_usd: Number(r.ganancia_bruta_usd || 0),
          ganancia_acreditada_usd: gananciaAcreditadaUsd,
        },
        b2b: {
          ventas_count: b.b2b_count || 0,
          ingresos_usd: Number(b.b2b_ingresos_usd || 0),
        },
        consolidado: {
          ventas_count: totalCount,
          ingresos_usd: ingresosTotalUsd,
          ganancia_neta_usd: gananciaNetaUsd,
          costo_financiero_usd: costoFinancieroUsd,
          ticket_promedio_usd: Number(ticketPromedioUsd.toFixed(2)),
        },
      };
    });
  },

  // ──────────────────────────────────────────────────────────────────────
  // get_dashboard_mensual — mes actual vs mes anterior
  // ──────────────────────────────────────────────────────────────────────
  // Comparativa simple: 2 períodos consecutivos + deltas. Reusa la lógica
  // de get_ventas_periodo para garantizar consistencia (mismo SQL → mismos
  // números que si el bot llamara la otra tool).
  async get_dashboard_mensual(_input, ctx) {
    // Llamamos a la implementación interna, NO al dispatcher, para evitar el
    // overhead de logging y double-error-handling.
    const actual = await handlers.get_ventas_periodo({ periodo: 'mes' }, ctx);
    const anterior = await handlers.get_ventas_periodo({ periodo: 'mes_anterior' }, ctx);

    // Función pura para calcular delta seguro (evita división por cero).
    const delta = (act, ant) => {
      const abs = act - ant;
      const pct = ant === 0 ? (act > 0 ? 100 : 0) : (abs / Math.abs(ant)) * 100;
      return { absoluto: Number(abs.toFixed(2)), porcentual: Number(pct.toFixed(1)) };
    };

    return {
      mes_actual: {
        periodo: actual.periodo,
        ingresos_usd: actual.consolidado.ingresos_usd,
        ganancia_neta_usd: actual.consolidado.ganancia_neta_usd,
        ventas_count: actual.consolidado.ventas_count,
        ticket_promedio_usd: actual.consolidado.ticket_promedio_usd,
      },
      mes_anterior: {
        periodo: anterior.periodo,
        ingresos_usd: anterior.consolidado.ingresos_usd,
        ganancia_neta_usd: anterior.consolidado.ganancia_neta_usd,
        ventas_count: anterior.consolidado.ventas_count,
        ticket_promedio_usd: anterior.consolidado.ticket_promedio_usd,
      },
      deltas: {
        ingresos_usd: delta(
          actual.consolidado.ingresos_usd,
          anterior.consolidado.ingresos_usd
        ),
        ganancia_neta_usd: delta(
          actual.consolidado.ganancia_neta_usd,
          anterior.consolidado.ganancia_neta_usd
        ),
        ventas_count: delta(
          actual.consolidado.ventas_count,
          anterior.consolidado.ventas_count
        ),
      },
    };
  },

  // ──────────────────────────────────────────────────────────────────────
  // get_envios_activos — pendientes + en camino
  // ──────────────────────────────────────────────────────────────────────
  async get_envios_activos(input, ctx) {
    const limit = Math.min(Math.max(1, Number(input?.limit) || 10), 50);

    return db.withTenant(ctx.tenantId, async (client) => {
      // Resumen agregado en una sola query (cheap).
      const { rows: resumen } = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE estado = 'Pendiente')::int  AS pendientes,
           COUNT(*) FILTER (WHERE estado = 'En camino')::int  AS en_camino,
           COALESCE(SUM(total_cobrado), 0)::numeric           AS total_a_cobrar
         FROM envios
         WHERE deleted_at IS NULL
           AND estado IN ('Pendiente', 'En camino')`
      );

      // Top N a entregar — los más viejos primero (los que urgen).
      const { rows: items } = await client.query(
        `SELECT
           id, fecha, cliente, barrio,
           total_cobrado, costo_envio, estado, prioridad
         FROM envios
         WHERE deleted_at IS NULL
           AND estado IN ('Pendiente', 'En camino')
         ORDER BY
           CASE prioridad WHEN 'Alta' THEN 0 WHEN 'Media' THEN 1 ELSE 2 END,
           fecha ASC, id ASC
         LIMIT $1`,
        [limit]
      );

      const r = resumen[0] || {};
      return {
        resumen: {
          total: (r.pendientes || 0) + (r.en_camino || 0),
          pendientes: r.pendientes || 0,
          en_camino: r.en_camino || 0,
          total_a_cobrar: Number(r.total_a_cobrar || 0),
        },
        items: items.map((e) => ({
          id: e.id,
          fecha: e.fecha,
          cliente: e.cliente,
          barrio: e.barrio,
          total_cobrado: Number(e.total_cobrado || 0),
          costo_envio: Number(e.costo_envio || 0),
          estado: e.estado,
          prioridad: e.prioridad,
        })),
      };
    });
  },

  // ──────────────────────────────────────────────────────────────────────
  // get_saldos_cajas
  // ──────────────────────────────────────────────────────────────────────
  // Saldo actual = saldo_inicial + Σ(ingresos) - Σ(egresos).
  // Mismo cálculo que cajaLedger.js — replicado acá en SQL pura para no
  // tener que hacer N+1 (1 query agrupa todas las cajas).
  async get_saldos_cajas(_input, ctx) {
    return db.withTenant(ctx.tenantId, async (client) => {
      const { rows: cajas } = await client.query(
        `SELECT
           mp.id,
           mp.nombre,
           mp.moneda,
           mp.es_financiera,
           mp.es_tarjeta,
           (mp.saldo_inicial + COALESCE(
              SUM(CASE WHEN cm.tipo = 'ingreso' THEN cm.monto ELSE -cm.monto END)
                FILTER (WHERE cm.deleted_at IS NULL),
              0
           ))::numeric AS saldo
         FROM metodos_pago mp
         LEFT JOIN caja_movimientos cm ON cm.caja_id = mp.id
         WHERE mp.deleted_at IS NULL
           AND mp.activo IS NOT FALSE
         GROUP BY mp.id, mp.saldo_inicial
         ORDER BY mp.orden NULLS LAST, mp.nombre`
      );

      // Agrupar totales por moneda. Regla del portal (cajaLedger.js#grupoMoneda):
      // USD y USDT se consolidan, ARS va aparte.
      const totales = { ARS: 0, USD: 0 };
      for (const c of cajas) {
        const saldo = Number(c.saldo || 0);
        if (c.moneda === 'ARS') totales.ARS += saldo;
        else totales.USD += saldo; // USD + USDT consolidados
      }

      return {
        cajas: cajas.map((c) => ({
          id: c.id,
          nombre: c.nombre,
          moneda: c.moneda,
          es_financiera: !!c.es_financiera,
          es_tarjeta: !!c.es_tarjeta,
          saldo: Number(c.saldo || 0),
        })),
        totales_por_moneda: {
          ARS: Number(totales.ARS.toFixed(2)),
          USD: Number(totales.USD.toFixed(2)),
        },
      };
    });
  },

  // ──────────────────────────────────────────────────────────────────────
  // get_alertas — resumen tenant-scoped (no usa /api/alertas porque ése
  // tiene cache global sin tenant key, ver task spawneada al respecto).
  // ──────────────────────────────────────────────────────────────────────
  async get_alertas(_input, ctx) {
    return db.withTenant(ctx.tenantId, async (client) => {
      // Cajas con saldo < 0 — usamos la misma fórmula que get_saldos_cajas.
      const { rows: cajasNeg } = await client.query(
        `SELECT mp.nombre, mp.moneda,
                (mp.saldo_inicial + COALESCE(
                  SUM(CASE WHEN cm.tipo='ingreso' THEN cm.monto ELSE -cm.monto END)
                    FILTER (WHERE cm.deleted_at IS NULL),
                  0
                ))::numeric AS saldo
         FROM metodos_pago mp
         LEFT JOIN caja_movimientos cm ON cm.caja_id = mp.id
         WHERE mp.deleted_at IS NULL AND mp.activo IS NOT FALSE
         GROUP BY mp.id, mp.nombre, mp.moneda, mp.saldo_inicial
         HAVING (mp.saldo_inicial + COALESCE(
                  SUM(CASE WHEN cm.tipo='ingreso' THEN cm.monto ELSE -cm.monto END)
                    FILTER (WHERE cm.deleted_at IS NULL),
                  0
                )) < 0
         ORDER BY saldo ASC
         LIMIT 5`
      );

      // Stock bajo — umbral default 5. Usamos la config de alertas_config
      // si existe, sino el default. La tabla alertas_config es RLS-scoped.
      const { rows: cfgRows } = await client.query(
        `SELECT parametros FROM alertas_config WHERE tipo = 'stock_bajo' AND activa = true`
      );
      const umbralStock = Number(cfgRows[0]?.parametros?.umbral_unidades) || 5;

      const { rows: stockBajo } = await client.query(
        `SELECT id, nombre, cantidad
         FROM productos
         WHERE deleted_at IS NULL
           AND oculto IS NOT TRUE
           AND condicion = 'nuevo'
           AND cantidad < $1
           AND cantidad > 0
         ORDER BY cantidad ASC
         LIMIT 5`,
        [umbralStock]
      );

      // CC en mora — clientes B2B con saldo > 0 (nos deben) y último mov hace > N días.
      const { rows: cfgMora } = await client.query(
        `SELECT parametros FROM alertas_config WHERE tipo = 'cc_mora' AND activa = true`
      );
      const diasMora = Number(cfgMora[0]?.parametros?.dias_sin_pago) || 30;

      const { rows: ccMora } = await client.query(
        `SELECT c.id, c.nombre, c.apellido,
                COALESCE(SUM(
                  CASE
                    WHEN m.tipo='saldo_inicial' THEN m.monto_total
                    WHEN m.tipo='compra' AND m.caja_id IS NOT NULL THEN 0
                    WHEN m.tipo='compra' THEN m.monto_total
                    ELSE -m.monto_total
                  END
                ), 0) AS saldo,
                MAX(m.fecha) AS ultimo_mov
         FROM clientes_cc c
         LEFT JOIN movimientos_cc m ON m.cliente_cc_id = c.id AND m.deleted_at IS NULL
         WHERE c.deleted_at IS NULL
         GROUP BY c.id, c.nombre, c.apellido
         HAVING COALESCE(SUM(
                  CASE
                    WHEN m.tipo='saldo_inicial' THEN m.monto_total
                    WHEN m.tipo='compra' AND m.caja_id IS NOT NULL THEN 0
                    WHEN m.tipo='compra' THEN m.monto_total
                    ELSE -m.monto_total
                  END
                ), 0) > 0
            AND (MAX(m.fecha) IS NULL OR MAX(m.fecha) < CURRENT_DATE - INTERVAL '1 day' * $1)
         ORDER BY saldo DESC
         LIMIT 5`,
        [diasMora]
      );

      const grupos = [
        {
          tipo: 'caja_negativa',
          count: cajasNeg.length,
          items: cajasNeg.map((c) => ({
            descripcion: `${c.nombre} (${c.moneda})`,
            saldo: Number(c.saldo),
          })),
        },
        {
          tipo: 'stock_bajo',
          count: stockBajo.length,
          umbral: umbralStock,
          items: stockBajo.map((p) => ({
            descripcion: p.nombre,
            cantidad: p.cantidad,
          })),
        },
        {
          tipo: 'cc_mora',
          count: ccMora.length,
          dias_umbral: diasMora,
          items: ccMora.map((c) => ({
            descripcion: `${c.nombre} ${c.apellido || ''}`.trim(),
            saldo_usd: Number(c.saldo),
            ultimo_mov: c.ultimo_mov,
          })),
        },
      ];

      return {
        total: grupos.reduce((acc, g) => acc + g.count, 0),
        grupos,
      };
    });
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────────────────────────────────
async function executeTool(name, input, ctx) {
  const handler = handlers[name];
  if (!handler) {
    logger.warn({ toolName: name }, '[chat-tools] handler no encontrado');
    return { error: `Tool "${name}" no implementada.` };
  }
  try {
    const result = await handler(input || {}, ctx);
    return result;
  } catch (err) {
    logger.error({ err, toolName: name, tenantId: ctx.tenantId }, '[chat-tools] error ejecutando handler');
    // Devolvemos error como data para que el bot pueda explicarlo al user
    // (en vez de propagar el throw que cortaría la conversación).
    return {
      error: 'Hubo un error obteniendo los datos. Probá de nuevo en un momento.',
      _internal: process.env.NODE_ENV === 'production' ? undefined : err.message,
    };
  }
}

module.exports = {
  SYSTEM_PROMPT,
  TOOLS,
  executeTool,
};
