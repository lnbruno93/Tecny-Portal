#!/usr/bin/env node
/**
 * audit-with-allowlist.mjs — wrapper de `npm audit` con allowlist explícita
 * de advisories no-exploitables en nuestra arquitectura.
 *
 * ── Uso ────────────────────────────────────────────────────────────────
 *   node scripts/security/audit-with-allowlist.mjs [workspace-dir]
 *
 *   Ejecuta `npm audit --json --audit-level=moderate --omit=dev` en el
 *   workspace especificado. Filtra advisories que están en `ALLOWLIST`
 *   (documentados con razón). Exit 0 si no queda ninguna vuln fuera del
 *   allowlist, exit 1 si sí.
 *
 * ── Por qué existe ─────────────────────────────────────────────────────
 *   npm audit no soporta allowlist nativo. Cuando aparece un advisory
 *   que NO es explotable en nuestra arquitectura (ej. una vuln de SSR
 *   en una lib que usamos solo client-side), el chequeo "moderate+" rompe
 *   CI para TODOS los PRs indefinidamente hasta que upstream libere fix.
 *
 *   Este wrapper permite documentar "advisory X no aplica porque Y" con
 *   justificación explícita, mantener CI verde, y forzar re-evaluación
 *   periódica (el allowlist es un archivo VCS-tracked, cada entry es un
 *   commit revisable).
 *
 * ── Convenciones para agregar al allowlist ─────────────────────────────
 *   1. Solo agregar advisories que son DEMOSTRABLEMENTE no-explotables
 *      dado el patrón de uso del codebase. NO agregar por conveniencia.
 *   2. Incluir `reason` con explicación concreta de por qué no es
 *      explotable en NUESTRO uso (no repetir el título del advisory).
 *   3. Incluir `addedAt` (ISO date) para trazar antigüedad.
 *   4. Incluir `expiresAt` opcional para forzar re-evaluación futura.
 *   5. Auditoría trimestral: revisar allowlist entero, remover entries
 *      cuyo upstream ya haya publicado fix o cuyo assumption ya no aplique.
 *
 * ── Formato allowlist ──────────────────────────────────────────────────
 *   Cada entry tiene keys:
 *     · advisoryId (GHSA-xxxx-xxxx-xxxx)
 *     · reason (por qué no aplica en Tecny)
 *     · addedAt (ISO date)
 *     · expiresAt (ISO date, opcional)
 */

import { spawnSync } from 'node:child_process';

// ── Allowlist ────────────────────────────────────────────────────────────

const ALLOWLIST = [
  {
    advisoryId: 'GHSA-qwww-vcr4-c8h2',
    title: 'React Router: RSC Mode CSRF Bypass Allows Action Execution Before 400 Response',
    reason:
      'Aplica solo cuando se usa React Server Components (RSC) mode. Tecny es una SPA ' +
      'client-side pura con react-router-dom @ BrowserRouter — sin SSR, sin RSC, sin ' +
      'server actions. La superficie afectada (Action handler pre-400) no existe en ' +
      'nuestro bundle. Upstream (react-router-dom) aún no libera fix compatible con 7.x ' +
      '— la única "fix" del advisory es downgrade a 7.11.0 que destapa 14+ advisories ' +
      'previos peores. Re-evaluar cuando react-router-dom@8.x esté disponible.',
    addedAt: '2026-07-24',
    expiresAt: '2026-10-24', // forzar re-evaluación en 3 meses
  },
];

// ── Main ─────────────────────────────────────────────────────────────────

const workspaceDir = process.argv[2] || '.';

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Verificar allowlist antes de correr audit — enforce expiry.
const expired = ALLOWLIST.filter((e) => e.expiresAt && e.expiresAt < today());
if (expired.length > 0) {
  console.error('[audit-allowlist] ENTRIES EXPIRADAS — re-evaluar y remover/renovar:');
  for (const e of expired) {
    console.error(`  · ${e.advisoryId} (expiró ${e.expiresAt}) — ${e.title}`);
  }
  console.error('\nEditar scripts/security/audit-with-allowlist.mjs y decidir: (a) ya no ' +
    'aplica el reasoning → remover, (b) sigue aplicando → renovar expiresAt.');
  process.exit(1);
}

const result = spawnSync(
  'npm',
  ['audit', '--json', '--audit-level=moderate', '--omit=dev'],
  { cwd: workspaceDir, encoding: 'utf8' }
);

let audit;
try {
  audit = JSON.parse(result.stdout);
} catch (err) {
  console.error(`[audit-allowlist] npm audit no devolvió JSON válido en ${workspaceDir}`);
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(2);
}

const vulns = audit.vulnerabilities || {};
const allowedIds = new Set(ALLOWLIST.map((e) => e.advisoryId));

// Colectar advisories NO allowlisteados. Estructura de npm audit --json:
//   vulnerabilities[pkg].via[] es array de advisory objects, cada uno con `url`
//   que contiene el GHSA-xxx-xxx-xxx al final. También hay `source` (number id).
const nonAllowedFindings = [];
let allowedCount = 0;

for (const [pkg, meta] of Object.entries(vulns)) {
  const via = Array.isArray(meta.via) ? meta.via : [];
  for (const item of via) {
    // item puede ser string (referencia a otro paquete via) o object (advisory).
    if (typeof item === 'string') continue;
    if (!item.url) continue;
    // Extraer GHSA-id del URL: https://github.com/advisories/GHSA-xxxx-xxxx-xxxx
    const m = item.url.match(/GHSA-[a-z0-9-]+/i);
    if (!m) continue;
    const ghsaId = m[0];
    if (allowedIds.has(ghsaId)) {
      allowedCount += 1;
    } else {
      nonAllowedFindings.push({
        pkg,
        advisoryId: ghsaId,
        title: item.title,
        severity: item.severity,
        url: item.url,
      });
    }
  }
}

// Log allowlisted (para visibilidad en CI logs).
if (allowedCount > 0) {
  console.log(`[audit-allowlist] ${allowedCount} finding(s) allowlisted en ${workspaceDir}:`);
  for (const entry of ALLOWLIST) {
    console.log(`  · ${entry.advisoryId} (${entry.expiresAt || 'sin expiry'}) — ${entry.title}`);
  }
  console.log('');
}

if (nonAllowedFindings.length === 0) {
  console.log(`[audit-allowlist] ✓ OK — sin findings fuera del allowlist en ${workspaceDir}`);
  process.exit(0);
}

// Hay findings no allowlisted — fallar CI.
console.error(`[audit-allowlist] ✗ ${nonAllowedFindings.length} finding(s) fuera del allowlist en ${workspaceDir}:\n`);
for (const f of nonAllowedFindings) {
  console.error(`  ${f.severity.toUpperCase()} — ${f.advisoryId} — ${f.pkg}`);
  console.error(`    ${f.title}`);
  console.error(`    ${f.url}\n`);
}
console.error(
  'Opciones:\n' +
  '  1. Aplicar `npm audit fix` en el workspace (preferido si es non-breaking)\n' +
  '  2. Si es breaking: bump manual con testing + PR dedicado\n' +
  '  3. Si NO es explotable en nuestra arquitectura: agregar al ALLOWLIST en ' +
  'scripts/security/audit-with-allowlist.mjs con justificación explícita.\n'
);
process.exit(1);
