# Auditoría TOTAL Tecny Portal — Consolidado — 2026-07-12

**Fecha**: 2026-07-12
**Metodología**: 5 tracks paralelos con agentes especializados + revisión consolidada. Cada track evaluó los 5 ejes: **escalabilidad, trazabilidad, solidez, excelencia, seguridad**.
**Docs por track**:
- [Financiero](./2026-07-12-audit-financiero.md) — Ventas, Cajas, CC, Cambios, Tarjetas, Financiera, Proveedores mov.
- [Stock](./2026-07-12-audit-stock.md) — Inventario, Envíos, Proveedores, Usados, Canjes
- [Auth](./2026-07-12-audit-auth.md) — RLS, Capabilities, Users, JWT, 2FA, Admin
- [Externa](./2026-07-12-audit-externa.md) — Share links, PDFs, chat-bot, sitio público, endpoints /publico
- [Plataforma](./2026-07-12-audit-plataforma.md) — Migrations, cache, deploy, CI, observability

---

## TL;DR EJECUTIVO

**Severity total: P0 12 · P1 32 · P2 39 · P3 48 = 131 findings sobre 149 archivos revisados.**

| Track | P0 | P1 | P2 | P3 | Health |
|---|---|---|---|---|---|
| Financiero | 3 | 5 | 6 | 9 | **Sólido base + deuda multi-país** |
| Stock | 3 | 6 | 8 | 6 | **Piso alto + gaps de cache y traza** |
| Auth | 1 | 8 | 10 | 6 | **El mejor track** (donde más invertiste) |
| Externa | 3 | 8 | 5 | 12 | **Razonable pero desigual** |
| Plataforma | 2 | 5 | 10 | 15 | **Notablemente bien construida** |

### Los 3 hallazgos más impactantes cross-audit

1. **Multi-país UYU incompleto en 5 módulos** (Financiero P0×3 + Stock P1-6 + Plataforma P2-6). El backfill F1-F5 cubrió Ventas + Cajas + Egresos + Proveedores + Cambios cross-tenant, pero dejó afuera: `POST /cuentas/movimientos`, cobranza masiva, `dashboardMensual.topProductos/Vendedores`, `canjes.moneda` CHECK constraint, y chat_rate_limits UNIQUE. **Impacto real**: los KPIs del Resumen Mensual mienten para el 100% de los tenants con ventas USD (subestiman 1400×). Tenants UY que hacen cobros individuales o canjes rebotan con errores opacos.

2. **Bypass del rate limit global con JWT válido** identificado por 3 tracks distintos (Plataforma P0-2, Auth P1-8, Externa P1-2). Un JWT robado tiene lifetime 8h y desactiva el limiter global. Puede quemar budget de OCR/Anthropic del tenant víctima o saturar el pool DB. **Un solo fix (rate limiter secundario per user.id) cierra el vector en los 3 tracks.**

3. **TABLAS_CON_RLS lista canónica desactualizada** (Auth P0-1). 5+ tablas tenant-scoped nuevas (`clases_producto`, `cross_tenant_operations`, `tenant_partnerships`, `venta_emails_enviados`, `caja_transferencias`, etc.) definen policies inline sin lint que garantice consistencia con la lista de fail-closed. Si un dev futuro copia un patrón viejo permissive, crea leak cross-tenant. **Riesgo latente pero real** — la próxima tabla nueva puede romperlo.

### El portal está en **buena salud arquitectónica**. Los findings dominantes son:
- **Deuda de migración incompleta** (multi-país, cache invalidation faltante en flows secundarios)
- **Gaps de trazabilidad** (login events sin audit, share link 404/410 sin log)
- **Superficie externa desigual** (share link bien blindado, login sin captcha)
- **Solidez de infra** (patrones sanos pero algunos con room to harden)

No hay bugs de **atomicidad**, **cross-tenant contamination**, o **RLS coverage** que hayan escapado a las auditorías previas (Red B2B, TANDA 0-4, SEG-1/2/4, PR-04). Esto vale la pena celebrarlo.

---

## Los 12 P0s ranked por impacto real

Orden basado en: **frecuencia de disparo × usuarios afectados × dificultad de detección post-facto**.

### Tier 1 — Bugs que están corrompiendo datos AHORA

| # | Track | Fix | Impacto | Costo | Complexity |
|---|---|---|---|---|---|
| **1** | Financiero P0-3 | `dashboardMensual.topProductos` divide por `tc_venta` sin filtrar por moneda del item | KPIs del Resumen Mensual **mienten para el 100%** de tenants con ventas USD | 1h | Trivial (copiar CASE del dashboard general) |
| **2** | Stock P0-3 | `POST /proveedores/movimientos/bulk` (=import XLSX!) no invalida `inventarioCache` | Cada import de 100+ productos deja el dashboard stale hasta 20s | 15min | Trivial (`invalidateMetricas` call) |
| **3** | Financiero P0-2 | Cobranza masiva UYU con `grupoMoneda` local divergente del canónico | Cobranza UYU contra caja USDT corrompe saldo × 40 | 1h | Trivial (import el helper) |

### Tier 2 — Vulnerabilidades explotables (seguridad)

| # | Track | Fix | Impacto | Costo | Complexity |
|---|---|---|---|---|---|
| **4** | Stock P0-1 | `PUT/DELETE /usados` sin `requireCapability` — vendedor con `usados.ver` (default) puede editar precios y borrar equipos | Vandalismo del share link público + comprometido cotizador | 30min | Trivial (3 gates) |
| **5** | Externa P0-1 | `/login` sin captcha ni lockout distribuido por IP | Brute-force distribuido factible sobre cualquier email conocido (Lucas es objetivo obvio) | 4h | Medio (backend + frontend) |
| **6** | Externa P0-3 | `SHARE_LINK_IP_SALT` con fallback dev inseguro | Si Railway olvidara la env, el hash de IP es reversible → rompe promesa de anonimización | 15min | Trivial (fail-closed en boot) |
| **7** | Plataforma P0-2 | Global rate limiter bypass con JWT firmado válido | JWT robado (TTL 8h) desactiva limiter → burn de budget OCR/Anthropic + saturación pool DB | 2h | Medio (agregar per-user limiter) |

### Tier 3 — Bugs de multi-país (bloquean tenants UY)

| # | Track | Fix | Impacto | Costo | Complexity |
|---|---|---|---|---|---|
| **8** | Financiero P0-1 | `POST /cuentas/movimientos` hardcodea `moneda='USD'` en postCajaMovimiento | Tenant UY con caja UYU no puede registrar cobros individuales | 3h | Medio (schema + frontend picker) |

### Tier 4 — Riesgos latentes (bugs que están por aparecer)

| # | Track | Fix | Impacto | Costo | Complexity |
|---|---|---|---|---|---|
| **9** | Auth P0-1 | `TABLAS_CON_RLS` canónica desactualizada — 5+ tablas nuevas con policies inline | Trampa esperando romperse: la próxima tabla nueva puede quedar permissive silenciosamente | 1 día | Alto (script canónico + startup assertion + doc ADR) |
| **10** | Stock P0-2 | `descontarStock` UPDATE sin `deleted_at IS NULL` — mismo TOCTOU que Red B2B P2-1 | Race window entre SELECT y UPDATE: producto soft-deleted queda re-vivo con stock decrementado | 5min | Trivial (3 chars al WHERE) |
| **11** | Plataforma P0-1 | `withTenant` interpola tenantId con string concat en vez de bind param | Tripwire escondido si un refactor futuro pasa tenantId sin validar | 30min | Trivial (`set_config` con bind) |
| **12** | Externa P0-2 | Cache CDN de 60s en share link no invalida al rotar el token | Link viejo sigue sirviendo hasta 60s tras el rotate — contradice la promesa "rotar = invalida YA" | 1h | Trivial (`Cache-Control: private`) |

---

## Cross-track patterns detectados

Los patrones **más valiosos del audit** — bugs identificados por múltiples agentes con visiones independientes.

### Pattern A: JWT rate limiter bypass (3 tracks confirmaron)

- **Plataforma P0-2**: `hasValidSignedJwt` skippea el global limiter
- **Auth P1-8**: mismo bug identificado como P1 en el track auth
- **Externa P1-2**: mismo bug identificado como P1 en superficie externa

**Un solo fix cierra los 3.** Agregar rate limiter secundario per user.id (1000/15min) en lugar de bypass total del global.

### Pattern B: Multi-país UYU incompleto (5 sitios)

- **Financiero P0-1**: `POST /cuentas/movimientos` hardcodea `moneda='USD'`
- **Financiero P0-2**: cobranza masiva `grupoMoneda` local sin UYU
- **Financiero P0-3**: `dashboardMensual` sin distinguir moneda del item
- **Stock P1-6**: `canjes.moneda` CHECK constraint sin UYU
- **Plataforma P2-6**: `chat_rate_limits` UNIQUE sin tenant_id

**Origen común**: el backfill F1-F5 se enfocó en Ventas + Cajas + Cambios cross-tenant y dejó módulos secundarios afuera. **Un sprint dedicado a "cerrar UYU en todos los módulos"** resuelve la deuda de una.

### Pattern C: TOCTOU en soft-delete (bug conocido, sigue apareciendo)

- **Red B2B P2-1** (ya cerrado en PR #572): `crossTenantOps.js:358`
- **Stock P0-2** (nuevo hallazgo): `ventaCore.js:76-83` (`descontarStock`)
- **Stock P2-1** (nuevo hallazgo): `inventario.js:1274` (`PUT /productos/:id`)
- **Stock P2-3** (nuevo hallazgo): `envios.js:409` (soft-delete envío)

**El pattern es rediseñable**. Cualquier UPDATE que dependa de un SELECT previo con `deleted_at IS NULL` debe incluir el mismo filtro en el WHERE. Se puede **prevenir con lint** (regla ESLint custom que detecte `UPDATE productos` sin `deleted_at IS NULL`).

### Pattern D: Cache invalidation olvidada (3 flows)

- **Stock P0-3**: `POST /proveedores/movimientos/bulk` (import XLSX = flow más caliente)
- **Stock P1-2**: `POST/PUT/DELETE /envios` (3 endpoints sin invalidateMetricas)
- **Plataforma P1-4**: fire-and-forget `.catch(() => {})` en cache invalidation crítica

**Root cause**: cada endpoint tiene que **recordar** invalidar el cache — no hay helper centralizado. Follow-up: mover la invalidación a un middleware post-COMMIT o un hook del db.withTenant.

### Pattern E: Audit trail gap (3 tracks confirmaron)

- **Auth P1-1**: login exitoso/fallido/lockout, logout, forgot-password sin audit persistido
- **Auth P1-6**: 4 endpoints 2FA con `audit()` firma incorrecta (sin `client` → fuera de tx)
- **Externa P1-7**: share link público sin audit en 404/410

**Impacto forense**: sin audit trail persistido, un incidente detectado 2 semanas después no tiene trace (Railway logs con retención finita). ISO 27001 / PCI / SOX exigen audit para auth events — bloqueante si Tecny escala a enterprise.

### Pattern F: Capability gates faltantes (3 tracks)

- **Stock P0-1**: `PUT/DELETE /usados` sin `requireCapability` (P0)
- **Externa P1-4**: 5 chat-bot tools sin capability gate (`get_ventas_pendientes`, etc.)
- **Financiero P3-4**: `GET /cajas/dashboard/negativas` sin cap check (P3)

**Root cause**: cuando se agrega un endpoint, es fácil olvidar el gate. Follow-up: **lint que rechace `router.post/put/delete` sin `requireCapability`** en el mismo statement (excepción explícita con comentario).

### Pattern G: Idempotency-Key faltante (1 track, 5 endpoints)

- **Financiero P1-1**: `POST /ventas`, `POST /cuentas/movimientos`, `POST /proveedores/movimientos`, `POST /tarjetas/liquidaciones`, `POST /cambios/movimientos` — **ninguno** tiene Idempotency-Key.

Red B2B (COR-1 + P1-3) implementó el pattern con éxito. **Aplicarlo a los 5 endpoints del portal principal es scope grande pero mecánico** — cada uno es +5 líneas backend + 3 líneas frontend + tests.

---

## P1s por eje

### Solidez (12 findings)

| # | Track | Descripción | Costo |
|---|---|---|---|
| 1 | Financiero P1-1 | `POST /ventas` sin Idempotency-Key (doble-click duplica venta) | 6h (5 endpoints) |
| 2 | Financiero P1-2 | Egresos recurrentes generan con TC stale (multi-país) | 2h |
| 3 | Financiero P1-3 | PATCH tarjeta liquidación no distingue mensaje 409 caja destino | 2h |
| 4 | Financiero P1-5 | `syncTarjetaCobros` JOIN frágil (venta_id+metodo_pago+monto) | 4h |
| 5 | Auth P1-5 | Race en signup + resolveUserTenant en super-admin invite | 2h |
| 6 | Auth P1-7 | 2FA `verifyAndConsume` con recovery code DoS-vulnerable | 15min |
| 7 | Externa P1-5 | PDF sin sanitizar texto multiline (control chars, RTL, NUL) | 1h |
| 8 | Plataforma P1-4 | Cache invalidation fire-and-forget en flows críticos | 1h |
| 9 | Plataforma P1-5 | Guideline: migrations con backfill chunked (helper compartido) | 1 día |
| 10 | Stock P1-3 | Bulks de inventario sin `AND tenant_id = $` explícito (defense-in-depth) | 20min |
| 11 | Stock P1-2 | `POST/PUT/DELETE /envios` no invalidan `inventarioCache` | 15min |
| 12 | Externa P1-3 | `/api/csp-report` y `/client-errors` sin truncar payloads antes de log | 20min |

### Trazabilidad (8 findings)

| # | Track | Descripción | Costo |
|---|---|---|---|
| 1 | Auth P1-1 | Login exitoso/fallido/lockout, logout, forgot-password sin audit | 3h |
| 2 | Auth P1-6 | 4 endpoints 2FA con `audit()` firma incorrecta (fuera de tx) | 1h |
| 3 | Externa P1-7 | Share link público sin audit en 404/410 (miles de scan silenciosos) | 30min |
| 4 | Stock P1-1 | Canje con producto asociado queda huérfano al cancelar venta | 4-6h |
| 5 | Externa P2-5 | Chat-bot tool_use intermedio no persistido (audit incompleto) | Deuda |
| 6 | Financiero P2-4 | `grupoMoneda` local duplicado en cobranza (drift potencial) | 5min |
| 7 | Plataforma P1-1 | `purgarAuditLogsViejos` redundante con job de particiones | 1h |
| 8 | Financiero P3-9 | `evalCajaNegativa` no filtra `deleted_at` en HAVING (deuda documental) | 0 (doc only) |

### Seguridad (7 findings)

| # | Track | Descripción | Costo |
|---|---|---|---|
| 1 | Auth P1-2 | `POST /revoke/:userId` no bumpea `password_changed_at` del target | 20min |
| 2 | Auth P1-3 | PUT `/usuarios/:id` no exige 2FA re-auth cuando admin edita a sí mismo | 2h |
| 3 | Auth P1-4 | `/api/auth/logout` DoS-vulnerable con JWT robado | 30min |
| 4 | Auth P1-8 (=Plat P0-2 =Ext P1-2) | JWT bypass del rate limiter global | 2h ONE FIX |
| 5 | Externa P1-1 | `/api/public/super-admin-invite/:token/accept` sin captcha | 30min |
| 6 | Externa P1-4 | 5 chat-bot tools sin capability gate | 30min |
| 7 | Stock P1-4 | Share link público expone tenant suspendido / paid_until vencido | 1-2h |

### Escalabilidad (3 findings)

| # | Track | Descripción | Costo |
|---|---|---|---|
| 1 | Stock P0-3 | Cache invalidation olvidada en 3 flows (**listado como P0 por frecuencia**) | 15min |
| 2 | Plataforma P1-3 | `pool.query` monkey-patch always-on con costo micro-persistente | 30min |
| 3 | Externa P1-8 | Compresión gzip sobre respuestas privadas (`/me`, `/login`) — vector BREACH | 15min |

### Excelencia (2 findings)

| # | Track | Descripción | Costo |
|---|---|---|---|
| 1 | Financiero P1-4 | `recalcComprobantesFinancieraByTenant` `@deprecated` pero exportado (tentación) | 15min |
| 2 | Plataforma P1-2 | CI no valida migrations con NOSUPERUSER + FORCE RLS (prevención F1-like) | 4h |

---

## Roadmap priorizado

Recomiendo esta secuencia — **quick wins primero para bajar el riesgo con costo mínimo**.

### Sprint 0 — Batch de quick wins P0 (1 día, 1 PR)

Los P0s de **trivial complexity** con máximo impacto. Todos juntos en un solo PR estilo el batch #565 de Red B2B.

- ✅ Financiero P0-2 — cobranza masiva UYU import grupoMoneda (1h)
- ✅ Financiero P0-3 — dashboardMensual copiar CASE del general (1h)
- ✅ Stock P0-1 — 3 capability gates en usados (30min)
- ✅ Stock P0-2 — deleted_at en descontarStock (5min)
- ✅ Stock P0-3 — invalidateMetricas en 3 rutas proveedores (15min)
- ✅ Externa P0-3 — SHARE_LINK_IP_SALT fail-closed en boot (15min)
- ✅ Plataforma P0-1 — withTenant → set_config (30min)
- ✅ Externa P0-2 — Cache-Control private en share link (30min)

**Total: ~4h de fixes.** Cierra 8 de los 12 P0s con impacto máximo por hora.

### Sprint 1 — P0 con más scope + Pattern A (2-3 días, 4 PRs)

Los P0s que requieren migration, coordinación frontend, o consenso.

- **PR A**: fix Pattern A — JWT rate limiter bypass (Plataforma P0-2 + Auth P1-8 + Externa P1-2). **Un fix, 3 tracks cierran** (~2h)
- **PR B**: fix Externa P0-1 — captcha en /login + contador diario per email (~4h)
- **PR C**: fix Auth P0-1 — TABLAS_CON_RLS canónica + startup assertion + ADR (~1 día)
- **PR D**: fix Financiero P0-1 — multi-país en POST /cuentas/movimientos (~3h)

### Sprint 2 — Cerrar multi-país UYU (Pattern B) + trazabilidad crítica (3-4 días, 3 PRs)

- **PR E**: fix Pattern B — cerrar los 5 gaps multi-país en un batch. Stock P1-6 (canjes UYU) + Financiero P1-2 (recurrentes TC) + Plataforma P2-6 (chat_rate_limits) + Financiero P2-1/P2-6 (Cambios UYU + Financiera UYU deuda) (~4h)
- **PR F**: fix Pattern E — audit trail login events. Auth P1-1 + Auth P1-6 + Externa P1-7 (~4h)
- **PR G**: fix Auth P1-3 — cambio de email exige verificación al email VIEJO. Migration `email_change_tokens` (~2h)

### Sprint 3 — Idempotency-Key en Financiero + seguridad restante (3-4 días, 3 PRs)

- **PR H**: fix Pattern G — Idempotency-Key en 5 endpoints (`/ventas`, `/cuentas/movimientos`, `/proveedores/movimientos`, `/tarjetas/liquidaciones`, `/cambios/movimientos`). Migration compartida + backend + frontend + tests (~6h)
- **PR I**: fix seguridad batch — Auth P1-2 (revoke bumpea), Auth P1-4 (logout DoS ratelimit), Externa P1-1 (captcha super-admin invite), Externa P1-4 (chat-bot caps) (~3h)
- **PR J**: fix Externa P1-5 (sanitize PDF) + P1-8 (compression filter auth) + P1-6 (no exponer TTL) (~2h)

### Sprint 4 — Infra hardening (3-4 días, 3 PRs)

- **PR K**: fix Plataforma P1-2 — CI test contra NOSUPERUSER + FORCE RLS (~4h). **Previene otro incidente tipo F1.**
- **PR L**: fix Plataforma P1-1 + P1-3 + P1-4 — dropear purga redundante, flag DB_INT_CAST_DEBUG, await invalidations críticas (~2h)
- **PR M**: fix Stock P1-1 — canjes con soft-delete + revertirEfectosVenta toca canjes. **Requiere decisión de Lucas antes.** (~4-6h)

### Sprint 5 — Batch P2/P3 (2-3 días, 2 PRs)

Los P2/P3 seleccionados por Lucas — cierran deuda técnica sin urgencia. Similar al PR #572 de Red B2B.

- **PR N**: batch P2 — 15-20 findings de mediano impacto
- **PR O**: batch P3 — 20-30 findings cosméticos + hygiene

---

## Total estimado

| Sprint | Duración | PRs | Findings cerrados |
|---|---|---|---|
| Sprint 0 (quick wins) | 1 día | 1 | 8 × P0 |
| Sprint 1 (P0 con scope) | 2-3 días | 4 | 4 × P0 + Pattern A (3 findings) |
| Sprint 2 (multi-país + traza) | 3-4 días | 3 | Pattern B (5) + Pattern E (3) + 1 × P1 |
| Sprint 3 (Idempotency + security) | 3-4 días | 3 | Pattern G (5) + 6 × P1 |
| Sprint 4 (infra) | 3-4 días | 3 | 4 × P1 |
| Sprint 5 (batch P2/P3) | 2-3 días | 2 | 40-50 × P2/P3 |
| **TOTAL** | **15-20 días** | **16 PRs** | **~90 findings cerrados (69%)** |

Los ~41 findings restantes son **deuda cosmética documentada** — batch en un futuro sprint o abandonar según decisión.

---

## Buenas prácticas verificadas (destacado)

**Los tracks encontraron mucho más BIEN HECHO que roto.** Vale la pena celebrarlo:

### Financiero
- Atomicidad rigurosa (BEGIN/COMMIT/ROLLBACK bien anidados en 39+ endpoints)
- SALDO_CASE canónico usado en 4/5 sitios (S-03 fix)
- Snapshot inmutable de `comision_pct` congelado en `venta_pagos` (D-01)
- Multi-tenant RLS con SET LOCAL sistemático — sin filtración cross-tenant detectada
- Redacción de `ganancia_usd` en 4 sitios con `hasCapability` (F5b)

### Stock
- RLS sistemático en todas las tablas de inventario
- Bulk INSERT con UNNEST en 3 hot paths
- Guard `WHERE cantidad >= u.cant` en cuentas.js:704 (elimina TOCTOU sin FOR UPDATE)
- Advisory lock por IMEI ordenado
- UNIQUE PARCIAL `idx_productos_imei_unique WHERE deleted_at IS NULL AND estado='disponible'`
- Response shaping F5b — redact `costo`/`costo_moneda` sin `inventario.ver_costos`

### Auth (el track más maduro)
- Fail-closed RLS con NULLIF + PREDICATE_CLOSED
- FORCE ROW LEVEL SECURITY en 44 tablas
- JWT algorithm HS256 explícito (no `alg:'none'` accepted)
- Lockout per-user con UPDATE atómico
- Dummy bcrypt para timing constante en login/signup/forgot
- 2FA anti-replay con `last_used_step`
- Super-admin 2FA obligatoria (S-25)
- Anti-enumeration en signup + forgot + super-admin invite
- Guarda del último owner + último super-admin cross-instance-safe
- `password_changed_at` bump invalida JWTs cross-instance en <60s

### Externa
- **Sitio iPro-Website 100% estático** verificado (0 backend calls)
- **PDF con pdfkit** (no puppeteer) — elimina SSRF via Chromium
- Chat-tools **READ-ONLY** sistemático — prompt injection no puede convertirse en RCE
- CSP restrictivo (`defaultSrc: 'none'`)
- Share link precio_costo NOT exposed (defense-in-depth SQL + JS)
- Rate limiters cross-instance (PostgresRateLimitStore)
- Fix del bug histórico "Tek Haus veía Tecny" verificado en prod

### Plataforma
- Graceful shutdown completo (SIGTERM → close → Sentry flush → pool end → timeout)
- Advisory locks multi-instancia en TODOS los jobs periódicos
- Cache TTL con tombstone anti-stale-write cross-instance
- Jitter en SETEX (evita cache stampede)
- Runbook postmortem F1 documentado + integrado a migrations posteriores
- CI required gates: lint + type-check + tests + coverage threshold + npm audit + Playwright E2E
- Monitor de deploys Railway (issue GitHub automática si falla 2×)
- `req.tenantId + req.userId + req.request_id` propagado a logs + Sentry

---

## Preguntas abiertas globales — CERRADAS 2026-07-12

Las 8 decisiones consultadas con Lucas están cerradas. Registro para futura referencia:

1. **Comunicación fix del dashboard mensual** → **Comunicar antes del deploy con framing positivo** ("detectamos un cálculo del Resumen Mensual que estaba subestimando los items en USD/USDT. Mañana verán los totales correctos.").

2. **JWT TTL 8h → 2-4h** → **Mantener 8h**. Fixear solo el JWT bypass del rate limiter (Pattern A cross-track). El refresh flow queda para TANDA 6.

3. **CAPTCHA en `/login`** → **hCaptcha invisible siempre** (mismo widget que ya se usa en signup/forgot/invite).

4. **Share link con tenant vencido** → **`410` con mensaje neutro** "Este enlace no está disponible por el momento". Semi-transparente — no revela suspend/expired/rotate al cliente final.

5. **Canjes a soft-delete** → **Soft-delete automático del producto del canje** al cancelar la venta (si está `disponible` y no fue vendido) + audit "producto revertido por cancelación de venta". Migration `canjes.deleted_at`.

6. **MFA obligatorio para owners** → **Nudge UI soft push** — banner persistente hasta que activen. Sin bloqueo hard. Config `require_2fa_for_owners` para futuro enterprise.

7. **CI test contra NOSUPERUSER + FORCE RLS** → **Priorizar ya (Sprint 1)** — 4h de trabajo previene otro incident tipo F1. ROI claro.

8. **`recalcComprobantesFinancieraByTenant` deprecated** → **Borrar completamente**. Si algún día se necesita, YAGNI resuelto con contexto fresco.

---

## Comparación con auditorías previas

| Auditoría | Findings | P0 | P1 | Cerrados | Referencia |
|---|---|---|---|---|---|
| Red B2B (2026-07-11) | 23 | 3 | 5 | **Todos** (PRs #565-#572) | [Doc](../audit/2026-07-11-red-b2b-audit.md) |
| **Auditoría TOTAL (2026-07-12)** | **131** | **12** | **32** | 0 (nueva) | Este doc |

El scope de esta auditoría es **~5.7× mayor** que la Red B2B (cubre 5 tracks en lugar de 1). El ratio de P0/total es **similar** (13% Red B2B vs 9% Total) — lo que sugiere que la calidad de código promedio del portal está en el mismo rango que Red B2B.

Los P0s de esta auditoría son **menos catastróficos** que los P0s de Red B2B (que tocaban contabilidad cross-tenant). Los P0s de acá son más operativos (multi-país incompleto, KPIs mal calculados) o de seguridad de superficie externa (captcha login, cache CDN).

---

## Siguientes pasos recomendados

1. **Empezar por Sprint 0** — 4h de trabajo cierran 8 P0s. Mejor ratio impacto/costo del audit.
2. **Confirmar preguntas abiertas antes de Sprint 1** — algunos scope requieren tu decisión.
3. **Sprint 1 PR A (JWT rate limiter fix)** debe ser prioridad porque cierra 3 findings de 3 tracks distintos.
4. **Después de Sprint 1**, revalidar contra Preguntas abiertas y decidir si vamos por Multi-país o Idempotency primero.

---

**Total auditado**: 149 archivos únicos (con solapamiento cross-track). 5 tracks paralelos. 131 findings. Los 5 docs por track están en `docs/audit/2026-07-12-audit-*.md`.

Auditoría TOTAL completa.
