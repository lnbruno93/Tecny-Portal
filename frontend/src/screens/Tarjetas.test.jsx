import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', () => ({
  tarjetas: {
    list: vi.fn().mockResolvedValue([
      { id: 7, nombre: 'Tarjeta de Crédito | 3 Cuotas', moneda: 'ARS', comision_pct: '23.5', saldo: '85500', comision_total: '24500', bruto_total: '110000', movimientos: 2 },
    ]),
    // 2 cobros en el estado de cuenta:
    //   - id 1: cobro de venta (venta_id=42) → NO debe mostrar botones edit/delete
    //   - id 2: cobro previo (venta_id=null) → SÍ debe mostrar botones
    movimientosAll: vi.fn().mockResolvedValue({
      data: [
        { id: 1, fecha: '2026-05-10', tipo: 'cobro', moneda: 'ARS', monto_bruto: '100000', monto_neto: '76500', pct: '23.5', saldo_acum: '76500', metodo_nombre: 'Tarjeta de Crédito | 3 Cuotas', venta_order_id: 'ORD-26-abc', caja_nombre: null, venta_id: 42, comentarios: null },
        { id: 2, fecha: '2026-05-08', tipo: 'cobro', moneda: 'ARS', monto_bruto: '10000', monto_neto: '9000', pct: '10', saldo_acum: '85500', metodo_nombre: 'Tarjeta de Crédito | 3 Cuotas', venta_order_id: null, caja_nombre: null, venta_id: null, comentarios: 'Saldo previo' },
      ],
      pagination: { page: 1, pages: 1, total: 2 },
    }),
    get: vi.fn().mockResolvedValue({
      id: 7, nombre: 'Tarjeta de Crédito | 3 Cuotas', moneda: 'ARS', comision_pct: '23.5',
      resumen: { saldo: '85500', comision_total: '24500', bruto_total: '110000', movimientos: 2 },
    }),
    movimientos: vi.fn().mockResolvedValue({
      data: [
        { id: 1, fecha: '2026-05-10', tipo: 'cobro', moneda: 'ARS', monto_bruto: '100000', monto_comision: '23500', monto_neto: '76500', venta_order_id: 'ORD-26-abc', caja_nombre: null, venta_id: 42 },
      ],
      pagination: { page: 1, pages: 1, total: 1 },
    }),
    saldosResumen: vi.fn().mockResolvedValue({ saldo_ars: 85500, saldo_usd: 0 }),
    createLiquidacion: vi.fn(),
    createCobroInicial: vi.fn(),
    updateMovimiento: vi.fn().mockResolvedValue({ id: 2 }),
    deleteMovimiento: vi.fn(),
  },
  cajas: { listCajas: vi.fn().mockResolvedValue([
    { id: 9, nombre: 'Caja Pesos', moneda: 'ARS', es_tarjeta: false },
    // Caja USD agregada en TANDA 2 auditoría 2026-06-06 — necesaria para los
    // tests del form de liquidación múltiple con conversión USD.
    { id: 10, nombre: 'Caja Dólares', moneda: 'USD', es_tarjeta: false },
  ]) },
}));

import Tarjetas from './Tarjetas';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider } from '../contexts/PageActionsContext';

const renderT = () => render(
  <ToastProvider><ConfirmProvider><PageActionsProvider><Tarjetas /></PageActionsProvider></ConfirmProvider></ToastProvider>
);

describe('Pantalla Tarjetas de Crédito', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('vista General: KPIs unificados + estado de cuenta', async () => {
    renderT();
    await waitFor(() => expect(screen.getByText('Saldo a tu favor')).toBeInTheDocument());
    expect(screen.getByText('Comisión financiera')).toBeInTheDocument();
    expect(screen.getByText('Ya recibido (liquidado)')).toBeInTheDocument();
    // El cobro automático figura en el estado de cuenta, referenciando la venta
    expect(await screen.findByText(/Venta ORD-26-abc/)).toBeInTheDocument();
  });

  // Tests post-auditoría TANDA 2: cobertura del modal de edición que el agente
  // marcó como HIGH faltante. Validamos la regla central: cobros de venta NO
  // se editan, cobros previos sí.

  it('cobros de venta NO muestran botones de editar/eliminar (regla canEdit)', async () => {
    renderT();
    // Esperar a que cargue el estado de cuenta.
    await screen.findByText(/Venta ORD-26-abc/);
    // Hay 2 movimientos: el de venta (id=1) y el cobro previo (id=2).
    // Solo el cobro previo debería tener botón Editar visible.
    const editButtons = screen.getAllByRole('button', { name: /Editar movimiento/i });
    expect(editButtons.length).toBe(1); // solo el del cobro previo
  });

  it('abre modal de edición pre-cargando datos del cobro previo', async () => {
    renderT();
    // Esperar a que el estado de cuenta cargue (busca el cobro de venta como anchor).
    await screen.findByText(/Venta ORD-26-abc/);
    const user = userEvent.setup();
    const editButtons = screen.getAllByRole('button', { name: /Editar movimiento/i });
    expect(editButtons.length).toBe(1);
    await user.click(editButtons[0]);
    // El modal aparece con título "Editar cobro previo"
    expect(await screen.findByRole('heading', { name: /Editar cobro previo/i })).toBeInTheDocument();
    // El form pre-carga los valores del cobro previo. Los labels del modal no
    // tienen htmlFor formal (patrón del sistema con field-label adjacente),
    // así que usamos getByDisplayValue para verificar valores cargados.
    expect(screen.getByDisplayValue('10000')).toBeInTheDocument();   // monto_bruto
    expect(screen.getByDisplayValue('10')).toBeInTheDocument();      // pct
    expect(screen.getByDisplayValue('Saldo previo')).toBeInTheDocument(); // comentarios
  });
});

// T1 (auditoría 2026-06-06): tests del form de liquidación múltiple con los
// 3 inputs enlazados USD × TC = ARS. Es la pieza más compleja del sprint
// USD×TC=ARS y la que tenía cero coverage frontend. Cubrimos:
//   1. Toggle USD activa la fila de 3 inputs y filtra cajas a USD/USDT.
//   2. Cargar USD + TC autocompleta ARS (USD × TC = ARS).
//   3. Cargar ARS + TC autocompleta USD (ARS / TC = USD).
//   4. Sobreescribir un valor manualmente preserva el descalce (caso del
//      redondeo de la planilla real).
describe('Tarjetas — Liquidación múltiple con 3 inputs USD × TC = ARS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // El toggle "Convertir a USD" persiste en localStorage. Sin limpiar entre
    // tests, el segundo test arranca con el toggle ya activo (del primero) y
    // el `user.click` lo DESACTIVA en vez de activarlo — fricción operativa
    // intencional pero rompe la suposición del test. Limpiar fuerza el state
    // inicial conocido (toggle off).
    localStorage.clear();
  });

  // Helper: la vista "Todas las tarjetas" es el default del Detalle. Navegamos
  // a ella, activamos toggle USD y devolvemos los 3 inputs localizados por
  // label adyacente (los inputs no tienen htmlFor — U4 de la auditoría, fix
  // en TANDA 3). El patrón label→sibling input es estable.
  const inputByLabel = (text) =>
    screen.getByText(text).parentElement.querySelector('input[type="number"]');

  const setupViewWithUSD = async () => {
    renderT();
    await screen.findByText('Saldo a tu favor');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Detalle/i }));
    await screen.findByText(/Registrar liquidación múltiple/i);
    await user.click(screen.getByRole('checkbox', { name: /Convertir a USD/i }));
    return user;
  };

  it('toggle "Convertir a USD" muestra los 3 inputs y filtra cajas a USD', async () => {
    renderT();
    await screen.findByText('Saldo a tu favor');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Detalle/i }));
    await screen.findByText(/Registrar liquidación múltiple/i);
    // Sin toggle: aparece input "Total ARS recibido".
    expect(screen.getByText(/Total ARS recibido/i)).toBeInTheDocument();
    // Activar toggle.
    await user.click(screen.getByRole('checkbox', { name: /Convertir a USD/i }));
    // Aparecen los 3 labels enlazados.
    expect(screen.getByText(/USD recibido \(caja\)/i)).toBeInTheDocument();
    expect(screen.getByText(/TC del día/i)).toBeInTheDocument();
    expect(screen.getByText(/Total ARS \(descuenta del saldo\)/i)).toBeInTheDocument();
    // El select de caja muestra la caja USD, NO la ARS.
    expect(screen.getByRole('option', { name: /Caja Dólares · USD/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Caja Pesos · ARS/i })).not.toBeInTheDocument();
  });

  it('cargar USD + TC autocompleta ARS (USD × TC = ARS)', async () => {
    const user = await setupViewWithUSD();
    const usd = inputByLabel(/USD recibido \(caja\)/i);
    const tc  = inputByLabel(/TC del día/i);
    const ars = inputByLabel(/Total ARS \(descuenta del saldo\)/i);
    await user.type(usd, '500');
    await user.type(tc, '1100');
    expect(ars).toHaveValue(550000);
  });

  it('cargar TC + ARS autocompleta USD (ARS / TC = USD)', async () => {
    const user = await setupViewWithUSD();
    const usd = inputByLabel(/USD recibido \(caja\)/i);
    const tc  = inputByLabel(/TC del día/i);
    const ars = inputByLabel(/Total ARS \(descuenta del saldo\)/i);
    // Orden invertido al primer test: TC primero, ARS después. Este es un
    // escenario válido cuando el operador conoce el TC del comprobante pero
    // todavía no calculó USD por su cuenta. Tipear ARS antes que TC tendría
    // un side-effect intermedio (cada keystroke de TC recalcula USD con TC
    // parcial), por eso evitamos ese orden en el test.
    await user.type(tc, '1100');
    await user.type(ars, '110000');
    expect(usd).toHaveValue(100);
  });

  it('sobreescribir ARS manualmente NO recalcula USD (preserva descalce planilla)', async () => {
    const user = await setupViewWithUSD();
    const usd = inputByLabel(/USD recibido \(caja\)/i);
    const tc  = inputByLabel(/TC del día/i);
    const ars = inputByLabel(/Total ARS \(descuenta del saldo\)/i);
    await user.type(usd, '500');
    await user.type(tc, '1100');
    expect(ars).toHaveValue(550000);
    // Operador edita ARS para reflejar la planilla con redondeo distinto.
    // NO debe recalcular USD — queda en 500. Ese es el caso operativo real.
    await user.clear(ars);
    await user.type(ars, '549999');
    expect(ars).toHaveValue(549999);
    expect(usd).toHaveValue(500);
    expect(tc).toHaveValue(1100);
  });
});
