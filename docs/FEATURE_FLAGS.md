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
