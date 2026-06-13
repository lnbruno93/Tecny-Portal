// Tests para backend/src/lib/storageFlags.js (P-03 Fase 3).
//
// El módulo usa test bypass (NODE_ENV=test) para no tocar Redis ni DB.
// Estos tests verifican que el bypass funciona y que el set/reset de
// overrides hace lo esperado.

const storageFlags = require('../src/lib/storageFlags');

describe('storageFlags', () => {
  afterEach(() => {
    storageFlags._resetTestOverrides();
  });

  describe('FLAGS', () => {
    test('expone los 3 flags soportados', () => {
      expect(storageFlags.FLAGS).toEqual([
        'storage_r2_comprobantes',
        'storage_r2_productos',
        'storage_r2_ventas_comprobantes',
      ]);
    });
  });

  describe('isEnabled', () => {
    test('default OFF para todos los flags', async () => {
      for (const flag of storageFlags.FLAGS) {
        expect(await storageFlags.isEnabled(flag)).toBe(false);
      }
    });

    test('ON cuando se setea explícitamente para test', async () => {
      storageFlags._setEnabledForTest('storage_r2_comprobantes', true);
      expect(await storageFlags.isEnabled('storage_r2_comprobantes')).toBe(true);
    });

    test('cambio de un flag no afecta a los otros', async () => {
      storageFlags._setEnabledForTest('storage_r2_comprobantes', true);
      expect(await storageFlags.isEnabled('storage_r2_comprobantes')).toBe(true);
      expect(await storageFlags.isEnabled('storage_r2_productos')).toBe(false);
      expect(await storageFlags.isEnabled('storage_r2_ventas_comprobantes')).toBe(false);
    });

    test('throwea con flag desconocido', async () => {
      await expect(storageFlags.isEnabled('storage_r2_invented')).rejects.toThrow(
        /flag desconocido/i,
      );
    });

    test('_setEnabledForTest throwea con flag desconocido', () => {
      expect(() => storageFlags._setEnabledForTest('storage_r2_invented', true))
        .toThrow(/flag desconocido/i);
    });

    test('_resetTestOverrides vuelve todos a false', async () => {
      storageFlags._setEnabledForTest('storage_r2_comprobantes', true);
      storageFlags._setEnabledForTest('storage_r2_productos', true);
      storageFlags._resetTestOverrides();
      for (const flag of storageFlags.FLAGS) {
        expect(await storageFlags.isEnabled(flag)).toBe(false);
      }
    });
  });

  describe('invalidate', () => {
    test('no throw con flag conocido (no-op en NODE_ENV=test)', async () => {
      await expect(storageFlags.invalidate('storage_r2_comprobantes')).resolves.not.toThrow();
    });

    test('no throw con flag desconocido (silencioso)', async () => {
      // No tiene sentido throwear acá — el caller puede iterar sobre flags
      // dinámicos sin riesgo de matar el response.
      await expect(storageFlags.invalidate('storage_r2_unknown')).resolves.not.toThrow();
    });
  });
});
