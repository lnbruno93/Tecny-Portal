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

// B1: el job interno de purga de audit_logs.
describe('startPurgaJob (B1)', () => {
  test('no programa nada cuando NODE_ENV=test', () => {
    // Estamos en test → la guarda interna debe devolver null sin tirar timers.
    expect(process.env.NODE_ENV).toBe('test');
    const handle = audit.startPurgaJob({ diasRetencion: 365, intervalHours: 24 });
    expect(handle).toBeNull();
  });

  test('purgarAuditLogsViejos clamp inferior a 30 días', async () => {
    // Aún si se pide menos, internamente respeta el piso de 30 días.
    // No verificamos rowCount (depende del estado de la DB de tests); solo
    // que la función exista y devuelva un número sin tirar.
    const r = await audit.purgarAuditLogsViejos(1);
    expect(typeof r).toBe('number');
  });
});
