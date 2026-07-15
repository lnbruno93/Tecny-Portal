# Observabilidad — Tecny Portal

Guía operacional: cómo configurar y verificar el error tracking de las 3 apps
(backend + portal + admin) con **Sentry**.

Ultimo update: 2026-07-15 (task #137)

---

## TL;DR — Lo que necesitás saber en 30 segundos

- **Backend**: `Sentry.init()` en `backend/server.js`. User context (tenant_id/user_id) seteado
  automáticamente por `middleware/auth.js`. 23 `captureException()` explícitos en jobs críticos.
- **Portal + Admin**: NO usan `@sentry/react` (ahorra ~30kb gz). Envían errores al backend
  vía `POST /api/client-errors` → backend forwards a Sentry.
- **Todo es opt-in**: sin las env vars, el código es un no-op silencioso (no rompe nada).
- **Source maps**: `@sentry/vite-plugin` sube maps a Sentry en cada Netlify build (si el token
  está configurado); los `.map` se borran del bundle público post-upload.

Si sospechás que Sentry está apagado en prod, revisá **[Checklist de activación](#checklist-de-activación-en-producción)** más abajo.

---

## Arquitectura

```
┌──────────────┐        ┌──────────────┐
│ Portal user  │──error─┤              │
│ (frontend)   │ POST   │ Backend      │
└──────────────┘        │ /api/client- │──captureMessage──▶ Sentry (project tecny-portal-backend)
                        │ errors       │                    · release=<commit_short>
┌──────────────┐        │              │                    · tags: source, build_commit
│ Admin        │──error─┤ (sin auth,   │
│ (admin FE)   │ POST   │  rate-lim.)  │
└──────────────┘        └──────┬───────┘
                               │
                               │ .setUser({ tenant_id, user_id })
                               ▼
                        ┌──────────────┐
                        │ auth         │
                        │ middleware   │
                        └──────────────┘
```

**Por qué esta arquitectura** (decisión durable 2026, ver `frontend/src/lib/reportError.js`):

- No requerimos `@sentry/react` en el bundle público → -30kb gzipped por app frontend.
- Un solo lugar donde configurar release/environment/tags: el backend.
- El endpoint `/api/client-errors` tiene rate limit (60 req/min/IP) + filtro de ruido
  (`NOISE_PATTERNS`) idéntico al del frontend → doble defensa contra floods.
- El request de reporte NO requiere auth → funciona incluso si la sesión expiró.

---

## Env vars por servicio

### Backend (Railway)

| Var                         | Requerida | Ejemplo                                              | Notas                                                         |
|-----------------------------|-----------|------------------------------------------------------|---------------------------------------------------------------|
| `SENTRY_DSN`                | **sí**    | `https://xxx@o123.ingest.sentry.io/456`              | Sin esto, Sentry no envía nada. Sentry.init() es no-op.        |
| `RAILWAY_GIT_COMMIT_SHA`    | auto      | (Railway lo setea automáticamente)                   | Se usa como `release` — matchea con el frontend.               |

**Cómo setear:**
```bash
railway variables --set SENTRY_DSN=https://xxx@o123.ingest.sentry.io/456
```

O vía UI: `tecny-backend` service → Variables → New Variable.

### Portal (Netlify — site `tecny-portal`)

| Var                    | Requerida | Ejemplo                                              | Notas                                                         |
|------------------------|-----------|------------------------------------------------------|---------------------------------------------------------------|
| `VITE_API_URL`         | **sí**    | `https://tecny-backend-production.up.railway.app`    | Ya seteada. Sin esto reportError es no-op + warn.              |
| `SENTRY_AUTH_TOKEN`    | opcional  | `sntrys_abc...`                                      | Build-time. Sube source maps a Sentry. Sin esto los maps no se suben. |
| `SENTRY_ORG`           | opcional  | `bruno-iu`                                           | **El slug real de la org es `bruno-iu`** (no `lnbruno`). Verificable en cualquier URL de Sentry. Default del código sigue siendo `'lnbruno'` por compat, pero prod usa `bruno-iu`. |
| `SENTRY_PROJECT`       | opcional  | `tecny-portal-frontend`                              | Default `'tecny-portal-frontend'`.                            |
| `COMMIT_REF`           | auto      | (Netlify lo setea automáticamente)                   | Se usa como `release`.                                        |

### Admin (Netlify — site `tecny-admin`)

Mismo esquema que portal, con:
- `SENTRY_PROJECT` default = `'tecny-portal-admin'`
- Todo lo demás es idéntico.

**Cómo setear:**
Netlify UI → site settings → Environment variables → Add variable.

---

## Setup inicial (una sola vez, si nunca se hizo)

### 1. Crear cuenta / proyectos en Sentry

En https://sentry.io:
1. Login o crear cuenta free (5k errors/mes es suficiente para ~10 tenants).
2. En la org (slug real: **`bruno-iu`**), crear 3 proyectos:
   - **`tecny-portal-backend`** — Platform: **Node.js**
   - **`tecny-portal-frontend`** — Platform: **React**
   - **`tecny-portal-admin`** — Platform: **React**
3. Para cada uno: `Settings → Client Keys (DSN)` → copiar el DSN.
4. Crear un **Auth Token**: `Settings → Auth Tokens → Create New Token`.
   - Scopes: `project:releases`, `project:read`, `org:read`
   - Guardarlo — solo se muestra una vez.

### 2. Configurar env vars

Ver la sección **[Env vars por servicio](#env-vars-por-servicio)** arriba.

### 3. Trigger el primer deploy

- Railway se redeploya solo en el próximo push a `main`.
- Netlify también.

### 4. Verificar

Ver **[Checklist de activación](#checklist-de-activación-en-producción)**.

---

## Checklist de activación en producción

Copiar y ejecutar en orden. Todo verificable sin credenciales de terceros.

### ✅ Backend

```bash
# 1. Health check muestra el commit correcto
curl -s https://tecny-backend-production.up.railway.app/health | jq .commit
# → debería devolver el short SHA del último merge a main

# 2. Verificar env var (requiere acceso a Railway)
railway variables | grep SENTRY_DSN
# → debería aparecer con valor (no vacío)

# 3. Trigger deliberado — endpoint de test (a implementar):
curl -X POST https://tecny-backend-production.up.railway.app/api/_debug/trigger-error \
  -H "Authorization: Bearer <token>"
# → 500. En Sentry debería aparecer el evento en < 1 min.
```

### ✅ Portal frontend

```bash
# 1. Abrir DevTools → Network → filtrar por 'client-errors'
# 2. En consola:
throw new Error('TEST_SENTRY_PORTAL_' + Date.now());
# 3. Buscar en Network: POST /api/client-errors con status 204
# 4. En Sentry (project tecny-portal-frontend o backend): el evento aparece con tag source='frontend'
```

### ✅ Admin frontend

Idem portal, con:
- Dominio: `admin.tecnyapp.com`
- Sentry tag: `source='admin:*'`
- Proyecto Sentry: `tecny-portal-admin` (o el backend si compartís proyecto)

---

## Qué se captura automáticamente

### Backend

- **Uncaught exceptions** en handlers Express (`Sentry.setupExpressErrorHandler(app)`).
- **User context** (`tenant_id`, `user_id`, `email_verified`, `is_super_admin`, `twofa_enabled`)
  seteado por `middleware/auth.js` post-verificación JWT.
- **Explicit captures** en 23 sitios críticos: jobs (audit worker, chat cleanup, invariants,
  paid_until warnings, partitions), ventaSync, redisClient, audit.js.
  - Patrón: `Sentry.captureException(err, { tags: { component: 'X', step: 'Y' }, extra: {...} })`.

### Frontend (portal + admin)

- **Errores no manejados**: `window.onerror` + `unhandledrejection` vía `installGlobalErrorHandlers()`.
- **Errores de React**: `<ErrorBoundary>` en `main.jsx` llama a `reportError()` con
  `component_stack` para debug.
- **Sin auto-capture de**: fetch failures del usuario (los manejamos con toast + retry;
  reportarlos ensuciaría Sentry con ruido transient).

---

## Filtros de ruido (`NOISE_PATTERNS`)

Los siguientes errores **NO** llegan a Sentry (ni backend ni frontend los reportan):

| Patrón                              | Por qué se ignora                                       |
|-------------------------------------|---------------------------------------------------------|
| `Sin conexión con el servidor`      | Mensaje interno al usuario cuando fetch falla — no bug. |
| `NetworkError / Failed to fetch`    | Wifi del user, no del código.                           |
| `AbortError / operation was aborted`| User navegó/cerró antes de que respondiera un request.  |
| `Loading chunk X failed`            | Bundle stale post-deploy — manejado por `chunkReload.js`. |
| `NO_AUTH` / `No tenés permiso`      | 401/403 esperados, ya manejados por UI.                 |

Definidos en:
- Frontend: `frontend/src/lib/reportError.js` (`NOISE_PATTERNS`)
- Admin:    `admin-frontend/src/lib/reportError.js` (mismo array)
- Backend:  `backend/src/lib/clientErrorNoise.js` (`isClientErrorNoise`, filtro final antes de Sentry)

**Regla**: si agregás un nuevo patrón, actualizá los tres lugares.

---

## Throttling

Frontend + Admin: **máximo 5 reportes por sesión, mínimo 2s entre reportes**.

Si un componente entra en loop generando errores, no queremos DDOS-earnos a nosotros mismos
ni saturar el free tier de Sentry.

Backend: rate limit **60 req/min/IP** en `/api/client-errors`.

---

## Cómo debuggear un error en Sentry

1. Filtrar por tag `release=<commit_short>` — reduce el scope al build específico.
2. Chequear tag `source` (`frontend` vs `admin:*` vs código backend).
3. En el evento, ver User context: `tenant_id`, `user_id` → correlacionar con el cliente que reportó.
4. `build_commit` en tags → coincide con el `release` para resolver source maps.
5. Si el stacktrace es minified (sin nombres): source maps no se subieron. Verificar
   `SENTRY_AUTH_TOKEN` en Netlify env vars.

---

## Trade-offs y decisiones durables

| Decisión                                           | Por qué                                                                  |
|----------------------------------------------------|--------------------------------------------------------------------------|
| No usar `@sentry/react` en frontends              | +30kb gz por app, para poco valor extra (backend ya captura todo).       |
| Un solo proyecto Sentry backend recibe frontend    | Simplifica alertas (todo en un dashboard); tag `source` los distingue.   |
| Filtrar `NoiseError` antes de Sentry              | Free tier limitado (5k/mes). Ruido transient inflaba el cuota.           |
| Sample rate `tracesSampleRate: 0` (solo errores)  | Performance monitoring no crítico ahora. Cambiar cuando haya SLA.        |
| Source maps con `hidden` no `true`                | Vite no agrega `//# sourceMappingURL=...` al bundle → browser no ve maps. |
| `filesToDeleteAfterUpload: ['./dist/**/*.map']`   | Sentry los tiene subidos; borrar del bundle público evita exposición.     |

---

## Gotchas descubiertos (2026-07-15)

Cosas que costaron tiempo entender en el setup real. Documentadas para
que futuro-tú (o próximo dev) no se choque con las mismas piedras.

### 1. Slug real de la org es `bruno-iu`, no `lnbruno`

El default en `frontend/vite.config.js` y `admin-frontend/vite.config.js` es
`'lnbruno'` (histórico, mi mala asunción). El slug REAL es `bruno-iu`.
Verificable en cualquier URL de Sentry (`sentry.io/organizations/bruno-iu/...`).

**Netlify env var** `SENTRY_ORG=bruno-iu` overridea el default, así el
build usa el slug correcto. No hace falta cambiar los defaults del código
(sirven de fallback en caso de que la env var falte en local).

### 2. Netlify CLI v26 tiene bug con `--site`

El flag `--site <id>` es ignorado por `netlify env:set` en CLI v26.2.x. Además,
`--secret` requiere `account_id` que solo se resuelve tras un `netlify link`.

**Workaround para scripts**: hacer `cd <project-dir> && netlify link --id
<site-id>` primero, después `netlify env:set VAR value --force`. Sin `--secret`
si querés evitar el prompt de account_id (marcala Sensitive por UI después).

### 3. Validar que el DSN esté bien formateado

El `SENTRY_DSN` de Railway se corrompió una vez (le faltaba el `@o<id>.ingest.`
del medio → los eventos se silenciaban sin error). Los indicadores de un
DSN válido:

```
https://<publickey>@<host>.ingest.us.sentry.io/<projectid>
                  ↑                ↑
                  debe existir     debe existir
```

**Chequeo rápido desde CLI:**
```bash
railway variables --service tecny-backend --json | \
  python3 -c "import json,sys; v=json.load(sys.stdin).get('SENTRY_DSN',''); \
    print('Valid:', '@' in v and 'ingest' in v)"
```

**Cómo obtenerlo si se pierde:**
- Sentry.io → project settings → Client Keys → copiar DSN
- O vía API con auth token:
  ```bash
  curl -H "Authorization: Bearer $TOKEN" \
    https://sentry.io/api/0/projects/bruno-iu/tecny-portal-backend/keys/
  ```

**Recomendación**: guardar el DSN correcto en un password manager como backup.
Sin ese respaldo, si Railway pierde la var hay que redescubrirlo (10 min extra).

### 4. Cambiar env var en Railway NO trigger redeploy automático

En este proyecto Railway no re-arranca el service cuando cambiás una env var.
Después de `railway variables --set X=Y`, hay que forzar el redeploy:

```bash
railway redeploy --service tecny-backend --yes
```

O commit vacío + push (pero requiere pasar branch protection). El CLI redeploy
es el path más rápido.

### 5. Auth Token de Sentry: scopes mínimos

Para que el `@sentry/vite-plugin` pueda subir source maps + crear releases:

- `project:releases` — crea/edita releases
- `project:read` — resuelve el project slug
- `org:read` — resuelve el org slug

Con `event:read` adicional podés también consultar issues via API (útil para
scripts de verificación, no necesario para el flow normal).

### 6. Test de verificación end-to-end

Después de cualquier cambio en la config de Sentry, verificar el pipeline
completo con un evento de prueba:

```bash
# Send test event
curl -X POST https://tecny-backend-production.up.railway.app/api/client-errors \
  -H "Content-Type: application/json" \
  -d '{"message":"TEST_'$(date +%s)'","stack":"Error: test\n    at :1:1","source":"admin:test","build_commit":"unknown","build_version":"0.1.0"}'

# Wait ~30s, verify Sentry received it
curl -H "Authorization: Bearer $SENTRY_TOKEN" \
  "https://sentry.io/api/0/projects/bruno-iu/tecny-portal-backend/stats/?stat=received&resolution=1h&since=$(( $(date +%s) - 3600 ))" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print('Events:', sum(int(c) for _,c in d))"
```

Si el count > 0 en el bucket de la última hora, el pipeline funciona.

---

## Referencias en código

- Backend init: `backend/server.js:35-56`
- Backend Express handler: `backend/src/app.js` (grep `setupExpressErrorHandler`)
- Backend user context: `backend/src/middleware/auth.js:209`
- Backend endpoint client-errors: `backend/src/app.js:361-403`
- Backend noise filter: `backend/src/lib/clientErrorNoise.js`
- Portal reportError: `frontend/src/lib/reportError.js`
- Portal ErrorBoundary: `frontend/src/components/ErrorBoundary.jsx`
- Portal vite plugin: `frontend/vite.config.js:216-231`
- Admin reportError: `admin-frontend/src/lib/reportError.js` (task #137)
- Admin ErrorBoundary: `admin-frontend/src/components/ErrorBoundary.jsx` (task #137)
- Admin vite plugin: `admin-frontend/vite.config.js` (task #137)
