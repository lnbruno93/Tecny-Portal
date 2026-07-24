# Content Security Policy (CSP)

Documentación operativa del CSP de Tecny — políticas actuales, jobs de CI
que las protegen, y decisiones tomadas durante el programa de hardening
Sprints 95-107 (2026-07-23/24).

**Última actualización**: Sprint 107 (2026-07-24) — cierre del programa CSP.

---

## Estado actual (post-Sprint 107)

CSP está seteado en Netlify via `netlify.toml` (una por deploy context:
production, branch-deploy, deploy-preview) en 2 archivos (`netlify.toml`
root para el portal cliente, `admin-frontend/netlify.toml` para el admin
back-office). La spec canónica vive en `scripts/security/csp-spec.js`.

### Header `Content-Security-Policy` (enforce mode)

Directivas idénticas entre root y admin salvo `img-src` (root: sin `blob:`;
admin: con `blob:` para preview de logos):

```
default-src 'self';
script-src  'self' https://*.hcaptcha.com;
style-src   'self' 'unsafe-inline' https://fonts.googleapis.com https://*.hcaptcha.com;
img-src     'self' data: https://tecny-backend-*.up.railway.app        # + blob: en admin
font-src    'self' https://fonts.gstatic.com;
connect-src 'self' https://tecny-backend-*.up.railway.app https://*.hcaptcha.com;
frame-src   'self' data: https://*.hcaptcha.com;
manifest-src 'self';
worker-src  'self';
object-src  'none';
base-uri    'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests;
script-src-attr 'none';
report-uri  https://tecny-backend-*/api/csp-report
```

### Header `Content-Security-Policy-Report-Only` (Sprint 106 — Trusted Types)

Header SEPARADO en modo Report-Only. No bloquea, solo reporta violaciones
al `report-uri` para análisis. Cuando tengamos 1-2 semanas de data de prod,
decidimos Sprint 106b (mover a enforce mode).

```
require-trusted-types-for 'script';
trusted-types 'allow-duplicates' default;
report-uri https://tecny-backend-*/api/csp-report
```

### Fortalezas del CSP actual

- `script-src` NO tiene `'unsafe-inline'` ni `'unsafe-eval'` — el vector XSS
  **principal** (JS injection) está cerrado.
- `object-src 'none'` — bloquea plugins legacy (Flash, Java).
- `frame-ancestors 'none'` — anti-clickjacking (equivalente a
  X-Frame-Options: DENY).
- `base-uri 'self'` — evita inyección de `<base>` que redirija URLs relativas.
- `form-action 'self'` — evita form POST a origen externo (credencial
  exfiltration).
- `script-src-attr 'none'` — bloquea inline event handlers HTML
  (`onclick="..."`, etc.). React usa syntheticEvent, cero impacto.
- `upgrade-insecure-requests` — cubre subresources http:// del bundle,
  defense-in-depth con HSTS.
- `report-uri` a un endpoint backend que loguea violaciones — visibilidad
  cuando un browser bloquea algo.

### Tech-debt aceptado (documentado)

- `style-src 'unsafe-inline'` — impedido por 13 residuales data-driven
  inevitables (bar-fill widths, chart heights %, DB-provided colors). Ver
  sección "13 residuales" abajo.

---

## 13 residuales inevitables

Después de los Sprints 95-104 se migraron ~500 `style={{...}}` attrs +
4 elementos `<style>` a CSS classes. Los 13 residuales que quedan son
**data-driven inherentemente** — no se pueden expresar como CSS estático
sin cambiar la semántica del componente:

| Ubicación | Qué es | Por qué es inevitable |
|---|---|---|
| `frontend/src/screens/ventas/HourChart.jsx` | bar height % | Chart data-driven |
| `frontend/src/screens/Sanidad.jsx` | progress bar-fill % | Data-driven |
| `frontend/src/screens/CuentasCC.jsx` | bar-fill width % | Data-driven |
| `frontend/src/components/NotificationsBell.jsx` | panel top/right px | `getBoundingClientRect()` |
| `frontend/src/components/Skeleton.jsx` | width/height API | Callers pasan valores arbitrarios |
| `admin-frontend/src/pages/SitioPublico.jsx` | Google avatar bg color | Color viene de DB |
| `admin-frontend/src/pages/Clientes.jsx` | health bar-fill width | Data-driven |
| `admin-frontend/src/pages/Resumen.jsx` (×2) | mrrSpark height + plan bar width | Data-driven |
| `admin-frontend/src/components/charts/ColChart.jsx` (×3) | chart height + 2 bar heights | Data-driven |
| `admin-frontend/src/pages/Ficha.jsx` | HealthBar fill width | Data-driven |

**Total: 13** (5 frontend + 8 admin).

Estos 13 están **tracked** por `scripts/csp-inline-styles-check.mjs` — si el
count sube por encima de 13, CI falla. El script matchea tanto
`style={{...}}` attrs como `<style>{...}</style>` blocks.

### Alternativas exploradas y descartadas

1. **CSS custom properties inline** (`style={{ '--w': pct }}`): sigue siendo
   un atributo `style=` → no ayuda al CSP.
2. **`element.style.setProperty()` via useEffect + refs**: bypassa el DOM
   attribute pero comportamiento inconsistente entre browsers respecto a CSP
   enforcement (Firefox estricto igual bloquea).
3. **`data-*` attrs + CSS `attr()`**: soporte limitado (Chrome 133+, no Safari).
4. **Nonces / hashes para inline styles**: nonces NO aplican a `style=""`
   attributes según spec CSP (solo a `<style>` tags). Hashes requieren
   valores estáticos, incompatible con data-driven.

Decisión final: aceptar los 13 residuales + anti-regression + `'unsafe-inline'`.

---

## Jobs de CI que protegen el CSP

### 1. `csp-parity` (Sprint 3 L1, junio 2026)

Asserta que los 2 `netlify.toml` (root + admin) tienen las **mismas
directivas** salvo por sus dominios propios. Previene divergencia no
intencional (bug del 2026-07-19: admin img-src sin backend URLs → logos
del carrusel Empresas 404).

Implementado con parser propio (`scripts/security/verify-csp-parity.js`)
que lee ambos archivos, extrae directivas, hace assertions. Sin
dependencies extra (solo `fs`).

```bash
npm run verify:csp   # assertions cross-file
```

### 2. `csp-invariants.test.js` (Sprint 107, 2026-07-24)

Tests unitarios que asertan **invariantes de seguridad** que NUNCA deben
cambiar sin conversación explícita. Ej.:

- `script-src` NUNCA tiene `'unsafe-inline'` ni `'unsafe-eval'`.
- `object-src` ES `'none'`.
- `frame-ancestors` ES `'none'`.
- `base-uri` ES `'self'`.
- `form-action` ES `'self'`.
- `default-src` ES `'self'`.
- `upgrade-insecure-requests` está presente.
- `script-src-attr` ES `'none'`.
- Todos los contextos tienen `report-uri`.
- root y admin comparten backend URLs en `connect-src` (fixture del bug 2026-07-19).

14 tests. Cualquier PR que relaje uno de estos rompe CI y fuerza la
conversación en el PR body.

```bash
npm run test:csp   # corre csp-parity.test + csp-invariants.test (36 tests total)
```

### 3. `csp-inline-styles` anti-regression (Rec #6 Fase 1, 2026-07-20)

Cuenta ocurrencias de `style={{...}}` y `<style>{...}</style>` en JSX/TSX
de `frontend/src` y `admin-frontend/src`. Compara contra baseline JSON
(`scripts/csp-inline-styles-baseline.json`). Falla si el count sube.

Baseline actual: **13** total (5 frontend + 8 admin, todos data-driven
residuales documentados).

```bash
node scripts/csp-inline-styles-check.mjs count   # solo imprime
node scripts/csp-inline-styles-check.mjs check   # exit 1 si aumentó (CI)
node scripts/csp-inline-styles-check.mjs update  # sobrescribe baseline
```

---

## Historia del programa de hardening (Sprints 95-107)

Contexto: la auditoría del 2026-07-20 (Rec #6) identificó `style-src
'unsafe-inline'` como el principal punto débil del CSP. En el momento
había ~3544 inline styles distribuidos entre frontend + admin. El programa
migró la mayor parte en 10 sprints.

| Sprint | Fecha | Contenido | Baseline post-sprint |
|---|---|---|---:|
| Fase 1 | 2026-07-20 | Anti-regression check + primeras 200 migraciones | 3344 |
| Sprints 4-94 | 2026-07-21/22 | Bulk migration a utility classes + component-specific classes | 136 |
| Sprint 95 | 2026-07-23 | 5 files @ 4 hits (batch) | 116 |
| Sprint 96 | 2026-07-23 | 6 files @ 4 hits (batch) | 93 |
| Sprint 97 | 2026-07-23 | 6 files @ 3 hits (batch) | 75 |
| Sprint 98 | 2026-07-23 | 4 files @ 2 hits (batch) | 67 |
| Sprint 99 | 2026-07-23 | 11 files @ 1 hit (batch, floor de frontend) | 56 |
| Sprint 100 | 2026-07-23 | Primer batch admin (3 files, 17 hits) | 39 |
| Sprint 101 | 2026-07-23 | Admin batch 4-hit (12 hits) | 27 |
| Sprint 102 | 2026-07-23 | Admin batch 2-3 hit (8 hits) | 19 |
| Sprint 103 | 2026-07-23 | Admin batch 1-hit (6 hits, floor de admin) | 13 |
| Sprint 104 | 2026-07-24 | Elementos style JSX (4 blocks) + check extendido | 13 |
| Sprint 105 | 2026-07-24 | Directive hardening + fix 2 bugs latentes | 13 |
| Sprint 106 | 2026-07-24 | Trusted Types en Report-Only (fase datos) | 13 |
| Sprint 107 | 2026-07-24 | Docs + invariant tests (cierre del programa) | 13 |

**Reducción total**: 3544 → 13 (99.6%).

Los 13 restantes son data-driven inevitables, documentados arriba.

---

## Decisiones tomadas y rechazadas

### ❌ `script-src 'strict-dynamic'` (rechazado en Sprint 107)

**Qué es**: revertir el modelo CSP a "solo el script inicial con nonce +
scripts que él cargue transitivamente". El resto de la source list se ignora.

**Por qué se descartó**:
- Netlify sirve HTML estático → necesitaría **Netlify Edge Functions**
  (Deno runtime) que interceptan cada request para inyectar nonce único
  en el `<script>` y en el CSP header.
- Nueva pieza de infra + latencia adicional + testing local complicado.
- Beneficio marginal vs el CSP actual: el único vector adicional que
  cierra es "atacante inyecta `<script src="/mismo-origen/malicious.js">`",
  pero para eso el atacante YA necesita write access al mismo dominio
  (una fase de ataque mucho más pesada que solo XSS).
- Costo/beneficio no justifica bajo el principio "solidez, escalabilidad,
  calidad".

**Cuándo revisitar**: si aparece un vector real (ej. XSS reportado en
producción que hubiera sido bloqueado por strict-dynamic), o si Netlify
Edge Functions dejan de ser una pieza de infra "extra" y son parte del
stack estándar del proyecto.

### ❌ Remover `style-src 'unsafe-inline'` (imposible sin refactor pesado)

Ver sección "13 residuales" arriba. Los residuales son data-driven
inherentemente. Removería visualmente los bar-fills, charts, y previews.

### ✅ Trusted Types en Report-Only primero (Sprint 106)

**Qué es**: header `Content-Security-Policy-Report-Only` con
`require-trusted-types-for 'script'`. Browsers reportan violaciones al
backend sin bloquear.

**Por qué Report-Only y no enforce**: nuestro codebase es TT-clean (cero
usos de `innerHTML`, `outerHTML`, etc.), pero libs 3rd party como hCaptcha
podrían usarlos internamente. Report-Only nos da 1-2 semanas de data para
saber qué policies necesitamos crear antes de mover a enforce.

**Sprint 106b futuro**: cuando tengamos data, crear policies necesarias +
cambiar el header a enforce.

---

## Referencias

- [MDN — Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [CSP Evaluator (Google)](https://csp-evaluator.withgoogle.com/) — pega el header y ver score
- [OWASP CSP Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
- [Trusted Types spec (W3C)](https://www.w3.org/TR/trusted-types/)
- [strict-dynamic explained (Google)](https://web.dev/articles/strict-csp)

---

## Ownership

- **Cambios en `netlify.toml`**: cualquier PR, pero requiere `csp-parity`,
  `test:csp` y `verify:csp` verdes (jobs de CI ya en place).
- **Cambios que relajen invariantes** (ej. agregar `'unsafe-inline'` a
  script-src): `csp-invariants.test.js` falla. El test tiene mensajes que
  documentan por qué el invariante existe — hay que actualizar test + PR
  body con razón fuerte para relajarlo.
- **Nuevos inline styles**: bloqueados por `csp-inline-styles`. Alternativa:
  migrar a CSS class o justificar update del baseline.
- **Sprint 106b (Trusted Types enforce)**: pendiente de tener 1-2 semanas de
  data de Report-Only en prod. Owner: Lucas.
