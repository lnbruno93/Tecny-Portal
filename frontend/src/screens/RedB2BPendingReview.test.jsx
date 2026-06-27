// Tests de pantalla RedB2BPendingReview (F2 #455).
//
// Cobertura (7 tests):
//   - Render empty state cuando no hay pending
//   - Render con lista de productos pending
//   - Click "Confirmar" llama redB2b.productosPendingReview.confirmNew(id)
//   - Click "Mergear" abre modal con picker de productos
//   - Submit del merge llama mergeInto(sourceId, targetId) y refresca
//   - fetchPendingReviewCount devuelve la cantidad (helper para badge)
//   - fetchPendingReviewCount devuelve 0 si el endpoint falla (best-effort)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', () => ({
  redB2b: {
    productosPendingReview: {
      list:       vi.fn().mockResolvedValue({ pendientes: [] }),
      confirmNew: vi.fn().mockResolvedValue({ ok: true, producto: {} }),
      mergeInto:  vi.fn().mockResolvedValue({ ok: true, stock_added: 3, target_producto: {} }),
    },
  },
  inventario: {
    productos: vi.fn().mockResolvedValue({ items: [
      { id: 101, nombre: 'iPhone 15 Pro - Catálogo', cantidad: 7, imei: 'ABC123' },
      { id: 102, nombre: 'Galaxy S24 - Catálogo', cantidad: 4, imei: 'DEF456' },
    ]}),
  },
}));

import { redB2b, inventario } from '../lib/api';
import RedB2BPendingReview, { fetchPendingReviewCount } from './RedB2BPendingReview';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';

function renderScreen() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <RedB2BPendingReview />
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe('Pantalla RedB2BPendingReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redB2b.productosPendingReview.list.mockResolvedValue({ pendientes: [] });
    inventario.productos.mockResolvedValue({ items: [
      { id: 101, nombre: 'iPhone 15 Pro - Catálogo', cantidad: 7 },
      { id: 102, nombre: 'Galaxy S24 - Catálogo', cantidad: 4 },
    ]});
  });

  it('renderiza empty state cuando no hay productos pendientes', async () => {
    renderScreen();
    expect(await screen.findByText(/Sin productos pendientes/i)).toBeInTheDocument();
  });

  it('renderiza la tabla con productos pending', async () => {
    redB2b.productosPendingReview.list.mockResolvedValue({
      pendientes: [{
        id: 50,
        nombre: 'iPhone 15 Pro 256GB',
        sku: 'IMEI123',
        stock: 5,
        precio: 1000,
        created_at: '2026-06-25T10:00:00Z',
        partner: { id: 7, nombre: 'iPro', slug: 'ipro' },
      }],
    });
    renderScreen();
    expect(await screen.findByText('iPhone 15 Pro 256GB')).toBeInTheDocument();
    expect(screen.getByText('iPro')).toBeInTheDocument();
    expect(screen.getByText('ipro')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirmar/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mergear/i })).toBeInTheDocument();
  });

  it('click "Confirmar" pide confirmación y llama confirmNew(id)', async () => {
    const user = userEvent.setup();
    redB2b.productosPendingReview.list.mockResolvedValue({
      pendientes: [{
        id: 50, nombre: 'Producto Test', stock: 5,
        partner: { id: 1, nombre: 'Partner', slug: 'partner' },
        created_at: '2026-06-25T10:00:00Z',
      }],
    });
    renderScreen();

    const confirmBtn = await screen.findByRole('button', { name: /Confirmar/i });
    await user.click(confirmBtn);

    // El ConfirmProvider abre un dialog — clickeamos el botón autofocus.
    const dialog = await screen.findByRole('dialog');
    const confirmModalBtn = dialog.querySelector('[data-autofocus="true"]');
    expect(confirmModalBtn).toBeTruthy();
    await user.click(confirmModalBtn);

    await waitFor(() => {
      expect(redB2b.productosPendingReview.confirmNew).toHaveBeenCalledWith(50);
    });
  });

  it('click "Mergear" abre modal con picker de productos del catálogo', async () => {
    const user = userEvent.setup();
    redB2b.productosPendingReview.list.mockResolvedValue({
      pendientes: [{
        id: 50, nombre: 'iPhone Pending', stock: 5,
        partner: { id: 1, nombre: 'Partner', slug: 'partner' },
        created_at: '2026-06-25T10:00:00Z',
      }],
    });
    renderScreen();

    const mergeBtn = await screen.findByRole('button', { name: /Mergear/i });
    await user.click(mergeBtn);

    // El modal aparece con título.
    expect(await screen.findByRole('dialog', { name: /Mergear con producto existente/i })).toBeInTheDocument();
    // Picker carga del catálogo.
    await waitFor(() => {
      expect(inventario.productos).toHaveBeenCalled();
    });
    // Vemos los productos del catálogo mockeados.
    expect(await screen.findByText('iPhone 15 Pro - Catálogo')).toBeInTheDocument();
    expect(screen.getByText('Galaxy S24 - Catálogo')).toBeInTheDocument();
  });

  it('submit del merge llama mergeInto y refresca la lista', async () => {
    const user = userEvent.setup();
    redB2b.productosPendingReview.list.mockResolvedValue({
      pendientes: [{
        id: 50, nombre: 'iPhone Pending', stock: 5,
        partner: { id: 1, nombre: 'Partner', slug: 'partner' },
        created_at: '2026-06-25T10:00:00Z',
      }],
    });
    renderScreen();

    const mergeBtn = await screen.findByRole('button', { name: /Mergear/i });
    await user.click(mergeBtn);

    // Esperamos que cargue el picker.
    const targetLabel = await screen.findByText('iPhone 15 Pro - Catálogo');
    // El label contiene el radio — click en el label selecciona el radio.
    const radio = targetLabel.closest('label').querySelector('input[type="radio"]');
    fireEvent.click(radio);

    // Submit del modal — buscamos el botón "Mergear" del modal (es el submit
    // del form, type="submit"). Hay dos botones "Mergear" en pantalla: el de
    // la tabla y el del modal — el del modal queda enabled cuando hay
    // selección. Disambiguamos con getAllByRole y filtramos por type.
    const allMergeBtns = screen.getAllByRole('button', { name: /Mergear/i });
    const submitBtn = allMergeBtns.find((b) => b.getAttribute('type') === 'submit');
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn);

    await waitFor(() => {
      expect(redB2b.productosPendingReview.mergeInto).toHaveBeenCalledWith(50, 101);
    });
    // La lista se refrescó (list llamado 2 veces: initial + post-merge).
    await waitFor(() => {
      expect(redB2b.productosPendingReview.list).toHaveBeenCalledTimes(2);
    });
  });
});

describe('fetchPendingReviewCount (helper para sidebar badge)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('devuelve la cantidad de pending productos', async () => {
    redB2b.productosPendingReview.list.mockResolvedValue({
      pendientes: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
    const n = await fetchPendingReviewCount();
    expect(n).toBe(3);
  });

  it('devuelve 0 si el endpoint falla (best-effort)', async () => {
    redB2b.productosPendingReview.list.mockRejectedValue(new Error('403'));
    const n = await fetchPendingReviewCount();
    expect(n).toBe(0);
  });
});
