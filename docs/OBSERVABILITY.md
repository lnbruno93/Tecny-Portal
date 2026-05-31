# Observabilidad — iPro Portal

Qué está monitoreado, dónde se ven los datos, y cómo se configura.

---

## 1. Sentry — captura de errores

**Backend:** `@sentry/node` inicializado en `backend/server.js` antes de cargar Express.

- Configuración: requiere `SENTRY_DSN` como env var en Railway. Sin DSN, Sentry es no-op (no crashea).
- `tracesSampleRate: 0` — solo errores, sin performance tracing (menor overhead).
- Captura automática de errores via `Sentry.setupExpressErrorHandler(app)`.
- Captura manual en lugares críticos (auth, audit) via `Sentry.captureException`.
- Graceful shutdown flushea eventos pendientes (`Sentry.flush(2000)`).

**Frontend:** sin `@sentry/react` (decisión deliberada — bundle size).

- Errores no manejados → `frontend/src/lib/reportError.js` → POST `/api/client-errors`.
- Backend reenvía a Sentry con tags: `source`, `build_commit`, `build_version`.
- Throttle: máximo 5 reportes por sesión, mínimo 2s entre reportes (anti loop).

**Tags útiles en el dashboard Sentry:**
- `source` — backend / frontend / cron / auth
- `build_commit` — corto 7-char del commit (correlaciona con Railway deploys)
- `build_version` — semver de package.json

---

## 2. Health endpoints

### `/health` — liveness probe
- Status 200 = OK; 503 = degraded.
- Devuelve: `db.status`, `db.latency_ms`, `db.pool`, `memory.*`, `commit`, `migrations`, `uptime`.
- Timeout DB: 3s (no se cuelga esperando al pool).
- Log silenciado (pino-http ignora /health para no llenar logs).

**Uso:** UptimeRobot ping cada 5 min — si responde no-200 dos veces seguidas, alertar.

### `/ready` — readiness probe
- Status 200 = listo para tomar tráfico; 503 = no listo.
- Devuelve `ready: true/false` + `commit`.
- Más liviano que `/health` (solo chequea DB). Usar para gates de deploy.

---

## 3. UptimeRobot (a configurar)

**Setup manual** (5 min, gratis hasta 50 monitors):

1. Crear cuenta en https://uptimerobot.com.
2. New monitor → HTTP(s):
   - URL: `https://ipro-backend-production.up.railway.app/health`
   - Type: HTTP(s)
   - Interval: 5 min
   - Alert contacts: tu email + WhatsApp (opcional, en plan paid).
3. Repetir para frontend: `https://<netlify-url>/`.
4. Test: matar el container en Railway un segundo → deberías recibir email/SMS en <10 min.

**Decisión durable:** ¿por qué no Better Stack / Pingdom?
- UptimeRobot tiene plan gratis suficiente (50 monitors, 5 min interval).
- Si más adelante necesitamos status page público o métricas P95, migrar.

---

## 4. Logs

**Backend:** `pino` con `pinoHttp` middleware.
- Producción: JSON estructurado a stdout — Railway los persiste 30 días.
- Dev: `pino-pretty --colorize`.
- Custom props: `userId` en cada req (si está autenticado).
- Silenciados: `/health`, `/ready`.

**Ver logs en Railway:** dashboard del servicio → tab "Logs".
**Filtrar por nivel:** `level >= 50` para errores, `level >= 40` para warnings.

---

## 5. Métricas a vigilar

Cuando entres a Railway, mirá estos números cada tanto:

| Métrica | Dónde | Umbral preocupante |
|---|---|---|
| Memory RSS | Railway dashboard | > 400 MB sostenido |
| DB CPU | Postgres-AueP / Metrics | > 70% sostenido |
| DB Active connections | Postgres-AueP / Metrics | > 80% del pool |
| `/health` db.pool.waiting | health endpoint | > 0 sostenido = pool agotado |
| Sentry events/día | Sentry dashboard | spike repentino |

---

## 6. Build metadata

Cada bundle frontend lleva inyectadas:
- `__BUILD_COMMIT__` — short SHA del git commit (de Railway, Netlify, o git local).
- `__BUILD_VERSION__` — semver de package.json.

Se inyectan en `vite.config.js` via `define`. Disponibles globalmente en runtime.
Cuando un error llega a Sentry, viene con estos tags para correlacionar con el release exacto.

**Backend equivalent:** `process.env.RAILWAY_GIT_COMMIT_SHA` — expuesto en `/health.commit` y tag de Sentry.

---

## 7. Cron de invariantes (data integrity)

Job nocturno (`backend/src/jobs/invariantsJob.js`) que corre cada 24h y valida
~10 invariantes de integridad financiera. Si encuentra drift, reporta a Sentry.

**Invariantes vigiladas hoy:**

| ID | Severity | Descripción |
|---|---|---|
| `caja_saldo_negativo` | crítica | Cajas con saldo < 0 |
| `caja_eliminada_con_movs_activos` | alta | Caja soft-deleted con movs activos |
| `conciliacion_pareja_inconsistente` | alta | `conciliado_en` y `conciliacion_id` deben coexistir |
| `conciliacion_match_caja_distinta` | alta | Línea matched a mov de otra caja |
| `conciliacion_match_a_mov_deleted` | media | Match a un mov soft-deleted |
| `egreso_pagado_sin_caja_mov` | crítica | Egreso pagado sin mov en ledger |
| `caja_mov_egreso_huerfano` | alta | caja_mov.origen=egreso sin egreso activo |
| `proyecto_mov_sin_caja_mov` | crítica | Mov de proyecto con caja_id sin mov en ledger |
| `venta_pagos_sin_venta_activa` | media | venta_pago apuntando a venta deleted |
| `conciliacion_cerrada_con_lineas_pending` | alta | Conciliación cerrada con líneas pending |

**Política de alerta:**
- Violación de `crítica` → Sentry `captureException` (level error). Atiende ya.
- Violación de `alta` → Sentry `captureMessage` (level warning).
- Violación de `media` → solo log estructurado en stdout.

**Endpoints admin (requieren JWT con role=admin):**
- `GET /api/admin/invariants` — corre todas las invariantes y devuelve el reporte,
  SIN reportar a Sentry. Para inspección manual.
- `POST /api/admin/invariants/run` — corre el mismo path que el cron (reporta
  a Sentry si hay violaciones). Útil para gatillar el alerta sin esperar 24h.

**Cómo agregar una nueva invariante:** ver comentarios en `backend/src/lib/checkInvariants.js`.

---

## 8. Source maps de Sentry (frontend)

El frontend se sirve minificado en producción. Sin source maps, un error
captado por Sentry viene con un stacktrace tipo `vendor-Dd7XaLiz.js:1:34521`
— inútil para debuggear.

**Setup** (`@sentry/vite-plugin` configurado en `frontend/vite.config.js`):

- En cada build con `SENTRY_AUTH_TOKEN` presente, el plugin:
  1. Genera los `.map` para todos los chunks.
  2. Sube los maps al proyecto Sentry como una "release" identificada con
     el commit short SHA del build (`__BUILD_COMMIT__`).
  3. **Borra los .map del `dist/`** antes de publicar — no quedan accesibles
     al cliente (anti pattern: filtraría tu código original).

- El backend reenvía cada error de `/api/client-errors` a Sentry con
  `release: <build_commit>`. Sentry matchea ese release con los maps
  subidos y resuelve los stacktraces automáticamente.

**Sin `SENTRY_AUTH_TOKEN`**, el plugin es no-op — los builds locales y los
deploys de previa NO suben maps. El comportamiento es el mismo que antes.

### Configuración inicial (one-time, ~10 min)

1. **Crear un Auth Token en Sentry:**
   - Sentry → Settings → Account → API → Auth Tokens → "Create New Token".
   - Scopes mínimos: `project:releases`, `project:read`.
   - Copiar el token (solo se muestra una vez).

2. **Confirmar/crear el proyecto Sentry para el frontend** — recomendado
   separar del backend para que los issues no se mezclen:
   - Si ya existe `ipro-portal-frontend` en el org `lnbruno`: nada que hacer.
   - Si no, crear un proyecto Browser/JavaScript con ese slug.

3. **Setear env vars en Netlify** (Settings → Build & deploy → Environment):
   - `SENTRY_AUTH_TOKEN` = el token del paso 1
   - `SENTRY_ORG` = `lnbruno` (o tu org slug)
   - `SENTRY_PROJECT` = `ipro-portal-frontend` (o el slug del proyecto)

4. **Backend Sentry DSN** apunta al proyecto del *backend* (Node). Para
   que los errores del frontend se registren correctamente, hay dos opciones:
   - **Opción simple (recomendada):** mismo DSN — los errores del frontend
     reciclan el proyecto del backend con `source: 'frontend'` tag. Los maps
     del frontend se suben al proyecto separado pero el resolve sigue
     funcionando si configurás `SENTRY_PROJECT` apuntando al frontend project.
   - **Opción dos proyectos separados:** crear `SENTRY_DSN_FRONTEND` distinto
     y postear directo desde el browser. Requiere agregar `@sentry/browser`
     al bundle (~15kb gz). No recomendado todavía dado el setup minimalista.

5. **Triggear un deploy** en Netlify (push a `main` o "Trigger deploy" manual).
   En los logs del build vas a ver:
   ```
   [sentry-vite-plugin] Creating release with name "abc1234"
   [sentry-vite-plugin] Uploading sourcemaps for release "abc1234"
   [sentry-vite-plugin] Successfully uploaded 12 source maps
   ```

6. **Verificar:** disparar un error de prueba en el frontend de producción
   y revisar el issue en Sentry — debería mostrar el stacktrace con nombres
   de funciones reales en lugar de chunk minificado.

### Cómo verificar que funciona después de un deploy

```bash
# Desde el browser de prod, en la consola JS:
throw new Error('test source maps');
```

En Sentry → Issues → el error nuevo → verificar:
- `release` field tiene el commit SHA del último deploy.
- "Stack Trace" muestra archivos `src/screens/X.jsx` con line numbers reales
  (no `chunk-abc.js:1:1234`).

---

## 9. Roadmap (no urgente)

- [ ] Sentry releases automáticas — vincular commit SHA con cada release en el dashboard.
- [ ] Custom dashboard de métricas de negocio (cajas, ventas/día). Hoy se mira a ojo desde el resumen mensual.
- [ ] Alertas Slack/Discord — Sentry hooks integrations cuando haya equipo de más de 1.
