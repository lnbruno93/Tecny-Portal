# Admin Tenants — Design Doc

**Status:** Draft (esperando aprobación)
**Author:** Claude + Lucas
**Date:** 2026-06-21
**Estimated effort:** 25–30h (1 design + 4 implementation phases)

## Motivación

El portal está rebrandeado a Tecny con dominio custom (`tecnyapp.com`), bot
funcional, signup público con verificación email, y rate-limits productivos.
Falta lo único que bloquea operar como SaaS real: **una herramienta para que
Lucas (super-admin) gestione tenants externos sin pegarse a psql**.

Hoy con 1 tenant (Lucas mismo), no urge — pero el diseño tiene que existir
antes del primer signup externo, no después.

### Casos de uso primarios

1. **Onboarding manual** — alguien se registró por la landing, Lucas necesita
   asignar plan, dar permisos default, marcar trial hasta cuándo.
2. **Soporte** — un cliente llama "no me carga X" → Lucas entra, mira sus
   ventas / alertas / audit logs sin tener su contraseña.
3. **Cobros / churn** — cliente atrasa pago → Lucas suspende; cliente paga →
   reanuda; cliente avisa que se va → marca baja con motivo.
4. **Métricas de negocio** — Lucas quiere saber MRR, churn, conversion
   trial→paid sin tener que abrir 4 dashboards distintos.

### Lo que NO está en scope (yet)

- Self-service de upgrade de plan por el cliente final.
- Billing automático (Stripe / Mercado Pago).
- Notificaciones a clientes (emails de "tu trial vence en 3 días").
- Multi-super-admin (asumimos 1 = Lucas).

Estos quedan para v2 cuando haya volumen real que lo justifique.

---

## Arquitectura

### Decisión 1 — App separada (admin.tecnyapp.com)

✅ **Approved by Lucas**: app frontend separada, no módulo dentro del portal.

**Trade-offs:**
- ➕ Compromise de un tenant cliente NO le da acceso al admin (superficie de
  ataque distinta — distinto subdominio, distinto auth flow, distinto deploy).
- ➕ Frontend más liviano (no carga todo el portal — solo las pantallas admin).
- ➕ Distinta URL → menos chance de "ay me equivoqué de URL y borré un cliente".
- ➖ Más infra (otro Netlify site, otro DNS record).
- ➖ Reuso de código frontend acotado (mismo design tokens + helpers, pero
  componentes admin son distintos a portal).

### Decisión 2 — Backend: mismos endpoints, mismo deploy, namespace `/api/admin/*`

**Default propuesto:** mismo backend Railway, todos los endpoints admin viven
bajo `/api/admin/*` con un middleware `requireSuperAdmin` que valida el JWT
y rechaza si `user.is_super_admin !== true`.

**Alternativa rechazada:** backend separado. Sería overkill — duplicar deploys,
duplicar DB pool, duplicar Sentry. La separación lógica via middleware es
suficiente; el riesgo de "tenant user llega a /api/admin" se cubre con un
test E2E que asegura 403.

### Decisión 3 — Auth super-admin: mismo JWT, claim `is_super_admin`

**Default propuesto:**
- Agregar `users.is_super_admin BOOLEAN NOT NULL DEFAULT false`.
- Login devuelve JWT con claim `is_super_admin` (además de `tenant_id`, etc).
- `requireSuperAdmin` middleware verifica el claim del JWT (NO re-query DB
  en cada request — el JWT ya es trusted con HS256 + JWT_SECRET).
- Admin frontend usa el mismo `/api/auth/login`, pero después del login si
  `is_super_admin === true` redirige al admin app en vez de al portal.

**Alternativa rechazada:** flow auth separado (otro endpoint `/api/admin/login`).
Más superficie, sin ganancia real — el JWT_SECRET es uno solo. Si lo robás,
ya estás dentro.

**Crítico:** el setter de `is_super_admin` NO es self-service. Se setea
manualmente vía script SQL (`scripts/setSuperAdmin.js userId`) que loguea a
audit. No hay endpoint que lo modifique vía API.

### Decisión 4 — Bypass RLS: role separado de Postgres con BYPASSRLS

**Default propuesto:** crear role `tecny_admin` en Postgres con `BYPASSRLS`
attribute. Nueva función helper `db.adminQuery(fn)` que abre conexión con
ese role:

```js
// db.js
const adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });

pool.adminQuery = async function(callback) {
  const client = await adminPool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
};
```

`ADMIN_DATABASE_URL` apunta al mismo DB con el role `tecny_admin` (Railway
provee ambas connection strings con users distintos).

**Alternativa rechazada:** `SECURITY DEFINER` functions en PG. Más complejo
de mantener (cada query admin = function PG creada por migration), y el
debugging es horrible. El role separado es el patrón canónico de PG.

**Crítico:** TODOS los endpoints admin pasan por `db.adminQuery` — el
linter de CI debería rechazar uso de `db.query` o `db.withTenant` desde
`backend/src/routes/admin/*.js`. Si un endpoint admin usa el role normal,
RLS lo filtra y devuelve subset incorrecto sin que nadie note.

### Decisión 5 — Schema de planes + MRR

**Estado actual:**
```sql
tenants.plan TEXT CHECK (plan IN ('trial', 'starter', 'pro', 'enterprise'))
```

No hay tabla de subscriptions ni precios definidos.

**Default propuesto:** mantenerlo simple. Hardcodear precios USD/mes en el
backend (`lib/planPricing.js`) hasta que tengamos billing automático real:

```js
const PLAN_PRICES_USD = {
  trial:      0,
  starter:   29,
  pro:       79,
  enterprise: 0,  // negociado per-deal
};
```

MRR del dashboard = `SUM(PLAN_PRICES_USD[t.plan])` sobre tenants no
suspendidos y plan != 'trial'. Para `enterprise` (custom pricing) agregar
columna `tenants.custom_mrr_usd NUMERIC` que el admin setea manualmente
al onboardear ese tenant.

Agregar columnas a `tenants`:
- `suspended_at TIMESTAMPTZ` — NULL = activo, set = suspendido (login bloqueado)
- `suspended_reason TEXT` — opcional, para soporte
- `trial_until DATE` — cuando expira el trial; NULL si plan != 'trial'
- `custom_mrr_usd NUMERIC(10,2)` — solo para plan='enterprise'
- `notes TEXT` — campo libre para Lucas (e.g. "Cliente referido por X")

**Cuando lleguemos a billing real (Stripe/MP):** agregamos tabla
`subscriptions` con histórico de pagos, link al payment provider, etc. Por
ahora no inventamos algo que no usamos.

---

## Schema (migrations)

```sql
-- migration: 20260621000001_super_admin_and_tenant_admin_fields.js

ALTER TABLE users ADD COLUMN is_super_admin BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX idx_users_super_admin ON users(id) WHERE is_super_admin = true;

ALTER TABLE tenants
  ADD COLUMN suspended_at      TIMESTAMPTZ,
  ADD COLUMN suspended_reason  TEXT,
  ADD COLUMN trial_until       DATE,
  ADD COLUMN custom_mrr_usd    NUMERIC(10,2),
  ADD COLUMN notes             TEXT;

-- Defensive: trial_until solo aplica si plan='trial'
ALTER TABLE tenants ADD CONSTRAINT chk_trial_until_only_for_trial
  CHECK (trial_until IS NULL OR plan = 'trial');

-- Defensive: custom_mrr_usd solo aplica si plan='enterprise'
ALTER TABLE tenants ADD CONSTRAINT chk_custom_mrr_only_for_enterprise
  CHECK (custom_mrr_usd IS NULL OR plan = 'enterprise');

-- Audit trail de cambios de plan / suspensión (no es para mostrar en UI
-- per-tenant, es para forense + investigaciones de churn).
CREATE TABLE tenant_admin_actions (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  super_admin_user_id INTEGER NOT NULL REFERENCES users(id),
  action            TEXT NOT NULL, -- 'plan_change', 'suspend', 'reactivate',
                                   -- 'trial_extend', 'note_update', 'delete'
  before_state      JSONB,
  after_state       JSONB,
  reason            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tenant_admin_actions_tenant ON tenant_admin_actions(tenant_id, created_at DESC);

-- NO RLS en tenant_admin_actions: solo super-admin puede leer/escribir y eso
-- se garantiza por endpoint (no por RLS).
```

### Bootstrap del primer super-admin

Script standalone (no expuesto vía API):

```bash
node backend/scripts/setSuperAdmin.js <user_id>
```

Idempotente, requiere DATABASE_URL admin (NO el de prod app). Loguea a
`tenant_admin_actions` aunque no es per-tenant (usa tenant_id = null).

---

## Backend — endpoints

Todos bajo `/api/admin/*`, montados con middleware `requireSuperAdmin` global.

| Method | Path | Descripción |
|---|---|---|
| GET | `/api/admin/me` | Ping — devuelve `{ is_super_admin: true, user_id }`. Usado por el admin frontend al boot para verificar acceso. |
| GET | `/api/admin/tenants` | Lista de tenants con stats inline. Query params: `?plan=`, `?suspended=true`, `?search=`. Devuelve array `{ id, nombre, slug, plan, suspended_at, trial_until, mrr_usd, users_count, last_login_at, signups_30d, last_venta_at }`. |
| GET | `/api/admin/tenants/:id` | Detalle de un tenant. Incluye todo lo de la lista + `notes`, `created_at`, `custom_mrr_usd`, últimas 10 acciones admin. |
| GET | `/api/admin/tenants/:id/activity` | Drill-down de actividad. Query `?type=ventas|cajas|alertas|bot|audit&limit=N`. Cada uno devuelve un summary distinto. |
| PATCH | `/api/admin/tenants/:id` | Mutate: `{ plan?, suspended_at?, suspended_reason?, trial_until?, custom_mrr_usd?, notes? }`. Cada cambio se loguea a `tenant_admin_actions` con `reason` opcional. |
| POST | `/api/admin/tenants/:id/extend-trial` | Shortcut: extiende `trial_until` por N días. Body: `{ days, reason }`. |
| POST | `/api/admin/tenants/:id/suspend` | Shortcut: `suspended_at = NOW()`. Body: `{ reason }` requerido. |
| POST | `/api/admin/tenants/:id/reactivate` | `suspended_at = NULL`. Body: `{ reason }` opcional. |
| GET | `/api/admin/metrics` | Dashboard SaaS. Devuelve `{ mrr_total_usd, tenants_active, tenants_trial, tenants_suspended, signups_7d, signups_30d, churn_30d, conversion_trial_paid_30d }`. |
| GET | `/api/admin/metrics/history` | Serie temporal últimos 90d de MRR + signups + churn. Para gráficos. |

**No expuesto** (decisión consciente):
- DELETE tenant — los borrados se hacen vía script (audit trail completo).
  Equivalente: `suspended_at + notes`. Si realmente hay que borrar, es 1 query
  manual con todos los `ON DELETE CASCADE` ya cubiertos.

---

## Frontend — admin app

### Stack
- Vite + React (mismo que el portal).
- Reuso del design system (CSS tokens via `@tecny/design-tokens` package
  futuro; por ahora copy del `styles.css` con las variables compartidas).
- React Router con 5 rutas:
  - `/login` — usa `/api/auth/login`, después de OK chequea `is_super_admin`.
  - `/tenants` — lista con filtros + search.
  - `/tenants/:id` — detalle + acciones.
  - `/metrics` — dashboard SaaS.
  - `/settings` — placeholder (cambiar password, ver logs propios).

### Mockup conceptual

```
┌─────────────────────────────────────────────────────────┐
│ TECNY ADMIN                              Lucas ▾ Logout │
├─────────────────────────────────────────────────────────┤
│ [Tenants] [Métricas] [Settings]                         │
├─────────────────────────────────────────────────────────┤
│ Tenants                                                 │
│ [search...]  Plan: [Todos ▾]  Estado: [Todos ▾]        │
│                                                         │
│ NOMBRE          PLAN    MRR   USERS  LAST LOGIN  ⚙     │
│ Tecny Demo     starter  $29    3     hace 2h       ⋮   │
│ Tienda Pepe    pro      $79    5     ayer          ⋮   │
│ Mercado Norte  trial    $0     1     hace 1d       ⋮   │
│ ...                                                     │
└─────────────────────────────────────────────────────────┘
```

Click en row → /tenants/:id con tabs:
- **Resumen**: nombre, slug, plan, fechas, notes editable, botones acciones
- **Actividad**: timeline (ventas, cajas, alertas, bot)
- **Usuarios**: lista de users del tenant + roles
- **Acciones admin**: histórico de cambios admin (de `tenant_admin_actions`)

### Auth UX

Mismo `/api/auth/login` que el portal. Backend devuelve JWT con
`is_super_admin` claim. El admin frontend:

```js
const r = await fetch('/api/auth/login', { ... });
const { token, user } = await r.json();
if (!user.is_super_admin) {
  setError('Esta app es solo para super-admins.');
  return;
}
localStorage.setItem('admin_token', token);
navigate('/tenants');
```

Si un super-admin entra al portal normal (`tecnyapp.com`) con su user,
funciona igual (es un user del tenant 1). El bit `is_super_admin` solo
abre el admin app, no le da poderes en el portal normal.

---

## Infra

### DNS + Netlify

- Nuevo Netlify site `tecny-admin-prod` apuntando a la rama `main` de un
  subdirectorio `/admin-frontend/` del repo.
- DNS: agregar registro `admin.tecnyapp.com CNAME tecny-admin-prod.netlify.app`.
- HTTPS automático via Netlify.
- CSP del admin frontend más estricto que portal (no necesita hCaptcha,
  no necesita inline scripts).

### Postgres role

```sql
-- En Railway DB, ejecutado UNA vez como superuser:
CREATE ROLE tecny_admin LOGIN PASSWORD '...' BYPASSRLS;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO tecny_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO tecny_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO tecny_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO tecny_admin;
```

### Env vars (Railway backend)

- `ADMIN_DATABASE_URL` — connection string con role `tecny_admin`.
- No requiere nuevas vars en frontend.

### Env vars (Netlify admin frontend)

- `VITE_API_URL` — `https://tecny-backend-production.up.railway.app` (mismo
  que portal — el frontend admin pega a `/api/admin/*` que ya existe en ese
  backend).

---

## Plan de implementación (5 fases)

### Fase 0 — Design doc + decisiones (1–2h) ← ESTAMOS ACÁ

- [ ] Lucas revisa este doc y aprueba/veta decisiones 1–5.
- [ ] Decidir naming: `admin.tecnyapp.com` vs `console.tecnyapp.com` vs `manage.tecnyapp.com`.
- [ ] Lock de precios USD por plan (decisión 5).

### Fase 1 — Backend: schema + auth + endpoints list/detail (~8h)

- Migration con campos nuevos en `users`, `tenants`, `tenant_admin_actions`.
- `users.is_super_admin` en JWT claim (auth route).
- `requireSuperAdmin` middleware.
- Role PG `tecny_admin` + `db.adminQuery()` helper.
- Endpoints: `GET /admin/me`, `GET /admin/tenants`, `GET /admin/tenants/:id`.
- Tests integration: 403 si no super-admin, 200 si es, RLS bypass funciona.
- Script `setSuperAdmin.js`.

### Fase 2 — Backend: mutations + activity + metrics (~6h)

- Endpoints PATCH + shortcuts (extend-trial, suspend, reactivate).
- `tenant_admin_actions` populated en cada mutation.
- `GET /admin/tenants/:id/activity` con los 5 types.
- `GET /admin/metrics` + `GET /admin/metrics/history`.
- Tests integration de cada mutation + audit trail.

### Fase 3 — Frontend: scaffold + auth + tenants list (~6h)

- Vite project en `admin-frontend/` (separado del portal).
- Reuso de design tokens (copy de CSS variables).
- React Router con 5 rutas.
- Login flow con check de `is_super_admin`.
- Pantalla `/tenants` con search + filtros + tabla.
- Loading states, error boundaries, empty states.

### Fase 4 — Frontend: detail + actions + metrics dashboard (~6h)

- Pantalla `/tenants/:id` con 4 tabs (Resumen, Actividad, Usuarios, Acciones admin).
- Modales: cambiar plan, suspender, extender trial.
- Pantalla `/metrics` con KPIs + gráficos (Recharts, ya está en deps del portal).
- Toast de feedback en cada acción.

### Fase 5 — Infra + deploy + smoke (~2–3h)

- Crear Netlify site para admin.
- DNS record `admin.tecnyapp.com`.
- Postgres role `tecny_admin` en prod + staging.
- Env vars en Railway (`ADMIN_DATABASE_URL`).
- Smoke E2E manual: login → ver tenant 1 → cambiar plan → verificar audit.
- Doc breve en `docs/ADMIN_OPERATIONS.md`.

---

## Open questions (resolver en revisión)

1. **Naming del subdominio**: `admin.tecnyapp.com` (default) o algo más
   neutro como `console.` / `manage.`?
2. **Precios USD por plan**: confirmar `$0/$29/$79/custom` o ajustar.
3. **Trial duration default**: ¿14 días? ¿30 días? ¿Sin trial automático?
4. **Acciones del admin EN un tenant**: ¿necesitás "impersonar" (login como
   user del tenant para ver lo que ve el cliente)? Es ~3h extra de scope.
   Por defecto NO incluido — el drill-down de actividad cubre 80% de los
   casos sin necesidad de impersonar.
5. **Email notifications**: cuando el admin suspende, ¿el cliente recibe
   email? Por ahora **no** (out of scope), pero si querés, ~2h extra.

---

## Out of scope explícito (v2)

- Self-service upgrade de plan por el cliente final.
- Billing integration (Stripe / Mercado Pago).
- Email notifications automáticas (trial vence, suspended, etc).
- Multi super-admin con roles diferenciados.
- Impersonation (super-admin "ve como" un user del tenant).
- Bulk actions (cambiar plan a 10 tenants a la vez).
- Export CSV/XLSX del listado de tenants.

Estos se agregan cuando lleguemos al volumen que los justifique.

---

## Métricas de éxito post-merge

- Lucas puede onboardear un cliente nuevo en < 2 minutos sin tocar psql.
- Lucas puede ver MRR actualizado en 1 click.
- Test E2E: un user del tenant 1 que NO es super-admin recibe 403 en
  `/api/admin/*` aún con JWT válido.
- Cero queries admin pegan al role normal de la app (linter CI).
- Audit trail completo de cada cambio admin (queryable por tenant_id + fecha).
