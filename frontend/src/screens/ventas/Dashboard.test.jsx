/**
 * Tests del Dashboard de ventas (Tema C.4).
 *
 * Foco: la cascada de ganancia neta — bruta acreditada → −costo financiero
 * → −egresos = neta. Antes del fix C.1+C.2+C.3 la "ganancia neta" estaba
 * inflada por la comisión retenida del método de pago. Este test bloquea
 * regresiones: si alguien remueve o renombra los campos del breakdown, se
 * cae acá.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Dashboard from './Dashboard';

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
