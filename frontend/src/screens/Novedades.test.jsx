// Tests de la pantalla Novedades (task #142, 2026-07-16).
//
// Cubre:
//   · Loading → contenido (list + count-unseen).
//   · Empty state (sin notas).
//   · Filtros por tipo (Todas / Feature / Mejora / Fix) actualizan la lista.
//   · Cards no vistas tienen el "punto azul" (aria-label="Nueva").
//   · mark-seen se dispara automáticamente al montar (side-effect).
//   · El evento window `release-notes:marked-seen` se emite (para que el
//     Shell apague el badge sin esperar al próximo poll).
//   · Si mark-seen falla, la pantalla NO rompe (best-effort).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/api', () => ({
  releaseNotes: {
    list: vi.fn(),
    countUnseen: vi.fn(),
    markSeen: vi.fn(),
  },
}));

import { releaseNotes as releaseNotesApi } from '../lib/api';
import Novedades from './Novedades';

// Fecha base: 2026-07-16 (misma que otros tests del sprint).
const HOY = '2026-07-16T15:00:00Z';

const NOTAS_FIXTURE = [
  {
    id: 'a1',
    titulo: 'Fix: canje en comprobantes',
    descripcion: 'Ahora el canje se suma al total y aparece en su sección.',
    tipo: 'fix',
    publicado_en: '2026-07-16T15:30:00Z', // HOY (más reciente)
  },
  {
    id: 'a2',
    titulo: 'Mejora: actividad reciente en español',
    descripcion: 'Se lee "Se cambió X" en lugar del JSON crudo.',
    tipo: 'mejora',
    publicado_en: '2026-07-16T11:20:00Z', // HOY
  },
  {
    id: 'a3',
    titulo: 'Feature: Cambios de Divisa dirección inversa',
    descripcion: 'Podés entregar USD y recibir ARS/UYU con el flow correcto.',
    tipo: 'feature',
    publicado_en: '2026-07-15T16:45:00Z', // AYER
  },
  {
    id: 'a4',
    titulo: 'Feature: búsqueda global (Cmd+K)',
    descripcion: 'Buscá productos, ventas, clientes desde cualquier pantalla.',
    tipo: 'feature',
    publicado_en: '2026-07-13T10:00:00Z', // Anteriores
  },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <Novedades />
    </MemoryRouter>
  );
}

describe('Pantalla Novedades', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Fijar la fecha para que el grouping HOY/AYER sea determinístico.
    // `toFake: ['Date']` = solo mockeamos Date (no setTimeout / microtasks),
    // así waitFor / async assertions siguen funcionando normal.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(HOY));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('loading → renderiza título + tabs + lista completa', async () => {
    releaseNotesApi.countUnseen.mockResolvedValue({ count: 2 });
    releaseNotesApi.list.mockResolvedValue({ release_notes: NOTAS_FIXTURE });
    releaseNotesApi.markSeen.mockResolvedValue({ ok: true });

    renderPage();
    expect(screen.getByText(/Cargando…/)).toBeInTheDocument();

    // El heading Novedades aparece incluso durante el loading state porque
    // vive fuera del switch de estados.
    expect(screen.getByRole('heading', { name: /Novedades/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Fix: canje en comprobantes')).toBeInTheDocument();
    });
    // Las 4 notas presentes
    expect(screen.getByText(/actividad reciente en español/)).toBeInTheDocument();
    expect(screen.getByText(/Cambios de Divisa dirección inversa/)).toBeInTheDocument();
    expect(screen.getByText(/búsqueda global \(Cmd\+K\)/)).toBeInTheDocument();
  });

  it('muestra "2 nuevas" y punta el dot en las 2 más recientes', async () => {
    releaseNotesApi.countUnseen.mockResolvedValue({ count: 2 });
    releaseNotesApi.list.mockResolvedValue({ release_notes: NOTAS_FIXTURE });
    releaseNotesApi.markSeen.mockResolvedValue({ ok: true });

    renderPage();
    await waitFor(() => screen.getByText('Fix: canje en comprobantes'));

    // El pill "2 nuevas" en el header
    expect(screen.getByText(/2 nuevas/)).toBeInTheDocument();

    // Solo las 2 primeras tienen el dot "Nueva" (aria-label).
    const dots = screen.getAllByLabelText('Nueva');
    expect(dots).toHaveLength(2);
  });

  it('llama a mark-seen y emite el evento cuando hay unseen', async () => {
    releaseNotesApi.countUnseen.mockResolvedValue({ count: 2 });
    releaseNotesApi.list.mockResolvedValue({ release_notes: NOTAS_FIXTURE });
    releaseNotesApi.markSeen.mockResolvedValue({ ok: true });
    const evtSpy = vi.fn();
    window.addEventListener('release-notes:marked-seen', evtSpy);

    renderPage();
    await waitFor(() => expect(releaseNotesApi.markSeen).toHaveBeenCalled());
    expect(evtSpy).toHaveBeenCalledTimes(1);

    window.removeEventListener('release-notes:marked-seen', evtSpy);
  });

  it('NO llama a mark-seen si count-unseen es 0 (evita ruido)', async () => {
    releaseNotesApi.countUnseen.mockResolvedValue({ count: 0 });
    releaseNotesApi.list.mockResolvedValue({ release_notes: NOTAS_FIXTURE });

    renderPage();
    await waitFor(() => screen.getByText('Fix: canje en comprobantes'));

    expect(releaseNotesApi.markSeen).not.toHaveBeenCalled();
    // El pill "N nuevas" tampoco aparece.
    expect(screen.queryByText(/nuevas?$/)).not.toBeInTheDocument();
  });

  it('best-effort: si mark-seen tira 500, la pantalla igual funciona', async () => {
    releaseNotesApi.countUnseen.mockResolvedValue({ count: 1 });
    releaseNotesApi.list.mockResolvedValue({ release_notes: NOTAS_FIXTURE });
    releaseNotesApi.markSeen.mockRejectedValue(new Error('boom'));

    renderPage();
    await waitFor(() => screen.getByText('Fix: canje en comprobantes'));

    // La lista se renderizó y el error no burbujeó. Punto — no rompe.
    expect(screen.getByText(/1 nueva/)).toBeInTheDocument();
  });

  it('filtro por tipo: click en "Fixes" oculta las que no son fix', async () => {
    releaseNotesApi.countUnseen.mockResolvedValue({ count: 0 });
    releaseNotesApi.list.mockResolvedValue({ release_notes: NOTAS_FIXTURE });

    renderPage();
    await waitFor(() => screen.getByText('Fix: canje en comprobantes'));

    // Click en el tab "Fixes"
    fireEvent.click(screen.getByRole('tab', { name: /Fixes/ }));

    // La fix se queda, las otras 3 se van.
    expect(screen.getByText('Fix: canje en comprobantes')).toBeInTheDocument();
    expect(screen.queryByText(/actividad reciente en español/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cambios de Divisa/)).not.toBeInTheDocument();
  });

  it('empty state cuando el backend devuelve lista vacía', async () => {
    releaseNotesApi.countUnseen.mockResolvedValue({ count: 0 });
    releaseNotesApi.list.mockResolvedValue({ release_notes: [] });

    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Todavía no hay novedades/)).toBeInTheDocument();
    });
  });

  it('empty state filtrado: "No hay fixs publicados" cuando el filtro no matchea', async () => {
    releaseNotesApi.countUnseen.mockResolvedValue({ count: 0 });
    releaseNotesApi.list.mockResolvedValue({
      release_notes: [NOTAS_FIXTURE[2]], // solo una feature
    });

    renderPage();
    await waitFor(() => screen.getByText(/Cambios de Divisa/));

    fireEvent.click(screen.getByRole('tab', { name: /Fixes/ }));
    expect(screen.getByText(/No hay fixs publicados/i)).toBeInTheDocument();
  });

  it('agrupa por día humano: HOY / AYER / <fecha>', async () => {
    releaseNotesApi.countUnseen.mockResolvedValue({ count: 0 });
    releaseNotesApi.list.mockResolvedValue({ release_notes: NOTAS_FIXTURE });

    renderPage();
    await waitFor(() => screen.getByText('Fix: canje en comprobantes'));

    expect(screen.getByText('Hoy')).toBeInTheDocument();
    expect(screen.getByText('Ayer')).toBeInTheDocument();
    // La nota del 13 jul no cae en Hoy/Ayer → tiene su propia sección con fecha.
    // Devuelve algo tipo "13 jul 2026" (la localización puede variar el separador,
    // por eso match parcial).
    expect(screen.getByText(/13 jul/i)).toBeInTheDocument();
  });

  it('muestra error amigable si el list falla', async () => {
    releaseNotesApi.countUnseen.mockResolvedValue({ count: 0 });
    releaseNotesApi.list.mockRejectedValue(new Error('Timeout'));

    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Timeout')).toBeInTheDocument();
    });
  });
});
