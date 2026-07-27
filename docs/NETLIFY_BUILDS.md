# Netlify Builds — Skip Pristine Deploys Workaround

**Audiencia**: developers que tocan `netlify.toml` (root o `admin-frontend/`) — headers, CSP, redirects, env vars — o que investigan por qué un cambio de config no llegó a prod.

**TL;DR**: Netlify skipea deploys cuando el `dist/` no cambia. Cambios de `netlify.toml` NO afectan `dist/` → deploys de config a veces se cancelan silenciosamente. Fix: los `netlify.toml` de este repo agregan un archivo timestamp único a cada build para forzar content-change.

## El bug

Netlify tiene una feature llamada **"Skip pristine deploys"** que compara el `dist/` compilado contra el del deploy anterior. Si son bit-perfect idénticos, cancela el deploy con:

```
Failed during stage 'checking build content for changes':
Canceled build due to no content change
```

Lógica bien intencionada — evita rebuildear la misma cosa dos veces. **Problema**: la config del sitio (headers, CSP, redirects) NO vive en `dist/`. Vive en el `netlify.toml` que Netlify lee al momento del deploy para configurar la CDN. Si un merge SOLO cambia el `netlify.toml`, entonces:

1. Netlify arranca build → OK
2. Corre `npm run build` → genera `dist/` idéntico al anterior
3. Check content changes → **Cancela el deploy**
4. La config nueva (CSP, headers) NUNCA se aplica → el sitio sigue con la config vieja

## Cómo se descubrió

**PR #667 (2026-07-19)** actualizó el CSP `img-src` del `admin-frontend/netlify.toml` para permitir imágenes desde el backend Railway (necesario para el feature "Empresas que confiaron en Tecny" — logos servidos desde Railway).

- 18:03 UTC: PR mergeado a `main`.
- Netlify arrancó build de `tecny-admin` (admin.tecnyapp.com).
- Build compiló, `dist/` idéntico al anterior (el cambio era solo en `.toml`).
- Netlify canceló el deploy con "no content change".
- **El CSP nuevo nunca llegó a admin.tecnyapp.com** → los previews de logos seguían apareciendo como "?".

Diagnóstico manual:

```bash
netlify api listSiteDeploys --data='{"site_id":"4176fd60-59a5-433c-8841-94135ce44462","per_page":15}' \
  | jq '.[] | select(.context=="production") | {created_at, state, commit_ref, error_message}'
```

Los últimos production deploys mostraban `state: "error"` con `error_message: "Canceled build due to no content change"`.

Workaround temporal aplicado: forzar rebuild manual con:

```bash
netlify api createSiteBuild --data='{"site_id":"4176fd60-59a5-433c-8841-94135ce44462"}'
```

El rebuild manual pasó el check (Netlify no compara con builds fallidos) y el nuevo CSP quedó aplicado.

## El fix permanente

Cada `netlify.toml` del repo ahora tiene un `command` modificado que escribe un archivo con timestamp único al `dist/`:

```toml
[build]
  command = "npm run build && date -u +%FT%TZ > dist/.build-timestamp.txt"
```

Cada build genera un `.build-timestamp.txt` con una hora ISO 8601 UTC distinta → el `dist/` difiere del anterior por al menos ese archivo → Netlify NUNCA skipea. Costo: ~30 bytes por build en el bundle publicado. Sin impacto en usuarios (el archivo no se referencia desde el HTML/JS).

Aplicado en:

- `netlify.toml` (root) — para el site `tecny-portal` (tecnyapp.com).
- `admin-frontend/netlify.toml` — para el site `tecny-admin` (admin.tecnyapp.com).

## Diagnóstico si un cambio de config no llega a prod

1. **Chequear si Netlify skipeó el deploy**:
   ```bash
   netlify api listSiteDeploys --data='{"site_id":"<ID>","per_page":10}' \
     | jq '.[] | select(.context=="production") | {created_at, state, commit_ref, title, error_message}'
   ```
   Si ves `state: "error"` con `"Canceled build due to no content change"`, el workaround del timestamp falló (o no está en esa branch).

2. **Forzar rebuild manual**:
   ```bash
   netlify api createSiteBuild --data='{"site_id":"<ID>"}'
   ```

3. **Verificar que el fix del timestamp está en la branch**:
   ```bash
   grep -n "build-timestamp" netlify.toml admin-frontend/netlify.toml
   ```
   Debería aparecer en ambos. Si no, la branch quedó vieja — hacer rebase con main.

## Site IDs

Para referencia (útil en los comandos de arriba):

| Site | Domain | Site ID |
|---|---|---|
| `tecny-portal` | tecnyapp.com | `893fc2d8-84dd-495a-8889-af782cdf4e0d` |
| `tecny-admin` | admin.tecnyapp.com | `4176fd60-59a5-433c-8841-94135ce44462` |

## Referencias

- El truco del timestamp es discutido en foros de Netlify Community desde hace ~5 años como el fix estándar del "skip pristine".
- Si Netlify saca en el futuro una opción oficial para desactivar "skip pristine" desde la config, este workaround debería reemplazarse por esa opción.

---

## 2026-07-27 (audit 07-25 Track E P1-6): double-deploy race condition

### El bug (distinto al "skip pristine" de arriba)

Cuando 2 PRs mergean a `main` con pocos segundos de diferencia (ej. `#875`
merged 16:32 UTC y `#876` merged 16:33 UTC del delta 07-25), Netlify puede
lanzar 2 builds paralelos. Ambos ven el mismo `HEAD` de `main` cuando arrancan
(o cerca) → ambos compilan el mismo `dist/`. El primer build gana `state: ready`
y queda como current. El segundo build queda cancelado con "no content change"
(el `dist/` es idéntico al que ganó primero).

**Síntoma reportado**: en GitHub el status del PR #876 mostraba
`netlify/tecny-portal/deploy-preview: fail` aunque **el commit sí llegó a prod**
via el primer build. El workaround del timestamp (sección de arriba) NO cubre
este escenario — ambos builds tienen commit-time distintos pero suficientemente
cercanos para que el timestamp del `.build-timestamp.txt` no genere diff bit
significativo (ambos escriben el mismo minuto en el nombre del archivo).

**Efecto real**:
- ✅ Bundle JS: el commit del PR mergeado primero prevalece. El segundo PR
  pierde sus cambios de JS hasta el siguiente deploy.
- ✅ Config (headers CSP, redirects, env vars): la del PR mergeado primero
  se aplica. La del segundo PR queda pendiente hasta el siguiente deploy.
- ✅ El GitHub status queda con `fail` sobre el segundo PR — visualmente
  alarmante pero no bloqueante si el operador entiende el pattern.

### Cómo detectar

1. **Chequear timing entre merges consecutivos**:
   ```bash
   gh pr list --state merged --limit 10 --json number,mergedAt
   ```
   Si 2 merges están dentro de 60s, sospechar race.

2. **Chequear en Netlify UI**:
   Ir al site en Netlify → Deploys. Si ves 2 deploys al mismo commit-hash o
   consecutivos con < 60s de diferencia y el segundo canceled con `no content
   change`, es el race.

### Workarounds hoy

- **Reactivo**: hacer un empty commit para triggerear rebuild (`git commit
  --allow-empty -m "chore: trigger netlify rebuild"; git push origin main`).
- **Proactivo**: **NO mergear 2 PRs consecutivos dentro de 60s**. Esperar a
  que Netlify reporte `state: ready` del primero antes de mergear el segundo.
  Vale la pena para el flow batch (Sprint 0/1/2/3 audit): mergear un PR,
  esperar ~90s, mergear el siguiente.

### Fix real (out of scope hoy)

Netlify tiene `NETLIFY_QUEUE_BUILDS=1` env var (experimental) que serializa
builds. No probado en este repo. Alternativa: GitHub Actions workflow con
`concurrency: group: netlify-deploy + cancel-in-progress: false` que
triggerea el build manualmente vía Netlify API en vez de dejar que Netlify
auto-detecte los merges. Ambas opciones requieren investigación + testing
en staging antes de aplicar.

**Recomendación pragmática (2026-07-27)**: no automatizar hoy. El pattern
manual "esperá 90s entre merges" resuelve el 99% de los casos. Documentado
acá para que Lucas lo tenga a mano si vuelve a aparecer.

### Contexto histórico

- PRs afectados observados: `#874`, `#875`, `#876` del delta 07-25 (documented
  en `state_2026-07-20.md`).
- El workaround del `date > dist/.build-timestamp.txt` (PR #670) fue para el
  bug del "skip pristine" (sección arriba) — DISTINTO al double-deploy race
  descripto acá. No los confundas.
