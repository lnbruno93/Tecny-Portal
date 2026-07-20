# Content Security Policy (CSP)

Documentación operativa del CSP de Tecny — políticas actuales, jobs de CI
que las protegen, y el plan de tightening (Rec #6 audit 2026-07-20).

---

## Estado actual

CSP está seteado en Netlify via `netlify.toml` (una por deploy context:
production, branch-deploy, deploy-preview) y en 2 archivos (`netlify.toml`
root para el portal cliente, `admin-frontend/netlify.toml` para el admin
back-office).

Directivas principales (idénticas entre root y admin salvo minor diffs
por dominios permitidos):

```
default-src 'self';
script-src  'self' https://*.hcaptcha.com;
style-src   'self' 'unsafe-inline' https://fonts.googleapis.com https://*.hcaptcha.com;
img-src     'self' data: blob: https://tecny-backend-*.up.railway.app;
font-src    'self' https://fonts.gstatic.com data:;
connect-src 'self' https://tecny-backend-*.up.railway.app https://*.hcaptcha.com;
frame-src   'self' https://*.hcaptcha.com;
manifest-src 'self';
worker-src  'self';
object-src  'none';
base-uri    'self';
form-action 'self';
frame-ancestors 'none';
report-uri  https://tecny-backend-*/api/csp-report
```

Puntos fuertes vs el minimum viable:
- `script-src` NO tiene `'unsafe-inline'` ni `'unsafe-eval'` — XSS
  reflexivo/stored no puede inyectar scripts.
- `object-src 'none'` — bloquea Flash / plugins legacy.
- `frame-ancestors 'none'` — anti-clickjacking (equivalente a
  X-Frame-Options: DENY).
- `report-uri` a un endpoint backend que loguea violaciones — visibilidad
  en Sentry cuando un browser bloquea algo.

Punto débil (Rec #6):
- `style-src 'unsafe-inline'` — permite `<style>` inline y `style="..."`
  attrs. Necesario mientras haya inline styles en el código (hoy: ~3544
  entre frontend + admin). Ver plan de tightening abajo.

---

## Jobs de CI que protegen el CSP

### 1. `csp-parity` (Sprint 3 L1, junio 2026)

Asserta que los 2 `netlify.toml` (root + admin) tienen las **mismas
directivas** salvo por sus dominios propios. Previene la clase de bug del
2026-07-19: admin's CSP tenía `img-src 'self' data:` sin las backend URLs
→ logos del carrusel Empresas 404 en `admin.tecnyapp.com` pero no en
`tecny.com.ar`.

Se implementa con un parser propio (`scripts/security/*`) que lee ambos
archivos, extrae las directivas, y hace assertions. Corre sin `npm ci`
(usa solo Node built-in `fs`) — ~5s por run.

```bash
npm run test:csp     # tests unit del parser
npm run verify:csp   # assertions cross-file
```

### 2. `csp-inline-styles` anti-regression (Rec #6 Fase 1, 2026-07-20)

Cuenta ocurrencias de `style={...}` en JSX/TSX de `frontend/src` y
`admin-frontend/src`. Compara contra un baseline JSON congelado
(`scripts/csp-inline-styles-baseline.json`). Falla si el count aumenta.

Propósito: **prevenir que se agregue nueva deuda técnica** mientras Fase
2 (migración de los existentes) avanza. Sin este check, cada PR nuevo
podría meter inline styles sin fricción y el número solo subiría.

```bash
node scripts/csp-inline-styles-check.mjs count   # solo imprime, no valida
node scripts/csp-inline-styles-check.mjs check   # exit 1 si aumentó (CI)
node scripts/csp-inline-styles-check.mjs update  # sobrescribe baseline
```

**Cuándo actualizar el baseline**:
- PR que **reduce** el count (migración de inline → CSS class): bienvenido
  y esperado. Correr `update`, incluir el JSON en el mismo commit.
- PR que **aumenta** el count porque el componente nuevo replaza uno más
  grande con más inline styles (net negativo eventual): correr `update`
  con explicación en el PR body.
- PR normal que agrega 1 inline style "porque es más rápido": **NO**
  actualizar. Migrar a clase CSS y no aumentar el baseline.

Baseline inicial (2026-07-20):
- frontend: 2956 matches en 84 archivos
- admin-frontend: 588 matches en 34 archivos
- Total: **3544** inline styles a migrar en Fase 2.

Top archivos frontend:
1. `screens/Ventas.jsx` — 169
2. `screens/CuentasCC.jsx` — 157
3. `screens/Envios.jsx` — 155
4. `screens/Tarjetas.jsx` — 155
5. `screens/Inventario.jsx` — 145

Top archivos admin:
1. `pages/SitioPublico.jsx` — 93
2. `pages/Ficha.jsx` — 54
3. `pages/Novedades.jsx` — 37

---

## Plan de tightening (Rec #6)

**Objetivo final**: remover `'unsafe-inline'` de `style-src`, alineado con
las best practices de CSP (evita una clase entera de XSS vector via inline
`style` attrs).

**Por qué no es 1 día**: 3544 inline styles distribuidos en 118 archivos.
Reescribirlos manualmente a clases CSS + coordinarlo con revisiones + no
romper visualmente = semanas. Sin la Fase 1 de este runbook, la deuda
crecería mientras se migra.

### Fase 1 — Anti-regression check (2026-07-20) ✅

Congelar el baseline actual + CI check que falla si sube. Documentado
arriba.

### Fase 2 — Migración incremental (futuro, semanas)

Aproach por sprints:
1. **Sprint 1**: Top 5 archivos frontend (~781 matches → clases CSS).
   Baseline baja de 2956 → ~2175.
2. **Sprint 2**: Top 5 archivos admin (~254 matches).
   Admin baseline baja de 588 → ~334.
3. **Sprint 3-N**: Continuar por count descendente hasta llegar a
   frontend + admin = ~0.

Cada sprint es 1 PR chico: migra 1 archivo top, corre el script `update`,
commit del baseline nuevo, verificación visual (screenshots antes/después).

### Fase 3 — Remover `unsafe-inline` (cuando el baseline sea ~0)

Actualizar los 4 archivos `netlify.toml` (2 root + 2 admin):

```diff
- style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://*.hcaptcha.com;
+ style-src 'self' https://fonts.googleapis.com https://*.hcaptcha.com;
```

Verificar con Sentry post-deploy — si alguna violation aparece, es un
inline style que se coló durante Fase 2 (o una lib externa que se agregó).
Investigar caso por caso.

---

## Referencias

- [MDN — Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [CSP Evaluator (Google)](https://csp-evaluator.withgoogle.com/) — pega el header y ver score
- [OWASP CSP cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)

---

## Ownership

- Cambios en `netlify.toml`: cualquier PR, pero requiere `csp-parity`
  verde (job de CI ya en place).
- Nuevos inline styles: bloqueados por `csp-inline-styles`. Alternativa:
  migrar a CSS class o justificar update del baseline.
- Fase 2 (migración): asignar por sprint al que empiece — sin owner
  dedicado, se estanca.
- Fase 3 (remove `unsafe-inline`): decisión de Lucas (product owner)
  cuando el baseline sea manejable.
