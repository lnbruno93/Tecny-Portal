// Tests del Modal primitive (Sub-fase B.3 #353).
//
// Cubrimos el contrato visible que los 4 modals de mutations dependen:
//   · open=false → NO renderiza nada (no es solo CSS hidden)
//   · open=true → children montados, title presente
//   · X button cierra
//   · ESC cierra (default) y NO cierra si closeOnEsc=false
//   · Click en backdrop cierra (default) y NO cierra si closeOnBackdrop=false
//   · Click sobre el card NO cierra (stopPropagation)

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Modal from '../Modal.jsx';

describe('Modal', () => {
  it('renderiza children y title cuando open=true', () => {
    render(
      <Modal open onClose={() => {}} title="Mi modal">
        <p>Body text</p>
      </Modal>
    );
    expect(screen.getByText('Mi modal')).toBeInTheDocument();
    expect(screen.getByText('Body text')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('no renderiza nada cuando open=false', () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}} title="Mi modal">
        <p>Body text</p>
      </Modal>
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Body text')).not.toBeInTheDocument();
  });

  it('click en X button dispara onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Test">
        <p>x</p>
      </Modal>
    );
    fireEvent.click(screen.getByRole('button', { name: /cerrar/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ESC dispara onClose (default closeOnEsc=true)', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Test">
        <p>x</p>
      </Modal>
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ESC NO dispara onClose si closeOnEsc=false', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Test" closeOnEsc={false}>
        <p>x</p>
      </Modal>
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('click en backdrop dispara onClose (default closeOnBackdrop=true)', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose} title="Test">
        <p>x</p>
      </Modal>
    );
    const backdrop = container.querySelector('.modal-backdrop');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('click en backdrop NO dispara onClose si closeOnBackdrop=false', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose} title="Test" closeOnBackdrop={false}>
        <p>x</p>
      </Modal>
    );
    const backdrop = container.querySelector('.modal-backdrop');
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('click sobre el card (no backdrop) NO dispara onClose', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose} title="Test">
        <p>contenido</p>
      </Modal>
    );
    // Click directo en el card. El handler del backdrop solo dispara
    // si e.target === e.currentTarget — un click en el card no cumple eso.
    const card = container.querySelector('.modal');
    fireEvent.click(card);
    expect(onClose).not.toHaveBeenCalled();
  });
});
