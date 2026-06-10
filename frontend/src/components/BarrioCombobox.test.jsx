import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BarrioCombobox from './BarrioCombobox';

describe('BarrioCombobox', () => {
  it('al hacer focus muestra el dropdown agrupado por zona', () => {
    render(<BarrioCombobox value="" onChange={() => {}} />);
    const input = screen.getByPlaceholderText(/buscar barrio/i);
    fireEvent.focus(input);
    // Headers de zona presentes
    expect(screen.getByText('CABA')).toBeInTheDocument();
    expect(screen.getByText('Zona Norte')).toBeInTheDocument();
    expect(screen.getByText('Zona Sur')).toBeInTheDocument();
    expect(screen.getByText('Zona Este')).toBeInTheDocument();
    expect(screen.getByText('Zona Oeste')).toBeInTheDocument();
    // Y muestra barrios de muestra
    expect(screen.getByText('Palermo')).toBeInTheDocument();
    expect(screen.getByText('La Plata')).toBeInTheDocument();
  });

  it('tipear filtra y respeta diacríticos (núñez → Núñez)', () => {
    const onChange = vi.fn();
    const { rerender } = render(<BarrioCombobox value="" onChange={onChange} />);
    const input = screen.getByPlaceholderText(/buscar barrio/i);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'nunez' } });
    // El onChange refleja lo tipeado (input controlado)
    expect(onChange).toHaveBeenCalledWith('nunez');
    // Renderizar con el nuevo value para forzar el filtro
    rerender(<BarrioCombobox value="nunez" onChange={onChange} />);
    expect(screen.getByText('Núñez')).toBeInTheDocument();
    // Y no muestra barrios sin "nunez"
    expect(screen.queryByText('Palermo')).toBeNull();
  });

  it('click en una opción setea el barrio sin la zona', () => {
    const onChange = vi.fn();
    render(<BarrioCombobox value="" onChange={onChange} />);
    const input = screen.getByPlaceholderText(/buscar barrio/i);
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByText('Vicente López'));
    expect(onChange).toHaveBeenCalledWith('Vicente López');
  });

  it('permite tipear un barrio fuera de la lista (combo libre)', () => {
    const onChange = vi.fn();
    render(<BarrioCombobox value="" onChange={onChange} />);
    const input = screen.getByPlaceholderText(/buscar barrio/i);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Barrio inventado' } });
    expect(onChange).toHaveBeenCalledWith('Barrio inventado');
    // Aunque no haya match, no rompe el componente — onChange ya disparó.
  });

  it('muestra hint de zona cuando el barrio cargado matchea la lista (cerrado)', () => {
    // Forzamos un value preexistente y NO abrimos el dropdown — el hint
    // debería verse debajo del input.
    render(<BarrioCombobox value="Palermo" onChange={() => {}} />);
    expect(screen.getByText(/Zona|CABA/)).toBeInTheDocument();
  });

  it('Escape cierra el dropdown', () => {
    render(<BarrioCombobox value="" onChange={() => {}} />);
    const input = screen.getByPlaceholderText(/buscar barrio/i);
    fireEvent.focus(input);
    expect(screen.getByText('Palermo')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByText('Palermo')).toBeNull();
  });
});
