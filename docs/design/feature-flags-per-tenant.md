# Feature Flags por Tenant

**Estado**: 🛠 DISEÑO — extensión del sistema #239 existente.
**Fecha**: 2026-07-06.
**Origen**: hoy existe `feature_flags` con flags **globales** (on/off para todos). Necesitamos poder activar features por **tenant específico** (canary/beta), por **plan** (Pro vs Starter), o por **cohort** (10% rollout).
**Effort estimado**: 3-4 días. F1 ≈ 1.5 días schema + resolver + tests, F2 ≈ 1 día UI admin, F3 ≈ 1 día migrar 3 flags actuales al nuevo sistema + docs.

---

## 1. Motivación

### 1.1 Qué resolvemos

Hoy tenemos un sistema simple de feature flags (#239) con estos usos reales:

```
FEATURE_ROJO_MSG = true       # nuevo copy en toda la app
FEATURE_R2_STORAGE = true     # driver R2 activado
FEATURE_AUDIT_ASYNC = false   # experimental, off por ahora
```

Los flags viven en Redis con TTL corto, y todos los tenants ven lo mismo. **Funciona pero no escala** para el próximo escenario:

- **Lanzamos una feature grande** (ej. Red B2B v2 con nueva UI). Queremos activarla para 3 clientes de confianza durante 1 semana, ver feedback, y después full rollout.
- **Feature exclusiva de plan Pro**: la reventa a distribuidores solo la usan clientes que pagan más → gatear por `plan_id`.
- **A/B testing**: 50% de tenants con nueva UI de Cotizador, 50% con la vieja → comparar métricas.
- **Kill switch por tenant**: un cliente específico rompe un flow → desactivar la feature solo para él sin afectar al resto.

### 1.2 Qué proponemos

Extender el sistema actual con un **resolver por tenant** que evalúa flags en este orden:

1. Override explícito por tenant (`feature_flags_tenants` table).
2. Override por plan (`feature_flags_plans`).
3. Rollout % por cohort (hash-based, determinístico).
4. Default global (tabla actual).

Todo cachado en Redis con invalidation cross-instance por WebSocket / pub-sub.

### 1.3 Por qué importa

- **Reduce riesgo de deploys grandes**. Hoy si Red B2B v2 tiene bug, afecta a 100% de clientes al mismo tiempo. Con flags por tenant, afecta a 3 canary → detectamos, arreglamos, seguimos.
- **Habilita modelo de pricing por plan**: features avanzadas exclusivas del Pro sin duplicar código o hacer if inline.
- **A/B testing real**: mejores decisiones de producto con data, no intuición.

### 1.4 Por qué es proyecto serio

- **Cache invalidation** — flags cambian en runtime, deben propagarse a todas las instancias de Railway en < 1s.
- **Auditoría** — cambiar un flag es una acción sensitiva (puede afectar a un tenant productivo). Registrar quién cambió qué y cuándo.
- **Rollback rápido**: si un flag rompe algo, kill switch debe funcionar sin deploy.
- **Determinismo**: si `rollout_pct = 30%` y tenant X está en el 30%, siempre debe estar en el 30% (no random cada request).

---

## 2. Diseño

### 2.1 Schema

Extender la tabla actual `feature_flags`:

```sql
-- Tabla actual (ya existe):
-- feature_flags(name TEXT PK, enabled BOOLEAN, description TEXT, updated_at)

-- NUEVA: overrides por tenant
CREATE TABLE feature_flags_tenants (
  flag_name    TEXT NOT NULL REFERENCES feature_flags(name) ON DELETE CASCADE,
  tenant_id    INT  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enabled      BOOLEAN NOT NULL,
  reason       TEXT,                  -- "canary group A", "requested by user"
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   INT REFERENCES users(id),
  PRIMARY KEY (flag_name, tenant_id)
);

-- NUEVA: overrides por plan
CREATE TABLE feature_flags_plans (
  flag_name    TEXT NOT NULL REFERENCES feature_flags(name) ON DELETE CASCADE,
  plan_id      TEXT NOT NULL,          -- 'starter', 'pro', 'enterprise'
  enabled      BOOLEAN NOT NULL,
  PRIMARY KEY (flag_name, plan_id)
);

-- Extensión de feature_flags con rollout %
ALTER TABLE feature_flags ADD COLUMN rollout_pct INT
  CHECK (rollout_pct BETWEEN 0 AND 100) DEFAULT NULL;
-- NULL = no rollout, usar `enabled`. 0-100 = % de tenants activos.
```

### 2.2 Resolver

```js
async function isFeatureEnabled(flagName, tenantId) {
  const cached = await redis.get(`ff:${flagName}:${tenantId}`);
  if (cached !== null) return cached === '1';

  // 1. Tenant override
  const tenantOverride = await db.query(
    `SELECT enabled FROM feature_flags_tenants
      WHERE flag_name = $1 AND tenant_id = $2`,
    [flagName, tenantId]
  );
  if (tenantOverride.rows[0]) {
    return cacheAndReturn(flagName, tenantId, tenantOverride.rows[0].enabled);
  }

  // 2. Plan override
  const tenant = await db.getTenant(tenantId); // ya cachado
  const planOverride = await db.query(
    `SELECT enabled FROM feature_flags_plans
      WHERE flag_name = $1 AND plan_id = $2`,
    [flagName, tenant.plan_id]
  );
  if (planOverride.rows[0]) {
    return cacheAndReturn(flagName, tenantId, planOverride.rows[0].enabled);
  }

  // 3. Rollout %
  const flag = await getFlag(flagName);
  if (flag.rollout_pct !== null) {
    // Hash determinístico: sha256(flagName + tenantId) mod 100 < rollout_pct
    const bucket = hashToBucket(`${flagName}:${tenantId}`, 100);
    const enabled = bucket < flag.rollout_pct;
    return cacheAndReturn(flagName, tenantId, enabled);
  }

  // 4. Default global
  return cacheAndReturn(flagName, tenantId, flag.enabled);
}
```

### 2.3 Cache invalidation

- Cache key: `ff:{flagName}:{tenantId}`, TTL 5 min.
- Cambio de flag (tenant, plan, o global) → publica en Redis pub-sub `ff:invalidate` con el `flagName`.
- Todas las instancias escuchan y borran `ff:{flagName}:*` (con SCAN).
- Sin pub-sub, TTL de 5 min es aceptable para no-canaries. Para kill switch de emergencia, TTL 30s.

### 2.4 UI Admin

En admin-frontend (Tecny back office), nueva pantalla `/features`:

```
┌─────────────────────────────────────────────────────────────┐
│ Feature Flags                                                │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ push_notifications                                       │ │
│ │ Global: [OFF]  Rollout: [ 30% ▽]                        │ │
│ │ Overrides tenant:                                        │ │
│ │   • Distribuidora ACME (id=42): [ON] (canary)          │ │
│ │   • iPro Test (id=1):        [OFF] (skip test)         │ │
│ │ Overrides plan:                                         │ │
│ │   • pro:      [ON]                                     │ │
│ │   • starter:  [OFF]                                    │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 2.5 Auditoría

Cada cambio de flag → row en `audit_logs` con:
- `action`: 'FEATURE_FLAG_CHANGED'
- `payload`: `{ flag, prev, next, scope: 'tenant'|'plan'|'global', target: id }`
- `user_id`: quién cambió.

---

## 3. Fases

### F1 — Schema + resolver + tests (1.5 días)
- 2 migrations (tables + rollout_pct column).
- `lib/featureFlags.js` con `isFeatureEnabled(flag, tenantId)`.
- Hash determinístico + tests unitarios (buckets estables).
- Cache Redis con TTL + invalidate helper.
- Tests integración con setup DB.

### F2 — UI admin + endpoints (1 día)
- CRUD endpoints admin-only para setear overrides.
- Frontend admin: pantalla `/features` con tabla + modales de override.
- Audit log integration.

### F3 — Migración + docs (1 día)
- Migrar los 3 flags actuales al nuevo sistema (con `plan_id = null` = todos).
- Middleware `req.features` en Express que expone `{ push: true, redB2B: false, ... }` → frontend usa via `useFeatures()` hook.
- RUNBOOK: cómo hacer canary, cómo kill-switch, cómo rollout gradual.

---

## 4. Riesgos + trade-offs

### 4.1 Complexity creep
Un flag → simple. 30 flags con overrides per tenant + per plan → nightmare. **Regla**: máximo 15 flags activos + cleanup ritual mensual de flags "permanentes" (mover código sin flag).

### 4.2 Cache staleness
Si pub-sub falla (Redis down), overrides tardan hasta TTL en propagarse. Para kill switch de emergencia, tener endpoint `POST /admin/features/invalidate/:flag` que hace SCAN + DEL local + broadcast. También aceptable.

### 4.3 A/B test contamination
Si el mismo user cambia de tenant (feature nueva multi-tenant?), su bucket cambia. Documentar que rollout es por **tenant**, no por user.

### 4.4 Testing con flags off
Todos los tests corren con "default" state de cada flag. Documentar en tests helpers cómo overridear un flag para un test específico:

```js
await setFeatureForTest('push_notifications', true, { tenantId: 1 });
```

---

## 5. Tests

- Resolver: tenant > plan > rollout > global (precedencia).
- Hash determinístico: mismo input → mismo bucket 1000 veces.
- Rollout 30%: sobre 10000 tenants random, ~30% enabled ±2%.
- Cache invalidation: cambio → nuevo valor en < 1s en instancia B (pub-sub).
- Concurrent updates: 2 admins cambian el mismo flag → último gana (updated_at).
- RLS: `feature_flags_tenants` con FORCE, admin bypass.

---

## 6. Métricas de éxito

- Poder hacer canary rollout de 1 feature al 5% en < 30s desde UI.
- Kill switch: desactivar feature en 100% de tenants en < 30s.
- 0 incidents por deploy grande en los siguientes 6 meses.
- Aumentar velocity de lanzamientos: 1 feature grande/semana con confianza.

---

## 7. Deferrable a fase 2

- Rollout por **cohort custom** (ej. "tenants creados post-2026-06").
- Feature request desde el user directamente ("Solicitar acceso beta").
- Analytics dashboard: qué % de traffic usa la nueva UI, cuánto tardan, error rate.
- Rate-limited toggle: no cambiar el mismo flag > 3 veces por hora (evita whiplash).
