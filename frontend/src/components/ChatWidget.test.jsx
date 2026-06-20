/**
 * Tests del ChatWidget (#340 Fase 1).
 *
 * Cubre:
 *   - No renderea nada si user no está logueado (defensive).
 *   - Render del FAB + abrir modal con click.
 *   - Empty state cuando no hay mensajes.
 *   - Send happy path: createConversation lazy + sendMessage + assistant
 *     msg aparece.
 *   - Disabled send button cuando draft está vacío.
 *   - Enter envía, Shift+Enter no.
 *   - Cierre con ESC.
 *   - Botón "+" resetea state (nueva conversación).
 *   - Error del backend (429) se muestra en error bar.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockCreate = vi.fn();
const mockSend = vi.fn();

vi.mock('../lib/api', () => ({
  chat: {
    createConversation: (...args) => mockCreate(...args),
    sendMessage:        (...args) => mockSend(...args),
  },
}));

let mockUser = { id: 1, username: 'testuser' };
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

import ChatWidget from './ChatWidget';

beforeEach(() => {
  mockCreate.mockReset();
  mockSend.mockReset();
  mockUser = { id: 1, username: 'testuser' };
});

describe('ChatWidget — visibilidad y apertura', () => {
  it('no renderea nada si no hay user logueado', () => {
    mockUser = null;
    const { container } = render(<ChatWidget />);
    expect(container.firstChild).toBeNull();
  });

  it('renderea FAB y abre el modal al clickearlo', async () => {
    const user = userEvent.setup();
    render(<ChatWidget />);
    const fab = screen.getByRole('button', { name: /abrir asistente/i });
    expect(fab).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(fab);
    expect(screen.getByRole('dialog', { name: /asistente tecny/i })).toBeInTheDocument();
    expect(screen.getByText(/preguntame sobre tu negocio/i)).toBeInTheDocument();
  });

  it('cierra con ESC', async () => {
    const user = userEvent.setup();
    render(<ChatWidget />);
    await user.click(screen.getByRole('button', { name: /abrir asistente/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('ChatWidget — envío de mensajes', () => {
  it('envía mensaje: crea conv lazy + llama sendMessage + muestra respuesta', async () => {
    mockCreate.mockResolvedValueOnce({ id: 42, created_at: '2026-06-20T00:00:00Z' });
    mockSend.mockResolvedValueOnce({
      text: 'Hoy vendiste $1.500.',
      content: [{ type: 'text', text: 'Hoy vendiste $1.500.' }],
      model: 'claude-sonnet-4-5',
      tokens: { input: 100, output: 20, cached: 0 },
      tool_calls: 1,
    });

    const user = userEvent.setup();
    render(<ChatWidget />);
    await user.click(screen.getByRole('button', { name: /abrir asistente/i }));

    const textarea = screen.getByRole('textbox', { name: /mensaje al asistente/i });
    await user.type(textarea, '¿Cuánto vendí hoy?');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(42, '¿Cuánto vendí hoy?');
    });

    expect(screen.getByText('¿Cuánto vendí hoy?')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('Hoy vendiste $1.500.')).toBeInTheDocument()
    );
  });

  it('NO crea conv nueva en el segundo mensaje (reusa id)', async () => {
    mockCreate.mockResolvedValueOnce({ id: 7 });
    mockSend.mockResolvedValueOnce({ text: 'R1', content: [], tokens: {}, model: 'm' });
    mockSend.mockResolvedValueOnce({ text: 'R2', content: [], tokens: {}, model: 'm' });

    const user = userEvent.setup();
    render(<ChatWidget />);
    await user.click(screen.getByRole('button', { name: /abrir asistente/i }));

    const textarea = screen.getByRole('textbox', { name: /mensaje al asistente/i });
    await user.type(textarea, 'primero');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByText('R1')).toBeInTheDocument());

    await user.type(textarea, 'segundo');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByText('R2')).toBeInTheDocument());

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenNthCalledWith(1, 7, 'primero');
    expect(mockSend).toHaveBeenNthCalledWith(2, 7, 'segundo');
  });

  it('Shift+Enter inserta newline, NO envía', async () => {
    const user = userEvent.setup();
    render(<ChatWidget />);
    await user.click(screen.getByRole('button', { name: /abrir asistente/i }));
    const textarea = screen.getByRole('textbox', { name: /mensaje al asistente/i });
    await user.type(textarea, 'linea1');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(textarea, 'linea2');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('linea1\nlinea2');
  });

  it('botón Enviar está disabled mientras draft está vacío', async () => {
    const user = userEvent.setup();
    render(<ChatWidget />);
    await user.click(screen.getByRole('button', { name: /abrir asistente/i }));
    const send = screen.getByRole('button', { name: /^enviar$/i });
    expect(send).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: /mensaje al asistente/i }), 'x');
    expect(send).not.toBeDisabled();
  });

  it('muestra error en bar cuando el backend rechaza (rate limit)', async () => {
    mockCreate.mockResolvedValueOnce({ id: 1 });
    const err = new Error('Pasaste el límite de 5 mensajes por minuto.');
    err.status = 429;
    mockSend.mockRejectedValueOnce(err);

    const user = userEvent.setup();
    render(<ChatWidget />);
    await user.click(screen.getByRole('button', { name: /abrir asistente/i }));
    await user.type(screen.getByRole('textbox', { name: /mensaje al asistente/i }), 'hola');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/límite de 5 mensajes/i)
    );
    // El user msg quedó en el hilo con tag "No se envió".
    expect(screen.getByText('hola')).toBeInTheDocument();
    expect(screen.getByText(/no se envió/i)).toBeInTheDocument();
  });
});

describe('ChatWidget — botón Nueva conversación', () => {
  it('resetea state: limpia mensajes y crea conv nueva al próximo envío', async () => {
    mockCreate.mockResolvedValueOnce({ id: 100 }); // primera conv
    mockSend.mockResolvedValueOnce({ text: 'r1', content: [], tokens: {}, model: 'm' });
    mockCreate.mockResolvedValueOnce({ id: 101 }); // segunda conv (post reset)
    mockSend.mockResolvedValueOnce({ text: 'r2', content: [], tokens: {}, model: 'm' });

    const user = userEvent.setup();
    render(<ChatWidget />);
    await user.click(screen.getByRole('button', { name: /abrir asistente/i }));
    await user.type(screen.getByRole('textbox', { name: /mensaje al asistente/i }), 'primero');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByText('r1')).toBeInTheDocument());

    // Click "Nueva conversación"
    await user.click(screen.getByRole('button', { name: /nueva conversación/i }));
    // Ya no se ve el msg viejo ni la respuesta.
    expect(screen.queryByText('primero')).toBeNull();
    expect(screen.queryByText('r1')).toBeNull();
    // Empty state visible de nuevo.
    expect(screen.getByText(/preguntame sobre tu negocio/i)).toBeInTheDocument();

    // Próximo envío crea OTRA conv (id distinto).
    await user.type(screen.getByRole('textbox', { name: /mensaje al asistente/i }), 'segundo');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(2));
    expect(mockSend).toHaveBeenNthCalledWith(2, 101, 'segundo');
  });
});
