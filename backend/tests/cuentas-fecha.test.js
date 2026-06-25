/**
 * Regresión — validación de `fecha` robusta a zona horaria.
 * Antes se parseaba con new Date(d+'T00:00:00') en la TZ local del server, lo que
 * pasada la medianoche UTC rechazaba el día actual como "futuro". Ahora se compara
 * de forma lexical (string YYYY-MM-DD) contra el "hoy" en UTC.
 */
const { createMovimientoCCSchema } = require('../src/schemas/cuentas');

// SOL-2 (TANDA 1.B): pago/parte_de_pago ahora exigen caja_id en el refine del
// schema. Para que este test siga aislando la validación de fecha (no la de
// caja_id), incluimos un caja_id stub válido en el base.
const base = { cliente_cc_id: 1, tipo: 'pago', monto_total: 100, caja_id: 1 };
const parse = (fecha) => createMovimientoCCSchema.safeParse({ ...base, fecha });

describe('validación de fecha (timezone-safe)', () => {
  it('acepta el día de hoy (UTC) — la misma base que envía el front', () => {
    const hoyUTC = new Date().toISOString().split('T')[0];
    expect(parse(hoyUTC).success).toBe(true);
  });

  it('rechaza una fecha claramente futura', () => {
    expect(parse('2999-01-01').success).toBe(false);
  });

  it('rechaza fechas anteriores al año 2000', () => {
    expect(parse('1999-12-31').success).toBe(false);
  });

  it('rechaza un string con formato/fecha inválida', () => {
    expect(parse('2026-13-40').success).toBe(false);
    expect(parse('no-es-fecha').success).toBe(false);
  });
});
