# Admin Tenants — Deploy Runbook

Pasos para llevar el admin frontend de "código en repo" a "live en
`admin.tecnyapp.com`". Es la culminación del proyecto #353 — Sub-fases
0 (design doc) + 1+2 (backend) + 3 + B.1+B.2+B.3 (frontend) ya están
mergeadas en main.

Tiempo estimado total: **1.5–2 horas**, manejable en una sentada.

## TL;DR del orden

1. Crear role `tecny_admin` en Postgres prod (psql + SQL)
2. Setear `ADMIN_DATABASE_URL` en Railway prod
3. Smoke test backend con curl
4. Crear Netlify site nuevo para admin-frontend
5. Configurar custom domain + DNS
6. Setear env vars en Netlify
7. Marcarte como super-admin (Railway shell)
8. Smoke test E2E desde el browser

Cada step tiene su sección abajo con commands exactos + verificación +
rollback. **NO saltees el orden** — el step 4 falla sin el step 2;
el step 8 falla sin el step 7.

---

## Step 1 — Crear role `tecny_admin` en Postgres prod

### Por qué

El backend tiene un pool secundario (`db.adminQuery`) que se conecta
con un user `BYPASSRLS` para queries cross-tenant. Sin ese role, el
fallback usa el pool app principal (NOSUPERUSER, RLS activo) y el
admin frontend solo ve el tenant del super-admin — no los otros.

El backend YA está en prod desde Fase 2 (#353), funcionando con el
fallback warn. Crear el role lo "destraba" sin tocar código.

### Cómo

Acceso a Postgres prod via Railway UI:

```
Railway dashboard → tu proyecto → Postgres → Connect → Database URL
```

La URL que Railway expone como **superuser** (rol `postgres`) está en
la pestaña "Variables" del servicio Postgres, en `DATABASE_URL`. Esta
es la URL que tu user app NO debería usar (la app usa una variable
distinta que apunta al role NOSUPERUSER), pero para crear el role
admin sí la necesitamos.

**Importante**: el DATABASE_URL del servicio Postgres y el del servicio
backend (`tecny-backend`) son DISTINTOS. El primero es superuser, el
segundo es el role app NOSUPERUSER. Para este step usás el del servicio
Postgres.

#### 1a. Conectarte con psql

```bash
# Desde tu laptop, con la URL del servicio Postgres
psql 'postgresql://postgres:PASSWORD@host.proxy.rlwy.net:PORT/railway'
```

Si no tenés psql instalado:

```bash
# macOS
brew install libpq && brew link --force libpq

# Linux
sudo apt install postgresql-client
```

Alternativa: usar el data tab de la UI de Railway, pero no soporta
parámetros `\set` que el script SQL usa.

#### 1b. Generar password aleatorio

```bash
openssl rand -base64 32 | tr -d '+/=' | head -c 40
```

Copialo en un lugar seguro temporal (1Password / scratch file). Lo
necesitás otra vez en el Step 2.

#### 1c. Correr el script SQL

Dentro de psql:

```sql
\set admin_password 'PEGAR_AQUI_LA_PASSWORD'
\i backend/sql/create_admin_role.sql
```

El script es idempotente — si lo corrés de nuevo (e.g. después de
agregar tablas nuevas), solo reaplica los GRANTs.

#### 1d. Verificación

El script termina con un SELECT que debe devolver:

```
 rolname     | is_superuser | bypasses_rls | can_login | connection_limit
 tecny_admin | f            | t            | t         | -1
```

Si `bypasses_rls = f`, algo salió mal — repetir.

### Rollback

```sql
-- Ver el bloque ROLLBACK al pie del script SQL. Resumen:
DROP ROLE tecny_admin;
```

---

## Step 2 — Setear `ADMIN_DATABASE_URL` en Railway

### Por qué

El backend lee esta env var al primer call a `db.adminQuery()`. Sin
ella, fallback al pool principal con warning. Con ella, BYPASSRLS activo.

### Cómo

```
Railway dashboard → tecny-backend service → Variables → New Variable
```

- Name: `ADMIN_DATABASE_URL`
- Value: `postgresql://tecny_admin:PASSWORD@host.proxy.rlwy.net:PORT/railway?sslmode=require`

Donde `PASSWORD` es la que generaste en Step 1b, y `host:port/db` es
el MISMO que `DATABASE_URL` del servicio Postgres (solo cambia user
+ password). `sslmode=require` es necesario en Railway.

Railway re-deploya el backend automáticamente al cambiar env vars
(~30 segundos).

### Verificación

```bash
# Esperar al re-deploy. Después:
railway logs --service tecny-backend | grep -i admin

# Debería NO aparecer el warning "[db.adminQuery] ADMIN_DATABASE_URL
# no configurado". Si seguís viéndolo, ADMIN_DATABASE_URL no llegó al
# proceso o tiene typo.
```

### Rollback

Borrar la env var desde la UI de Railway. Backend re-deploya y vuelve
al fallback con warning.

---

## Step 3 — Smoke test backend con curl

### Por qué

Confirmar que el backend ve a `tecny_admin` antes de tocar el frontend.
Aísla el problema: si curl falla, es backend; si curl pasa y la UI no
muestra data, es frontend.

### Cómo

Primero necesitás un JWT de super-admin. Si todavía no sos super-admin
en prod, hacer **Step 7 primero** (orden non-trivial, ver al pie). Si
ya tenés el flag, login normal:

```bash
# Reemplazar EMAIL + PASSWORD con tus creds prod
curl -X POST https://tecny-backend-production.up.railway.app/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"TU@email","password":"TU_PASSWORD"}' \
  | jq .

# Si el response tiene user.is_super_admin: true, copiar el token.
export TOKEN='ey...'

# Probar endpoint super-admin que requiere BYPASSRLS
curl -H "Authorization: Bearer $TOKEN" \
  https://tecny-backend-production.up.railway.app/api/super-admin/tenants \
  | jq 'length'
```

### Verificación

- Si devuelve un número > 1 (más de un tenant) → `tecny_admin` funcionó.
- Si devuelve exactamente 1 (solo tu tenant) → algo está mal, RLS está
  filtrando. Revisar Step 2.

### Rollback

N/A — read-only test.

---

## Step 4 — Crear Netlify site nuevo

### Por qué

`admin-frontend/` necesita su propio site, independiente del
portal (`frontend/`). Distinto dominio = distinto bundle = distinta
auth boundary = un compromiso en el portal no compromete al admin.

### Cómo

```
Netlify dashboard → Add new site → Import existing project →
  GitHub → autorizar acceso al repo Tecny-Portal (si no lo tenés ya) →
  seleccionar `lnbruno93/Tecny-Portal`
```

Settings del nuevo site:

- **Site name**: `tecny-admin` (o el que quieras — define el
  `xxx.netlify.app` default antes de mapear el custom domain)
- **Branch to deploy**: `main`
- **Base directory**: `admin-frontend` (CRÍTICO — sino arma el bundle
  del portal por error)
- **Build command**: `npm run build` (Netlify lo lee del package.json)
- **Publish directory**: `admin-frontend/dist`

Netlify va a leer `admin-frontend/netlify.toml` y aplicar todos los
headers + SPA fallback. **No definir esos en la UI** — el archivo es
source of truth.

### Verificación

Después del primer build (~1 min):

```bash
# Abrí el URL temporal de Netlify (tecny-admin.netlify.app o similar)
# Debería mostrar el Login del admin. NO va a funcionar el login porque
# el bundle apunta a VITE_API_URL que todavía no seteamos — lo hacemos
# en el Step 6.
```

### Rollback

Borrar el site desde la UI de Netlify (Site settings → Delete site).

---

## Step 5 — Configurar custom domain `admin.tecnyapp.com`

### Por qué

URL profesional + cert TLS válido para el admin app.

### Cómo

#### 5a. En Netlify

```
Site settings → Domain management → Add custom domain →
  ingresar: admin.tecnyapp.com → Verify → Add
```

Netlify va a mostrar 2 opciones de DNS config. Elegir CNAME (Netlify
recomienda este por flexibilidad).

#### 5b. En tu DNS provider (probablemente Cloudflare/Route53/etc)

Agregar un registro:

- **Type**: CNAME
- **Name**: `admin`
- **Value**: `xxx.netlify.app` (el que Netlify te muestra)
- **TTL**: Auto / 3600
- **Proxy**: Off (DNS only — sino el cert TLS de Netlify no se valida)

#### 5c. Esperar propagación DNS

5–15 min típicamente. Verificar:

```bash
dig admin.tecnyapp.com CNAME +short
# Debería devolver el xxx.netlify.app que Netlify asignó
```

#### 5d. Netlify provisiona cert TLS

Automático con Let's Encrypt una vez que ve el CNAME. Tarda otros
5 min. En Netlify Site settings → HTTPS, debería decir "HTTPS Enabled".

#### 5e. Forzar HTTPS

En Netlify Site settings → HTTPS → Force HTTPS (toggle).

### Verificación

```bash
curl -I https://admin.tecnyapp.com
# Debería devolver 200 con headers de seguridad del netlify.toml
# (X-Frame-Options DENY, Content-Security-Policy, etc.)
```

### Rollback

Sacar el CNAME del DNS provider. Sacar el custom domain de Netlify.
El site sigue accesible por el URL `xxx.netlify.app`.

---

## Step 6 — Setear `VITE_API_URL` en Netlify

### Por qué

El bundle del admin frontend lee esta env var en build time para saber
contra qué backend apuntar. Sin ella, fallback al backend prod
hardcodeado en `api.js` — funciona pero es mejor explícito.

### Cómo

```
Netlify Site settings → Environment variables → Add a variable
```

- **Key**: `VITE_API_URL`
- **Value**: `https://tecny-backend-production.up.railway.app`
- **Scopes**: All scopes (Builds + Functions + Runtime)
- **Deploy contexts**: Production only (branch deploys de `staging`
  deberían usar staging backend — agregalas separadamente si configurás
  el branch deploy también)

Después de guardar, **Trigger deploy** desde Site overview → Deploys.
La env var solo aplica al próximo build.

### Verificación

Esperar ~1 min al build. Abrí `https://admin.tecnyapp.com/login`,
abrí DevTools Network, intentá login con creds inválidas. La request
debería ir a `tecny-backend-production.up.railway.app/api/auth/login`,
no a un path relativo.

### Rollback

Borrar la env var → próximo build vuelve al fallback hardcodeado.

---

## Step 7 — Marcarte como super-admin

### Por qué

El admin app requiere `users.is_super_admin = true` en DB para dejarte
entrar (`requireSuperAdmin` middleware + double-gate frontend). Por
default todos los users del portal lo tienen en `false`.

### Cómo

Acceso shell a Railway prod:

```bash
# Desde tu laptop, con railway CLI instalado
railway login
railway link  # seleccionar el proyecto Tecny

# Conectar al servicio backend
railway shell --service tecny-backend
```

Dentro del shell:

```bash
# Encontrar tu user_id primero. Si no lo sabés:
node -e "const db = require('./backend/src/config/database'); \
  db.query('SELECT id, username, email, is_super_admin FROM users WHERE email = $1', \
    ['TU@email.com']).then(r => console.log(r.rows)).finally(() => db.end());"

# Otorgar super-admin (con tu user_id, ej. 5):
node backend/scripts/setSuperAdmin.js 5

# Va a pedir confirmación: escribir "otorgar" + Enter
```

### Verificación

```bash
# Re-correr el query del paso anterior — is_super_admin debería ser true.
# El script invalida automáticamente userAuthCache, así que el cambio
# aplica en ≤ 60 segundos en la próxima request del backend.
```

Hacer logout / login en el portal — el response del login ahora
debería incluir `user.is_super_admin: true`.

### Rollback

```bash
node backend/scripts/setSuperAdmin.js 5 --revoke
```

---

## Step 8 — Smoke test E2E desde el browser

### Por qué

Validar el flow completo end-to-end antes de declarar "deployado".

### Cómo

1. Browser nuevo / incógnito: `https://admin.tecnyapp.com`
2. Te lleva a `/login`. Intentar con tus creds (las del portal).
3. Debería redirigir a `/` y mostrar el Resumen con KPIs reales.
4. Click en sidebar **Clientes** → tabla con todos los tenants.
5. Click en una row → Ficha real del tenant.
6. Click en **Editar** → modal abre, cambiar plan, Guardar → vuelve a
   refrescar la Ficha con el cambio.
7. Volver a Resumen → en el activity feed debería aparecer la acción
   que acabás de hacer ("lucas cambió plan de XXX").

### Si algo falla

- **Login no funciona**: confirmar `is_super_admin` (Step 7) +
  `VITE_API_URL` apuntando al backend correcto.
- **Login OK pero "solo para super-admins"**: el flag está en false en
  DB o el cache no se invalidó. Re-correr `setSuperAdmin.js`.
- **Clientes muestra solo 1 tenant**: `ADMIN_DATABASE_URL` no está
  funcionando. Volver al Step 2 y revisar logs del backend.
- **403 Forbidden en cualquier endpoint**: JWT no tiene
  `is_super_admin`. Logout / login para refrescar el token.
- **CSP errors en consola del browser**: revisar netlify.toml — la
  primera causa típica es que faltó dominio en `connect-src`.

---

## Resumen final post-deploy

Al terminar, tenés:

- ✅ `admin.tecnyapp.com` live con TLS
- ✅ Backend con BYPASSRLS activo (puede ver todos los tenants)
- ✅ Tu user marcado como super-admin
- ✅ Flow completo READ + WRITE + AUDIT funcionando
- ✅ Audit trail empezando a poblar con cada acción que hagas

Próximo paso lógico: configurar pricing real (los `plan_prices_usd`
están en $0 placeholder — el Resumen muestra el nudge "precios
pendientes" para acordarte). Editar `backend/src/lib/planPricing.js`,
deploy normal.

---

## Apéndice — Branch deploys de staging

Si querés tener `admin-staging.tecnyapp.com` apuntando al backend
staging:

1. Netlify → Site → Build & Deploy → Continuous Deployment → Branches
   → Branches to deploy: agregar `staging`
2. Netlify → Site → Domain management → agregar `admin-staging.tecnyapp.com`
3. DNS: CNAME `admin-staging` → `staging--xxx.netlify.app`
4. Netlify → Environment variables: agregar `VITE_API_URL` con scope
   "Branch deploys" → value `https://tecny-backend-staging.up.railway.app`
5. Repetir Steps 1+2 contra Postgres staging (mismo SQL, distinta DB)

El admin staging te sirve para probar cambios al admin frontend sin
tocar prod.
