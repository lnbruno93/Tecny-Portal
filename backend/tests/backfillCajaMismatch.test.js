/**
 * Tests unitarios del helper puro `analizarCandidato` + `armarReporte`
 * usado por el script de backfill Fase B fix #4 (audit 2026-07-07).
 *
 * Estos tests fijan el contrato:
 *   - Qué rows se marcan como 'reparar' (auto-corregibles).
 *   - Qué rows se marcan como 'revisar_manual' (Lucas + tenant deciden).
 *   - Qué rows se marcan como 'skip' (y por qué razón).
 *
 * Importante: son la fuente de verdad de "cuándo tocamos data histórica
 * y cuándo no". Si alguien afloja alguno de los criterios de skip, este
 * test se rompe antes que el backfill corrompa dinero de un tenant.
 */

const { analizarCandidato, armarReporte } = require('../src/lib/backfillCajaMismatch');

// Row template para no repetir shape en cada test.
function row(overrides = {}) {
  return {
    caja_movimiento_id: 1,
    caja_id:            10,
    caja_moneda:        'ARS',
    caja_nombre:        'Mercadopago ARS',
    mov_monto:          100,      // crudo del pago (PRE-fix)
    mov_monto_usd:      0.07,     // 100 ARS / 1400 tc
    venta_id:           500,
    order_id:           'V-0500',
    pago_monto:         100,
    pago_moneda:        'USD',
    pago_tc:            1400,
    tenant_id:          1,
    tenant_slug:        'tekhaus',
    ...overrides,
  };
}

describe('analizarCandidato — casos SKIP (no requieren backfill)', () => {
  it('skip cuando pago y caja tienen misma moneda', () => {
    const r = analizarCandidato(row({ pago_moneda: 'ARS', caja_moneda: 'ARS' }));
    expect(r).toEqual({ accion: 'skip', razon: 'misma_moneda' });
  });

  it('skip cuando ambas son fuertes USD ↔ USDT (paridad 1:1, no afecta saldo)', () => {
    expect(analizarCandidato(row({ pago_moneda: 'USD', caja_moneda: 'USDT' })))
      .toEqual({ accion: 'skip', razon: 'usd_usdt_paridad' });
    expect(analizarCandidato(row({ pago_moneda: 'USDT', caja_moneda: 'USD' })))
      .toEqual({ accion: 'skip', razon: 'usd_usdt_paridad' });
  });

  it('skip cuando el monto ya no es el crudo del pago (POST-fix o tocado manual)', () => {
    // Ej: caja ARS, pago USD 100 tc=1400 — el mov ya tiene 140000 (convertido).
    const r = analizarCandidato(row({
      pago_moneda: 'USD', caja_moneda: 'ARS', pago_monto: 100, mov_monto: 140000, pago_tc: 1400,
    }));
    expect(r).toEqual({ accion: 'skip', razon: 'ya_convertido_o_tocado' });
  });

  it('skip también si mov_monto difiere de pago_monto por > 0.01 (tolerancia round2)', () => {
    // Un operador tocó manualmente: mov=100.50, pago=100. Damos por sentado
    // que la intervención humana es intencional — no la pisamos.
    const r = analizarCandidato(row({
      pago_moneda: 'USD', caja_moneda: 'ARS', pago_monto: 100, mov_monto: 100.5, pago_tc: 1400,
    }));
    expect(r.accion).toBe('skip');
    expect(r.razon).toBe('ya_convertido_o_tocado');
  });

  it('NO skipea si mov_monto difiere del pago por drift de fpu (< 0.01)', () => {
    const r = analizarCandidato(row({
      pago_moneda: 'USD', caja_moneda: 'ARS', pago_monto: 100, mov_monto: 100.005, pago_tc: 1400,
    }));
    // Esto SÍ es candidato a reparar (drift fpu, no intervención).
    expect(r.accion).toBe('reparar');
  });
});

describe('analizarCandidato — casos REPARAR (auto-corregibles)', () => {
  it('USD → ARS con tc: convierte y calcula monto_usd nuevo', () => {
    const r = analizarCandidato(row({
      pago_moneda: 'USD', caja_moneda: 'ARS', pago_monto: 100, mov_monto: 100, pago_tc: 1400,
    }));
    expect(r.accion).toBe('reparar');
    expect(r.nuevo_monto).toBe(140000);   // 100 × 1400
    expect(r.nuevo_monto_usd).toBe(100);  // 140000 ARS / 1400 = 100 USD
    expect(r.delta).toBe(139900);         // 140000 - 100
  });

  it('USD → UYU con tc=40 (caso reportado por tenant UY)', () => {
    const r = analizarCandidato(row({
      pago_moneda: 'USD', caja_moneda: 'UYU', pago_monto: 100, mov_monto: 100, pago_tc: 40,
    }));
    expect(r.accion).toBe('reparar');
    expect(r.nuevo_monto).toBe(4000);
    expect(r.nuevo_monto_usd).toBe(100);
    expect(r.delta).toBe(3900);
  });

  it('ARS → USD (inverso) también repara con div', () => {
    const r = analizarCandidato(row({
      pago_moneda: 'ARS', caja_moneda: 'USD', pago_monto: 140000, mov_monto: 140000, pago_tc: 1400,
    }));
    expect(r.accion).toBe('reparar');
    expect(r.nuevo_monto).toBe(100);
    expect(r.nuevo_monto_usd).toBe(100);
  });

  it('USDT → ARS con tc (mismo path que USD porque USDT es fuerte)', () => {
    const r = analizarCandidato(row({
      pago_moneda: 'USDT', caja_moneda: 'ARS', pago_monto: 50, mov_monto: 50, pago_tc: 1400,
    }));
    expect(r.accion).toBe('reparar');
    expect(r.nuevo_monto).toBe(70000);
  });
});

describe('analizarCandidato — casos REVISAR_MANUAL (no auto-corregibles)', () => {
  it('fiat USD → ARS sin tc → falta_tc', () => {
    const r = analizarCandidato(row({
      pago_moneda: 'USD', caja_moneda: 'ARS', pago_monto: 100, mov_monto: 100, pago_tc: null,
    }));
    expect(r).toEqual({ accion: 'revisar_manual', razon: 'falta_tc' });
  });

  it('fiat USD → ARS con tc=0 (inválido) → falta_tc', () => {
    const r = analizarCandidato(row({
      pago_moneda: 'USD', caja_moneda: 'ARS', pago_monto: 100, mov_monto: 100, pago_tc: 0,
    }));
    expect(r.accion).toBe('revisar_manual');
    expect(r.razon).toBe('falta_tc');
  });

  it('local ↔ local (ARS ↔ UYU) sin USD intermedio → par_no_soportado', () => {
    const r = analizarCandidato(row({
      pago_moneda: 'ARS', caja_moneda: 'UYU', pago_monto: 40000, mov_monto: 40000, pago_tc: 40,
    }));
    expect(r).toEqual({ accion: 'revisar_manual', razon: 'par_no_soportado' });
  });

  it('UYU → ARS también par_no_soportado', () => {
    const r = analizarCandidato(row({
      pago_moneda: 'UYU', caja_moneda: 'ARS', pago_monto: 1000, mov_monto: 1000, pago_tc: 40,
    }));
    expect(r.razon).toBe('par_no_soportado');
  });
});

describe('armarReporte — agrupa por tenant y separa buckets', () => {
  it('reporte por 2 tenants con mix de casos', () => {
    const rows = [
      // Tenant tekhaus (AR)
      row({ tenant_slug: 'tekhaus', caja_movimiento_id: 1, pago_moneda: 'USD', caja_moneda: 'ARS', mov_monto: 100 }),
      row({ tenant_slug: 'tekhaus', caja_movimiento_id: 2, pago_moneda: 'USD', caja_moneda: 'ARS', mov_monto: 100, pago_tc: null }),
      row({ tenant_slug: 'tekhaus', caja_movimiento_id: 3, pago_moneda: 'ARS', caja_moneda: 'ARS' }),  // skip
      // Tenant UY
      row({ tenant_slug: 'uytenant', tenant_id: 2, caja_movimiento_id: 4, pago_moneda: 'USD', caja_moneda: 'UYU', mov_monto: 100, pago_tc: 40 }),
    ];
    const r = armarReporte(rows);

    expect(r.total_rows).toBe(4);
    expect(Object.keys(r.tenants)).toEqual(['tekhaus', 'uytenant']);

    expect(r.tenants.tekhaus.reparables).toHaveLength(1);
    expect(r.tenants.tekhaus.reparables[0].caja_movimiento_id).toBe(1);
    expect(r.tenants.tekhaus.reparables[0].mov_monto_nuevo).toBe(140000);

    expect(r.tenants.tekhaus.revisar_manual).toHaveLength(1);
    expect(r.tenants.tekhaus.revisar_manual[0].caja_movimiento_id).toBe(2);
    expect(r.tenants.tekhaus.revisar_manual[0].razon).toBe('falta_tc');

    expect(r.tenants.tekhaus.skip.count).toBe(1);
    expect(r.tenants.tekhaus.skip.por_razon).toEqual({ misma_moneda: 1 });

    expect(r.tenants.uytenant.reparables).toHaveLength(1);
    expect(r.tenants.uytenant.reparables[0].mov_monto_nuevo).toBe(4000);
  });

  it('cajas_afectadas es el count de cajas distintas con reparables o manuales', () => {
    const rows = [
      row({ tenant_slug: 'x', caja_id: 10, caja_movimiento_id: 1, pago_moneda: 'USD', caja_moneda: 'ARS' }),
      row({ tenant_slug: 'x', caja_id: 10, caja_movimiento_id: 2, pago_moneda: 'USD', caja_moneda: 'ARS' }),
      row({ tenant_slug: 'x', caja_id: 11, caja_movimiento_id: 3, pago_moneda: 'USD', caja_moneda: 'ARS' }),
      row({ tenant_slug: 'x', caja_id: 12, caja_movimiento_id: 4, pago_moneda: 'ARS', caja_moneda: 'ARS' }),  // skip, no cuenta
    ];
    const r = armarReporte(rows);
    expect(r.tenants.x.cajas_afectadas).toBe(2);  // solo 10 y 11
  });

  it('reporte vacío cuando no hay rows', () => {
    const r = armarReporte([]);
    expect(r).toEqual({ tenants: {}, total_rows: 0 });
  });
});
