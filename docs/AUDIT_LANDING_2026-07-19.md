# Auditoría técnica — Landing tecnyapp.com

**Fecha**: 2026-07-19
**Alcance**: `frontend/src/screens/Landing.jsx` + assets estáticos + config Netlify + endpoints públicos que la alimentan.
**Contexto**: Lucas expresó preocupación de que la landing no cumple el principio "SIEMPRE solidez, infraestructura y escalabilidad" tras un día en que 4 bugs distintos afectaron el feature "Empresas que confiaron en Tecny" (CSP admin, CORP backend, `<img src>` relativo, Netlify skip-pristine deploys).

## TL;DR

La landing está en **"deuda técnica manejable pero real"**. No hay P0 productivo — funciona, es rápida y es segura. Pero hay 3 issues HIGH que impactan crecimiento (SEO) y observabilidad (no sabemos qué visitantes convierten ni cuándo la landing falla).

**Plan sugerido**: 3 sprints de 1 semana cada uno. Sprint 1 puede empezar hoy.

## Metodología

Datos reales, no impresiones:

- **Build local**: `npm run build` en `frontend/`, análisis de chunks.
- **Prod**: `curl` a `tecnyapp.com` para TTFB, headers, meta tags, robots/sitemap.
- **Código**: inspección directa de `Landing.jsx`, `App.jsx`, `index.html`, migrations del CMS.
- **Delegación**: agent Explore para análisis cualitativo cruzado (10 puntos).

## Findings por severidad

### 🔴 HIGH — atacar en Sprint 1

#### H1. Sin sitemap.xml ni robots.txt reales

**Evidencia**: `curl https://tecnyapp.com/robots.txt` → HTTP 200 pero devuelve el `index.html` del SPA fallback (el `[[redirects]]` de Netlify captura el path). Google no tiene forma de saber qué URLs crawlear ni la frecuencia esperada.

Impacto real: crawler de Google marca el sitio como "sin estructura declarada" → menor autoridad de dominio en el mediano plazo. Para un SaaS que compite por keywords tipo "sistema para revendedores de tecnología", esto duele.

**Fix**: crear `frontend/public/robots.txt` y `frontend/public/sitemap.xml`. Vite copia `public/` al `dist/` en el build y Netlify sirve los archivos estáticos ANTES del SPA fallback. Sin tocar routing.

**Esfuerzo**: 30 min.

#### H2. Sin JSON-LD structured data

**Evidencia**: `curl https://tecnyapp.com/` → 4 grupos de meta tags bien puestos (`og:*`, `twitter:*`, `description`, `canonical`) pero **ningún `<script type="application/ld+json">`**. Google, Bing y motores de IA (ChatGPT search, Perplexity) usan structured data para entender qué vende el sitio.

Comparación:
- **Linear** (linear.app): `@type: SoftwareApplication`, `offers`, `aggregateRating`.
- **Stripe**: `@type: Organization` + `@type: WebSite` + `SearchAction`.
- **Notion**: `@type: SoftwareApplication` con `screenshot` array.

**Fix**: agregar bloque JSON-LD al `frontend/index.html` con `@type: SoftwareApplication`, `applicationCategory: BusinessApplication`, `offers` (leídos del backend `/api/public/pricing` no aplica en HTML estático — dejamos hardcoded como fallback, matcheado al schema). Consider ampliarlo con `aggregateRating` cuando tengamos reviews de Google verificadas.

**Esfuerzo**: 1 hora.

#### H3. Sin observabilidad específica de la landing

**Evidencia**: `grep -rn "Sentry\|gtag\|posthog\|mixpanel" frontend/src/screens/Landing.jsx` → **0 matches**. Ningún breadcrumb, evento de analytics, ni performance mark. Consecuencia directa:

- No sabemos cuántos visitantes anónimos hacen click en "Empezar gratis" (nav vs hero vs pricing vs cta-final).
- Si el fetch de `/api/public/site-config` falla en 5% de los visitantes, nadie se entera hasta que un cliente reporta.
- El bug de logos de hoy (PR #666/#667/#670/#671) hubiera sido detectado en 15 min si un evento de Sentry se disparara cuando un `<img>` del carrusel emite `onerror`.

**Fix**: 
1. Sentry breadcrumbs para cada fetch de la landing (site-config, pricing, trusted-companies) + un `onError` en el `<img>` del carrusel que dispare Sentry warning.
2. Analytics event provider agnóstico (`window.dataLayer` push) para CTA clicks — así queda listo para cablear GA4/PostHog/Plausible cuando decidamos cuál.
3. `performance.mark('landing-ready')` para medir TTI (Time to Interactive) real desde RUM.

**Esfuerzo**: 2 días.

### 🟡 MED — Sprint 2

#### M1. `Landing.jsx` monolítico (870 líneas, 12 fetches, 3 useEffect anidados)

**Evidencia**: `Landing.jsx:168-268` — un solo `useEffect` con 3 fetch calls (`/pricing`, `/site-config`, `/trusted-companies`) compartiendo el mismo `AbortController`. Si uno tarda, aborta los otros.

**Fix**: partir en 3 hooks separados (`useLandingPricing`, `useLandingCMS`, `useTrustedCompanies`) + extraer secciones a subcomponentes (Hero, Products, Pricing, FAQ, Contact).

**Esfuerzo**: 2 horas.

#### M2. Sin tests E2E de la landing

**Evidencia**: `frontend/src/screens/Landing.test.jsx` cubre solo el fetch de `pricing`. No hay Playwright que abra tecnyapp.com y verifique CTA clicks, logos que cargan, o navigation.

**Fix**: agregar 4-5 tests Playwright en `e2e/landing.spec.ts`:
- Landing carga con status 200 + `og:image` en headers.
- Los logos del carrusel `<img>` no tienen `naturalWidth === 0` (broken image detection).
- Click en "Empezar gratis" navega a `/signup`.
- Sección Contacto muestra los datos del CMS (email, WhatsApp).
- CSP no bloquea ninguna imagen (verificar `document.querySelectorAll('img').every(img => img.complete)`).

**Esfuerzo**: 3 días.

#### M3. Fixes accesibilidad (a11y)

**Evidencia** (line numbers de `Landing.jsx` en `main` a fecha 2026-07-19):
1. **L62-66** — `SoonLink` usa `href="#"` con `aria-disabled="true"`, pero screen readers lo interpretan como link activo. Cambio a `<span role="link" aria-disabled="true">`.
2. **L42-49** — Componente `Check` SVG sin `role="img"` ni `aria-label`. Screen readers no anuncian los checkmarks del pricing.
3. **Landing.css** — botones `.btn-lg` en mobile miden ~36px de alto. WCAG 2.5.5 pide 44×44px mínimo.
4. **L711-716** — `<img>` del carrusel usan `alt={c.nombre}` pero el contenedor no tiene `role` que indique "list of trusted companies".
5. **Landing.css** — no hay `:focus-visible` styles → keyboard users pierden el indicador de foco.

**Esfuerzo**: 1 día.

#### M4. Escalabilidad del CMS singleton

**Evidencia**: `backend/migrations/20260713*.js` — 5 migrations `ALTER TABLE site_landing_config` en 5 días. Actualmente la tabla tiene 15+ columnas.

**Regla empírica**: a 20-25 columnas, el patrón empieza a doler (SELECT * lento, backups pesados, refactor de código de UI acoplado a cada campo). Todavía manejable.

**Fix propuesto (para cuando duela)**: refactor a `content JSONB` con schema Zod validado en el backend. Migración gradual: nuevas columnas van al JSONB, viejas se dejan hasta refactor completo del frontend.

**Esfuerzo**: 1 semana (no urgente).

### 🟢 LOW — cuando duela

#### L1. Duplicación `netlify.toml` root vs `admin-frontend/netlify.toml`

CSP idéntico casi por completo (5 headers duplicados en 3 blocks: production, branch-deploy, deploy-preview). Netlify no soporta `include` así que la solución sería un script Node que genera ambos `.toml` desde un YAML compartido. Overkill hoy.

**Esfuerzo**: 30 min si se hace en shell.

#### L2. `Landing.css` con ~30 líneas de bloat

Reglas de secciones removidas (`.strip`, `.testimonial-card`) que quedaron huérfanas tras el audit #441 de 2026-06-26. Sin impacto de performance real.

**Esfuerzo**: 30 min.

## Descartes explícitos

### Bundle sharing con el portal — NO es un problema

**Verificación**: `App.jsx:36` → `const Landing = lazy(() => import('./screens/Landing'))`. Landing está lazy-loaded. Chunk aislado: **32KB (8KB gzipped)**. El vendor bundle compartido (React + router + 3 contextos) es inevitable en un SPA.

TTFB medido en prod: **110ms (cache warm)**, **422ms (primer request)**. Sano.

Descartar como issue.

### Rediseño `iPro-Website` — NO migrar

Es un rediseño de landing B2C (compare iPhones, drag&drop) hecho en Replit. Narrativa distinta del SaaS actual. Repo archivado. Si en el futuro se retoma, es una decisión estratégica de producto — no técnica.

## Roadmap sugerido

### Sprint 1 (1 semana) — SEO + Observabilidad

| # | Item | Severidad | Esfuerzo |
|---|---|---|---|
| H1 | `robots.txt` + `sitemap.xml` reales | HIGH | 30 min |
| H2 | JSON-LD structured data | HIGH | 1 hora |
| H3 | Sentry breadcrumbs + `onError` en `<img>` + `performance.mark` | HIGH | 2 días |
| — | (Opcional) `document.title` dinámico por sección | MED | 2 horas |

**Objetivo**: la landing queda indexable con datos ricos, y sabemos cuándo falla algo antes que el cliente avise.

### Sprint 2 (1 semana) — Solidez + Mantenibilidad

| # | Item | Severidad | Esfuerzo |
|---|---|---|---|
| M2 | 4-5 tests E2E Playwright | MED | 3 días |
| M1 | Refactor `Landing.jsx` en subcomponentes + 3 hooks | MED | 2 horas |
| M3 | Fixes a11y (5 items concretos) | MED | 1 día |

**Objetivo**: la landing pasa CI con tests que atraparían el bug de hoy, es mantenible por sub-secciones, y cumple WCAG 2.1 AA básico.

### Sprint 3 — Escalabilidad del CMS

| # | Item | Severidad | Esfuerzo | Estado |
|---|---|---|---|---|
| M4 | Refactor `site_landing_config` → `content JSONB` con schema Zod | MED | 1 semana | ⏳ Pending (disparador no cumplido) |
| L1 | Deduplicar CSP entre `netlify.toml` root y admin | LOW | 30 min | ✅ Done — spec canónica en `scripts/security/csp-spec.js` + test de paridad en CI |
| L2 | Limpieza `Landing.css` | LOW | 30 min | ✅ Done — 26 líneas de selectores huérfanos removidas (`.strip*`, `.test*`, `.bigstat*`, `.tint-slate`) |

**Disparador M4**: cuando la tabla singleton supere 20 columnas o alguien pida agregar un campo dinámico complejo (ej. hero video URL con thumbnail). Hoy en 15+ columnas — todavía manejable.

## Métricas baseline (2026-07-19)

Para poder medir progreso en cada sprint:

| Métrica | Valor actual | Objetivo Sprint 1 |
|---|---|---|
| TTFB (cache warm) | 110ms | ≤150ms (mantener) |
| HTML size | 3.96 KB | ≤5 KB (con JSON-LD) |
| Landing chunk (gzipped) | 8 KB | ≤10 KB |
| Meta tags OG/Twitter | ✅ Completos | ✅ + JSON-LD |
| robots.txt | ❌ (SPA fallback) | ✅ Real |
| sitemap.xml | ❌ (SPA fallback) | ✅ Real |
| Sentry events desde landing | 0 | ≥3 (breadcrumbs + errors) |
| Tests E2E de landing | 0 | 0 (Sprint 2) |

## Referencias

- Landing SPA: `frontend/src/screens/Landing.jsx` (870 líneas)
- CSS: `frontend/src/screens/Landing.css` (557 líneas)
- HTML root: `frontend/index.html`
- Router: `frontend/src/App.jsx:36` (lazy import)
- CMS backend: `backend/src/routes/public.js` (endpoints `/api/public/site-config`, `/api/public/trusted-companies`)
- CMS admin: `admin-frontend/src/pages/SitioPublico.jsx`
- Migrations CMS: `backend/migrations/20260713*.js` + `backend/migrations/20260718000001_site_landing_companies.js`
- Netlify config: `netlify.toml` (root) + `admin-frontend/netlify.toml`

## Historial de trabajo el día de la auditoría

Hoy (2026-07-19) se mergearon PRs #664-#672 relacionados con la landing y su infra:

- #664/#665: Feature "Empresas que confiaron en Tecny" (backend + admin UI + landing carousel).
- #666: Fix CSP + CORP para logos cross-origin.
- #667: Fix CSP admin (necesitó rebuild manual — origen del hallazgo H2 externo).
- #668: Fix flake test comprobante-email.
- #669: Polish visual del carrusel.
- #670: Workaround Netlify "skip pristine deploys" con timestamp file.
- #671: Fix `<img src>` relativo en `TrustedCompaniesCard` del admin.
- #672: Fix comprobante backend PDF sin canjes (bug Tek Haus).

Este intenso día de fixes es lo que motivó la auditoría. La lección estructural: fallamos en detectar los bugs antes de merge por falta de tests E2E + observabilidad específica.
