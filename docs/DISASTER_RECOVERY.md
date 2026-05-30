# Disaster Recovery — iPro Portal

Escenarios de pérdida/corrupción de datos y procedimientos de recovery.

> El portal opera con datos financieros reales (cajas, CC clientes, deudas a
> proveedores). Una hora de datos perdidos = horas de reconstrucción manual.
> Este documento existe para que no tengas que improvisar bajo presión.

Para procedimientos cotidianos (backups, deploys) ver [OPERATIONS.md](OPERATIONS.md).

---

## 1. Política de backups

**Postgres-AueP en Railway** (NO el servicio `Postgres` vacío).

| Tipo | Frecuencia | Retención | Quién |
|---|---|---|---|
| Snapshot automático | Diario | 7 días (free) | Railway |
| Backup manual pre-migración | A demanda | Indefinida | Tú |
| Backup mensual exportado | Mensual | 1 año | Tú (recordatorio el día 1) |

**Acción ahora:** verificar en Railway que los snapshots diarios están **activos**:
1. Railway dashboard → Postgres-AueP → tab **Backups**.
2. Si dice "Disabled" → habilitar. Es gratis hasta 100GB.
3. Confirmar que aparece "Latest snapshot: <fecha hoy o ayer>".

**Backup mensual exportado** — recomendado para tener una copia fuera de Railway:
```bash
# El día 1 de cada mes, correr esto desde tu laptop (con DATABASE_PUBLIC_URL en tu env):
pg_dump "$DATABASE_PUBLIC_URL" -Fc -f ~/backups/ipro_$(date +%Y-%m).dump
# Comprimir y subir a iCloud / Drive / Backblaze.
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
