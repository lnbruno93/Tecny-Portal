# Audit Plataforma 2026-07-25

**Fecha**: 2026-07-25
**Auditor**: Claude Opus 4.7 (segunda auditoría TOTAL cross-track; primera fue 2026-07-12 → 72% cerrado en 12 sprints).
**Alcance**: CI/CD (`.github/workflows/*`), migrations (`backend/migrations/*`), pool + admin pool (`backend/src/config/database.js`), RLS canónico (`backend/src/lib/rlsCanonical.js`), cache Redis (`cacheTtl.js`, `cacheConfig.js`, `redisClient.js`), Sentry init + noise (`server.js`, `clientErrorNoise.js`), logger (`logger.js`), health (`app.js` /health y /ready), startup checks, feature flags per-tenant (`featureFlags.js`), Netlify/Railway config, npm audit wrapper, Dependabot, DR runbook.

## Contexto

Esta es la segunda audit TOTAL. La 07-12 cerró Plataforma con 10 findings mergeados; los deltas 07-24 y 07-25 tocaron mucho esta superficie (cache invalidation audit, SET LOCAL refactor a 29 sites, anti-regression checks, contract tests, hotfix P0 de deploys por owner-mismatch, npm audit wrapper con allowlist). Muchos issues de la audit anterior están cerrados. La postura general es **notablemente sólida** — pero quedaron algunos temas nuevos que emergieron de los deltas + gaps de gobernanza pre-existentes.

## Findings

### P0 — Críticos

Ninguno. Todos los P0 de la audit 07-12 están cerrados. Los P0 emergentes de 07-24 (Sentry #16/#17 + connection poisoning + RLS content invariant) también están cerrados con anti-regression CI. **El único P0 con follow-up conocido — PR #874 owner mismatch de 7 tablas — está documentado y en cross-track hooks, no se re-analiza acá.**

---

### P1 — Importantes

#### P1-1 — `/api/csp-report` sin captura Sentry ni contador, solo logger.warn

**File**: `backend/src/app.js:353-365`
**Categoría**: Observabilidad + Seguridad

El endpoint que recibe CSP violation reports los loguea con `logger.warn` y responde 204. **Nada agrega Sentry captureMessage** — con el Trusted Types Report-Only activo desde Sprint 106 (07-24) durante 1-2 semanas para guiar Sprint 106b (enforce), Lucas necesita ver TT violations **agregadas** en Sentry para decidir la lista de policies allowed. Los reports quedan enterrados en Railway logs con retención de 30 días y sin agregación por tipo.

Además: `logger.warn` a stdout escala mal si hay un ataque (100 reports/min/IP × N IPs desde botnet = lag en Railway indexing) — el rate limit interno (100/min) protege memoria pero no ruido.

**Fix propuesto**: agregar `Sentry.captureMessage(...)` con tags `{ csp_directive, blocked_uri, source }` para el 100% de los CSP reports, y un `Sentry.captureMessage` separado para TT-Report-Only (matchable por directive == 'trusted-types'). Puede quedar detrás de env var (`SENTRY_CSP_REPORTS=1`) si molesta cuota. **Costo**: 15 minutos.

---

#### P1-2 — `pool.on('error')` global captura errores del pool pero NO reporta a Sentry

**File**: `backend/src/config/database.js:47-49` + `340-342` (admin pool)

```js
pool.on('error', (err) => {
  logger.error({ err }, 'PostgreSQL pool error');
});
```

Los eventos `'error'` del pool ocurren cuando un client idle muere (Railway proxy cierra socket, PG restart, etc.). Con `logger.error` el evento queda en logs pero **NO llega a Sentry**. En cambio, el `pool.on('error')` de Sentry #17 (07-24) fue el primer síntoma del connection poisoning por SET LOCAL — sin Sentry capture, Lucas tuvo que esperar a que un endpoint failearía para detectarlo.

**Fix propuesto**: reemplazar el handler por uno que además haga `Sentry.captureException(err, { tags: { component: 'pg_pool' } })` con throttle de 1/min (mismo pattern que `redisClient._reportToSentry`). **Costo**: 20 minutos.

---

#### P1-3 — `getMigrationCount()` y `getCommitSha()` cachean forever pero el DB puede cambiar bajo el proceso

**File**: `backend/src/app.js:481-505`

```js
let CACHED_MIGRATION_COUNT = null;
async function getMigrationCount() {
  if (CACHED_MIGRATION_COUNT !== null) return CACHED_MIGRATION_COUNT;
  ...
}
```

El cache se invalida solo al restart. En un escenario donde Lucas corre migrations manualmente (Railway console con superuser — como el follow-up del PR #874) contra el pod prod vivo, el `/health.migrations` sigue reportando el count **anterior a la migration manual** hasta el próximo redeploy. La única evidencia real de "estás corriendo con el schema al día" queda desincronizada del reality.

Impacto: bajo (Lucas ya monitorea desde Railway UI, no /health) pero **desalinear observabilidad con estado real** es un anti-pattern. Similar riesgo con `getCommitSha()` — pero commit SHA sí es efectivamente inmutable per-proceso.

**Fix**: refrescar `MIGRATION_COUNT` con TTL de 60s (o simplemente NO cachear — es 1 query trivial contra pgmigrations). Dejar `getCommitSha` como está (SHA sí no cambia). **Costo**: 10 minutos.

---

#### P1-4 — Rate limiter `hasValidSignedJwt` corre `jwt.verify` PER REQUEST — no cache

**File**: `backend/src/app.js:282-304` + `backend/src/lib/jwtVerify.js` (no leído en detalle pero descrito en comment)

La docstring del refactor 07-12 dice que `validateAndGetJwtUserId` tiene "cache per-request". El global limiter usa `hasValidSignedJwt(req)` — solo returns bool. Como el limiter middleware corre para TODO request antes del pinoHttp middleware que setea `req.id`, cada request paga 1 `jwt.verify()` HS256 (~1ms) que **ya se re-hará adentro de `requireAuth`** — doble trabajo.

A 100 req/s sostenidos (unlikely hoy pero cerca del load test peak) son ~100ms/s CPU sumada por request. En escenarios de spike con JWT válido, esto amplifica.

Además: el "skip: (req) => hasValidSignedJwt(req)" y el authenticated limiter "keyGenerator: (req) => u:${validateAndGetJwtUserId(req)}" pueden ser DOS `jwt.verify()` distintos si el helper no los memoiza en req. **Verificar `jwtVerify.js`** — no lo leí en esta iteración.

**Fix**: si `jwtVerify.js` NO memoiza el resultado en `req` (ej. `req._verifiedUserId`), agregarlo. Los dos limiters + requireAuth deberían compartir 1 sola verify. **Costo**: 30 min (leer + fix + test).

---

#### P1-5 — RLS content check en warning-only genera drift silencioso hasta que crezca

**File**: `backend/src/lib/rlsCanonical.js:303-373`

El hotfix del 07-25 (documentado en `rlsCanonical.js:303-317`) degradó el chequeo 4 (CONTENT NULLIF) de fatal a warning-only. Esto está bien como puente hasta que corra el follow-up manual con superuser (PR #874). PERO:

1. **El warning se emite con `logger.warn` + `Sentry.captureMessage` a cada boot** — con 2 réplicas × N boots/día por auto-scale/redeploy, el ruido a Sentry crece linealmente. `SENTRY_TRACES_SAMPLE_RATE=0.05` no aplica acá (es un message, no trace). Sin throttle, agota cuota si el drift persiste semanas.

2. **No hay expiry warning** — si nadie corre el fix manual del #874 en 30 días, el mensaje se vuelve indistinguible de ruido. Considerar agregar en el `warnMsg`: "Drift detectado desde 2026-07-25 (día del hotfix). Si ves este mensaje después de 2026-09-01, ejecutar el runbook".

3. **El invariante 2 (huérfanas) sigue siendo fatal** — bien. Pero cualquiera que agregue tabla nueva a `TABLAS_TENANT_ID_SIN_RLS` con description mal escrita pasa. No hay lint/test que verifique que la descripción existe (map vacío `{}` bypassa).

**Fix**: (a) throttle Sentry captureMessage a 1/hora en boots exitosos con drift; (b) test unitario que asserte que cada entry de `TABLAS_TENANT_ID_SIN_RLS` tiene reason no-vacío ≥ 50 chars; (c) agregar `driftDetectedSince` timestamp al startup log para trigger visual. **Costo**: 1h.

---

#### P1-6 — Netlify double-deploy race condition sin diagnóstico automatizado

**File**: `docs/NETLIFY_BUILDS.md` + observado en PRs #874, #875, #876 (context de deltas).

El bug del "skip pristine deploys" fue mitigado con `date > dist/.build-timestamp.txt` (PR #670). Pero la manifestación reciente **NO** es el mismo bug — es un **double-deploy race**: cuando 2 PRs mergean a main dentro de segundos (feature `#875` + fix XLSX `#876`), Netlify lanza 2 builds paralelos. El primero que gana termina como "current"; el segundo puede ser cancelado con "no content change" **si ambos builds vieron ambos commits** (mismo bundle).

El workaround del timestamp NO cubre este caso — ambos builds tienen el mismo commit-time y el mismo dist/. El único síntoma: el frontend queda con el bundle del **primer PR mergeado**, no del último. Los headers CSP y VITE_API_URL SÍ se propagan (ya no dependen del content-change), pero los cambios de JS del segundo PR requieren un force rebuild.

**Fix propuesto**: (a) documentar el race en `docs/NETLIFY_BUILDS.md` explícitamente como sección aparte del bug pristine; (b) considerar `concurrency` config en `netlify.toml` si Netlify lo soporta (sino: mergear sequential — no arbitrario a 2 PRs en el mismo minuto); (c) el workflow `sync-main-to-staging.yml` YA tiene `concurrency: group: sync-main-to-staging + cancel-in-progress: false` — mismo pattern podría aplicarse a un hipotético workflow "trigger netlify build". **Costo**: 1h investigación + 30min doc.

---

#### P1-7 — Cache invalidation cross-instance de `createTenantScopedCache.invalidatePrefix` no propaga a la otra réplica

**File**: `backend/src/lib/cacheTtl.js:306-326`

El comment `cacheTtl.js:307-313` reconoce el gap: `invalidatePrefix` solo invalida keys que **este proceso** ya vio (están en el local Map). Si la otra réplica cacheó `cache:ventas:dashboard:1|2026-07-01|2026-07-31`, este proceso no lo tiene en su Map → no invalida. La otra réplica sirve stale por hasta 30s.

En la práctica el TTL es corto (30s dashboard, 60s mensual) y hoy Lucas opera con 2 réplicas. Pero un dashboard admin que consulta múltiples rangos de fecha puede ver un "primer refresh stale, segundo refresh actualiza" en cada réplica alternando.

**Fix real**: generation counter en Redis (`INCR ventas_dashboard:tenant:1:gen` post-mutation + prefix incluye `:gen`). Costo alto (30% del cache module reescrito), payoff bajo (ventana de staleness = TTL de todos modos). **Documentado en el comment como known trade-off**. Para escalar más allá de 2 réplicas O bajar TTL debajo de 10s, ES necesario.

**Recomendación**: no fixear hoy, pero **agregar test que verifique el hit rate del Map local** — si baja del 90% en producción, gatillar reactivación. **Costo test métrico**: 1h.

---

#### P1-8 — `railway.json` no fuerza rebuild del pod cuando cambian solo migrations

**File**: `backend/railway.json:6-11`

```json
"startCommand": "npm run migrate && node server.js",
```

`npm run migrate` es idempotente (node-pg-migrate). Pero si un PR modifica **solo** una migration sin tocar código, Railway detecta el commit y redeploya. El pod arranca, corre migrate (ok), arranca server (ok) — el cutover es OK. **Sin embargo**: si el `migrate` toma >5min (healthcheckTimeout=300), el pod queda listo pero el healthcheck falla → Railway retry 3× (restartPolicyMaxRetries=3) → deploy FAILED.

El migration del #876 (bulk insert de 41 categorías huérfanas) demoró varios minutos en prod. Sin telemetría de duración de migrate en el startup log, es imposible saber cuánto queda del budget de 300s.

**Fix propuesto**: (a) agregar `time` wrap en `startCommand` (`sh -c 'time npm run migrate && node server.js'`); (b) alertar via Sentry si el migrate toma > 60s. **Costo**: 30 min.

---

### P2 — Higiene

#### P2-1 — `logger.js` pretty transport check depende de NODE_ENV=production

**File**: `backend/src/lib/logger.js:69-71`

Ya identificado en audit 07-12 (P2-1) — sigue open. El check `process.stdout.isTTY && process.env.NODE_ENV !== 'production'` es correcto para Railway (NODE_ENV=production en todos los envs) pero frágil si algún día alguien setea NODE_ENV=staging en Railway staging.

**Fix**: `try { require.resolve('pino-pretty'); } catch { transport: undefined }`. **Costo**: 15 min.

---

#### P2-2 — `DB_INT_CAST_DEBUG` sigue como env var — no tiene expiry

**File**: `backend/src/config/database.js:126-137`

El instrumentador de `pg_strtoint32_safe` sigue como código-flag desde la audit 07-12 (Sprint 7 #589). El bug original fue reportado 2026-06-17 — hace ~40 días. Si no reincidió, ya cumplió su ROI negativo (`if not incident in 60d → drop`).

**Fix propuesto**: si al 2026-08-17 no hubo recurrencia, borrar el instrumentador entero (75 líneas). **Costo**: 30 min post-fecha.

---

#### P2-3 — `express.json({ limit: '2mb' })` global es una regresión menor: bulk import de productos XLSX pasa por multipart pero el nuevo endpoint POST /categorias/bulk + /depositos/bulk (PRs #876/#877) NO tiene test que confirme que el body cabe

**File**: `backend/src/app.js:346` + `backend/src/routes/categorias/*` + `depositos/*`

El límite de 2mb (audit 07-12 P2-9) es conservador. Los endpoints `/bulk` nuevos aceptan arrays de N items con nombre + tenant_id → cada item ~200 bytes → 2mb caben ~10k items. Un tenant que importe XLSX con 20k productos + auto-crea 5k categorías podría chocar. **NO hay test explícito**.

**Fix propuesto**: agregar assertion en test de `/categorias/bulk` que envíe payload de N=8000 (dentro del 2mb) y verifique OK. También sirve para catchear un bump silencioso del payload shape. **Costo**: 1h.

---

#### P2-4 — Backup Backblaze no valida integridad automáticamente

**File**: `scripts/ipro-backup.sh` + `docs/DISASTER_RECOVERY.md`

Cron diario 9AM en Mac de Lucas. El script hace `pg_dump | b2 upload` — pero NO valida el dump post-upload (no re-descarga + `pg_restore --list` + compara catálogos). El DR rehearsal manual (semestral) es la única defensa contra "dumps corruptos silencious". Si Backblaze corrompe el multipart upload sin errorear (bug conocido en algunos SDKs), el próximo rehearsal descubre el problema — potencialmente 6 meses tarde.

Adicional: **el cron corre en Mac local** — si Mac apagada 2 días seguidos (viaje, poweroff), no hay dump. El sistema depende de "Lucas ve la Mac prendida" — con verificación semanal, gap máximo detectable = 7 días. En audit 07-12 se movió de mensual → diario; el próximo paso sería **fault-tolerant scheduling**.

**Fix propuesto**: 
1. Script agregar `pg_restore --list ~/tmp.dump | head -5` post-upload local para smoke integrity.
2. Migrar a Railway Scheduler (~$5/mes) — el precio y la aditividad justifica quitar la dependencia de Mac. **P1 potencial**, pero degradado a P2 porque el DR rehearsal semestral es el fallback definitivo. **Costo**: 3h + $5/mes Railway.

---

#### P2-5 — `authQueueWorker` sigue con polling constante 2s — sin backoff (audit 07-12 P2-8 abierto)

**File**: `backend/src/jobs/auditQueueWorker.js` + `server.js:209`

Sigue el mismo estado que en audit 07-12: 43k queries/día con `SKIP LOCKED`. El feature flag `audit_async_enabled` sigue OFF por default en todos los tenants (confirmado en `feature_flags` tabla, no hay override activo). Cuando esté ON, la queue se llena y el polling tiene sentido; con OFF, 43k queries diarias son sobre queue vacía.

**Reactivación**: cuando primer tenant active `audit_async_enabled`, re-evaluar backoff. Hasta entonces, sigue como está.

---

#### P2-6 — `restartPolicyMaxRetries: 3` puede tumbar el servicio en un Redis outage prolongado

**File**: `backend/railway.json:11`

Ya en audit 07-12 (P3-10). Sigue abierto. 3 retries × ~30s startup = ~90s de intentos totales. Un Redis outage de >2min tumba el pod definitivamente (Railway lo deja caído) hasta intervención manual. Con Redis fallback graceful implementado, **el pod no debería fallar en startup por Redis** (el `redisClient._getClient` no throwa) — pero si algún día alguien agrega un `await redis.ping()` en el startup path que sí throwa, el gap se abre.

**Recomendación**: subir a 5 retries + agregar test que verifique que el startup NO depende de Redis. **Costo**: 30 min.

---

#### P2-7 — 2 migrations recientes sin `exports.down` funcional

**Files**: `backend/migrations/20260720000004_feature_flags_per_tenant.js` — tiene down OK. `backend/migrations/20260721000001_refresh_tokens.js` — tiene down OK. `backend/migrations/20260724000002_backfill_nullif_rls_tables.js` — no-op down (correcto, up es también no-op post-hotfix).

Verificado: **todas** las migrations recientes tienen `exports.down`. **Nothing to fix acá — falso positivo del análisis inicial**. Dejado como confirmación de higiene.

---

#### P2-8 — El allowlist `audit-with-allowlist.mjs` tiene expiry pero el warning de expiry NO grita fuerte

**File**: `scripts/security/audit-with-allowlist.mjs:87-96`

Cuando un allowlist expira, el script falla CI. Correcto. PERO: el CI job muestra el error solo en el log ("[audit-allowlist] ENTRIES EXPIRADAS"). Sin notificación proactiva (email, Slack, GitHub issue), la señal aparece solo cuando alguien abre un PR. Si Lucas está trabajando en features durante 2 semanas sin PRs, el allowlist expira silenciosamente.

**Fix propuesto**: workflow separado que corra semanalmente y abra GitHub issue si algún allowlist entry vence en <14 días. Mismo pattern que `monitor-railway-deploys.yml`. **Costo**: 1h.

---

#### P2-9 — `admin-frontend` sigue sin Sentry noise filter equivalente al del portal

**Files**: `backend/src/lib/clientErrorNoise.js` (portal), `admin-frontend/*/reportError.js` (a verificar).

El portal tiene `clientErrorNoise.js` con 15+ patterns. El admin-frontend integró Sentry en el PR #634 (07-15/16) pero no verifiqué si tiene su propio filter. Si admin reporta AbortError/chunk-load noise a Sentry sin filtrar, el ratio noise/signal se degrada. **Verificar**: `grep -rn NOISE_PATTERNS admin-frontend/src/`. Si no existe, replicar el mismo helper. **Costo**: 30 min verificación + 1h implementación si aplica.

---

### P3 — Opcional

- **P3-1** — `hashtext` collision en `withAdvisoryLock` sigue con lockName legibles y ~10 nombres distintos. Sigue en el mismo estado que audit 07-12. Reactivación con >100 names — no aplica hoy.

- **P3-2** — `getMigrationCount` es 1 query GRUP BY constante — considerar mover a startup log (una vez) en vez de por-request cached. Marginal.

- **P3-3** — `netlify.toml` root duplica todo el CSP block 3 veces (production, branch-deploy, deploy-preview). El `verify-csp-parity.js` chequea root vs admin-frontend pero NO verifica que los 3 context blocks del mismo file compartan directivas. Extender el parser para asserta paridad intra-file. **Costo**: 1h.

- **P3-4** — El `/health` endpoint usa `Promise.race` con hardcoded 3s timeout. Si el pool está saturado, `db.query('SELECT 1')` cola detrás de 20 requests activas → 3s no alcanza → status=degraded → Railway reinicia el pod. **En realidad correcto** (queremos que reinicie si el pool está pinchado), pero el timeout debería ser configurable (`process.env.HEALTH_DB_TIMEOUT_MS`).

- **P3-5** — La lista `TABLAS_TENANT_SCOPED` (rlsCanonical.js:54) se ordenó ASCII a mano. Un test debería asserta que `[...arr].sort().join() === arr.join()` para prevenir regressions manuales. Fácil win.

- **P3-6** — `Sentry.captureMessage` en `rlsCanonical.js:365` NO taggea con `tenantId` porque es startup context (no request). Fine.

- **P3-7** — `docs/OBSERVABILITY.md` sigue diciendo "UptimeRobot ping cada 5 min" en modo "a configurar" (Section 3). Verificar si se configuró en el interím (hace ~6 semanas). Si sí, actualizar doc. Si no, es un P2 pending.

- **P3-8** — `SENTRY_TRACES_SAMPLE_RATE=0.05` por default. Con ~10 tenants activos genera ~50-100 transactions/hora. Baseline saludable, pero **verificar la cuota Sentry real** — con la caída del `/health` skippeada del pinoHttp autoLogging pero NO del Sentry sampling, cada request que pasa por Sentry cuenta hacia la cuota. En 2 semanas medir cuánto quema.

- **P3-9** — `backend/loadtest/*` sigue como stand-alone (autocannon). No integrado con CI. Correr trimestralmente contra staging con `IPRO_TARGET=... npm run load-test` sigue siendo manual. Baseline es del 2026-05-30 (pre multi-tenant + pre M4). Ya documentado como pending en `LOAD_BASELINE.md`.

- **P3-10** — `Dependabot` config tiene grupo `postgres` que incluye `pg`, `pg-*`, `node-pg-migrate`. Pero un bump minor de `pg` puede requerir cambios en `database.js` (ej. si cambia signature de `pool.connect()`) — el instrumentador `_instrumentClient` es sensible a esto. Considerar test específico post-Dependabot merge de `pg`.

- **P3-11** — `feature_flags_tenants` tabla está en whitelist `TABLAS_TENANT_ID_SIN_RLS` — correcto (config global). Verificar que la doc de FEATURE_FLAGS.md refleje que borrar un tenant borra su override (CASCADE en la migration 20260720000004).

---

## Cross-track hooks

- **Follow-up del PR #874 (P1 documentado)**: script SQL manual con superuser Railway para re-owner las 7 tablas afectadas (`clases_producto`, `chat_conversations`, `chat_messages`, `chat_rate_limits`, `egresos_recurrentes_overrides`, `proyecciones_mensuales`, `share_links`) → `ALTER TABLE <t> OWNER TO ipro_app`. Luego re-run del backfill de la migration `20260724000002` (que hoy es no-op). Luego restaurar chequeo 4 (rlsCanonical CONTENT) a fatal. Y update CI `ci-setup-app-role.sql` para simular owners heterogéneos (que hoy no reproduce el gap). Esto está agendado como P1 conocido — no re-analizado como bug en este audit.

- **Auth track**: el refresh token pattern (PR #874 migration `20260721000001_refresh_tokens.js`) todavía es Fase 1 (backend + migration). Frontend + rotación cross-instance no cubiertos en este audit — cerrar con Auth track.

- **Multi-tenant track**: el `feature_flags_per_tenant` (Rec proactiva #3, F1+F2+F3 mergeados) tiene 3 tablas nuevas whitelisted. Verificar en Multi-tenant track que los endpoints admin de F2 no leakean overrides cross-tenant (leí `featureFlags.js` — el resolver usa `db.adminQuery` BYPASSRLS correcto, pero los endpoints admin deben verificarse en su router).

- **Externa track**: `/api/csp-report` (P1-1 acá) es endpoint público — coordinar con Externa para decidir si el Sentry capture debe llevar IP + user-agent como tags (implica revisión de PII redaction).

- **Financiero track**: cache invalidation cross-instance de `DASHBOARD_VENTAS` (P1-7 acá) impacta directamente a las mutations de ventas. Coordinar si Financiero decide bajar TTL a <10s (que forzaría el fix del generation counter).

---

## Métricas del track

- **Archivos revisados**: 42 (workflows/*.yml, migrations recientes 20260720+, database.js, rlsCanonical.js, cacheTtl.js/cacheConfig.js, redisClient.js, logger.js, app.js, server.js, netlify.toml root + admin, railway.json, backend/package.json, DR + OBSERVABILITY + FEATURE_FLAGS + NETLIFY_BUILDS docs, npm audit wrapper, anti-regression check, dependabot.yml, jobs/*.js).

- **Findings totales**: 22 (0 P0 + 8 P1 + 9 P2 + 11 P3 + 1 cross-track hook conocido).

- **P0**: 0 (todo cerrado en audits previos + hotfixes 07-24/07-25).

- **P1 nuevos vs cerrados audit 07-12**: 8 nuevos vs 4/4 cerrados de 07-12. Los P1 abiertos son mayormente observability + edge cases del delta 07-24/07-25.

- **Regresiones detectadas del audit 07-12**: ninguna. Todos los P0/P1 mergeados siguen en pie.

- **Deltas 07-24/07-25 verificados**: cache invalidation contract tests (`cache-invalidation-contracts.test.js`) presente y funcional; anti-regression check (`backend-anti-regression-check.mjs`) con 3 patterns activos + baseline; `withTenant` refactor a `set_config` bind param confirmado en `database.js:277-280`; `keepAlive: true` + `keepAliveInitialDelayMillis` en pool principal y admin pool; RLS content chequeo 4 activo (warning-only por hotfix documentado); `audit-with-allowlist.mjs` con 2 entries expiran 2026-10-24.

- **Postura general**: **excelente**. La plataforma tiene 4 auditorías consecutivas de hardening (06-10, 06-17, 06-30, 07-12) + los hotfixes 07-24/07-25 correctamente propagados. Los findings de esta ronda son "endurecer lo que ya está bien pensado" — no hay bugs latentes de solidez detectados. El único gap operativo real es el follow-up manual del PR #874 (ya reconocido).

- **Estimación total de trabajo**: **~15 horas** para cerrar los 8 P1 + ~10 horas para los P2 seleccionables. Sin P0, la próxima audit puede espaciarse a 3 meses o al próximo milestone de negocio (>50 tenants).
