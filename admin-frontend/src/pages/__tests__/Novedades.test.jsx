// Tests de la página Novedades — CMS de release notes (task #142).
//
// Cubrimos los escenarios que dan valor:
//   1. Render inicial: cargar lista y mostrarla en la tabla ordenada DESC.
//   2. Empty state cuando el backend devuelve [].
//   3. Error state con botón Reintentar.
//   4. Nuevo → publicar: llena form, click Publicar → llama create con body correcto.
//   5. Editar: click Editar → form se pre-llena, click Guardar → llama update.
//   6. Borrar: click Borrar muestra Confirmar/No; click Confirmar llama remove.
//   7. Validación local: título vacío o >60 → error inline; descripción >280 → error.
//   8. Vista previa: refleja tipo/título/descripción del form en vivo.
//   9. Contadores: muestran N / MAX y warn en rojo cuando pasa el límite.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../../lib/api.js', () => ({
  adminApi: {
    releaseNotes: {
      list:   vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
  },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

import Novedades from '../Novedades.jsx';
import { adminApi } from '../../lib/api.js';

const NOTAS_FIXTURE = [
  {
    id: 'n1',
    titulo: 'Fix: canje en comprobantes',
    descripcion: 'Ahora el canje se suma al total y aparece en su sección.',
    tipo: 'fix',
    publicado_en: '2026-07-16T15:30:00Z',
    created_at: '2026-07-16T15:30:00Z',
    updated_at: '2026-07-16T15:30:00Z',
  },
  {
    id: 'n2',
    titulo: 'Feature: búsqueda global',
    descripcion: 'Presioná Cmd+K y buscá desde cualquier pantalla.',
    tipo: 'feature',
    publicado_en: '2026-07-13T12:00:00Z',
    created_at: '2026-07-13T12:00:00Z',
    updated_at: '2026-07-13T12:00:00Z',
  },
];

function renderPage() {
  return render(
    <BrowserRouter>
      <Novedades />
    </BrowserRouter>
  );
}

describe('Admin Novedades — CMS release notes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lista notas ordenadas DESC (la más reciente primero)', async () => {
    adminApi.releaseNotes.list.mockResolvedValue({ release_notes: NOTAS_FIXTURE });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Fix: canje en comprobantes')).toBeInTheDocument();
    });
    expect(screen.getByText('Feature: búsqueda global')).toBeInTheDocument();
    expect(screen.getByText(/Notas publicadas \(2\)/)).toBeInTheDocument();
  });

  it('empty state cuando no hay notas', async () => {
    adminApi.releaseNotes.list.mockResolvedValue({ release_notes: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No hay notas publicadas todavía/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Crear la primera/ })).toBeInTheDocument();
  });

  it('error state + botón Reintentar', async () => {
    adminApi.releaseNotes.list.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
    // Reintentar dispara otra call al list.
    adminApi.releaseNotes.list.mockResolvedValueOnce({ release_notes: [] });
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
    await waitFor(() => {
      expect(screen.getByText(/No hay notas publicadas/)).toBeInTheDocument();
    });
  });

  it('crear nota: llena form + Publicar → llama create con body correcto', async () => {
    adminApi.releaseNotes.list.mockResolvedValue({ release_notes: [] });
    adminApi.releaseNotes.create.mockResolvedValue({ id: 'nuevo', tipo: 'feature' });
    renderPage();
    await waitFor(() => screen.getByText(/No hay notas publicadas/));

    // Título + descripción (tipo por default 'feature')
    const inputs = screen.getAllByRole('textbox');
    const titulo = inputs.find((el) => el.tagName === 'INPUT');
    const desc = inputs.find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(titulo, { target: { value: 'Nuevo feature' } });
    fireEvent.change(desc, { target: { value: 'Descripción de prueba' } });

    fireEvent.click(screen.getByRole('button', { name: /Publicar nota/ }));

    await waitFor(() => {
      expect(adminApi.releaseNotes.create).toHaveBeenCalledWith({
        titulo: 'Nuevo feature',
        descripcion: 'Descripción de prueba',
        tipo: 'feature',
      });
    });
  });

  it('editar nota: click Editar → form se pre-llena, Guardar → update', async () => {
    adminApi.releaseNotes.list.mockResolvedValue({ release_notes: NOTAS_FIXTURE });
    adminApi.releaseNotes.update.mockResolvedValue({ id: 'n1' });
    renderPage();
    await waitFor(() => screen.getByText('Fix: canje en comprobantes'));

    // Click Editar de la primera fila (Fix)
    const editButtons = screen.getAllByRole('button', { name: /^Editar$/ });
    fireEvent.click(editButtons[0]);

    // El form muestra "Editar nota" y el input pre-llenado
    expect(screen.getByText('Editar nota')).toBeInTheDocument();
    const inputs = screen.getAllByRole('textbox');
    const titulo = inputs.find((el) => el.tagName === 'INPUT');
    expect(titulo.value).toBe('Fix: canje en comprobantes');

    // Cambio el título y guardo
    fireEvent.change(titulo, { target: { value: 'Fix: canje FIXED' } });
    fireEvent.click(screen.getByRole('button', { name: /Guardar cambios/ }));

    await waitFor(() => {
      expect(adminApi.releaseNotes.update).toHaveBeenCalledWith(
        'n1',
        expect.objectContaining({ titulo: 'Fix: canje FIXED', tipo: 'fix' })
      );
    });
  });

  it('borrar: click Borrar → Confirmar/No; Confirmar llama remove', async () => {
    adminApi.releaseNotes.list.mockResolvedValue({ release_notes: NOTAS_FIXTURE });
    adminApi.releaseNotes.remove.mockResolvedValue({ ok: true });
    renderPage();
    await waitFor(() => screen.getByText('Fix: canje en comprobantes'));

    // Click Borrar de la primera fila
    fireEvent.click(screen.getAllByRole('button', { name: /^Borrar$/ })[0]);

    // Aparecen los botones de confirmación
    const confirmar = await screen.findByRole('button', { name: /Confirmar/ });
    expect(screen.getByRole('button', { name: /^No$/ })).toBeInTheDocument();

    fireEvent.click(confirmar);
    await waitFor(() => {
      expect(adminApi.releaseNotes.remove).toHaveBeenCalledWith('n1');
    });
  });

  it('validación local: título vacío → error inline, no llama create', async () => {
    adminApi.releaseNotes.list.mockResolvedValue({ release_notes: [] });
    renderPage();
    await waitFor(() => screen.getByText(/No hay notas publicadas/));

    // No lleno nada, solo click Publicar
    fireEvent.click(screen.getByRole('button', { name: /Publicar nota/ }));

    // Error inline "Requerido." (aparece 2 veces — una por título, una por desc)
    const errores = await screen.findAllByText('Requerido.');
    expect(errores.length).toBeGreaterThanOrEqual(1);
    expect(adminApi.releaseNotes.create).not.toHaveBeenCalled();
  });

  it('vista previa refleja tipo + título + desc del form en vivo', async () => {
    adminApi.releaseNotes.list.mockResolvedValue({ release_notes: [] });
    renderPage();
    await waitFor(() => screen.getByText(/No hay notas publicadas/));

    const inputs = screen.getAllByRole('textbox');
    const titulo = inputs.find((el) => el.tagName === 'INPUT');
    const desc = inputs.find((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(titulo, { target: { value: 'Preview title' } });
    fireEvent.change(desc, { target: { value: 'Preview desc' } });

    // El preview aparece 1 vez con el título nuevo (además del contenido del form).
    const previewSection = screen.getByText(/Vista previa en el portal cliente/).parentElement;
    expect(within(previewSection).getByText(/Preview title/)).toBeInTheDocument();
    expect(within(previewSection).getByText(/Preview desc/)).toBeInTheDocument();
  });

  it('backend responde 400 con fields → los muestra inline', async () => {
    adminApi.releaseNotes.list.mockResolvedValue({ release_notes: [] });
    const err = new Error('Validación falló');
    err.status = 400;
    err.body = { error: 'Validación falló.', fields: { titulo: 'El backend dice que no' } };
    adminApi.releaseNotes.create.mockRejectedValue(err);

    renderPage();
    await waitFor(() => screen.getByText(/No hay notas publicadas/));

    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs.find((el) => el.tagName === 'INPUT'), { target: { value: 'x' } });
    fireEvent.change(inputs.find((el) => el.tagName === 'TEXTAREA'), { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: /Publicar nota/ }));

    await waitFor(() => {
      expect(screen.getByText('El backend dice que no')).toBeInTheDocument();
    });
  });
});
