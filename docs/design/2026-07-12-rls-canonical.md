# Design — RLS canónico + startup assertion

**Fecha**: 2026-07-12
**Origen**: auditoría TOTAL Auth P0-1 (`docs/audit/2026-07-12-audit-auth.md#p0-1`)
**Estado**: implementado en PR C del sprint 1 del audit
**Ver también**: `backend/src/lib/rlsCanonical.js`

---

## Contexto

El portal Tecny usa PostgreSQL con FORCE ROW LEVEL SECURITY sobre ~55 tablas tenant-scoped. La convención es que cada tabla con column `tenant_id` tiene:

1. RLS enabled + FORCE
2. Policy `tenant_isolation` con predicate `tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int` (fail-closed)

Los flows usan `db.withTenant(tenantId, ...)` que hace `SET LOCAL app.current_tenant = ...`. Cross-tenant reads solo permitidos via `db.adminQuery` (BYPASSRLS con role `tecny_admin`).

## Problema (pre-2026-07-12)

Antes de este design, la lista de tablas con RLS vivía **dentro** de una migration (`20260618000001_rls_nullif_empty_setting.js`, constante `TABLAS_CON_RLS`). Esa lista NO se actualizaba cuando se agregaban tablas nuevas — cada migration nueva definía su propia policy inline.

**Resultado:** la auditoría detectó 2 problemas de gobernanza:

1. **Divergencia semántica**: 2 migrations posteriores usaron nombres custom para su policy (no `tenant_isolation`):
   - `caja_transferencias_tenant_isolation` (migration 2026-07-04)
   - `venta_emails_tenant_isolation` (migration 2026-06-30)

   Si una migration futura iteraba `pg_policies WHERE policyname = 'tenant_isolation'` para aplicar un cambio masivo (ej. rotar el predicate), estas 2 tablas quedaban olvidadas.

2. **Rollforward roto**: 5+ tablas agregadas post-canónica quedaban fuera de la lista canónica original. Cualquier auditoría o script de mantenimiento que iterara `TABLAS_CON_RLS` las omitía.

3. **Sin startup assertion**: no había fail-fast al boot si una nueva tabla con `tenant_id` se agregaba sin policy. Un desarrollador podía crear una tabla nueva "olvidando" la policy y el bug no se detectaba hasta que alguien lo auditara manualmente.

## Design

### 1. Módulo canónico `backend/src/lib/rlsCanonical.js`

Fuente única de verdad. Exporta:

- **`TABLAS_TENANT_SCOPED`** — array frozen con las tablas que DEBEN tener RLS enforced. Ordenado ASCII para diffs limpios.
- **`TABLAS_TENANT_ID_SIN_RLS`** — object frozen: whitelist de excepciones intencionales con razón explícita por tabla.
- **`PREDICATE_CLOSED`** — string del predicate canónico (fail-closed con NULLIF).
- **`PREDICATE_CLOSED_NULLABLE`** — variante para `audit_logs` (permite `tenant_id IS NULL` para audits de sistema).
- **`enableTenantRlsFor(pgm, tableName)`** — helper para migrations nuevas. En 1 call: `ALTER TABLE ENABLE + FORCE`, `CREATE POLICY tenant_isolation`.
- **`assertRlsCoverage(pool)`** — startup assertion. Compara el schema real (via `information_schema.columns` + `pg_policies`) contra el canónico + whitelist. Si detecta drift, throw con enumerado de tablas afectadas.

### 2. Whitelist actual — 3 excepciones documentadas

| Tabla | Razón |
|---|---|
| `audit_queue` | Cola de audits programáticos (jobs internos). Workers consumen con `adminQuery`/BYPASSRLS. Tenant_id se usa solo para agregación, no aislamiento. |
| `tenant_users` | Relación N:M user↔tenant. Se accede desde `/api/admin/*` y flows de super-admin cross-tenant. Aislamiento por capability `requireSuperAdmin`, no RLS. |
| `tenant_admin_actions` | Audit trail de acciones de super-admin cross-tenant (`plan_change`, `delete_tenant`). Super-admin necesita ver todas las filas. Aislamiento por capability, no RLS. |

Cualquier tabla nueva con `tenant_id` que NO deba tener RLS debe agregarse acá **con razón explícita**. Sin razón, no se acepta la PR.

### 3. Startup assertion en `server.js`

Antes de `app.listen()`, se llama `await assertRlsCoverage(db)`:

- **OK** → `logger.info('cobertura de RLS verificada — todas las tablas con tenant_id tienen policy canónica')` + arranca el server.
- **Drift** → `logger.fatal` con mensaje enumerando tablas afectadas → `process.exit(1)` → deploy Railway queda FAILED.

**Costo:** 2 queries a system catalogs (~10ms). Trivial vs. el impacto de un leak cross-tenant no detectado.

### 4. Migration de normalización

`20260712000001_rls_canonical_policy_names.js` renombra las 2 policies con nombres custom al canónico. Usa el helper `enableTenantRlsFor` para asegurar idempotencia.

## Convención para tablas nuevas

Cuando agregues una tabla con `tenant_id`:

1. **Agregar la tabla a `TABLAS_TENANT_SCOPED`** en `backend/src/lib/rlsCanonical.js` (respetando orden ASCII).
2. **En la migration**, usar `enableTenantRlsFor(pgm, 'mi_tabla')`:
   ```js
   const { enableTenantRlsFor } = require('../src/lib/rlsCanonical');

   exports.up = (pgm) => {
     pgm.sql(`CREATE TABLE mi_tabla (id SERIAL, tenant_id INT NOT NULL);`);
     enableTenantRlsFor(pgm, 'mi_tabla');
   };
   ```
3. **Si NO debe tener RLS**, agregarla a `TABLAS_TENANT_ID_SIN_RLS` con razón explícita (>20 chars, no trivial).
4. **Si olvidás alguno de los 2 pasos anteriores**, la assertion del boot fallará y el deploy no arrancará. Fail-fast por diseño.

## Trade-offs

- **Costo overhead:** 2 queries + iteración cada boot. Aceptable.
- **Fricción para devs:** tienen que actualizar 2 sitios cuando agregan tabla (canónica + migration). Documentado + explícito.
- **False positives:** una tabla `_test_orphan_tenant_table` en el schema local (accidental) haría fallar el boot. Ver test 3 de `rlsCanonical.test.js` — verificado que el error message es descriptivo.
- **Gap residual:** si alguien AGREGA una tabla a la whitelist sin discutirlo, el sistema NO lo detecta (whitelist es autoritative). Mitigación: test unitario que enumera las 3 whitelisteadas y falla si aparece una 4ta sin actualizar el test.

## Alternativas descartadas

1. **Trigger/event que loguee al crear tablas** — más complejo, requiere event triggers PostgreSQL. La assertion post-hoc es más simple y suficiente.
2. **Convención sin enforcement** (solo documentación) — no se mantiene con el tiempo. Precisamente el pattern que causó el problema original.
3. **Lint pre-commit** — no cubre migrations que ya están en `main`. La assertion runtime cubre todo.

## Testing

- **Unit tests** (`tests/rlsCanonical.test.js`, 10 tests):
  - Constantes frozen, sorted, sin duplicados
  - Whitelist con razones explícitas
  - Canónica ∩ whitelist = ∅
  - Predicate contiene NULLIF
  - `assertRlsCoverage` pasa en el schema actual
  - `assertRlsCoverage` detecta policy dropped
  - `assertRlsCoverage` detecta tabla huérfana

## Referencias

- Auditoría: `docs/audit/2026-07-12-audit-auth.md` P0-1
- Módulo: `backend/src/lib/rlsCanonical.js`
- Migration normalization: `backend/migrations/20260712000001_rls_canonical_policy_names.js`
- Startup assertion: `backend/server.js` (función `startServer`)
- Tests: `backend/tests/rlsCanonical.test.js`
