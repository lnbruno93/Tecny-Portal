// Tests de las primitivas. Cubrimos el contrato visible (clases CSS que
// el resto de la app espera) y el wiring de eventos onChange — si esto
// se rompe, cualquier pantalla que las use rompe en cascada.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Btn, Badge, Card, Seg, Tabs, Status } from '../index.jsx';

describe('Btn', () => {
  it('renderiza icon + children cuando se pasa icon prop', () => {
    render(<Btn icon="Plus">Crear</Btn>);
    const btn = screen.getByRole('button', { name: /crear/i });
    expect(btn).toBeInTheDocument();
    // El span.ico envuelve el SVG.
    expect(btn.querySelector('.ico svg')).toBeTruthy();
    expect(btn).toHaveTextContent('Crear');
  });

  it('aplica className btn-primary con kind="primary"', () => {
    render(<Btn kind="primary">Guardar</Btn>);
    expect(screen.getByRole('button')).toHaveClass('btn', 'btn-primary');
  });
});

describe('Badge', () => {
  it('aplica className badge-pos con tone="pos"', () => {
    render(<Badge tone="pos">Activa</Badge>);
    expect(screen.getByText('Activa')).toHaveClass('badge', 'badge-pos');
  });

  it('sin tone usa solo la clase badge', () => {
    render(<Badge>Neutral</Badge>);
    const el = screen.getByText('Neutral');
    expect(el).toHaveClass('badge');
    expect(el.className).not.toMatch(/badge-/);
  });
});

describe('Card', () => {
  it('con flush + title renderiza .card-flush y .card-hd', () => {
    const { container } = render(
      <Card flush title="Header">contenido</Card>
    );
    const card = container.querySelector('.card');
    expect(card).toHaveClass('card-flush');
    expect(card.querySelector('.card-hd')).toBeTruthy();
    expect(card.querySelector('.card-hd .card-title')).toHaveTextContent('Header');
  });

  it('sin flush no aplica .card-flush', () => {
    const { container } = render(<Card>hola</Card>);
    const card = container.querySelector('.card');
    expect(card).not.toHaveClass('card-flush');
  });
});

describe('Seg', () => {
  it('clic en opción dispara onChange con el value', () => {
    const onChange = vi.fn();
    render(
      <Seg
        value="a"
        options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('Tabs', () => {
  it('clic en opción dispara onChange con el value', () => {
    const onChange = vi.fn();
    render(
      <Tabs
        value="uno"
        options={['uno', 'dos']}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole('tab', { name: 'dos' }));
    expect(onChange).toHaveBeenCalledWith('dos');
  });
});

describe('Status', () => {
  it('con tone="neg" tiene className s-neg', () => {
    render(<Status tone="neg">Suspendida</Status>);
    expect(screen.getByText('Suspendida')).toHaveClass('status', 's-neg');
  });
});
