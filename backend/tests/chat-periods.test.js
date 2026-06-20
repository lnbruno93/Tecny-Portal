/**
 * Tests del helper periodoRange (#340 Fase 2 PR#2).
 *
 * Unit tests sin DB — la lógica es pura, solo manipulación de fechas en
 * timezone ART. Asegura que las tools del bot que comparten este helper
 * resuelvan TODAS al mismo rango cuando el bot dice "hoy" / "esta semana".
 */

const { periodoRange, PERIODOS_VALIDOS } = require('../src/lib/chat-periods');

describe('periodoRange — formato y consistencia', () => {
  it('PERIODOS_VALIDOS contiene los 7 esperados', () => {
    expect(PERIODOS_VALIDOS.sort()).toEqual([
      'anio', 'ayer', 'custom', 'hoy', 'mes', 'mes_anterior', 'semana',
    ]);
  });

  it('todos los presets devuelven { desde, hasta, label } con formato YYYY-MM-DD', () => {
    for (const p of ['hoy', 'ayer', 'semana', 'mes', 'mes_anterior', 'anio']) {
      const r = periodoRange(p);
      expect(r.desde).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.hasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof r.label).toBe('string');
      expect(r.desde <= r.hasta).toBe(true);
    }
  });

  it('"hoy" tiene desde === hasta', () => {
    const r = periodoRange('hoy');
    expect(r.desde).toBe(r.hasta);
  });

  it('"ayer" tiene desde === hasta, y < hoy', () => {
    const ayer = periodoRange('ayer');
    const hoy = periodoRange('hoy');
    expect(ayer.desde).toBe(ayer.hasta);
    expect(ayer.hasta < hoy.desde).toBe(true);
  });

  it('"semana" cubre exactamente 7 días terminando hoy', () => {
    const r = periodoRange('semana');
    const hoy = periodoRange('hoy').hasta;
    expect(r.hasta).toBe(hoy);
    const desdeDate = new Date(`${r.desde}T00:00:00Z`);
    const hastaDate = new Date(`${r.hasta}T00:00:00Z`);
    const diffDias = (hastaDate - desdeDate) / (24 * 60 * 60 * 1000);
    expect(diffDias).toBe(6); // 6 días entre boundaries = 7 días inclusivos
  });

  it('"mes" arranca el día 1 del mes actual', () => {
    const r = periodoRange('mes');
    expect(r.desde.slice(-2)).toBe('01');
    // mismo año-mes que hoy
    expect(r.desde.slice(0, 7)).toBe(periodoRange('hoy').desde.slice(0, 7));
  });

  it('"mes_anterior" arranca día 1 y termina el último día del mes pasado', () => {
    const r = periodoRange('mes_anterior');
    expect(r.desde.slice(-2)).toBe('01');
    // El primero del mes siguiente menos 1 día debe ser r.hasta.
    const hastaDate = new Date(`${r.hasta}T00:00:00Z`);
    const next = new Date(hastaDate.getTime() + 24 * 60 * 60 * 1000);
    expect(next.getUTCDate()).toBe(1);
  });

  it('"anio" arranca el 1 de enero', () => {
    const r = periodoRange('anio');
    expect(r.desde.slice(-5)).toBe('01-01');
  });
});

describe('periodoRange — custom', () => {
  it('respeta desde y hasta del input', () => {
    const r = periodoRange('custom', { desde: '2026-01-15', hasta: '2026-02-10' });
    expect(r.desde).toBe('2026-01-15');
    expect(r.hasta).toBe('2026-02-10');
    expect(r.label).toContain('2026-01-15');
  });

  it('rechaza si falta desde/hasta', () => {
    expect(() => periodoRange('custom')).toThrow(/requiere desde y hasta/);
    expect(() => periodoRange('custom', { desde: '2026-01-01' })).toThrow();
  });

  it('rechaza formato inválido', () => {
    expect(() => periodoRange('custom', { desde: 'ayer', hasta: 'hoy' })).toThrow();
    expect(() => periodoRange('custom', { desde: '2026-13-01', hasta: '2026-12-31' })).toThrow();
    expect(() => periodoRange('custom', { desde: '2026-02-30', hasta: '2026-03-01' })).toThrow();
  });

  it('rechaza desde > hasta', () => {
    expect(() => periodoRange('custom', { desde: '2026-12-01', hasta: '2026-11-01' })).toThrow(/invertido|desde.*>.*hasta/);
  });
});

describe('periodoRange — errores', () => {
  it('rechaza período desconocido con mensaje útil', () => {
    expect(() => periodoRange('semestre')).toThrow(/período inválido/);
    expect(() => periodoRange(undefined)).toThrow(/período inválido/);
    expect(() => periodoRange('')).toThrow();
  });
});
