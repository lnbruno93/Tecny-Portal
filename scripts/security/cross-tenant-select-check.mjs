#!/usr/bin/env node
/**
 * cross-tenant-select-check.mjs — anti-regression para el pattern
 * "SELECT ... FROM <tabla-tenant-scoped> ... [LIMIT 1 | WHERE id = $N]"
 * sin `tenant_id` en el WHERE, cuando corre bajo `db.adminQuery` (BYPASSRLS).
 *
 * Contexto (audit 2026-07-25):
 *   4 sitios distintos del backend habían recreado el MISMO bug durante
 *   los últimos 3 meses (pattern original — LIMIT 1 por atributo):
 *
 *     1. `ensureSellerClienteCc` (audit 07-12, Sprint 1 P0-1)
 *     2. `ensureBuyerProveedor`  (audit 07-12, Sprint 1 P0-1)
 *     3. `upsertLinkedContacto`  (audit 07-25, Sprint 0 Fix 2 → PR #883)
 *     4. `cambio_entidades` en crossTenantPagos.js (audit 07-25, Sprint 0 Fix 3 → PR #883)
 *
 *   Y 1 caso adicional (pattern extendido — PK lookup por `id = $N`,
 *   sin LIMIT porque `id` es UNIQUE):
 *
 *     5. `redB2b/config` metodos_pago (audit 07-25, Sprint 2 Fix 7 → PR #885)
 *
 *   Todos siguen la MISMA forma:
 *
 *     await db.adminQuery(async (client) => {
 *       const { rows } = await client.query(
 *         `SELECT id FROM <tabla-tenant-scoped>
 *            WHERE <algún-atributo> = $1
 *              AND deleted_at IS NULL
 *            [LIMIT 1]`,
 *         [valor]
 *       );
 *     });
 *
 *   Sin `WHERE tenant_id = $2`. Corre bajo adminQuery → BYPASSRLS → el
 *   SELECT lee cross-tenant. El primer tenant con match "gana" (LIMIT 1),
 *   los siguientes tenants se quedan con FK cross-tenant o corrupción
 *   silenciosa. Con PK lookup, si el $1 se corrompe (DB manual edit,
 *   migration bug, race), la row de OTRO tenant se expone al cliente.
 *
 * ── Estrategia de detección ────────────────────────────────────────────
 *
 * SQL vive en template literals multi-línea, y los archivos MEZCLAN
 * `db.adminQuery` con `db.withTenant` en el mismo file (ej.
 * `routes/redB2b/operations.js`: 7 adminQuery + 4 withTenant). Un check
 * line-agnostic dispararía falsos positivos masivos.
 *
 * El check hace análisis por-file + wrapper detection:
 *
 *   1. Solo escanea archivos que contengan `db.adminQuery`.
 *   2. Extrae todos los template literals que contienen `SELECT` + `FROM`.
 *   3. Para cada SQL template, determina el WRAPPER que lo envuelve
 *      (nearest `db.adminQuery(` o `db.withTenant(` antes del template).
 *   4. Solo aplica el check si el wrapper es `db.adminQuery` — los que
 *      corren bajo `withTenant` tienen RLS activo y son seguros.
 *   5. Para el SQL bajo adminQuery, chequea:
 *      a. `FROM <tabla>` matchea contra `TABLAS_TENANT_SCOPED` (sync con
 *         `backend/src/lib/rlsCanonical.js`).
 *      b. El SQL NO menciona `tenant_id` en ninguna parte.
 *      c. Si (a) + (b), matchea uno de 2 sub-patterns peligrosos:
 *         - LIMIT 1 (pattern original — SELECT por atributo no-único)
 *         - WHERE id = $N sin LIMIT (pattern PK lookup — SELECT por
 *           PK cuya row referenciada podría pertenecer a otro tenant)
 *   6. Allowlist para queries legítimas (super-admin cross-tenant,
 *      idempotency por opId único, tablas cross-tenant by design, etc.).
 *
 * Uso:
 *   node scripts/security/cross-tenant-select-check.mjs [--verbose]
 *
 * En CI: exit code 1 si encuentra regresiones. La allowlist se actualiza
 * a mano cuando aparece un nuevo caso legítimo (con justificación en el
 * comentario adjunto).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src');
const VERBOSE = process.argv.includes('--verbose');

// ── Tablas tenant-scoped ─────────────────────────────────────────────────
//
// Fuente de verdad: `TABLAS_TENANT_SCOPED` de `backend/src/lib/rlsCanonical.js`.
// Antes teníamos una lista paralela hardcoded que se desincronizaba
// silenciosamente (audit 07-25 encontró 3 tablas cross-tenant hardcodeadas
// que NO deberían estar y ~25 tablas nuevas faltantes). Importar directo
// desde el módulo canónico elimina drift.
//
// Se usa `createRequire` porque rlsCanonical.js es CommonJS y este script
// es ESM (.mjs).
const require = createRequire(import.meta.url);
const { TABLAS_TENANT_SCOPED: CANONICAL_LIST } = require(
  join(BACKEND_SRC, 'lib', 'rlsCanonical.js')
);
const TABLAS_TENANT_SCOPED = new Set(CANONICAL_LIST);

// ── Allowlist ─────────────────────────────────────────────────────────────
//
// Formato: `file:funcion o SQL fragment` → razón.
// Cada entrada requiere una razón EXPLÍCITA (en el PR body) de por qué el
// SELECT sin tenant_id es intencional. Casos típicos:
//   - El SELECT busca por PK únicamente (id = $X) → tenant no aporta.
//   - El SELECT es dentro de un helper que YA setea `SET LOCAL app.
//     current_tenant` antes (RLS aplica en tiempo real).
//   - El SELECT es explícitamente cross-tenant (super-admin, telemetría).
const ALLOWLIST = [
  // Nota histórica (audit 07-25 Sprint cleanup batch B):
  //
  // Este archivo tenía 3 entradas allowlist previas que ya NO son
  // necesarias post-cleanup:
  //
  //   - `routes/config.js` (SELECT tc_venta) — resuelto por wrapper
  //     detection: el SELECT vive bajo `db.withTenant`, no adminQuery. El
  //     check ahora skippea SQL bajo withTenant automáticamente.
  //
  //   - `routes/redB2b/pagos.js` (cross_tenant_pagos, cross_tenant_operations)
  //     — resuelto por sincronización con `rlsCanonical.TABLAS_TENANT_SCOPED`:
  //     esas tablas son cross-tenant BY DESIGN (tienen seller_tenant_id +
  //     buyer_tenant_id, no tenant_id) y NO están en la lista canónica.
  //
  // Se conserva la ALLOWLIST vacía como slot listo para casos futuros
  // legítimos. Formato: { file, fragment, reason }.
];

// ── File walking ─────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'tests']);
const EXTS = ['.js', '.mjs', '.cjs'];

function walkDir(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walkDir(full, out);
    } else if (EXTS.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

// ── SQL extraction + wrapper detection ──────────────────────────────────

/**
 * Extrae template literals con SQL de un archivo. Devuelve array de
 * `{ sql, offset, lineStart }` para cada template que contenga
 * SELECT + FROM (with or without LIMIT).
 *
 * `offset` es el índice del backtick de apertura en el contenido — se usa
 * para wrapper detection (buscar `db.adminQuery(` o `db.withTenant(` antes
 * de este offset).
 *
 * Heurística simple: matchea backticks abiertos con backticks cerrados.
 * No es perfecta (no maneja ${} anidados con backticks, ni escapes) pero
 * cubre >99% del código real del backend, que sigue el pattern estándar
 * `pg`.
 */
function extractSqlTemplates(content) {
  const results = [];
  const joined = content;

  // Regex simple: backtick + contenido no-backtick (incluyendo newlines) + backtick.
  // NOTA: `.` con la flag `s` matchea newlines.
  const regex = /`([^`]*?)`/gs;
  let match;
  while ((match = regex.exec(joined)) !== null) {
    const sql = match[1];
    // Filtrar rápido: solo interesa si tiene SELECT + FROM.
    // No requerimos LIMIT — el pattern extendido incluye PK lookups sin LIMIT.
    if (!/SELECT[\s\S]+FROM/i.test(sql)) continue;
    const upTo = joined.slice(0, match.index);
    const lineStart = upTo.split('\n').length;
    results.push({ sql, offset: match.index, lineStart });
  }
  return results;
}

/**
 * Encuentra el wrapper que envuelve un SQL template dado su offset.
 * Retorna 'adminQuery' | 'withTenant' | null.
 *
 * Heurística: buscar la ocurrencia MÁS CERCANA (mayor offset < sqlOffset)
 * de `db.adminQuery(` o `db.withTenant(` antes del SQL. Simple pero
 * suficiente para la estructura típica del backend, donde los wrappers
 * NO se anidan cross-type (adminQuery > withTenant o viceversa) y las
 * top-level llamadas son mayormente independientes en Promise.all() o
 * secuencial.
 *
 * Limitación conocida: si un adminQuery abarca varios SQL templates
 * secuenciales y otro wrapper aparece EN MEDIO (ej. return), el nearest
 * check puede mal-atribuir el siguiente SQL. En el codebase real esto
 * es raro (los wrappers son bloques cortos) y el falso positivo se
 * resuelve con allowlist inline. Para tracking por-bloque real habría
 * que hacer brace-matching JS-aware, que es Sprint futuro (low ROI hoy).
 */
function detectWrapper(content, sqlOffset) {
  // Buscar la última ocurrencia antes de sqlOffset.
  // Simple slice + lastIndexOf funciona (el corpus es de tamaño manejable).
  const before = content.slice(0, sqlOffset);
  const adminIdx = before.lastIndexOf('db.adminQuery(');
  const withIdx  = before.lastIndexOf('db.withTenant(');
  if (adminIdx < 0 && withIdx < 0) return null;
  if (adminIdx > withIdx) return 'adminQuery';
  return 'withTenant';
}

/**
 * Chequea si un SQL matchea alguno de los patterns peligrosos.
 * Precondición: el caller garantiza que este SQL corre bajo adminQuery
 * (via detectWrapper).
 *
 * Returns { hit: boolean, tabla: string|null, kind: string }.
 *
 * `kind` categoriza el pattern:
 *   - 'limit1'     → SELECT ... WHERE <col> = $ ... LIMIT 1
 *                    (pattern original, audit 07-12 P0-1 x2 + 07-25 Fixes 2+3)
 *   - 'pk-lookup'  → SELECT ... WHERE id = $ [AND deleted_at IS NULL]
 *                    (pattern PK lookup — audit 07-25 Fix 7)
 */
function checkSqlPattern(sql) {
  // Solo SELECT (no INSERT/UPDATE/DELETE, esos son otra categoría de audit).
  if (!/^\s*SELECT/i.test(sql)) return { hit: false };

  // Extraer FROM <tabla> (tomar el primer FROM — ignorar JOINs).
  const fromMatch = sql.match(/FROM\s+([a-z_][a-z0-9_]*)/i);
  if (!fromMatch) return { hit: false };
  const tabla = fromMatch[1].toLowerCase();
  if (!TABLAS_TENANT_SCOPED.has(tabla)) return { hit: false };

  // Chequear si el SQL menciona tenant_id (en cualquier parte).
  // Match liberal: `tenant_id` en el string es suficiente.
  // Falsos positivos aceptables (ej. tenant_id en el SELECT projection pero
  // no en WHERE) → no es lo típico, y siempre podemos allowlistear.
  if (/\btenant_id\b/i.test(sql)) return { hit: false };

  // Sub-pattern A: LIMIT 1 (original — SELECT por atributo no-único).
  const isLimitOne = /\bLIMIT\s+1\b/i.test(sql);

  // Sub-pattern B: PK lookup (WHERE id = $N o AND id = $N).
  // `id` es UNIQUE PK → no requiere LIMIT. Peligroso si $N viene de otra
  // tabla que podría estar corrompida cross-tenant.
  const isPkLookup =
    /\bWHERE\s+id\s*=\s*\$\d+/i.test(sql) ||
    /\bAND\s+id\s*=\s*\$\d+/i.test(sql);

  if (!isLimitOne && !isPkLookup) return { hit: false };

  const kind = isLimitOne ? 'limit1' : 'pk-lookup';
  return { hit: true, tabla, kind };
}

function isAllowlisted(file, sql) {
  return ALLOWLIST.some((entry) => {
    if (!file.includes(entry.file)) return false;
    return sql.includes(entry.fragment);
  });
}

// ── Self-tests ──────────────────────────────────────────────────────────
//
// La lógica de `checkSqlPattern` + `detectWrapper` es no-trivial y una
// regresión silenciosa (ej. regex que deja de matchear el pattern
// `WHERE id = $N`) desactivaría toda la protección sin ruido.
//
// El self-test corre con `--self-test` y valida ~12 casos representativos:
// pattern peligroso limit1, pk-lookup, casos seguros (tenant_id presente,
// tabla no tenant-scoped, SELECT bajo withTenant, sin LIMIT ni WHERE id=$),
// edge cases (LIMIT 2, comment con FROM en el SELECT, etc.).
//
// En CI se corre después del check principal para verificar la sanity del
// script mismo (`npm test` incluye ambos).

const SELF_TEST_CASES = [
  // ── DEBEN dispararse ──
  {
    name: 'limit1 clásico: WHERE nombre = $ sin tenant_id',
    sql: `SELECT id FROM contactos WHERE nombre = $1 AND deleted_at IS NULL LIMIT 1`,
    expectHit: true,
    expectKind: 'limit1',
  },
  {
    name: 'limit1 con newlines multi-línea',
    sql: `SELECT id
            FROM proveedores
            WHERE numero = $1
              AND deleted_at IS NULL
            LIMIT 1`,
    expectHit: true,
    expectKind: 'limit1',
  },
  {
    name: 'pk-lookup: WHERE id = $ sin tenant_id',
    sql: `SELECT id, nombre, moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL`,
    expectHit: true,
    expectKind: 'pk-lookup',
  },
  {
    name: 'pk-lookup: AND id = $ (id no en primer WHERE)',
    sql: `SELECT id FROM productos WHERE deleted_at IS NULL AND id = $1`,
    expectHit: true,
    expectKind: 'pk-lookup',
  },

  // ── NO DEBEN dispararse ──
  {
    name: 'safe: tenant_id presente en WHERE',
    sql: `SELECT id FROM contactos WHERE nombre = $1 AND tenant_id = $2 LIMIT 1`,
    expectHit: false,
  },
  {
    name: 'safe: pk-lookup con tenant_id',
    sql: `SELECT id FROM metodos_pago WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    expectHit: false,
  },
  {
    name: 'safe: tabla NO tenant-scoped (tenants)',
    sql: `SELECT id, nombre FROM tenants WHERE id = $1`,
    expectHit: false,
  },
  {
    name: 'safe: sin LIMIT y sin WHERE id=$ (por rango de fecha, ej.)',
    sql: `SELECT id FROM contactos WHERE created_at > $1 ORDER BY id DESC`,
    expectHit: false,
  },
  {
    name: 'safe: no es SELECT (UPDATE)',
    sql: `UPDATE contactos SET nombre = $1 WHERE id = $2`,
    expectHit: false,
  },
  {
    name: 'safe: LIMIT 2 (no exactamente 1)',
    sql: `SELECT id FROM contactos WHERE nombre = $1 LIMIT 2`,
    expectHit: false,
  },
];

function runSelfTests() {
  let passed = 0;
  let failed = 0;

  console.log('[self-test] validando checkSqlPattern con casos hardcoded...\n');

  for (const tc of SELF_TEST_CASES) {
    const result = checkSqlPattern(tc.sql);
    const hitOk = result.hit === tc.expectHit;
    const kindOk = !tc.expectKind || result.kind === tc.expectKind;
    const ok = hitOk && kindOk;

    if (ok) {
      passed += 1;
      console.log(`  ✅ ${tc.name}`);
    } else {
      failed += 1;
      console.error(`  ❌ ${tc.name}`);
      console.error(`     expected: hit=${tc.expectHit}${tc.expectKind ? `, kind=${tc.expectKind}` : ''}`);
      console.error(`     got:      hit=${result.hit}${result.kind ? `, kind=${result.kind}` : ''}`);
      console.error(`     SQL: ${tc.sql.trim().replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }

  // Wrapper detection self-tests.
  const wrapperFixture = `
    async function foo() {
      const a = await db.adminQuery(async (client) => {
        const q = await client.query(\`SELECT * FROM productos\`);
      });
      const b = await db.withTenant(tid, async (client) => {
        const q = await client.query(\`SELECT * FROM contactos\`);
      });
    }
  `;
  const templates = extractSqlTemplates(wrapperFixture);
  if (templates.length !== 2) {
    failed += 1;
    console.error(`  ❌ wrapper fixture: esperaba 2 SQL templates, encontré ${templates.length}`);
  } else {
    const w1 = detectWrapper(wrapperFixture, templates[0].offset);
    const w2 = detectWrapper(wrapperFixture, templates[1].offset);
    if (w1 === 'adminQuery' && w2 === 'withTenant') {
      passed += 1;
      console.log('  ✅ wrapper detection: adminQuery + withTenant correcto');
    } else {
      failed += 1;
      console.error(`  ❌ wrapper detection: esperaba [adminQuery, withTenant], obtuve [${w1}, ${w2}]`);
    }
  }

  console.log(`\n[self-test] ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n❌ Self-tests fallaron. Revisar cambios recientes al script.');
    process.exit(1);
  }
  console.log('✅ Self-tests OK.');
  process.exit(0);
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  if (process.argv.includes('--self-test')) {
    return runSelfTests();
  }

  const files = walkDir(BACKEND_SRC);
  const regressions = [];
  let scanned = 0;
  let templatesFound = 0;
  let templatesUnderAdmin = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    // Solo escanear archivos que usan adminQuery.
    if (!/db\.adminQuery/.test(content)) continue;
    scanned += 1;

    const templates = extractSqlTemplates(content);
    templatesFound += templates.length;

    for (const { sql, offset, lineStart } of templates) {
      // Wrapper detection: solo aplicar el check si estamos bajo adminQuery.
      const wrapper = detectWrapper(content, offset);
      if (wrapper !== 'adminQuery') continue;
      templatesUnderAdmin += 1;

      const { hit, tabla, kind } = checkSqlPattern(sql);
      if (!hit) continue;
      const rel = relative(REPO_ROOT, file);
      if (isAllowlisted(rel, sql)) continue;
      regressions.push({
        file: rel,
        line: lineStart,
        tabla,
        kind,
        sqlSnippet: sql.trim().replace(/\s+/g, ' ').slice(0, 200),
      });
    }
  }

  if (VERBOSE) {
    console.log(`[cross-tenant-select-check] escaneados ${scanned} archivos con db.adminQuery`);
    console.log(`[cross-tenant-select-check] SQL templates encontrados: ${templatesFound}`);
    console.log(`[cross-tenant-select-check] SQL bajo adminQuery: ${templatesUnderAdmin}`);
  }

  if (regressions.length === 0) {
    console.log('✅ cross-tenant-select-check: OK — ningún SELECT sin tenant_id bajo adminQuery');
    console.log(`   (escaneados ${scanned} archivos, ${templatesUnderAdmin}/${templatesFound} templates bajo adminQuery, ${TABLAS_TENANT_SCOPED.size} tablas cubiertas)`);
    console.log('   Patterns cubiertos: LIMIT 1 (audit 07-12 P0-1 x2, 07-25 Fixes 2+3) + PK lookup (07-25 Fix 7)');
    process.exit(0);
  }

  const byKind = regressions.reduce((acc, r) => {
    acc[r.kind] = (acc[r.kind] || 0) + 1;
    return acc;
  }, {});

  console.error(`\n❌ cross-tenant-select-check: ${regressions.length} regresión(es) potencial(es).\n`);
  console.error(`  Breakdown: ${Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(', ')}\n`);
  console.error('Patterns peligrosos (bajo db.adminQuery, sin tenant_id en WHERE):');
  console.error('  - limit1     → SELECT ... WHERE <col> = $ ... LIMIT 1');
  console.error('                 (cazado 4× en 3 meses: audit 07-12 P0-1 x2 + 07-25 Fixes 2+3)');
  console.error('  - pk-lookup  → SELECT ... WHERE id = $ [AND deleted_at IS NULL]');
  console.error('                 (cazado 1× audit 07-25 Fix 7 — redB2b/config metodos_pago)\n');
  console.error('Fix: agregar `AND tenant_id = $N` al WHERE (defense-in-depth vs RLS bypass).\n');
  console.error('Si el caso es legítimo (super-admin cross-tenant, idempotency por opId único,\n' +
                'tabla cross-tenant by design, etc.), agregarlo al ALLOWLIST del script con\n' +
                'razón explícita en el PR body.\n');

  for (const r of regressions) {
    console.error(`  [${r.kind}] ${r.file}:~${r.line}  (tabla: ${r.tabla})`);
    console.error(`    SQL: ${r.sqlSnippet}`);
    console.error('');
  }

  process.exit(1);
}

main();
