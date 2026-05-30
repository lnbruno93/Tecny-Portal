# Load Test Baseline — iPro Portal

Cómo correr el load test + qué números esperar + cuándo preocuparse.

---

## ¿Por qué hacer esto?

Sin baseline de performance, escalás a ciegas. No sabés:
- ¿Cuántos usuarios concurrentes aguanta el backend actual?
- ¿Cuál endpoint es el cuello de botella? (probablemente dashboard o inventario)
- Después de un cambio que parece performante, ¿realmente mejoró?

Esta baseline da una referencia objetiva. **Correrla cada 3-6 meses** y comparar
con los números anteriores te dice si el portal se está degradando o mejorando.

---

## Cómo correr

### Setup

```bash
# 1. Estar parado en backend/
cd backend

# 2. Conseguir un token JWT de un admin contra staging.
#    Más rápido: login desde el frontend de staging, copiar el token del localStorage.
#    Alternativa: curl al endpoint de login.
curl -X POST "https://ipro-backend-staging.up.railway.app/api/auth/login" \
     -H "Content-Type: application/json" \
     -d '{"username":"admin","password":"..."}'

# 3. Exportar env vars
export IPRO_TARGET=https://ipro-backend-staging.up.railway.app
export IPRO_TOKEN=<el-jwt-del-paso-2>

# 4. Correr todos los scenarios (~2 min total)
npm run load-test

# O un scenario solo:
npm run load-test inventario_list
```

### Limitación: rate limit global de 300 req/15min

El backend tiene un rate limit global de **300 requests / 15 min por IP** (en `app.js`).
`/health` y `/ready` están exentos, pero todos los demás endpoints **van a chocar
con el 429 antes de terminar el test** si corrés de a 50 conn × 15s.

Cómo manejar esto:

1. **Para `/health`**: corre sin problema (exento).
2. **Para los demás endpoints**: el test SÍ va a hacer ~300 requests antes del 429.
   La latencia medida en esos 300 requests es representativa. El error_rate
   te avisa cuántos chocaron con el limit.
3. **Si querés correr el test completo sin rate limit**: setear
   `GLOBAL_RATE_LIMIT_MAX=5000` (o más) en Railway env vars del servicio backend.
   Railway redeploya automático en ~30s. Cuando termines el test, restaurar:
   borrá la env var o seteala a 300. NO subas el limit en producción salvo
   que sea estrictamente necesario (campaña, demo, etc).
4. **Alternativa**: correr el test desde dentro de Railway (shell del propio
   servicio backend), que comparte IP con la app y se considera localhost por
   `trust proxy: 1`. Sigue contando contra el limit, pero menos relevante.

### NUNCA contra producción

El script bloquea si `IPRO_TARGET` contiene `"production"`. Si en algún momento
querés saltarte el guard:

```bash
IPRO_ALLOW_PRODUCTION=yes-im-sure npm run load-test
```

Pero **no lo hagas**: el test genera 50 conn/s sostenidos por 10-15s — eso
satura el pool de Railway y degrada a los usuarios reales.

### Local

Para iterar más rápido sin sobrecargar staging:

```bash
# Terminal 1
npm run dev   # backend local en :3001

# Terminal 2
IPRO_TARGET=http://localhost:3001 IPRO_TOKEN=<token-local> npm run load-test
```

---

## Scenarios

Definidos en `backend/loadtest/scenarios.js`:

| name | path | conn × dur | Por qué importa |
|---|---|---|---|
| `health` | `/health` | 50 × 10s | Sanity check — debería ser <50ms p95 |
| `inventario_list` | `/api/inventario?limit=50` | 20 × 15s | Endpoint más visitado del portal |
| `dashboard_resumen_mensual` | `/api/dashboard/resumen-mensual` | 10 × 15s | 8 queries en paralelo, primer hit es el caro |
| `alertas_eval` | `/api/alertas` | 10 × 10s | JOINs sobre productos + CC + proveedores |
| `cuentas_clientes` | `/api/cuentas/clientes?limit=50` | 15 × 15s | Saldo agregado por cliente |
| `proveedores_list` | `/api/proveedores?limit=50` | 15 × 15s | LEFT JOIN agregado sobre proveedor_movimientos |
| `contactos_search` | `/api/contactos?buscar=lu&limit=20` | 20 × 10s | ILIKE — debería usar índice trigram |

---

## Baseline esperada (orden de magnitud)

> **Notación:** p50 = mediana, p95 = 95% de requests responden bajo este número.
> Los valores asumen DB tamaño mediano (1-5k registros por tabla) en Railway tier hobby.
> Con más datos, los números empeoran linealmente.

### Lo que esperás (✓ saludable)

> Autocannon v8 reporta `p50`, `p90`, `p97_5`, `p99` (no `p95`). Headline = p50/p90/p99.

| Scenario | RPS | p50 | p90 | p99 |
|---|---|---|---|---|
| `health` | >100 | <30ms | <100ms | <200ms |
| `inventario_list` | >50 | <100ms | <300ms | <500ms |
| `dashboard_resumen_mensual`* | >30 | <100ms | <300ms | <500ms |
| `alertas_eval`* | >30 | <100ms | <300ms | <500ms |
| `cuentas_clientes` | >40 | <150ms | <400ms | <600ms |
| `proveedores_list` | >40 | <150ms | <400ms | <600ms |
| `contactos_search` | >100 | <50ms | <150ms | <300ms |

\* Cacheado con TTL — el primer hit es el más caro, los siguientes (mismos params)
son lectura de memoria. Es esperable que el p99 del primer request sea 2-5× el p50.

> **Nota sobre staging vs prod:** Railway tier hobby puede tener una sola
> conexión a DB en staging vs. pool más amplio en prod. Si `/health` se degrada
> con 10 conn en staging, no necesariamente significa que prod lo hará.

### Lo que indica problema (⚠)

- **error_rate > 0.5%**: timeouts o 500s. Pool de DB saturado o memoria.
- **p99 / p50 > 5×**: latencia muy variable — algo está bloqueando esporádicamente.
- **p99 > 2s**: alguna query está mal indexada o tiene N+1.
- **RPS plano subiendo conn**: el cuello de botella es DB, no la app.

---

## Resultados actuales

> **Última corrida:** _(completá vos con los números cuando corras el test)_
>
> Formato sugerido:
>
> ```
> Fecha: 2026-MM-DD
> Target: staging
> Versión backend: <commit short SHA>
> ```
>
> | Scenario | RPS | p50 | p90 | p99 | err% |
> |---|---|---|---|---|---|
> | health | ... | ... | ... | ... | ... |
> | inventario_list | ... | ... | ... | ... | ... |
> | dashboard_resumen_mensual | ... | ... | ... | ... | ... |
> | alertas_eval | ... | ... | ... | ... | ... |
> | cuentas_clientes | ... | ... | ... | ... | ... |
> | proveedores_list | ... | ... | ... | ... | ... |
> | contactos_search | ... | ... | ... | ... | ... |
>
> **Observaciones:**
> - _(qué endpoint salió peor / mejor de lo esperado)_
> - _(si algo está rojo, anotar el ticket de follow-up)_

---

## Roadmap (cuándo profundizar)

Esta baseline es deliberadamente simple — autocannon + 7 GET endpoints. Cuando
crezca el equipo / los users:

- [ ] Agregar scenarios de **escritura** (POST venta, POST conciliación) — más
  riesgoso porque ensucia datos; requiere cleanup post-test.
- [ ] Test de soak (1h sostenido) para detectar memory leaks.
- [ ] Test de spike (100 conn de pico súbito) para validar resiliencia del pool.
- [ ] Integrar al CI — bloquear merge si performance regress > 30% vs baseline.
- [ ] Migrar a k6 si querés dashboards con gráficos (Grafana k6 cloud free 50 VUH/mes).

Por ahora, autocannon + corrida manual cada 3-6 meses es suficiente.
