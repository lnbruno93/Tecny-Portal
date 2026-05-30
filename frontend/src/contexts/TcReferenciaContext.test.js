import { describe, it, expect } from 'vitest';
import { verificarTcContraRef } from './TcReferenciaContext';

// Tests del verificador puro de TC vs referencia. La lógica del negocio:
// si tipeás un TC más bajo que (valor_ref × (1 - tolerancia%)), aparece un
// warning. Tolerance % aplicado SOLO por debajo según política inicial.
// El componente TcWarning consume este resultado.

describe('verificarTcContraRef', () => {
  const tcRefBase = { valor: 1400, tolerancia_pct: 1, alerta_por_debajo: true };

  it('TC tipeado dentro de tolerancia → null (no alerta)', () => {
    // 1400 - 1% = 1386. 1390 está dentro de rango.
    expect(verificarTcContraRef(tcRefBase, 1390)).toBe(null);
  });

  it('TC tipeado exactamente igual al ref → null', () => {
    expect(verificarTcContraRef(tcRefBase, 1400)).toBe(null);
  });

  it('TC tipeado por encima del ref → null (solo alerta por debajo)', () => {
    expect(verificarTcContraRef(tcRefBase, 1500)).toBe(null);
  });

  it('TC tipeado en el borde exacto inferior → null (≥ minPermitido)', () => {
    // 1400 × 0.99 = 1386
    expect(verificarTcContraRef(tcRefBase, 1386)).toBe(null);
  });

  it('TC tipeado 1 unidad debajo del borde → warning', () => {
    const r = verificarTcContraRef(tcRefBase, 1385);
    expect(r).not.toBe(null);
    expect(r.msg).toContain('Chequear Tipo de Cambio');
    expect(r.msg).toContain('1400');
    expect(r.tcRef).toEqual(tcRefBase);
    expect(r.diferencia_pct).toBeCloseTo(1.071, 2);
  });

  it('TC tipeado muy por debajo → warning con % grande', () => {
    const r = verificarTcContraRef(tcRefBase, 700);
    expect(r).not.toBe(null);
    expect(r.diferencia_pct).toBeCloseTo(50.0, 1);
  });

  it('TC tipeado = 0 → null (todavía no tipeó nada)', () => {
    expect(verificarTcContraRef(tcRefBase, 0)).toBe(null);
    expect(verificarTcContraRef(tcRefBase, '')).toBe(null);
  });

  it('TC tipeado negativo → null (inválido, no alertamos)', () => {
    expect(verificarTcContraRef(tcRefBase, -100)).toBe(null);
  });

  it('TC tipeado no numérico → null', () => {
    expect(verificarTcContraRef(tcRefBase, 'abc')).toBe(null);
    expect(verificarTcContraRef(tcRefBase, null)).toBe(null);
    expect(verificarTcContraRef(tcRefBase, undefined)).toBe(null);
  });

  it('tcRef null → null (no hay config)', () => {
    expect(verificarTcContraRef(null, 1000)).toBe(null);
  });

  it('tcRef con alerta_por_debajo=false → null (config desactivada para alerta)', () => {
    const tcRefSin = { ...tcRefBase, alerta_por_debajo: false };
    expect(verificarTcContraRef(tcRefSin, 1000)).toBe(null);
  });

  it('tcRef con valor=0 → null (config incompleta)', () => {
    const tcRefSin = { ...tcRefBase, valor: 0 };
    expect(verificarTcContraRef(tcRefSin, 1000)).toBe(null);
  });

  it('tolerancia_pct=0 → cualquier valor debajo dispara warning', () => {
    const tcRefStrict = { ...tcRefBase, tolerancia_pct: 0 };
    // 1399 está debajo → warning
    expect(verificarTcContraRef(tcRefStrict, 1399)).not.toBe(null);
    // 1400 exacto → null
    expect(verificarTcContraRef(tcRefStrict, 1400)).toBe(null);
  });

  it('tolerancia_pct grande (5%) → más permisivo', () => {
    const tcRefRelajado = { ...tcRefBase, tolerancia_pct: 5 };
    // 1400 × 0.95 = 1330
    expect(verificarTcContraRef(tcRefRelajado, 1340)).toBe(null);
    expect(verificarTcContraRef(tcRefRelajado, 1320)).not.toBe(null);
  });

  it('string numérico funciona (input.value siempre es string)', () => {
    expect(verificarTcContraRef(tcRefBase, '1385')).not.toBe(null);
    expect(verificarTcContraRef(tcRefBase, '1390')).toBe(null);
  });
});
