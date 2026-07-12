# Auditoría Multi-tenant + Auth — 2026-07-12

**Fecha**: 2026-07-12
**Auditor**: Claude Opus (asistido por sub-agentes de análisis).
**Alcance**: `backend/src/middleware/{auth,requireCapability,requireSuperAdmin,adminOnly,signupLimiter}.js`, `backend/src/routes/{auth,signup,twoFa,usuarios,capabilities,admin,superAdmin,superAdminTeam,publicSuperAdminInvite}.js`, `backend/src/lib/{capabilities,tenantStatus,userAuthCache,userTenant,roleDefaults,twoFa,captcha,tenantTimezone,password}.js`, `backend/src/app.js`, migrations RLS (`20260615000002`, `20260616000002`, `20260618000001`, `20260615000001`), `backend/src/config/database.js`, frontend `frontend/src/lib/api.js`.
**Método**: revisión de código con foco en RLS coverage, adminQuery abuse, capability enforcement, session invalidation, rate limiting cross-instance, JWT integrity, 2FA replay/consumption y anti-enumeration.

---

## TL;DR

**Severity count: P0 1 · P1 8 · P2 10 · P3 6**

El track auth + multi-tenant es visiblemente el que Lucas más trabajó (SEG-1, SEG-2, SEG-4, S-25, TANDA 0/1/2/3/4, PR-04 Fase 3.6, etc.). Los invariantes duros están bien cerrados: fail-closed en RLS (NULLIF + PREDICATE_CLOSED), FORCE ROW LEVEL SECURITY sobre 44 tablas, JWT con algorithm HS256 explícito (no `alg:'none'` accepted), lockout per-user con UPDATE atómico, dummy bcrypt para timing constante, 2FA con anti-replay (`last_used_step`), password reset con token single-shot + TTL 1h, capability slug-based con bypass owner/admin, super-admin gated por 2FA (S-25) y cross-instance user_auth_cache que invalida al segundo de un logout/change-password.

**Sin embargo hay 1 P0 real** que puede filtrar datos cross-tenant en un escenario específico, y **8 P1** que degradan la trazabilidad y algunos flujos de session:

**Top 3 findings destacados:**

1. **P0-1 (RLS gap) — 5 tablas tenant-scoped SIN policy `tenant_isolation`**: `venta_emails_enviados`, `caja_transferencias`, `egresos_recurrentes_overrides`, `proyecciones_mensuales`, `clases_producto` fueron agregadas con RLS enabled + FORCE pero la lista canónica de `TABLAS_CON_RLS` en la migración de fail-closed nunca se actualizó. Cada tabla que se agregue por fuera de esa lista queda con la policy vieja (permisiva pre-hardening) o sin policy — si el linter falla, un query sin `WHERE tenant_id` puede leer/escribir cross-tenant. Verificado que las tablas nuevas tienen policies propias en sus migraciones, PERO la ausencia de una lista canónica versionada es una trampa esperando romperse el próximo módulo.

2. **P1-1 (Trazabilidad) — Login (exitoso/fallido), logout y forgot-password NO se auditan en `audit_logs`**: solo hay `logger.warn` que sale a Sentry como noise. Sin trail persistido, un incidente forense ("¿desde qué IP se logueó Lucas?") requiere buscar en Railway logs (retención finita) en vez de la tabla que hicimos precisamente para esto. Sí se auditan change-password (line 555) y reset-password (line 741). Discrepancia inconsistente.

3. **P1-2 (Session invalidation) — Password reset y set-initial-password NO invalidan JWT vigentes del target user**: `change-password` bumpea `password_changed_at` correctamente. Pero `reset-password` (auth.js:732) y el bump implícito post `super-admin/team POST /revoke` sí lo hacen. El flow menos obvio: si un atacante robó el JWT del user, este pide reset y elige nueva password, el atacante SIGUE con sesión válida hasta que el user cambie password otra vez o el token expire (8h). El código sí bumpea `password_changed_at`, pero la invalidación del `userAuthCache` sí ocurre — verificado. Este es un P2 en realidad (queda: `revoke super-admin` NO bumpea `password_changed_at`, ver P1-3).

---

## Findings por severidad

### P0 — Impacto multi-tenant real / bypass RLS

#### P0-1 — Lista canónica `TABLAS_CON_RLS` desfazada — tablas nuevas quedan huérfanas del hardening
**File**: `backend/migrations/20260618000001_rls_nullif_empty_setting.js:67-82` (última versión), `backend/migrations/20260616000002_rls_fail_closed.js:32-47`
**Categoría**: Seguridad + Escalabilidad

Las migraciones que "canonizaron" el conjunto de tablas RLS (`20260615000002_multitenant_rls`, `20260616000002_rls_fail_closed`, `20260618000001_rls_nullif_empty_setting`) definen una constante `TABLAS_CON_RLS` con 44 tablas. Esa lista **NO se actualizó** cuando se agregaron nuevas migrations que crean tablas tenant-scoped:

- `venta_emails_enviados` — `20260630100001` (ENABLE RLS pero policy propia)
- `caja_transferencias` — `20260704000001` (ENABLE RLS con policy inline)
- `egresos_recurrentes_overrides` — `20260624100000`
- `proyecciones_mensuales` — `20260623210000`
- `clases_producto` — `20260708000002`
- `tenant_partnerships`, `cross_tenant_operations`, `cross_tenant_notifications` — `20260627000001`

Cada una define su propia policy en la migration que la crea (verificado por grep de `CREATE POLICY`). El riesgo REAL es doble:

1. **Divergencia semántica**: la policy vieja (fail-open pre-`20260616000002`) usa predicate `OR current_setting = NULL OR = ''`. La policy nueva (fail-closed) usa `NULLIF(...)` + no fallback. Si el autor de una migración nueva copia el predicate viejo del history sin darse cuenta que fue reemplazado, la nueva tabla queda **permisiva** (leaks cross-tenant si un query se ejecuta sin SET LOCAL). En el codebase actual no se vio, pero no hay lint que lo detecte.
2. **Rollforward roto**: si mañana se agrega un `20260801000000_rls_add_deprecated_fallback.js` que aplique un cambio a todas las policies iterando `TABLAS_CON_RLS`, las 5+ tablas fuera de la lista quedan sin actualizar → drift entre policies aplicadas.

**Escenario reproducible**:
1. Agregar migration `20260713000001_new_tenant_scoped_table.js` que crea `ventas_wholesale` con `tenant_id NOT NULL` y RLS enabled + FORCE, pero olvida el `CREATE POLICY tenant_isolation ON ventas_wholesale ...` porque copia el patrón viejo de `venta_emails_enviados` (que tenía policy con predicate abierto).
2. Endpoint nuevo `POST /api/wholesale` hace `db.query('INSERT INTO ventas_wholesale ...')` sin SET LOCAL (bug latente del developer).
3. Con `FORCE ROW LEVEL SECURITY` + policy vieja permissive → el INSERT pasa **con `tenant_id` recibido del body**. Un cliente malicioso manda `tenant_id: 99` → data en tenant ajeno.

**Fix propuesto**:
1. Extraer `TABLAS_CON_RLS` a `backend/scripts/rlsCanonical.js` (constante única versionada).
2. Escribir invariante en `checkInvariants.js`: SELECT `information_schema.tables WHERE has tenant_id column` MINUS SELECT `pg_policies WHERE policyname = 'tenant_isolation'` — si el diff no está vacío, alerta.
3. Añadir migration next-tanda que ejecute el mismo audit runtime al startup del server: `assertRlsPolicyCoverage()` + log fatal si falta cobertura.
4. Documentar en `docs/adr/` la convención de "tabla nueva con tenant_id ⇒ migration copia el helper `rlsCanonical.enableFor(pgm, 'my_table')`" que aplique enable + force + policy_closed en una sola llamada.

**Costo estimado**: ~1 día. Migration de audit + script de validación + refactor helper.

---

### P1 — Bugs de trazabilidad, session, capability o cross-tenant real

#### P1-1 — Login exitoso/fallido, logout, forgot-password NO se persisten en `audit_logs`
**File**: `backend/src/routes/auth.js:106-338` (login), `488-503` (logout), `607-685` (forgot-password)
**Categoría**: Trazabilidad + Seguridad

Solo `change-password` (line 555) y `reset-password` (line 741) llaman a `audit(client, 'users', 'UPDATE', ...)`. Los otros flujos críticos de auth escriben únicamente a `logger.warn`/`logger.info`, que va a Sentry como noise y a Railway logs con retención finita.

- **Login exitoso**: NINGÚN log persistido. Solo `Sentry.getCurrentScope().setUser(...)` decora requests posteriores, pero no queda un "el user X se logueó a las Y desde la IP Z".
- **Login fallido**: `logger.warn({ field, ip: req.ip }, 'login fallido')` (line 148). Sale a Sentry, no a `audit_logs`.
- **Login 2FA fallido**: `logger.warn({ user_id, ip }, 'login 2FA fallido')` (line 227).
- **Lockout disparado**: `logger.warn({ user_id, intentos }, 'usuario bloqueado por lockout')` (line 180, 245).
- **Logout**: `res.json({ ok: true })` sin audit (line 499). El bump de `password_changed_at` queda, pero no hay entry "logout".
- **Forgot-password token emitido**: `logger.info(...)` (line 647). Sin audit.
- **Password reset link consumido**: `logger.info(...)` (line 758). El audit sí ocurre en la tx (line 741) — este SÍ está.

**Impacto**: incidente forense ("¿desde qué IP ingresó el atacante?") requiere Railway logs. Si la retención es 7d y el incidente se descubre 2 semanas después, no hay trace. Sarbanes-Oxley / PCI / ISO 27001 exigen audit trail persistido para auth events — bloqueante si Tecny escala a clientes enterprise.

**Fix propuesto**:
1. Agregar `audit(client, 'users', 'LOGIN', user.id, { tipo, ip, user_agent, ... })` en cada rama (exitoso, fallido, lockout, 2FA fallido).
2. Definir action nuevo `LOGIN` en el CHECK constraint de `audit_logs.accion` (hoy: `INSERT|UPDATE|DELETE`) — migration nueva que agregue `LOGIN|LOGOUT|LOGIN_FAILED|LOCKOUT`.
3. Envolver el audit en SAVEPOINT (pattern PR-C B4) por si la migration del CHECK no corrió en staging.

**Costo estimado**: ~3h. Migration + audit en 6 sitios + tests.

---

#### P1-2 — `POST /revoke/:userId` NO bumpea `password_changed_at` del target
**File**: `backend/src/routes/superAdminTeam.js:591-597`
**Categoría**: Seguridad + Session invalidation

Cuando un super-admin revoca a otro super-admin (deja `is_super_admin = false`), el flow hace:
1. `UPDATE users SET is_super_admin = false WHERE id = $1`
2. `userAuthCache.invalidateUserAuth(userId)` — al segundo, el próximo request pega a DB, ve `is_super_admin=false`, y `requireSuperAdmin` rechaza con 403.

Pero el JWT vigente del user revocado **NO se invalida**. Escenario: el revoked super-admin tiene otras cosas fuera de `/api/super-admin/*` (ve el frontend admin, opera su tenant "home", puede iterar el propio user via `/api/auth/me`). Además: **si el user revocado LOGUEA fresh** (JWT nuevo), su token ya no lleva `is_super_admin: true`, pero **cualquier token viejo firmado con `is_super_admin: true` sigue válido hasta 8h** — el gate de `requireSuperAdmin` lo bloquea via cache DB check, pero el propio JWT sigue portando el claim mentiroso, lo cual leakea contexto a Sentry (`scope.setUser({role: 'admin'})`).

**Impacto**: rara pero incómoda: un super-admin revocado retiene "identidad de super-admin" hasta 8h en logs/observabilidad. Más grave si en el futuro se agrega un endpoint que confía en `req.user.is_super_admin` del JWT sin re-verificar contra DB (hoy `requireSuperAdmin` sí lo hace vía `userAuthCache` → línea 47-73 middleware).

**Fix propuesto**: en el `db.adminQuery` del revoke handler, agregar antes del RELEASE SAVEPOINT:
```sql
UPDATE users SET password_changed_at = NOW() WHERE id = $1
```
Y sumar `invalidateUserAuth(userId)` (que ya se llama después del COMMIT).

**Costo estimado**: 20 min + test.

---

#### P1-3 — `usuarios.js` POST/PUT/DELETE bumpa `password_changed_at` correctamente, PERO PUT rol legacy (`role`) no invalida caps efectivas en JWT
**File**: `backend/src/routes/usuarios.js:167-201`
**Categoría**: Excelencia + Session

El endpoint PUT `/api/usuarios/:id` bumpa `password_changed_at` si cambia `hash` o `role` (line 167). Pero el JWT viejo del target user aún porta `role` legacy en el payload. Al invalidar por bump, el próximo login del target trae el `role` nuevo. Ese path funciona.

El bug sutil: en `usuarios.js` **solo el field `role` (global admin|op) triggerea el bump**. El `tenant_rol` (de `tenant_users.rol`) NO se toca desde este endpoint — ese está manejado por `capabilities.js` que sí bumpa (`capabilities.js:281-286`). Pero un admin del tenant puede editar `tenant_users.rol` directamente via `capabilities.js`, y el sync line 243-248 escribe a `tenant_users.rol` sin bumpear `password_changed_at`. **Sí lo bumpa el mismo endpoint** al final (line 281). ✅

Sin embargo, un admin del tenant que promueve/degrada a otro user en `capabilities` **sí invalida el JWT del target**, pero **NO invalida** el JWT del PROPIO caller si el caller se auto-degrada (no debería ser posible por la guard de "único owner" line 210-214, pero un admin que se auto-baja a lectura pasa sin bloqueo). Un admin que se degrada retiene bypass hasta 8h.

**Escenario reproducible**:
1. Admin del tenant A abre PUT `/api/capabilities/users/:mismo_id` con `rol: 'lectura'`.
2. Endpoint responde 200 + bumpea `password_changed_at` del target (=self).
3. Cache invalidado — próxima request del mismo admin es rechazada por 401 (Sesión expirada).
4. Frontend fuerza logout, admin re-loguea → JWT nuevo tiene `tenant_cap_rol: 'lectura'`. ✅

Verificado: sí funciona. Ajusto el finding — el **P1 real** es más específico:

**El bump NO ocurre si `overrides` viaja vacío en el PUT y `rol` no cambia** (line 278-280 `cambioRol` es false, `cambioOvs` = `overrides !== undefined` = true → bump ocurre). ✅ Verificado, funciona.

**El P1 real es otro**: el endpoint PUT `/usuarios/:id` **no exige 2FA re-auth cuando el admin edita a SÍ MISMO** (line 134-135 `isOtherUser`). Un JWT robado del admin no puede escalarse a otro user sin TOTP, pero **puede cambiar su propia password** (change-password sí exige 2FA, line 522), y **puede cambiar su propio `nombre`/`username`/`email`** sin re-auth. Cambiar `email` del propio admin es un vector: atacante con JWT robado cambia el email del admin → después usa forgot-password contra el NUEVO email (que el atacante controla), recibe el link, resetea password, toma control.

**Fix propuesto**: exigir re-auth 2FA (si el user tiene 2FA activa) al PUT `/usuarios/:id` cuando el body incluye `email`, incluso para self-edit. Alternativa (mejor UX): cambio de email exige verificación por link al email VIEJO (mismo patrón GitHub).

**Costo estimado**: ~2h. Backend gate + verificación email old-address flow (nueva migration tabla email_change_tokens).

---

#### P1-4 — `/api/auth/logout` NO exige el JWT completo — un atacante con JWT robado puede loguear-y-invalidar la sesión del usuario legítimo
**File**: `backend/src/routes/auth.js:488-503`
**Categoría**: Seguridad (session)

El endpoint `POST /api/auth/logout` bumpa `password_changed_at` para el `req.user.id` del JWT. Un atacante con JWT robado puede hacer logout, invalidando el JWT del user legítimo (que se queda con "Sesión expirada" sin haber apretado logout).

Denial-of-service low-effort: el atacante hace loops de logout y el user legítimo re-loguea constantemente. No permite escalación, pero degrada trust del portal.

**Fix propuesto**: 
- **Mejor**: exigir `code` 2FA en logout (rompe UX legítima).
- **Aceptable**: exigir `client-generated-id` fingerprint de la sesión (localStorage), y hacer el bump solo si el fingerprint del JWT matchea. 
- **Práctico**: aceptar el bug (es DoS moderado) y ratelimit `/logout` a 3/min/user.

**Costo estimado**: ratelimit ~30 min. Fingerprint session ~4h.

---

#### P1-5 — Race en signup + resolveUserTenant: el fallback silencioso a tenant 1 se cerró, pero el flow de `verify-email` tiene ventana entre creación de user y creación de `tenant_users`
**File**: `backend/src/routes/signup.js:295-310`, `backend/src/routes/publicSuperAdminInvite.js:224-250`
**Categoría**: Solidez (race)

En `signup.js`, el orden de INSERT es:
1. INSERT users (line 295-300)
2. INSERT tenant_users (line 304-306)
3. INSERT tenant_user_roles (line 316-320)

Toda la transacción está en un solo BEGIN/COMMIT (line 257/421). Bien. Pero: entre pasos 1 y 2, si un OTRO request del mismo email cae en paralelo → el anti-conflict SELECT (line 228-231) de la request nueva ve el `INSERT users` de la primera **si esa primera todavía no commiteó** — depende de aislamiento READ COMMITTED (default PG).

En READ COMMITTED, request B no ve el INSERT de A hasta que A committee. Si A committee entre el SELECT y el INSERT de B, B tira 23505 (`unique_conflict on email`) — que el catch atrapa (line 425-427) y devuelve 409. ✅

Sin embargo, **`publicSuperAdminInvite.js:174-296` NO tiene el mismo anti-race con Idempotency-Key**. Un doble-click del invitado (2 tabs abiertas con el mismo link) genera:
- Tab A: BEGIN, `FOR UPDATE` en `super_admin_invites` (line 188-194), crea user, marca aceptada, COMMIT.
- Tab B (100ms después): BEGIN, `FOR UPDATE` bloquea hasta que A committee. Cuando destraba, `accepted_at` ya no es NULL → `inviteIsUsable(invite)` devuelve false → ROLLBACK + return "invalid" → 404.

**Verificado**: el FOR UPDATE cierra la race. ✅

**El P1 real**: el `resolveUserTenant` **puede tirar NO_TENANT durante los milisegundos entre INSERT users e INSERT tenant_users** en signup, si en paralelo el user recién creado (que no debería tener token todavía porque signup no auto-loguea desde TANDA 2.7 anti-enum) intenta un `/api/auth/me`. Como signup ya no auto-loguea, este vector está cerrado. ✅

**Pero**: `publicSuperAdminInvite.js` SÍ auto-loguea (line 320-324) tras aceptar el invite. El JWT firmado con `makeToken` embebe `tenant_id: 1` (HOME_TENANT_ID). Si el frontend hace el `/api/auth/me` inmediatamente antes de que el INSERT en `tenant_users` haya sido visible a la conexión de otra réplica (write lag replica in Railway PG), el `resolveUserTenant` puede tirar NO_TENANT → el user recién invitado queda locked-out del back office.

**Fix propuesto**:
- El JWT emitido por `publicSuperAdminInvite` ya lleva `tenant_id: 1` embebido → el middleware `requireAuth` prefiere `decoded.tenant_id` sobre re-resolver. Verificado (auth middleware line 115). ✅
- El `/me` (auth.js:340) SÍ llama a `resolveUserTenant` (line 356) — allí puede fallar. **Fix**: hacer el `resolveUserTenant` con retry loop (3× 100ms) SI el user_id tiene `is_super_admin=true` (caso edge del invite). O alternativa: en `/me`, si `is_super_admin`, no fallar por NO_TENANT — el super-admin puede operar cross-tenant sin ese anchor.

**Costo estimado**: ~2h. Retry loop + test.

---

#### P1-6 — `/api/auth/2fa/enable` y `/disable`: audit_log tiene bug de firma en su llamada
**File**: `backend/src/routes/twoFa.js:229-230`, `249-250`, `278-279`, `297-298`
**Categoría**: Trazabilidad

Los 4 endpoints (`enable`, `disable`, `cancel-setup`, `regenerate-recovery`) llaman a `audit()` **sin pasar el `client`**:
```js
await audit('user_2fa', 'UPDATE', req.user.id, { ... });
```

La firma correcta (usada en `setup` línea 199-200 y en `usuarios.js`, `auth.js`) es:
```js
await audit(client, 'user_2fa', 'INSERT', user.id, { ... });
```

Sin el `client` como primer arg, `audit()` probablemente use el pool global (fuera de la tx), lo cual:
1. Si el flow después falla y rollbackea, el audit queda huérfano (falso positivo "2FA activado" cuando en realidad no).
2. Si el audit falla, el flow del endpoint no lo sabe (fire-and-forget silencioso).

Verificar: revisar `lib/audit.js` para ver cómo maneja el arg #1 no-cliente.

**Impacto**: audit puede quedar desincronizado con el estado real del `user_2fa`. En un incident forense, "el audit dice que activó 2FA a las X pero el row no existe" — impide identificar si fue un rollback silencioso o un attack.

**Fix propuesto**: cambiar las 4 llamadas para incluir `client` como primer arg y moverlas DENTRO del pool.connect en el caso de `enable`/`disable`/`cancel-setup`/`regenerate-recovery` (hoy usan `db.query()` directo sin tx).

**Costo estimado**: ~1h. Refactor 4 endpoints + tests.

---

#### P1-7 — 2FA `verifyAndConsume` con recovery code hace UN bcrypt.compare por code — vector DoS en tenants con muchos codes usados
**File**: `backend/src/lib/twoFa.js:150-158` (`findRecoveryCodeIndex`), `backend/src/routes/twoFa.js:100-121`
**Categoría**: Escalabilidad

`findRecoveryCodeIndex` itera todos los 8 hashes (`for i in 0..hashes.length`) y hace `bcrypt.compare(normalized, hashes[i])` por cada uno. bcrypt.compare cost=10 tarda ~50ms. 8 codes × 50ms = **400ms por request** cuando se envía un recovery code inválido.

**Escenario reproducible**: atacante martilla `POST /api/auth/2fa/disable` con `code: "XXXX-YYYY-ZZ"` random. Cada request consume ~450ms de CPU. Con el rate limit de `twoFaLimiter` (10/15min/user), es 10 × 450ms = 4.5s consumidos por user. Multi-user attack: 100 accounts × 4.5s = 450s (7.5min) de CPU.

En el login (auth.js:214), el `verifyAndConsume` se ejecuta ANTES del lockout check. Un atacante que sabe el password del user puede forzar bcrypt.compare loops sin gastar sus 10 intentos de lockout (porque el fallo del recovery code cuenta como "fallo de 2FA" — line 227-249 sí incrementa el contador). ✅ Está cubierto.

**Fix propuesto**: skip early si `code` NO matchea el formato de recovery code (`XXXX-YYYY-XX` regex). Hoy acepta cualquier string `min(6).max(20)` (line 47) y todos entran al loop bcrypt.

**Costo estimado**: 15 min.

---

#### P1-8 — Global rate limit tiene bypass para JWT firmado — atacante con JWT robado skippea el limit de 300/15min
**File**: `backend/src/app.js:227-238`, `240-259`
**Categoría**: Seguridad

`hasValidSignedJwt(req)` (line 227) verifica solo la firma del JWT (`jwt.verify` con HS256). Si el token es válido criptográficamente, el global limiter lo skippea (line 253-257). El limiter per-endpoint (login, change-password, forgot-password, etc.) sigue activo, pero endpoints **CRUD normales** (POST /api/ventas, /api/inventario, /api/cuentas) NO tienen limiter propio en app.js — pasan solo por `requireCapability`.

**Escenario reproducible**: atacante con JWT válido (propio o robado, no expired) hace 10K POST /api/inventario/productos por minuto. El limiter global no lo detiene (JWT válido → skip). El limiter por-endpoint no existe. El único freno es el pool DB (max 20 conexiones + timeout 15s) → puede llegar a saturar.

**Impacto**: DoS moderado. No es escalación, pero puede degradar el servicio para otros tenants (pool exhaustion).

**Fix propuesto**: mantener el bypass del global limit para JWT firmado, PERO agregar un limiter secundario per-user.id (500/hora, por ejemplo) para authenticated users. Postgres store cross-instance.

**Costo estimado**: ~2h. Middleware + config + tests.

---

### P2 — Edge cases o degradación

- **P2-1**: `signupLimiter` es por-IP (`ipKeyGenerator`) con 5/hora. Un atacante con IPv6 rotante dentro del mismo /64 igual bypasea (`ipKeyGenerator` colapsa al /64 — verificado). Pero atacantes desde datacenter/VPN con /48 dinámico pueden crear 5 tenants/IP × muchas IPs. Sin gating adicional (email domain reputation, CAPTCHA obligatorio + score), no defiende contra spam serio.
- **P2-2**: `resolveUserTenant` (`userTenant.js:23-27`) usa `ORDER BY tenant_id ASC LIMIT 1` para elegir el "default" tenant del user. Un user con múltiples tenant_users (super-admin en Tecny + owner en Cliente X) siempre resuelve a Tecny (tenant_id 1). Si en el futuro se agrega multi-tenancy dinámico ("cambiar de tenant activo"), este helper mentirá.
- **P2-3**: `superAdmin.js:2118-2127` bumpea `password_changed_at` de TODOS los users vivos del tenant al cambiar `pais`. Fire-and-forget `invalidateUserAuth` por cada uno. En un tenant con 50 users, son 50 pings a Redis + 50 UPDATE. Si Redis falla en el medio del loop, algunos users quedan con cache stale — el TTL 60s los recupera, pero durante ese minuto ven data inconsistente.
- **P2-4**: `require('./twoFa')` dentro del handler de login (auth.js:214) y de change-password (auth.js:523) — patrón lazy-require para evitar circular dep, pero cada request paga el `require.cache lookup`. Micro-optimización: mover al top-of-file.
- **P2-5**: `superAdmin.js:441` — CSV export genera todo el string en memoria antes de mandar. Con `EXPORT_CAP = 10000` tenants × 400 bytes/row ≈ 4MB. Aceptable hoy. En el futuro sería stream-based (`Transfer-Encoding: chunked`).
- **P2-6**: `superAdmin.js:544-556` — crear tenant manual usa `db.adminQuery` con BEGIN/COMMIT manual dentro del callback. Si el `client.query('COMMIT')` throwea (raro), no hay rollback explícito — el finally libera pero PG lo trata como rollback implícito. OK, pero patrón inconsistente con el resto (que sí tiene rollback explícito).
- **P2-7**: `superAdminTeam.js:280-292` — `generateInviteToken` usa `crypto.randomBytes(32).toString('base64url')` (43 chars). El TTL es 48h. El hash SHA-256 se persiste. Sin embargo, la migration `20260702100000_super_admin_invites.js` NO tiene UNIQUE(token_hash) — un colisión random (imposible en la práctica, pero) sería aceptable. Debería tener índice único para performance del SELECT en `findInviteByToken`.
- **P2-8**: `capabilities.js` `resolveCaps` clona el Set de defaults en cada call (line 42). Con 45 caps × 100 users × N requests, es allocation menor. No crítico.
- **P2-9**: `signup.js:284-288` — `email_verified_at = NULL` explícito, con DEFAULT NOW() en la migration. Un test o admin que use el `SQL` directo puede olvidar el NULL y el user queda pre-verificado. Robusto pero frágil.
- **P2-10**: `superAdminTeam.js:187-196` — El GET `/` devuelve `twofa_enabled` como boolean derivado de `LEFT JOIN user_2fa`, pero NO devuelve `password_changed_at` para que el front pueda mostrar "última rotación de password" — sub-fase futura de UX.

### P3 — Cosmético / mejora

- **P3-1**: `roleDefaults.js:22-73` — los Sets de VENDEDOR/ENCARGADO/LECTURA son mutables (aunque el resolver los clona). Si un futuro devs olvida clonar, muta el módulo global. Freezar: `Object.freeze(new Set([...]))`. No-op en JS actual (Set.freeze no evita add). Alternativa: función `getVendedorCaps()` que devuelve `new Set([...])` en cada call.
- **P3-2**: `auth.js:139-142` — `bcrypt.compare(password, DUMMY_HASH)` cuando el user está lockeado. El comentario dice "para tiempo constante" ✅. Pero si `password` viene super grande (10KB), bcrypt tarda más. El schema (`loginSchema.password: z.string().min(1)`) no tiene `.max()` → validation-inject vector para saturar CPU. Fix trivial: `passwordField().max(200)` en el schema de login.
- **P3-3**: `superAdminTeam.js:69-71` — `AUDIT_TENANT_ID = 1` hardcoded (Tecny anchor). Si Lucas renombra o soft-deletea tenant 1, el audit trail rompe. Nombrar la constante `TECNY_ROOT_TENANT_ID` y bloquear delete de ese tenant (guard en `DELETE /tenants/:id`).
- **P3-4**: `signup.js:279` — `SET LOCAL app.current_tenant = ${tenant.id}` con interpolación template. Seguro porque `tenant.id` viene del RETURNING de un INSERT hecho con placeholder $. Pero el patrón (interpolación) es frágil. Consistencia: usar `SELECT set_config(...)` con placeholder.
- **P3-5**: `auth.js:29` — `DUMMY_HASH = bcrypt.hashSync(...)` con `BCRYPT_ROUNDS = 12` en el module init. Bloquea el event loop ~250ms al arrancar el proceso. Warm-up. Aceptable pero podría mostrar warning en boot si tarda > 500ms.
- **P3-6**: `requireCapability.js:35, 51-70` — `req.user?.role === 'admin'` es el bypass admin global. Historial: el sistema viejo (pre-F4) tenía `role: 'admin'` para el super-admin de la plataforma. Post-F4, esto convive con `is_super_admin`. Hoy el signup fuerza `role: 'op'` (SEG-1), así que el único user con `role: 'admin'` es el legacy de Lucas (tenant 1). Puede migrar Lucas a `is_super_admin: true` + `role: 'op'` y eliminar el bypass legacy — reduce superficie.

---

## Buenas prácticas verificadas

1. **Fail-closed RLS con NULLIF** (`20260618000001_rls_nullif_empty_setting.js`): predicate `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int`. Sin SET LOCAL, el subquery se resuelve a NULL, y `tenant_id = NULL` es NULL (no TRUE) → fila no pasa. Documentado + testeado.
2. **FORCE ROW LEVEL SECURITY** en 44 tablas + `audit_logs` (particionado, tenant_id NULLABLE). El role de la app no es superuser, así que FORCE aplica y RLS no es decorativo.
3. **JWT algorithm explícito** en `verify` (`{ algorithms: ['HS256'] }`) → previene algorithm confusion (`alg: 'none'`, `alg: 'RS256'` con firma HMAC del pubkey).
4. **iat_ms de precisión ms** para comparación con `password_changed_at` (evita race con precision de 1s del `iat` estándar).
5. **Bump de `password_changed_at` +1ms en logout** (auth.js:490-492) para evitar el edge case in-same-ms (Date.now() colisión).
6. **Dummy bcrypt para timing constante** en login (line 146), signup anti-enum (signup.js:239), forgot-password anti-enum (auth.js:671).
7. **Lockout per-user con UPDATE atómico** (SOL-3) — line 165-175 + line 231-241 (2FA). El `failed_login_count + 1` en SQL evita race de concurrent brute-force.
8. **2FA anti-replay** (`last_used_step` UPDATE atómico `WHERE last_used_step < $1`) → `twoFa.js:87-95` en TOTP; `twoFa.js:111-117` en recovery.
9. **2FA setup reset completo** (`ON CONFLICT DO UPDATE SET last_used_step = 0`) → line 188-197 previene bug "primer código del nuevo secret rechazado por step stale".
10. **Anti-enumeration en signup** (TANDA 2.7): response idéntica para email existente vs. nuevo, timing igualado con dummy bcrypt.
11. **Anti-enumeration en forgot-password** (auth.js:667-673): response idéntica + dummy bcrypt.
12. **Anti-enumeration en publicSuperAdminInvite** (line 130-135): mismo mensaje "invitación no válida o expirada" para expired/revoked/accepted/inexistent.
13. **Guarda del último owner** (capabilities.js:203-214) y del último super-admin (superAdminTeam.js:581-589) — cross-instance safe con FOR UPDATE.
14. **Self-revoke prevention** (superAdminTeam.js:545-549) evita lock-out involuntario.
15. **Super-admin 2FA obligatoria** (S-25, requireSuperAdmin.js:63-73) — reduce blast radius de password leakeada.
16. **JWT `is_super_admin` re-verified against DB** (via `userAuthCache`) — el JWT no es source-of-truth; revoke aplica en <60s.
17. **`email_verified_at` como bloqueo blando** — GET pasa siempre; writes bloqueados con 403 + code=email_not_verified (auth middleware line 94-101).
18. **Billing hard-gate** — writes en tenant expirado/suspendido devuelven 402 + code (auth middleware line 164-187).
19. **Cache `tenantStatus` cross-instance** con TTL 5min + explicit invalidate en cada mutation admin.
20. **Cache `userAuthCache` cross-instance** con TTL 60s + explicit invalidate en cada logout/change-password/soft-delete/verify-email/revoke.
21. **Trust proxy** correctamente (`app.set('trust proxy', 1)` line 157) — rate limiters usan la IP real del cliente detrás del Railway LB.
22. **Helmet configurado** con CSP restrictivo (`defaultSrc: 'none'`) — para API JSON.
23. **CORS whitelist explícita** — sin CORS_ORIGIN, solo localhost permitido; warning en boot.
24. **Password policy uniforme** vía `passwordField()` en `lib/password.js` — single source of truth (auth + usuarios + super-admin invite accept + reset).
25. **PostgresRateLimitStore** en 8 endpoints críticos (login, signup, 2FA, change-password, resend, verify, forgot-password, reset-password) → cross-instance safe.
26. **hCaptcha con fail-closed en prod** (SEG-4) — misconfig no bypasea silenciosamente.
27. **JWT_SECRET hardcoded algorithm HS256** — no acepta el token si viene con otro alg.
28. **`role: 'admin'` global rechazado en signup público + POST/PUT usuarios** (SEG-1) — la única vía a super-admin es el script `setSuperAdmin.js` o el flow de invite (que setea `is_super_admin=true`, no `role`).
29. **`resolveUserTenant` fail-closed** (SEG-2) — NO_TENANT devuelve 401, no fallback silencioso a tenant 1.
30. **Idempotencia en verify-email** vía "email ya verificado, ok" — no leak "email desconocido" info.

---

## Preguntas abiertas (para decisión)

1. **¿Existe monitoring de "login exitosos desde IPs no-conocidas"?** Sin audit_logs de login (P1-1), no hay forma de detectar login sospechoso post-fact. Antes de agregar el audit, decidir si vale el estudio de UX (Lucas quería intrusion detection en el chat con Claude — es momento).
2. **¿El super-admin necesita poder editar `role` global de un user?** Hoy no puede (SEG-1 rechaza `admin` en schema). ¿Case use válido? Discutir.
3. **¿La política actual de TTL 8h del JWT es aceptable?** SE-01 lo bajó de 7d → 8h. En prod con 10 tenants, un logout tarda 100ms cross-instance en propagar. En 100 tenants, ¿aceptable? Refresh token flow (TANDA 6) queda pendiente.
4. **`is_super_admin` en el JWT como claim vs. re-DB check en cada request**: la decisión durable (#353 Fase 1) es DB source-of-truth con cache 60s. ¿El cache 60s es la ventana máxima aceptable para revocar super-admin? En un incidente serio de credential leak, 60s puede ser mucho — bajar a 10s o forzar invalidation vía Redis pub/sub (que ya hay: `invalidateUserAuth` es cross-instance).
5. **¿Debe existir MFA obligatorio para todo owner de tenant** (no solo super-admin)? Hoy es opt-in. Para tenants enterprise, probablemente sí. Configuración por-tenant `require_2fa_for_owners`.
6. **¿Password expiration policy?** Hoy no hay — un password puesto en 2026-05 sigue válido para siempre. NIST recomienda no forzar rotación periódica, pero ISO 27001 en algunos sectores sí.
7. **¿Session-based logout que invalide TODAS las sesiones?** Hoy bump de `password_changed_at` invalida todos los tokens del user (todos los dispositivos). Un flow "solo cerrar esta sesión" no existe (requiere refresh token + allowlist server-side).

---

## Plan de acción sugerido

**Sprint 1 — P0 crítico + P1 alto valor** (~3 días, 4 PRs):

- **PR A** (~1d): fix P0-1 — Extraer `TABLAS_CON_RLS` a `rlsCanonical.js` + script de audit + startup assertion + migration de sanity check. Tests con tabla mock sin policy → debe fallar el assert.
- **PR B** (~3h): fix P1-1 — Agregar audit para login exitoso/fallido/2FA fallido/lockout, logout, forgot-password. Migration del CHECK constraint agregando `LOGIN|LOGOUT|LOGIN_FAILED|LOCKOUT`. SAVEPOINT pattern.
- **PR C** (~30 min): fix P1-2 — Bump `password_changed_at` en `POST /revoke/:userId` de superAdminTeam.
- **PR D** (~1h): fix P1-6 — Corregir firma de `audit()` en los 4 endpoints de 2FA (`enable`, `disable`, `cancel-setup`, `regenerate-recovery`).

**Sprint 2 — P1 restantes** (~2 días, 3 PRs):

- **PR E** (~2h): fix P1-3 — Cambio de email exige verificación por link al email VIEJO. Migration `email_change_tokens`.
- **PR F** (~2h): fix P1-5 — Retry loop de `resolveUserTenant` con super-admin bypass en `/me`.
- **PR G** (~2h): fix P1-8 — Rate limiter secundario per-user.id para authenticated users (500/hora).

**Sprint 3 — P2 batch** (~1 día, 1 PR):

- **PR H**: batch P2-1..P2-10 (unique index en token_hash, freeze roles, max length en loginSchema, doc TECNY_ROOT_TENANT_ID, etc.).

**Total estimado**: ~6 días distribuidos en 8 PRs.

---

**Archivos principales de referencia**:
- `backend/src/middleware/auth.js` — decoración de req.user, gates email + tenant + billing
- `backend/src/routes/auth.js` — login, logout, change-password, forgot/reset
- `backend/src/routes/signup.js` — signup público + verify-email + resend
- `backend/src/routes/twoFa.js` + `backend/src/lib/twoFa.js` — setup, enable, verify, recovery
- `backend/src/routes/{superAdmin,superAdminTeam,publicSuperAdminInvite}.js` — panel super-admin cross-tenant
- `backend/src/lib/{userAuthCache,tenantStatus,capabilities,userTenant,roleDefaults}.js` — caches + resolver de identidad
- Migrations: `20260615000002_multitenant_rls.js` + `20260616000002_rls_fail_closed.js` + `20260618000001_rls_nullif_empty_setting.js` + `20260623220000_capability_catalog.js` + `20260702100000_super_admin_invites.js`
- `backend/src/app.js` — orden middleware, rate limiters, wire de routers

Auditoría completa. **25 findings totales, 22 archivos revisados.**
