# Multi-Environment Drift — Anti-patterns & Guardrails

**Audiencia:** developers y operadores que tocan config multi-entorno (prod, staging, deploy-previews) — Netlify sites, migrations RLS, DBs Railway, env vars.

**TL;DR:** Cuando prod, staging, deploy-previews o dev tienen diferencias **no intencionales**, es "drift". Este proyecto sufrió 4 incidentes de drift entre 2026-07-27 y 2026-08-01 (uno de ellos P0 con 10h de downtime). Este doc consolida las 4 categorías, cómo detectarlas, cómo prevenirlas, y linkea el runbook específico de cada una.

## Índice

- [Categorías de drift observadas](#categorías-de-drift-observadas)
  - [1. Schema / permisos DB (RLS)](#1-schema--permisos-db-rls)
  - [2. Content headers (CSP)](#2-content-headers-csp)
  - [3. Env vars & config de site](#3-env-vars--config-de-site)
  - [4. Instancias DB por environment](#4-instancias-db-por-environment)
- [Diagnostic playbook](#diagnostic-playbook)
- [Runbook index (RLS)](#runbook-index-rls)
- [Runbook index (multi-env / staging)](#runbook-index-multi-env--staging)
- [Toxic assumptions (bookmark si tocás config multi-env)](#toxic-assumptions-bookmark-si-tocás-config-multi-env)

---

## Categorías de drift observadas

### 1. Schema / permisos DB (RLS)

**Síntoma:** una migration pasa CI verde pero rompe prod al deploy. El backend
entra en loop de crash <1s (`Starting Container → Stopping Container`).

**Casos históricos:**

| Fecha | Ticket | Root cause |
|---|---|---|
| 2026-07-27 | #874 | 7 tablas con `owner ≠ ipro_app` — `ipro_app` no puede `DROP POLICY` sobre tablas que no owns. Origen: tablas creadas por `postgres` superuser en migrations viejas |
| 2026-08-01 | #274 / #275 | `SET LOCAL row_security = off` + `UPDATE` sobre tabla con `FORCE ROW LEVEL SECURITY`. Con `FORCE` + owner sin `BYPASSRLS`, Postgres rechaza el UPDATE con hint específico |

**Guardrails activos:**

- **CI job `nosuperuser-rls`** (`.github/workflows/ci.yml`):
  - Step "Run NOSUPERUSER pool tests" — corre 6 smoke tests con role `ipro_app` NOSUPERUSER.
  - Step "Migrations from-scratch as ipro_app NOSUPERUSER (owner-of-schema)" (nuevo 2026-08-01) — crea DB fresca donde `ipro_app` es owner del schema, y corre TODAS las migrations desde cero como NOSUPERUSER. Si alguna migration usa un feature superuser-only (`BYPASSRLS`, `ALTER SYSTEM`, `SET LOCAL row_security = off` contra tabla FORCE RLS), este step revienta ANTES del merge con el mensaje exacto de Postgres.
- **Boot-time RLS invariant check** (`backend/src/lib/rlsCanonical.js`):
  - Al arrancar el backend, ejecuta `assertRlsCoverage` — 4 chequeos: (1) todas las tablas RLS tienen policy `tenant_isolation`, (2) tienen `FORCE ROW LEVEL SECURITY`, (3) `ipro_app` es owner, (4) el predicate contiene `NULLIF` (defense-in-depth contra el bug pattern de Sentry #16).
  - Sentry alert `rls_content_drift` throttled 1/h si detecta drift.
- **Runbook específico:** [`RUNBOOK_MIGRATION_RLS_FORCE.md`](RUNBOOK_MIGRATION_RLS_FORCE.md) — diagnostic checklist + fix pattern canónico + alternativas rechazadas.

**Pattern canónico para bulk UPDATE sobre tabla FORCE RLS** (dentro de la tx de la migration):

```sql
ALTER TABLE <tabla> NO FORCE ROW LEVEL SECURITY;
UPDATE <tabla> SET ...;
ALTER TABLE <tabla> FORCE ROW LEVEL SECURITY;
```

Si el UPDATE falla, ROLLBACK deja la tabla con FORCE RLS. Invariante preservado.

### 2. Content headers (CSP)

**Síntoma:** un site (prod, staging, deploy-preview) tiene CSP distinto del que
espera el dev, o de otros sites paralelos. Puede romper login (widget hCaptcha
bloqueado), bloquear conexiones al backend, o quedar más permisivo de lo intended.

**Casos históricos:**

| Fecha | Ticket | Root cause |
|---|---|---|
| 2026-07-26 → 07-30 | Reg. de Fix 10 Sprint 1 audit 07-25 | El CSP prod fue restringido a `backend-production` solamente. Se asumió que `[[context.production.headers]]` block del netlify.toml scopearía. **Falso** — solo `[[headers]]` global aplica. Consecuencia: staging + deploy previews (que apuntan a `backend-staging`) ROTOS por 4 días |
| 2026-07-30 | #254 (PR #943) | Migración landing a Astro omitió `https://*.hcaptcha.com` del CSP. Portal `/login` es SERVIDO via proxy 200 desde el landing → headers del landing wrappean la response del portal → widget invisible bloqueado → login roto |
| 2026-07-31 | #259 | Descubierto: `admin-staging.tecnyapp.com` era **alias** del site prod `tecny-admin`. Mismo bundle, mismo backend, mismo CSP. No había staging real de admin |

**Guardrails activos:**

- **Build-time `_headers` generation** (task #259, PR #955): cada build de Vite (portal + admin) genera `dist/_headers` con CSP restringido al backend específico del site. Portal-prod → `backend-production` only. Portal-staging → `backend-staging` only. Admin idem.
- **Spec canónica CSP** (`scripts/security/csp-spec.js`) — fuente de verdad. Exports `cspForSiteAndBackend()`, `KNOWN_BACKEND_URLS` (allowlist).
- **Test invariantes** (`scripts/security/csp-invariants.test.js`): 7 tests que verifican propiedades de seguridad de la spec.
- **Test parity** (`scripts/security/verify-csp-parity.js`): valida (a) el toml NO tiene CSP, (b) el generator produce headers alineados con la spec.
- **Test landing** (`scripts/security/verify-landing-csp-hcaptcha.js`): valida que el CSP del landing tiene los vendors críticos que el portal necesita en las rutas proxeadas (`/login`, `/signup`, `/forgot-password`).
- **Runbooks:** [`runbooks/csp-landing.md`](runbooks/csp-landing.md) (cambios al CSP landing) + secciones "Build-time `_headers` generation" y "Setup del site tecny-admin-staging".

**Regla operativa:** para headers distintos por context/branch/site, **NUNCA** usar `[[context.<X>.headers]]` blocks — son placebo (dead code). Usar build-time generation + eliminar el header conflictivo del toml (el toml GANA sobre `_headers` para el mismo header name).

### 3. Env vars & config de site

**Síntoma:** un site staging usa env vars incorrectas — típicamente `VITE_API_URL`
apuntando al backend equivocado, con la consecuencia de que "staging" en realidad
está pegándole a prod (o viceversa).

**Casos históricos:**

| Fecha | Ticket | Root cause |
|---|---|---|
| 2026-07-30 | #258 (PR #944) | Site `tecny-portal-staging` con primary branch `staging` heredaba `[build.environment]` global → `VITE_API_URL=backend-production`. Fix: `[context.staging.environment]` explícito en netlify.toml |
| 2026-07-31 | #259 continuación (PR #956) | Site `tecny-admin-staging` (recién creado) mismo bug. Netlify trata al primary branch de un site como **PRODUCTION context**, NO como branch-deploy |

**Guardrails activos:**

- **`[context.<X>.environment]` explícito** en cada `netlify.toml` para los env vars context-specific. Patrón aplicado:
  - `netlify.toml` root (portal): tiene `[context.staging.environment]` + `[context.deploy-preview.environment]` con `VITE_API_URL=backend-staging`.
  - `admin-frontend/netlify.toml`: mismo patrón desde PR #956.
- **Site setup procedure documentado** en [`runbooks/csp-landing.md`](runbooks/csp-landing.md) ("Setup del site tecny-admin-staging (creado 2026-07-31)") — replicable para crear sites nuevos con 6 curl commands.
- **Regression check post-deploy:**
  ```bash
  curl -sI https://tecnyapp.com/         | grep -i content-security-policy | tr ';' '\n' | grep connect-src
  # → debe contener tecny-backend-production, NO tecny-backend-staging
  curl -sI https://staging.tecnyapp.com/ | grep -i content-security-policy | tr ';' '\n' | grep connect-src
  # → debe contener tecny-backend-staging, NO tecny-backend-production
  ```

### 4. Instancias DB por environment

**Síntoma:** al aplicar un fix operativo en prod DB, asumimos que staging ya está
igual porque "el hostname interno es el mismo". Falso.

**Caso histórico:** 2026-07-27 — cuando cerramos el RLS drift la primera vez
(#903), asumimos que `postgres-auep.railway.internal` resolvía a la misma
instancia desde ambos environments. **Cada environment tiene su propia instancia
del service `Postgres-AueP` con su propio storage.** El hostname interno resuelve
distinto según el env desde el que se accede.

**Consecuencia:** cualquier procedimiento operativo (fix RLS, patch manual,
backfill via SQL directo) debe aplicarse **en cada environment por separado**.

**Guardrails activos:**

- **Runbook explícito:** [`RUNBOOK_RLS_OWNER_FIX.md`](RUNBOOK_RLS_OWNER_FIX.md) — sección "⚠️ Postgres tiene instancias SEPARADAS por environment" + Step 4 "Repetir en staging".
- **Connection strings por env** documentadas en el mismo runbook (Step 2 "Connect strings por environment").

---

## Diagnostic playbook

### ¿Prod y staging tienen el mismo CSP?

```bash
diff <(curl -sI https://tecnyapp.com/         | grep -i content-security-policy) \
     <(curl -sI https://staging.tecnyapp.com/ | grep -i content-security-policy)
# Deberían diferir SOLO en el backend URL (production vs staging).
```

Si difieren en otros vendors o directives → drift real, ir a la sección
[Content headers (CSP)](#2-content-headers-csp).

### ¿Un bundle staging apunta al backend correcto?

```bash
# Verificar el bundle deploy-preview / staging
curl -s https://staging.tecnyapp.com/ | grep -oE 'assets/[^"]+' | head -3
# Pull el JS y buscar la URL del backend en el bundle
curl -s "https://staging.tecnyapp.com/assets/<HASH>.js" | grep -oE 'tecny-backend-[a-z]+\.up\.railway\.app' | sort -u
# → debe imprimir SOLO tecny-backend-staging.up.railway.app
```

### ¿RLS ownership es el mismo en prod y staging?

```bash
# Requiere superuser access al DB de cada env (rol postgres).
railway run --service tecny-backend --environment production \
  psql "$DATABASE_URL" -f scripts/security/diagnose-rls-drift.sql

railway run --service tecny-backend --environment staging \
  psql "$DATABASE_URL" -f scripts/security/diagnose-rls-drift.sql
```

Output debería ser idéntico en ambos envs (todas las tablas OK, 0 en drift). Si
diferencia → aplicar [`RUNBOOK_RLS_OWNER_FIX.md`](RUNBOOK_RLS_OWNER_FIX.md) en el
env drifteado.

### ¿El guardrail de CI está corriendo?

Chequear en un PR reciente que el step "Migrations from-scratch as ipro_app
NOSUPERUSER (owner-of-schema)" aparece verde en el job `NOSUPERUSER RLS Tests`.
Duración esperada: ~30-60s. Si NO aparece o falla → el fix del CI (2026-08-01)
está desactivado o rompió.

---

## Runbook index (RLS)

| Runbook | Cuándo usarlo |
|---|---|
| [`RUNBOOK_MIGRATION_RLS_FORCE.md`](RUNBOOK_MIGRATION_RLS_FORCE.md) | Migration falla en prod deploy con `ERROR: query would be affected by row-level security policy` |
| [`RUNBOOK_RLS_OWNER_FIX.md`](RUNBOOK_RLS_OWNER_FIX.md) | Boot warning `rls_content_drift` o migration falla con `must be owner of relation ...` |
| [`runbooks/rls-bulk-migration.md`](runbooks/rls-bulk-migration.md) | Escribir migration con bulk `UPDATE` sobre tabla FORCE RLS multi-tenant (guía preventiva) |
| [`RUNBOOK.md`](RUNBOOK.md) sección "Multi-tenant activar role NOSUPERUSER en prod (TANDA 0c)" | Setup inicial del role `ipro_app` NOSUPERUSER en un environment nuevo |

## Runbook index (multi-env / staging)

| Runbook | Cuándo usarlo |
|---|---|
| [`STAGING.md`](STAGING.md) | Setup inicial del env staging (bootstrapping) |
| [`NETLIFY_BUILDS.md`](NETLIFY_BUILDS.md) | Deploy Netlify skipped o double-deploy race |
| [`runbooks/csp-landing.md`](runbooks/csp-landing.md) | Cambiar CSP del landing sin romper login del portal + patrón build-time `_headers` para portal/admin + setup site tecny-admin-staging |
| [`runbooks/monitor-railway-deploys.md`](runbooks/monitor-railway-deploys.md) | Monitorear deploys Railway en tiempo real |

---

## Toxic assumptions (bookmark si tocás config multi-env)

Cada una destapada por un incidente real. Documentadas acá para que la próxima
vez que aparezcan mentalmente, las corte de raíz.

1. **"Netlify context-specific headers funciona."**
   Falso. `[[context.<X>.headers]]` blocks son dead code — solo `[[headers]]`
   global aplica en runtime. Confirmado empíricamente + community threads + docs
   oficiales. Ver [`runbooks/csp-landing.md`](runbooks/csp-landing.md) sección
   "Netlify context-specific headers limitation".
   → Workaround: build-time generation de `_headers`.

2. **"Prod y staging comparten la DB Postgres-AueP porque el hostname interno es el mismo."**
   Falso. Cada env tiene su propia instancia con su propio storage. El hostname
   resuelve distinto según el env desde el que se accede. Ver
   [`RUNBOOK_RLS_OWNER_FIX.md`](RUNBOOK_RLS_OWNER_FIX.md) sección "⚠️ Postgres
   tiene instancias SEPARADAS por environment".

3. **"CI corre migrations con el mismo role que prod."**
   Falso hasta 2026-08-01. CI corría como SUPERUSER (bypassea RLS incluso con
   FORCE). Prod corre como NOSUPERUSER (no bypassea). Migrations con features
   superuser-only pasaban CI verde y rompían prod. Cerrado con nuevo step
   "Migrations from-scratch as ipro_app NOSUPERUSER (owner-of-schema)" del job
   `nosuperuser-rls`.

4. **"Site staging tiene su config staging por default cuando el primary branch es staging."**
   Falso. Netlify trata al primary branch de un site como **PRODUCTION** context
   (no como branch-deploy). Sin `[context.staging.environment]` explícito en el
   netlify.toml del site, el bundle hereda `[build.environment]` global — que
   probablemente apunta al backend de prod. Ver PR #944 (portal) / PR #956
   (admin) para el patrón correcto.

5. **"Emails 'Build failed!' de Railway == build falló."**
   Puede ser deploy falló (post-build, en el step `npm run migrate` del start
   command). Los logs pueden morir con el container antes de que stderr flushee
   al log store. **Diagnosticar reproduciendo la operación directo contra la DB
   con `psql BEGIN/ROLLBACK`** en lugar de esperar logs. Ver
   [`RUNBOOK_MIGRATION_RLS_FORCE.md`](RUNBOOK_MIGRATION_RLS_FORCE.md) sección
   "Diagnostic checklist".

6. **"El `[[headers]]` toml y el `dist/_headers` son intercambiables."**
   Falso. Para el mismo header name, **toml GANA**. Confirmado empíricamente con
   marker header en PR #955 y respaldado por [docs oficiales](https://docs.netlify.com/routing/headers/):
   *"Custom headers set in the netlify.toml take precedence over those set in
   the _headers file."* Consecuencia: si querés que un header sea generado
   dinámicamente en el build → sacarlo del toml completamente. Dejar los dos
   con contenido distinto = el toml pisa el trabajo del generator.

---

## Referencias

**Post-mortems:**
- Task #239 — Fix zombie routing staging (drift #1 identificado)
- Task #258 — Fix [context.staging] explícito (PR #944)
- Task #259 — Build-time `_headers` generation (PR #955)
- Tasks #274 / #275 — P0 migration RLS FORCE (2026-08-01, 10h downtime)

**Decisiones durables** (ver `memory/state_2026-07-20.md`):
- **46** — Verificar empíricamente Netlify config post-cambio de headers.
- **47** — Headers scope requiere build-time generation.
- **48** — CSP hardening requiere per-site config.
- **52** — Netlify precedence toml > `_headers` (para el mismo header name).
- **53** — Diagnostic marker headers para verificar cuál file aplica.
- **54** — Failure mode graceful "menos hardened no roto".
- **55** — Netlify API workflow para site linkeado (3 PATCHes secuenciales).
- **56** — Site primary branch = staging trata como PRODUCTION context, no branch-deploy.
- **57** — FORCE RLS es default del proyecto (53 de 57 tablas) — anti-pattern usar `SET LOCAL row_security = off`.
- **58** — Diagnóstico migration failure empírico (psql directo) > logs Railway.
- **59** — CI que solo corre migrations como SUPERUSER es fake safety net.
- **60** — Emails "Build failed!" de Railway pueden referirse al deploy step (post-build).

**Scripts de diagnóstico:**
- `scripts/security/diagnose-rls-drift.sql` — 3 queries para verificar ownership + predicate content de las 7 tablas históricamente drifteadas.
- `scripts/security/verify-csp-parity.js` — invariante toml sin CSP + generator alineado con spec.
- `scripts/security/verify-landing-csp-hcaptcha.js` — vendors críticos en CSP del landing.
