# Notificaciones Push Web

**Estado**: 🛠 DISEÑO — pendiente de decisión + implementación.
**Fecha**: 2026-07-06 (armado en jornada épica de 10 PRs cerrada con Lucas).
**Origen**: gap identificado — hoy las alertas críticas del portal (caja negativa, stock 0, CC vencida, comprobante rechazado) **solo se ven si el user tiene el portal abierto en el browser**. Un dueño que cierra la app y va a dormir se pierde eventos que necesita ver.
**Effort estimado**: 5-8 días. F1 ≈ 2 días backend + Redis + tabla suscripciones, F2 ≈ 1.5 días PWA + Service Worker + UI opt-in, F3 ≈ 1.5 días integrar con evaluarTodas + eventos ad-hoc, F4 ≈ 1 día tests + docs.

---

## 1. Motivación

### 1.1 Qué resolvemos

Hoy el módulo Alertas del portal **evalúa** cajas negativas, stock bajo, CC en mora y proveedores atrasados — pero el user tiene que estar mirando la campanita para saber que algo pasó. Escenarios reales que estamos perdiendo:

- **10 PM: caja del dueño quedó en negativo** (retiro registrado mal). El dueño se entera al día siguiente cuando ya operó 4 horas sobre un saldo incorrecto.
- **Sábado a la mañana: un producto crítico llegó a stock=0**. Cliente WhatsAppea "¿tenés?" y el vendedor dice "sí" — cuando entra a Ventas se da cuenta que no.
- **Comprobante de transferencia rechazado** por el banco (fondos insuficientes del pagador). Hoy el user se entera cuando entra a Financiera. Debería ver un push inmediatamente.

### 1.2 Qué proponemos

Implementar **Web Push Notifications** vía Service Worker + Push API (estándar web abierto, no depende de Firebase / OneSignal / vendors) para eventos críticos del portal. El user hace opt-in una vez desde Config, autoriza el browser, y recibe notificaciones en su dispositivo aunque el portal esté cerrado.

### 1.3 Por qué importa para el negocio

- **Reduce el "descubrí demasiado tarde" que hoy causa pérdidas contables**. Un stock=0 no detectado durante un fin de semana puede costar 2-3 ventas perdidas.
- **Aumenta el trust del dueño en el portal como "sistema operativo real"**, no como "dashboard que reviso cuando me acuerdo". Los usuarios que confían delegan más operaciones al portal → LTV sube.
- **Diferenciador vs competencia**: la mayoría de sistemas de gestión para PYMEs argentinas NO tienen push notifications reales. Es un signature feature de "portal moderno".

### 1.4 Por qué es proyecto serio

- **Multi-tenant**: cada suscripción se guarda con `tenant_id` + `user_id`. Un dispositivo se puede desuscribir individualmente.
- **Multi-device**: un mismo user puede tener push en móvil + desktop + tablet.
- **Preferencias granulares**: no todos los eventos son iguales — el dueño quiere caja negativa pero no stock=0 (que se lo maneja el encargado).
- **Rate limiting**: si el sistema evalúa alertas cada 5 min y hay 40 stock_bajo activos, no queremos 40 pushes/5min. Coalescing necesario.
- **VAPID keys** (Voluntary Application Server Identification) — necesitamos generar par de claves y guardarlas seguras.

---

## 2. Diseño

### 2.1 Componentes

```
┌───────────────────────────────────────────────────────────────┐
│ FRONTEND                                                       │
│                                                                │
│  Config.jsx → tab "Notificaciones"                            │
│    - Toggle opt-in por evento (caja_negativa, stock_bajo,…)   │
│    - Muestra dispositivos suscritos                           │
│    - Botón "Suscribir este dispositivo"                       │
│                                                                │
│  service-worker.js                                            │
│    - Recibe evento 'push' → render notification               │
│    - Recibe evento 'notificationclick' → navigate a URL       │
└───────────────────────────────────────────────────────────────┘
                          │ POST /api/push/subscribe
                          │ POST /api/push/prefs
                          ▼
┌───────────────────────────────────────────────────────────────┐
│ BACKEND                                                        │
│                                                                │
│  routes/push.js                                               │
│    POST   /subscribe   — guarda { endpoint, keys, ua }        │
│    DELETE /subscribe/:id                                       │
│    PATCH  /prefs       — { caja_negativa: true, stock_bajo: false }│
│    GET    /vapid-public — devuelve la public key              │
│                                                                │
│  lib/pushSender.js                                            │
│    sendToUser(userId, tenantId, event, payload)               │
│      → busca suscripciones activas + preferencias             │
│      → skip si event está desactivado                         │
│      → coalescing en Redis (key = `push:{userId}:{event}`,    │
│         TTL 15 min → skip repetido)                           │
│      → llama a web-push npm con VAPID                         │
│      → si endpoint 410 → soft-delete suscripción              │
│                                                                │
│  lib/alertas.js (existing)                                    │
│    evaluarTodas() ya devuelve grupos con severidad.           │
│    NEW: post-eval, para cada grupo severidad=critica →        │
│      pushSender.sendToUser(...)                                │
│                                                                │
│  Eventos ad-hoc (comprobante rechazado, venta cancelada       │
│  con impacto en caja):                                        │
│    Los routes que hoy hacen `logger.warn` en la línea         │
│    también harán `pushSender.sendToUser(...)`.                │
└───────────────────────────────────────────────────────────────┘
                          │
                          ▼
                  Web Push Protocol
                          │
                          ▼
                    User's Browser
```

### 2.2 Schema

Migration `push_subscriptions`:

```sql
CREATE TABLE push_subscriptions (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      INT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  endpoint     TEXT NOT NULL,       -- URL del push service (FCM/Mozilla/Apple)
  p256dh       TEXT NOT NULL,       -- key para encriptar payload
  auth         TEXT NOT NULL,       -- auth secret
  user_agent   TEXT,                -- para mostrar "Chrome en Mac" en UI
  device_label TEXT,                -- editable por user ("Mi laptop", "Celu")
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ,
  UNIQUE (endpoint)
);

CREATE INDEX idx_push_sub_tenant_user ON push_subscriptions(tenant_id, user_id)
  WHERE deleted_at IS NULL;
```

Migration `push_preferences`:

```sql
CREATE TABLE push_preferences (
  tenant_id  INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  evento     TEXT NOT NULL,        -- 'caja_negativa', 'stock_bajo', etc.
  activo     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_id, evento)
);
```

RLS con `FORCE` como en el resto del portal.

### 2.3 VAPID keys

Generar 1 vez con `web-push generate-vapid-keys` → guardar en Railway env vars:
- `PUSH_VAPID_PUBLIC_KEY` (expuesta al frontend vía `/api/push/vapid-public`)
- `PUSH_VAPID_PRIVATE_KEY` (solo backend)
- `PUSH_VAPID_SUBJECT` (`mailto:soporte@tecnyapp.com`)

Rotarlas requiere invalidar todas las suscripciones existentes → nunca rotar salvo en un incidente.

### 2.4 Coalescing

Sin coalescing: 40 stock_bajo activos × cron cada 5 min × 24 h = 11520 pushes/día. Insano.

Con coalescing en Redis:
- Key: `push:coalesce:{userId}:{evento}:{itemId?}` con TTL = 15 min (configurable).
- Antes de enviar, `SETNX` → si ya existe skip.
- Para grupos (stock_bajo con múltiples items) enviamos 1 push con "Tenés 12 productos con stock bajo" en vez de 12 pushes.

### 2.5 Eventos elegibles (F1)

| Evento | Trigger | Payload title | URL destino |
|---|---|---|---|
| `caja_negativa` | evaluarTodas → grupo critica | "Caja en negativo: {nombre}" | /cajas |
| `stock_bajo` | evaluarTodas cada N | "N productos con stock bajo" | /inventario?filter=stock-bajo |
| `cc_mora` | evaluarTodas | "N clientes con deuda vencida" | /cuentas?filter=mora |
| `comprobante_rechazado` | POST /financiera/comprobante → estado='rechazado' | "Comprobante rechazado" | /financiera/{id} |
| `red_b2b_pedido_nuevo` | POST /red-b2b/pedidos (cross-tenant) | "Nuevo pedido B2B de {partner}" | /red-b2b/pedidos/{id} |

Ampliable en F2/F3 según feedback.

---

## 3. Fases

### F1 — Backend + PWA base (2 días)
- Migration + schema.
- `lib/pushSender.js` + `web-push` npm.
- Routes `/api/push/subscribe`, `/vapid-public`, `/prefs`.
- Service Worker mínimo en `frontend/public/sw.js`.
- Config para VAPID keys.
- Tests unitarios pushSender + rutas.

### F2 — UI + opt-in flow (1.5 días)
- Tab "Notificaciones" en Config.
- Botón "Habilitar en este dispositivo" con `Notification.requestPermission()`.
- Lista de dispositivos suscritos con `deviceLabel` editable.
- Toggles por evento (5 defaults + expandible).
- Manejo de "browser no soporta" y "permiso denegado" con copy claro.

### F3 — Integrar con evaluarTodas + eventos ad-hoc (1.5 días)
- Cron alertas: post-eval, envía push por evento crítico.
- Handlers `financiera`, `red-b2b` que emiten push en momentos clave.
- Coalescing Redis con TTL configurable.

### F4 — Tests + docs (1 día)
- Tests E2E: mock del Push API, verificar que se llama con el shape correcto.
- Test de coalescing: 100 evaluaciones → 1 push.
- RUNBOOK: cómo rotar VAPID (edge case), cómo debuggear no-recepción.

---

## 4. Riesgos + trade-offs

### 4.1 Compatibilidad de browsers
- **Chrome, Edge, Firefox, Opera**: soporte completo Web Push.
- **Safari macOS**: soporte desde Safari 16.4 (Ventura+). En dispositivos viejos NO recibe pushes → fallback "no soportado" en UI.
- **Safari iOS**: soporte desde iOS 16.4 y **solo si la PWA está instalada como app** (Add to Home Screen). Menos común en el user base actual. **Investigar telemetría real de nuestros users antes de F2**.
- **Chrome iOS**: NO soportado (Apple no permite push a browsers third-party). Los users que usan Chrome en iPhone quedan afuera.

**Trade-off**: para maximizar cobertura, ofrecer también **email fallback** a los eventos críticos (piggyback en `lib/email.js` que ya existe). Los users con browser incompatible seleccionan email en las prefs.

### 4.2 Battery / spam
Si mandamos push por cada movimiento, el user desinstala rápido. Regla: **solo eventos que requieren acción humana**. NO push por:
- Ventas nuevas registradas (info, no acción).
- Login desde otro dispositivo (a menos que sea sospechoso).
- Reportes generados (info).

### 4.3 Compliance (GDPR / consentimiento)
- Push requiere opt-in explícito → OK legal.
- Guardar el opt-in con timestamp y IP para auditoria.
- Permitir opt-out granular por evento (no todo o nada).

### 4.4 Scaling
- 100 tenants × 3 users promedio × 2 devices = 600 suscripciones.
- 600 pushes/evento × 10 eventos/día = 6000 pushes/día. web-push npm handles bien.
- Si crecemos a 1000+ tenants, mover a job async con cola (Redis + BullMQ). No urgente ahora.

### 4.5 Endpoints expirados
Push services (FCM, Mozilla, Apple) devuelven 410 Gone cuando el user desinstaló el browser / limpió cache. Soft-delete la suscripción al primer 410. Sin esto acumulamos "zombies" que causan latencia al enviar.

---

## 5. Tests

### 5.1 Unitarios
- `pushSender.sendToUser` con múltiples suscripciones + preferencias off → skip.
- Coalescing: 100 calls en 15 min → 1 web-push.call.
- Endpoint 410 → soft-delete + retry con las demás.

### 5.2 Integración
- POST /api/push/subscribe con endpoint válido → guarda + 201.
- Alertas cron → verifica que se llama pushSender para severidad critica.
- Multi-tenant isolation: tenant A no puede leer subs de tenant B.

### 5.3 E2E manual
- Chrome desktop: opt-in, cerrar tab, disparar caja negativa desde otra sesión → notification aparece en macOS Notification Center.
- Firefox: mismo test.
- Safari 16.4+ mac: mismo test.
- Chrome Android: mismo test.

---

## 6. Métricas de éxito

- **Opt-in rate**: 30% de users activos suscritos a 1 mes.
- **CTR de notifications**: > 20% (users clickean para ir al portal).
- **Tiempo mediano hasta acción del user post-push crítico**: < 30 min (vs actual: horas o días).
- **Zero incidents de spam** — no unsubscribes en masa el primer mes.

---

## 7. Deferrable a fase 2

- Push agrupados con schedule del user ("resumen diario a las 9 AM").
- Push cross-user: notificar al owner cuando un vendedor hace algo relevante.
- Push desde Chat bot ("terminé el reporte que me pediste").
- Web Push actionable (botones "Marcar resuelto" en la notification sin abrir el portal).
