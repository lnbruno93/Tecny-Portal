# Auditoría TOTAL cross-track 2026-07-25 — Consolidación + Roadmap

**Fecha**: 2026-07-25
**Owner**: Lucas Bruno
**Audit anterior**: 2026-07-12 (cerró 72% en 12 sprints)
**Metodología**: 5 agents en paralelo, uno por track, findings priorizados P0/P1/P2/P3, luego consolidación cross-track + roadmap.

---

## Executive summary

**83 findings totales** distribuidos en 5 tracks. La plataforma sigue en estado sólido — no hay bugs sistémicos ni regresiones masivas. Sin embargo, aparecen **5 P0 críticos** nuevos: 3 de cross-tenant data corruption/leak (todos en la superficie Red B2B), 1 defense-in-depth roto en canjes, y 1 data leak persistente vía Google indexation. Además hay **1 regresión importante** del hotfix P0 #583 (captcha bypass) que fue introducida sin catch en tests.

**Estimación de cierre**: 6-8 sprints (~2-3 semanas de trabajo focalizado). Similar al ciclo del 07-12.

### Distribución cross-track

| Track | Findings | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| A — Financiero | 18 | 1 | 6 | 6 | 5 |
| B — Stock/Inventario | 15 | 1 | 7 | 6 | ~1 |
| C — Auth/Multi-tenant | 12 | 2 | 6 | 5 | ~-1 |
| D — Superficie externa | 16 | 1 | 3+ | ~6 | ~6 |
| E — Plataforma | 22 | 0 | 8 | 9 | ~5 |
| **TOTAL** | **83** | **5** | **~30** | **~32** | **~16** |

### Comparación vs audit 07-12

| Métrica | 07-12 | 07-25 | Δ |
|---|---|---|---|
| Findings totales | ~120 | 83 | -30% |
| P0 | ~8 | 5 | -37% |
| P1 | ~35 | ~30 | -14% |
| Regresiones detectadas | 0 | 1 (#583) | +1 |

**Interpretación**: los ciclos de hardening 07-12 → 07-25 redujeron significativamente la superficie de bugs. Los 5 P0 nuevos son de áreas menos auditadas anteriormente (Red B2B post-integraciones, share links públicos post-feature Equipos Usados, sync del vuelto ARS/UYU multi-país).

---

## 🚨 Sprint 0 — P0s + regresión crítica (Quick wins de 1-3h c/u)

Estos son los items que se deben cerrar YA. Idealmente todos en 1 sesión.

### 1. **REGRESIÓN #583** — Bypass captcha `/login` via `code` flag
**Track**: D (Externa) · **File**: `routes/auth.js:234` (approx) · **Fix**: ~30min
El hotfix P0 #583 (captcha single-use rompía step 2 de 2FA) introdujo `if (!code)` como skip del captcha check. Un atacante puede triggerearlo siempre mandando `code: '000000'` en el body — anula el fix P0-1 del audit 07-12 (captcha invisible login).
**Prioridad P0 aunque marcado P1** porque es regresión de un fix reciente.

### 2. **Track C P0-1** — `upsertLinkedContacto` cross-tenant contact hijacking
**File**: `routes/redB2b/partnerships.js:517-538` · **Fix**: ~1h + tests
Helper corre bajo `adminQuery` (BYPASSRLS) + `SELECT WHERE nombre = $1 AND linked_tenant_id IS NULL LIMIT 1` sin filtro `tenant_id`. Al aceptar partnership Red B2B, un contacto homónimo de OTRO tenant se linkea al partner del que acepta.
**Impacto**: cross-tenant data corruption silenciosa. Detectable con query post-fix para inventariar linked_tenant_ids incorrectos.

### 3. **Track C P0-2** — `cambio_entidades` FK cross-tenant (3er sitio del mismo pattern)
**File**: `lib/crossTenantPagos.js:324-329` · **Fix**: ~45min + tests
SELECT entidad "Red B2B — diferencias cambiarias" sin filtro tenant. Primer tenant "gana" el id; siguientes tenants persisten `cambio_movimientos` con FK cross-tenant. Contabilidad de Cambios cross-tenant rota.
**Este es el 3er sitio con el mismo bug**: ya se cerró en `ensureSellerClienteCc` + `ensureBuyerProveedor` (Sprint 1 P0-1 del audit 07-12). Sugerir grep-based CI check contract para detectar el pattern estructuralmente (`SELECT ... FROM (tabla tenant-scoped) WHERE (algún atributo) LIMIT 1` sin `tenant_id`).

### 4. **Track B P0-1** — Canje `_existing` UPDATE sin filtro tenant + deleted_at
**File**: `routes/ventas.js:383-389` · **Fix**: ~15min + tests
UPDATE final del producto asociado a un canje omite `tenant_id = $M` y `deleted_at IS NULL`. SELECT previo sí filtra. Rompe defense-in-depth + abre TOCTOU si otro proceso soft-deletea entre SELECT y UPDATE.

### 5. **Track D P0-1** — `/publico/usados/:token` indexable por Google
**File**: routes de share links + `frontend/public/robots.txt` + backend header · **Fix**: ~1h
Ruta pública NO tiene `noindex`, `robots.txt` no cubre `/publico/`, backend no envía `X-Robots-Tag`. **Google puede indexar catálogos completos con precios + WhatsApp del vendedor** de cualquier tenant. Persistente (Wayback/Google cache).
Impacto: bug de expectativa contractual + posible Ley 25.326 (datos personales expuestos sin consentimiento explícito para indexar).

### 6. **Track A P0-1** — `syncVentaVuelto` con `tc: null` hardcoded (ledger cross-moneda roto)
**File**: `lib/ventaSync.js:126-142` · **Fix**: ~10min + tests
Egreso del vuelto se postea con `tc: null` hardcoded. Cuando `vuelto_moneda` es ARS/UYU, `monto_usd` persiste como **0**, aunque `venta.vuelto_tc` esté disponible. Saldo nativo OK pero ledger cross-moneda del reporting subestima cada vuelto.
Fix: 1 línea leyendo `venta.vuelto_tc`.

**Estimación Sprint 0**: 4-5h total. **Recomiendo hacerlo mañana temprano** dado que hay 3 items de cross-tenant + 1 regresión.

---

## Sprint 1 — Batch P1 quick wins (~1-2h c/u)

Ordenados por impacto/riesgo. Estimación total ~10h.

| # | Track | Finding | File | Fix |
|---|---|---|---|---|
| 1 | A | P1-6 Cobranza masiva sin Idempotency-Key (doble-click duplica lote entero) | `routes/cuentas.js:1251` | ~2h |
| 2 | C | P1-1 `/api/auth/refresh` sin rate limiter | `routes/auth.js:710` | ~30min |
| 3 | D | P1-1 XSS stored en Landing via `contact_instagram_url` (defensivo pre-#499) | `Landing.jsx:800` + Zod schema | ~1h |
| 4 | A | P1-1 Cajas.jsx input TC UY roto (`moneda === 'ARS'` hardcoded) | `screens/Cajas.jsx:551, 1065` | ~1h |
| 5 | B | P1-1/1-2 Doble `className` en 2 `<select>` (React silencia) | `Inventario.jsx:1413`, `EquiposUsadosContent.jsx:237` | ~15min |
| 6 | A | P1-2/1-3 Cobranza + cambios sin `assertMonedaValidaParaPais` | `routes/cuentas.js`, `routes/cambios.js` | ~1h |
| 7 | E | P1-1 `/api/csp-report` sin captura Sentry | `app.js:353-365` | ~15min |
| 8 | E | P1-2 `pool.on('error')` sin reportar a Sentry con throttle | `config/database.js:47-49, 340-342` | ~30min |
| 9 | C | P1-2 `signup.js:712` `SET LOCAL` interpolación (última interpolación legacy) | `routes/signup.js:712` | ~5min |
| 10 | D | P1-2 CSP prod permite URLs de backend-STAGING | `netlify.toml` + `csp-parity` check | ~30min |

**Nota sobre item #4 (multi-país UY)**: probablemente el mismo pattern se repite en `Egresos.jsx`, `Cambios.jsx`, `CuentasCC.jsx`, `Tarjetas.jsx`. Grep global `moneda === 'ARS'` en frontend para encontrar los sitios y batchear en el mismo Sprint. Si son >3 sitios, considerar Sprint 2 dedicado.

---

## Sprint 2 — P1 medium complexity (~2-3h c/u)

Estimación total ~15h.

| # | Track | Finding | File |
|---|---|---|---|
| 1 | B | P1-3 `RecepcionStock.jsx` usa `clase: 'celular'` legacy (columna dropeada) | `screens/RecepcionStock.jsx:195` |
| 2 | B | P1-4 `buildBulkMovimientosPayload` silencia reconciliación fallida de clase_id/deposito_id | `importStock.js:452-458` |
| 3 | A | P1-4 `syncFinancieraComprobante` primer SELECT `LIMIT 1` sin `ORDER BY` (indeterminismo silencioso) | `lib/comprobante*.js` |
| 4 | A | P1-5 `postCajaMovimientoFinanciera` con `tc: null` hardcodeado (multi-país + USDT) | `lib/comprobante*.js` |
| 5 | C | P1-3 `resolveOwnerEmail` puede seleccionar `tenant_users` cross-tenant si SET LOCAL falla | `lib/redB2bEmail.js` |
| 6 | C | P1-4 `crossTenantOps.createSellerVenta` info leak de nombres de productos ajenos | `lib/crossTenantOps.js` |
| 7 | C | P1-5 `redB2b/config.js` GET sin filtro tenant (defense-in-depth gap) | `routes/redB2b/config.js:113` |
| 8 | B | P1-5 `GET /inventario/usados` filtro `solo_canjes` no filtra tenant en JOIN | `routes/inventario.js` |
| 9 | B | P1-6 `getShareLinkStats` puede correr con `shareLinkId` cross-tenant (admin pool) | `routes/shareLinks.js` |
| 10 | B | P1-7 `PATCH /share-link` acepta cambio de `activo` sin gate específico | `routes/inventario.js` (share link section) |

---

## Sprint 3 — P1 heavy + refactor (~3-6h c/u)

Estimación total ~20h.

| # | Track | Finding |
|---|---|---|
| 1 | C | P1-6 `resolveUserTenant` sigue con `ORDER BY tenant_id ASC LIMIT 1` — **bloquea multi-tenant per user** (change grande, discutir con Lucas antes) |
| 2 | E | P1-3 `getMigrationCount()` / `getCommitSha()` cachean forever (stale al re-deploy sin restart) |
| 3 | E | P1-4 Rate limiter `hasValidSignedJwt` corre `jwt.verify` PER REQUEST sin cache |
| 4 | E | P1-6 Netlify double-deploy race condition sin diagnóstico automatizado |
| 5 | E | P1-7 Cache invalidation cross-instance de `createTenantScopedCache.invalidatePrefix` no propaga |
| 6 | E | P1-8 `railway.json` no fuerza rebuild del pod cuando cambian solo migrations |
| 7 | E | P1-5 RLS content check en warning-only (follow-up PR #874 conocido) |

**Nota importante Sprint 3**: el item 7 (RLS content check warning-only) requiere superuser en Railway console. Es el follow-up conocido del PR #874. Coordinar con Lucas antes de arrancar (necesita acceso Railway).

---

## Sprint 4 — Batch P2/P3 higiene cross-track (~10h)

Consolidación de ~30 P2 + ~16 P3 en un único batch. Priorizar:

- **Sanidad estructural**: tests parametrizables, comments desactualizados, dedup de código
- **Multi-país edge cases**: schemas TC sin `.max()`, snapshot cross-moneda edge
- **Cache higiene**: `invalidateCajas` faltante en 4 rutas (P2-2 Financiero), Redis fallback más robusto
- **Contract tests nuevos**: grep-based CI check para pattern `UPDATE tabla WHERE ... sin tenant_id` (Track B P2 y Track C — mismo pattern)
- **JSON-LD landing desincronizado** (Track D P2-1)
- **Backup Backblaze integrity check** (Track E P2-4)

---

## Cross-track dependencies + observaciones

### Findings que tocan múltiples tracks

1. **Pattern residual UPDATE sin `tenant_id`** — cazado en Track B (P0-1 canje) y Track C (P0-1, P0-2, P1-3, P1-4, P1-5). Sugerencia: **contract test estático grep-based** en `scripts/security/tenant-scope-check.mjs` que ranquee UPDATEs y SELECTs a tablas tenant-scoped sin `tenant_id` en el WHERE. Reduciría superficie a auditar.

2. **Multi-país incompleto** — cazado en Track A (P1-1 Cajas UY, P1-2 cobranza, P1-3 cambios, P1-5 Financiera USDT, P2-3 snapshot, P2-4 canjes local, P2-5 tarjetas, P2-6 cambio_movimientos overflow). Todo el track A converge en el mismo problema. Sprint 1 item #4 puede convertirse en sprint dedicado si hay más de 3 sitios. **Recomendación**: hacer un mini-audit específico multi-país como pre-work del Sprint 1.

3. **Idempotency-Key en bulk operations** — Track A P1-6 (cobranza masiva). Pattern replicable para `POST /clases/bulk` y `POST /depositos/bulk` (PRs recientes #876/#877) del Track B — actualmente sin Idempotency guard.

4. **Sentry capture faltante para eventos de infra** — Track E P1-1 (/api/csp-report) y P1-2 (pool.on error). Ambos son "observabilidad para casos raros pero críticos". Combinar en un mini-batch.

5. **Follow-up PR #874 (superuser DB ownership)** — mencionado en Track E como pending conocido. NO parte del audit. Requiere acceso Railway console de Lucas.

### Regresiones detectadas (nuevo vs 07-12)

**1 regresión**: Track D P1-3 bypass captcha via `code` (introducida por hotfix P0 #583).
Sugerencia: agregar test específico en `signup.test.js` o `authFlow.test.js` que valide que el skip de captcha en step 2 solo aplica cuando hay `tempAuth JWT` presente en el body, NO cuando hay `code` (que puede ser input del usuario). Similar al `regresión guard` que usamos en `fmtSignedParts` tests.

### Postura general

**Excelente**: la plataforma sigue sólida después de 4 auditorías consecutivas de hardening. Los P0 nuevos son de áreas menos auditadas antes (Red B2B, share links públicos post-Equipos Usados, sync vuelto post-multi-país UYU). Cerrando Sprint 0 (5-6h) el nivel de riesgo baja significativamente. Los sprints 1-3 son higiene incremental.

**Cadencia sugerida próxima audit**: 4-6 semanas (post-cierre de Sprint 3), o al llegar a 20+ tenants activos, lo que ocurra primero.

---

## Roadmap ejecución sugerido

| Sprint | Duración | Ítems | Riesgo pre-fix | Impacto |
|---|---|---|---|---|
| **0** | 4-5h | 5 P0 + 1 regresión | 🔴 ALTO (cross-tenant leaks + captcha bypass + Google indexing) | 🟢 P0 cerrado 100% |
| **1** | ~10h | 10 P1 quick wins | 🟡 MEDIO | Cierre 33% P1 |
| **2** | ~15h | 10 P1 medium | 🟡 MEDIO | Cierre 66% P1 |
| **3** | ~20h | 7 P1 heavy + refactor | 🟢 BAJO | Cierre 100% P1 |
| **4** | ~10h | P2/P3 batch cross-track | 🟢 BAJO | Higiene + contract tests nuevos |
| **Total** | ~60h | 83 findings | | Cierre estimado ~90% |

---

## Anexos

- [`2026-07-25-financiero.md`](2026-07-25-financiero.md) — Track A detallado
- [`2026-07-25-stock.md`](2026-07-25-stock.md) — Track B detallado
- [`2026-07-25-auth-multitenant.md`](2026-07-25-auth-multitenant.md) — Track C detallado
- [`2026-07-25-externa.md`](2026-07-25-externa.md) — Track D detallado
- [`2026-07-25-plataforma.md`](2026-07-25-plataforma.md) — Track E detallado
- [`2026-07-12-cierre.md`](2026-07-12-cierre.md) — Audit anterior (referencia)
