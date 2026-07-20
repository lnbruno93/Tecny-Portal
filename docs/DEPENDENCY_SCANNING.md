# Dependency scanning — política y herramientas

**Última actualización:** 2026-07-20 (Rec proactiva #4 post-audit)

## Objetivo

Que ninguna vulnerabilidad conocida de una dependency directa o transitiva llegue a prod sin que alguien la vea. En orden de descuido creciente:

1. **Vulns críticas conocidas** de deps directas → detectadas por `npm audit` en CI.
2. **Vulns transitivas** (deps de deps) → detectadas por Socket.dev.
3. **Updates disponibles** (no necesariamente por vuln) → auto-PRs de Dependabot.

## Herramientas activas

### 1. `npm audit` en CI — deps directas, `moderate+`

Configurado en `.github/workflows/ci.yml` para los 3 workspaces:

- `backend/` — `npm audit --audit-level=moderate --omit=dev` (runtime deps solo, devDeps no se explotan en prod).
- `frontend/` — `npm audit --audit-level=moderate`.
- `admin-frontend/` — `npm audit --audit-level=moderate`.

Root (Playwright/E2E) no tiene audit gate porque solo corre en CI, no en prod.

**Falla el CI si aparece vuln `moderate+` en runtime.** Fuerza a ver antes del merge.

### 2. Dependabot — auto-PRs semanales

`.github/dependabot.yml` configurado con:

- **Cadencia:** lunes 09:00 AR time.
- **4 ecosystems npm:** root, backend, frontend, admin-frontend.
- **1 ecosystem GitHub Actions:** para bumps de `actions/*`.
- **Grouping:** Sentry, Postgres, Vite ecosystems se agrupan en un PR único por semana (menos ruido).
- **Ignores:** majors de React/Vite/Vitest/Express/pg quedan como PRs SOLO manuales — los majors de estos suelen requerir migration + testing exhaustivo, no queremos auto-PR.

**Bandeja "Dependabot" cada lunes AM:** revisar los PRs abiertos con label `dependencies`. Si CI verde + no hay CHANGELOG con breaking → merge. Si hay algo raro, escalate a review.

### 3. Socket.dev — vulns transitivas (a instalar)

**Setup manual (1x):**

1. Ir a [Socket for GitHub](https://github.com/marketplace/socket-security) y clickear "Set up a plan" (Free tier suficiente hasta 5 repos y features básicas).
2. Autorizar en `lnbruno93/Tecny-Portal` (private repo — el Free tier de Socket lo cubre).
3. En cada PR, Socket analiza:
   - **Newly added transitive deps** — flagea si un update de nivel 2 mete un package nuevo con supply-chain risks (typosquatting, mineros, exfil).
   - **Vulnerable transitive deps** — vulns conocidas en deps de deps.
   - **License risk** — flagea licenses no-compatibles.
4. Socket bot comentea en PRs. No bloquea merge, pero deja checkmarks visibles.

**Por qué Socket vs Snyk/etc:**

- Snyk gratuito limita a monthly scans + solo direct deps con noise alto en PRs.
- Socket free tier específicamente analiza cada PR + tiene mejor UX para supply-chain (que es el vector creciente 2024-2026).
- Ninguno reemplaza a `npm audit` — son complementos.

**Alternativa si Socket no convence:** GitHub's own **Dependency review action** (built-in, gratis). Documentar acá cuál se elige.

## Cadencia de revisión

- **Lunes AM (~15 min):** mirar bandeja de PRs con label `dependencies`. Merge los verdes, comentar/cerrar los rotos.
- **Post-merge:** cada PR de Dependabot deployea igual que cualquier otro (staging→prod via sync workflow). Sentry alerta si hay regression → rollback via revert.
- **Trimestralmente:** revisar el archivo `dependabot.yml` — ¿los ignores siguen teniendo sentido? ¿hay que reordenar cadencia?

## Anti-patterns a evitar

- ❌ **Auto-merge de Dependabot PRs** — nunca. Aunque CI esté verde, un `minor` puede introducir un bug sutil de comportamiento (ej: cambio de default en pg driver). El humano revisa 30s por PR, vale la pena.
- ❌ **Ignorar vulns por "es dev dep"** — algunas devDeps se ejecutan en CI (jest, playwright) y sí pueden ser vector si el runner es shared. Regla: si tenés dudas, escalate.
- ❌ **Postergar majors sine die** — cuando un major de una dep queda ignored por 6+ meses, el gap con el mainstream crece. Cada quarter revisar si toca migrar.

## Runbook: llegó una vuln crítica

1. **Confirmar** con `npm audit` local si es real (a veces son falsos positivos de advisories retirados).
2. **Escalate:** si es RCE / auth bypass / data exfil → hotfix en el día.
3. **Fix path:** upgrade el paquete afectado. Si no hay upgrade, usar `overrides` en package.json para forzar la versión parcheada de la transitiva.
4. **Deploy hotfix:** merge → main → deploy Railway → verify + Sentry.
5. **Post-mortem:** doc en `docs/audit/YYYY-MM-DD-vuln-<name>.md` si fue P0.
