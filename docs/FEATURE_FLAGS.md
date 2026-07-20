# Feature Flags (M-08)

Sistema minimalista de feature flags para iPro-Portal. Permite hacer
rollouts graduales y kill-switches sin requerir un deploy.

Introducido en TANDA 6 (junio 2026) tras la auditoría 2026-06-10 que
detectó la falta como blocker operativo:
ver `docs/audit/2026-06-10-gran-auditoria.md` (M-08).

---

## Modelo de datos

Una sola tabla `feature_flags` con on/off global por flag:

| Columna       | Tipo            | Notas                                              |
| ------------- | --------------- | -------------------------------------------------- |
| `name`        | VARCHAR(64) PK  | snake_case, regex `^[a-z][a-z0-9_]*$`              |
| `enabled`     | BOOLEAN         | default `false` — flag nuevo no impacta hasta on   |
| `description` | TEXT (≤500)     | humano-legible, opcional                           |
| `created_at`  | TIMESTAMPTZ     | default `NOW()`                                    |
| `updated_at`  | TIMESTAMPTZ     | default `NOW()`, actualizado por la app en PATCH   |

**Sin targeting por user/role, sin rollout %, sin variantes A/B**. Si en
algún momento aparece la necesidad, se extiende la tabla — la versión 1
no asume nada más allá del MVP.

Auditoría granular (quién prendió qué flag cuándo) la cubre
`audit_logs` desde la route (patrón S-05 TANDA 2 — audit-in-tx).

---

## API HTTP

Mount en `/api/feature-flags`, protegido por `requireAuth` global. El
guard `adminOnly` se aplica inline en cada ruta excepto el GET público.

| Método | Path                              | Acceso          | Devuelve                                |
| ------ | --------------------------------- | --------------- | --------------------------------------- |
| GET    | `/api/feature-flags`              | logueado        | `{ flags: { name: bool, ... } }`        |
| GET    | `/api/feature-flags/admin`        | admin           | array `[{ name, enabled, description, created_at, updated_at }]` |
| POST   | `/api/feature-flags`              | admin           | row creado (201) — `{ name, enabled?, description? }` |
| PATCH  | `/api/feature-flags/:name`        | admin           | row actualizado — `{ enabled?, description? }` (al menos uno) |
| DELETE | `/api/feature-flags/:name`        | admin           | 204 No Content                          |

**Cache TTL**: el GET público cachea el map en memoria 60 s
(`createCachedFetcher` de `lib/cacheTtl.js`). Trade-off consciente:
cuando un admin cambia un flag, la otra réplica Railway lo ve cuando
expire su TTL (≤60 s). Para invalidación cross-instance real haría
falta Redis pub/sub — fuera de scope de la versión 1.

**Audit-in-TX**: create/update/delete persisten el INSERT en
`audit_logs` dentro de la misma TX → cero risk de "cambio commiteado
sin audit" si el proceso muere a mitad de camino.

### Ejemplos curl

Crear un flag (admin):

```bash
curl -X POST https://ipro-portal.up.railway.app/api/feature-flags \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"new_dashboard_kpis","enabled":false,"description":"KPIs renovados del dashboard"}'
```

Prenderlo (rollout):

```bash
curl -X PATCH https://ipro-portal.up.railway.app/api/feature-flags/new_dashboard_kpis \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}'
```

Apagarlo (kill-switch):

```bash
curl -X PATCH https://ipro-portal.up.railway.app/api/feature-flags/new_dashboard_kpis \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'
```

Borrarlo (cleanup post-rollout exitoso):

```bash
curl -X DELETE https://ipro-portal.up.railway.app/api/feature-flags/new_dashboard_kpis \
  -H "Authorization: Bearer $TOKEN"
```

> Una UI admin para administrar flags está fuera de scope de la versión 1
> pero la API ya está lista para cuando aparezca.

---

## Uso en el frontend

El `FeatureFlagsProvider` envuelve el árbol React (montado en `App.jsx`
después de `AuthProvider`) y hace fetch al endpoint público en mount /
cuando cambia el user. Si la API rompe → fail-safe: todos los flags
quedan en `false`.

Hook puntual:

```jsx
import { useFeatureFlag } from '@/contexts/FeatureFlagsContext';

function DashboardScreen() {
  const newKpisActive = useFeatureFlag('new_dashboard_kpis');
  return newKpisActive ? <NewKpiPanel /> : <LegacyKpiPanel />;
}
```

Hook completo (para admin UI futura o componentes que dependen de
varios flags):

```jsx
import { useFeatureFlags } from '@/contexts/FeatureFlagsContext';

function DebugOverlay() {
  const { flags, loading, error, reload } = useFeatureFlags();
  // ...
}
```

`useFeatureFlag` devuelve `false` cuando:

- el flag no existe en la tabla,
- el provider aún está cargando,
- la API rompió (fail-safe).

El comportamiento "apagado por default" es deliberado: si la feature
aún no salió, no se expone.

---

## Convenciones

### Naming

- **snake_case**, regex enforced server-side: `^[a-z][a-z0-9_]*$`, ≤ 64 chars.
- Empezá con un prefijo de módulo para legibilidad: `ventas_*`,
  `inventario_*`, `envios_*`, `dashboard_*`.
- El nombre debe describir **qué activa**, no contar una historia.
  `new_checkout_flow` ✅ — `prueba_temporal_2026_q2_para_decidir_si_X` ❌.

### Lifecycle de un flag

```
1. Crear (POST, enabled=false) — el código nuevo ya lee `useFeatureFlag`.
2. Deploy del código que depende del flag (apagado en prod).
3. Rollout: PATCH enabled=true. Validar en uso real.
4. Kill-switch si algo sale mal: PATCH enabled=false (≤60 s para que se
   propague por TTL del cache).
5. Estabilización: una vez que la feature está 100% encendida y nadie
   quiere volver atrás, **borrar el flag** (DELETE) y limpiar el código
   muerto del `if (useFeatureFlag(...))` en una PR de cleanup.
```

Un flag que vive eterno es deuda técnica — el sistema NO está pensado
para sustituir config (a diferencia de e.g. parámetros tipo `tc_default`,
que viven en otra tabla).

### ¿Cuándo NO usar un flag?

- Config de negocio (limites, parámetros, defaults) → tabla `config`.
- Permisos por usuario → JWT `perms`.
- A/B test estadístico — el sistema no soporta variantes ni segmentos.

---

## Observabilidad

Cada create/update/delete genera una fila en `audit_logs`:

```sql
SELECT created_at, accion, datos_antes, datos_despues, usuario_id
  FROM audit_logs
 WHERE tabla = 'feature_flags'
 ORDER BY created_at DESC LIMIT 50;
```

Útil para responder "¿quién prendió `new_checkout_flow` el martes?".

---

## Tests

- Backend: `backend/tests/feature-flags.test.js` — 28 tests cubriendo
  CRUD admin, naming convention, 403 a non-admin, audit trail.
- Frontend: `frontend/src/contexts/FeatureFlagsContext.test.jsx` — 7
  tests cubriendo hook, default-false, fail-safe, sin-sesión.

---
---

# V2: Feature Flags Per-Tenant (Rec proactiva #3, julio 2026)

**Estado**: F1 + F2 + F3 mergeados (2026-07-20). Ver task #184/#187/#188
en la task list del proyecto para historial.

**Contexto**: la V1 arriba (M-08 junio 2026) tenía sólo `enabled` binario
global — un flag estaba ON o OFF para TODOS los tenants al mismo tiempo.
No había forma de decir "activar R2 solo para Tek Haus como canary antes
del rollout global" o "audit async al 25% de tenants para validar 24h
antes de subir al 100%". La Rec proactiva #3 del post-audit 2026-07
agregó overrides tenant/plan + rollout% determinístico.

**Coexistencia con V1**: la tabla `feature_flags` no se dropeó — sigue
existiendo con `enabled` global. Se agregaron:

- `feature_flags.rollout_pct SMALLINT NULL` (0..100 o NULL = "sin rollout")
- `feature_flags_tenants (flag_name, tenant_id, enabled)` — override específico
- `feature_flags_plans (flag_name, plan_id, enabled)` — override por plan

El endpoint viejo `/api/feature-flags` sigue funcionando pero solo lee
`enabled` global. El endpoint nuevo `/api/features` (F3) devuelve el map
resuelto con precedencia completa.

## Modelo de precedencia

Para cada `(flagName, tenantId)`:

```
1. Tenant override      (feature_flags_tenants)     — el más específico. Si existe, gana.
2. Plan override        (feature_flags_plans)       — matchea tenants.plan
3. Rollout %            (rollout_pct + bucket hash) — SHA-256(flag:tenant) % 100 < rollout_pct
4. Global default       (feature_flags.enabled)     — legacy V1
5. Fail-closed → false  (flag no existe, DB inaccesible, etc.)
```

El **primer match gana**. Ejemplos concretos:

| Global | Rollout% | Plan `pro` | Tenant 42 | Resultado para tenant 42 |
|:------:|:--------:|:----------:|:---------:|:-------------------------|
| OFF    | —        | —          | ON        | **ON** (tenant override) |
| ON     | —        | —          | OFF       | **OFF** (kill switch por tenant) |
| OFF    | —        | ON         | —         | **ON** (si tenant 42 plan='pro') |
| OFF    | 30       | —          | —         | ON si `sha256("flag:42") % 100 < 30` |
| OFF    | —        | —          | —         | OFF (default global) |

## API HTTP (V2)

### `GET /api/features` (público per-tenant, F3)

```
Authorization: Bearer <jwt>
→ 200
{
  "features": {
    "audit_async_enabled": false,
    "storage_r2_comprobantes": true,       ← este tenant tiene override ON
    "storage_r2_productos": false,
    "demo_flag": false
  },
  "resolved_at": "2026-07-20T18:45:00.123Z"
}
```

Consume el resolver con precedencia completa. Distinto shape que el viejo
`/api/feature-flags` (que devuelve `{ flags }` solo con default global).

### Endpoints admin (F2)

Requieren super-admin + 2FA:

| Método | Path                                                       | Efecto                                     |
| ------ | ---------------------------------------------------------- | ------------------------------------------ |
| GET    | `/api/super-admin/features`                                | Lista completa con overrides + rollout     |
| PATCH  | `/api/super-admin/features/:name`                          | Cambiar `enabled` / `rollout_pct` / `description` |
| POST   | `/api/super-admin/features/:name/tenants/:tenantId`        | Upsert override tenant `{ enabled: bool }` |
| DELETE | `/api/super-admin/features/:name/tenants/:tenantId`        | Borrar override tenant                     |
| POST   | `/api/super-admin/features/:name/plans/:planId`            | Upsert override plan `{ enabled: bool }`   |
| DELETE | `/api/super-admin/features/:name/plans/:planId`            | Borrar override plan                       |

Todos los writes:
- **Audit-in-tx** en `audit_logs.tabla ∈ {feature_flags, feature_flags_tenants, feature_flags_plans}`
- **Invalidación cache**: post-write llaman `invalidateFeatureCache(name, tenantId)`
  para bajar la latencia de propagación cross-instance de TTL 5min → <100ms.

UI admin en `admin.tecnyapp.com/features` (page `Features.jsx`).

## Uso en el backend (V2)

### Opción A: middleware `req.features` (recomendado para routes)

Montar el middleware `loadFeatures()` en el router:

```js
const loadFeatures = require('../middleware/features');

app.use('/api/comprobantes', requireAuth, loadFeatures(), comprobantesRoutes);
```

Después dentro del handler:

```js
router.post('/', async (req, res) => {
  if (await req.features.enabled('storage_r2_comprobantes')) {
    // usar R2
  } else {
    // fallback legacy
  }
});
```

El middleware memoiza por request: llamadas repetidas al mismo flag NO
hacen round-trip extra. Para varios flags upfront:

```js
const flags = await req.features.resolveAll(['flag_a', 'flag_b']);
// { flag_a: true, flag_b: false }
```

### Opción B: resolver directo (para libs internas sin request)

Cuando NO hay `req` (jobs, crons, helpers) se llama al resolver
directamente:

```js
const { isFeatureEnabled } = require('../lib/featureFlags');

const useAsync = await isFeatureEnabled('audit_async_enabled', tenantId);
```

Sin `tenantId` (`null`) cae al default global — útil para features de
sistema que no son "por cliente".

## Uso en el frontend (portal cliente, V2)

El `FeatureFlagsProvider` desde F3 consume `/api/features` (per-tenant).
Los hooks públicos NO cambiaron su contrato:

```jsx
const useR2 = useFeatureFlag('storage_r2_productos');
```

Si el user cambia de tenant (raro pero posible), el context refetchea al
detectar el cambio del `user.tenant_id`.

---

# RUNBOOK — Operar feature flags per-tenant

Este runbook documenta los procedimientos operativos para las 4 usos
principales: **canary**, **rollout gradual**, **kill-switch de emergencia**,
y **verificación**.

## Escenario 1: Canary por tenant

**Cuándo usarlo**: querés activar una feature en 1 tenant específico
(ej. Tek Haus, cliente power-user) antes de rollear al resto. Sirve para
validar la feature contra datos reales sin arriesgar al resto de la base.

**Pasos**:

1. Verificar el estado global del flag desde `admin.tecnyapp.com/features`.
   Debe estar en **enabled=false** (default global OFF).
2. En la card del flag, click en "Agregar override tenant" → seleccionar
   el tenant (ej. Tek Haus, id=7) → toggle ON → guardar.
3. Verificar via API o UI del tenant:
   ```bash
   # como super-admin, impersonar tenant 7 o pedir al owner de Tek Haus
   # que curl -H "Auth: Bearer <token-tenant-7>" /api/features
   # → features.storage_r2_productos debe ser true
   ```
4. Validar la feature con uso real 24-72h. Monitorear Sentry por errores.

**Rollback**: en la misma card del override tenant → borrar. El flag
vuelve a leer el default global (OFF) para ese tenant en ≤5min (TTL cache).
Para invalidación inmediata, el DELETE del endpoint admin ya llama
`invalidateFeatureCache` — la propagación cross-instance es <100ms.

## Escenario 2: Rollout gradual (%)

**Cuándo usarlo**: la feature ya se validó en 1-2 tenants canary. Ahora
querés subirla progresivamente al resto minimizando blast radius si algo
rompe.

**Cómo funciona el bucket**: la función `bucketFor(flag, tenant)` calcula
`SHA-256(flag:tenant) % 100 → 0..99`. El tenant cae en el rollout si
`bucket < rollout_pct`. Es **determinístico**: el mismo tenant siempre está
en el mismo bucket para el mismo flag (idempotente). Distinto flag → bucket
independiente (evita que "los mismos tenants tempranos" acumulen todas las
features canary).

**Pasos**:

1. Desde `/features`, en la card del flag → setear `rollout_pct` de 0 → 10
   (10%) → guardar. Los tenants cuyo bucket cae en 0..9 empiezan a tener
   la feature ON, el resto sigue con default global (OFF).
2. Validar 24-48h. Si Sentry / logs se ven bien → subir a 25%, 50%, 100%.
3. Al llegar a 100%, opcionalmente cambiar a `enabled=true` global +
   `rollout_pct=NULL` (el rollout deja de aplicar; el default global es ON
   para todos).

**Consideración**: el override tenant SIEMPRE gana sobre el rollout. Si
un tenant tiene override OFF por kill switch previo, subir el rollout_pct
no lo afecta. Para "resetear", borrar el override tenant.

## Escenario 3: Kill switch de emergencia

**Cuándo usarlo**: la feature está rompiendo prod (o solo un tenant) y
necesitás apagarla YA.

**Opción A — kill global (afecta a todos)**:

1. Desde `/features`, toggle del flag → OFF → guardar.
2. Post-write invalida el cache `ff:<flag>:*` para todos los tenants.
   Propagación cross-instance <100ms.
3. Confirmar via `curl -H "Auth: ..." /api/features` (desde cualquier tenant)
   que el flag aparece en `false`.

**Opción B — kill por tenant** (si el problema es de 1 cliente):

1. Desde `/features`, en la card del flag → "Agregar override tenant"
   → seleccionar el tenant afectado → toggle **OFF** → guardar.
2. El tenant queda forzado OFF aunque el global sea ON — el override tenant
   gana.

**Verificación post-kill**: reproducir el error debería fallar / caer al
path legacy. Chequear Sentry: los eventos nuevos deben cesar en ~1min
(depende del volumen).

**Si algo NO propaga**: ver Troubleshooting abajo.

## Escenario 4: Verificación post-cambio

Después de cualquier flip:

- **Backend**: `curl -s https://tecny-backend-production.up.railway.app/api/features -H "Authorization: Bearer <token>" | jq '.features."<flag>"'`
- **Frontend**: el hook `useFeatureFlag` refleja el cambio en el próximo
  refetch del context. El refetch ocurre en mount + user change — para
  ver el cambio sin recargar página, el user tiene que hacer logout/login
  o cambiar de tab (mount de otro provider).
- **Cache Redis**: `redis-cli GET "ff:<flag>:<tenant_id>"` debe reflejar el
  nuevo valor (o estar ausente si se invalidó).

## Escenario 5: Kill switch instantáneo cuando NO hay UI disponible

Si la UI admin está caída (deploy roto, DB en modo read-only), fallback a
SQL directo:

```sql
-- Kill global
UPDATE feature_flags SET enabled = false WHERE name = '<flag>';

-- Kill por tenant
INSERT INTO feature_flags_tenants (flag_name, tenant_id, enabled)
  VALUES ('<flag>', <tenant_id>, false)
  ON CONFLICT (flag_name, tenant_id) DO UPDATE SET enabled = false;
```

**IMPORTANTE**: SQL directo NO invalida el cache Redis. La propagación
llega en ≤5min (TTL natural). Para invalidación manual:

```bash
redis-cli DEL "ff:<flag>:<tenant_id>"
# o para todos los tenants (nuclear):
redis-cli --scan --pattern "ff:<flag>:*" | xargs redis-cli DEL
```

Última opción nuclear si Redis está roto: `railway service restart tecny-backend`
— fuerza cold start de todos los pods → cache local vacío.

## Cache TTL

| Cache                                       | TTL   | Invalidación                             |
| ------------------------------------------- | ----- | ---------------------------------------- |
| Redis `ff:<flag>:<tenant>` (F1 resolver)    | 5 min | Auto por TTL, o `invalidateFeatureCache` desde endpoints admin (<100ms cross-instance). |
| Frontend context (memoria del browser)      | ∞*    | Refetch on user change o remount del provider. Para forzar, logout/login. |

*El browser cache el response al mount. Si un flag cambia mientras el
user tiene la app abierta, no lo ve hasta refresh o navegación que
remonte el provider. Si necesitás propagación instantánea al frontend
sin refresh (raro), armar un WebSocket/polling — fuera de scope V2.

## Troubleshooting

### "Cambié el flag pero no toma efecto"

1. ¿La operación devolvió 2xx? Chequear los logs de Railway del endpoint
   admin. Si hubo error, la mutación puede haber fallado antes del audit.
2. ¿Estás mirando el tenant correcto? El JWT del usuario que consulta
   `/api/features` determina qué overrides se aplican. Un super-admin
   viendo desde su own tenant no ve los overrides de otros tenants.
3. Cache Redis: `redis-cli GET "ff:<flag>:<tenant>"`. Si devuelve el valor
   viejo, invalidar manual (ver Escenario 5).
4. Frontend cache: el user tiene que hacer refresh o logout/login para
   que el context refetchee.

### "El rollout_pct=30 activó al tenant equivocado"

El bucket es hash SHA-256(`flag_name:tenant_id`) — no se puede "elegir".
Si un tenant específico DEBE tener la feature ON aunque el rollout no lo
alcance, usar override tenant (siempre gana sobre rollout).

Para preview del bucket sin efecto colateral, el resolver expone `bucketFor`:
```js
const { bucketFor } = require('../lib/featureFlags');
console.log(bucketFor('my_flag', 42)); // 0..99
```

### "Los 4 flags legacy (audit_async, storage_r2_*) no toman override tenant"

Este era el estado pre-F3. Verificar que las branches F3.2/F3.3 estén
mergeadas y deployeadas. Si el flag lo lee un consumer que llama al
resolver directo con `tenantId=null`, no aplica override tenant — buscar
call sites y verificar que pasen `req.tenantId`.

## Checklist pre-flip

Antes de activar una feature nueva en prod:

- [ ] El código gateado detrás del flag maneja el path OFF también (fallback legacy).
- [ ] Hay tests con flag ON Y OFF (o el bypass NODE_ENV=test funciona).
- [ ] El flag existe en `feature_flags` — verificar `SELECT * FROM feature_flags WHERE name = '<flag>'`.
- [ ] Rollout plan definido: canary 1 tenant → 10% → 25% → 100% → sunset del flag.
- [ ] Kill switch validado en staging: flip ON → verificar feature activa → flip OFF → verificar rollback.
- [ ] Monitoring: Sentry alerta configurada para errores del path nuevo si aplica.

## Ownership

**Owner del sistema**: Lucas (product owner).
**Cambios de código**: cualquiera con acceso al repo, con PR + CI verde.
**Flips en prod**: por ahora solo Lucas via admin UI o SQL directo. Cuando
haya más super-admins, cada uno con MFA obligatorio (ya enforced en F2).

---

## Tests V2

- Backend F1: `backend/tests/featureFlags.test.js` — resolver + precedencia + bucket + fail-safe.
- Backend F2: `backend/tests/featureFlagsAdmin.test.js` — 21 tests endpoints admin + audit.
- Backend F3.1: `backend/tests/featuresPublic.test.js` — middleware + endpoint público.
- Backend F3.2: `backend/tests/audit-async.test.js` describe `F3.2 migración a resolver F1` — 3 tests.
- Backend F3.3: `backend/tests/storage-flags.test.js` describe `F3.3 migración a resolver F1` — 3 tests.
- Frontend: `frontend/src/contexts/FeatureFlagsContext.test.jsx` — 7 tests actualizados a `features.resolved()`.

Total: 63+ tests dedicados al sistema completo V1+V2.
