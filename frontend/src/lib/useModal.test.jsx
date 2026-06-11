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

  // Regresión: bug operativo reportado tras TANDA 1. Cada keystroke del usuario
  // en un input del modal cambiaba el state del padre → re-render → arrow
  // function `onClose` cambiaba identidad → useEffect re-corría → setTimeout
  // del foco se disparaba de nuevo → cursor saltaba al primer input.
  // Fix: onClose en ref (estable), useEffect solo depende de `open`.
  it('Esc sigue invocando el onClose más reciente aunque haya rerenders (ref interno estable)', () => {
    const onCloseV1 = vi.fn();
    const onCloseV2 = vi.fn();
    const { rerender } = render(<ModalProbe open onClose={onCloseV1} />);
    // Simulamos re-render del padre con un nuevo onClose (lo que pasa cuando
    // el usuario tipea en un input y el state del form cambia).
    rerender(<ModalProbe open onClose={onCloseV2} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    // El último onClose pasado debe ser el que se invoque — no el primero.
    expect(onCloseV1).not.toHaveBeenCalled();
    expect(onCloseV2).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('rerender con onClose distinto NO re-aplica el foco al primer input', async () => {
    // Renderizamos con foco inicial al primer input. Después movemos foco a
    // un input distinto y disparamos un rerender con onClose nuevo. El foco
    // debe quedarse donde estaba, no saltar al primer input.
    function ProbeConDos({ open, onClose }) {
      const overlayRef = useRef(null);
      useModal({ open, onClose, overlayRef });
      if (!open) return null;
      return (
        <div ref={overlayRef} data-testid="overlay">
          <input data-testid="first-input" />
          <input data-testid="second-input" />
        </div>
      );
    }
    const { rerender } = render(<ProbeConDos open onClose={() => {}} />);
    // Esperar el setTimeout(50ms) del foco inicial.
    await new Promise(r => setTimeout(r, 70));
    const second = screen.getByTestId('second-input');
    second.focus();
    expect(document.activeElement).toBe(second);
    // Rerender con onClose distinto (simula state change en padre).
    rerender(<ProbeConDos open onClose={() => {}} />);
    // Esperar más que el timeout del foco — si fuera a saltar, ya saltaría.
    await new Promise(r => setTimeout(r, 70));
    // El foco debe seguir en second, NO haber saltado al first.
    expect(document.activeElement).toBe(second);
    cleanup();
  });

  // U-08 auditoría 2026-06-10: focus trap W3C APG Dialog.
  // Probamos que Tab desde el último elemento cicla al primero y viceversa.
  function TrapProbe({ open, onClose }) {
    const overlayRef = useRef(null);
    useModal({ open, onClose, overlayRef });
    if (!open) return null;
    return (
      <div ref={overlayRef} data-testid="overlay" role="dialog" aria-modal="true">
        <input data-testid="trap-first" />
        <input data-testid="trap-middle" />
        <button data-testid="trap-last">Guardar</button>
      </div>
    );
  }

  it('Tab desde el último elemento del modal cicla al primero (focus trap)', () => {
    render(<TrapProbe open onClose={() => {}} />);
    const last = screen.getByTestId('trap-last');
    const first = screen.getByTestId('trap-first');
    last.focus();
    expect(document.activeElement).toBe(last);
    // Simular Tab. fireEvent dispara el handler de keydown del document,
    // que es donde está nuestra lógica de trap.
    const tabEvent = fireEvent.keyDown(document, { key: 'Tab' });
    // El handler llama preventDefault y mueve foco al primero.
    expect(tabEvent).toBe(false); // preventDefault devuelve false
    expect(document.activeElement).toBe(first);
    cleanup();
  });

  it('Shift+Tab desde el primer elemento cicla al último (focus trap)', () => {
    render(<TrapProbe open onClose={() => {}} />);
    const first = screen.getByTestId('trap-first');
    const last = screen.getByTestId('trap-last');
    first.focus();
    expect(document.activeElement).toBe(first);
    const ev = fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(ev).toBe(false);
    expect(document.activeElement).toBe(last);
    cleanup();
  });

  it('restoreFocus: al cerrar devuelve foco al elemento que abrió el modal', async () => {
    function App({ open, onClose }) {
      const overlayRef = useRef(null);
      useModal({ open, onClose, overlayRef });
      return (
        <>
          <button data-testid="opener">Abrir</button>
          {open && (
            <div ref={overlayRef} data-testid="overlay">
              <input data-testid="modal-input" />
            </div>
          )}
        </>
      );
    }
    const { rerender } = render(<App open={false} onClose={() => {}} />);
    const opener = screen.getByTestId('opener');
    opener.focus();
    expect(document.activeElement).toBe(opener);
    rerender(<App open onClose={() => {}} />);
    // Esperamos al foco inicial automático.
    await new Promise(r => setTimeout(r, 70));
    // Cerramos.
    rerender(<App open={false} onClose={() => {}} />);
    // El cleanup del useEffect debería haber restaurado el foco al opener.
    expect(document.activeElement).toBe(opener);
    cleanup();
  });
});
