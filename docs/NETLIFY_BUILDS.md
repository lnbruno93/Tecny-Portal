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
