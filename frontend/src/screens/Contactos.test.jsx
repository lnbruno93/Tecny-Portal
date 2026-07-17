import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listMock = vi.fn();
vi.mock('../lib/api', () => ({
  contactos: {
    list: (...args) => listMock(...args),
    create: vi.fn(), update: vi.fn(), delete: vi.fn(),
  },
}));

import Contactos from './Contactos';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider } from '../contexts/PageActionsContext';

const FIXTURE = [
  { id: 1, nombre: 'Ana', apellido: 'García', telefono: '11-5555', dni: '30111222', email: 'ana@mail.com', tipo: 'cliente', origen: 'manual' },
  { id: 2, nombre: 'Distribuidora', apellido: null, telefono: null, dni: null, email: null, tipo: 'cliente', origen: 'proveedores' },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider><ConfirmProvider><PageActionsProvider>
        <Contactos />
      </PageActionsProvider></ConfirmProvider></ToastProvider>
    </MemoryRouter>
  );
}

describe('Pantalla Contactos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockReset();
    listMock.mockResolvedValue(FIXTURE);
  });

  it('lista contactos con su origen', async () => {
    renderPage();
    expect(await screen.findByText('Ana García')).toBeInTheDocument();
    expect(screen.getByText('ana@mail.com')).toBeInTheDocument();
    expect(screen.getByText('Distribuidora')).toBeInTheDocument();
    // "Proveedores" aparece en el filtro y en el badge de la fila → al menos uno
    expect(screen.getAllByText('Proveedores').length).toBeGreaterThanOrEqual(1);
  });

  // 2026-07-16 (task #144 UX A): empty state diferenciado — nunca cargaste
  // vs filtros que no matchean. Cambio de comportamiento visible al user.
  it('empty state "todavía no cargaste contactos" muestra botón Nuevo contacto', async () => {
    listMock.mockResolvedValueOnce([]);
    renderPage();
    expect(await screen.findByText(/Todavía no cargaste contactos/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nuevo contacto/ })).toBeInTheDocument();
  });
});
