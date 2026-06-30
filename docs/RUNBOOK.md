<!-- Auditoría 2026-06-30 Q-04: rebrand iPro Tech/Celnyx/iPro Portal → Tecny -->
# Runbook — Tecny Portal

"Tengo X síntoma, ¿qué hago?" — guía operativa indexada por escenario.

Para procedimientos cotidianos (deploys, backups) ver [OPERATIONS.md](OPERATIONS.md).
Para cómo está montado el monitoring ver [OBSERVABILITY.md](OBSERVABILITY.md).
Para escenarios de pérdida/corrupción de datos ver [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).

---

## Acceso rápido a paneles

- **Railway** — https://railway.app/dashboard → proyecto iPro
- **Netlify** — https://app.netlify.com → site iPro
- **Sentry** — https://sentry.io/organizations/<org>/issues/
- **GitHub** — https://github.com/lnbruno93/iPro-Portal
- **Health en vivo** — https://tecny-backend-production.up.railway.app/health

---

## El portal está caído

### Síntoma: Los usuarios reportan "no abre"

1. Probar `/health` desde el browser/curl. Si responde 200 → problema es frontend o red del usuario.
2. Si responde 503 o no responde:
   - Railway → tecny-backend → **Deployments** → ver el último: ¿está "Building", "Failed", "Crashed"?
   - Si "Crashed": ver Logs, buscar el error reciente. Si está en loop, Railway lo reinicia automáticamente.
   - Si la causa es el último deploy: rollback (ver OPERATIONS.md §2).
3. Si `/health` responde 503 con `db.status: error`:
   - Postgres-AueP → ¿está corriendo? Si está caída, restart desde el dashboard de Railway.
   - Ver si hay alerta de Railway por consumo de plan / billing.

### Síntoma: Frontend abre pero "error de red" en cada acción

1. ¿El usuario está offline? El service worker debería mostrar página cacheada — si no, problema del SW.
2. CORS: si el navegador del usuario muestra "CORS error" en la consola, revisar `CORS_ORIGIN` en Railway envs — debe incluir el dominio Netlify del usuario.
3. Probar la API directo con curl: `curl -i https://tecny-backend-production.up.railway.app/health` — descarta backend down.

---

## Errores en Sentry

### Síntoma: Spike de errors después de un deploy

1. Sentry → filtrar por `build_commit: <commit-corto-del-deploy>`.
2. Si la mayoría son del mismo error: probable regresión.
3. Rollback el deploy en Railway (OPERATIONS.md §2) si el blast radius es alto.
4. Crear branch fix/ con el revert o el patch.

### Síntoma: Mismo error repitiéndose desde hace tiempo

1. Sentry → ordenar por "Events" desc → ver los top 10.
2. Si es "client error" con stack ilegible (minificado), correlacionar con `build_commit` para saber qué versión correr local.
3. Si el error está en un usuario específico (mismo user_id en multiple events), contactarlo para más contexto.

---

## Performance degradada

### Síntoma: Una pantalla tarda 5-10s en cargar

1. Network tab del browser → ¿qué endpoint es el lento?
2. Si es `/api/inventario` con miles de productos: verificar que el frontend usa paginación.
3. Si es `/api/dashboard/resumen-mensual`: ¿cuál período se está pidiendo? Si es muy viejo y no está cacheado, primera carga puede tardar 3-5s. Las siguientes deben ser <500ms.
4. Backend logs: buscar la latencia del request en pino logs (`responseTime` field).

### Síntoma: `/health` muestra db.pool.waiting > 0 sostenido

- Pool de DB agotado — alguien está reteniendo conexiones.
- Causas habituales: leak en una route que no llama `client.release()`.
- Buscar en logs `'connection acquired but not released'` o latencias DB altas.
- Restart del backend libera el pool inmediatamente (parche temporal).

### Síntoma: Memory RSS subiendo sostenido

- Memory leak — alguna caché in-memory no tiene tope.
- Revisar `lib/cacheTtl.js` y los caches LRU en `dashboard.js`.
- Restart del backend resetea (parche temporal).

---

## Datos raros / sospecha de corrupción

### Síntoma: "Mi caja muestra saldo que no cuadra"

1. **Forzar check de invariantes** (más rápido que SQL manual):
   ```bash
   curl -s -X GET "https://tecny-backend-production.up.railway.app/api/admin/invariants" \
        -H "Authorization: Bearer <admin-token>" | jq
   ```
   El campo `caja_saldo_negativo.violaciones` lista las cajas con saldo < 0.
2. Cross-check con SQL directo (Railway → Postgres-AueP → Query):
   ```sql
   SELECT mp.saldo_inicial + COALESCE(SUM(
            CASE WHEN cm.tipo = 'ingreso' THEN cm.monto ELSE -cm.monto END
          ), 0) AS saldo_calculado
     FROM metodos_pago mp
     LEFT JOIN caja_movimientos cm ON cm.caja_id = mp.id AND cm.deleted_at IS NULL
    WHERE mp.id = <caja_id>
    GROUP BY mp.id, mp.saldo_inicial;
   ```
3. Si difiere del saldo que muestra la UI: bug. Reportar a Sentry + buscar últimos movimientos.
4. El cron de invariantes corre cada 24h automático y reporta a Sentry si encuentra drift — ver `backend/src/lib/checkInvariants.js`.

### Síntoma: Movimiento de conciliación "fantasma"

- Ver `caja_movimientos.conciliado_en` y `conciliacion_id` — si conciliacion_id apunta a una conciliación borrada, hay drift.
- El DELETE de conciliación libera los movimientos (NULL en ambos campos). Si algo lo saltó, parchar manualmente:
  ```sql
  UPDATE caja_movimientos SET conciliado_en = NULL, conciliacion_id = NULL
   WHERE conciliacion_id NOT IN (SELECT id FROM conciliaciones WHERE deleted_at IS NULL);
  ```

---

## Autenticación / acceso

### Síntoma: Un usuario no puede loguearse

1. Auth → tabla `users` → buscar el username.
2. ¿`deleted_at` no es null? El user fue dado de baja. Restore: `UPDATE users SET deleted_at = NULL WHERE id = X;`.
3. ¿Tiene `locked_until` en el futuro? Lockout por intentos fallidos. Reset: `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = X;`.
4. Si pide reset de password: el flow está en `/auth/reset-password` (admin only).

### Síntoma: Un usuario activó 2FA y perdió el cel / no tiene recovery codes

El user debería usar uno de sus 8 recovery codes (los generó al activar 2FA).
Si NO los guardó y perdió el cel, hay que desactivar 2FA manualmente:

```sql
-- Verificar que tenga 2FA enabled
SELECT user_id, enabled_at FROM user_2fa WHERE user_id = X;

-- Desactivar (elimina la fila completa, libera el lock del login)
DELETE FROM user_2fa WHERE user_id = X;
```

Después contactar al user para que vuelva a hacer setup (ahora SÍ guardando
los recovery codes). El audit log queda con el evento DELETE.

> **Por qué requiere intervención manual:** el flow del frontend exige código
> TOTP o recovery para disable. Sin ninguno, el user no puede hacerlo solo.
> Documentado como decisión durable: confiamos en que un admin (vos) puede
> rescatar manualmente, no agregamos un "magic email link" porque ese mismo
> link sería un bypass de 2FA si el email se compromete.

### Síntoma: Login rate-limited masivo

- Está pasando algo: o un ataque de credential stuffing, o un script propio mal hecho.
- IP banneada via Cloudflare/proxy (no implementado todavía).
- Mitigation temporal: subir el límite en `app.js` loginLimiter, redeploy. Volver a bajar después.

---

## Email / Notificaciones (TANDA 2.2)

**Provider:** Resend (free tier: 100 emails/día, 3000/mes). Se activa cuando hay
`RESEND_API_KEY` en env vars del backend; sin esa key cae automáticamente a un
stub que loguea los emails a Pino (útil en dev/tests).

**Env vars requeridas en Railway (staging + prod):**
- `RESEND_API_KEY` — copiar de 1Password.
- `EMAIL_FROM` — string `Display Name <email@domain>`. Por defecto del code:
  `Tecny Portal <onboarding@resend.dev>` (sender no verificado, limitado a
  entregar al email del owner de Resend).
- `FRONTEND_URL` — URL del frontend para construir el link de verificación
  (`{FRONTEND_URL}/verify-email?token=...`).

**Verificar un dominio en Resend** (necesario para signup público a usuarios
externos — sin dominio verificado solo se entrega al email del owner de Resend):
1. Resend dashboard → Domains → Add Domain → tu dominio.
2. Te muestra 3 records DNS (SPF + DKIM + MX). Agregalos en tu provider de DNS.
3. Resend verifica en ~5 min. Cuando esté verde, podés usar `noreply@<dominio>`
   en `EMAIL_FROM`.
4. Cambiar `EMAIL_FROM` en Railway env vars → redeploy automático.

**Dominio actual (post #312, 2026-06-18):** `tecnyapp.com`, registrado en
GoDaddy. `EMAIL_FROM` en Railway = `Tecny Portal <noreply@tecnyapp.com>`.
Setup detallado: [docs/runbooks/resend-domain-setup.md](runbooks/resend-domain-setup.md).

**Troubleshooting deliverability:**
- Email llega a spam → marcá "No es spam" en Gmail / agregar DKIM al dominio.
- "Domain not verified" en Resend response → revisar DNS, esperar 10 min.
- `429 Too Many Requests` de Resend → upgrade plan o esperar reset diario.

**Templates:** HTML inline en `backend/src/lib/email.js`. Hay templates para
verification email + welcome email. Son strings ES con interpolación segura
(`_esc()`). Para cambiar copy o branding, editar ahí.

**Tests:** `backend/tests/email.test.js` cubre los 3 modos (Resend real
mockeado / stub / failure). El stub guarda emails en una queue accesible vía
`emailLib._getTestQueue()` durante tests.

---

## Cuándo NO actuar y esperar

- Sentry tiene 1 error nuevo aislado — esperar a ver si se repite. Click anecdóticos pasan.
- `/health` responde 503 una vez sola en 1 hora — Railway reinicia y se recupera solo.
- Memory RSS sube 50MB durante un día con uso normal — es esperable, GC eventualmente baja.

---

## Cuándo SÍ actuar inmediato

- `/health` responde 503 en dos pings consecutivos de UptimeRobot.
- Sentry detecta el mismo error en >50 usuarios distintos en <10 min.
- Cron de invariantes (TANDA B) reporta drift en saldo de cajas.
- Algún usuario reporta dato perdido / borrado sin explicación.

---

## Multi-tenant: activar role NOSUPERUSER en prod (TANDA 0c)

### Contexto

PostgreSQL bypassea RLS para los roles SUPERUSER **incluso con FORCE ROW
LEVEL SECURITY**. El role default de Railway (`postgres`) es superuser →
toda la red multi-tenant es decorativa hasta que la app corra con un role
no-superuser. Después de TANDA 0c (migration `rls_fail_closed`), la
policy RLS quedó fail-closed; el último paso es cambiar el role.

### Procedimiento (Railway, ~10 minutos)

1. **Generar password fuerte** localmente:
   ```bash
   openssl rand -base64 24
   ```
   Copialo a un lugar seguro (1Password / bitwarden) — vas a usarlo en
   los pasos 2 y 5.

2. **Editar `backend/scripts/setup-app-role.sql`** — reemplazar
   `PASSWORD_SEGURO_AQUI` por la password generada. NO commitear con la
   password real; revertí el archivo después de correr (o usá el editor
   inline del query console de Railway sin tocar el archivo).

3. **Correr el script en Railway**:
   - Railway dashboard → proyecto iPro → Postgres add-on → **Connect** →
     **Query** (consola SQL embebida).
   - Pegar el contenido del script con la password reemplazada.
   - Run. Debe terminar con la SELECT mostrando `ipro_app | f | t | f | f`.

4. **Construir la nueva `DATABASE_URL`**. Buscar la URL actual en la env
   var del backend (ej. `postgresql://postgres:PASS@host:port/db`).
   Reemplazar `postgres:PASS` por `ipro_app:LA_NUEVA_PASSWORD`. Otros
   campos quedan igual.

5. **Cambiar la env var en Railway**:
   - Railway → tecny-backend (servicio) → **Variables** → `DATABASE_URL`.
   - Pegar la nueva URL. Railway redeploya automáticamente al guardar
     (2-3 minutos).

6. **Verificar el deploy**:
   - Logs del nuevo pod: buscar errores `permission denied for table` o
     `must be owner of table`. Si aparece alguno, agregar el GRANT que
     falta vía la query console (típicamente alguna tabla nueva post-PR1
     que no tenía el grant default).
   - `curl /health` → debe responder 200.
   - Probar manualmente: login + listar inventario / crear venta de
     prueba. Si todo OK → DONE.

7. **(Opcional) Verificar que RLS efectivamente filtra**:
   - Crear un segundo tenant de prueba en DB (manual via query console):
     `INSERT INTO tenants (nombre, slug, plan) VALUES ('Tenant Test',
     'test', 'free'); INSERT INTO tenant_users (tenant_id, user_id, rol)
     SELECT id, 1, 'admin' FROM tenants WHERE slug='test';`
   - Loguear con un user vinculado a ese tenant, listar inventario →
     debe ver 0 productos (porque el tenant nuevo está vacío). Si ve
     productos del tenant original = RLS NO está filtrando, revisar.

### Rollback de emergencia

Si el deploy se cae con errores RLS imposibles de debuggear en vivo:

1. Railway → tecny-backend → **Variables** → revertir `DATABASE_URL` a la
   string con `postgres` (la vieja). Redeploy automático.
2. El role `ipro_app` queda en la DB sin uso. No lo borres todavía — lo
   podés necesitar cuando vuelvas a intentar.
3. Investigar los errores de permission denied con calma, agregar grants
   faltantes, y reintentar paso 5.

### Después de TANDA 0c

Una vez verificado, ese rollback ya no debería ser necesario.
**Documentar la password de `ipro_app`** en un secret manager (1Password
"ipro / db / app-role"). Es el único acceso de la app a la DB; si se
pierde, recovery requiere crear otro role.
