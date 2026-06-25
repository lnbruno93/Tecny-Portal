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

# 4. Reapuntar DATABASE_URL en Railway → tecny-backend.

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

---

## 5. Rehearsal pre-launch (TANDA 4.E — antes del primer cliente)

> **Por qué**: hasta acá el procedure de restore es papel. Una "auditoría
> excelente" exige rehearsearlo al menos una vez antes de tener clientes
> reales, midiendo el tiempo real, y dejando documentado qué funcionó y qué
> rompió. Sin esto, los RTO/RPO declarados son aspiracionales.
>
> **Cuándo**: 1x antes del primer cliente. Después se vuelve drill semestral.
>
> **Tiempo target**: < 30 minutos end-to-end. Si te lleva más, hay un problema
> de tooling que mejor descubrir ahora que en una emergencia real.

### Pre-requisitos en tu Mac

Verificar que tenés instalado (debería estar todo si seguiste el setup de §1):

```bash
psql --version          # >= 16.x
pg_restore --version    # match con psql
b2 version              # Backblaze CLI
```

### Procedure step-by-step (cronometralo)

**Etapa 1: Bajar un backup real (5 min)**

```bash
# Cargar credenciales B2 desde tu ~/.ipro-backup.env
set -a; source ~/.ipro-backup.env; set +a

# Autorizar
b2 account authorize "$B2_KEY_ID" "$B2_APP_KEY"

# Listar lo disponible (deberías ver al menos 1 archivo si el cron mensual corrió)
b2 ls "b2://$B2_BUCKET"

# Bajar el más reciente
b2 file download "b2://$B2_BUCKET/<NOMBRE_DUMP>" ~/dr-rehearsal-$(date +%Y%m%d).dump
```

**Etapa 2: Crear DB sandbox local (3 min)**

> No usar prod ni staging. Sandbox 100% local — descartable cuando termines.

```bash
# Crear DB vacía
createdb dr_rehearsal_$(date +%Y%m%d)

# Anotá el nombre exacto, lo vas a usar varias veces:
export REHEARSAL_DB="postgres://$USER@localhost:5432/dr_rehearsal_$(date +%Y%m%d)"
```

**Etapa 3: Restore (variable, depende del tamaño — esperá 5-15 min)**

```bash
# Cronometrá ESTO. Si toma >30 min para un dump <500MB, hay un problema
# (probablemente pgmigrations corriendo dentro del dump). Anotá el wall-clock.
time pg_restore --no-owner --no-privileges -d "$REHEARSAL_DB" \
  ~/dr-rehearsal-$(date +%Y%m%d).dump
```

**Etapa 4: Verificar con el script (1 min)**

```bash
# Desde la raíz del repo:
DATABASE_URL="$REHEARSAL_DB" ./scripts/dr-verify.sh
```

Esperás `✅ TODOS LOS CHECKS PASARON`. Si alguno falla, anotá cuál y por qué.
Los checks típicos:
- Conectividad, versión Postgres
- Tablas críticas con datos (users, tenants, tenant_users)
- RLS policies + FORCE activos
- Migrations al día (>=30)
- Extensions
- Sample query end-to-end (login simulado)

**Etapa 5: Smoke test con backend (5 min)**

```bash
# Apuntar el backend local a la DB sandbox y arrancarlo.
cd backend
DATABASE_URL="$REHEARSAL_DB" \
  ADMIN_DATABASE_URL="$REHEARSAL_DB" \
  JWT_SECRET=anything-min-32-chars-only-for-rehearsal \
  TWOFA_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  NODE_ENV=development \
  npm run dev
```

En otra terminal o el navegador:
1. Levantar el frontend (`cd frontend && npm run dev`)
2. Login con un user que sepas que estaba en el backup (ej: tu cuenta de Tecny)
3. Browse Inventario — ¿aparecen productos?
4. Browse Cajas — ¿aparecen los métodos de pago y saldos?
5. Browse Cuentas Corrientes — ¿aparecen los clientes B2B?

**Si todo se ve correcto**: el restore funcionó end-to-end. Anotá el tiempo total.

**Etapa 6: Cleanup (1 min)**

```bash
# Cerrar el backend (Ctrl+C)
# Borrar la DB sandbox
dropdb dr_rehearsal_$(date +%Y%m%d)

# Borrar el dump local (es data sensible)
rm ~/dr-rehearsal-$(date +%Y%m%d).dump
```

### Checklist de rehearsal (printable)

Marcá cada paso al ejecutarlo. Esto se vuelve el registro auditable.

```
Fecha del rehearsal: ____________________
Operador:            ____________________
Backup usado (filename): ____________________
Tamaño del dump (MB): ____________________

Etapa                        Wall-clock       Resultado
─────────────────────────────────────────────────────────
[ ] 1. b2 download             ___ min      OK / Falló: _____
[ ] 2. createdb sandbox        ___ min      OK / Falló: _____
[ ] 3. pg_restore              ___ min      OK / Falló: _____
[ ] 4. dr-verify.sh PASS       ___ min      OK / Falló: _____
[ ] 5. backend + login + UI    ___ min      OK / Falló: _____
[ ] 6. cleanup                 ___ min      OK / Falló: _____
─────────────────────────────────────────────────────────
TIEMPO TOTAL:                  ___ min

Notas / sorpresas / improvements:
_____________________________________________________________
_____________________________________________________________
_____________________________________________________________
```

### Qué hacer si algo falla durante el rehearsal

**Es EL momento de descubrir bugs del procedure, no producción.** Si algo no
funciona como esperás:

1. **NO improvises arreglos** — el objetivo es validar el procedure ACTUAL.
2. **Documentá la falla exacta** (comando ejecutado, error printed).
3. **Continuá si podés** (skip el step roto, anotalo).
4. **Después del rehearsal**: actualizá este doc + scripts/dr-verify.sh con
   los fixes. Próximo rehearsal valida que están resueltos.

Los issues comunes en una primera ejecución:
- **b2 account authorize falla** → key expiró, regenerar en Backblaze UI
- **pg_restore "version mismatch"** → instalar Postgres major version del dump
- **dr-verify.sh "0 users / 0 tenants"** → restore "exitoso" pero vacío,
  probablemente el dump se cortó en pg_dump (ver tamaño vs prod actual)
- **Backend no levanta** → falta alguna env var nueva post-rehearsal
  (typical: NUEVA migration agregó secret nuevo)
- **Login funciona pero RLS bloquea queries** → el restore perdió GRANTs
  al role `ipro_app`. Re-correr migrations recupera los GRANTs.

### Después del rehearsal: actualizar este doc

Reemplazá la línea de abajo con los resultados reales del primer rehearsal:

```
Último rehearsal exitoso: ____________________
Wall-clock total: ____ minutos
Bugs encontrados + resueltos: ____________________
Próximo drill programado (6 meses): ____________________
```

> **Status actual**: Rehearsal pre-launch NO ejecutado todavía. Es el último
> ítem bloqueante antes de invitar al primer cliente.
