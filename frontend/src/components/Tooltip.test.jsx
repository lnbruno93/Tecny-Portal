import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Tooltip from './Tooltip';

describe('Tooltip', () => {
  it('no muestra el contenido hasta que el trigger recibe foco', () => {
    render(
      <Tooltip content="Ayuda contextual">
        <button>Info</button>
      </Tooltip>
    );
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('aparece en focus con role=tooltip y trigger gana aria-describedby', () => {
    render(
      <Tooltip content="Ayuda contextual">
        <button>Info</button>
      </Tooltip>
    );
    const btn = screen.getByRole('button', { name: 'Info' });
    fireEvent.focus(btn);

    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Ayuda contextual');
    // El aria-describedby debe apuntar al id del tooltip — relación
    // anunciada por lectores de pantalla.
    expect(btn.getAttribute('aria-describedby')).toBe(tip.id);
  });

  it('desaparece en blur y limpia aria-describedby', () => {
    render(
      <Tooltip content="Hola">
        <button>Info</button>
      </Tooltip>
    );
    const btn = screen.getByRole('button', { name: 'Info' });
    fireEvent.focus(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.blur(btn);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(btn.getAttribute('aria-describedby')).toBeNull();
  });

  it('aparece en mouseenter y desaparece en mouseleave del wrapper', () => {
    render(
      <Tooltip content="Hola">
        <button>Info</button>
      </Tooltip>
    );
    const btn = screen.getByRole('button', { name: 'Info' });
    // El wrapper es el padre del button.
    const wrap = btn.parentElement;
    fireEvent.mouseEnter(wrap);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseLeave(wrap);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('Escape cierra el tooltip abierto', () => {
    render(
      <Tooltip content="Hola">
        <button>Info</button>
      </Tooltip>
    );
    const btn = screen.getByRole('button', { name: 'Info' });
    fireEvent.focus(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
