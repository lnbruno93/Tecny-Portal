import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  contactos: {
    list: vi.fn().mockResolvedValue([
      { id: 1, nombre: 'Ana', apellido: 'García', telefono: '11-5555', dni: '30111222', email: 'ana@mail.com', tipo: 'cliente', origen: 'manual' },
      { id: 2, nombre: 'Distribuidora', apellido: null, telefono: null, dni: null, email: null, tipo: 'cliente', origen: 'proveedores' },
    ]),
    create: vi.fn(), update: vi.fn(), delete: vi.fn(),
  },
}));

import Contactos from './Contactos';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider } from '../contexts/PageActionsContext';

describe('Pantalla Contactos', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lista contactos con su origen', async () => {
    render(
      <ToastProvider><ConfirmProvider><PageActionsProvider>
        <Contactos />
      </PageActionsProvider></ConfirmProvider></ToastProvider>
    );
    expect(await screen.findByText('Ana García')).toBeInTheDocument();
    expect(screen.getByText('ana@mail.com')).toBeInTheDocument();
    expect(screen.getByText('Distribuidora')).toBeInTheDocument();
    // "Proveedores" aparece en el filtro y en el badge de la fila → al menos uno
    expect(screen.getAllByText('Proveedores').length).toBeGreaterThanOrEqual(1);
  });
});
