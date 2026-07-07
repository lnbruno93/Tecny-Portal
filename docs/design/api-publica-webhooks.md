# API Pública + Webhooks

**Estado**: 🛠 DISEÑO — proyecto grande, dividir en 3 fases.
**Fecha**: 2026-07-06.
**Origen**: los tenants más maduros piden integrarse con sistemas externos: Mercado Libre (sync stock), contabilidad (exportar ventas al Contable), WhatsApp Business (avisar al cliente al despachar), calendario (agenda de envíos). Hoy todo esto se hace a mano.
**Effort estimado**: 10-15 días. F1 ≈ 3 días API keys + rate limiting, F2 ≈ 3 días endpoints core + docs, F3 ≈ 4 días webhooks salientes + retry queue.

---

## 1. Motivación

### 1.1 Qué resolvemos

Los tenants exportan y re-cargan data manualmente a otros sistemas:

- **Contabilidad**: fin de mes, el contador pide un XLSX de ventas + egresos. Alguien lo genera desde el portal, lo manda por email, el contador lo re-carga en su sistema. Trabajo manual, error prone.
- **Mercado Libre**: el vendedor tiene el mismo producto en el portal y en ML. Cambia el stock en el portal, tiene que ir a ML y actualizar manualmente.
- **WhatsApp Business API**: al despachar un envío, el cliente debería recibir un WA con tracking. Hoy el vendedor le manda manualmente.
- **Reportes power-user**: hay usuarios que quieren "un dashboard en Google Data Studio con mis KPIs". Hoy no hay forma sin manual export.

### 1.2 Qué proponemos

**API pública REST** con:
- Autenticación via **API keys por tenant** (no JWT — apta para machine-to-machine).
- Endpoints core versionados (`/api/v1/public/*`) — leer inventario, ventas, contactos, cajas.
- **Webhooks salientes** — el portal notifica a URLs configuradas cuando ciertos eventos ocurren.
- Rate limiting por API key (menos generoso que UI).
- Docs auto-generadas con OpenAPI 3.0.

### 1.3 Por qué importa

- **Reduce fricción operativa**: contadores y power-users tienen automation → menos tiempo perdido en exports manuales.
- **Habilita ecosistema**: developers third-party pueden armar integraciones (ML sync, WA bot, dashboards). Cada integración es un moat.
- **Diferenciador enterprise**: clientes que evalúan sistemas de gestión enterprise buscan "¿tiene API?". Ahora podemos decir sí.
- **Upsell**: API con quota alta → plan Pro. API en beta con quota baja → todos los planes.

### 1.4 Por qué es proyecto serio

- **Seguridad**: API keys son credenciales productivas. Necesitamos rotación, scopes, revocación instant.
- **Rate limiting robusto**: sin esto, un cliente con bug de bucle puede tirar el backend.
- **Backwards compatibility**: una vez publicada `/v1`, cambios incompatibles requieren `/v2` (o breaking window largo).
- **Webhooks reliability**: si el target endpoint cae, no podemos perder eventos. Retry queue + dead letter.
- **Docs de calidad**: sin docs no hay adopción. OpenAPI + ejemplos + sandbox.

---

## 2. Diseño

### 2.1 Componentes

```
┌────────────────────────────────────────────────────────────────┐
│ INBOUND: /api/v1/public/*                                      │
│                                                                 │
│  Middleware: apiKeyAuth                                        │
│    - Extrae `Authorization: Bearer tk_...`                     │
│    - Hash lookup en api_keys                                   │
│    - Valida scopes vs endpoint                                 │
│    - Aplica rate limit (Redis + sliding window)                │
│    - Setea req.tenantId + req.apiKey                           │
│    - Log a api_access_log (async)                              │
│                                                                 │
│  Endpoints core (F2):                                          │
│    GET  /inventario         — lista + filtros                  │
│    GET  /inventario/:id     — 1 producto                       │
│    GET  /ventas             — con paginación                   │
│    GET  /contactos          — read-only                        │
│    GET  /cajas/saldos       — snapshot                         │
│    POST /webhooks           — CRUD suscripciones               │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ OUTBOUND: webhookDispatcher                                    │
│                                                                 │
│  Eventos internos → enqueue en Redis Stream                   │
│  Worker desencola → busca suscriptores → POST con retries      │
│  Idempotency key en headers                                    │
│  Retry: 3 intentos con backoff exponencial (10s, 60s, 5m)     │
│  Dead letter después de 3 fallos → tabla webhooks_failed       │
└────────────────────────────────────────────────────────────────┘
```

### 2.2 Schema

```sql
-- API keys
CREATE TABLE api_keys (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,             -- "MP sync bot"
  key_hash     TEXT NOT NULL,             -- sha256 del token; nunca guardar plaintext
  key_preview  TEXT NOT NULL,             -- primeros 8 chars para UI (tk_abc12345…)
  scopes       TEXT[] NOT NULL,           -- ['inventario:read', 'ventas:read']
  rate_limit   INT NOT NULL DEFAULT 100,  -- req/min
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   INT REFERENCES users(id),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  UNIQUE (key_hash)
);

-- Access log (particionado por mes)
CREATE TABLE api_access_log (
  id           BIGSERIAL,
  tenant_id    INT NOT NULL,
  api_key_id   BIGINT REFERENCES api_keys(id),
  method       TEXT,
  path         TEXT,
  status       INT,
  duration_ms  INT,
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (timestamp);
-- Retención 30 días.

-- Webhook subscriptions
CREATE TABLE webhook_subscriptions (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_url   TEXT NOT NULL,
  events       TEXT[] NOT NULL,          -- ['venta.created', 'stock.low']
  secret       TEXT NOT NULL,            -- para HMAC sig
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_delivered_at TIMESTAMPTZ,
  fail_count   INT NOT NULL DEFAULT 0
);

-- Dead letter queue
CREATE TABLE webhooks_failed (
  id             BIGSERIAL PRIMARY KEY,
  subscription_id BIGINT REFERENCES webhook_subscriptions(id),
  event          TEXT NOT NULL,
  payload        JSONB NOT NULL,
  attempts       INT NOT NULL,
  last_error     TEXT,
  failed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

RLS con FORCE en todas.

### 2.3 API Keys

Format: `tk_live_<32 chars random>` para prod, `tk_test_` para sandbox futuro.

Generar con `crypto.randomBytes(24).toString('base64url')`.

Al crear: mostrar UNA sola vez al user (como GitHub tokens). Después solo se ve preview `tk_live_abc123...`. Perder = revocar y crear nueva.

### 2.4 Scopes

Formato `dominio:acción`:
- `inventario:read` — GET productos.
- `ventas:read` — GET ventas + items.
- `contactos:read` — GET CC.
- `cajas:read` — GET saldos.
- `webhooks:manage` — CRUD subscriptions.

**F1 solo read**. Escritura (POST/PUT) diferido a F4+ con controles adicionales.

### 2.5 Rate limiting

Sliding window Redis:
- Key: `apirl:{apiKeyId}:{minute}`.
- Cada request INCR + EXPIRE 60s.
- Antes de responder, chequea `INCR` return > `rate_limit` → 429.
- Header `X-RateLimit-Remaining` y `X-RateLimit-Reset` en response.

Default 100 req/min por key. Configurable per-key por admin.

### 2.6 Webhooks salientes

Eventos F1:
- `venta.created` — venta retail o B2B nueva.
- `venta.cancelled` — cancel de venta.
- `stock.low` — producto llegó al umbral.
- `caja.negative` — caja quedó en negativo.
- `envio.delivered` — envío marcado entregado.
- `contacto.created` — contacto nuevo.

Payload:
```json
{
  "event": "venta.created",
  "id": "evt_1234",
  "timestamp": "2026-07-06T22:15:00Z",
  "tenant_id": 42,
  "data": { "venta_id": 999, "total_usd": 1200, ... }
}
```

Headers:
- `X-Tecny-Event: venta.created`
- `X-Tecny-Signature: sha256=<hmac de body con subscription.secret>`
- `X-Tecny-Delivery: evt_1234`
- `X-Tecny-Attempt: 1`

Verificación (por el receiver):
```js
const expectedSig = 'sha256=' + hmac(secret, req.rawBody);
if (req.headers['x-tecny-signature'] !== expectedSig) return 401;
```

### 2.7 Reliability

- Redis Stream (`webhook:events`) para queue.
- Worker consume + envía con timeout 15s.
- Fail (non-2xx o timeout): retry con delay backoff (10s → 60s → 5m).
- Después de 3 attempts → `webhooks_failed` + notification al user.
- Idempotency: receiver puede deduplicar por `X-Tecny-Delivery`.

### 2.8 Docs auto-generadas

- `openapi.json` en `/api/v1/public/openapi.json`.
- Swagger UI en `/api/v1/public/docs` (protected: solo admin del tenant).
- Ejemplos curl + Postman collection.
- Sandbox opcional en F3 (env dedicado con data fake).

---

## 3. Fases

### F1 — Foundation: API keys + auth + rate limit (3 días)
- Migration `api_keys` + `api_access_log`.
- `lib/apiKeyAuth.js` middleware.
- `lib/apiRateLimit.js` con Redis sliding window.
- Endpoint mínimo `GET /api/v1/public/ping` para smoke test.
- UI Admin en portal para CRUD de keys.
- Tests: auth ok, auth fail, scope mismatch, rate limit hit.

### F2 — Endpoints core read + OpenAPI docs (3 días)
- Endpoints: inventario, ventas, contactos, cajas/saldos.
- Response shape estable (no incluye campos internos, tenant_id, IDs sensibles).
- OpenAPI spec generado.
- Swagger UI.
- Postman collection.
- Docs en `docs/api/README.md`.

### F3 — Webhooks salientes (4 días)
- Schema `webhook_subscriptions` + `webhooks_failed`.
- CRUD UI en portal (crear webhook, elegir eventos, secret auto-generado).
- `lib/webhookDispatcher.js` + Redis Stream worker.
- HMAC sig + verificación docs.
- Dead letter + retry.
- Tests: delivery ok, retry backoff, dead letter después de 3 fallos, HMAC valida.

### F4+ (roadmap futuro)
- Endpoints POST/PUT (crear ventas, marcar envío entregado, etc.) — requiere auth adicional (2FA?).
- OAuth2 flow (third-party apps que actúan on-behalf-of user).
- Sandbox env con data sintética.
- SDK client oficial (JS + Python).

---

## 4. Riesgos + trade-offs

### 4.1 Backwards compatibility
Una vez publicada `/v1`, cualquier breaking change requiere `/v2` + deprecation window de 6-12 meses. Docs claras sobre qué constituye "breaking".

**Regla**: **agregar** campos a response = safe. **Renombrar** o **quitar** campos = breaking → deprecar 6 meses.

### 4.2 Rate limit vs usabilidad
100 req/min es generoso para uso normal, restrictivo para bulk export. Ofrecer endpoint dedicado `GET /export/ventas?desde=&hasta=` que devuelve XLSX pre-computado (cache 1h) sin contar contra rate limit.

### 4.3 API key leaks
Un key filtrado en GitHub público → tenant comprometido. Mitigations:
- Preview solo (nunca ver la key completa después de creación).
- Rotación easy: crear nueva, migrar apps, revocar la vieja.
- Alertas si key se ve usada desde IPs muy dispersas geográficamente (feature futura).

### 4.4 Webhook target hijack
Si un attacker cambia `target_url` para robar events, expone data del tenant. Mitigations:
- Cambio de `target_url` requiere confirm por email al owner.
- HMAC sig: aún si target es hijacked, el receiver debe verificar sig (docs deben insistir).
- Test webhook: al crear, enviar 1 evento de prueba y verificar 200.

### 4.5 Cost of scale
1000 tenants × 100 req/min = 100k req/min = ~1700 req/s. Nuestro backend actual Railway 2 instances no aguanta sin degradación.

Solutions cuando llegue el momento:
- Read replicas dedicadas para API pública (queries de solo lectura).
- CDN cache para endpoints públicos de baja volatilidad (`/public/pricing`).
- Escalar Railway a más instances con HPA.

---

## 5. Tests

### 5.1 Auth
- Sin `Authorization` → 401.
- Bearer inválido → 401.
- Bearer válido pero revoked → 401.
- Bearer válido pero scope mismatch → 403.
- Rate limit hit → 429 + headers correctos.

### 5.2 Endpoints
- Response shape es estable (test snapshot).
- Filtros funcionan (`?from=&to=`).
- Paginación (`?limit=&cursor=`).
- Cross-tenant: key de tenant A NO ve data de tenant B.

### 5.3 Webhooks
- Evento interno → subscription activa → recibe HTTP POST con signature válida.
- Target devuelve 500 → retry x3.
- Target devuelve 200 en 2° try → success.
- 3 fails → dead letter + subscription.fail_count++.
- fail_count > 10 → subscription auto-desactivada.

---

## 6. Métricas de éxito

- **10 tenants con API activa** a 3 meses.
- **> 100k API calls/día** a 6 meses.
- **> 5 integraciones third-party** en el ecosistema (ML, WA, Data Studio, contabilidad, dashboard custom).
- **P50 latency de endpoints < 100ms**, P95 < 500ms.
- **99.5% webhook delivery success rate** (excluye fallas del target).

---

## 7. Deferrable a fase 2+

- OAuth2 para third-party apps.
- Endpoints POST (write via API).
- GraphQL como alternativa a REST.
- SDK client oficial en npm.
- Sandbox environment con test data.
- API playground interactivo con ejemplos live.
- Sistema de "API monetization" (facturar por request > umbral).
