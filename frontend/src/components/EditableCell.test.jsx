import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import EditableCell from './EditableCell';

function tableWrap(children) {
  // td requiere estar dentro de <table><tbody><tr>
  return <table><tbody><tr>{children}</tr></tbody></table>;
}

describe('EditableCell — text', () => {
  it('muestra el valor en modo lectura y entra en edición al click', () => {
    const onSave = vi.fn();
    render(tableWrap(<EditableCell value="Hola" type="text" onSave={onSave} />));
    expect(screen.getByText('Hola')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Hola'));
    // Ahora hay un input
    const input = screen.getByDisplayValue('Hola');
    expect(input.tagName).toBe('INPUT');
  });

  it('Enter llama a onSave con el nuevo valor', async () => {
    const onSave = vi.fn().mockResolvedValue();
    render(tableWrap(<EditableCell value="Hola" type="text" onSave={onSave} emptyToNull={false} />));
    fireEvent.click(screen.getByText('Hola'));
    const input = screen.getByDisplayValue('Hola');
    fireEvent.change(input, { target: { value: 'Mundo' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Mundo'));
  });

  it('Esc cancela sin llamar a onSave', () => {
    const onSave = vi.fn();
    render(tableWrap(<EditableCell value="Hola" type="text" onSave={onSave} />));
    fireEvent.click(screen.getByText('Hola'));
    const input = screen.getByDisplayValue('Hola');
    fireEvent.change(input, { target: { value: 'Mundo' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onSave).not.toHaveBeenCalled();
    // Vuelve al valor original
    expect(screen.getByText('Hola')).toBeInTheDocument();
  });

  it('valor sin cambios no llama a onSave (no-op)', async () => {
    const onSave = vi.fn().mockResolvedValue();
    render(tableWrap(<EditableCell value="Hola" type="text" onSave={onSave} emptyToNull={false} />));
    fireEvent.click(screen.getByText('Hola'));
    const input = screen.getByDisplayValue('Hola');
    fireEvent.keyDown(input, { key: 'Enter' });
    // tick para microtask
    await act(async () => {});
    expect(onSave).not.toHaveBeenCalled();
  });

  it('disabled: no entra en modo edición', () => {
    const onSave = vi.fn();
    render(tableWrap(<EditableCell value="Hola" type="text" onSave={onSave} disabled />));
    fireEvent.click(screen.getByText('Hola'));
    expect(screen.queryByDisplayValue('Hola')).toBeNull();
  });
});

describe('EditableCell — number con parse', () => {
  it('parsea el string a número antes de guardar', async () => {
    const onSave = vi.fn().mockResolvedValue();
    render(tableWrap(
      <EditableCell value={100} type="number" onSave={onSave} parse={v => Number(v)} emptyToNull={false} />,
    ));
    fireEvent.click(screen.getByText('100'));
    const input = screen.getByDisplayValue('100');
    fireEvent.change(input, { target: { value: '250' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(250));
  });
});

describe('EditableCell — select', () => {
  it('cambia el valor con select', async () => {
    const onSave = vi.fn().mockResolvedValue();
    render(tableWrap(
      <EditableCell
        value="USD"
        type="select"
        options={[{ value: 'USD', label: 'USD' }, { value: 'ARS', label: 'ARS' }]}
        onSave={onSave}
        emptyToNull={false}
      />,
    ));
    fireEvent.click(screen.getByText('USD'));
    const select = screen.getByDisplayValue('USD');
    expect(select.tagName).toBe('SELECT');
    fireEvent.change(select, { target: { value: 'ARS' } });
    fireEvent.keyDown(select, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('ARS'));
  });
});

describe('EditableCell — combo', () => {
  const options = [
    { value: 1, label: 'iPhone Nuevo' },
    { value: 2, label: 'Fundas' },
    { value: 3, label: 'Cargadores' },
  ];

  it('filtra opciones por query y guarda la seleccionada con Enter', async () => {
    const onSave = vi.fn().mockResolvedValue();
    render(tableWrap(
      <EditableCell
        value={1}
        display={<span>iPhone Nuevo</span>}
        type="combo"
        options={options}
        onSave={onSave}
        parse={v => Number(v)}
      />,
    ));
    fireEvent.click(screen.getByText('iPhone Nuevo'));
    const input = screen.getByPlaceholderText('Buscar…');
    fireEvent.change(input, { target: { value: 'fund' } });
    // Aparece "Fundas" en el dropdown
    expect(screen.getByText('Fundas')).toBeInTheDocument();
    // Enter selecciona el primer match (Fundas)
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(2));
  });

  it('Backspace con input vacío guarda null (limpiar FK)', async () => {
    const onSave = vi.fn().mockResolvedValue();
    render(tableWrap(
      <EditableCell value={1} display={<span>iPhone Nuevo</span>} type="combo" options={options} onSave={onSave} />,
    ));
    fireEvent.click(screen.getByText('iPhone Nuevo'));
    const input = screen.getByPlaceholderText('Buscar…');
    fireEvent.keyDown(input, { key: 'Backspace' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });
});

describe('EditableCell — onSave error', () => {
  it('si onSave rechaza, vuelve a modo lectura con el valor anterior', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('boom'));
    render(tableWrap(
      <EditableCell value="Hola" type="text" onSave={onSave} emptyToNull={false} />,
    ));
    fireEvent.click(screen.getByText('Hola'));
    const input = screen.getByDisplayValue('Hola');
    fireEvent.change(input, { target: { value: 'Mundo' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    // El padre no actualizó el value (porque onSave falló) → se muestra el valor original
    await waitFor(() => expect(screen.getByText('Hola')).toBeInTheDocument());
  });
});
