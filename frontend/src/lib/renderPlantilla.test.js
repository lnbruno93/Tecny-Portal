import { describe, it, expect } from 'vitest';
import { renderPlantilla, PLACEHOLDER_NEGOCIO } from './renderPlantilla';

describe('renderPlantilla — sustitución de {{negocio}} por tenant.nombre', () => {
  it('reemplaza {{negocio}} por el nombre del tenant', () => {
    expect(renderPlantilla('Vendido por {{negocio}}.', 'Tek Haus'))
      .toBe('Vendido por Tek Haus.');
  });

  it('reemplaza múltiples ocurrencias de {{negocio}}', () => {
    expect(renderPlantilla('{{negocio}} · Somos {{negocio}}', 'Celnyx'))
      .toBe('Celnyx · Somos Celnyx');
  });

  it('reemplaza al final del texto (caso principal de las plantillas backfilleadas)', () => {
    const texto = 'Este comprobante es tu nota de compra.\n\nNos responsabilizamos por 12 meses.\n\n{{negocio}} | Tech Reseller';
    expect(renderPlantilla(texto, 'Tek Haus'))
      .toBe('Este comprobante es tu nota de compra.\n\nNos responsabilizamos por 12 meses.\n\nTek Haus | Tech Reseller');
  });

  it('fallback a "Tecny" cuando el tenant no tiene nombre', () => {
    expect(renderPlantilla('Vendido por {{negocio}}.', ''))
      .toBe('Vendido por Tecny.');
    expect(renderPlantilla('Vendido por {{negocio}}.', null))
      .toBe('Vendido por Tecny.');
    expect(renderPlantilla('Vendido por {{negocio}}.', undefined))
      .toBe('Vendido por Tecny.');
  });

  it('trimea whitespace del nombre del tenant antes de usarlo', () => {
    expect(renderPlantilla('Vendido por {{negocio}}.', '   Tek Haus   '))
      .toBe('Vendido por Tek Haus.');
  });

  it('idempotente si el texto no tiene placeholder — devuelve el string tal cual', () => {
    const texto = 'Este comprobante es tu nota de compra.\n\nNos responsabilizamos por 12 meses.';
    expect(renderPlantilla(texto, 'Tek Haus')).toBe(texto);
  });

  it('safe con texto null/undefined — devuelve string vacío', () => {
    expect(renderPlantilla(null, 'Tek Haus')).toBe('');
    expect(renderPlantilla(undefined, 'Tek Haus')).toBe('');
  });

  it('no interpreta el nombre del tenant como regex ($1, $&, etc.)', () => {
    // Si un tenant tiene un nombre con caracteres que en regex.replace
    // significan grupos de captura, split/join evita el problema.
    expect(renderPlantilla('Marca: {{negocio}}', '$1 & $&'))
      .toBe('Marca: $1 & $&');
  });

  it('acepta nombre con caracteres especiales', () => {
    expect(renderPlantilla('{{negocio}}', 'Tek Haus · Ltda.'))
      .toBe('Tek Haus · Ltda.');
  });

  it('constante PLACEHOLDER_NEGOCIO expuesta para uso en otros módulos', () => {
    expect(PLACEHOLDER_NEGOCIO).toBe('{{negocio}}');
  });
});
