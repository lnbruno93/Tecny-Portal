// Tests de la pantalla TcDefaults (Multi-país F4 #470).
//
// Cubrimos los flows críticos:
//   1. Render con 2 rows (AR ARS/USD, UY UYU/USD) — labels + inputs presentes
//   2. Empty state si el backend devuelve { tc_defaults: [] }
//   3. Cambiar el valor habilita el botón Guardar (era disabled por isDirty)
//   4. Click Guardar dispara PATCH con shape correcto + update in-place
//   5. PATCH error → banner de error visible, no actualiza la row

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../../lib/api.js', () => ({
  adminApi: {
    getTcDefaultsPais: vi.fn(),
    updateTcDefaultPais: vi.fn(),
    me: vi.fn(),
  },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: { id: 1, username: 'lucas.bruno', is_super_admin: true },
  }),
  AuthProvider: ({ children }) => children,
}));

import { adminApi } from '../../lib/api.js';
import TcDefaults from '../TcDefaults.jsx';

function renderPage() {
  return render(
    <BrowserRouter>
      <TcDefaults />
    </BrowserRouter>
  );
}

function happyTcDefaults(overrides = {}) {
  return {
    tc_defaults: [
      {
        pais: 'AR',
        par: 'ARS/USD',
        valor: 1400,
        updated_at: '2026-06-29T10:00:00Z',
        updated_by: 1,
        updated_by_username: 'lucas.bruno',
      },
      {
        pais: 'UY',
        par: 'UYU/USD',
        valor: 40,
        updated_at: null,
        updated_by: null,
        updated_by_username: null,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TcDefaults', () => {
  it('renderiza ambas rows (AR + UY) con sus valores', async () => {
    adminApi.getTcDefaultsPais.mockResolvedValue(happyTcDefaults());
    renderPage();

    // Las dos filas aparecen con los labels país + par.
    await waitFor(() => {
      expect(screen.getByText(/🇦🇷 Argentina/)).toBeInTheDocument();
    });
    expect(screen.getByText(/🇺🇾 Uruguay/)).toBeInTheDocument();

    // Inputs con los valores seed (1400 AR, 40 UY).
    const arInput = screen.getByLabelText(/Valor TC default AR ARS\/USD/i);
    const uyInput = screen.getByLabelText(/Valor TC default UY UYU\/USD/i);
    expect(arInput.value).toBe('1400');
    expect(uyInput.value).toBe('40');

    // Botón Guardar deshabilitado en ambas filas (no hay drafts).
    const guardarBtns = screen.getAllByRole('button', { name: /Guardar/i });
    expect(guardarBtns.length).toBe(2);
    guardarBtns.forEach((b) => expect(b).toBeDisabled());
  });

  it('empty state cuando el backend devuelve tc_defaults vacío', async () => {
    adminApi.getTcDefaultsPais.mockResolvedValue({ tc_defaults: [] });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/No hay TC defaults configurados/i)).toBeInTheDocument();
    });
    // No deben renderizarse inputs.
    expect(screen.queryByLabelText(/Valor TC default/i)).toBeNull();
  });

  it('cambiar el valor habilita Guardar y muestra chip "cambios sin guardar"', async () => {
    adminApi.getTcDefaultsPais.mockResolvedValue(happyTcDefaults());
    renderPage();

    const arInput = await screen.findByLabelText(/Valor TC default AR ARS\/USD/i);
    // Antes del cambio, no hay chip dirty.
    expect(screen.queryByText(/cambios sin guardar/i)).toBeNull();

    fireEvent.change(arInput, { target: { value: '1500' } });

    // Aparece el chip dirty.
    expect(screen.getByText(/cambios sin guardar/i)).toBeInTheDocument();
    // El botón Guardar de la row AR (la primera) ya no está disabled.
    // Buscamos por orden: ambos botones existen pero solo el AR está enabled.
    const guardarBtns = screen.getAllByRole('button', { name: /Guardar/i });
    expect(guardarBtns[0]).not.toBeDisabled();
    expect(guardarBtns[1]).toBeDisabled();
  });

  it('Guardar dispara PATCH con shape correcto + actualiza row in-place', async () => {
    adminApi.getTcDefaultsPais.mockResolvedValue(happyTcDefaults());
    // Response del PATCH: backend devuelve la row actualizada + noop:false.
    adminApi.updateTcDefaultPais.mockResolvedValue({
      pais: 'UY',
      par: 'UYU/USD',
      valor: 42,
      updated_at: '2026-06-30T08:00:00Z',
      updated_by: 1,
      noop: false,
    });
    renderPage();

    const uyInput = await screen.findByLabelText(/Valor TC default UY UYU\/USD/i);
    fireEvent.change(uyInput, { target: { value: '42' } });

    // Click Guardar de UY (segundo botón en el DOM por orden de la response).
    const guardarBtns = screen.getAllByRole('button', { name: /Guardar/i });
    fireEvent.click(guardarBtns[1]);

    await waitFor(() => {
      expect(adminApi.updateTcDefaultPais).toHaveBeenCalledTimes(1);
    });
    expect(adminApi.updateTcDefaultPais).toHaveBeenCalledWith({
      pais: 'UY',
      par: 'UYU/USD',
      valor: 42,
    });

    // Banner de éxito visible.
    expect(await screen.findByText(/🇺🇾 Uruguay UYU\/USD actualizado a 42/i)).toBeInTheDocument();
    // El input refleja el valor canonical del backend.
    expect(uyInput.value).toBe('42');
  });

  it('error del PATCH → banner de error + no actualiza la row', async () => {
    adminApi.getTcDefaultsPais.mockResolvedValue(happyTcDefaults());
    adminApi.updateTcDefaultPais.mockRejectedValue(new Error('Backend rechazó: valor fuera de rango'));
    renderPage();

    const arInput = await screen.findByLabelText(/Valor TC default AR ARS\/USD/i);
    fireEvent.change(arInput, { target: { value: '1500' } });

    const guardarBtns = screen.getAllByRole('button', { name: /Guardar/i });
    fireEvent.click(guardarBtns[0]);

    expect(await screen.findByText(/Backend rechazó: valor fuera de rango/i)).toBeInTheDocument();
    // El input sigue mostrando el draft (no se revierte automáticamente).
    expect(arInput.value).toBe('1500');
  });
});
