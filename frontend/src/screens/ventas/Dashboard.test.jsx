/**
 * Tests del Dashboard de ventas (Tema C.4).
 *
 * Foco: la cascada de ganancia neta — bruta acreditada → −costo financiero
 * → −egresos = neta. Antes del fix C.1+C.2+C.3 la "ganancia neta" estaba
 * inflada por la comisión retenida del método de pago. Este test bloquea
 * regresiones: si alguien remueve o renombra los campos del breakdown, se
 * cae acá.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock del hook de moneda del tenant. Cada test setea el valor que quiere
// para simular tenants AR (default) o UY. El hook real depende de
// AuthContext + user.tenant.pais, cadena que no necesitamos para tests
// unitarios del componente. Ver useMonedasTenant.test.jsx para el hook.
vi.mock('../../lib/useMonedasTenant', () => ({
  useMonedasTenant: vi.fn(),
}));

import Dashboard from './Dashboard';
import { useMonedasTenant } from '../../lib/useMonedasTenant';

beforeEach(() => {
  // Default: tenant AR — la mayoría de tests preexistentes asumen ARS.
  useMonedasTenant.mockReturnValue({ monedaLocal: 'ARS' });
});

// Factory de un objeto de dashboard mínimo. Solo carga los campos que el
// componente lee — el resto se queda en sus defaults para no acoplar el test
// a cambios en partes no relacionadas (top productos, etc.).
function makeDashboard(overrides = {}) {
  return {
    ventas_count: 1,
    ingresos: { usd: 100, ars: 0, usdt: 0, total_usd_equiv: 100, ventas_total_usd: 100 },
    unidades: { celulares: 1, accesorios: 0 },
    ganancia_bruta_usd: 40,
    ganancia_bruta_acreditada_usd: 40,
    costo_financiero_usd: 10,
    costo_financiero_acreditado_usd: 10,
    egresos_usd: 5,
    ganancia_neta_usd: 25,
    margen_pct: 25,
    costos_usd: 60,
    inversion_canjes_usd: 0,
    diferencias: { sobrepagos: 0, faltantes: 0, neto: 0 },
    metodos_pago: [],
    por_horario: [],
    por_etiqueta: [],
    ticket_promedio_usd: 100,
    top_productos: [],
    top_vendedores: [],
    ...overrides,
  };
}

// `fmt` (lib/format.ts) usa Math.round + toLocaleString('es-AR') → enteros.
// 25 → "25", 1234 → "1.234". Por eso los matchers de monto usan strings
// crudos en vez de regex con decimales.

describe('Dashboard — desglose de ganancia neta (Tema C.4)', () => {
  it('muestra la cascada bruta · −fin · −egr cuando hay costo financiero > 0', () => {
    const { container } = render(<Dashboard d={makeDashboard()} />);
    // Big number = neta. fmt(25) = "25" → "u$s25" pero NO seguido de otro dígito
    // (para no pegar contra u$s250). \b no sirve porque '5' y 'B' (de "Bruta")
    // son ambos word chars y no hay boundary entre ellos.
    expect(container.textContent).toMatch(/u\$s25(?!\d)/);
    // Cascada visible — texto repartido en spans; verificamos el textContent
    // de la card de Ganancia neta.
    const card = screen.getByText('Ganancia neta').closest('.card');
    expect(card).toBeTruthy();
    const cardText = card.textContent.replace(/\s+/g, ' ');
    expect(cardText).toMatch(/Bruta u\$s40/);
    expect(cardText).toMatch(/−fin u\$s10/);
    expect(cardText).toMatch(/−egr u\$s5/);
    expect(cardText).toMatch(/25% margen/);
    // Tooltip de aclaración sobre qué incluye el costo financiero
    const finChip = card.querySelector('[title]');
    expect(finChip).toBeTruthy();
    expect(finChip.getAttribute('title')).toMatch(/tarjeta|transferencia/i);
  });

  it('NO muestra la línea −fin cuando no hay costo financiero en el período', () => {
    render(<Dashboard d={makeDashboard({
      costo_financiero_usd: 0,
      costo_financiero_acreditado_usd: 0,
      ganancia_neta_usd: 35, // bruta 40 − 0 fin − 5 egr
    })} />);
    const card = screen.getByText('Ganancia neta').closest('.card');
    const cardText = card.textContent.replace(/\s+/g, ' ');
    expect(cardText).toMatch(/Bruta u\$s40/);
    expect(cardText).toMatch(/−egr u\$s5/);
    expect(cardText).not.toMatch(/−fin/);
  });
});

// 2026-07-04 (ventas.ver_ganancias): el backend redacta el bloque de
// ganancia cuando el user no tiene la cap. El componente detecta la ausencia
// del campo `ganancia_neta_usd` para ocultar la card entera (modo "no mostrar
// nada" — Lucas prefiere ocultar antes que un guión).
describe('Dashboard — gating por ventas.ver_ganancias', () => {
  it('muestra la KPI card de Ganancia neta cuando el backend incluye los campos', () => {
    render(<Dashboard d={makeDashboard()} />);
    expect(screen.getByText('Ganancia neta')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-ganancia')).toBeInTheDocument();
  });

  it('oculta la KPI card de Ganancia neta cuando el backend redactó los campos', () => {
    // Backend redacta ganancia_bruta_usd / ganancia_neta_usd / margen_pct
    // — llegan undefined al frontend. El componente NO renderiza la card.
    const { ganancia_bruta_usd, ganancia_bruta_acreditada_usd,
            ganancia_neta_usd, margen_pct, ...redacted } = makeDashboard();
    render(<Dashboard d={redacted} />);
    expect(screen.queryByText('Ganancia neta')).toBeNull();
    expect(screen.queryByTestId('kpi-ganancia')).toBeNull();
    // Las otras 3 cards del kpi-grid siguen visibles — el vendedor sí ve
    // unidades / costos / inversión.
    expect(screen.getByText('Unidades vendidas')).toBeInTheDocument();
    expect(screen.getByText('Costos productos')).toBeInTheDocument();
    expect(screen.getByText('Inversión canjes')).toBeInTheDocument();
  });
});

// 2026-07-08 (bug iOStoreUY): antes la card "INGRESOS TOTALES" mostraba
// `u$s{usd} + ${ars} ARS` hardcoded. En tenants UY los pagos UYU
// desaparecían del display superior aunque el "USD equivalente" sí los
// reflejara. Ahora el frontend lee `monedaLocal` del tenant y muestra el
// complemento correcto (ARS en AR, UYU en UY).
describe('Dashboard — moneda local del tenant en INGRESOS TOTALES', () => {
  it('tenant AR: muestra "u$s + $ ARS" (comportamiento previo preservado)', () => {
    useMonedasTenant.mockReturnValue({ monedaLocal: 'ARS' });
    render(<Dashboard d={makeDashboard({
      ingresos: { usd: 100, ars: 25000, uyu: 0, usdt: 0, total_usd_equiv: 120, ventas_total_usd: 100 },
    })} />);
    // "Ingresos totales" en el DOM (el uppercase visual es CSS text-transform).
    const bigNum = screen.getByText('Ingresos totales').parentElement;
    const txt = bigNum.textContent.replace(/\s+/g, ' ');
    expect(txt).toMatch(/u\$s100 \+ \$25\.000 ARS/);
    expect(txt).not.toMatch(/UYU/);
  });

  it('tenant UY: muestra "u$s + $U UYU" (fix bug 2026-07-08)', () => {
    useMonedasTenant.mockReturnValue({ monedaLocal: 'UYU' });
    render(<Dashboard d={makeDashboard({
      ingresos: { usd: 100, ars: 0, uyu: 66167, usdt: 0, total_usd_equiv: 1755, ventas_total_usd: 100 },
    })} />);
    // "Ingresos totales" en el DOM (el uppercase visual es CSS text-transform).
    const bigNum = screen.getByText('Ingresos totales').parentElement;
    const txt = bigNum.textContent.replace(/\s+/g, ' ');
    expect(txt).toMatch(/u\$s100 \+ \$U66\.167 UYU/);
    expect(txt).not.toMatch(/ARS/);
  });

  it('tenant UY sin campo uyu (backend viejo pre-fix o cache stale): fallback a 0 (no NaN)', () => {
    // Defense en el frontend: si el backend NO devuelve `uyu` (cache viejo,
    // rollback, etc.), mostramos "$U0 UYU" en vez de "$UNaN UYU". Idem para
    // ars si estuviera undefined.
    useMonedasTenant.mockReturnValue({ monedaLocal: 'UYU' });
    render(<Dashboard d={makeDashboard({
      // Sin uyu.
      ingresos: { usd: 100, ars: 0, usdt: 0, total_usd_equiv: 100, ventas_total_usd: 100 },
    })} />);
    // "Ingresos totales" en el DOM (el uppercase visual es CSS text-transform).
    const bigNum = screen.getByText('Ingresos totales').parentElement;
    const txt = bigNum.textContent;
    expect(txt).toMatch(/\$U0 UYU/);
    expect(txt).not.toMatch(/NaN/);
  });

  // F3.c-2 (2026-07-09) — 3 shapes de `unidades_por_clase` que el Dashboard
  // debe manejar sin crashear durante la transición backend→frontend:
  describe('F3.c-2 — unidades_por_clase 3 shapes de compat', () => {
    it('shape NUEVO (array): renderea chip por cada item con emoji + nombre + n', () => {
      render(<Dashboard d={makeDashboard({
        unidades_por_clase: [
          { clase_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', nombre: 'Watch',      emoji: '⌚', n: 3 },
          { clase_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', nombre: 'Cargadores', emoji: '🔋', n: 12 },
          { clase_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', nombre: 'Sin emoji',  emoji: null, n: 1 },
        ],
      })} />);
      const card = screen.getByTestId('kpi-unidades');
      const txt = card.textContent;
      // Chips render: {emoji} {nombre} {n}
      expect(txt).toMatch(/⌚ Watch\s*3/);
      expect(txt).toMatch(/🔋 Cargadores\s*12/);
      // Sin emoji: solo nombre + n (no debe aparecer null ni undefined).
      expect(txt).toMatch(/Sin emoji\s*1/);
      expect(txt).not.toMatch(/null|undefined/);
    });

    it('shape LEGACY F2 (object {slug: n}): usa CLASES_LABELS hardcoded (backend viejo + client nuevo)', () => {
      render(<Dashboard d={makeDashboard({
        unidades_por_clase: { celular_sellado: 5, watch: 2 },
      })} />);
      const card = screen.getByTestId('kpi-unidades');
      const txt = card.textContent;
      // El client usa CLASES_LABELS del enum F1 hardcoded para el chip.
      expect(txt).toMatch(/Celular Sellado.*5|5.*Celular Sellado/);
      expect(txt).toMatch(/Watch.*2|2.*Watch/);
    });

    it('shape PRE-F2 (undefined): fallback al bucket binario', () => {
      render(<Dashboard d={makeDashboard({
        unidades: { celulares: 5, accesorios: 3 },
        // Sin unidades_por_clase.
      })} />);
      const card = screen.getByTestId('kpi-unidades');
      const txt = card.textContent;
      expect(txt).toMatch(/📱\s*5\s*·\s*🎧\s*3/);
    });

    it('array vacío: fallback al bucket binario (no chips vacíos)', () => {
      // Backend nuevo pero sin ventas del período → array [] → mostrar
      // el bucket viejo con 0/0 en vez de un card vacío.
      render(<Dashboard d={makeDashboard({
        unidades: { celulares: 0, accesorios: 0 },
        unidades_por_clase: [],
      })} />);
      const card = screen.getByTestId('kpi-unidades');
      expect(card.textContent).toMatch(/0\s*·.*0/);
    });
  });
});
