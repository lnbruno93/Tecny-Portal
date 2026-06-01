# Disaster Recovery — iPro Portal

Escenarios de pérdida/corrupción de datos y procedimientos de recovery.

> El portal opera con datos financieros reales (cajas, CC clientes, deudas a
> proveedores). Una hora de datos perdidos = horas de reconstrucción manual.
> Este documento existe para que no tengas que improvisar bajo presión.

Para procedimientos cotidianos (backups, deploys) ver [OPERATIONS.md](OPERATIONS.md).

---

## 1. Política de backups

**Postgres-AueP en Railway** (NO el servicio `Postgres` vacío).

| Tipo | Frecuencia | Retención | Quién | Costo |
|---|---|---|---|---|
| Snapshot diario | Cada 24h | 6 días | Railway (auto) | Gratis |
| Snapshot semanal | Cada 7 días | 1 mes | Railway (auto) | Gratis |
| Snapshot mensual | Cada 30 días | 3 meses | Railway (auto) | Gratis |
| **Offsite dump a Backblaze B2** | Mensual | 1 año | Tú (script) | ~$5/mes (50GB) |

### Configurar offsite backup en Backblaze B2 (one-time, ~15 min)

Por qué offsite: los 3 niveles de snapshot de Railway viven **dentro de
Railway**. Si tu account de Railway se hackea o cancela por error, todos
esos snapshots desaparecen. Backblaze B2 es un bucket S3-compatible, barato
($0.005/GB/mes), y es el seguro de última instancia.

**Setup:**

1. **Crear cuenta en Backblaze** (gratis hasta 10GB): https://www.backblaze.com/sign-up/cloud-storage
2. **Crear bucket** privado:
   - Bucket name: `ipro-backups-prod` (slug-safe)
   - Files: **Private** (no público).
   - Default encryption: SSE-B2 (la encriptación que Backblaze provee gratis).
3. **Crear Application Key** (NO el master key):
   - Settings → Application Keys → Add a New Application Key.
   - Name: `ipro-backup-uploader`.
   - Allow access to: solo el bucket `ipro-backups-prod`.
   - Type of Access: **Read and Write**.
   - **Guardar el keyID + applicationKey** que muestra (no se vuelve a mostrar).

4. **Lifecycle rule** (para auto-eliminar viejos):
   - Bucket → Lifecycle Rules → Add → "Keep prior versions for X days" → 365.
   - Eso elimina dumps de > 1 año automáticamente.

5. **Script de upload** — guardarlo en `~/bin/ipro-backup.sh` localmente:
   ```bash
   #!/bin/bash
   set -e
   DATE=$(date +%Y-%m)
   FILE="ipro_${DATE}.dump"

   # 1. Dump
   pg_dump "$DATABASE_PUBLIC_URL" -Fc -f "/tmp/$FILE"

   # 2. Upload a B2 via Backblaze CLI (instalar con: brew install b2-tools)
   b2 authorize-account "$B2_KEY_ID" "$B2_APP_KEY"
   b2 upload-file ipro-backups-prod "/tmp/$FILE" "$FILE"

   # 3. Cleanup local
   rm "/tmp/$FILE"
   echo "✓ Backup $FILE subido a Backblaze"
   ```
6. **Calendarizarlo**: agregar al calendario un recordatorio mensual día 1,
   o configurar un cronjob local (`crontab -e`: `0 9 1 * * ~/bin/ipro-backup.sh`).

### Verificación

```bash
# Listar lo que hay en el bucket
b2 ls ipro-backups-prod
# Debería mostrar: ipro_2026-06.dump, ipro_2026-05.dump, etc.
```

### Restore desde Backblaze (escenario peor caso)

```bash
b2 download-file-by-name ipro-backups-prod ipro_2026-06.dump ~/backups/
pg_restore --no-owner -d "$NUEVA_DB_URL" ~/backups/ipro_2026-06.dump
```

---

## 2. Escenarios de pérdida de datos

### Escenario A: Borrado accidental de un registro vía UI

Todos los DELETE de la app son **soft-delete** (`deleted_at = NOW()`). El registro sigue en la tabla.

**Recovery:**
```sql
-- Restaurar un registro soft-deleted
UPDATE <tabla> SET deleted_at = NULL WHERE id = <id>;
```

**Cuándo NO está disponible:**
- `caja_movimientos` que fueron borrados duramente por un cleanup (no debería pasar, los handlers soft-deletean).
- Records dependientes que fueron borrados en cascade (FKs con ON DELETE CASCADE — son pocos, ver migraciones).

---

### Escenario B: Update masivo accidental

Un script o query borró/modificó muchas filas. Soft-delete no salva (los UPDATE no son reversibles sin backup).

**Recovery (en orden de preferencia):**

1. **Audit log** — la app loggea cada INSERT/UPDATE/DELETE con `datos_antes` / `datos_despues`:
   ```sql
   SELECT * FROM audit_logs
    WHERE tabla = 'caja_movimientos'
      AND created_at > NOW() - INTERVAL '1 hour'
    ORDER BY created_at DESC;
   ```
   Si está ahí, podés reconstruir el estado anterior fila por fila desde `datos_antes`.

2. **Snapshot diario de Railway** — si el daño fue ayer o antes, restore a una nueva DB y comparar:
   - Railway → Postgres-AueP → Backups → seleccionar el snapshot del día anterior al daño.
   - **Restore a una DB nueva** (NO sobre prod). Comparar la tabla afectada.
   - Hacer UPDATE manual en prod con los datos rescatados.

3. **Backup mensual exportado** — última resort si los snapshots no llegan tan lejos.

**Tiempo estimado:** 30-90 min según volumen de filas afectadas.

---

### Escenario C: Corrupción silenciosa (saldos no cuadran)

Un bug introdujo drift entre el saldo "calculado" (sum de movimientos) y el "esperado" (lo que la UI muestra). Difícil de detectar a ojo.

**Detección automática:** TANDA B implementa un cron nocturno (`backend/src/jobs/checkInvariants.js`) que valida ~10 invariantes financieros. Si encuentra drift, alerta vía Sentry.

**Recovery manual** — ver RUNBOOK.md §"Datos raros / sospecha de corrupción".

---

### Escenario D: DB completamente perdida

Catástrofe total: Railway pierde el servicio, account hijack, etc.

**Recovery con backup mensual:**
1. Crear DB nueva en Railway (o cualquier Postgres provider).
2. `pg_restore --no-owner -d "$NUEVA_DB_URL" ipro_YYYY-MM.dump`
3. Reapuntar `DATABASE_URL` en Railway → ipro-backend.
4. Correr migraciones pendientes: `npm run migrate` (auto en deploy).
5. Verificar manualmente que `users`, `productos`, `cajas` tienen datos.

**Cuánto se pierde:** todo desde el último backup mensual hasta el momento del incidente.

> Por eso el backup mensual exportado es el último seguro. Si tenés posibilidad,
> automatizá con un cron de GitHub Actions o Railway Scheduler que corra el `pg_dump`
> y lo suba a un bucket S3/Backblaze.

---

## 3. Qué NO hacer bajo presión

- **NO** hacer DROP TABLE para "limpiar" sin un backup verificado en mano.
- **NO** correr migraciones destructivas (DROP COLUMN, TRUNCATE) en prod sin tener
  `pg_dump` fresco del día.
- **NO** ejecutar UPDATE sin WHERE en una sesión de SQL directa. (Workbench/DBeaver
  suelen pedir confirmación; psql NO.)
- **NO** restaurar un backup encima de prod sin antes confirmar que el backup tiene
  los datos que esperás (probar restore a una DB nueva primero).

---

## 4. Test del runbook (recomendado cada 6 meses)

Cada 6 meses, hacer un drill:

1. Bajar un backup reciente.
2. Restaurarlo a una DB de prueba (Railway permite tener una DB extra free).
3. Conectar el backend a esa DB temporalmente (env var override).
4. Verificar que la app funciona y los datos están bien.

Esto valida que:
- Los backups son íntegros (no archivos corruptos).
- El procedimiento de restore está claro.
- No surprises bajo presión real.
