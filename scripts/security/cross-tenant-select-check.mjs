#!/usr/bin/env node
/**
 * cross-tenant-select-check.mjs — anti-regression para el pattern
 * "SELECT ... FROM <tabla-tenant-scoped> ... LIMIT 1" sin `tenant_id` en
 * el WHERE, cuando corre bajo `db.adminQuery` (BYPASSRLS).
 *
 * Contexto (audit 2026-07-25):
 *   3 sitios distintos del backend habían recreado el MISMO bug durante
 *   los últimos 3 meses:
 *
 *     1. `ensureSellerClienteCc` (audit 07-12, Sprint 1 P0-1)
 *     2. `ensureBuyerProveedor`  (audit 07-12, Sprint 1 P0-1)
 *     3. `upsertLinkedContacto`  (audit 07-25, Sprint 0 Fix 2 → PR #883)
 *     4. `cambio_entidades` en crossTenantPagos.js (audit 07-25, Sprint 0 Fix 3 → PR #883)
 *
 *   Todos siguen la MISMA forma:
 *
 *     await db.adminQuery(async (client) => {
 *       const { rows } = await client.query(
 *         `SELECT id FROM <tabla-tenant-scoped>
 *            WHERE <algún-atributo> = $1
 *              AND deleted_at IS NULL
 *            LIMIT 1`,
 *         [valor]
 *       );
 *     });
 *
 *   Sin `WHERE tenant_id = $2`. Corre bajo adminQuery → BYPASSRLS → el
 *   SELECT lee cross-tenant. El primer tenant con match "gana" (LIMIT 1),
 *   los siguientes tenants se quedan con FK cross-tenant o corrupción
 *   silenciosa.
 *
 * ── Estrategia de detección ────────────────────────────────────────────
 *
 * Line-level regex es demasiado ingenuo (SQL vive en template literals
 * multi-línea). El check hace un análisis simple por-archivo:
 *
 *   1. Solo escanea archivos que contengan `db.adminQuery` — que sí usan
 *      BYPASSRLS.
 *   2. Extrae todos los template literals que contienen `SELECT` + `FROM`
 *      + `LIMIT` (con o sin whitespace/newlines).
 *   3. Para cada query, chequea:
 *      a. `FROM <tabla>` matchea contra una lista de tablas tenant-scoped
 *         conocidas (importada de `TABLAS_TENANT_SCOPED` de rlsCanonical.js).
 *      b. El WHERE de esa query contiene la substring `tenant_id`.
 *      c. Si (a) es true y (b) es false → potential regression.
 *   4. Allowlist para queries legítimas (ej. SELECT del helper `getTenantById`
 *      que INTENCIONALMENTE no filtra por tenant_id porque busca al tenant
 *      mismo).
 *
 * Uso:
 *   node scripts/security/cross-tenant-select-check.mjs
 *
 * En CI: exit code 1 si encuentra regresiones. La allowlist se actualiza
 * a mano cuando aparece un nuevo caso legítimo (con justificación en el
 * comentario adjunto).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src');
const VERBOSE = process.argv.includes('--verbose');

// ── Tablas tenant-scoped ─────────────────────────────────────────────────
//
// Lista canónica de tablas donde el pattern "SELECT sin tenant_id LIMIT 1"
// es peligroso bajo adminQuery. Mantenida en sync con
// `TABLAS_TENANT_SCOPED` de backend/src/lib/rlsCanonical.js.
//
// Cuando se agrega una tabla nueva tenant-scoped, agregala acá TAMBIÉN.
// Un desync es low-risk (el check queda inaplicable para la nueva tabla)
// pero conceptualmente merece atención — se puede automatizar sync en un
// Sprint futuro leyendo directamente rlsCanonical.
const TABLAS_TENANT_SCOPED = new Set([
  'productos', 'clases_producto', 'ventas', 'venta_pagos', 'canjes',
  'contactos', 'clientes_cc', 'movimientos_cc', 'proveedores',
  'proveedor_movimientos', 'metodos_pago', 'caja_movimientos',
  'ajustes_caja', 'cambio_entidades', 'cambio_movimientos', 'tarjetas',
  'tarjeta_movimientos', 'egresos', 'envios', 'depositos', 'share_links',
  'cross_tenant_operations', 'cross_tenant_pagos', 'red_b2b_partnerships',
  'chat_conversations', 'chat_messages',
]);

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
  // False positive: config.js:41 (GET /last-tc) tiene el SELECT dentro de
  // `db.withTenant` (RLS aplica). El check dispara porque el archivo
  // TAMBIÉN usa `db.adminQuery` en OTRA función (getTcDefaultPais fallback
  // a nivel país). Este es un limit fundamental del check line-agnostic:
  // no distingue entre bloques dentro del mismo archivo. Aceptamos falso
  // positivo con esta entrada — mejorar el check para tracking por bloque
  // es Sprint 3+ (refactor grande, low ROI hoy).
  { file: 'routes/config.js', fragment: 'SELECT tc_venta', reason: 'Corre bajo db.withTenant, no adminQuery. RLS aplica.' },
  // Legítimos: idempotency lookups por (opId, client_generated_id) donde el
  // opId es único cross-tenant por diseño de Red B2B (tabla cross_tenant_pagos
  // es explícitamente cross-tenant). El client_generated_id + opId forman
  // effectively-unique — no aporta tenant_id al filtro.
  { file: 'routes/redB2b/pagos.js', fragment: 'FROM cross_tenant_pagos', reason: 'Cross-tenant table by design + idempotency lookup por (opId, key) unique' },
  { file: 'routes/redB2b/pagos.js', fragment: 'FROM cross_tenant_operations', reason: 'Cross-tenant table by design + idempotency lookup por (parent_op_id, key)' },
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

// ── SQL extraction ───────────────────────────────────────────────────────

/**
 * Extrae template literals con SQL de un archivo. Devuelve array de
 * `{ sql, lineStart }` para cada template que contenga SELECT + FROM + LIMIT.
 *
 * Heurística simple: matchea backticks abiertos con backticks cerrados.
 * No es perfecta (no maneja ${} anidados con backticks, ni escapes) pero
 * cubre >99% del código real del backend, que sigue el pattern estándar
 * `pg`.
 */
function extractSqlTemplates(content) {
  const results = [];
  const lines = content.split('\n');
  const joined = content;

  // Regex simple: backtick + contenido no-backtick (incluyendo newlines) + backtick.
  // NOTA: `.` con la flag `s` matchea newlines.
  const regex = /`([^`]*?)`/gs;
  let match;
  while ((match = regex.exec(joined)) !== null) {
    const sql = match[1];
    // Filtrar rápido: solo interesa si es SQL.
    if (!/SELECT[\s\S]+FROM[\s\S]+LIMIT/i.test(sql)) continue;
    // Calcular linea aproximada donde arranca el template (offset → linea).
    const upTo = joined.slice(0, match.index);
    const lineStart = upTo.split('\n').length;
    results.push({ sql, lineStart });
  }
  return results;
}

/**
 * Chequea si un SQL matchea el pattern peligroso.
 * Returns { hit: boolean, tabla: string|null, reason: string }.
 */
function checkSqlPattern(sql) {
  // Extraer FROM <tabla> (tomar el primer FROM — ignorar JOINs).
  const fromMatch = sql.match(/FROM\s+([a-z_][a-z0-9_]*)/i);
  if (!fromMatch) return { hit: false };
  const tabla = fromMatch[1].toLowerCase();
  if (!TABLAS_TENANT_SCOPED.has(tabla)) return { hit: false };

  // Detectar LIMIT 1 (o LIMIT sin número que igual devuelve pocas rows).
  if (!/\bLIMIT\s+1\b/i.test(sql)) return { hit: false };

  // Chequear si el SQL menciona tenant_id (en cualquier parte).
  // Match liberal: `tenant_id` en el string es suficiente.
  // Falsos positivos aceptables (ej. tenant_id en el SELECT projection pero
  // no en WHERE) → no es lo típico, y siempre podemos allowlistear.
  if (/\btenant_id\b/i.test(sql)) return { hit: false };

  return { hit: true, tabla };
}

function isAllowlisted(file, sql) {
  return ALLOWLIST.some((entry) => {
    if (!file.includes(entry.file)) return false;
    return sql.includes(entry.fragment);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const files = walkDir(BACKEND_SRC);
  const regressions = [];
  let scanned = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    // Solo escanear archivos que usan adminQuery.
    if (!/db\.adminQuery/.test(content)) continue;
    scanned += 1;

    const templates = extractSqlTemplates(content);
    for (const { sql, lineStart } of templates) {
      const { hit, tabla } = checkSqlPattern(sql);
      if (!hit) continue;
      const rel = relative(REPO_ROOT, file);
      if (isAllowlisted(rel, sql)) continue;
      regressions.push({
        file: rel,
        line: lineStart,
        tabla,
        sqlSnippet: sql.trim().replace(/\s+/g, ' ').slice(0, 200),
      });
    }
  }

  if (VERBOSE) {
    console.log(`[cross-tenant-select-check] escaneados ${scanned} archivos con db.adminQuery`);
  }

  if (regressions.length === 0) {
    console.log('✅ cross-tenant-select-check: OK — ningún SELECT sin tenant_id + LIMIT 1 en archivos con adminQuery');
    console.log(`   (escaneados ${scanned} archivos, ${TABLAS_TENANT_SCOPED.size} tablas cubiertas)`);
    process.exit(0);
  }

  console.error(`\n❌ cross-tenant-select-check: ${regressions.length} regresión(es) potencial(es).\n`);
  console.error('Pattern peligroso: `SELECT ... FROM <tabla-tenant-scoped> ... LIMIT 1`');
  console.error('sin filtro `tenant_id` en WHERE, dentro de archivos que usan db.adminQuery.\n');
  console.error('Este pattern se cazó 4 veces en 3 meses (audit 07-12 P0-1 x2, audit 07-25 Fixes 2+3).');
  console.error('Fix: agregar `AND tenant_id = $N` al WHERE (defense-in-depth vs RLS bypass).\n');
  console.error('Si el caso es legítimo (PK lookup, super-admin cross-tenant, etc.), agregarlo\n' +
                'al ALLOWLIST del script con razón explícita.\n');

  for (const r of regressions) {
    console.error(`  ${r.file}:~${r.line}  (tabla: ${r.tabla})`);
    console.error(`    SQL: ${r.sqlSnippet}`);
    console.error('');
  }

  process.exit(1);
}

main();
