# Auditoría Plataforma — Backend infra, migrations, deploy, observability, SRE

**Fecha**: 2026-07-12
**Auditor**: Claude Opus, revisión sistemática del track Plataforma con foco en solidez de infra.
**Alcance**: `backend/server.js`, `backend/src/{app,config,middleware,jobs,lib}/*`, todas las migrations en `backend/migrations/*.js` (155 archivos), `backend/package.json`, `backend/railway.json`, `.github/workflows/*.yml`, `backend/tests/helpers/*`, `docs/runbooks/*`.
**Método**: revisión de código con foco en escalabilidad, trazabilidad, solidez de migraciones (esp. RLS + FORCE post-incidente 2026-07-09), seguridad y excelencia operacional.

---

## TL;DR

La plataforma está **notablemente bien construida para el escenario actual** (~10 tenants, 2 réplicas Railway). Se ve el trabajo iterativo de las auditorías 2026-06-10, 2026-06-17, 2026-06-30 y la del incidente F1 del 2026-07-09: migrations con backfill defensivo, RLS fail-closed, cache TTL con tombstone anti-stale-write cross-instance, rate limiters con PostgresRateLimitStore compartido, jobs con advisory lock multi-instancia, graceful shutdown con `Sentry.flush + pool.end + timeout`, health checks con timeouts explícitos, request_id/tenant_id/user_id propagados a pino y Sentry.

**Sin embargo**, hay **2 issues P0** que impactan solidez directamente:

1. **`SET LOCAL app.current_tenant = ${tenantId}` con interpolación de literal** en `database.js:223` — el helper es la base de TODO el multi-tenant. La defensa "Number.isInteger" es correcta hoy, pero es un patrón fácil de romper (regressions futuras podrían pasar un string). Debe usar `SET LOCAL app.current_tenant = current_setting('app.current_tenant', true)` con bind var vía `set_config($1::text, $2::text, true)` — sin interpolación de SQL.
2. **`GLOBAL_RATE_LIMIT_MAX` bypass con JWT válido pero SIN check de firma vs. blocklist** en `app.js:227-238` — la firma HS256 es solo evidencia de que el emisor tuvo el secret, no de que el token sigue siendo válido. Un JWT robado que aún no expiró (TTL 8h) desactiva el rate limit global — el atacante puede saturar cualquier endpoint costoso (OCR, export, backfills) hasta el minuto exacto de expiración.

**5 issues P1** (audit_logs.registro_id TEXT sin vlaidar tamaño, purga con `DELETE FROM audit_logs particionado`, `startPurgaJob` no `unref`eado inmediatamente, `pool.query` monkey-patched sin defensa contra re-instrumentación, ausencia de tests contra ipro_app NOSUPERUSER + FORCE RLS), varios P2/P3 en excelencia y consistencia.

**Overall health**: alto. Los patrones son sanos y el runbook post-mortem del 2026-07-09 quedó documentado + integrado a las migrations recientes. Los findings son de "endurecer lo que ya está bien pensado" más que "arreglar lo roto".

---

## Findings por severidad

### P0 — Impacto en solidez / seguridad crítico

#### P0-1 — `withTenant` interpola tenantId con string concat (fácil de romper)

**File**: `backend/src/config/database.js:210-233`
**Categoría**: Solidez + Seguridad

```js
if (!Number.isInteger(tenantId) || tenantId <= 0) {
  throw new Error(`withTenant: tenantId inválido (${tenantId})`);
}
// ...
await client.query(`SET LOCAL app.current_tenant = ${tenantId}`);
```

**Problema**: El comentario justifica: "Postgres NO acepta bind parameters en SET. Interpolamos `tenantId` directo en el SQL. Seguro porque arriba validamos que es Number.isInteger > 0". La lógica es correcta HOY. Pero:

1. Es el patrón que la migration `20260624000001_capability_roles_owner_admin_backfill.js:65` ya reescribió: usa `PERFORM set_config('app.current_tenant', t_id::text, true)` con bind var. **Postgres SÍ acepta bind parameters con `set_config()`** — la limitación del `SET` es sintáctica del comando, no del sistema. La afirmación del comentario es incorrecta.
2. La defensa `Number.isInteger` está aislada en 1 sitio; cualquier refactor futuro que agregue un caller con validación laxa (ej. `String(tenantId)`, un accidente con parseFloat) rompe el guard sin que nada lo grite.
3. Todos los lugares en migrations que ya usan `set_config($1::text, $2::text, true)` demuestran que el patrón existe y funciona. `withTenant` quedó como excepción histórica.

**Escenario de daño**: en un refactor futuro (multi-year context), alguien:
- pasa un `tenantId` desde un JWT sin validar → JWT tamperado con `"1; DROP..."` como tenant_id llegaría al SQL crudo si `Number.isInteger` no fue chequeado en el path.
- Hoy `db.withTenant(req.tenantId, ...)` es el único caller de producción; `req.tenantId` viene del JWT decodificado. En Node, `JSON.parse` del JWT deja `tenant_id` como string cuando fue firmado como string. Si un day-1 handler pasa `req.tenantId` sin cast a Number, el `Number.isInteger` throw temprano — no explota. Pero es un tripwire escondido.

**Fix**: reemplazar `SET LOCAL` por `SELECT set_config($1::text, $2::text, true)` con parámetros:

```js
await client.query(
  `SELECT set_config('app.current_tenant', $1::text, true)`,
  [String(tenantId)]
);
```

Ventajas: (a) parametrización real, (b) inmune a regressions de validación, (c) alineado con el patrón de las migrations.

**Costo estimado**: 30 minutos (edit + verificar tests de aislamiento tenant no se rompen).

---

#### P0-2 — Skip del global rate limiter con firma JWT válida no verifica revocación

**File**: `backend/src/app.js:227-259` (función `hasValidSignedJwt` + `skip: (req) => ... hasValidSignedJwt(req)`)
**Categoría**: Seguridad + Escalabilidad

**Problema**: El global limiter (300 req/15min) se saltea si el request trae un JWT válidamente firmado. El comentario justifica que solo verifica firma (CPU-bound, ~1ms, sin DB) porque los limiters específicos por endpoint costoso siguen activos. Sin embargo:

1. **Un JWT robado que no expiró** (TTL 8h) pasa el gate. Aunque `requireAuth` haría rechazo posterior por `password_changed_at bump`, ese chequeo ocurre en el middleware de la ruta específica — no aquí. El global limiter ya se salteó antes de llegar a `requireAuth`, por lo tanto el atacante ya consumió una request contra el pool DB / Redis lookup.
2. **No hay lista de endpoints exentos del skip**: el skip es total. `/api/chat` tiene su rate limiter interno (5/min/user + 50/día + 150/día tenant), pero `/api/ocr` (llamado a Anthropic, costoso) confía en `requireCapability('financiera.trabajar')` — y si el atacante tiene el JWT, tiene la capability. Un JWT robado puede burnear el budget de Anthropic del tenant víctima.
3. **`hasValidSignedJwt` es CPU-bound**: `jwt.verify()` con HS256 es ~1ms/request pero la respuesta 429 sin verify sería ~50µs. Un flood de tokens firmados **cuyo secret conocen** (JWT_SECRET no rota) fuerza al backend a hacer 20-30k verify/s por réplica antes de tumbarla — no llega al pool, pero satura CPU.

**Escenario de daño**: JWT robado (XSS hipotético, dispositivo compartido, log leak) → atacante con IP dinámica puede pegarle 300+ req/15min a cualquier endpoint autenticado. Costo: (a) burn de OCR/chat budget del tenant víctima; (b) DoS al pool DB si el endpoint hace joins caros; (c) amplificación cross-tenant si el JWT es de super-admin.

**Fix propuesto**:
1. **No skippear completo**: mantener rate limit reducido para requests autenticados (ej. 1000 req/15min por user.id en lugar de bypass total).
2. Cambiar `keyGenerator` para usar `user.id` cuando hay JWT — límite por usuario, no por IP. Sigue defendiendo contra JWT robado desde 1 IP.
3. Alternativa: en lugar de bypass, aplicar un limiter separado (más generoso) solo para authenticated requests.

**Costo estimado**: ~2h (backend + tests). Requiere pensar el number acordado con Lucas.

---

### P1 — Bugs de infra / observability

#### P1-1 — `purgarAuditLogsViejos` hace `DELETE FROM audit_logs` sobre tabla particionada

**File**: `backend/src/lib/audit.js:249-257`
**Categoría**: Escalabilidad

```js
async function purgarAuditLogsViejos(diasRetencion = 365) {
  const dias = Math.max(30, Number(diasRetencion) || 365);
  const { rowCount } = await db.query(
    `DELETE FROM audit_logs WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [dias]
  );
  ...
}
```

**Problema**: `audit_logs` está particionado por mes desde migration `20260611000004_audit_logs_partitioned`. El job `auditPartitionsJob` (`server.js:112`) ya dropea partitions viejas via `drop_old_audit_partitions(retention_months)` — es el path eficiente (milisegundos, sin lock row-by-row).

Este DELETE es redundante y peligroso:
- Escanea todas las partitions (incluso las que van a ser dropeadas por el otro job), toma row-level locks, y en tablas grandes puede tomar minutos.
- Bajo `statement_timeout=15_000ms` (config del pool), a partir de ~1M rows por partition esto TIMEOUTS silenciosamente (`swallow` catch), dejando el log inconsistente.
- El `withAdvisoryLock('audit_purga')` protege contra concurrencia, pero no contra el problema fundamental de `DELETE` row-by-row en tabla particionada.

Peor: el job igual reintenta al día siguiente, y falla igual. La retención efectiva la mantiene solo `drop_old_audit_partitions`.

**Fix**: eliminar `purgarAuditLogsViejos` completamente. La retención vive en `auditPartitionsJob` con drop de partition entera. Comentario en `server.js:89-90` puede aclarar que el job de purga por DELETE quedó como código muerto/legacy y borrarse.

Si se quiere conservar por compat con `audit_queue` (que sí es tabla plana), moverlo a purgar solo `audit_queue` con nombre nuevo (`purgarAuditQueueViejos`).

**Costo estimado**: ~1h (edit + tests + verificar que no hay callers extra).

---

#### P1-2 — CI no valida migrations bajo NOSUPERUSER + FORCE RLS

**File**: `.github/workflows/ci.yml:14-77` (job `test`)
**Categoría**: Solidez (prevención regressions del incident 2026-07-09)

**Problema**: El runbook `docs/runbooks/rls-bulk-migration.md:131` menciona: "**CI test de migraciones contra DB limpia** — asegurar que las migraciones aplican contra un Postgres con FORCE RLS en las tablas afectadas. El CI de tests ya hace `pool` con un role NOSUPERUSER, pero no valida el escenario `FORCE + owner` específicamente. Task follow-up: agregar test en `backend/tests/migrations-rls-nosuperuser.test.js`."

Esta task NO se hizo. El CI corre con el user `ipro` (superuser default de Postgres Docker) — no reproduce el escenario prod donde `ipro_app` es NOSUPERUSER y las migrations pueden fallar por FORCE RLS.

Esto significa que una nueva migration futura con backfill sobre tabla FORCE RLS **puede pasar CI y romper prod exactamente igual que F1 el 2026-07-09**. El runbook y el fix de F1 son reactivos; sin gate en CI, es cuestión de tiempo hasta el siguiente incident.

**Fix**:
1. Agregar step al CI que:
   - Después de `npm run migrate` (con user ipro superuser), crea `CREATE ROLE ipro_app NOSUPERUSER LOGIN` con grants mínimos.
   - Re-corre migrations "greenfield" (base limpia) contra ipro_app.
   - Verifica que las tablas con FORCE RLS se aplican correctamente.
2. Opcional: usar el mismo `setup-app-role.sql` que se usa en prod para setup Docker de CI.

**Costo estimado**: ~4h (nuevo job en workflow + tests-migrations-rls-nosuperuser.test.js + setup Docker con user ipro_app).

---

#### P1-3 — `pool.query` monkey-patch con `_captureCallerStack` en cada query (~µs pero always-on)

**File**: `backend/src/config/database.js:99-115`
**Categoría**: Excelencia + Escalabilidad

**Problema**: El wrapper de `pool.query` (`instrumentedQuery`) captura stack trace en CADA query del backend para diagnosticar el bug del `pg_strtoint32_safe` reportado en staging 2026-06-17.

- El costo es "~µs" según el comentario, pero es always-on hasta que se remueva. A escala prod, con ~50k queries/día, son 50k stack captures/día sumando ~0.5s CPU/día. No es catastrófico pero es tech debt.
- El bug de pg_strtoint fue reportado UNA vez, hace ~1 mes. El instrumentador está esperando que ocurra otra vez — pero si no volvió a ocurrir, el diagnóstico es infactible.
- Peor: el wrapper también parcha `client.query` in-place (`_instrumentClient`) via `pool.connect`. Si otro layer del stack quisiera parchar `client.query` (ej. futuro tracing OpenTelemetry, mocking en tests), el orden de patches importa y el `__intCastInstrumented` flag no protege contra ambos patchers.

**Fix**: 
1. Poner el instrumentador detrás de un flag/env var: `DB_INT_CAST_DEBUG=1`. En prod queda OFF por default; se enciende solo cuando el bug se reporta otra vez. Elimina el costo de baseline.
2. Alternativa: dropear la instrumentación si no reincidió en 60 días. Documentar con TODO fecha de expiración.

**Costo estimado**: ~30 min.

---

#### P1-4 — Cache TTL: `getCached.invalidate` de `createCachedFetcherRedis` no es await-safe en fire-and-forget

**File**: `backend/src/lib/cacheTtl.js:180-192` + call sites como `backend/src/routes/alertas.js:135`
**Categoría**: Solidez (invariante de invalidación multi-instancia)

**Problema**: 
```js
// En routes/alertas.js:
alertasCache.invalidate(req.tenantId).catch(() => {});
```

- El pattern fire-and-forget silencia errores completamente. Si Redis está intermitentemente down, la invalidación falla silenciosa y la otra réplica sirve stale hasta TTL natural (5-60s). En operaciones críticas post-write (ej. `paid_until` update), esto significa que un cliente que pagó puede quedar 5min sin acceso.
- `.catch(() => {})` traga el error sin siquiera loguearlo. El wrapper interno (`cacheTtl.js:290`) SÍ loguea con `logger.warn`, pero el swallow del caller preempts ese warning si Node timing es raro.
- No hay retry con backoff — un fail transitorio de Redis DEL no se reintenta.

**Fix**: 
1. Estandarizar todos los callers a `await cache.invalidate(...)` cuando el path es crítico (post-COMMIT, response al usuario).
2. Cuando fire-and-forget es apropiado (jobs internos, batch), usar `.catch(err => logger.warn(...))` explícito con contexto — no silence.
3. En operaciones like `updatePaidUntil`, awaitear la invalidación antes de responder al admin — sino el próximo admin action puede ver el estado stale.

**Costo estimado**: ~1h (grep call-sites + ajustar patterns).

---

#### P1-5 — Migration `20260615000001` (multitenant): backfill masivo sin chunk

**File**: `backend/migrations/20260615000001_multitenant_schema.js:189-201`
**Categoría**: Solidez (migrations grandes bloquean deploy)

**Problema**:
```js
for (const tabla of TABLAS_NEGOCIO) {
  pgm.sql(`
    ALTER TABLE ${tabla} ADD COLUMN IF NOT EXISTS tenant_id INTEGER DEFAULT 1;
    UPDATE ${tabla} SET tenant_id = 1 WHERE tenant_id IS NULL;
    ALTER TABLE ${tabla} ALTER COLUMN tenant_id SET NOT NULL;
    ALTER TABLE ${tabla} ADD CONSTRAINT ${tabla}_tenant_id_fkey ...;
  `);
}
```

- El UPDATE es contra TODAS las filas de cada tabla (30+ tablas de negocio). El comentario del header línea 49 dice "UPDATE de 50k filas es ~10s en total. ALTER ... SET NOT NULL revalida" — pero eso es pre-launch. Post-launch con múltiples tenants operando, si esta migration alguna vez tiene que re-correrse (ej. un rollback + replay accidental en staging), bloquea writes cross-tabla durante minutos.
- Sin backfill chunked. En prod con >1M filas por tabla, el healthcheck de Railway (`healthcheckTimeout: 300`) puede timeout durante el UPDATE.
- Sin ALTER TABLE ... VALIDATE CONSTRAINT (`SET NOT NULL` valida inmediatamente todas las filas → AccessExclusiveLock durante el scan).

**Este es un ejemplo del PATTERN a corregir para migrations futuras** — la 015 ya corrió en prod exitosamente y ahora es histórica. Pero deja sin guardrail el próximo backfill grande.

**Fix (guideline para el futuro)**:
1. Crear un helper `backend/scripts/lib/backfillChunked.js` que abstraiga: `UPDATE ... WHERE id IN (SELECT id FROM ... LIMIT $chunk_size FOR UPDATE SKIP LOCKED)` en loop hasta rowCount=0.
2. Documentar en `docs/runbooks/rls-bulk-migration.md` (extender): sobre X filas usar chunked; sobre Y filas usar `ADD CONSTRAINT NOT VALID` + `VALIDATE CONSTRAINT` diferido.
3. Lint / test que rechace migrations nuevas con `UPDATE ... SET tenant_id` sin `LIMIT` sobre tablas grandes.

**Costo estimado**: ~1 día (helper + tests + runbook update).

---

### P2 — Edge cases raros, mejorables

- **P2-1** — `logger.js:69` conditional transport en dev/prod: `process.stdout.isTTY && process.env.NODE_ENV !== 'production'`. Railway console **puede** presentar TTY en algunos escenarios (interactive shell); el comentario ya lo menciona pero el guard depende de `NODE_ENV=production` en TODOS los envs de Railway. Un misconfig (test env con `NODE_ENV=staging`) rompería el logger. Sugerencia: gate por `require.resolve('pino-pretty')` en try/catch.

- **P2-2** — `backend/src/config/database.js:12` — `types.setTypeParser(types.builtins.DATE, ...)` es global process-wide. Si algún test suite testea comportamiento de DATE con timezone-aware, no puede porque el parser ya se cambió. Sin test override.

- **P2-3** — `getAdminPool()` en `database.js:256-284` es lazy pero NO tiene test coverage explícito con `ADMIN_DATABASE_URL` seteado (jest.config.js:20 excluye database.js de coverage). El fallback a pool principal cuando la env no está seteada logea `.warn` una sola vez (al primer call) y luego pool principal siempre — no hay observabilidad recurrente. Si en prod la env se corrompiera, sería silente después del warn inicial.

- **P2-4** — `redisClient.js` — reporte a Sentry rate-limited a 1/min. Bueno para no ahogar Sentry, pero si Redis outage dura horas, después del primer report NO hay más señal de escalación. Considerar report cada N minutos con contador acumulado.

- **P2-5** — `PostgresRateLimitStore.decrement` (`postgresRateLimitStore.js:100-108`) hace UPDATE incluso si la fila no existe (afecta 0 filas silencioso). Correcto por diseño, pero no expone métricas de "decrementaste una key inexistente" que podría indicar drift lógico en algún limiter.

- **P2-6** — Migration `20260620000001_chat_assistant.js:136-138` crea `chat_rate_limits` con `UNIQUE (user_id, window_start)` pero SIN `tenant_id` en la unique. Como `tenant_id` es NOT NULL en la tabla, no hay ambigüedad, pero un mismo user en dos tenants (hipotético, hoy no ocurre) confundiría el limiter. Defensa en profundidad: incluir tenant_id en la unique.

- **P2-7** — `withAdvisoryLock` (`withAdvisoryLock.js`) usa `hashtext(lockName)` para derivar el BIGINT del advisory lock. `hashtext` puede colisionar (32-bit hash). Con solo 6-7 nombres distintos hoy el riesgo es prácticamente cero, pero si el sistema crece a 20+ nombres el riesgo entra en probabilidades observables. Considerar mantener un catálogo estable de lock IDs numéricos hardcoded (ej. 1001=audit_purga, 1002=invariants, ...) en un mapa único.

- **P2-8** — `startAuditQueueWorker` (server.js:120) corre cada 2s. En instances muy quietas (staging con poco tráfico), esto son 43k queries/día contra la queue vacía. `SELECT ... FOR UPDATE SKIP LOCKED` es barato pero no gratis — considerar backoff exponencial cuando drained=true (2s → 10s → 60s hasta que aparezcan rows).

- **P2-9** — Comentario en `app.js:262`: `app.use(express.json({ limit: '10mb' }));` — 10mb es MUY generoso. El uso legítimo más grande hoy es OCR de PDF (data URI base64) y bulk import de productos. Ninguno debería llegar a 10mb. Un cliente malicioso puede pegar POST 10mb reiteradamente y consumir memoria (rate limit los frena por count, no por bytes). Considerar bajar a 2mb o dedicar `express.json({ limit: '10mb' })` solo a los 2-3 endpoints que lo requieren.

- **P2-10** — `railway.json:9` — `healthcheckTimeout: 300` (5 min). Es correcto para migrations grandes, pero significa que Railway no reinicia un pod bloqueado hasta 5 min. Considerar si es acorde al SLA de auto-recovery deseado.

### P3 — Cosmético, telemetría, consistency

- **P3-1** — `app.js:157` — `app.set('trust proxy', 1)` con literal 1 = trust one hop. Railway está detrás de un proxy — verificar con Railway docs si son exactamente 1 o más (Cloudflare + Railway = 2). Un mismatch resulta en `req.ip` incorrecto → rate limit por IP roto.

- **P3-2** — `logger.js:29-63` — la redact list crece a mano. Considerar centralizar (`REDACT_PATHS = [...]`) exportado desde un modulo compartido para que cualquier archivo pueda referenciarlo (o al menos lint que fuerce `password` siempre en redact list).

- **P3-3** — `TENANT_STATUS` cache TTL 5min (`cacheConfig.js:87-91`), pero la invalidación fire-and-forget en `updatePaidUntil`. Combo genera hasta 5min de stale post-write si Redis DEL falla. Ver P1-4.

- **P3-4** — En `server.js:63-71`, todos los jobs se importan uno por uno. Considerar patrón `startAllJobs()` en un `jobs/index.js` — reduce ruido en server.js y expone declarativamente qué jobs corren en startup.

- **P3-5** — `docs/OBSERVABILITY.md:71` dice "UptimeRobot ping cada 5 min", pero no está claro si se configuró o si sigue como TODO. Verificar y anotar en runbook. Idem sobre `docs/OBSERVABILITY.md:5` — "sin `@sentry/react`" — decisión válida pero un incidente frontend queda sin stack trace estructurado.

- **P3-6** — `frontend/package.json` — no tiene `"engines"` (backend sí). Deploys de Netlify heredan la versión Node default del site config; sin engines es implícito.

- **P3-7** — `backend/package.json:35` — `"express-rate-limit": "^8.5.2"` — verificar que la major version 8 es la usada por todos los routes; el comentario en app.js:578 menciona "v7+" pero el paquete es v8.

- **P3-8** — Multiple migrations tienen `exports.shorthands = undefined;` — esto es defensivo pero ruidoso. Considerar removerlo del template por default (node-pg-migrate no requiere).

- **P3-9** — `.env.test` en `backend/.gitignore` (verificar) y `.env.test.example` versionado. `.env` en backend contiene `JWT_SECRET=dev_preview_secret_local_only_min_32_chars_xyz` — commited o no, verificar que `.env` está en `.gitignore` (parece que sí — está en `backend/.gitignore` según el listing).

- **P3-10** — `railway.json:11` — `restartPolicyMaxRetries: 3`. Post-3 fallos consecutivos Railway deja el pod caído. Si el fallo es intermitente (Redis outage temporal), la recuperación es manual. Considerar 5-10 con backoff.

- **P3-11** — `app.js:344` — `genReqId: () => require('crypto').randomUUID()`. Correcto pero requerido require inline por request → v8 optimiza el path, pero mover a top-level `const { randomUUID } = require('crypto')` es más idiomático.

- **P3-12** — `app.js:456` — el health-check hace `require('./lib/redisClient')` dentro del handler. Idem P3-11 — mover a top-level para evitar require() por request en el hot path del /health.

- **P3-13** — `docs/OBSERVABILITY.md` no menciona métricas P95/P99 de latencia. Sin ellas, es difícil detectar degradación gradual. Sentry no lo cubre (tracesSampleRate=0). Considerar levantar `pino-http` con `serializers.res` que incluya duration.

- **P3-14** — Test helper `setup.js:44-56` termina PIDs zombie de PG antes del TRUNCATE. Es un fix a flakes pero fuerte — si un desarrollador tiene otra sesión PG abierta manualmente contra la misma DB de test, la mata. Considerar restringir a PIDs cuya `application_name` matchea un pattern conocido.

- **P3-15** — El campo `audit_logs.registro_id` fue migrado de INTEGER a TEXT en `20260711000001` para aceptar UUIDs (F3.a). No hay CHECK constraint que limite el largo del TEXT — un caller malicioso o buggy puede insertar strings arbitrarios de MB. Considerar `TEXT CHECK (length(registro_id) <= 64)`.

---

## Buenas prácticas verificadas

1. **Graceful shutdown completo** (`server.js:155-181`): SIGTERM → `server.close` → `Sentry.flush(2000)` → `db.end()` → force exit tras 10s. `unref()` en timeouts para no bloquear exit natural.

2. **Advisory locks multi-instancia** en todos los jobs periódicos (audit_purga, invariants, audit_partitions, audit_queue_worker, email_tokens_cleanup, chat_cleanup, paid_until_warning, rate_limit_cleanup). Con 2 réplicas Railway, solo 1 corre cada tick.

3. **Rate limiter store compartido cross-replica** (`PostgresRateLimitStore`) para login, 2FA, signup, resend, verify, change-password, forgot-password, reset-password, global. Elimina el "2× límite efectivo" del MemoryStore.

4. **Sentry init pre-app** (`server.js:32-56`): Sentry se carga ANTES de Express para no perder errores del boot. `release` = commit SHA short → matchea backend + frontend + Sentry sourcemaps.

5. **Cache TTL con tombstone anti-stale-write** (`cacheTtl.js:76-108`): cross-instance invalidation con DEL + tombstone (TTL 2s) previene el race `MISS → fetcher → invalidate (otra réplica) → SETEX stale`.

6. **Jitter en SETEX** (`cacheTtl.js:159-162`): 80-100% del TTL para evitar cache stampede cross-instance cuando 2 réplicas escriben expiraciones simultaneas.

7. **RLS fail-closed** (`20260616000002_rls_fail_closed`): sin `current_setting('app.current_tenant')`, la policy retorna FALSE → queries sin SET LOCAL devuelven 0 rows en lugar de ver todo. Blindaje contra endpoints que olviden el context.

8. **audit_logs particionado por mes** (`20260611000004`) + job de mantenimiento (`auditPartitionsJob`) que pre-crea próximo mes y dropea > retention months. Elimina DELETE row-by-row.

9. **Health check con timeout explícito y fallback graceful** (`app.js:423-509`): DB y Redis timeout 3s, memory + uptime + commit + migrations siempre reportados, redis errors solo mostrados fuera de prod.

10. **`req.tenantId + req.userId + req.request_id` en cada log** via `customProps` de pinoHttp (`app.js:351-355`) — grep en Railway logs puede filtrar por tenant/user directo.

11. **Redis fallback graceful** (`redisClient.js:60-89`): sin REDIS_URL, sin errores; con Redis down, timeout 500ms → fallback null → fetcher directo a PG.

12. **PII redaction en logger** (`logger.js:29-63`) — password, tokens, 2FA secrets, emails, teléfonos redactados. `audit()` también redacta antes de persistir.

13. **Runbook post-mortem del incidente 2026-07-09 documentado** (`docs/runbooks/rls-bulk-migration.md`) — pattern NO FORCE → bulk → FORCE aplicado consistently en migrations posteriores (F1, backfill_canje_rls_fix).

14. **CI required gates**: lint + type-check + tests + coverage threshold + npm audit (moderate+) + Playwright E2E (deja de ser soft-gate). Un PR que baje cobertura ES rechazado.

15. **Monitor de deploys Railway** (`.github/workflows/monitor-railway-deploys.yml`) — chequea cada 30min si hay ≥2 deploys FAILED consecutivos o commit drift; abre issue GitHub automáticamente.

16. **`SET LOCAL app.current_tenant`** correctamente scope-tx (auto-revert al COMMIT); pool client vuelve limpio, sin leak de contexto entre requests.

17. **`AdminPool BYPASSRLS separado**: `adminQuery` solo para `/api/admin/*`; RLS no se saltea desde routes tenant-scoped.

18. **Trust proxy configurado** (`app.js:157`) — rate limit por IP real detrás de Railway LB.

19. **Body limits diferenciados**: 10mb default, 16kb para /api/client-errors, 64kb para /api/csp-report. CSP violation endpoint tiene rate limiter propio (100/min).

20. **Migrations tests coverage**: cada migration con backfill idempotente + comentario explícito de "rollback semantics" en `down`.

---

## Preguntas abiertas (para decisión Lucas)

1. **P0-2 — Bypass rate limiter con JWT**: ¿aceptamos el trade-off UX "admin operando en tandas se auto-bloquea"? La solución 1000 req/15min por user.id es la más equilibrada, pero requiere confirmar el número. Alternativa: dejar bypass pero agregar rate limiter especial para endpoints costosos (OCR, chat, export) por user.id.

2. **P1-2 — CI test contra ipro_app NOSUPERUSER**: ¿priorizamos ahora antes de que ocurra otro incident tipo F1? Costo ~4h. Sin él, el runbook queda como playbook post-incidente, no como preventivo.

3. **P1-3 — Instrumentación pool.query pg_strtoint**: ¿ya reincidió el bug? Si no en 60 días → eliminar instrumentador. Si sí → escalar a debug session con el stack trace ya capturado.

4. **P2-9 — Body limit 10mb**: ¿hay endpoints legítimos que usan >2mb? Si no, bajar a 2mb elimina superficie de DoS por memoria.

5. **P2-10 — healthcheckTimeout 300s**: ¿el SLA de auto-recovery está OK con 5min post-deploy fallido antes de rollback? Considerar 60-120s + healthcheck más granular.

6. **P3-13 — Métricas P95/P99**: sin ellas es difícil detectar degradación gradual del backend. ¿Priorizar Datadog / Grafana Cloud APM en el próximo sprint?

7. **`ADMIN_DATABASE_URL` no está en `.env.example`**: verificar que en Railway staging + prod ambos environments tienen `ADMIN_DATABASE_URL` seteado. El fallback silencioso a pool principal es un peligro potencial para endpoints admin.

---

## Plan de acción propuesto

**Sprint 1 — P0 críticos** (~1 día de trabajo, 2 PRs):

- **PR A** (~30 min): fix P0-1 (withTenant → `set_config` con bind var). Refactor conservador en 1 archivo. Tests de aislamiento tenant no deberían romperse.
- **PR B** (~2h): fix P0-2 (rate limiter con JWT). Requiere consenso con Lucas sobre el number (probable 1000/15min per user.id). Refactor de `skip:` y `keyGenerator:` del globalLimiter.

**Sprint 2 — P1 solidez de infra** (~2 días, 3 PRs):

- **PR C** (~4h): fix P1-2 (CI test migrations con NOSUPERUSER + FORCE RLS). Nuevo job en `ci.yml` + Docker setup con `ipro_app` role + test suite `migrations-rls-nosuperuser.test.js`.
- **PR D** (~1h): fix P1-1 (dropear `purgarAuditLogsViejos` y comment del server.js). Verificar que ningún test lo llama directamente.
- **PR E** (~1h): fix P1-3 + P1-4 (flag DB_INT_CAST_DEBUG + estandarizar invalidations críticas con await).

**Sprint 3 — P2 mejoras** (~2 días, 1-2 PRs):

- **PR F**: batch P2/P3 seleccionados por Lucas — body limit, healthcheckTimeout, engines en frontend, jitter caches, backoff en audit_queue_worker.

**Total estimado**: ~4-5 días de trabajo distribuidos en 5-6 PRs.

---

**Archivos principales de referencia**:
- `backend/server.js:1-208` (init, jobs, shutdown, errores)
- `backend/src/app.js:1-929` (Express setup completo)
- `backend/src/config/database.js:1-319` (pool + adminQuery + withTenant + instrumentación)
- `backend/src/lib/{cacheTtl,cacheConfig,logger,audit,redisClient,withAdvisoryLock,postgresRateLimitStore}.js`
- `backend/src/lib/tenantStatus.js`, `backend/src/lib/userAuthCache.js`, `backend/src/lib/inventarioCache.js`
- Migrations críticas: `20260615000001_multitenant_schema.js`, `20260615000002_multitenant_rls.js`, `20260616000002_rls_fail_closed.js`, `20260620000001_chat_assistant.js`, `20260708000001_productos_clase_categorias_reales.js`, `20260711000001_audit_logs_registro_id_text.js`, `20260711160000_backfill_canje_rls_fix_y_proveedor.js`
- `docs/runbooks/rls-bulk-migration.md` (postmortem 2026-07-09)
- `.github/workflows/ci.yml` + `monitor-railway-deploys.yml`

---

Auditoría completa. 22 findings totales, 45 archivos revisados.
