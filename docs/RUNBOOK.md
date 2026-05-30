# Runbook — iPro Portal

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
- **Health en vivo** — https://ipro-backend-production.up.railway.app/health

---

## El portal está caído

### Síntoma: Los usuarios reportan "no abre"

1. Probar `/health` desde el browser/curl. Si responde 200 → problema es frontend o red del usuario.
2. Si responde 503 o no responde:
   - Railway → ipro-backend → **Deployments** → ver el último: ¿está "Building", "Failed", "Crashed"?
   - Si "Crashed": ver Logs, buscar el error reciente. Si está en loop, Railway lo reinicia automáticamente.
   - Si la causa es el último deploy: rollback (ver OPERATIONS.md §2).
3. Si `/health` responde 503 con `db.status: error`:
   - Postgres-AueP → ¿está corriendo? Si está caída, restart desde el dashboard de Railway.
   - Ver si hay alerta de Railway por consumo de plan / billing.

### Síntoma: Frontend abre pero "error de red" en cada acción

1. ¿El usuario está offline? El service worker debería mostrar página cacheada — si no, problema del SW.
2. CORS: si el navegador del usuario muestra "CORS error" en la consola, revisar `CORS_ORIGIN` en Railway envs — debe incluir el dominio Netlify del usuario.
3. Probar la API directo con curl: `curl -i https://ipro-backend-production.up.railway.app/health` — descarta backend down.

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
   curl -s -X GET "https://ipro-backend-production.up.railway.app/api/admin/invariants" \
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

### Síntoma: Login rate-limited masivo

- Está pasando algo: o un ataque de credential stuffing, o un script propio mal hecho.
- IP banneada via Cloudflare/proxy (no implementado todavía).
- Mitigation temporal: subir el límite en `app.js` loginLimiter, redeploy. Volver a bajar después.

---

## Email/Notificaciones (no implementado todavía)

Cuando se sume:
- ¿SMTP provider? Resend / SendGrid free tier.
- Templates fuera del código (Markdown + variables).
- DKIM/SPF configurado en el dominio del remitente.

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
