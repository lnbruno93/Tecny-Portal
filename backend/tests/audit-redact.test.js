const audit = require('../src/lib/audit');
const { redactPII } = audit;

describe('redactPII', () => {
  test('redacta completamente teléfono / dirección / notas', () => {
    const o = redactPII({ telefono: '+541112345678', direccion: 'Calle Falsa 123', notas: 'comentarios', barrio: 'Palermo' });
    expect(o.telefono).toBe('(redactado)');
    expect(o.direccion).toBe('(redactado)');
    expect(o.notas).toBe('(redactado)');
    expect(o.barrio).toBe('(redactado)');
  });

  test('parcializa IMEI manteniendo últimos 4 chars', () => {
    expect(redactPII({ imei: '356938035643809' }).imei).toBe('***3809');
    expect(redactPII({ imei: 'AB' }).imei).toBe('***');
  });

  test('parcializa nombres: "Juan Pérez" → "Juan P."', () => {
    expect(redactPII({ cliente_nombre: 'Juan Pérez' }).cliente_nombre).toBe('Juan P.');
    expect(redactPII({ cliente: 'Madonna' }).cliente).toBe('Madonna');
  });

  test('parcializa email: "lnbruno93@gmail.com" → "lnb***@gmail.com"', () => {
    expect(redactPII({ email: 'lnbruno93@gmail.com' }).email).toBe('lnb***@gmail.com');
  });

  test('elimina passwords/tokens', () => {
    const o = redactPII({ nombre: 'X', password: 'hunter2', token: 'abc', api_key: '...' });
    expect(o.password).toBeUndefined();
    expect(o.token).toBeUndefined();
    expect(o.api_key).toBeUndefined();
    expect(o.nombre).toBe('X');
  });

  test('preserva campos NO sensibles (montos, fechas, estado, ids)', () => {
    const input = { id: 1, total_usd: 1500, fecha: '2026-05-28', estado: 'acreditado', categoria_id: 5 };
    expect(redactPII(input)).toEqual(input);
  });

  test('redacta recursivamente en arrays y nested objects', () => {
    const o = redactPII({ items: [{ imei: '111122223333444', descripcion: 'X' }], cliente: { cliente_nombre: 'María González', telefono: '...' } });
    expect(o.items[0].imei).toBe('***3444');
    expect(o.items[0].descripcion).toBe('X');
    expect(o.cliente.cliente_nombre).toBe('María G.'); // recurre y aplica regla del key del nivel interno
    expect(o.cliente.telefono).toBe('(redactado)');
  });

  test('tolera null/undefined/primitives', () => {
    expect(redactPII(null)).toBeNull();
    expect(redactPII(undefined)).toBeUndefined();
    expect(redactPII('hola')).toBe('hola');
    expect(redactPII(42)).toBe(42);
  });
});

// 2026-07-12 (auditoría TOTAL Plataforma P1-1): borrado `describe('startPurgaJob')`
// junto con las funciones `startPurgaJob` + `purgarAuditLogsViejos` (audit.js).
// La retención de audit_logs vive en auditPartitionsJob (drop de partitions
// enteras) — path canónico. Tests del partition drop en:
//   tests/audit-partitions.test.js (drop_old_audit_partitions)
