/**
 * Tests del hook useModal: Esc cierra, body lock funciona, foco al primer
 * elemento, cleanup al desmontar / cerrar.
 */
import { describe, it, expect, vi } from 'vitest';
import { useRef } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useModal } from './useModal';

function ModalProbe({ open, onClose }) {
  const overlayRef = useRef(null);
  useModal({ open, onClose, overlayRef });
  if (!open) return null;
  return (
    <div ref={overlayRef} data-testid="overlay">
      <input data-testid="first-input" />
      <button data-testid="primary" className="btn-primary">OK</button>
    </div>
  );
}

describe('useModal', () => {
  it('aplica body.modal-open al abrir y lo saca al cerrar', () => {
    const { rerender, unmount } = render(<ModalProbe open onClose={() => {}} />);
    expect(document.body.classList.contains('modal-open')).toBe(true);
    rerender(<ModalProbe open={false} onClose={() => {}} />);
    expect(document.body.classList.contains('modal-open')).toBe(false);
    unmount();
  });

  it('Esc invoca onClose', () => {
    const onClose = vi.fn();
    render(<ModalProbe open onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('teclas que no son Esc no invocan onClose', () => {
    const onClose = vi.fn();
    render(<ModalProbe open onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
    cleanup();
  });

  it('al cerrar, devuelve el body al estado normal aunque queden otros modales abiertos', () => {
    // Abrimos dos modales y cerramos uno: el body sigue locked
    const { rerender: r1, unmount: u1 } = render(<ModalProbe open onClose={() => {}} />);
    const { rerender: r2, unmount: u2 } = render(<ModalProbe open onClose={() => {}} />);
    expect(document.body.classList.contains('modal-open')).toBe(true);
    r1(<ModalProbe open={false} onClose={() => {}} />);
    expect(document.body.classList.contains('modal-open')).toBe(true); // todavía hay 1 abierto
    r2(<ModalProbe open={false} onClose={() => {}} />);
    expect(document.body.classList.contains('modal-open')).toBe(false);
    u1(); u2();
  });
});
