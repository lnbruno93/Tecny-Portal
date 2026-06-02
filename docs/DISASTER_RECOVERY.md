# Disaster Recovery — iPro Portal

Escenarios de pérdida/corrupción de datos y procedimientos de recovery.

> El portal opera con datos financieros reales (cajas, CC clientes, deudas a
> proveedores). Una hora de datos perdidos = horas de reconstrucción manual.
> Este documento existe para que no tengas que improvisar bajo presión.

Para procedimientos cotidianos (backups, deploys) ver [OPERATIONS.md](OPERATIONS.md).

---

## 1. Política de backups

**Postgres-AueP en Railway** (NO el servicio `Postgres` vacío).

| Tipo | Frecuencia | Retención | Quién | Estado |
|---|---|---|---|---|
| Snapshot automático Railway | Diario | 7 días (free) | Railway | Activo |
| Backup manual pre-migración | A demanda | Indefinida | Tú | A demanda |
| **Backup mensual offsite (Backblaze B2)** | **Día 1 cada mes 9 AM** | **365 días** | **Cron en Mac + script** | **Activo desde 2026-06-01** |

**Acción semestral:** verificar en Railway que los snapshots diarios siguen
activos (Railway dashboard → Postgres-AueP → tab **Backups** → "Latest snapshot:
<fecha hoy o ayer>"). Es gratis hasta 100GB.

### Backup mensual offsite (Backblaze B2)

Defensa contra escenario D ("Railway pierde el servicio" o cualquier catastrofe
que arrastre los snapshots Railway). Vive en una infra **completamente separada**:
Backblaze B2, bucket privado con server-side encryption, lifecycle 365 días,
Application Key bucket-scoped.

**Componentes** (todos en el repo + setup local del operador):

| Pieza | Path | Notas |
|---|---|---|
| Script de backup | `scripts/ipro-backup.sh` | pg_dump + b2 upload, idempotente, trap cleanup |
| Template de env | `scripts/ipro-backup.env.example` | 4 variables: DATABASE_PUBLIC_URL, B2_KEY_ID, B2_APP_KEY, B2_BUCKET |
| Env real (NO repo) | `~/.ipro-backup.env` | chmod 600, las 4 vars reales |
| Script instalado | `~/bin/ipro-backup.sh` | Copia del repo, ejecutable |
| Cron mensual | `crontab -l` en la Mac del operador | `0 9 1 * *` (día 1, 9 AM) |
| Bucket B2 | `ipro-backups-prod` | Private, SSE-B2 encryption, lifecycle 365 d |
| Connection pública | Railway TCP Proxy | `<host>.proxy.rlwy.net:<port>` |

**Setup inicial en una Mac nueva** (segundo operador o reemplazo de la máquina actual):

```bash
# 1. Herramientas
brew install postgresql@18 b2-tools

# 2. Habilitar TCP Proxy en Railway (una sola vez por proyecto)
#    Railway → production → Postgres-AueP → Settings → Networking
#    → "Public Networking" → click "+ TCP Proxy" (puerto interno 5432)
#    → Railway asigna un dominio `<host>.proxy.rlwy.net` + puerto random.

# 3. Crear Application Key en Backblaze (una sola vez por bucket)
#    Backblaze UI → App Keys → "Add a New Application Key"
#    · Scope: SOLO el bucket ipro-backups-prod (no "all buckets")
#    · Permissions: Read & Write
#    Copiar el applicationKey EN EL MOMENTO (se muestra una sola vez).

# 4. Instalar el script y las credenciales
mkdir -p ~/bin
cp scripts/ipro-backup.sh ~/bin/ipro-backup.sh
chmod +x ~/bin/ipro-backup.sh
cp scripts/ipro-backup.env.example ~/.ipro-backup.env
chmod 600 ~/.ipro-backup.env
# Editar ~/.ipro-backup.env y reemplazar los 4 placeholders con valores reales.

# 5. Test de fuego (debería completar en < 1 min para una DB chica)
~/bin/ipro-backup.sh
# Output esperado: "✅ Backup completado: ipro_<fecha>.dump (XMB) en bucket ipro-backups-prod"

# 6. Programar cron mensual
EDITOR=nano crontab -e
# Agregar (3 líneas):
#   # iPro: backup mensual de DB a Backblaze B2 — día 1 de cada mes a las 9 AM
#   PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin
#   0 9 1 * * /Users/<vos>/bin/ipro-backup.sh >> /Users/<vos>/.ipro-backup.log 2>&1

# 7. macOS: dar Full Disk Access a /usr/sbin/cron (System Settings → Privacy
#    & Security → Full Disk Access → +). Sin esto, cron no puede leer
#    ~/.ipro-backup.env ni escribir en /tmp.
```

**Limitación conocida:** el cron corre en la Mac del operador. Si la Mac está
**apagada/dormida** el día 1 a las 9 AM, no se dispara — se pierde ese mes.
Mitigación: recordatorio mensual de Claude el día 1 a las 10 AM que avisa
verificar (ver §4 abajo). Si el archivo no apareció en B2, correr el script
manualmente cuando la Mac se prenda.

**Costo Backblaze** (junio 2026): $0.006/GB/mes storage + $0.01/GB egress
(restore). Una DB de iPro de ~250KB → centavos por año. Plan futuro: si la
DB crece >1GB o querés independencia de la Mac, evaluar Railway Scheduler
(cron en su red privada, ~$5/mes pero sin dependencia local).

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

3. **Backup mensual offsite (Backblaze)** — última resort si los snapshots Railway no llegan tan lejos.

**Tiempo estimado:** 30-90 min según volumen de filas afectadas.

---

### Escenario C: Corrupción silenciosa (saldos no cuadran)

Un bug introdujo drift entre el saldo "calculado" (sum de movimientos) y el "esperado" (lo que la UI muestra). Difícil de detectar a ojo.

**Detección automática:** un cron nocturno (`backend/src/jobs/invariantsJob.js`,
multi-instance-safe via `withAdvisoryLock`) valida ~10 invariantes financieros.
Si encuentra drift, alerta vía Sentry.

**Recovery manual** — ver RUNBOOK.md §"Datos raros / sospecha de corrupción".

---

### Escenario D: DB completamente perdida

Catástrofe total: Railway pierde el servicio, account hijack, etc.

**Recovery con backup mensual offsite (Backblaze):**

```bash
# 1. Bajar el último backup de Backblaze a tu Mac
b2 account authorize "$B2_KEY_ID" "$B2_APP_KEY"
b2 ls b2://ipro-backups-prod                # listar los dumps disponibles
b2 file download b2://ipro-backups-prod/ipro_YYYY-MM-DD_HHMM.dump ~/ipro-restore.dump

# 2. Crear DB nueva en Railway (o cualquier Postgres provider con misma versión, 18.x).

# 3. Restaurar el dump (sin owner, sin permisos del original)
pg_restore --no-owner --no-privileges \
  -d "$NUEVA_DB_URL" \
  ~/ipro-restore.dump

# 4. Reapuntar DATABASE_URL en Railway → ipro-backend.

# 5. Las migraciones ya están en el dump. Si querés validar:
#    cd backend && DATABASE_URL=$NUEVA_DB_URL npm run migrate

# 6. Smoke test en el portal:
#    · Login con el admin
#    · Inventario muestra productos
#    · Cajas con saldos
#    · Movimientos del último mes (los previos al dump están, los posteriores se perdieron)
```

**Cuánto se pierde:** todo desde el último backup mensual hasta el momento del
incidente. Si el incidente fue el 15 del mes y el último dump exitoso fue el 1,
se pierden 14 días. Por eso conviene complementar con los snapshots diarios de
Railway (intentar restaurar de ahí PRIMERO si el incidente es Railway-side y
los snapshots siguen accesibles).

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

## 4. Verificación mensual + test semestral del runbook

### Verificación mensual (5 minutos, día 1 después de las 9 AM)

Claude programa un recordatorio el día 1 de cada mes a las 10 AM. El check es:

1. **Abrir Backblaze** → bucket `ipro-backups-prod` → "Browse files".
2. Confirmar que apareció `ipro_<YYYY-MM-01>_0900.dump` con tamaño razonable
   (debería crecer linealmente con la DB).
3. **Si NO apareció**:
   - Revisar log local: `cat ~/.ipro-backup.log`
   - Causas comunes:
     - Mac apagada/dormida ese día → correr manual `~/bin/ipro-backup.sh`
     - Full Disk Access perdido → re-otorgar a `/usr/sbin/cron`
     - Railway rotó credenciales TCP Proxy → actualizar `DATABASE_PUBLIC_URL`
       en `~/.ipro-backup.env`
     - Backblaze rotó/disabled la Application Key → crear key nueva

### Test semestral del runbook (drill — 30 min)

Cada 6 meses, hacer un test real de restore:

1. Bajar un backup reciente de Backblaze (ver Escenario D arriba).
2. Restaurarlo a una DB de prueba (Railway permite varios servicios PG free).
3. Conectar el backend a esa DB temporalmente (env var override en local).
4. Login + browse Inventario + browse Cajas → confirmar que los datos están.
5. Limpiar (eliminar la DB de prueba) cuando termines.

Esto valida:
- Los backups son íntegros (no archivos corruptos por algún cambio en pg_dump).
- El procedimiento de restore funciona end-to-end.
- Las credenciales B2 siguen vigentes.
- No surprises bajo presión real.

**Documentá el drill** — fecha + qué falló (si algo) en un commit a este doc.
