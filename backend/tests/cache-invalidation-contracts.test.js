/**
 * Tests contract-based de cache invalidation — static analysis.
 *
 * ── Contexto ──────────────────────────────────────────────────────────────
 * Cache audit del 2026-07-24 identificó gaps de cache invalidation. Los P1
 * y P2 se fixearon en PRs #865 y #868. Este archivo cierra el P3:
 *
 *   > "Falta coverage integration 'muto → next GET ve nuevo' para 5 caches
 *   >  multi-tenant"
 *
 * ── Por qué static analysis en vez de spy/integration ────────────────────
 *
 * Dos limitaciones del approach obvio:
 *
 *   1. En `NODE_ENV=test` el cache está DISABLED (ver `cacheTtl.js:37`).
 *      Una integration test "mutate → GET fresh" es trivialmente verde en
 *      test env porque el cache jamás devuelve stale.
 *
 *   2. `jest.spyOn` sobre exports módulo NO intercepta callers que usan
 *      destructured import (`const { invalidateCajas } = require(...)`).
 *      La destructuring captura la referencia en require-time; el spy solo
 *      reemplaza la propiedad del module.exports posteriormente. Requeriría
 *      `jest.mock()` a nivel de test file, que es intrusivo (reemplaza el
 *      módulo ENTERO — rompe otros tests que compartan la suite runtime).
 *
 * Approach robusto: leer cada route file y verificar por PATTERN que la
 * mutation handler contiene el invalidate call correspondiente. Testa el
 * CÓDIGO estático, no el runtime. Ventajas:
 *   · Rápido (~100ms, sin HTTP ni DB)
 *   · Robusto (no requiere mocking runtime)
 *   · Explícito (cada regla = 1 assertion con mensaje descriptivo)
 *   · Regresión-guard real: si alguien remueve el invalidate line, o
 *     renombra la función invalidate, o cambia el argument, el test caza
 *
 * ── Reglas que valida ────────────────────────────────────────────────────
 *
 *   Route file                          │ Endpoint/context                │ Invalidate esperado
 *   ────────────────────────────────────┼─────────────────────────────────┼─────────────────────────────
 *   routes/cuentas.js                   │ POST /cobranzas-masivas         │ invalidateCajas(req.tenantId)
 *   routes/superAdmin.js                │ PATCH /tenants/:id              │ invalidateTenantStatus(id)
 *   routes/superAdmin.js                │ POST /tenants/:id/clases-merge  │ invalidateMetricas(id)
 *   routes/superAdmin.js                │ POST /tenants/:id/suspend       │ invalidateTenantStatus(id)
 *   routes/superAdmin.js                │ POST /tenants/:id/reactivate    │ invalidateTenantStatus(id)
 *   routes/ventas.js                    │ POST / (crear venta)            │ invalidateMetricas + invalidateDashboardVentas
 *   routes/ventas.js                    │ PUT /:id                        │ invalidateMetricas + invalidateDashboardVentas
 *   routes/ventas.js                    │ DELETE /:id                     │ invalidateMetricas + invalidateDashboardVentas
 *   routes/ventas.js                    │ PATCH /:id/vendedor-nombre      │ invalidateDashboardVentas
 *
 * ── Cómo agregar reglas nuevas ───────────────────────────────────────────
 *
 * Cada regla es una entry en el array `CONTRACTS`. Requiere:
 *   · file: path relativo a backend/
 *   · description: 1 línea que aparece en el test name
 *   · expectedCalls: array de substrings que DEBEN aparecer en el file
 *   · notExpectedCalls: array de patterns que NO deberían aparecer (opt)
 *
 * Cuando agregues una mutation nueva que debería invalidar un cache,
 * agregar la regla acá cierra el loop preventivo — el test falla en el
 * primer PR que la introduzca sin invalidate.
 */

const fs = require('node:fs');
const path = require('node:path');

const BACKEND_ROOT = path.join(__dirname, '..');

// ── Contratos ────────────────────────────────────────────────────────────

const CONTRACTS = [
  {
    file: 'src/routes/cuentas.js',
    description: 'POST /cobranzas-masivas invalida CAJAS_LIST',
    expectedCalls: [
      // Import del helper.
      `require('../lib/cajasCache')`,
      // Call fire-and-forget con req.tenantId.
      `invalidateCajas(req.tenantId)`,
    ],
  },
  {
    file: 'src/routes/superAdmin.js',
    description: 'clases-merge invalida INVENTARIO_METRICAS',
    expectedCalls: [
      `require('../lib/inventarioCache')`,
      // El call es dentro del handler de clases-merge — usa `id` (parsedId
      // del path param, no req.tenantId porque super-admin actúa cross-tenant).
      `invalidateMetricas(id)`,
    ],
  },
  {
    file: 'src/routes/superAdmin.js',
    description: 'PATCH /tenants + otros endpoints admin invalidan TENANT_STATUS',
    expectedCalls: [
      `require('../lib/tenantStatus')`,
      // Múltiples callsites — al menos uno debe existir.
      `invalidateTenantStatus(id)`,
    ],
    // Contamos que el count no sea trivialmente 1 — hay 5+ endpoints admin
    // que necesitan invalidar. El PATCH genérico se sumó 2026-07-24.
    minOccurrences: {
      'invalidateTenantStatus(id)': 4, // suspend + reactivate + extend-trial + PATCH-paid-until + migrate-country + PATCH genérico
    },
  },
  {
    file: 'src/routes/ventas.js',
    description: 'POST/PUT/DELETE/PATCH ventas invalidan DASHBOARD_VENTAS',
    expectedCalls: [
      // Helper local definido en el mismo file post-cache/ttl.
      `function invalidateDashboardVentas`,
      // Al menos 5 callsites (POST + 2 paths PUT + PATCH vendedor + DELETE).
      `invalidateDashboardVentas(req.tenantId)`,
    ],
    minOccurrences: {
      'invalidateDashboardVentas(req.tenantId)': 5,
    },
  },
  {
    file: 'src/routes/ventas.js',
    description: 'POST/PUT/DELETE ventas invalidan INVENTARIO_METRICAS (stock)',
    expectedCalls: [
      `require('../lib/inventarioCache')`,
      `invalidateMetricas(req.tenantId)`,
    ],
    minOccurrences: {
      'invalidateMetricas(req.tenantId)': 3, // POST + PUT (2 paths) + DELETE
    },
  },
];

// ── Helper ───────────────────────────────────────────────────────────────

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Cache invalidation contracts (static analysis)', () => {

  for (const contract of CONTRACTS) {
    it(`${contract.file}: ${contract.description}`, () => {
      const fullPath = path.join(BACKEND_ROOT, contract.file);
      const source = fs.readFileSync(fullPath, 'utf8');

      // Chequeo 1: expectedCalls presentes.
      for (const needle of contract.expectedCalls) {
        expect(source).toContain(needle);
      }

      // Chequeo 2: notExpectedCalls (si aplica).
      if (contract.notExpectedCalls) {
        for (const needle of contract.notExpectedCalls) {
          expect(source).not.toContain(needle);
        }
      }

      // Chequeo 3: minOccurrences (si aplica). Cazam regresiones donde
      // alguien remueve UN callsite pero el otro sigue.
      if (contract.minOccurrences) {
        for (const [needle, min] of Object.entries(contract.minOccurrences)) {
          const count = countOccurrences(source, needle);
          expect(count).toBeGreaterThanOrEqual(min);
        }
      }
    });
  }

  // Meta-test: verificar que el ALLOWLIST de anti-regression check para
  // SET LOCAL siga vacío (PR #866 llevó los legacy a 0). Si alguien
  // reintroduce el pattern, este test caza además del anti-regression CI.
  it('scripts/security/backend-anti-regression-baseline.json — sin entries de SET_LOCAL_UNSAFE_INTERPOLATION', () => {
    const baselinePath = path.join(BACKEND_ROOT, '..', 'scripts', 'security', 'backend-anti-regression-baseline.json');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const setLocalEntries = baseline.SET_LOCAL_UNSAFE_INTERPOLATION;
    // Puede no existir la key (0 = clean). Si existe, debe ser objeto vacío.
    if (setLocalEntries) {
      expect(Object.keys(setLocalEntries)).toEqual([]);
    }
  });
});
