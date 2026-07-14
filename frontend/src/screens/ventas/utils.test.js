import { describe, it, expect } from 'vitest';
import { computeVentaTotales, sym } from './utils';

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

  // 2026-07-14 (bug reportado por Lucas): el vuelto no se descontaba del
  // preview de Ganancia real → mentía cuando había vuelto en ARS/UYU sobre
  // una venta USD cubierta. Estos tests cubren el descuento del vuelto.
  describe('vuelto descuenta de la ganancia real', () => {
    it('pago exacto + vuelto adicional (regalo): real cae en el monto del vuelto', () => {
      // Venta USD 100 con costo 60 → bruta = 40. Pago EXACTO 100 (cubierto) +
      // vuelto USD 10 adicional (regalo/error). El vuelto sale del comercio
      // sin cash compensatorio → perdemos 10 respecto al margen.
      const cart = [{ cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }];
      const pagos = [{ monto: 100, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const vuelto = { monto: 10, moneda: 'USD', tc: null };
      const r = computeVentaTotales(cart, pagos, [], [], 0, null, vuelto);
      expect(r.bruta).toBe(40);       // margen del producto, no cambia por el vuelto
      expect(r.vueltoUsd).toBe(10);
      expect(r.real).toBe(30);        // 100 - 60 - 10 (regalamos 10)
    });

    it('pago excedente + vuelto por la diferencia: real ≡ bruta (se compensan)', () => {
      // Escenario canónico: cliente paga MÁS de lo que costó, el operador le
      // devuelve la diferencia como vuelto. El pago excedente y el vuelto
      // se anulan en el flujo neto → ganancia real = margen del producto.
      const cart = [{ cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }];
      const pagos = [{ monto: 110, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const vuelto = { monto: 10, moneda: 'USD', tc: null };
      const r = computeVentaTotales(cart, pagos, [], [], 0, null, vuelto);
      expect(r.bruta).toBe(40);
      expect(r.vueltoUsd).toBe(10);
      expect(r.real).toBe(40); // 110 (pago) - 60 (costo) - 10 (vuelto) = 40
    });

    it('vuelto en ARS con TC 1000: descuenta la conversión USD del real (bug del screenshot)', () => {
      // Reproduce el screenshot: venta USD 600, pago USD 600 cubierto, vuelto
      // 150000 ARS con TC 1000 → USD 150 de vuelto. Bruta = 120. Real = -30.
      const cart = [{ cantidad: 1, precio_vendido: 600, costo: 480, moneda: 'USD' }];
      const pagos = [{ monto: 600, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const vuelto = { monto: 150000, moneda: 'ARS', tc: 1000 };
      const r = computeVentaTotales(cart, pagos, [], [], 0, null, vuelto);
      expect(r.bruta).toBe(120);
      expect(r.vueltoUsd).toBe(150);
      expect(r.real).toBe(-30); // 600 - 480 - 150
    });

    it('sin vuelto: vueltoUsd es 0 y real no se toca', () => {
      const cart = [{ cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }];
      const pagos = [{ monto: 100, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const r = computeVentaTotales(cart, pagos, [], [], 0, null); // sin vuelto
      expect(r.vueltoUsd).toBe(0);
      expect(r.real).toBe(40);
    });

    it('vuelto en ARS sin TC: defensively se ignora (real queda igual)', () => {
      // Guard defensive del helper: si el shape del vuelto es inválido (moneda
      // local sin TC), NO explota — devuelve vueltoUsd=0 y real sin descontar.
      // El schema Zod del backend bloquea el submit, así que esto solo aplica
      // durante la edición del form antes de submit.
      const cart = [{ cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }];
      const pagos = [{ monto: 100, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const vuelto = { monto: 5000, moneda: 'ARS', tc: null };
      const r = computeVentaTotales(cart, pagos, [], [], 0, null, vuelto);
      expect(r.vueltoUsd).toBe(0);
      expect(r.real).toBe(40); // no se descontó nada
    });

    it('vuelto en UYU con TC 40: descuenta correctamente en moneda uruguaya', () => {
      // Venta USD 100 (costo 60), vuelto UYU 200 con TC 40 → USD 5.
      const cart = [{ cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }];
      const pagos = [{ monto: 105, moneda: 'USD', metodo_pago_id: null, es_cuenta_corriente: false }];
      const vuelto = { monto: 200, moneda: 'UYU', tc: 40 };
      const r = computeVentaTotales(cart, pagos, [], [], 0, null, vuelto);
      expect(r.vueltoUsd).toBe(5);
      expect(r.real).toBe(40); // 105 - 60 - 5
    });
  });
});
