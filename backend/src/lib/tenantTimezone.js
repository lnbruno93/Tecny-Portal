// tenantTimezone.js — 2026-07-11 (auditoría Red B2B P0-2).
//
// Deriva la timezone IANA de un tenant a partir de su `tenants.pais`.
// Usado en comparaciones fecha-only (`paid_until`, boundaries de billing,
// cortes contables) donde comparar contra UTC genera off-by-one erráticos.
//
// Contexto del bug: el server PG de Railway corre en `Etc/UTC`. Al comparar
// `paid_until` (fecha calendar-local del negocio) contra `CURRENT_DATE`
// (fecha UTC), un tenant AR con `paid_until = 2026-07-11` quedaba
// "expirado" desde las 21:00 hora AR del 10 hasta las 21:00 hora AR del 11
// (3 horas de bloqueo por día). Comparación correcta:
//
//   paid_until >= (NOW() AT TIME ZONE '<tenant_tz>')::date
//
// Convención del portal (2026-07-11):
//   - AR (default) → America/Argentina/Buenos_Aires (UTC-3, sin DST).
//   - UY           → America/Montevideo (UTC-3, sin DST desde 2015).
//   - Cualquier otro → fallback a America/Argentina/Buenos_Aires.
//
// Ambas timezones son operacionalmente UTC-3, pero mantenemos el mapping
// explícito por si Argentina o Uruguay vuelven a adoptar DST, o si el
// portal se abre a otro país (CL con DST activo, BR con múltiples zonas).

// Mapping país → IANA timezone. Fuente única — cambiar acá si Argentina
// vuelve a DST u otro cambio.
const TZ_POR_PAIS = {
  AR: 'America/Argentina/Buenos_Aires',
  UY: 'America/Montevideo',
};

const TZ_FALLBACK = 'America/Argentina/Buenos_Aires';

/**
 * Devuelve la timezone IANA para un país tenant.
 *
 * @param {string|null|undefined} pais - código ISO-3166 alpha-2 (AR, UY).
 *                                        NULL / undefined / desconocido → fallback AR.
 * @returns {string} - timezone IANA (ej: 'America/Argentina/Buenos_Aires').
 */
function getTenantTimezone(pais) {
  return TZ_POR_PAIS[String(pais || '').toUpperCase()] || TZ_FALLBACK;
}

/**
 * Devuelve un fragmento SQL que expresa "hoy" en la timezone del tenant.
 * Diseñado para ser interpolado en una query como comparación fecha-only.
 *
 * IMPORTANTE: el país debe venir como parámetro `$N` de la query, NO por
 * concatenación de string (SQL injection). Este helper solo construye el
 * fragmento `(NOW() AT TIME ZONE tz)::date` — el caller es responsable de
 * pasar la timezone resuelta a la query.
 *
 * Ejemplo de uso:
 *   const tz = getTenantTimezone(tenant.pais);
 *   client.query(
 *     `SELECT ... WHERE paid_until >= (NOW() AT TIME ZONE $1)::date`,
 *     [tz]
 *   );
 *
 * @param {string} pais
 * @returns {string} timezone string listo para pasar como parámetro
 */
function tenantDateSqlParam(pais) {
  return getTenantTimezone(pais);
}

module.exports = { getTenantTimezone, tenantDateSqlParam, TZ_POR_PAIS };
