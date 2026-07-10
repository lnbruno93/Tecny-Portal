# Monitor de deploys de Railway (post-incidente 2026-07-09)

Workflow: [`.github/workflows/monitor-railway-deploys.yml`](../../.github/workflows/monitor-railway-deploys.yml)

## Qué hace

Corre cada 30 minutos (a los `:13` y `:43` de cada hora) y chequea 2 síntomas independientes:

1. **≥2 deployments FAILED consecutivos** en el servicio `tecny-backend` de producción → probable migration rota, startup crash o backend con bug.
2. **Drift** — el commit desplegado en prod NO coincide con el HEAD de `main` → auto-deploy roto o deploys fallidos silenciosamente.

Si detecta uno de los dos, abre un issue en el repo con label `railway-monitor`. Si el issue ya está abierto para el mismo problema, agrega un comment en lugar de duplicar.

## Setup inicial (1 sola vez, antes de que el workflow funcione)

### 1. Crear un Railway API Token

1. Andá a https://railway.com/account/tokens
2. Click **New Token**
3. Nombre: `github-actions-monitor` (o similar — para saber después de dónde viene)
4. Copiá el token que aparece — **no lo vas a poder ver de nuevo después**

### 2. Agregar el token como secret del repo

En el repo de GitHub:

1. **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `RAILWAY_TOKEN` (exactamente así — el workflow lo espera con este nombre)
4. Value: pegá el token del paso anterior
5. **Add secret**

### 3. Verificar el workflow

Después de mergear el PR:

1. Andá a **Actions** en el repo
2. Buscá "Monitor Railway deploys" en la lista de workflows
3. Click **Run workflow** → **Run workflow** (dispara manual para probar)
4. Esperá 1-2 min. El run debería quedar en verde.

Si el manual falla, revisá los logs del step "Verificar estado de deploys" — el error suele ser:
- `Not authorized`: token mal copiado o expirado → regenerá y actualizá el secret
- `Service not found`: cambió el nombre del servicio en Railway → editá el workflow

## Qué hacer cuando llega una alerta

### Caso 1 — "2+ deploys FAILED consecutivos"

El symptom es idéntico al incidente 2026-07-09.

**Recovery:** seguir el playbook en [`docs/runbooks/rls-bulk-migration.md`](rls-bulk-migration.md), sección "Cuando aparezca el mismo síntoma".

**Resumen:**
1. Ver los logs del deploy fallido (`railway logs --service tecny-backend --environment production --lines 800 <DEPLOY_ID> | tail -50`)
2. Si es la misma familia de bug (RLS + bulk UPDATE): aplicar migraciones manualmente como superuser + redeploy `--from-source`
3. Si es otra cosa: diagnosticar según el log

Cuando prod vuelva a servir el HEAD de main, **cerrar el issue** (el monitor no lo va a cerrar solo — es la señal de que resolviste).

### Caso 2 — "Drift entre commit desplegado y main"

Puede ser 3 cosas:

1. **Auto-deploy no se disparó** — verificá en Railway UI → Settings del servicio → sección Source → Automatic Deploys debe estar ON.
2. **Deploys fallidos silenciosamente** — en `railway deployment list` verás la falla real, seguir Caso 1.
3. **Falso positivo** — merge muy reciente (<10 min) que todavía está en BUILDING/DEPLOYING. Esperá 5 min y verificá de nuevo con el `workflow_dispatch` manual antes de invertir tiempo.

## Trade-offs conscientes

- **Cadencia**: 30 min es aceptable para prod (peor caso: enterás del fallo 30 min después del merge). Bajar a 15 min duplica el consumo de minutos gratis de GitHub Actions (~1440 min/mes gratis en cuenta free — el workflow consume ~1 min por run × 48 runs/día = 1440 min/mes justo en el límite).
- **False positives del drift**: un merge que aún está deployando (~5 min) dispara alerta. La primera alerta se auto-cierra en el siguiente run (30 min después) si el deploy ya completó y el commit matchea.
- **Alerta duplicada durante un incidente activo**: el workflow evita duplicar issues abiertos con el mismo título, pero SÍ agrega comment en cada run. Si un incidente dura 6 horas, tenés 12 comments en el issue — no es hermoso pero es útil para el timeline post-mortem.
- **No hace resolución automática** — solo alerta. Recovery es 100% manual, guiado por el runbook.

## Follow-ups posibles (no implementados)

- **Notificación a Slack/Email** — hoy solo abre issue en GitHub. Podría agregar un step con webhook de Slack para alertar más rápido si el operador no monitorea GitHub notifications.
- **Auto-recovery** — si detectamos ≥3 deploys FAILED consecutivos AND el último merge tocó una migration, podríamos intentar el playbook de recovery automáticamente. Riesgo alto — mejor manual con Lucas al mando por ahora.
- **Dashboard de historial** — hoy cada alerta es puntual. Un dashboard con timeline de failures + MTTR ayudaría a decidir si vale la pena invertir en más prevención.
