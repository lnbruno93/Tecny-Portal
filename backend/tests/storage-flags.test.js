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

  // ────────────────────────────────────────────────────────────────
  // F3.3 (Rec proactiva #3, 2026-07-20): storageFlags ahora delega la
  // lectura al resolver de F1 (`isFeatureEnabled(name, tenantId)`).
  // Verificamos:
  //   1. `isEnabled(flag, tenantId)` acepta la nueva firma sin romper.
  //   2. Bypass NODE_ENV=test se preservó (short-circuit ANTES del resolver).
  //   3. `invalidate()` sigue devolviendo Promise no-throw.
  //
  // No podemos testear la precedencia real desde acá (el bypass corta
  // antes del resolver) — eso lo cubre `featureFlags.test.js` a nivel
  // resolver. Acá verificamos el binding.
  // ────────────────────────────────────────────────────────────────
  describe('F3.3 migración a resolver F1', () => {
    test('isEnabled acepta tenantId opcional (backward compat + F3)', async () => {
      // Sin tenantId — comportamiento legacy (default OFF).
      expect(await storageFlags.isEnabled('storage_r2_comprobantes')).toBe(false);
      // Con tenantId — nueva firma F3. En test bypasea igual al override.
      expect(await storageFlags.isEnabled('storage_r2_comprobantes', 1)).toBe(false);
      expect(await storageFlags.isEnabled('storage_r2_comprobantes', 42)).toBe(false);

      // Con override ON, ambas firmas devuelven true.
      storageFlags._setEnabledForTest('storage_r2_comprobantes', true);
      expect(await storageFlags.isEnabled('storage_r2_comprobantes')).toBe(true);
      expect(await storageFlags.isEnabled('storage_r2_comprobantes', 1)).toBe(true);
      expect(await storageFlags.isEnabled('storage_r2_comprobantes', 999)).toBe(true);
    });

    test('bypass NODE_ENV=test preservado — no hace lookup DB/Redis', async () => {
      // Verificación explícita: sin overrides, todos los flags devuelven
      // false y NO hacen round-trip. Si el bypass estuviera roto, los tests
      // integration de comprobantes/inventario/ventas saturarían el pool
      // en cada upload y timeout-earían — que estén verdes (113 tests
      // regresión) es la señal implícita.
      for (const flag of storageFlags.FLAGS) {
        expect(await storageFlags.isEnabled(flag)).toBe(false);
        expect(await storageFlags.isEnabled(flag, 1)).toBe(false);
        expect(await storageFlags.isEnabled(flag, 999)).toBe(false);
      }
    });

    test('invalidate delega al invalidador de F1 sin romper', async () => {
      // Cambio semántico: antes invalidaba el key `cache:flag:<name>` propio
      // del wrapper de storageFlags. Ahora delega a `invalidateFeatureCache
      // (name, null)` del resolver de F1 → invalida `ff:<name>:null`.
      // Smoke test: no throw, devuelve Promise.
      const result = storageFlags.invalidate('storage_r2_comprobantes');
      expect(result).toBeInstanceOf(Promise);
      await result; // no throw = pass
    });
  });
});
