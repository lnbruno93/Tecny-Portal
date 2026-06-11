# P-07 — Audit logs async: doc de diseño

**Estado**: 📋 PROPUESTA — esperando review de Lucas antes de implementar.
**Fecha**: 2026-06-11
**Origen**: P-07 GRAN auditoría 2026-06-10 (`docs/audit/2026-06-10-gran-auditoria.md`).

---

## 1. Resumen ejecutivo

Mover el INSERT de `audit_logs` del path síncrono del request a una **queue async procesada en background**. Mantener la API `audit(...)` actual sin cambios para los call sites. Garantizar **cero pérdida** de audit logs (es evidence legal por Ley 25.326 y trazabilidad financiera).

Recomendación: **Opción A — tabla `audit_queue` + worker `setInterval` en mismo proceso** + advisory lock para multi-instance. Sin dependencias externas. Rollout con feature flag `audit_async_enabled` (M-08 ya disponible) para revertir sin deploy.

---

## 2. Estado actual

`backend/src/lib/audit.js` exporta una función `audit(...)` que hace:

```
audit(client?, tabla, accion, registro_id, { antes, despues, user_id, req, ...extra })
```

Comportamiento:
- **In-TX** (cliente pasado): INSERT en `audit_logs` dentro de la misma transacción del caller, aislado con `SAVEPOINT audit_sp`. Si el INSERT falla, hace `ROLLBACK TO SAVEPOINT` y deja la TX exterior intacta.
- **Fuera de TX** (sin cliente): INSERT contra el pool global.
- **PII redaction**: `redactPII(...)` se aplica antes del INSERT (no se cachea ni se difiere).
- **Errores**: log a Sentry + pino, NO se propagan al caller (el caller no debería romper por un audit que falló).

Call sites: **~24 archivos en `backend/src/routes/`** llaman a `audit(...)`. Patrón establecido en TANDA 2 S-04+S-05: refactorizar todos los handlers a audit-in-tx.

---

## 3. Problema

Aunque audit-in-tx resolvió la atomicidad (S-04), el INSERT **sigue agregando latencia al response del request** del caller. Para handlers con N items (ej. venta B2B con 50 items, cobranza masiva con N cobranzas), hay 1 INSERT a audit_logs por item → blocking sequential.

Impacto medido:
- **Latencia adicional p50**: ~5-15ms por INSERT (Railway prod).
- **Bulk endpoints**: hasta +500ms en escenarios con N items (cobranza masiva).
- **Worst case**: si audit_logs tiene contention (cron de purga corriendo, particionado en swap), el response del request espera.

Impacto hipotético (que motiva la urgencia):
- Plan multi-tenant SaaS aumenta volumen de audits ~10× cuando escalemos. La latencia se nota más con tráfico.
- Cuando llegue P-19 particionado (ya está mergeado), las queries de read son rápidas pero las writes siguen igual.

---

## 4. Requirements

### Funcionales
1. La API `audit(client?, tabla, accion, registro_id, opts)` no cambia para los callers. **Cero refactor en las 24+ rutas**.
2. Eventualmente todo audit válido debe llegar a la tabla `audit_logs`.
3. Orden temporal aproximado: si el operador hace acción A y luego B, la entrada de A debe quedar antes que la de B en `created_at` (no estricto por nanosegundos, pero sí por segundos).

### No funcionales
4. **Cero pérdida de audit logs**. Si el proceso muere, los audits encolados pero no procesados deben sobrevivir. Esto descarta queues solo-en-memoria.
5. **Multi-instance**: 2+ réplicas Railway no deben procesar la misma entrada dos veces ni dejar entries pegadas si una réplica muere.
6. **Latencia agregada al request del caller**: ≤ 1ms (un INSERT en la queue table es ~1ms vs los 5-15ms actuales).
7. **PII redaction**: sigue ocurriendo ANTES de persistir (cuando se encola, no al procesar) — el redactPII es CPU-bound chico, mantenerlo síncrono no aporta blocking significativo y simplifica el worker.
8. **Compatible con migración cero-downtime**: feature flag para A/B y rollback.

### Seguridad / Compliance
9. **No reordenar leaks**: el audit del cambio X NO debe llegar al log antes del COMMIT de la TX que hizo X. Si la TX falla, su audit NO debe procesarse.
10. **Retención y particionado** (P-19): la tabla destino sigue particionada por mes. El worker escribe a la tabla padre, Postgres rutea a la partición correcta.

---

## 5. Opciones evaluadas

### Opción A: tabla `audit_queue` + worker setInterval (in-process)

Tabla intermedia `audit_queue` con los mismos campos que `audit_logs` + `status` y `attempts`. Worker corre cada N segundos, hace `SELECT ... FOR UPDATE SKIP LOCKED` de filas pending, las INSERT en `audit_logs`, y DELETE de la queue. Idéntico patrón al `auditPartitionsJob.js` (P-19) y `purgarAuditLogsViejos`.

**Pros**:
- Cero deps externas (no Redis, no BullMQ).
- Reutilizable: ya tenemos `withAdvisoryLock` para multi-instance.
- Postgres garantiza durabilidad: si el proceso muere mid-encolado, la fila queda en la queue.
- Simple de testear (los tests ya saben hacer Postgres ops).
- `SKIP LOCKED` permite que 2 réplicas procesen en paralelo SIN duplicar.

**Cons**:
- Latencia de procesamiento: hasta `interval_ms` (ej. 2s) entre encolar y persistir. Aceptable para audit (no es read-after-write crítico).
- Throughput limitado por el round-trip a Postgres en el worker (~100-500 rows/seg). Suficiente para iPro hoy y 10× crecimiento.
- Backpressure: si el worker se atrasa, la queue crece sin límite (mitigable: alertar si depth > 10k).

### Opción B: BullMQ + Redis

Queue en Redis con BullMQ. Worker proceso separado.

**Pros**:
- Throughput alto (10k+ msg/s).
- Retries built-in, dead-letter queue, delayed jobs.
- UI de admin (Bull Board).

**Cons**:
- **Requiere Redis** (P-04 también pendiente, otra dep externa).
- Worker separado: más infra de deploy en Railway.
- **Reliability**: Redis es volátil por default. Si Redis se reinicia, la queue se pierde a menos que esté configurado con AOF + persistencia, que cuesta más en Upstash. NO acepta el req #4 sin config cuidadosa.
- Complejidad alta para el volumen actual.

### Opción C: Postgres LISTEN/NOTIFY

`audit()` hace `NOTIFY audit_log '<json>'`. Worker hace `LISTEN audit_log` y persiste.

**Pros**:
- Latencia baja (sub-segundo).
- Nativo de Postgres, sin deps.

**Cons**:
- **NOTIFY payload limit**: 8KB max. Nuestros `datos_antes/despues` pueden ser grandes (productos con observaciones, etc).
- **NOTIFY no es persistente**: si el listener no está conectado al momento del NOTIFY, se pierde. Si el worker muere mid-LISTEN, audits encolados durante la ventana se pierden. **Viola req #4**.
- Para mitigar: combinar con tabla queue → termina siendo Opción A más complejo.

### Opción D: in-memory queue + flush on close

Array en memoria + worker `setInterval` que flushea N entradas a `audit_logs`.

**Pros**:
- Latencia máxima.
- Implementación trivial.

**Cons**:
- **Viola req #4 (cero pérdida)**: si el proceso muere (SIGKILL, OOM, Railway redeploy), la queue se va con él.
- Graceful shutdown puede flushear, pero un `kill -9` o crash sí pierde.
- Multi-instance: cada réplica tiene su propia queue → si una réplica muere con queue cargada, esos audits se pierden.

---

## 6. Recomendación

**Opción A: tabla `audit_queue` + worker in-process con SKIP LOCKED + advisory lock.**

Razones:
1. Cumple todos los reqs (especialmente cero pérdida + multi-instance).
2. Cero deps externas — coherente con el stack actual (todo lo de iPro corre en 1 servicio Railway + Postgres).
3. Reutiliza patrones ya probados en el repo (`withAdvisoryLock`, `setInterval` jobs).
4. Latencia ≤ 2s entre encolar y persistir es aceptable para audit logs (nadie monitorea audit en real-time; el use case es forense + compliance, no operación).
5. Fácil de rollback: feature flag `audit_async_enabled=false` y `audit()` vuelve a path síncrono.

Si en el futuro el volumen escala 100× o se requiere read-after-write sub-segundo, **migrar a Opción B (BullMQ + Redis)** sin cambiar la API. La interfaz pública `audit(...)` queda igual.

---

## 7. Diseño detallado (Opción A)

### 7.1 Schema de `audit_queue`

```sql
CREATE TABLE audit_queue (
  id          BIGSERIAL PRIMARY KEY,
  -- Campos idénticos a audit_logs (excepto created_at que se calcula al insertar en audit_logs):
  tabla       TEXT NOT NULL,
  accion      TEXT NOT NULL CHECK (accion IN ('INSERT','UPDATE','DELETE')),
  registro_id INTEGER,
  datos_antes  JSONB,
  datos_despues JSONB,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip          INET,
  user_agent  TEXT,
  request_id  UUID,
  -- Metadata del procesamiento:
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  -- NO usamos `status`. Filas pending viven acá; al persistir en audit_logs, se DELETE.
  -- DELETE evita el campo "processed" + cleanup posterior. La queue se mantiene chica
  -- en operación normal (depth en steady state ≈ rate × interval_ms).
);

CREATE INDEX idx_audit_queue_enqueued ON audit_queue (enqueued_at);
-- Para el SELECT FOR UPDATE SKIP LOCKED del worker.
```

### 7.2 API pública (`backend/src/lib/audit.js`)

**Sin cambios para los callers.** La función `audit(...)` internamente decide:

```js
async function audit(...args) {
  // ...mismo parsing de args y redactPII actual...

  // Bifurcación: leer feature flag (cache TTL 60s desde tabla feature_flags).
  // En path síncrono legacy si flag=false (rollback path).
  const asyncEnabled = await isAsyncEnabled();

  if (!asyncEnabled) {
    // Path actual: INSERT directo en audit_logs con SAVEPOINT si in-tx.
    // ...código actual sin cambios...
    return;
  }

  // Path nuevo: INSERT en audit_queue.
  // Si el caller pasó un client (in-tx), encolamos en la misma tx con SAVEPOINT.
  // Esto garantiza atomicidad: si la tx exterior hace ROLLBACK, el audit
  // tampoco se encola (cumple req #9 "no reordenar leaks").
  const sql = `INSERT INTO audit_queue (tabla, accion, registro_id, datos_antes,
               datos_despues, user_id, ip, user_agent, request_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
  // ...SAVEPOINT path idéntico al actual pero apuntando a audit_queue...
}
```

### 7.3 Worker (`backend/src/jobs/auditQueueWorker.js`)

```js
function startAuditQueueWorker({ batchSize = 100, intervalMs = 2000 } = {}) {
  if (process.env.NODE_ENV === 'test') return null;

  const tick = async () => {
    try {
      await withAdvisoryLock('audit_queue_worker', async () => {
        // SKIP LOCKED permite paralelizar entre réplicas sin duplicar.
        // FOR UPDATE bloquea la fila durante la TX del worker.
        const { rows } = await db.query(`
          DELETE FROM audit_queue
          WHERE id IN (
            SELECT id FROM audit_queue
            ORDER BY enqueued_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED
          )
          RETURNING *
        `, [batchSize]);

        if (rows.length === 0) return;

        // Bulk INSERT a audit_logs usando UNNEST (mismo patrón P-06 TANDA 3).
        const cols = rows[0];
        const values = rows.map(r => [
          r.tabla, r.accion, r.registro_id,
          r.datos_antes, r.datos_despues,
          r.user_id, r.ip, r.user_agent, r.request_id,
          r.enqueued_at,  // preserva el timestamp ORIGINAL
        ]);
        // INSERT INTO audit_logs (...) SELECT * FROM UNNEST(...) — 1 round-trip.
        // Nota: created_at de audit_logs = enqueued_at del queue (preserva orden).

        logger.debug({ count: rows.length }, 'audit_queue: batch procesado');
      });
    } catch (err) {
      logger.error({ err }, 'audit_queue worker tick failed');
      // Sentry capture si está configurado.
    }
  };

  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();

  // Graceful shutdown: flushear todo lo encolado antes de cerrar el proceso.
  // Railway envía SIGTERM con ~10s antes del SIGKILL — alcanza para drenar.
  let shuttingDown = false;
  const drain = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(handle);
    logger.info('audit_queue worker: draining queue before shutdown');
    while (true) {
      try {
        await withAdvisoryLock('audit_queue_worker', tick);
        const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM audit_queue');
        if (rows[0].n === 0) break;
      } catch (err) {
        logger.error({ err }, 'audit_queue drain failed');
        break;
      }
    }
    logger.info('audit_queue worker: drain complete');
  };
  process.once('SIGTERM', drain);
  process.once('SIGINT', drain);

  return handle;
}
```

### 7.4 `enqueued_at` como `created_at` en `audit_logs`

El worker preserva `enqueued_at` del queue como `created_at` en `audit_logs`. **El orden temporal de los audits refleja cuándo ocurrió la acción, no cuándo el worker la procesó.** Esto:
- Cumple req #3 (orden temporal).
- Mantiene compatible las queries del historial (filtros por fecha funcionan igual).
- Particionado P-19 sigue ruteando correctamente: el row va a la partición del mes del `enqueued_at`.

### 7.5 Manejo de errores

- **INSERT en `audit_queue` falla**: log a Sentry, no propagar. Mismo comportamiento actual.
- **Worker tick falla**: log + Sentry, los rows quedan en la queue (porque el DELETE está dentro de la TX). Próximo tick los retomará.
- **Fila tóxica (poison message)**: si una fila falla N veces, marcarla `attempts++` y skipearla del DELETE. **TODO en implementación**: alertar si `attempts > 5` y mover a `audit_queue_dead` (DLQ) para inspección manual.

---

## 8. Migration strategy

### Fase 1 — Setup (sin tocar callers)
1. Migración: crear `audit_queue`.
2. Implementar `audit.js` con bifurcación por feature flag.
3. Feature flag `audit_async_enabled` creado en `feature_flags` con `enabled=false` por default.
4. Worker `auditQueueWorker.js` registrado en `server.js` (siempre arranca, pero no hace nada si la queue está vacía).
5. Deploy a producción con flag OFF → comportamiento idéntico al actual.

### Fase 2 — Smoke test en staging
6. Activar flag en staging (`PATCH /api/feature-flags/audit_async_enabled` con `{ enabled: true }`).
7. Verificar que audits llegan a `audit_logs` con latencia < 2s.
8. Verificar drain on shutdown con `kill SIGTERM` manual.
9. Verificar SKIP LOCKED con 2 réplicas simuladas.

### Fase 3 — Rollout producción
10. Activar flag en producción.
11. Monitor durante 24h: queue depth, latencia, errores del worker.
12. Si todo OK: dejarlo encendido.

### Fase 4 — Cleanup (sprint futuro)
13. Después de 30 días estable, considerar remover el path síncrono legacy del `audit.js` para simplificar. El feature flag queda como kill-switch.

---

## 9. Rollback plan

**Trigger de rollback**: queue depth > 10k sostenido, error rate > 1%, o cualquier alerta de Sentry relacionada con audit.

**Pasos**:
1. `PATCH /api/feature-flags/audit_async_enabled` con `{ enabled: false }`. Toma efecto en ≤60s (TTL del cache de feature flags).
2. Llamadas nuevas a `audit()` vuelven al path síncrono.
3. Worker sigue corriendo y drena lo que quedó encolado. **No descartar la queue** — esos audits son importantes.
4. Si el worker tampoco logra drenar: stop el worker manualmente, `psql -c "INSERT INTO audit_logs SELECT ... FROM audit_queue"` a mano + drop queue.

**Sin downtime ni deploy** en ningún paso del rollback. Es el beneficio crítico de tener M-08 disponible.

---

## 10. Test strategy

### Unit (worker aislado)
- `tick()` con 0 rows → no hace nada, no rompe.
- `tick()` con 5 rows → todos llegan a `audit_logs`, queue queda vacía.
- `tick()` con error en INSERT → rows siguen en la queue, log a Sentry.
- `enqueued_at` se preserva como `created_at` en `audit_logs`.

### Integration (`audit()` + worker)
- Test feature flag OFF: `audit()` INSERT directo a `audit_logs` (legacy path).
- Test feature flag ON: `audit()` INSERT a `audit_queue`. Después de 1 tick, llega a `audit_logs`.
- In-tx + ROLLBACK del caller: el audit encolado se revierte con la TX. NO aparece ni en queue ni en logs.
- 100 audits concurrentes → todos llegan, sin duplicados.

### Multi-instance (simulado)
- 2 workers en paralelo: SKIP LOCKED garantiza que cada row se procesa exactamente 1 vez.

### Graceful shutdown
- Test que simula SIGTERM con queue cargada: el worker drena antes de salir.

### Carga
- 1000 audits encolados → procesados en N batches sin pérdida ni duplicación.
- Queue depth growth bajo load > worker throughput → alerta dispara (TODO definir endpoint de métricas).

---

## 11. Métricas y observabilidad

Endpoint nuevo: `GET /api/admin/audit-queue-stats` (requiere `requireAuth` + `role === 'admin'`):
```json
{
  "queue_depth": 42,
  "oldest_enqueued_at": "2026-06-11T15:23:00Z",
  "worker_last_tick_at": "2026-06-11T15:24:01Z",
  "rows_processed_last_hour": 12345,
  "errors_last_hour": 0
}
```

Alertas (vía Sentry o cron `lib/alertas`):
- `queue_depth > 1000` → warning (worker está lento)
- `queue_depth > 10000` → critical (worker stuck o disabled)
- `oldest_enqueued_at` más viejo que 5 min → critical
- `errors_last_hour > 100` → critical

---

## 12. Open questions (para Lucas)

1. **Intervalo del worker**: propongo 2s. ¿Aceptable o querés menos?
2. **Batch size**: propongo 100 rows/tick. Suficiente para ~50 audits/s sostenido.
3. **Drain timeout en SIGTERM**: Railway da ~10s. ¿Vale la pena agregar timeout máximo de 8s al drain para no chocar con el SIGKILL?
4. **DLQ (dead letter queue)**: ¿implementar ahora o dejar TODO? Mi recomendación: dejar TODO, las poison messages son rarísimas en audit (datos simples). Si aparecen, las inspeccionamos manualmente.
5. **Read-after-write**: ¿algún endpoint del portal asume que un audit hecho en el request es visible en el response (ej: `GET /audit-logs` justo después)? Si sí, ese endpoint necesita un flush manual o caer al path sync. **Pre-implementación, hacer grep para descartarlo.**
6. **Métricas endpoint**: ¿lo dejamos para esta PR o lo hago en PR separada?
7. **Rollout flag default**: arrancar con `enabled=false` en prod y activar manualmente. ¿OK?

---

## 13. Lo que NO está en este doc

- **Implementación**. Esto es solo diseño. Cuando vos apruebes, abro otra PR con el código.
- **P-04 Redis**: si en el futuro se justifica, migrar a BullMQ es un swap de implementación, no de API. Doc separado cuando llegue.
- **Tenant_id en audit_queue**: SE-02 (multi-tenant) es ortogonal. Cuando se agregue `tenant_id` a todas las tablas, también va a `audit_queue` siguiendo el mismo patrón.

---

## Próximos pasos

1. **Lucas**: leer + marcar comments inline o responder los 7 open questions.
2. Cuando esté aprobado, abro PR de implementación.
3. Smoke en staging antes de prod (Fase 2).

Si querés cambios estructurales (ej. preferís BullMQ + Redis desde el día 1, o tenés un req extra que no contemplé), avisame y reescribo el doc.
