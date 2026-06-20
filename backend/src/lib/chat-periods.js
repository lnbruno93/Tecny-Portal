/**
 * chat-periods — helper compartido para parsear "período" en tools del bot
 * (#340 Fase 2).
 *
 * Problema:
 *   Sin un helper compartido, cada tool re-inventa el parseo de "período"
 *   con bugs sutiles (TZ ART, edge cases de fin de mes, formato YYYY-MM-DD,
 *   etc.) y queda inconsistente entre tools. El bot escribe "esta semana" y
 *   ventas dice 7 días pero envíos dice 5.
 *
 * Solución:
 *   Una sola función `periodoRange(periodo, { desde?, hasta? })` que
 *   devuelve siempre `{ desde, hasta, label }` con desde/hasta en formato
 *   YYYY-MM-DD calculado en ART (UTC-3, sin DST). Las queries hacen
 *   `WHERE fecha >= $desde AND fecha <= $hasta` y listo.
 *
 * Períodos soportados:
 *   - 'hoy'          → día actual ART
 *   - 'ayer'         → día anterior ART
 *   - 'semana'       → últimos 7 días (incluye hoy)
 *   - 'mes'          → del 1 al día actual del mes corriente
 *   - 'mes_anterior' → del 1 al último día del mes pasado
 *   - 'anio'         → del 1-ene al día actual del año
 *   - 'custom'       → usa desde/hasta del input (requeridos)
 *
 * Por qué inclusivo (>= desde AND <= hasta):
 *   Coherente con el resto del backend (routes/comprobantes, dashboardMensual,
 *   etc. ya usan inclusivo en ambos extremos). El día de "hoy" entonces es
 *   `desde === hasta`, no `[hoy, mañana)`.
 *
 * TZ:
 *   Todo se calcula en America/Argentina/Buenos_Aires (UTC-3, sin DST desde
 *   2009). Una venta cargada a las 23:55 ART cuenta en "hoy", no en "mañana"
 *   UTC. Argentina no tiene DST por ley, así que el offset es constante —
 *   no necesitamos Intl.DateTimeFormat ni librerías de TZ.
 */

const ART_OFFSET_HOURS = -3;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const PERIODOS_VALIDOS = ['hoy', 'ayer', 'semana', 'mes', 'mes_anterior', 'anio', 'custom'];

/**
 * Devuelve `Date` con la hora ajustada de UTC a ART.
 * No es "convertir" — es proyectar el instante UTC a las coordenadas
 * de Argentina para extraer year/month/day correctos.
 */
function nowInArt() {
  return new Date(Date.now() + ART_OFFSET_HOURS * MS_PER_HOUR);
}

/** Formatea una `Date` (proyectada en ART) como 'YYYY-MM-DD'. */
function isoDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Suma `n` días a una fecha ART. */
function addDays(dArt, n) {
  return new Date(dArt.getTime() + n * MS_PER_DAY);
}

/** Primer día del mes en ART. */
function firstOfMonth(dArt) {
  const r = new Date(dArt.getTime());
  r.setUTCDate(1);
  return r;
}

/** Último día del mes en ART (inclusivo). */
function lastOfMonth(dArt) {
  const r = new Date(dArt.getTime());
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + 1);
  r.setUTCDate(0); // restando a "día 0" del mes siguiente → último día del mes original
  return r;
}

/** Valida formato YYYY-MM-DD (10 chars, números válidos). */
function isValidIso(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // Defensive: rechazar 2026-02-31. Construir Date y verificar que se preservaron
  // year/month/day (si JS los "ajusta", la fecha era inválida).
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Resuelve un período a { desde, hasta, label }.
 *
 * @param {string} periodo — uno de PERIODOS_VALIDOS
 * @param {object} [opts]
 * @param {string} [opts.desde] — YYYY-MM-DD (requerido si periodo='custom')
 * @param {string} [opts.hasta] — YYYY-MM-DD (requerido si periodo='custom')
 * @returns {{ desde: string, hasta: string, label: string }}
 * @throws {Error} si period inválido o custom con desde/hasta faltantes/invertidos.
 */
function periodoRange(periodo, opts = {}) {
  if (!PERIODOS_VALIDOS.includes(periodo)) {
    throw new Error(
      `período inválido: "${periodo}". Válidos: ${PERIODOS_VALIDOS.join(', ')}`
    );
  }
  const now = nowInArt();

  switch (periodo) {
    case 'hoy': {
      const d = isoDate(now);
      return { desde: d, hasta: d, label: 'hoy' };
    }
    case 'ayer': {
      const a = addDays(now, -1);
      const d = isoDate(a);
      return { desde: d, hasta: d, label: 'ayer' };
    }
    case 'semana': {
      // Últimos 7 días incluyendo hoy → desde = hoy - 6.
      return {
        desde: isoDate(addDays(now, -6)),
        hasta: isoDate(now),
        label: 'últimos 7 días',
      };
    }
    case 'mes': {
      return {
        desde: isoDate(firstOfMonth(now)),
        hasta: isoDate(now),
        label: 'mes actual',
      };
    }
    case 'mes_anterior': {
      // Primer día del mes anterior + último día del mes anterior.
      const prev = new Date(now.getTime());
      prev.setUTCMonth(prev.getUTCMonth() - 1);
      return {
        desde: isoDate(firstOfMonth(prev)),
        hasta: isoDate(lastOfMonth(prev)),
        label: 'mes anterior',
      };
    }
    case 'anio': {
      const start = new Date(now.getTime());
      start.setUTCMonth(0);
      start.setUTCDate(1);
      return {
        desde: isoDate(start),
        hasta: isoDate(now),
        label: 'año actual',
      };
    }
    case 'custom': {
      const { desde, hasta } = opts;
      if (!isValidIso(desde) || !isValidIso(hasta)) {
        throw new Error('período custom requiere desde y hasta en formato YYYY-MM-DD');
      }
      if (desde > hasta) {
        throw new Error(`período custom inválido: desde (${desde}) > hasta (${hasta})`);
      }
      return { desde, hasta, label: `${desde} a ${hasta}` };
    }
    default:
      // Inalcanzable por el check de PERIODOS_VALIDOS arriba.
      throw new Error(`período no implementado: ${periodo}`);
  }
}

/** Schema fragment reusable en input_schema de las tools. */
const PERIODO_SCHEMA_FRAGMENT = {
  periodo: {
    type: 'string',
    enum: PERIODOS_VALIDOS,
    description:
      'Rango temporal. "hoy"/"ayer" = un día. "semana" = últimos 7 días. ' +
      '"mes"/"mes_anterior" = mes calendario. "anio" = año en curso. ' +
      '"custom" requiere desde y hasta en YYYY-MM-DD.',
  },
  desde: {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'Fecha desde (YYYY-MM-DD). Solo se usa si periodo="custom".',
  },
  hasta: {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'Fecha hasta (YYYY-MM-DD), inclusiva. Solo si periodo="custom".',
  },
};

module.exports = {
  periodoRange,
  PERIODOS_VALIDOS,
  PERIODO_SCHEMA_FRAGMENT,
};
