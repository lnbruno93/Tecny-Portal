// Landing pública E2E — Sprint 2 M2 del roadmap post-auditoría.
//
// Cubre lo que la auditoría (docs/AUDIT_LANDING_2026-07-19.md) identificó
// como los bugs de detección tardía del día 2026-07-19:
//   - Logos rotos por CSP mal aplicada (PRs #666, #667, #670, #671).
//   - JSON-LD ausente (PR #674).
//   - Meta tags SEO faltantes (PR #674).
//
// Cada test que sigue habría atrapado uno de esos bugs ANTES del merge:
//   1. Smoke — la landing responde 200 y no tira errores JS.
//   2. Meta tags OG/Twitter — validan el share preview.
//   3. JSON-LD — Google reconoce el SaaS.
//   4. CTA "Empezá gratis" navega a /signup.
//   5. Sección Empresas con logos — cada <img> del carrusel carga sin
//      naturalWidth === 0 (broken image detection).
//   6. Sección Contacto — datos del CMS visibles.
//
// Estrategia: interceptamos las llamadas al backend con `page.route()` y
// devolvemos fixtures fijas. Esto:
//   - Hace los tests deterministicos (no dependen del estado real del CMS).
//   - Evita tocar la DB de e2e (la landing es pre-auth, no hay que setupear
//     tenant/user como en los otros specs).
//   - Corren rápido (~2s por test, sin backend real involved en los fetches
//     del CMS).

const { test, expect } = require('@playwright/test');

// ── Fixtures del backend público ────────────────────────────────────────

const MOCK_PRICING = { prices: { starter: 39, pro: 189 }, currency: 'USD', period: 'monthly' };

const MOCK_SITE_CONFIG = {
  contact: {
    email:            'hola@tecnyapp.com',
    whatsapp:         '5491126165007',
    whatsapp_display: '+54 9 11 2616-5007',
    address:          'Buenos Aires, Argentina',
    instagram_handle: 'tecny.app',
    instagram_url:    'https://instagram.com/tecny.app',
  },
  hero:  { headline: 'Todo tu negocio', subheadline: null, blurb: 'Test blurb' },
  cta:   { headline: 'Test CTA', body: 'Test body' },
  faq:   [],
  testimonials: [],
  footer: null,
  updated_at: '2026-07-19T00:00:00Z',
};

const MOCK_TRUSTED_COMPANIES = {
  companies: [
    { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', nombre: 'TestCo Uno', position: 0 },
    { id: 'ffffffff-1111-2222-3333-444444444444', nombre: 'TestCo Dos', position: 1 },
  ],
};

// PNG 1×1 negro (67 bytes) — devolvemos este blob para el endpoint /logo. El
// browser lo carga OK → naturalWidth queda en 1 (no 0 = broken).
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=';

/**
 * Instala rutas mock para los 3 endpoints públicos del CMS + el endpoint del
 * blob del logo. Todas las rutas responden 200 con Cache-Control y CORP
 * correctos, replicando lo que el backend real hace en prod. Filtro por regex
 * porque en dev/E2E el backend queda en :3001 y en prod en Railway; ambos
 * deben interceptarse.
 */
async function mockLandingApis(page, { companies = MOCK_TRUSTED_COMPANIES } = {}) {
  await page.route(/\/api\/public\/pricing/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PRICING) }),
  );
  await page.route(/\/api\/public\/site-config/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_SITE_CONFIG) }),
  );
  await page.route(/\/api\/public\/trusted-companies$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(companies) }),
  );
  await page.route(/\/api\/public\/trusted-companies\/.+\/logo/, (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400, immutable',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
      body: Buffer.from(PNG_1x1_BASE64, 'base64'),
    }),
  );
}

test.describe('Landing pública', () => {
  test('smoke: carga con status 200 y sin errores JS en console', async ({ page }) => {
    const errors = [];
    // Capturamos errores JS + errores de red (fetch fallidos) para asertar
    // que ninguno ocurre durante el load inicial.
    //
    // Filtro `AbortError`: React 18 StrictMode en dev dispara double-mount →
    // el primer cleanup aborta los fetches → catch → si algún path se
    // escapa del filtro de reportLandingError, no queremos hacer flaky el
    // test por eso. Son cleanup benignos, no bugs.
    const IGNORE = /AbortError|signal is aborted|The operation was aborted/i;
    page.on('pageerror', (err) => {
      if (!IGNORE.test(err.message)) errors.push({ type: 'pageerror', msg: err.message });
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !IGNORE.test(msg.text())) {
        errors.push({ type: 'console', msg: msg.text() });
      }
    });

    await mockLandingApis(page);
    const res = await page.goto('/');
    expect(res.status()).toBe(200);

    // Espera a que la landing esté ready (el evento del dataLayer del Sprint 1 H3).
    await page.waitForFunction(
      () => (window.dataLayer || []).some((e) => e.event === 'landing_content_ready'),
      { timeout: 15_000 },
    );

    // Cero errores JS o console.error durante el ciclo de vida completo.
    expect(errors, `Errors detectados: ${JSON.stringify(errors, null, 2)}`).toEqual([]);
  });

  test('SEO: meta tags OG/Twitter/canonical presentes', async ({ page }) => {
    await mockLandingApis(page);
    await page.goto('/');

    // Título y description base.
    await expect(page).toHaveTitle(/Tecny.*revendedores/i);
    const description = await page.locator('meta[name="description"]').getAttribute('content');
    expect(description).toMatch(/comprobantes|cuentas corrientes|caja/i);

    // Open Graph — WhatsApp/Slack/LinkedIn scrapean estos.
    const ogTitle = await page.locator('meta[property="og:title"]').getAttribute('content');
    const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
    const ogType  = await page.locator('meta[property="og:type"]').getAttribute('content');
    expect(ogTitle).toMatch(/Tecny/);
    expect(ogImage).toMatch(/^https:\/\//);
    expect(ogType).toBe('website');

    // Twitter Card.
    const twitterCard = await page.locator('meta[name="twitter:card"]').getAttribute('content');
    expect(twitterCard).toBe('summary_large_image');

    // Canonical (evita duplicate content).
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical).toMatch(/^https:\/\/tecnyapp\.com\/?$/);
  });

  test('SEO: JSON-LD SoftwareApplication con offers válido', async ({ page }) => {
    await mockLandingApis(page);
    await page.goto('/');

    // Debe existir exactamente un bloque application/ld+json en la landing.
    const ldJsonRaw = await page.locator('script[type="application/ld+json"]').textContent();
    expect(ldJsonRaw).toBeTruthy();

    // Debe parsear como JSON válido — si Google intenta parsearlo y falla,
    // el sitio no aparece en rich results.
    const data = JSON.parse(ldJsonRaw);
    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('SoftwareApplication');
    expect(data.name).toBe('Tecny');
    expect(Array.isArray(data.offers)).toBe(true);
    expect(data.offers.length).toBeGreaterThan(0);
    // Cada offer tiene price + priceCurrency (mínimo para rich results).
    for (const offer of data.offers) {
      expect(offer['@type']).toBe('Offer');
      expect(offer.price).toMatch(/^\d+$/);
      expect(offer.priceCurrency).toBe('USD');
    }
  });

  test('CTA hero: click en "Empezá gratis" navega a /signup', async ({ page }) => {
    await mockLandingApis(page);
    await page.goto('/');

    // El hero tiene "Empezá gratis" como primer CTA primario.
    const heroCta = page.getByRole('link', { name: /Empezá gratis/i }).first();
    await expect(heroCta).toBeVisible();
    await heroCta.click();

    await expect(page).toHaveURL(/\/signup$/);
  });

  test('Sección Empresas: los logos del carrusel cargan (no rota la imagen)', async ({ page }) => {
    await mockLandingApis(page);
    await page.goto('/');

    // Esperar primero a que el fetch del CMS haya persistido las empresas
    // (React StrictMode en dev hace double-mount → puede que la 1ra pasada
    // se aborte). `landing_content_ready` se dispara cuando los 3 hooks
    // resolvieron; después la sección `#empresas` aparece si hay logos.
    await page.waitForFunction(
      () => (window.dataLayer || []).some((e) => e.event === 'landing_content_ready'),
      { timeout: 15_000 },
    );
    const section = page.locator('#empresas');
    await expect(section).toBeVisible({ timeout: 5_000 });

    // El carrusel duplica las empresas (set A + set B) → esperamos 4 <img>.
    // Verificamos que cada uno haya CARGADO (naturalWidth > 0). Si el CSP o
    // el CORP están mal, `naturalWidth === 0` — el bug del día 2026-07-19.
    const imgs = section.locator('img');
    await expect(imgs).toHaveCount(4);
    await page.waitForFunction(() => {
      const imgs = document.querySelectorAll('#empresas img');
      return imgs.length === 4 && Array.from(imgs).every((img) => img.complete && img.naturalWidth > 0);
    }, { timeout: 15_000 });
  });

  test('Sección Empresas: cero empresas → sección oculta (fail-open)', async ({ page }) => {
    // Con companies vacías, la sección NO debe renderizarse — no queremos
    // "Empresas que confiaron: (vacío)" horrible.
    await mockLandingApis(page, { companies: { companies: [] } });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('#empresas')).toHaveCount(0);
  });

  test('Sección Contacto: muestra email + whatsapp del CMS', async ({ page }) => {
    await mockLandingApis(page);
    await page.goto('/');

    // El fetch de site-config es async — esperamos a que reemplace los defaults.
    await page.waitForFunction(
      () => (window.dataLayer || []).some((e) => e.event === 'landing_content_ready'),
      { timeout: 10_000 },
    );

    // Los datos del mock deben aparecer en la sección Contacto (líneas
    // ~805-870 de Landing.jsx). El WhatsApp está en un link wa.me.
    await expect(page.locator('a[href*="wa.me"]')).toHaveCount(1);
    const waHref = await page.locator('a[href*="wa.me"]').getAttribute('href');
    expect(waHref).toContain('5491126165007');

    // Email es un mailto:.
    await expect(page.locator('a[href^="mailto:hola@tecnyapp.com"]')).toHaveCount(1);
  });
});
