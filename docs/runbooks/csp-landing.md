# Runbook — Cambiar el CSP del landing sin romper el login

**Fecha:** 2026-07-30 (postmortem del P0 login bloqueado).
**Aplica a:** cualquier cambio al `Content-Security-Policy` del site `tecny-landing` — sea agregar/remover un vendor externo, endurecer/aflojar directives, o refactorizar a hashes.

## TL;DR

El landing sirve **también** las pantallas de auth del portal (`/login`, `/signup`, `/forgot-password`) via proxy 200. Los headers CSP que aplican en esas pantallas son los del **landing** (Netlify wrappea la response del proxy con los headers del site). Si el CSP del landing no permite un vendor que el portal necesita en esas pantallas → login roto sin diagnóstico obvio.

**Antes de mergear cualquier cambio al CSP del landing:** correr `npm run verify:landing-csp-hcaptcha` (contract test que corre también en CI).

## Contexto del incidente

El 2026-07-30 a la mañana Lucas no podía loguearse — el widget invisible de hCaptcha no aparecía y el backend rechazaba con "Verificación inválida". 4 horas de detour para diagnosticar.

**Root cause:** la migración del landing a Astro (PRs #936/#937 del 2026-07-29) creó un CSP nuevo, más estricto, que **omitió `https://*.hcaptcha.com`**. El landing no usa hCaptcha directamente, así que el omit pasó el review. Pero `/login`, `/signup`, y `/forgot-password` — que son pantallas del PORTAL — se sirven via proxy 200 desde el landing (catch-all `/* → tecny-portal.netlify.app/:splat`). En ese pattern de Netlify, los headers del site landing wrappean la response del proxy, así que el CSP que ve el browser es el del landing, NO el del portal.

Sin hcaptcha en `script-src`, `style-src`, `connect-src`, y `frame-src` del landing, el widget no cargaba → nunca generaba token → el backend rechazaba con 400.

## Arquitectura relevante — por qué esto es sutil

```
Browser → tecnyapp.com/login
  → Netlify site tecny-landing recibe request
  → No matchea static file en dist/ → cae al catch-all
  → Proxy 200 a tecny-portal.netlify.app/login
  → Response wrapped con headers de tecny-landing (incluye CSP)
  → Browser recibe HTML del portal + CSP del landing
```

**Consecuencia:** el CSP del landing es la **superficie efectiva** de TODAS las páginas del portal servidas via proxy. Cualquier vendor que el portal use en esas páginas debe estar en el CSP del landing.

Pantallas del portal servidas via proxy actualmente (2026-07-30):
- `/login` — hCaptcha invisible
- `/signup` — hCaptcha invisible
- `/forgot-password` — hCaptcha invisible
- `/inicio`, `/ventas`, `/cajas`, `/inventario`, etc. — SPA routes (usan mismo bundle, algunos features requieren vendors adicionales)
- `/publico/usados/:token` — share links públicos
- `/assets/*.js`, `/assets/*.css` — bundle del SPA

Si mañana el portal agrega Stripe, Datadog RUM, Intercom, u otro vendor crítico, hay que agregarlo al CSP del **landing**, no solo al del portal.

## Los 2 files donde vive el CSP

El CSP del landing existe **duplicado** en 2 files por razones de cache invalidation:

### 1. `landing/netlify.toml`

```toml
[[headers]]
  for = "/*"
  [headers.values]
    Content-Security-Policy = "default-src 'self'; script-src 'self' ..."
```

Es la fuente canónica. Se aplica al build.

### 2. `landing/public/_headers`

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' ...
```

Es el **fallback runtime**. El edge cache de Netlify a veces no invalida cambios del `.toml` inmediatamente (visto en producción — un cambio de CSP tardó horas en propagarse). El file `_headers` se sirve directo desde el build, sin intermediación de config.

**Precedencia real** (task #259, 2026-07-31): para headers definidos en AMBOS files, el `netlify.toml` **gana** — confirmado empíricamente + [docs oficiales de Netlify](https://docs.netlify.com/routing/headers/). En el landing (Astro) esta duplicación funciona porque ambos files tienen contenido idéntico; si divergen, aplica el toml. El contract test valida sincronización.

**Regla:** cualquier cambio al CSP del landing DEBE hacerse en **ambos** files sincronizados. El contract test (ver abajo) valida esto.

**Para el portal + admin**: patrón distinto — el CSP **solo vive en `_headers`** (generado en build-time), NO en el toml. Ver sección "Build-time _headers generation" abajo.

## Los tokens obligatorios

Actualmente (2026-07-30), el CSP del landing DEBE incluir `https://*.hcaptcha.com` en las 4 directives siguientes:

- `script-src` — el snippet del widget
- `style-src` — los styles del iframe
- `connect-src` — el POST del token al backend de hCaptcha
- `frame-src` — el iframe del challenge visual (si el user falla el invisible)

Si a futuro se agregan otros vendors críticos, actualizar el array `REQUIRED_TOKENS` en `scripts/security/verify-landing-csp-hcaptcha.js`.

## Cómo cambiar el CSP paso a paso

### Escenario A — agregar un vendor nuevo

Ejemplo: agregar Stripe.

1. **Identificar directives necesarias** — leer la doc del vendor. Stripe requiere:
   - `script-src https://js.stripe.com`
   - `frame-src https://js.stripe.com https://hooks.stripe.com`
   - `connect-src https://api.stripe.com`

2. **Editar `landing/netlify.toml`** — agregar los tokens a las directives listadas. Mantener el orden alfabético dentro de cada directive.

3. **Editar `landing/public/_headers`** — mismo cambio, verbatim.

4. **Actualizar `scripts/security/verify-landing-csp-hcaptcha.js`** — agregar entry al array `REQUIRED_TOKENS`:
   ```js
   {
     token: 'https://js.stripe.com',
     directives: ['script-src', 'frame-src'],
     reason: 'Stripe.js en checkout de suscripciones',
   },
   ```

5. **Correr el check local**:
   ```bash
   npm run verify:landing-csp-hcaptcha
   ```
   Exit 0 = ambos files tienen los tokens requeridos. Exit 1 = falta algo, el output dice cuál file y directive.

6. **Correr el test de CSP parity** (por si tocaste otro CSP también):
   ```bash
   npm run verify:csp
   ```

7. **Deploy** — PR normal. El check corre en CI (job `Landing CSP hcaptcha anti-regression` en `.github/workflows/ci.yml`).

### Escenario B — remover un vendor obsoleto

1. **Confirmar que ninguna pantalla del portal servida via proxy lo usa**. Grep en `frontend/` por el vendor. Si no hay hits, seguir.

2. **Verificar el listado de rutas proxeadas arriba en este runbook**. Si el vendor solo se usaba en una ruta que ya no se proxea, safe. Si no, buscar reemplazo antes de tocar el CSP.

3. **Editar ambos files** (`landing/netlify.toml` y `landing/public/_headers`) — remover el token de todas las directives donde aparecía.

4. **Actualizar `REQUIRED_TOKENS`** — remover la entry si el vendor estaba enforced.

5. **Deploy con canary** — mergear a staging primero, testear login/signup/forgot-password manualmente, y luego prod.

### Escenario C — endurecer 'unsafe-inline'

Actualmente `script-src` tiene `'unsafe-inline'` por el snippet inline de Meta Pixel (comentario en `landing/netlify.toml` línea 66 explica el trade-off). Si querés migrar a `sha256-XXX=`:

1. Calcular el hash SHA256 del snippet EXACTO:
   ```bash
   echo -n "<contenido del snippet inline>" | openssl dgst -sha256 -binary | openssl base64
   ```

2. Reemplazar `'unsafe-inline'` por `'sha256-XXX='` en ambos files.

3. **Testear en deploy preview PRIMERO** — cualquier variación (whitespace, salto de línea) invalida el hash.

4. Si el snippet cambia (Meta rota su script), el hash queda inválido y CSP bloquea → pixel no dispara → tracking roto. Documentar el proceso de re-cálculo del hash cerca del snippet.

## Verificación manual post-deploy

Después de mergear un cambio al CSP:

1. **Purge cache Netlify** (opcional pero recomendado):
   ```bash
   curl -X POST "https://api.netlify.com/api/v1/sites/<SITE_ID>/purge_cache" \
     -H "Authorization: Bearer $NETLIFY_AUTH_TOKEN"
   ```
   (Site ID de tecny-landing: `d900359b-...`, ver `docs/NETLIFY_BUILDS.md`.)

2. **Verificar el header con curl**:
   ```bash
   curl -sI https://tecnyapp.com/login | grep -i content-security-policy
   ```
   Confirmar que el token nuevo aparece.

3. **Abrir `/login` en incognito** (evitar cache del browser). Abrir DevTools → Console. Si hay bloqueos CSP, aparecen como:
   ```
   Refused to load the script 'https://xxx' because it violates the following Content Security Policy directive: "script-src ..."
   ```

4. **Test funcional** — intentar login con credenciales válidas. Si el captcha widget renderiza y el submit exitoso, OK.

5. **Repetir para `/signup` y `/forgot-password`**.

## Netlify context-specific headers limitation

**Descubierto 2026-07-30 durante el staging drift diagnóstico.**

Netlify docs implican que `[[context.<X>.headers]]` blocks scopean headers por deploy context (production, branch-deploy, deploy-preview, o un branch específico). En la práctica, **NO funcionan** — son dead code.

Solo `[context.<X>.environment]` respeta el context. Los headers blocks context-específicos NUNCA se aplican en runtime. Confirmado empíricamente + community threads + docs de soporte de Netlify. El único header block que gana es `[[headers]]` global.

Consecuencias:

- `[[context.deploy-preview.headers]]` con CSP diferente → ignorado. Deploy previews reciben `[[headers]]` global.
- `[[context.branch-deploy.headers]]` con report-uri distinto → ignorado.
- `[[context.staging.headers]]` (branch específico) → ignorado.

**Impacto pasado**: el "Fix 10" del audit 07-25 (Sprint 1) intentó restringir el CSP de prod a `backend-production` solamente (hardening contra XSS-exfil-a-staging). Como el `[[headers]]` global es el único que aplica, ese cambio ALSO bloqueó las requests desde staging + deploy previews (que apuntan a `backend-staging` vía VITE_API_URL). Regressed 2026-07-30 (ambos backends permitidos en el CSP global) para restaurar funcionalidad.

**Workaround oficial de Netlify**: usar el build command para copiar un `_headers` file dinámicamente al `dist/` según el context detectado (via env var `CONTEXT` o `VITE_API_URL`). Y — importante — quitar el header equivalente del `[[headers]]` toml (ver "Precedencia" en la siguiente sección: toml gana sobre `_headers` para el mismo header name; si dejás ambos, el toml pisa el trabajo del generator).

**Fix implementado (task #259, 2026-07-31)** — ver siguiente sección.

**Regla operativa**: si querés headers distintos por context/branch/site, NO uses `[[context.<X>.headers]]` blocks — son placebo. Usá build-time generation + eliminá el header conflictivo del toml.

## Build-time `_headers` generation (task #259)

**Aplica a los sites**: `tecny-portal`, `tecny-portal-staging`, `tecny-admin`, `tecny-admin-staging`.

**No aplica al landing** (`tecny-landing`) — el landing tiene su propio pipeline (Astro + `landing/public/_headers`) y no consume `VITE_API_URL`; ver secciones anteriores.

### Precedencia Netlify — cazado por PR #955

Antes de mergear task #259 asumimos (basado en el runbook viejo del landing) que `_headers` **ganaba** sobre `[[headers]]` toml. Falso — [los docs oficiales](https://docs.netlify.com/routing/headers/) dicen lo contrario:

> Custom headers set in the netlify.toml take precedence over those set in the _headers file. This means if the same header is set in both files, the netlify.toml version is used.

Confirmado empíricamente con un marker header en PR #955: cuando toml + _headers definían ambos el CSP, la response mostraba el CSP del **toml**. El marker header (solo en _headers) sí aparecía → el _headers file se aplica, pero PIERDE contra toml para el mismo header name.

**Consecuencia del patrón implementado**: el CSP del portal + admin vive **exclusivamente en `dist/_headers`**. El `[[headers]]` toml define X-Frame-Options / HSTS / etc. (headers que no cambian por site) pero NO CSP.

### El patrón

Cada build de Vite del portal (`frontend/`) y del admin (`admin-frontend/`) corre un post-build que genera `dist/_headers` con el CSP RESTRINGIDO al backend específico del site deployed:

- Portal prod (`tecnyapp.com`, `VITE_API_URL=backend-production`) → CSP permite SOLO `tecny-backend-production`.
- Portal staging (`staging.tecnyapp.com`, `VITE_API_URL=backend-staging`) → CSP permite SOLO `tecny-backend-staging`.
- Admin prod (`admin.tecnyapp.com`) → mismo criterio.
- Admin staging (`admin-staging.tecnyapp.com`) → mismo criterio.
- Deploy previews (PR builds) → CSP restringido a staging.

**Failure mode**: si el generator falla, el `dist/_headers` no existe → el `[[headers]]` toml NO tiene CSP → browser aplica policy default (sin restricción). Estado equivalente al pre-task-#259. NO es P0 — es "menos hardened", no "roto".

### Los archivos involucrados

- `scripts/security/csp-spec.js` — spec canónica (fuente de verdad). Exports `cspForSiteAndBackend(site, backendUrl)`, `formatCsp(dict)`, `trustedTypesReportOnlyFor(backendUrl)`, `KNOWN_BACKEND_URLS` (allowlist).
- `frontend/scripts/generate-headers.mjs` — post-build del portal. Lee `VITE_API_URL`, valida contra allowlist, escribe `frontend/dist/_headers`.
- `admin-frontend/scripts/generate-headers.mjs` — espejo del admin.
- `frontend/package.json` / `admin-frontend/package.json` — el script `build` corre `vite build && npm run generate:headers`.
- `netlify.toml` / `admin-frontend/netlify.toml` — el `[[headers]]` global tiene HSTS, X-Frame-Options, etc. **NO tiene CSP** (invariante de `verify-csp-parity.js`).

### Cómo cambiar el CSP del portal/admin

1. **Editar `scripts/security/csp-spec.js`** — actualizar `COMMON_DIRECTIVES`, `SITE_DIFFERENCES`, o agregar tokens al site que aplique. Este es el único lugar canónico.

2. **Correr tests**: `node --test scripts/security/csp-invariants.test.js` (invariantes de seguridad + 7 tests del hardening #259).

3. **Correr parity check**: `node scripts/security/verify-csp-parity.js`. Valida DOS invariantes: (a) el toml NO tiene CSP; (b) el generator produce headers alineados con la spec.

4. **NO tocar netlify.toml para cambios de CSP** — es un invariante que el toml NO tenga CSP. Si necesitás agregar/quitar un header que sí va en toml (HSTS, X-Frame, etc.), editar el `[[headers]]` global directamente.

5. **Deploy** — al build, cada site genera su `dist/_headers` con el CSP restringido.

6. **Verificar post-deploy**:
   ```bash
   curl -sI https://tecnyapp.com/ | grep -i content-security-policy
   # → debe contener backend-production, NO backend-staging
   curl -sI https://staging.tecnyapp.com/ | grep -i content-security-policy
   # → debe contener backend-staging, NO backend-production
   ```

### Agregar un backend URL nuevo (raro)

Si Tecny agrega un backend regional (ej. `tecny-backend-mx.up.railway.app`):

1. Editar `scripts/security/csp-spec.js:KNOWN_BACKEND_URLS` — agregar la URL.
2. Correr los tests: `node --test scripts/security/csp-invariants.test.js`.
3. Setear `VITE_API_URL` del site nuevo en Netlify UI o en el toml correspondiente.

Si NO se agrega a `KNOWN_BACKEND_URLS`, el build del site nuevo va a FALLAR loud con:
```
[generate-headers] ERROR: VITE_API_URL no reconocido: "https://tecny-backend-mx..."
```
Defense-in-depth intencional: un `VITE_API_URL` typo/malicioso NO puede legitimarse silenciosamente en el CSP.

### Cuándo NO usar este patrón

- Si el header debe ser IDÉNTICO en todos los contexts → mantener en `[[headers]]` global y punto.
- Si el header depende de algo que Netlify no expone en build (ej. request headers) → usar Edge Function.
- Si el sitio NO tiene build step (static hosted directo) → generar `_headers` manualmente y commitearlo.

### Rollback

Si el _headers dinámico rompe algo:

1. Revertir el commit que introdujo el patrón.
2. Como fallback rápido: agregar un CSP permisivo al `[[headers]]` toml (ambos backends). Eso restaura el estado pre-#259.
3. Diagnosticar el fallo en local con `VITE_API_URL=... node frontend/scripts/generate-headers.mjs`.

## Cache invalidation gotcha (edge cache Netlify)

El edge cache de Netlify a veces persiste responses con headers viejos hasta ~6h después del deploy — visto en el P0 del 2026-07-30 donde el CSP fix estaba live pero el browser seguía recibiendo el CSP viejo. Signos:

- `curl -I` desde tu máquina muestra header nuevo
- Browser en incognito muestra header nuevo
- Un browser específico (usualmente el que ya tenía sesión) sigue mostrando header viejo

**Root cause:** las requests proxeadas (/login, /signup, /forgot-password) tenían cacheable responses. Con headers viejos cacheados en edge, el purge API respondía 202 pero no invalidaba.

**Fix aplicado:** los 3 redirects tienen `Cache-Control: no-store, no-cache, must-revalidate` en `[redirects.headers]`. Cada request va al origen, sin edge cache. Ver `landing/netlify.toml` líneas 169-191.

**Regla:** si agregás una ruta nueva del portal al proxy (algo que no sea static del landing), agregar el mismo bloque `[redirects.headers]` con `no-store` para evitar el mismo problema.

## Rollback plan

Si un cambio al CSP rompe algo en producción:

1. **Revert inmediato** — `git revert <commit>` y push. El deploy tarda ~2-3 min.

2. **Purge cache** con el curl de arriba.

3. **Verificar con incognito** que el CSP viejo volvió.

4. **Analizar en local** — hacer el cambio incremental, testear en deploy preview antes de re-mergear.

## Testing en deploy preview

Cada PR crea un deploy preview del landing en `https://deploy-preview-<PR>--tecny-landing.netlify.app/`. El proxy al portal en el preview apunta al mismo `tecny-portal.netlify.app` de siempre, así que podés testear `/login` en el preview y ver el CSP nuevo aplicado a la pantalla real del portal.

**Nota:** el preview usa el CSP del PR, así que si el PR tiene un CSP roto, el login en el preview va a fallar de la misma forma que fallaría en prod. Es un test funcional real.

## Referencias

- `scripts/security/verify-landing-csp-hcaptcha.js` — el contract test que corre en CI
- `landing/netlify.toml` — fuente canónica del CSP
- `landing/public/_headers` — fallback runtime
- `docs/CSP.md` — CSP del portal (netlify.toml root) — no confundir
- `docs/NETLIFY_BUILDS.md` — pattern de deploy Netlify + purge API
- P0 del 2026-07-30 — hotfix hcaptcha + contract test (PRs #943/#945)
