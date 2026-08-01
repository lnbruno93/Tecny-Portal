import { describe, it, expect } from 'vitest';
import { computeVentaTotales, computePagoAfterTcChange, sym } from './utils';

// 2026-07-08 (bug iOStoreUY): antes `sym('UYU')` caía en el default 'u$s'
// porque el helper era `m === 'ARS' ? '$' : 'u$s'`. En "Métodos de pago" del
// dashboard, un pago Mercadopago UYU 2.744 se mostraba como "u$s2.744"
// dando la impresión de que eran dólares. Ahora UYU mapea a "$U".
describe('sym', () => {
  it('ARS → "$"', () => expect(sym('ARS')).toBe('$'));
  it('UYU → "$U" (fix bug 2026-07-08)', () => expect(sym('UYU')).toBe('$U'));
  it('USD → "u$s"', () => expect(sym('USD')).toBe('u$s'));
  it('USDT → "u$s"', () => expect(sym('USDT')).toBe('u$s'));
  it('desconocido → "u$s" (default seguro)', () => expect(sym('XYZ')).toBe('u$s'));
});

// Auditoría 2026-07-04 TANDA 0: tests de regresión para `computeVentaTotales`,
// la lógica extraída del useMemo de Ventas.jsx. Cubre el cambio de criterio
// bruto-vs-neto (#506) — cambio contable importante que se mergeó sin tests.
//
// Contrato clave del helper:
//   cubierto = brutoTotal + canjes    (chequeo pagos-vs-venta ignora comisión)
//   real     = netoTotal + canjes - costos  (Ganancia real refleja comisión)
//   dif      = cubierto - items       (tolerancia 0.005 en el submit de venta)
describe('computeVentaTotales', () => {
  it('venta simple sin comisión: cubierto = bruto = items → dif ≈ 0', () => {
    const cart = [{ cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }];
    const pagos = [{ monto: 100, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
    const r = computeVentaTotales(cart, pagos, [], [], 0, null);
    expect(r.items).toBe(100);
    expect(r.cubierto).toBe(100);
    expect(r.dif).toBe(0);
    expect(r.bruta).toBe(40); // 100 - 60
    expect(r.real).toBe(40);  // sin comisión, real ≡ bruta
    expect(r.costoFin).toBe(0);
  });

  it('con comisión de financiera 3%: cubierto usa BRUTO (fix #506), real usa NETO', () => {
    // Este es el caso del bug que se corrigió: cliente paga u$s1250 exactos
    // con transferencia. Antes: "Falta u$s37.50" (comparaba con neto 1212.50).
    // Después: "Cubierto ✓" (compara con bruto 1250).
    const cart = [{ cantidad: 1, precio_vendido: 1250, costo: 900, moneda: 'USD' }];
    const finCajaId = 1;
    const metodos = [{ id: finCajaId, es_financiera: true, comision_pct: 0 }];
    const pagos = [{ monto: 1250, moneda: 'USD', metodo_pago_id: finCajaId, es_cuenta_corriente: false }];
    const r = computeVentaTotales(cart, pagos, [], metodos, 3, null);
    expect(r.items).toBe(1250);
    expect(r.cubierto).toBe(1250); // BRUTO, no neto → dif=0 → "Cubierto ✓"
    expect(r.dif).toBe(0);
    expect(r.costoFin).toBeCloseTo(37.5, 2); // 3% de 1250
    // Ganancia bruta: 1250 - 900 = 350 (sin considerar comisión).
    expect(r.bruta).toBe(350);
    // Ganancia real: neto (1212.50) - costo (900) = 312.50 (comisión afecta profit).
    expect(r.real).toBeCloseTo(312.5, 2);
  });

  it('con comisión de tarjeta 5%: mismo comportamiento (bruto para cubierto, neto para real)', () => {
    // Confirmado con Lucas: cambio aplica tanto a financiera como a tarjeta.
    const cart = [{ cantidad: 1, precio_vendido: 1000, costo: 700, moneda: 'USD' }];
    const tarjetaId = 2;
    const metodos = [{ id: tarjetaId, es_tarjeta: true, comision_pct: 5 }];
    const pagos = [{ monto: 1000, moneda: 'USD', metodo_pago_id: tarjetaId, es_cuenta_corriente: false }];
    const r = computeVentaTotales(cart, pagos, [], metodos, 0, null);
    expect(r.cubierto).toBe(1000); // BRUTO → "Cubierto ✓"
    expect(r.dif).toBe(0);
    expect(r.costoFin).toBeCloseTo(50, 2);
    expect(r.bruta).toBe(300);
    expect(r.real).toBeCloseTo(250, 2); // 950 - 700
  });

  it('con canje: suma al cubierto y al real como valor pleno (sin comisión sobre el canje)', () => {
    const cart = [{ cantidad: 1, precio_vendido: 1000, costo: 700, moneda: 'USD' }];
    const pagos = [{ monto: 600, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
    const canjes = [{ valor_toma: 400 }];
    const r = computeVentaTotales(cart, pagos, canjes, [], 0, null);
    expect(r.canjeTotal).toBe(400);
    expect(r.cubierto).toBe(1000); // 600 bruto + 400 canje
    expect(r.dif).toBe(0);
    expect(r.real).toBe(300); // 600 + 400 - 700
  });

  it('pago en ARS con TC 1000: convierte a USD para el cálculo', () => {
    // Venta u$s100, cliente paga $100.000 ARS con TC 1000 → equivale u$s100.
    const cart = [{ cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }];
    const pagos = [{ monto: 100000, moneda: 'ARS', tc: 1000, metodo_pago_id: null, es_cuenta_corriente: false }];
    const r = computeVentaTotales(cart, pagos, [], [], 0, null);
    expect(r.cubierto).toBe(100);
    expect(r.dif).toBe(0);
  });

  it('cart vacío: todos los totales son 0', () => {
    const r = computeVentaTotales([], [], [], [], 0, null);
    expect(r.items).toBe(0);
    expect(r.cubierto).toBe(0);
    expect(r.dif).toBe(0);
    expect(r.bruta).toBe(0);
    expect(r.real).toBe(0);
    expect(r.costoFin).toBe(0);
    expect(r.pagosDetalle).toEqual([]);
  });

  it('CC (cuenta corriente): no tiene comisión aunque el método tenga comision_pct', () => {
    // Un pago con es_cuenta_corriente=true bypassa el cálculo de comisión
    // (aunque el método asociado sea tarjeta con comision_pct>0).
    const cart = [{ cantidad: 1, precio_vendido: 500, costo: 300, moneda: 'USD' }];
    const metodos = [{ id: 3, es_tarjeta: true, comision_pct: 10 }];
    const pagos = [{ monto: 500, moneda: 'USD', metodo_pago_id: 3, es_cuenta_corriente: true }];
    const r = computeVentaTotales(cart, pagos, [], metodos, 0, null);
    expect(r.cubierto).toBe(500);
    expect(r.costoFin).toBe(0); // CC no comisiona
    expect(r.real).toBe(200);   // 500 - 300 (bruta = real cuando no hay comisión)
  });

  // 2026-07-14 (bug reportado por Lucas): el preview de "Ganancia real"
  // salía en verde con el monto absoluto cuando en realidad la venta era
  // una pérdida (sin pagos suficientes). Estos tests cubren el signo del
  // `real` en escenarios de sub-cobro para que el render pueda decidir
  // "Ganancia" vs "Pérdida" basado en `real < 0`.
  describe('sub-cobro (pérdida real)', () => {
    it('sin pagos y con costo → real es NEGATIVO (perdimos el costo)', () => {
      // Vender un producto en 720 sin cobrar nada: dimos el producto y no
      // percibimos plata. La ganancia real debe ser -720 (pérdida = costo del
      // producto entregado). El operador ve "Pérdida u$s720" en el preview.
      const cart = [{ cantidad: 1, precio_vendido: 720, costo: 720, moneda: 'USD' }];
      const r = computeVentaTotales(cart, [], [], [], 0, null);
      expect(r.items).toBe(720);
      expect(r.cubierto).toBe(0);
      expect(r.dif).toBe(-720);
      expect(r.bruta).toBe(0);
      expect(r.real).toBe(-720);
    });

    it('pago parcial menor al costo → real refleja el faltante', () => {
      // Cliente paga 700 de un producto que costó 720 (margen 0). Perdimos 20.
      const cart = [{ cantidad: 1, precio_vendido: 720, costo: 720, moneda: 'USD' }];
      const pagos = [{ monto: 700, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const r = computeVentaTotales(cart, pagos, [], [], 0, null);
      expect(r.items).toBe(720);
      expect(r.cubierto).toBe(700);
      expect(r.dif).toBeCloseTo(-20);
      expect(r.bruta).toBe(0);
      expect(r.real).toBeCloseTo(-20);
    });

    it('pago menor al costo con margen positivo pactado → sigue perdiendo si no cubre costo', () => {
      // Venta 1000 con costo 800 (margen bruto 200). Cliente paga solo 500.
      // Bruta = 200 (potencial). Real = 500 - 800 = -300 (perdimos parte del costo).
      const cart = [{ cantidad: 1, precio_vendido: 1000, costo: 800, moneda: 'USD' }];
      const pagos = [{ monto: 500, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const r = computeVentaTotales(cart, pagos, [], [], 0, null);
      expect(r.bruta).toBe(200);       // margen potencial (si cobrara todo)
      expect(r.real).toBeCloseTo(-300); // realidad: perdimos 300
    });
  });

  // 2026-08-01 (regla PO Lucas): el vuelto NO impacta la ganancia. Es solo
  // dinero devuelto al cliente (línea informativa en UI/comprobante). La
  // ganancia real usa la fórmula pre-PR #620: `real = netoTotalUsd + canjeTotal - costosUsd`
  // (sin restar `vueltoUsd`). El `vueltoUsd` sigue exportándose para que el
  // caller lo renderice como línea "Vuelto entregado: -u$s10" separada.
  describe('vuelto NO impacta ganancia real (regla PO 2026-08-01)', () => {
    it('pago exacto + vuelto adicional: real = pagos - costos (vuelto no resta)', () => {
      // Venta USD 100 con costo 60. Pago EXACTO 100 + vuelto USD 10 (regalo).
      // Real = 100 - 60 = 40. El vuelto se muestra como línea aparte.
      const cart = [{ cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }];
      const pagos = [{ monto: 100, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const vuelto = { monto: 10, moneda: 'USD', tc: null };
      const r = computeVentaTotales(cart, pagos, [], [], 0, null, vuelto);
      expect(r.bruta).toBe(40);
      expect(r.vueltoUsd).toBe(10); // se sigue exportando para UI
      expect(r.real).toBe(40);      // pagos (100) - costos (60), sin restar vuelto
    });

    it('pago excedente + vuelto por la diferencia: real = pagos - costos', () => {
      // Escenario típico: cliente paga u$s110 por venta u$s100, se le devuelve
      // u$s10 de vuelto. Real = 110 - 60 = 50 (el sobrepago cuenta como
      // ganancia; el vuelto sale de caja aparte, no del KPI de rentabilidad).
      const cart = [{ cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }];
      const pagos = [{ monto: 110, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const vuelto = { monto: 10, moneda: 'USD', tc: null };
      const r = computeVentaTotales(cart, pagos, [], [], 0, null, vuelto);
      expect(r.bruta).toBe(40);
      expect(r.vueltoUsd).toBe(10);
      expect(r.real).toBe(50); // 110 (pago) - 60 (costo), vuelto no descuenta
    });

    it('vuelto en ARS con TC 1000: real ignora el vuelto (regla PO)', () => {
      // Reproduce el screenshot: venta USD 600, pago USD 600 cubierto, vuelto
      // 150000 ARS con TC 1000 → USD 150 de vuelto (informativo).
      // Real = 600 - 480 = 120.
      const cart = [{ cantidad: 1, precio_vendido: 600, costo: 480, moneda: 'USD' }];
      const pagos = [{ monto: 600, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const vuelto = { monto: 150000, moneda: 'ARS', tc: 1000 };
      const r = computeVentaTotales(cart, pagos, [], [], 0, null, vuelto);
      expect(r.bruta).toBe(120);
      expect(r.vueltoUsd).toBe(150);
      expect(r.real).toBe(120); // = bruta (vuelto no resta)
    });

    it('sin vuelto: vueltoUsd es 0 y real no cambia', () => {
      const cart = [{ cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }];
      const pagos = [{ monto: 100, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const r = computeVentaTotales(cart, pagos, [], [], 0, null); // sin vuelto
      expect(r.vueltoUsd).toBe(0);
      expect(r.real).toBe(40);
    });

    it('vuelto en ARS sin TC (defensive): vueltoUsd=0, real igual', () => {
      // El schema Zod backend bloquea el submit, pero el preview tolera
      // shape inválido devolviendo vueltoUsd=0 sin explotar.
      const cart = [{ cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }];
      const pagos = [{ monto: 100, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const vuelto = { monto: 5000, moneda: 'ARS', tc: null };
      const r = computeVentaTotales(cart, pagos, [], [], 0, null, vuelto);
      expect(r.vueltoUsd).toBe(0);
      expect(r.real).toBe(40);
    });

    it('vuelto en UYU con TC 40: se computa vueltoUsd pero real NO lo resta', () => {
      // Venta USD 100 (costo 60), pago 105, vuelto UYU 200 @ TC 40 → USD 5.
      // Real = 105 - 60 = 45 (vuelto informativo, no descuenta).
      const cart = [{ cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }];
      const pagos = [{ monto: 105, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const vuelto = { monto: 200, moneda: 'UYU', tc: 40 };
      const r = computeVentaTotales(cart, pagos, [], [], 0, null, vuelto);
      expect(r.vueltoUsd).toBe(5);
      expect(r.real).toBe(45); // 105 - 60, sin restar 5 del vuelto
    });
  });
});

// 2026-08-01 (bug Leonel): al cambiar el TC de un pago que ya tiene monto
// tipeado, el pago NO debe multiplicar los pesos por el TC. Antes se
// priorizaba `hayUsdInput` sobre `hayMonto` — si el operador tipeaba el
// monto en el input "Le cobrás al cliente" (setPagoBruto, que setea
// usd_input derivado), al cambiar el TC se recalculaba monto = usd × tc_nuevo
// = número enorme. Fix: `hayMonto` prioridad #1.
describe('computePagoAfterTcChange (fix Leonel 2026-08-01)', () => {
  describe('BUG del reporte — pesos tipeados no se multiplican al cambiar TC', () => {
    it('pago con monto=811000 pesos + usd_input=519.87 derivado: al tipear TC=1560 preserva monto', () => {
      // Reproducción exacta del screenshot de Leonel:
      // - Transferencia PESOS $ 811000, TC 1560
      // - usd_input=519.87 (calculado por setPagoBruto o setPagoUsd previo)
      // Pre-fix: hayUsdInput ganaba → monto = 519.87 × 1560 = 810,997 (roundeo raro)
      // Post-fix: hayMonto gana → monto se preserva, usd_input se re-deriva.
      const pago = { monto: '811000', usd_input: '519.87', moneda: 'ARS' };
      const result = computePagoAfterTcChange(pago, '1560', 0);
      expect(result.tc).toBe('1560');
      expect(result.monto).toBeUndefined(); // NO se toca el monto
      expect(Number(result.usd_input)).toBe(519.87); // 811000 / 1560 ≈ 519.87
    });

    it('mismo bug con UYU (Uruguay): pesos preserva al cambiar TC', () => {
      const pago = { monto: '40000', usd_input: '1000', moneda: 'UYU' };
      const result = computePagoAfterTcChange(pago, '40', 0);
      expect(result.monto).toBeUndefined();
      expect(Number(result.usd_input)).toBe(1000); // 40000 / 40 = 1000
    });

    it('con comisión de tarjeta: preserva bruto, USD derivado NETO de comisión', () => {
      // Pago tarjeta 5% comisión. Bruto en pesos = 100000, TC = 1500.
      // USD equivalente = 100000 / 1500 / factor_comision
      //   factor = 1 / (1 - 0.05) = 1.0526
      //   netoEquivalente = 100000 / 1.0526 ≈ 95000
      //   USD = 95000 / 1500 ≈ 63.33
      const pago = { monto: '100000', usd_input: '65', moneda: 'ARS' };
      const result = computePagoAfterTcChange(pago, '1500', 5);
      expect(result.monto).toBeUndefined();
      expect(Number(result.usd_input)).toBeCloseTo(63.33, 1);
    });
  });

  describe('Flow original preservado — sin monto, sí usd_input', () => {
    it('pago con solo usd_input (autofill inicial): calcula monto = usd × tc', () => {
      // Caso: operador elige método, autofill deja usd_input=520 y monto=''.
      // Al tipear TC=1560, calcula monto = 520 × 1560 = 811200.
      const pago = { monto: '', usd_input: '520', moneda: 'ARS' };
      const result = computePagoAfterTcChange(pago, '1560', 0);
      expect(result.tc).toBe('1560');
      expect(result.monto).toBe('811200'); // 520 × 1560
      expect(result.usd_input).toBeUndefined(); // no se toca
    });

    it('pago USD puro: monto = usd × 1 (TC no aplica)', () => {
      const pago = { monto: '', usd_input: '500', moneda: 'USD' };
      const result = computePagoAfterTcChange(pago, '1500', 0);
      expect(result.monto).toBe('500'); // USD no divide/multiplica por TC
    });
  });

  describe('Casos edge', () => {
    it('sin monto ni usd_input: solo actualiza el TC', () => {
      const pago = { monto: '', usd_input: '', moneda: 'ARS' };
      const result = computePagoAfterTcChange(pago, '1500', 0);
      expect(result.tc).toBe('1500');
      expect(result.monto).toBeUndefined();
      expect(result.usd_input).toBeUndefined();
    });

    it('monto=0 se trata como sin monto (no preserva 0)', () => {
      const pago = { monto: '0', usd_input: '520', moneda: 'ARS' };
      const result = computePagoAfterTcChange(pago, '1500', 0);
      // hayMonto=false porque 0 > 0 = false → cae en usd_input branch
      expect(result.monto).toBe('780000'); // 520 × 1500
    });

    it('bruto_manual se resetea a false al cambiar TC', () => {
      // Consistencia con setPagoUsd: cualquier cambio de TC descarta el
      // override manual del bruto.
      const pago = { monto: '811000', usd_input: '520', moneda: 'ARS', bruto_manual: true };
      const result = computePagoAfterTcChange(pago, '1600', 0);
      expect(result.bruto_manual).toBe(false);
    });

    it('neto_input siempre se limpia al cambiar TC', () => {
      // Consistencia con setPagoUsd/setPagoBruto: cambio de TC descarta el neto tipeado.
      const pago = { monto: '811000', usd_input: '520', moneda: 'ARS', neto_input: '810000' };
      const result = computePagoAfterTcChange(pago, '1600', 0);
      expect(result.neto_input).toBe('');
    });

    it('ARS sin TC (edge defensive): monto preserva, usd_input NO se puede derivar', () => {
      // Si el usuario borra el TC (value=''), preservamos monto pero el USD
      // derivado retorna ''. En ese caso, el usd_input se queda como está.
      const pago = { monto: '811000', usd_input: '520', moneda: 'ARS' };
      const result = computePagoAfterTcChange(pago, '', 0);
      expect(result.tc).toBe('');
      expect(result.monto).toBeUndefined(); // preserva
      expect(result.usd_input).toBe('520'); // preserva (no se puede derivar sin TC)
    });
  });
});
