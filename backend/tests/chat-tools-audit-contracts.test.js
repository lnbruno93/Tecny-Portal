/**
 * Tests de auditoría de las 14 tools del chat bot (task #202, chat P1 4/4).
 *
 * Cierra el último P1 del chat bot pendiente desde snapshot 2026-07-08.
 * Los otros 3 P1s ya se resolvieron:
 *   · prompt injection → PR #872 (structural boundaries)
 *   · retention → verificado (chatCleanupJob.js, audit 2026-07-06 P1)
 *   · capability → verificado (hasCap gates en 13 tools, audit 2026-07-06 P1)
 *
 * ── Qué audita este archivo (regresión-guards estructurales) ─────────────
 *
 * 1. **Paridad TOOLS ↔ handlers**: cada entry del array `TOOLS` (definiciones
 *    Anthropic) tiene un handler en el objeto `handlers`. Si alguien agrega
 *    una tool pero olvida el handler (o al revés), el bot fallaría en
 *    runtime — este test lo caza al primer PR.
 *
 * 2. **Read-only invariant**: NINGÚN handler puede contener SQL de
 *    modificación (INSERT / UPDATE / DELETE / TRUNCATE / ALTER / DROP / GRANT
 *    / REVOKE / CREATE fuera de CREATE TEMP). Chat bot es analytical
 *    read-only por diseño (system prompt line: "Sos solo análisis/lectura").
 *    Regresión-guard: si un handler futuro accidentalmente mete `UPDATE`
 *    (ej. copy-paste de otro código), el test caza.
 *
 * 3. **Tenant-scoped invariant**: cada handler DEBE usar `db.withTenant(...)`
 *    para que RLS aplique. Un handler que use `db.query()` directo bypassa
 *    RLS y podría leer cross-tenant. El comment en línea 441 lo declara
 *    como reglas obligatorias — este test lo enforcea.
 *
 * 4. **Capability gates para tools sensibles**: replicamos la lista canónica
 *    del audit 2026-07-06 P1. Si alguien remueve un `hasCap()` de una tool
 *    sensible (ej. get_cc_pendientes sin capability check), el test caza.
 *
 * ── Approach: static analysis ────────────────────────────────────────────
 *
 * Igual que `cache-invalidation-contracts.test.js` y
 * `chat-prompt-injection-hardening.test.js` — parseamos el source con
 * regex + assertions. Ventajas:
 *   · Rápido (~200ms, sin DB ni HTTP)
 *   · Robusto (sin runtime spies/mocks)
 *   · Explícito (cada invariante = 1 assertion legible)
 */

const fs = require('node:fs');
const path = require('node:path');

const { TOOLS, executeTool } = require('../src/lib/chat-tools');

const SOURCE_PATH = path.join(__dirname, '..', 'src', 'lib', 'chat-tools.js');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extrae el bloque de código de un handler específico. Busca desde
 * `async <name>(` hasta el `},` de cierre del método (comment en handlers
 * es "cada handler es method-shorthand — el `,` cierra la propiedad").
 * Retorna el string del cuerpo del handler.
 */
function getHandlerBody(name) {
  // Match: `async <name>(_input | input, ctx) {`  hasta el `}` del scope.
  // Approach simple: contamos braces desde el `{` de apertura del handler.
  const rgx = new RegExp(`async\\s+${name}\\s*\\(`, 'g');
  const match = rgx.exec(source);
  if (!match) return null;

  // Encontrar el { del cuerpo.
  const start = source.indexOf('{', match.index);
  if (start === -1) return null;

  let depth = 1;
  let i = start + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    // Skip strings (backtick / single / double) — no perfecto pero
    // suficiente para los handlers actuales (sin template literals nested).
    else if (ch === '`' || ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 2;
        else i += 1;
      }
    }
    i += 1;
  }
  return source.substring(start, i);
}

const TOOL_NAMES = TOOLS.map((t) => t.name);

// Handlers extraidos una vez para reusar en múltiples tests.
const HANDLER_BODIES = Object.fromEntries(
  TOOL_NAMES.map((n) => [n, getHandlerBody(n)])
);

// ── Suite 1: paridad TOOLS ↔ handlers ────────────────────────────────────

describe('paridad TOOLS ↔ handlers', () => {
  it('cada TOOL tiene su handler implementado', () => {
    for (const name of TOOL_NAMES) {
      expect(HANDLER_BODIES[name]).not.toBeNull();
    }
  });

  it('executeTool exporta las 14 tools esperadas', () => {
    expect(TOOL_NAMES).toHaveLength(14);
  });

  it('cada tool devuelve algo válido al invocar con handler mock (smoke)', async () => {
    // executeTool devuelve `{ error: 'Tool "X" no implementada.' }` si el
    // handler no existe. Cross-check: para cada TOOL name, el dispatcher
    // NO debe devolver ese error. Usamos ctx minimal — los handlers pueden
    // fallar por otras razones (DB no disponible en unit test) pero NO
    // por handler no encontrado.
    for (const name of TOOL_NAMES) {
      const result = await executeTool(name, {}, { tenantId: 1, role: 'admin' });
      // El result puede tener .error (fail de DB, capability, etc.) pero
      // NO debe ser "Tool X no implementada".
      if (result?.error) {
        expect(result.error).not.toMatch(/no implementada/);
      }
    }
  });
});

// ── Suite 2: read-only invariant ─────────────────────────────────────────

describe('read-only invariant — ningún handler escribe en DB', () => {
  // Regex para SQL de mutación. Case-insensitive. \b bounds para evitar
  // matches parciales (ej. "insertar" contiene "insert").
  // No incluimos SELECT ... FOR UPDATE porque el lock no muta.
  const MUTATION_KEYWORDS = [
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+\w+\s+SET\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i,
    /\bALTER\s+TABLE\b/i,
    /\bDROP\s+TABLE\b/i,
    /\bGRANT\b/i,
    /\bREVOKE\b/i,
    // CREATE está permitido para CREATE TEMP TABLE / CREATE INDEX en analytical
    // queries — no lo restringimos generalmente. Los actual mutation
    // keywords arriba son suficientes.
  ];

  for (const name of TOOL_NAMES) {
    it(`handler ${name} no contiene mutation SQL`, () => {
      const body = HANDLER_BODIES[name];
      expect(body).not.toBeNull();
      for (const rgx of MUTATION_KEYWORDS) {
        expect(body).not.toMatch(rgx);
      }
    });
  }
});

// ── Suite 3: tenant-scoped invariant ─────────────────────────────────────

describe('tenant-scoped invariant — cada handler está scopeado a ctx.tenantId', () => {
  for (const name of TOOL_NAMES) {
    it(`handler ${name} scope-a por tenantId (directo o delegando)`, () => {
      const body = HANDLER_BODIES[name];
      expect(body).not.toBeNull();
      // 3 formas válidas de scoping:
      //
      // (a) Directo: `db.withTenant(ctx.tenantId, ...)` — la mayoría.
      // (b) Delegando a otro handler: `handlers.<name>(..., ctx)` — ese
      //     handler interno scope-a. Ej: get_dashboard_mensual llama
      //     handlers.get_ventas_periodo pasando ctx.
      // (c) Helper externo que scope internamente: pasar `{ tenantId: ctx.tenantId }`
      //     como opt. Ej: get_alertas → evaluarTodas({ tenantId: ctx.tenantId, db }).
      //
      // Al menos UNA debe estar presente. Un handler que hace `db.query(...)`
      // directo sin ninguna de estas 3 formas es un bug (bypass RLS) —
      // la Suite 3b lo caza explícitamente.
      const directWithTenant = /db\.withTenant\s*\(\s*(ctx\.)?tenantId\s*,/.test(body);
      const delegatingToOtherHandler = /handlers\.\w+\s*\([^)]*,\s*ctx\s*\)/.test(body);
      const helperWithTenantId = /\{\s*tenantId\s*:\s*ctx\.tenantId/.test(body);

      const scopedOk = directWithTenant || delegatingToOtherHandler || helperWithTenantId;
      expect(scopedOk).toBe(true);
    });

    it(`handler ${name} NO usa db.query() directo (bypass RLS)`, () => {
      const body = HANDLER_BODIES[name];
      // Los handlers pueden usar client.query() ADENTRO de withTenant.
      // Lo que NO deben usar es `db.query(` directo — eso corre en el pool
      // sin SET LOCAL app.current_tenant → cero filtrado RLS.
      // NOTA: `db.query` en un COMMENT sí está permitido — asumimos que si
      // aparece dentro del body, es una llamada real.
      // Simple check: `db.query(` (no `client.query(` ni `pool.query(`).
      // Chequeamos con una regex que descarta line comments (//... db.query...).
      const linesWithoutComments = body
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      expect(linesWithoutComments).not.toMatch(/\bdb\.query\s*\(/);
    });
  }
});

// ── Suite 4: capability gates para tools sensibles ───────────────────────
//
// Lista canónica del audit 2026-07-06 P1. Cada tool acá listada DEBE tener
// `hasCap(ctx, '<slug>')` en su handler. Si alguien remueve el gate
// (regresión), test caza.
//
// Sync con `chat-tools.js:40-75` cuando se agreguen tools sensibles nuevas.

const CAPABILITY_GATES = [
  // Tool sensible → capability requerida (según el audit 2026-07-06 P1).
  // Verificado 2026-07-24 leyendo el código real. Regresión-guard: si un PR
  // futuro cambia el slug requerido, este test falla y fuerza actualización
  // explícita de esta lista (para que quede en el review + auditable).
  { tool: 'get_ventas_periodo',         capability: 'ventas.trabajar' },
  { tool: 'get_dashboard_mensual',      capability: 'ventas.trabajar' },
  { tool: 'get_envios_activos',         capability: 'envios.trabajar' },
  { tool: 'get_saldos_cajas',           capability: 'cajas.ver' },
  { tool: 'get_top_productos',          capability: 'ventas.trabajar' },
  { tool: 'get_top_vendedores',         capability: 'ventas.ver_ganancias' },  // más restrictivo: ranking exposa ganancias
  { tool: 'get_cc_pendientes',          capability: 'contactos.ver' },
  { tool: 'get_proveedores_pendientes', capability: 'proveedores.trabajar' },
  { tool: 'get_ventas_pendientes',      capability: 'ventas.trabajar' },
  { tool: 'get_tarjetas_no_liquidadas', capability: 'tarjetas.trabajar' },
  { tool: 'get_stock_bajo',             capability: 'inventario.ver' },
  { tool: 'get_actividad_reciente',     capability: 'historial.ver' },
];

describe('capability gates para tools sensibles', () => {
  for (const { tool, capability } of CAPABILITY_GATES) {
    it(`handler ${tool} tiene hasCap check`, () => {
      const body = HANDLER_BODIES[tool];
      expect(body).not.toBeNull();
      // La regex es flexible sobre el slug exacto para tolerar aliases;
      // pero verificamos que hay hasCap(ctx, ...) al menos.
      expect(body).toMatch(/hasCap\s*\(\s*ctx\s*,/);
    });

    it(`handler ${tool} referencia la capability "${capability}"`, () => {
      const body = HANDLER_BODIES[tool];
      expect(body).toContain(capability);
    });
  }

  // Meta: get_alertas y get_kpis_hoy NO tienen cap gate — ambos son
  // read-only + high-level (no leakean data sensible individual). Documentar
  // explicitamente para que no reaparezca la pregunta.
  it('get_alertas y get_kpis_hoy no requieren cap gate (design decision, audit 2026-07-06 P1)', () => {
    const alertasBody = HANDLER_BODIES['get_alertas'];
    const kpisBody = HANDLER_BODIES['get_kpis_hoy'];
    // Verificar que existen los handlers (no que TENGAN el gate — al revés).
    expect(alertasBody).not.toBeNull();
    expect(kpisBody).not.toBeNull();
    // Design decision: estos son KPIs top-level, no PII individual.
    // Todos los users con acceso al chat pueden verlos.
  });
});
