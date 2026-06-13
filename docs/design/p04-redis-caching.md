# P-04 — Redis cross-instance caching

**Estado:** ✅ **IMPLEMENTADO** (Fases 1-3 mergeadas y validadas en prod + staging
el 2026-06-12). Operaciones documentadas en
[docs/OPERATIONS.md sección 6](../OPERATIONS.md#6-redis-cache-cross-instance--agregado-2026-06-12-p-04).
**Origen:** GRAN auditoría 2026-06-10 — item #6 del top 10 hiper-prioritarios.
**Autor:** Claude + Lucas, 2026-06-12.
**Predecesor:** P-07 async audit (mergeado, PR #189).

## PRs

- PR #190 — Fase 2: librería ioredis + wrapper `createCachedFetcherRedis`
- PR #191 — hotfix `/health` fault-tolerant tras Railway healthcheck failure
- PR #192 — Fase 3.1: flag `audit_async_enabled` (validado cross-instance con 20 GETs)
- PR #193 — Fase 3.2: `cajasCache` (lista de cajas, 15s)
- PR #194 — Fase 3.3: `inventarioCache` (métricas dashboard, 20s)
- PR #195 — Fase 3.4: dashboard mensual (60s, key por par período)
- PR #196 — Fase 3.5: dashboard ventas (30s, key por par fecha)
- PR ??? — Fase 4: RUNBOOK operacional (este commit)

---

## 1. Contexto

iPro corre en Railway con **2 réplicas activas** del backend Express. Hoy todas
las capas de cache son **in-memory por proceso**:

| Módulo | TTL | Invalidación local | Riesgo cross-instance |
|---|---|---|---|
| `cacheTtl.js` (primitivo) | variable | sí (`.invalidate()`) | — |
| `cajasCache.js` | 15s | sí, ~6 callsites en `cajas.js` | Stale max 15s |
| `inventarioCache.js` (métricas) | 20s | sí, ~9 callsites en `ventas.js`/`cuentas.js` | Stale max 20s |
| `audit.js` (flag `audit_async_enabled`) | 60s | manual via `_clearAsyncCache()` | Stale max 60s (P-07) |
| `dashboard.js` (`resumen-mensual` por par período) | 60s | no | Stale max 60s |
| `routes/ventas.js` (dashboard P-05) | 30s | no | Stale max 30s |
| `routes/feature-flags.js` (listado) | desconocido | no | desconocido |
| `routes/alertas.js` | desconocido | no | desconocido |

**Síntoma observado en prod (incidente Railway):** cuando réplica A escribe
(ej. admin desactiva user, alta de caja, cambio de feature flag), réplica B
sigue sirviendo el valor stale hasta que expira su TTL. Para flags y permisos
esto es **inaceptable** — un permiso revocado tarda hasta 60s en ser efectivo
en TODAS las réplicas, ventana donde el user mantiene acceso indebido.

Para caches "fríos" (cajas, métricas) un stale de 15-20s es tolerable, pero a
medida que el sistema crece y se agreguen réplicas (3+), la fragmentación crece
linealmente.

**P-07 (audit async) acaba de aterrizar** y depende del cache de feature flag.
Si activamos `audit_async_enabled = true` desde admin, **tarda hasta 60s en
ser efectivo en TODAS las réplicas** — durante esa ventana el path sync sigue
corriendo. Esto es funcional pero confuso para operaciones. P-04 lo arregla.

---

## 2. Objetivos

1. **Invalidación cross-instance en <100ms** para datos críticos (flags,
   permisos, cajas, métricas).
2. **Cache miss tolerable** — caída de Redis NO debe tumbar el backend, solo
   degradarlo a comportamiento pre-cache (queries directas a Postgres).
3. **Migración progresiva** — un cache a la vez via feature flag, sin big bang.
4. **Compatible con P-07** — el flag `audit_async_enabled` se beneficia
   inmediatamente.
5. **Sin agregar latencia significativa** — Redis <2ms p99 en la misma región
   Railway (US-West).
6. **Multi-tenant ready** — keys con prefijo por tenant cuando llegue SE-02.

**No-objetivos** (fuera de scope):
- Reemplazar Postgres como source of truth. Redis es caché, no DB.
- Session storage (JWT sigue stateless).
- Rate limit (ya hay `postgresRateLimitStore.js`, funciona y multi-instance).
- Pub/sub para eventos de aplicación (event sourcing es otro problema).

---

## 3. Opciones de arquitectura

### Opción A — Redis directo (sin cache local)

Cada `getCached()` va directo a Redis. Cache local desaparece.

**Pros:**
- Mismo modelo mental que un single-instance: si está cacheado, todo el mundo
  lo ve igual.
- Implementación más simple — un wrapper `cacheTtl` que delega a `redis.get/set`.
- Invalidación es `redis.del(key)` — instantáneo cross-instance, sin pub/sub.

**Cons:**
- Cada lectura tiene latencia de red (1-5ms en mismo región Railway).
- Si Redis está down, fallback a fetch directo en cada request → degradación
  de throughput (pero sigue funcional).

### Opción B — Cache local L1 + Redis L2 + pub/sub invalidación

Cache local sigue para latencia mínima. Redis solo se usa para invalidación
cross-instance via pub/sub.

**Pros:**
- Hit local = sub-ms.
- Si Redis cae, cada réplica funciona con su cache local (degradación graceful
  a TTL stale).

**Cons:**
- Complejidad: 2 capas, 2 mecanismos de invalidación.
- Pub/sub: cada réplica subscribe a un canal `invalidate:cache`. Al recibir
  `invalidate:cajas`, llama `getCajasList.invalidate()` localmente.
- Bug class nueva: si pub/sub se cae temporalmente, las réplicas que se
  perdieron mensajes quedan con stale data hasta su TTL.

### Opción C — Redis solo para datos críticos (flags, permisos)

Mantener cache in-memory para cajas/métricas/dashboard (TTL chico ya es ok).
Solo agregamos Redis para feature flags y permisos que requieren invalidación
instantánea.

**Pros:**
- Scope mínimo. Tocamos menos código.
- Permite shipear rápido sin reescribir todos los caches.

**Cons:**
- Sigue habiendo fragmentación para caches frios. Si en 6 meses queremos
  invalidación cross-instance del cache de cajas, hay que volver a tocar.
- No resuelve el problema raíz, solo el síntoma más doloroso.

---

## 4. Recomendación: Opción A con fallback graceful

**Decisión: Redis directo (Opción A) con fallback automático a fetch directo
si Redis no responde.**

Razones:
1. **Mental model simple.** Un solo lugar donde está la verdad cacheada.
   No hay race conditions de pub/sub.
2. **Latencia aceptable.** 1-5ms vs sub-ms del local es invisible para el
   usuario final. Para endpoints high-frequency (cajasList se pide en cada
   page-load), el ahorro de no hacer la query Postgres compensa por amplio
   margen.
3. **Migración progresiva.** Por feature flag `cache_backend_X = "redis"`
   por módulo. Si algo va mal, rollback a `"local"` instantáneo. Default
   sigue siendo `"local"` hasta validar cada cache en staging.
4. **Operacional.** Una cosa que monitorear (Redis up/down) vs dos (Redis +
   pub/sub).

**Fallback degradation:** si `redis.get(key)` falla con timeout o conexión
caída, el wrapper hace fetch directo a Postgres y **NO cachea el resultado**
(porque sino quedaríamos con cache fragmentado entre réplicas como hoy).
Esto preserva consistency a costo de throughput durante el outage de Redis.

---

## 5. Plan de implementación

### Fase 1 — Infra (1 día)
- Provisionar **Railway Redis addon** (mismo provider, latencia <2ms).
- Variable de entorno `REDIS_URL` en backend service.
- Health-check endpoint `/health/redis` que pingea Redis.
- Sentry alert si Redis `PING` falla 3 veces consecutivas.

### Fase 2 — Librería + wrapper (1 día)
- Agregar `ioredis` (no `node-redis`): mejor support de cluster, mejor API,
  TypeScript-friendly. Última versión 5.x.
- Crear `backend/src/lib/redisClient.js` con:
  - Singleton lazy-init.
  - Connection pool (default ok para nuestro tráfico).
  - `setEx(key, ttlSec, value)` / `get(key)` / `del(key)` / `delPattern(prefix)`.
  - Timeout 500ms para evitar bloquear requests si Redis lagueado.
- Refactor de `cacheTtl.js`:
  - Nuevo wrapper `createCachedFetcherRedis(key, ttlMs, fetcher)`.
  - Misma API que el actual `createCachedFetcher` — drop-in replacement.
  - Decisión de backend por feature flag `redis_cache_<scope>_enabled`.

### Fase 3 — Migración progresiva por módulo (3-5 días)

**Orden de migración (de menor a mayor riesgo):**

| # | Cache | Razón orden | Riesgo |
|---|---|---|---|
| 1 | `audit_async_enabled` flag (P-07) | Único valor, ya en feature_flags | 🟢 |
| 2 | `cajasCache.js` | Crítico para dropdowns, alta frecuencia | 🟡 |
| 3 | `inventarioCache.js` métricas | Dashboard, medium frecuencia | 🟡 |
| 4 | `dashboard.js` resumen-mensual | Multiple keys por par período | 🟡 |
| 5 | `routes/ventas.js` dashboard P-05 | KPIs Ventas | 🟡 |
| 6 | Otros (alertas, feature-flags lista) | Bajo impacto | 🟢 |

Por cada uno:
1. Implementar el `_redis()` parallelo al `_local()` existente.
2. Activar flag `redis_cache_<scope>_enabled = true` solo en staging.
3. Validar 24h en staging con tráfico real.
4. Activar en prod via PATCH al flag.
5. Después de 1 semana sin issues, deprecar el path local (PR de cleanup).

### Fase 4 — Tests + docs (1-2 días)
- Tests de integración:
  - Cache hit ratio (mock redis y verificar calls).
  - Fallback: simular `redis.get` timeout → verificar fetch directo.
  - Invalidación cross-instance simulada (2 clients ioredis).
- Doc operacional en `docs/OPERATIONS.md`:
  - Comandos para limpiar cache manualmente (`redis-cli DEL <key>`).
  - Cómo verificar hit ratio.
  - Procedimiento de failover (Redis down → degradación).
- Doc en `docs/ARCHITECTURE.md`: diagrama actualizado con Redis.

**Total estimado: 1 semana de trabajo, dividida en PRs por fase para review
incremental.**

---

## 6. Operacional

### Provider: Railway Redis
- **$5-10/mes** por instancia (free tier no alcanza para prod).
- Misma región que el backend (US-West) → latencia <2ms p99.
- TLS por default.
- Backup automático cada 24h (Railway managed).

**Alternativas consideradas:**
- **Upstash** ($0 hasta 10k requests/día). Cross-region (us-east) — agrega ~50ms.
  Descartado por latencia.
- **Render Redis** (paid only). Sin razón para cambiar de Railway si ya está
  todo ahí.
- **Self-hosted** en Railway. Más config, sin backups managed. Descartado.

### Configuración recomendada
- **maxmemory-policy: allkeys-lru** — si llegamos al límite de memoria, descarta
  los keys menos usados. Más seguro que `noeviction` (que rechazaría writes).
- **maxmemory: 100mb** — más que suficiente para los caches que tenemos.
- **TLS habilitado** (Railway lo hace por default).
- **AUTH** con password rotable (Railway maneja).

### Monitoring
- **Hit ratio por scope** — log estructurado, exponer en `/health/cache-stats`.
- **Sentry alert** si hit ratio cae <50% en 5 min (algo está rompiendo el cache).
- **Sentry alert** si Redis ping falla.
- **Dashboard Grafana** (futuro): RPS Redis, latencia p99, hit ratio.

### Costo estimado total mensual
- Railway Redis: $5-10.
- Sentry alerts: incluido en plan actual.
- Engineering ongoing: 0 (cero mantenimiento si está provisionado correctamente).

---

## 7. Riesgos + Mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Redis down → todos los endpoints lentos | Bajo | Alto | Fallback automático a fetch directo. SLA Railway 99.9%. |
| Memory leak en Redis (keys sin TTL) | Bajo | Medio | Todos los SET con TTL explícito. maxmemory-policy = LRU. |
| Cache stampede (N requests al mismo key expirado) | Medio | Medio | Wrapper hace dedup via `pending` promise (igual que cacheTtl.js actual). |
| Cifrado en tránsito comprometido | Bajo | Alto | TLS habilitado por Railway. |
| Costo escalando con tráfico | Bajo | Bajo | Plan paid Railway escala automático. Monitor mensual del gasto. |
| Bug en wrapper cachea valor stale eternamente | Bajo | Alto | Tests de integración + alert si hit ratio = 100% por >1h. |
| Migración rompe un endpoint en prod | Medio | Alto | Feature flag por módulo, rollback instantáneo. Validación staging 24h por scope. |

---

## 8. Impacto en P-07 + futuras tandas

### P-07 (audit async) — inmediato
- `isAsyncEnabled()` consulta cache Redis en lugar de local.
- Cuando admin flipea el flag via `/api/feature-flags/audit_async_enabled`,
  invalidate `redis.del("cache:flag:audit_async_enabled")`.
- TODAS las réplicas ven el cambio en <100ms (siguiente lectura va a Redis).
- TTL puede subir a 5 min (en lugar de 60s) porque ya no dependemos de TTL
  para "eventual consistency". Menos round-trips a Redis.

### P-02 (auth/perms sin caché) — desbloqueado
P-02 es el TOP #2 del backlog. La query DB por permission check (2-3 queries
por request) tiene que cachearse, pero hoy es imposible cross-instance porque
si un admin desactiva user, las otras réplicas no se enteran. **Con Redis**
podemos:
- Cachear `perms:user:<id>` con TTL 5 min.
- En PUT `/api/usuarios/:id` (donde admin cambia perms), `redis.del(perms:user:<id>)`.
- Todas las réplicas ven los nuevos perms en <100ms.

### SE-02 (multi-tenant) — preparación
Las keys de Redis usarán prefijo `tenant:<id>:` desde el principio para no
tener que migrar después. Hoy solo hay 1 tenant implícito (`tenant:default:`),
pero el patrón está listo.

---

## 9. Open questions para Lucas

### Q1 — ¿Approve Opción A (Redis directo)?
La alternativa B (cache local + pub/sub) es más rápida pero MÁS COMPLEJA.
¿Confirmás que el tradeoff "1-5ms latencia extra" es aceptable a cambio de
"mental model simple"?

### Q2 — ¿Railway Redis o Upstash?
Railway: $5-10/mes, <2ms latencia, misma región.
Upstash: free hasta 10k req/día, ~50ms latencia (cross-region).
Mi reco: Railway por latencia. Upstash queda como Plan B si Railway falla.

### Q3 — ¿Empezamos por el flag de P-07 (Fase 3 #1) o vamos al combo P-04 + P-02?
Si arrancamos solo P-04 con migración de un cache simple (flag de P-07),
shipeamos rápido y validamos infra. **Después** atacamos P-02 (auth/perms
cache) sobre la base Redis ya andando.
Alternativa: combinar todo en un solo proyecto grande. **Mi reco: P-04
incremental primero, P-02 después.**

### Q4 — ¿Algún cache de los listados que querés priorizar antes que el orden propuesto?
El orden por defecto (flag → cajas → métricas → dashboard mensual → ventas
dashboard) es de menor a mayor riesgo. Si tenés evidencia operacional de
que algún cache está siendo problema HOY, lo movemos al principio.

### Q5 — ¿Provisionás vos el Redis addon en Railway o querés que arme un script?
Necesito `REDIS_URL` configurado para empezar Fase 2.

---

## 10. Decisión

Esperando approval de PO sobre Q1-Q5. Sin objeciones se procede como descrito.
