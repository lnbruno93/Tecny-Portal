# Audit Auth + Multi-tenant 2026-07-25

**Auditor**: Claude Opus (agente de auditoría dedicado al track Auth + Multi-tenant).
**Alcance**: `backend/src/middleware/{auth,requireCapability,requireSuperAdmin,adminOnly,features,signupLimiter}.js`, `backend/src/routes/{auth,signup,twoFa,usuarios,capabilities,superAdmin,superAdminTeam,publicSuperAdminInvite,tenant-profile,public,shareLinks,redB2b/*}.js`, `backend/src/lib/{rlsCanonical,capabilities,userAuthCache,userTenant,refreshTokens,twoFa,crossTenantOps,crossTenantPagos,redB2bEmail,audit,captcha,jwtVerify}.js`, `backend/src/config/database.js`, `scripts/security/backend-anti-regression-check.mjs`, `backend/server.js`.
**Método**: lectura completa de código con foco en cross-tenant leaks (ensure* / helpers sin filtro tenant bajo `adminQuery` BYPASSRLS), capability enforcement, session invalidation, refresh token rotation, startup assertions post-hotfix #874, RLS coverage, rate limiting per-endpoint.
**Nota**: se excluyeron findings ya cerrados en el ciclo 07-12 (12 sprints) y en el ciclo 07-24/25 (Sentry #16 audit_logs, #17 connection poisoning, P0 combo RLS content invariant, refresh token, chat bot P1 hardening prompt injection, JWT_EXPIRES_IN 15m→8h, hotfix P0 sesión, tools contract tests, cache invalidation audit, cleanup 29 SET LOCAL legacy).

---

## Contexto

Este track ya tuvo el mayor scrutinio del portal (2 auditorías previas, ~11 findings cerrados, hotfixes semanales sobre RLS/refresh/audit_logs). La superficie de Red B2B introdujo un patrón nuevo — helpers que corren bajo `adminQuery` (BYPASSRLS) y setean `SET LOCAL app.current_tenant` como scoping "lógico". Ese setup NO protege queries que consultan tablas tenant-scoped sin filtro explícito `tenant_id = $x`. El audit del 2026-07-11 (Red B2B) cerró 3 sitios (`ensureSellerClienteCc`, `ensureBuyerProveedor`, `resolveCajaParaTenant`) pero **quedaron regresiones en 2 helpers análogos** en Red B2B que este audit destapó.

Además: el nuevo refresh token pattern (2026-07-21) trajo una vulnerabilidad de keep-alive infinito sin rate limit dedicado en `/refresh`.

## Findings

### P0 — Críticos

#### P0-1 — `upsertLinkedContacto` linkea contacto de OTRO tenant al aceptar partnership Red B2B

**File**: `backend/src/routes/redB2b/partnerships.js:517-538`
**Categoría**: Cross-tenant data corruption

Al aceptar una partnership Red B2B (POST `/api/red-b2b/partnerships/:id/accept`), el helper `upsertLinkedContacto` corre bajo `db.adminQuery` (BYPASSRLS, role `tecny_admin`) y hace:

```js
const existingQ = await client.query(
  `SELECT id FROM contactos
     WHERE nombre = $1
       AND linked_tenant_id IS NULL
     LIMIT 1`,
  [linkedTenant.nombre]
);
```

**El SELECT NO filtra por `tenant_id`**. El `SET LOCAL app.current_tenant` de la línea 518 solo tiene efecto si Postgres evalúa las policies RLS — bajo BYPASSRLS el planner las salta. Resultado: si otro tenant tiene un contacto con el mismo nombre y `linked_tenant_id IS NULL`, el SELECT retorna su id, y el UPDATE de línea 534 modifica una fila cross-tenant:

```js
await client.query(
  `UPDATE contactos SET linked_tenant_id = $1 WHERE id = $2`,
  [linkedTenant.id, existingQ.rows[0].id]
);
```

**Escenario reproducible**:
1. Tenant A tiene el contacto "Tekny Tech" con `linked_tenant_id = NULL` (cliente común, no linkeado a partnership).
2. Tenant B acepta la invitación de partnership con el tenant C, cuyo `nombre` es "Tekny Tech" (colisión legítima — nombres de negocio no son globalmente únicos).
3. `upsertLinkedContacto({ ownerTenantId: B, linkedTenant: C })` corre. El SELECT (sin filtro tenant) devuelve el id del contacto del tenant A. El UPDATE linkea el contacto de A al tenant C.
4. Cross-tenant data corruption: (a) el contacto del tenant A queda con `linked_tenant_id = C_id` que A nunca eligió; (b) el tenant B queda sin su contacto creado (el helper hace early return con `return existingQ.rows[0].id` — mismo ID cross-tenant); (c) queries de B que hagan JOIN con `contactos WHERE id = <id_ajeno>` van a fallar por RLS.

**Impacto real**: hoy la superficie es pequeña (~10 tenants activos, colisión de nombres poco probable). Pero es una superficie que crece cuadráticamente con la base de tenants — a 100 tenants, colisiones de nombres "Cliente 1", "Ventas", "Distribuidor", nombres genéricos son inevitables. Además: mismo pattern que Sentry Red B2B P0-1 (ensureSellerClienteCc / ensureBuyerProveedor) que ya se cerró en `crossTenantPagos.js:187`. **Es una regresión del fix parcial de 07-11** — el fix omitió este callsite.

**Fix propuesto**: agregar `AND tenant_id = $2` al SELECT + pasar `ownerTenantId` como parámetro:

```js
const existingQ = await client.query(
  `SELECT id FROM contactos
     WHERE tenant_id = $1
       AND nombre = $2
       AND linked_tenant_id IS NULL
     LIMIT 1`,
  [ownerTenantId, linkedTenant.nombre]
);
```

Sumar test integración con 2 tenants con contactos homónimos.

**Costo estimado**: 30 min (fix + test).

---

#### P0-2 — `cambio_entidades` lookup en `registerSellerCobro` sin filtro tenant → FK cross-tenant en `cambio_movimientos`

**File**: `backend/src/lib/crossTenantPagos.js:324-329` (dentro de `registerSellerCobro`)
**Categoría**: Cross-tenant FK contamination (accounting integrity)

Cuando se registra un pago Red B2B con diferencia cambiaria (moneda_pago ARS/UYU, tc_pago ≠ tc_venta), el helper `registerSellerCobro` busca (o crea) una entidad "Red B2B — diferencias cambiarias" en el módulo Cambios de Divisa del seller. El SELECT corre bajo `db.adminQuery` (BYPASSRLS):

```js
const ENTIDAD_NOMBRE = 'Red B2B — diferencias cambiarias';
const entQ = await client.query(
  `SELECT id FROM cambio_entidades
     WHERE LOWER(nombre) = LOWER($1) AND deleted_at IS NULL
     LIMIT 1`,
  [ENTIDAD_NOMBRE]
);
```

**No filtra por `tenant_id`**. El nombre `'Red B2B — diferencias cambiarias'` es un canónico compartido a través de todos los tenants Red B2B por diseño (todos los tenants con Red B2B crean esa entidad al primer pago con diff cambiaria). El SELECT devuelve `LIMIT 1` con ORDER indefinido → potencialmente el `id` de la entidad del PRIMER tenant que la creó.

**Escenario reproducible**:
1. Tenant A (id=42) hace el PRIMER pago Red B2B con diferencia cambiaria. El helper: SELECT (0 filas) → INSERT `cambio_entidades (tenant_id=42, nombre='Red B2B — diferencias cambiarias')` con id=100. Persistido en `cambio_movimientos (tenant_id=42, entidad_id=100)`.
2. Tenant B (id=99) hace su primer pago Red B2B con diff cambiaria. Bajo SET LOCAL app.current_tenant=99 + BYPASSRLS: el SELECT devuelve `entidadId=100` (del tenant A). El INSERT en línea 360-378 guarda `cambio_movimientos (tenant_id=99, entidad_id=100)`.
3. `cambio_movimientos` del tenant B tiene FK a `cambio_entidades` del tenant A → cross-tenant reference. Cualquier reporte del tenant B que haga JOIN a `cambio_entidades` filtrando por RLS (fuera de adminQuery) fallará: la entidad no aparece en el resultset, el JOIN queda NULL, la ganancia/pérdida cambiaria del tenant B se pierde del reporte.

**Impacto real**: contabilidad de Cambios del tenant B queda inconsistente — los movimientos existen pero no matchean con su entidad (que "pertenece" a otro tenant). Silencioso — no explota como un error, se ve como "diferencias cambiarias sin entidad" en el UI.

**Escenario secundario más grave**: si el super-admin borra por error la entidad del tenant A (soft-delete via `cambio_entidades.deleted_at`), el JOIN de línea 328 filtra `deleted_at IS NULL` y devuelve 0 rows para el tenant B. El siguiente pago del tenant B crea `cambio_entidades (tenant_id=99, id=200)` — ahora hay 2 entidades (una viva, otra ex-linked del tenant A). Los movimientos históricos del tenant B siguen apuntando al id=100 (ahora huérfano soft-deleted del tenant A). Data corruption permanente.

**Fix propuesto**: agregar filtro `tenant_id = $2` al SELECT:

```js
const entQ = await client.query(
  `SELECT id FROM cambio_entidades
     WHERE tenant_id = $2
       AND LOWER(nombre) = LOWER($1) AND deleted_at IS NULL
     LIMIT 1`,
  [ENTIDAD_NOMBRE, sellerTenantId]
);
```

Mismo pattern que ya se cerró en `ensureSellerClienteCc` (línea 187) y `ensureBuyerProveedor` (línea 221) de este mismo archivo. Es la 3ra víctima del mismo bug — regresión del fix parcial 07-11.

**Costo estimado**: 30 min (fix + test).

---

### P1 — Importantes

#### P1-1 — `POST /api/auth/refresh` sin rate limiter dedicado — keep-alive infinito con refresh cookie robado

**File**: `backend/src/routes/auth.js:710-767`, `backend/src/app.js` (no hay mount de `refreshLimiter`)
**Categoría**: Seguridad (session)

El endpoint POST `/api/auth/refresh` (2026-07-21 Task #190) verifica el cookie `tecny_refresh`, rota el token y emite access token nuevo. No tiene `requireAuth` (por diseño — el auth es el cookie). Sin rate limiter dedicado:

- El global rate limiter (300/15min por IP) NO aplica bien: al ser POST con cookie httpOnly (sin `Authorization: Bearer`), `hasValidSignedJwt(req)` devuelve `false` → **el request SÍ cuenta contra los 300**. Bien. Pero un atacante con IP rotante (proxy pool, IPv6 /64 rotation) elude fácil.
- El authenticated rate limiter (1000/15min per user.id) NO aplica: `validateAndGetJwtUserId(req) == null` porque no hay JWT en el header → skip.

**Vector real**: atacante roba refresh cookie víctima (via XSS en un site relacionado que comparte dominio de segundo nivel, malware local, MITM en dev con HTTP). Puede hacer POST /refresh cada 14min (justo antes que expire el access token nuevo emitido) manteniendo sesión indefinidamente durante 30 días (TTL del refresh). La víctima NO se da cuenta hasta que vuelve al portal y su cookie ya rotado dispara la attack detection → revoca toda la familia. **Ventana de exposición: 30 días.**

En prod hoy hay ~10 tenants → superficie chica. Pero cuando la base crezca (~100-1K tenants con super-admins), un cookie robado del super-admin es "acceso admin cross-tenant hasta 30 días" — blast radius muy alto.

**Fix propuesto**: agregar `refreshLimiter` en app.js (pattern idéntico a `logoutLimiter`):

```js
const refreshStore = isTestEnv ? undefined : new PostgresRateLimitStore({ db, prefix: 'refresh', logger });
const refreshLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 20,                  // 20/hora es holgado (refresh típico: 4/hora)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de refresh, esperá 1 hora.' },
  // Key por cookie hash (mejor que IP porque cookie es lo que el atacante tiene).
  keyGenerator: (req) => {
    const cookie = req.cookies?.tecny_refresh;
    return cookie ? require('crypto').createHash('sha256').update(cookie).digest('hex').slice(0, 16) : ipKeyGenerator(req);
  },
  skip: () => process.env.NODE_ENV === 'test',
  ...(refreshStore && { store: refreshStore }),
});
app.use('/api/auth/refresh', refreshLimiter);
```

Un refresh legítimo dispara ~4-6 refresh/hora (JWT 8h TTL). 20/hora corta el keep-alive automatizado sin romper UX.

**Costo estimado**: 1h (limiter + tests + doc).

---

#### P1-2 — `signup.js:712` usa `SET LOCAL` con interpolación string inconsistente vs el resto del file

**File**: `backend/src/routes/signup.js:712` (dentro de `/resend-verification`)
**Categoría**: Consistency + defense-in-depth

En el mismo archivo, dos callsites usan bind param post-Sentry #17 (líneas 287 y 611):

```js
await client.query(
  `SELECT set_config('app.current_tenant', $1::text, true)`,
  [String(tenant.id)]
);
```

Pero el handler `/resend-verification` (línea 712) usa el pattern legacy interpolado:

```js
await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
```

Aunque `req.tenantId` está validado en `middleware/auth.js:132` (`Number.isInteger > 0`), la inconsistencia es exactamente lo que se documenta en el anti-regression check como "solo `${req.tenantId}` permitido". El script `scripts/security/backend-anti-regression-check.mjs:105-127` lo tiene en el allowlist.

**Impacto**: hoy no explota (guard middleware). Pero: si algún día se elimina el guard o se re-hidrata desde otro path (ej. worker que setea `req.tenantId` sin pasar por middleware), el pattern queda vulnerable. Ya está el ejemplo canónico en línea 287 y 611 del mismo file — cero razón para no migrar la línea 712 también.

**Fix propuesto**: reemplazar `SET LOCAL app.current_tenant = ${req.tenantId}` por el pattern canónico `SELECT set_config(...)` con bind param.

**Costo estimado**: 5 min. Es una línea.

---

#### P1-3 — `resolveOwnerEmail` en `redB2bEmail.js` puede seleccionar `tenant_users` de otro tenant si SET LOCAL falla silenciosamente

**File**: `backend/src/lib/redB2bEmail.js:56-124`
**Categoría**: Cross-tenant info leak (email dispatch)

El helper resuelve el email del owner del tenant destinatario. Corre bajo `db.adminQuery` (BYPASSRLS). Setea `set_config('app.current_tenant', $1::text, true)` (bind param OK post-fix Sentry #17). Después hace SELECT con `AND tu.tenant_id = $1` filtro explícito:

```js
const uQ = await client.query(
  `SELECT u.id, u.nombre, u.email, ...
     FROM users u
     JOIN tenant_users tu ON tu.user_id = u.id
    WHERE tu.tenant_id = $1
      AND tu.rol IN ('owner', 'admin')
      ...`,
  [tenantId]
);
```

El SELECT tiene el filtro correcto `tu.tenant_id = $1` — no hay leak de datos. Sin embargo, el `set_config` de línea 87 es innecesario acá (BYPASSRLS lo ignora, y el filtro inline hace el trabajo). El comentario dice "tenant_users tiene FORCE RLS — necesitamos SET LOCAL", pero bajo BYPASSRLS eso NO es cierto. El SET_LOCAL es ceremonial y no defiende de nada.

**Impacto**: información engañosa en el comment + confianza injustificada en el patrón. Si un dev futuro copia este helper y ELIMINA el filtro `WHERE tu.tenant_id = $1` "porque ya SET LOCAL", introduce cross-tenant leak instantáneo.

**Fix propuesto**: (a) actualizar el comment explicando que el SET LOCAL es defense-in-depth (por si un día se retira BYPASSRLS del rol), NO source-of-truth; (b) considerar remover el SET LOCAL si el filtro inline se mantiene (menos ceremonia = menos bugs latentes).

**Costo estimado**: 15 min (comment update + revisar callsites).

---

#### P1-4 — `crossTenantOps.createSellerVenta` SELECT productos sin filtro tenant → info leak de nombres de productos ajenos en error `stock_insufficient`

**File**: `backend/src/lib/crossTenantOps.js:285-301`, `326-353`
**Categoría**: Info leak

En `createSellerVenta`, el SELECT productos (línea 286-292) NO filtra por `tenant_id`:

```js
const prodsQ = await client.query(
  `SELECT id, nombre, observaciones, cantidad, costo, costo_moneda
     FROM productos
    WHERE id = ANY($1::int[]) AND deleted_at IS NULL
    ORDER BY id`,
  [prodIds]
);
```

Bajo `adminQuery` (BYPASSRLS), esto retorna productos de CUALQUIER tenant que matche los ids. El UPDATE atómico posterior (línea 333) SÍ filtra por `AND p.tenant_id = $3`, así que el stock del tenant ajeno no se decrementa — pero el path de error (línea 339-353) usa `prodMap.get(pid).nombre` que puede ser el nombre del producto AJENO:

```js
if (updRes.rowCount !== decPids.length) {
  const insuf = [];
  for (const [pid, qty] of qtyByProd.entries()) {
    const p = prodMap.get(pid); // ← puede ser producto de otro tenant
    if (!p) continue;
    if (Number(p.cantidad) < qty) {
      insuf.push({ producto_id: pid, nombre: p.nombre, disponible: p.cantidad, pedido: qty });
    }
  }
  const e = new Error('stock_insufficient');
  e.detail = { faltantes: insuf };  // ← se propaga al 409 response
  throw e;
}
```

**Escenario reproducible**: atacante seller manda POST `/api/red-b2b/operations` con `items: [{ producto_id: 99999, cantidad: 1000 }]` donde 99999 es un id de producto de OTRO tenant. El SELECT lo trae. El UPDATE (con filtro tenant) no lo decrementa (rowCount=0). El path de error retorna `{ faltantes: [{ producto_id: 99999, nombre: '<nombre del producto ajeno>', disponible: <cantidad ajena>, pedido: 1000 }] }` — leakeando el nombre del producto y el stock ajeno.

**Impacto**: reconocimiento pasivo — un atacante puede enumerar productos ajenos scaneando ids (max 500 items por op, tamaño del espacio de ids típico ~10K por tenant, factible en horas). El data leakado (nombre + stock) no permite escritura ni escalación pero destruye la promesa de aislamiento multi-tenant.

**Fix propuesto**: agregar `AND tenant_id = $2` al SELECT de línea 286-292, con `sellerTenantId` como segundo param.

**Costo estimado**: 30 min (fix + test integración con dos tenants).

---

#### P1-5 — `redB2b/config.js` GET `/api/red-b2b/config` lookup de `metodos_pago` sin filtro tenant (defense-in-depth gap)

**File**: `backend/src/routes/redB2b/config.js:113-121`
**Categoría**: Defense-in-depth gap (no explota hoy)

El GET config lee `red_b2b_caja_default_id` del tenant y luego consulta `metodos_pago` bajo `adminQuery`:

```js
if (t.red_b2b_caja_default_id) {
  const cQ = await client.query(
    `SELECT id, nombre, moneda, activo
       FROM metodos_pago
       WHERE id = $1 AND deleted_at IS NULL`,
    [t.red_b2b_caja_default_id]
  );
  caja = cQ.rows[0] || null;
}
```

**No filtra `AND tenant_id = $2`**. Hoy no explota porque `red_b2b_caja_default_id` fue seteado por el propio tenant (validado en PATCH `/caja-default` línea 175-183) → apunta a una caja propia. Pero: si un futuro bug re-introduce la posibilidad de setear un default cross-tenant, este GET expondría metadata de la caja ajena (nombre, moneda) al owner del tenant.

Es el MISMO pattern que ya se cerró como P0 en `resolveCajaParaTenant` (línea 136-141) y `PATCH /caja-default` (línea 175-183) — el trio de fixes 2026-07-06 omitió este read path.

**Fix propuesto**: agregar `AND tenant_id = $2` al SELECT con `myTenantId`.

**Costo estimado**: 15 min.

---

#### P1-6 — `resolveUserTenant` sigue con `ORDER BY tenant_id ASC LIMIT 1` — bloquea multi-tenant per user

**File**: `backend/src/lib/userTenant.js:22-53`
**Categoría**: Deuda arquitectónica (documentada P2-2 en audit 07-12, aún abierta)

Ya identificado en audit 07-12 (Auth P2-2, marcado como "aceptable hoy"). Sigo abriéndolo como P1 en este ciclo porque:

1. **Super-admin invite flow ya crea users con múltiples tenant_users rows** (via `publicSuperAdminInvite.js` que vincula al `HOME_TENANT_ID=1` como member + su super-admin cross-tenant). Un super-admin invitado hoy resuelve siempre a tenant 1 en `/me`, aunque su rol REAL sea cross-tenant.
2. **El flow de auth (`login` y `refresh`) usa `resolveUserTenant` como fuente única de tenant_id embebido en JWT**. Si el user tiene 2 tenant_users rows, el JWT queda anclado al tenant menor ID por siempre — no hay manera de "cambiar de tenant activo".
3. **El chat bot (F3 Rec proactiva #3) usa el JWT para scoping** — un super-admin invitado que quiere consultar métricas del tenant 42 desde el bot no puede, porque su JWT dice tenant_id=1.

Este es un blocker latente para el feature "user pertenece a N tenants" que se identificó pero no priorizó. Con la nueva Red B2B (donde un user puede terminar necesitando ver ambos lados de un partnership), la superficie crece.

**Fix propuesto** (parcialmente aceptable como deferred):
- Corto plazo (2h): loggear WARN cuando `resolveUserTenant` matchea >1 row para un user (visibility sobre la ambigüedad silenciosa).
- Largo plazo (1 semana): implementar `X-Active-Tenant-Id` header + validación en `requireAuth`. El JWT embebe la LISTA de tenants del user, el header selecciona el activo. Requiere refactor de `capabilities.js`, `withTenant`, y frontend.

**Costo estimado**: corto plazo 2h; largo plazo 1 semana.

---

### P2 — Higiene

#### P2-1 — Chequeo 4 de `assertRlsCoverage` es warning-only por follow-up pendiente PR #874

**File**: `backend/src/lib/rlsCanonical.js:302-373`
**Categoría**: Warning-only por hotfix P0 07-25 (excluir del scope explícito)

**Ya documentado en el prompt** — el chequeo 4 (CONTENT del predicate NULLIF) es warning-only hasta que se ejecute el script SQL manual con superuser para `ALTER TABLE OWNER TO ipro_app` en 7 tablas y se re-run la migration de backfill. Este audit lo confirma como pendiente, sin re-analizarlo (fuera de scope). Sentry alert está configurado — visibilidad OK.

---

#### P2-2 — `authenticatedLimiter` counts de tokens que no pasan validación semántica

**File**: `backend/src/app.js:308-332`, `backend/src/lib/jwtVerify.js`
**Categoría**: Rate limiting granularidad

`validateAndGetJwtUserId` valida la firma HS256 y el shape básico del token. NO chequea `password_changed_at` vs `iat_ms` (eso lo hace `requireAuth` después). Un JWT válido criptográficamente pero YA invalidado por bump de password (post-logout, post-change-password) cuenta contra los 1000/15min del user antes de ser rechazado por `requireAuth`.

**Impacto**: minor — un atacante con JWT robado post-logout puede quemar el cuota del user legítimo sin haber logrado nada. El user legítimo, al re-loguear, entra en 429 hasta que expire la ventana.

**Fix propuesto**: en `validateAndGetJwtUserId`, agregar check contra `userAuthCache.getUserAuth` (mismo pattern que requireAuth). Cost adicional: 1 lookup Redis por request (cacheado 60s). Aceptable en el hot path.

**Costo estimado**: 1h + verificación de que no rompe tests.

---

#### P2-3 — `signupLimiter` sigue con IPv6 /64 rotation bypass (documentado en 07-12 P2-1)

**File**: `backend/src/middleware/signupLimiter.js`
**Categoría**: Ya documentado, sin cambios en 07-25.

Aceptable hoy — hCaptcha invisible cubre el vector real. Reactivar solo si spike de signups sospechosos.

---

#### P2-4 — Naming inconsistente `req.tenantRol` vs `req.user.tenant_cap_rol`

**File**: `backend/src/middleware/{adminOnly,requireCapability}.js`, `backend/src/middleware/auth.js:139`
**Categoría**: Naming legacy vs nuevo

`adminOnly` usa `req.tenantRol` (rol legacy owner/admin/member del tenant_users). `requireCapability` usa `req.user.tenant_cap_rol` (rol nuevo owner/admin/vendedor/encargado/lectura/custom). Los dos coexisten y confunden — un dev que agregue un middleware nuevo puede usar el "equivocado" y crear un gate débil o inconsistente.

**Fix propuesto**: sunset del legacy `req.tenantRol` post cutover completo F4. Documentar en `adminOnly.js` que es legacy y agregar TODO con criterio de retiro.

**Costo estimado**: 30 min (comment + TODO). El sunset real requiere refactorear `adminOnly` para usar `tenant_cap_rol`.

---

#### P2-5 — Test parametrizable de RLS coverage vs schema real

**File**: `backend/tests/rlsCanonical.test.js`, `backend/tests/nosuperuser-pool-real.test.js`
**Categoría**: Test hygiene

Los tests de RLS coverage existen y verifican `assertRlsCoverage` en happy path + falla. Pero no hay un test parametrizable que cubra el conjunto de tablas mencionadas en Sentry #16 (7 tablas con owner mismatch) — se agregarán post-fix del follow-up.

**Fix propuesto**: template de test parametrizado que corre `assertRlsCoverage` + verificación por tabla contra un fixture de policies esperadas. Deferrable hasta que se cierre el follow-up #874.

**Costo estimado**: 2h. Deferrable.

---

### P3 — Opcional

#### P3-1 — Comentarios estilo TODO en tests sin issues linkeados

Varios TODOs en `crossTenantOps.js` y `crossTenantPagos.js` mencionan "F5+ podría agregar linked_tenant_id" o "PR follow-up: renombrar columna". Sin issue linkeado se pierden. Convertir a comments con formato explícito `// TODO(issue #NNN)`.

**Costo estimado**: batch de 1h.

---

#### P3-2 — `capabilities.js` `resolveCaps` clona defaults en cada call

Ya documentado en audit 07-12 como P2-8. Sin cambio.

---

## Cross-track hooks

- **Financiero**: P0-2 (cambio_entidades cross-tenant FK) impacta reportes de Cambios de Divisa en tenants Red B2B que hacen pagos con diff cambiaria. Auditor Financiero debería verificar si hay tenants en prod hoy con `cambio_movimientos.entidad_id` que apunte a `cambio_entidades.tenant_id ≠ movimiento.tenant_id` (query cross-tenant integrity).
- **Externa**: P1-1 (refresh sin rate limit) cruza con superficie externa — un atacante que roba cookie mediante subdominio comprometido o supply chain attack tiene 30d de exposición. Coordinar con audit Externa para revisar SameSite/CORP headers del refresh cookie.
- **Plataforma**: P1-4 (info leak de productos en `stock_insufficient`) sugiere revisar TODOS los mensajes de error de `crossTenantOps` y `crossTenantPagos` — puede haber más leaks similares en paths de error.

## Métricas del track

- **Findings totales**: 12 (2 P0 + 6 P1 + 5 P2 + 2 P3)
- **Nuevos vs audit 07-12**: **7 nuevos** (2 P0-1/2, 4 P1-1/3/4/5, 1 P3-1). El resto son P2-P3 con status "aceptable/documentado".
- **Regresiones detectadas**: **1 crítica** (P0-2 `cambio_entidades` es la 3ra víctima del bug ensure* sin tenant filter; fix parcial 07-11 omitió este callsite). **1 nueva superficie** (P0-1 `upsertLinkedContacto`; nunca fue auditado antes).
- **Archivos revisados**: 28 core (middleware + routes core + lib crítico) + 6 tests de referencia.
- **Files con hallazgos activos**: 5 (`routes/redB2b/partnerships.js`, `lib/crossTenantPagos.js`, `lib/crossTenantOps.js`, `routes/redB2b/config.js`, `routes/signup.js`).
- **Buenas prácticas verificadas**:
  - `assertRlsCoverage` con 4 chequeos (3 fatal + 1 warning-only con Sentry alert por follow-up #874) — sólido.
  - `refreshTokens.verifyAndRotate` con attack detection (revoca family en reuso de refresh revocado) — bien diseñado.
  - Anti-regression check `backend-anti-regression-check.mjs` con 3 patterns (SET_LOCAL_INTERPOLATION, EVAL_USAGE, RAW_STRING_CAST) + baseline versionado — modelo a expandir a más patterns (ver Cross-track hooks).
  - Migración `set_config` bind param en 29 sitios legacy (PR #866) + pattern canónico documentado — SET LOCAL interpolation con `${req.tenantId}` allowlist bien justificado (guard middleware).
  - Cross-instance session invalidation via `password_changed_at` bump + `userAuthCache.invalidateUserAuth` — funciona para tokens robados post-change-password / logout / revoke super-admin.
  - Rate limiters dedicados en 8 endpoints críticos + Postgres store cross-instance — cerca del ideal (falta refresh, ver P1-1).

**Postura del track post-audit**: sistema **sólido con 2 P0 nuevos que cerrar de inmediato** (mismo pattern conocido y ya cerrado 2 veces — regression pattern). El refresh token pattern es nuevo (2026-07-21) y tiene 1 gap de rate limiting que puede cerrarse en 1h. El resto es hygiene incremental.

**Recomendación de closure**: Sprint 1 (~1 día) para los 2 P0 + P1-1/2 (refresh limiter, signup inconsistency) + P1-4/5 (info leak, defense-in-depth). Los P1-3, P1-6 y P2s pueden ir a Sprint 2 o Sprint follow-up. Total P0+P1 estimado: **~5h**.
