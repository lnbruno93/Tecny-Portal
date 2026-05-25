# Operaciones — iPro Portal

Runbook operativo: backups, rollback y decisiones de escala. Producción es Railway (backend + Postgres) + Netlify (frontend).

---

## 1. Backups de la base de datos

**Producción:** servicio `Postgres-AueP` en Railway (NO el `Postgres` vacío).

- Activar backups automáticos: Railway → `Postgres-AueP` → pestaña **Backups** → habilitar snapshots programados.
- Backup manual antes de cualquier migración destructiva (DROP/ALTER que borre datos):
  ```bash
  pg_dump "$DATABASE_PUBLIC_URL" -Fc -f ipro_$(date +%Y%m%d_%H%M).dump
  ```
- Restore (a una base nueva, NUNCA pisar prod sin verificar):
  ```bash
  pg_restore --no-owner -d "$TARGET_DATABASE_URL" ipro_YYYYMMDD_HHMM.dump
  ```

> Regla: **antes de una migración que borre o transforme datos, sacar un backup manual** y verificar que el archivo se generó.

---

## 2. Rollback de un deploy

Railway auto-deploya en cada push a `main`. Si un deploy queda mal:

1. **Rollback instantáneo (sin tocar código):** Railway → servicio `ipro-backend` → **Deployments** → en un deploy verde anterior, menú ⋮ → **Redeploy**. Vuelve a esa versión en minutos.
2. **Rollback por código (preferido si el problema es el código):**
   ```bash
   git revert <sha-del-merge> -m 1   # revierte el merge problemático
   git push origin main              # dispara un deploy limpio
   ```
3. El frontend (Netlify) se revierte igual: Deploys → un deploy anterior → **Publish deploy**.

---

## 3. Rollback de una migración

Las migraciones corren al arrancar el contenedor (`npm run migrate` en el startCommand).

- **Revertir la última migración:**
  ```bash
  DATABASE_URL="<public-url>" npm run migrate:down   # ejecuta el exports.down de la última
  ```
- **Criterio:** solo revertir si la migración es problemática Y su `down` es seguro. Para migraciones aditivas (índices, columnas nullable) el `down` es seguro. Para migraciones que borran datos, **restaurar desde backup** en vez de confiar en `down`.
- Tras revertir, hacer rollback del código que dependía de esa migración (sección 2) para que no vuelva a aplicarse en el próximo deploy.

> ⚠️ El `down` NO recupera datos borrados por el `up`. Para eso está el backup (sección 1).

---

## 4. Escala — réplica única (decisión 2026-05-25)

**iPro corre con 1 réplica.** Es la configuración soportada hoy y todo está afinado para eso:
- El rate-limiter (`express-rate-limit`) usa store en memoria → correcto con 1 réplica.
- Las migraciones corren al arranque del único proceso → sin race conditions.

**Cuando el tráfico justifique escalar a múltiples réplicas, ANTES hay que:**
1. **Rate-limiter compartido:** mover a `rate-limit-redis` con un Redis en Railway (si no, el límite anti-fuerza-bruta se multiplica por la cantidad de réplicas).
2. **Migraciones como job único:** sacar `npm run migrate` del startCommand por-réplica y correrlo como release-phase/job aparte (node-pg-migrate toma advisory lock no-bloqueante: con varias réplicas arrancando juntas, las que no obtienen el lock fallan y reintentan → flapping).

Hasta entonces, mantener `numReplicas: 1` en Railway.
