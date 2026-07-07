/**
 * Tests de instrumentación Sentry en syncVentaCaja.
 *
 * Contexto (Fase B fix #4 audit 2026-07-07): el WARN de pino
 * `[syncVentaCaja] pago mismatch de moneda` NO va a Sentry por default —
 * pino sólo escribe a stdout (Railway logs). Para dimensionar cuánto
 * mismatch histórico hay en producción sin arrancar Fase B a ciegas,
 * agregamos un `Sentry.captureMessage` con fingerprint estable por par
 * (pagoMoneda→cajaMoneda) al lado del WARN.
 *
 * Estos tests fijan el contrato:
 *   - Se llama con level=warning + fingerprint correcto en mismatch.
 *   - NO se llama en el path OK (misma moneda o con TC válido).
 *   - Guarded por SENTRY_DSN — sin env var, no rompe ni intenta reportar.
 *   - Si Sentry falla, el sync sigue funcionando (best-effort).
 */

// Mocks totales antes de cargar el módulo.
jest.mock('@sentry/node', () => ({
  captureMessage: jest.fn(),
}));
jest.mock('../src/lib/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../src/lib/cajaLedger', () => ({
  reverseCajaMovimientos: jest.fn(async () => {}),
  postCajaMovimientosBulk: jest.fn(async () => {}),
}));

const Sentry = require('@sentry/node');
const logger = require('../src/lib/logger');
const { postCajaMovimientosBulk } = require('../src/lib/cajaLedger');
const { syncVentaCaja } = require('../src/lib/ventaSync');

// Helper: arma un cliente pg mock que devuelve `pagos` cuando se hace el
// SELECT de venta_pagos. syncVentaCaja hace un solo SELECT.
function makeClient(pagos) {
  return {
    query: jest.fn(async () => ({ rows: pagos })),
  };
}

// Venta acreditada mínima (retieneStock=true).
const ventaBase = { id: 42, order_id: 'V-0042', estado: 'acreditado', fecha: '2026-07-07' };

// SENTRY_DSN debe estar seteado para que el path de Sentry se active.
// Usamos un DSN dummy — el mock intercepta antes de la red.
const ORIG_DSN = process.env.SENTRY_DSN;
beforeAll(() => { process.env.SENTRY_DSN = 'https://dummy@sentry.io/1'; });
afterAll(() => {
  if (ORIG_DSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = ORIG_DSN;
});

beforeEach(() => { jest.clearAllMocks(); });

describe('syncVentaCaja — instrumentación Sentry en mismatch sin conversión', () => {
  it('mismatch USD→ARS sin tc → captureMessage con fingerprint estable', async () => {
    const client = makeClient([{
      metodo_pago_id: 7, monto: 100, moneda: 'USD', tc: null,
      caja_moneda: 'ARS', es_financiera: false, es_tarjeta: false,
    }]);

    await syncVentaCaja(client, ventaBase, 99);

    // WARN de pino sigue disparando (Railway logs).
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Y ahora también Sentry, con la firma que definimos.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = Sentry.captureMessage.mock.calls[0];
    expect(msg).toMatch(/pago mismatch de moneda/);
    expect(opts.level).toBe('warning');
    // Fingerprint estable: mismatch USD→ARS agrupa aparte de USD→UYU, etc.
    expect(opts.fingerprint).toEqual(['sync-venta-caja-mismatch', 'USD', 'ARS']);
    expect(opts.tags).toMatchObject({
      pago_moneda: 'USD', caja_moneda: 'ARS', has_tc: 'no',
    });
    expect(opts.extra).toMatchObject({
      ventaId: 42, orderId: 'V-0042', cajaId: 7, monto: 100, tc: null,
    });
    // Y el mov NO se posteó (skip por seguridad).
    expect(postCajaMovimientosBulk).toHaveBeenCalledWith(client, []);
  });

  it('mismatch UYU↔ARS (sin USD intermedio) también reporta con su propio fingerprint', async () => {
    const client = makeClient([{
      metodo_pago_id: 8, monto: 4000, moneda: 'UYU', tc: 40,
      caja_moneda: 'ARS', es_financiera: false, es_tarjeta: false,
    }]);

    await syncVentaCaja(client, ventaBase, 99);

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [, opts] = Sentry.captureMessage.mock.calls[0];
    // Fingerprint distinto → issue de Sentry separado del USD→ARS.
    expect(opts.fingerprint).toEqual(['sync-venta-caja-mismatch', 'UYU', 'ARS']);
    // has_tc='yes' aunque no ayude a ARS↔UYU sin USD intermedio.
    expect(opts.tags.has_tc).toBe('yes');
  });
});

describe('syncVentaCaja — NO reporta Sentry en el happy path', () => {
  it('misma moneda (USD→USD) → no llama a Sentry ni a logger.warn', async () => {
    const client = makeClient([{
      metodo_pago_id: 10, monto: 100, moneda: 'USD', tc: null,
      caja_moneda: 'USD', es_financiera: false, es_tarjeta: false,
    }]);

    await syncVentaCaja(client, ventaBase, 99);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    // El mov se posteó con el monto convertido (100 sin cambio).
    expect(postCajaMovimientosBulk).toHaveBeenCalledTimes(1);
    const movs = postCajaMovimientosBulk.mock.calls[0][1];
    expect(movs).toHaveLength(1);
    expect(movs[0]).toMatchObject({ caja_id: 10, monto: 100, moneda: 'USD' });
  });

  it('mismatch USD→ARS CON tc → conversión OK, no reporta', async () => {
    const client = makeClient([{
      metodo_pago_id: 11, monto: 100, moneda: 'USD', tc: 1400,
      caja_moneda: 'ARS', es_financiera: false, es_tarjeta: false,
    }]);

    await syncVentaCaja(client, ventaBase, 99);

    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    const movs = postCajaMovimientosBulk.mock.calls[0][1];
    expect(movs[0]).toMatchObject({ caja_id: 11, monto: 140000, moneda: 'ARS' });
  });
});

describe('syncVentaCaja — Sentry disabled / falla no rompe el sync', () => {
  it('sin SENTRY_DSN, mismatch sigue skipeando el mov pero no llama captureMessage', async () => {
    const prev = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    try {
      const client = makeClient([{
        metodo_pago_id: 20, monto: 50, moneda: 'USDT', tc: null,
        caja_moneda: 'UYU', es_financiera: false, es_tarjeta: false,
      }]);

      await syncVentaCaja(client, ventaBase, 99);

      // WARN pino sí (siempre queremos el rastro en Railway logs).
      expect(logger.warn).toHaveBeenCalledTimes(1);
      // Sentry no (guardado por env var).
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      // Mov skipeado igual (defensa contra corrupción de saldo).
      expect(postCajaMovimientosBulk).toHaveBeenCalledWith(client, []);
    } finally { process.env.SENTRY_DSN = prev; }
  });

  it('si captureMessage tira excepción, el sync no crashea', async () => {
    Sentry.captureMessage.mockImplementationOnce(() => { throw new Error('sentry down'); });
    const client = makeClient([{
      metodo_pago_id: 21, monto: 100, moneda: 'ARS', tc: null,
      caja_moneda: 'USD', es_financiera: false, es_tarjeta: false,
    }]);

    // No debe throwear — telemetría es best-effort.
    await expect(syncVentaCaja(client, ventaBase, 99)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Mov skipeado.
    expect(postCajaMovimientosBulk).toHaveBeenCalledWith(client, []);
  });
});
