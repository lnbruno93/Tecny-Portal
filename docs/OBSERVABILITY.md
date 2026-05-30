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

## 7. Roadmap (no urgente)

- [ ] Source maps de Sentry — subir maps en CI para que stacktraces minificados sean legibles.
- [ ] Sentry releases automáticas — vincular commit SHA con cada release en el dashboard.
- [ ] Custom dashboard de métricas de negocio (cajas, ventas/día). Hoy se mira a ojo desde el resumen mensual.
- [ ] Alertas Slack/Discord — Sentry hooks integrations cuando haya equipo de más de 1.
