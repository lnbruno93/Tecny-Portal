// Tests del ExitoModal — modal de "¡Éxito!" post-venta + opción de descargar PDF.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import ExitoModal from './ExitoModal';

function renderExito({ open = true, venta = { id: 1 }, pdfLoading = false } = {}) {
  const onClose = vi.fn();
  const onDescargar = vi.fn();
  const utils = render(
    <ExitoModal
      state={{ open, venta }}
      onClose={onClose}
      onDescargar={onDescargar}
      pdfLoading={pdfLoading}
    />
  );
  return { onClose, onDescargar, ...utils };
}

beforeEach(() => { cleanup(); });

describe('ExitoModal — render condicional', () => {
  it('open=false: no renderiza nada', () => {
    const { container } = render(
      <ExitoModal state={{ open: false }} onClose={vi.fn()} onDescargar={vi.fn()} pdfLoading={false} />
    );
    expect(container.querySelector('.modal')).toBeNull();
  });

  it('open=true: renderiza con role="dialog" aria-modal + heading "¡Éxito!"', () => {
    const { container, getByText } = renderExito();
    const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-labelledby')).toBe('exito-modal-title');
    expect(getByText('¡Éxito!')).toBeTruthy();
    expect(container.textContent).toContain('Venta guardada exitosamente');
  });
});

describe('ExitoModal — acciones', () => {
  it('click "OK" llama onClose', () => {
    const { onClose, getByText } = renderExito();
    fireEvent.click(getByText('OK'));
    expect(onClose).toHaveBeenCalled();
  });

  it('click "Descargar comprobante" llama onDescargar con la venta', () => {
    const venta = { id: 42, total_usd: 100 };
    const { onDescargar, getByText } = renderExito({ venta });
    fireEvent.click(getByText('Descargar comprobante'));
    expect(onDescargar).toHaveBeenCalledWith(venta);
  });

  it('pdfLoading=true: botón deshabilitado y texto "Generando…"', () => {
    const { getByText, onDescargar } = renderExito({ pdfLoading: true });
    const btn = getByText('Generando…');
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn); // no debería disparar
    expect(onDescargar).not.toHaveBeenCalled();
  });

  it('click en overlay (fuera del modal) llama onClose', () => {
    const { container, onClose } = renderExito();
    const overlay = container.querySelector('.modal-overlay');
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it('click en el contenido del modal NO llama onClose (stopPropagation)', () => {
    const { container, onClose } = renderExito();
    const modal = container.querySelector('.modal');
    fireEvent.click(modal);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ExitoModal — #475 reenvío por mail', () => {
  it('venta SIN cliente_email: no muestra "Reenviar por mail"', () => {
    const onReenviarEmail = vi.fn();
    const { queryByText } = render(
      <ExitoModal
        state={{ open: true, venta: { id: 1 } }}
        onClose={vi.fn()}
        onDescargar={vi.fn()}
        pdfLoading={false}
        onReenviarEmail={onReenviarEmail}
      />
    );
    expect(queryByText('Reenviar por mail')).toBeNull();
  });

  it('venta CON cliente_email: muestra el email y el botón "Reenviar por mail"', () => {
    const onReenviarEmail = vi.fn();
    const { getByText, container } = render(
      <ExitoModal
        state={{ open: true, venta: { id: 1, cliente_email: 'cliente@x.com' } }}
        onClose={vi.fn()}
        onDescargar={vi.fn()}
        pdfLoading={false}
        onReenviarEmail={onReenviarEmail}
      />
    );
    expect(container.textContent).toContain('cliente@x.com');
    fireEvent.click(getByText('Reenviar por mail'));
    expect(onReenviarEmail).toHaveBeenCalledWith({ id: 1, cliente_email: 'cliente@x.com' });
  });

  it('venta con email pero SIN handler onReenviarEmail: no muestra el botón', () => {
    const { queryByText } = render(
      <ExitoModal
        state={{ open: true, venta: { id: 1, cliente_email: 'cliente@x.com' } }}
        onClose={vi.fn()}
        onDescargar={vi.fn()}
        pdfLoading={false}
        // sin onReenviarEmail
      />
    );
    expect(queryByText('Reenviar por mail')).toBeNull();
  });
});
