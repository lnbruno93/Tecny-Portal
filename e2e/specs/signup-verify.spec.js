// Signup + verify-email + portal access E2E — TANDA 2.x flow completo.
//
// Cubre el camino crítico de onboarding (HIGH Tests gap del audit 2026-06-17):
//   1. User va a /signup y crea cuenta (tenant + user owner, role=op, unverified).
//   2. Backend responde 200 genérico — anti-enum (TANDA 2.7). Frontend muestra
//      pantalla "Revisá tu email" SIN auto-login.
//   3. Test extrae token de verificación desde DB (en prod llega por Resend).
//   4. User clickea link → /verify-email?token=<hex> → useEffect verifica.
//   5. Tras 2.5s VerifyEmail redirige a /. AuthGuard ve user no logueado y
//      muestra Login.
//   6. User hace login con el email recién verificado → entra a /inicio.
//   7. UnverifiedBanner NO aparece (email ya verified). Escritura habilitada.
//
// También cubre el caso anti-enum: signup con email ya registrado responde
// con la MISMA pantalla "Revisá tu email" (no se distingue del caso nuevo)
// y NO crea un segundo user en DB.

const { test, expect } = require('@playwright/test');
const {
  getVerificationToken,
  countUsersByEmail,
  expireVerificationToken,
} = require('../helpers/signup');

// Genera un email único por test. timestamp + random evita colisiones cuando
// dos tests del mismo file corren back-to-back en el mismo segundo.
function uniqueEmail(prefix = 'e2e') {
  const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${uniq}@example.com`;
}

// Helper: llena el form de signup y submitea. NO espera el redirect — el
// caller decide qué assertion hacer después (sino el helper se acoplaría
// al flow del happy path).
async function fillSignupAndSubmit(page, { nombre, email, password, empresa }) {
  await page.goto('/signup');
  // Audit 2026-07-04 P3: labels llevan asterisco rojo `*` (ej. "Tu nombre *").
  // Usamos regex `/^X/` para tolerar el marker de required sin romper el E2E
  // si mañana cambiamos la marca visual. Contraseña con `/^Contraseña/` (no $)
  // porque el label es "Contraseña *" — el `^` evita colisión con eventuales
  // "Confirmar contraseña".
  await page.getByLabel(/^Tu nombre/).fill(nombre);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Contraseña/).fill(password);
  await page.getByLabel(/^Nombre de tu empresa/).fill(empresa);
  await page.getByRole('button', { name: /crear cuenta/i }).click();
}

test.describe('Signup → verify-email → portal access', () => {
  test('happy path: signup, verify, login, llega a /inicio sin banner unverified', async ({ page }) => {
    const email = uniqueEmail('happy');
    const password = 'TestPass1234!';
    const empresa = 'Empresa E2E Happy';

    // 1) Signup completo. La response del backend es 200 con
    //    { verification_required: true } y SIN token (TANDA 2.7 anti-enum).
    await fillSignupAndSubmit(page, {
      nombre: 'Test User Happy',
      email,
      password,
      empresa,
    });

    // 2) Frontend muestra pantalla "Revisá tu email" — NO redirige a /inicio.
    //    Esto es la diferencia clave vs. pre-TANDA-2.7 (donde había auto-login).
    await expect(page.getByRole('heading', { name: /revisá tu email/i }))
      .toBeVisible({ timeout: 10_000 });
    // El email submitido aparece en la pantalla.
    await expect(page.getByText(email)).toBeVisible();
    // NO se persistió token (no hay auto-login).
    const tokenAfterSignup = await page.evaluate(() => localStorage.getItem('fin_token'));
    expect(tokenAfterSignup).toBeNull();

    // 3) Extraemos el verification token desde DB (en prod llegaría por email).
    const verifyToken = await getVerificationToken(email);
    expect(verifyToken).toMatch(/^[0-9a-f]{64}$/);

    // 4) Visitamos el link del email — VerifyEmail.jsx auto-verifica en useEffect.
    //
    // TANDA 5 fix M4 auditoría 2026-06-17: capturamos las responses del API
    // verify-email para distinguir el path "first call success" del path
    // "subsequent already_used". En dev React StrictMode hace que useEffect
    // corra 2× → 2 calls al API. En prod (sin StrictMode) hay 1 sola call.
    // Lo que NUNCA debería pasar (en NINGÚN entorno) es que el PRIMER call
    // devuelva ok=false — eso sería un bug de regresión que el test debe
    // cazar. La assertion del heading sigue siendo broad por StrictMode,
    // pero la del primer API response cubre lo que el audit pidió.
    const verifyResponses = [];
    page.on('response', async (response) => {
      if (response.url().endsWith('/api/auth/verify-email')) {
        try {
          verifyResponses.push({
            status: response.status(),
            body: await response.json(),
          });
        } catch { /* body parse fail — record status only */ }
      }
    });
    await page.goto(`/verify-email?token=${verifyToken}`);

    // 5) Aparece el estado de éxito Y redirige a / tras 2.5s.
    //    En dev, React StrictMode hace que useEffect corra 2 veces — el
    //    primer call consume el token (status='success'), el segundo ve
    //    already_used (status='already'). Ambos estados son "verified OK"
    //    y redirigen. En prod (sin StrictMode) solo se ve 'success'.
    //    Aceptamos cualquiera de los dos headings VISIBLES; el API check
    //    abajo locka que el PRIMER call siempre fue success real.
    await expect(
      page.getByRole('heading', {
        name: /listo.*email verificado|este email ya estaba verificado/i,
      })
    ).toBeVisible({ timeout: 10_000 });

    // El primer API call al verify-email DEBE ser un éxito real (status 200,
    // ok:true). Sin esto un mapping erróneo expired→success no se cazaría.
    expect(verifyResponses.length).toBeGreaterThanOrEqual(1);
    expect(verifyResponses[0].status).toBe(200);
    expect(verifyResponses[0].body && verifyResponses[0].body.ok).toBe(true);
    // Esperamos el redirect a / (que muestra Login porque no hay sesión).
    await page.waitForURL((url) => !url.pathname.startsWith('/verify-email'), {
      timeout: 5_000,
    });
    await expect(page.getByRole('heading', { name: /ingresá a tu portal/i }))
      .toBeVisible();

    // 6) Login normal con el email recién verificado.
    await page.getByLabel('Usuario o email').fill(email);
    await page.getByLabel('Contraseña', { exact: true }).fill(password);
    await page.getByRole('button', { name: /^ingresar/i }).click();
    await page.waitForURL(/\/inicio/, { timeout: 10_000 });

    // 7) Estamos en /inicio. UnverifiedBanner NO debería estar (email_verified=true).
    //    El banner tiene texto "Verificá tu email" — si NO aparece, está OK.
    await expect(page.getByText(/verificá tu email/i)).not.toBeVisible();

    // Sanity: token JWT persistido (login exitoso).
    const token = await page.evaluate(() => localStorage.getItem('fin_token'));
    expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  test('anti-enum: signup con email ya registrado muestra MISMA pantalla "Revisá tu email" + NO crea segundo user', async ({ page }) => {
    // Primero, creamos un user (sin verificar — no importa para este test).
    const email = uniqueEmail('dup');
    const password = 'TestPass1234!';
    await fillSignupAndSubmit(page, {
      nombre: 'First Signup',
      email,
      password,
      empresa: 'Empresa Dup 1',
    });
    await expect(page.getByRole('heading', { name: /revisá tu email/i }))
      .toBeVisible({ timeout: 10_000 });

    // Sanity: hay 1 user con ese email.
    expect(await countUsersByEmail(email)).toBe(1);

    // Ahora, segundo signup con el MISMO email (variante en mayúsculas para
    // testar case-insensitive). Datos diferentes en nombre/empresa para
    // descartar que el backend esté matcheando por otro campo.
    await fillSignupAndSubmit(page, {
      nombre: 'Second Signup Attempt',
      email: email.toUpperCase(),
      password,
      empresa: 'Empresa Dup 2',
    });

    // La pantalla es IDÉNTICA a la del happy path. Nada en la UI distingue
    // "email nuevo" de "email duplicado" — anti-enum garantizado.
    await expect(page.getByRole('heading', { name: /revisá tu email/i }))
      .toBeVisible({ timeout: 10_000 });
    // El email que se muestra es lowercase normalizado (el frontend lo
    // normaliza antes de submit, lo que es UX coherente).
    await expect(page.getByText(email.toLowerCase())).toBeVisible();

    // NO se creó un user nuevo: sigue habiendo 1 con ese email.
    expect(await countUsersByEmail(email)).toBe(1);
  });

  test('T6: verify-email con token expirado muestra error claro (no "verificado")', async ({ page }) => {
    // TANDA 2 fix T6 auditoría 2026-06-17: el backend cubre reason="expired"
    // en signup.test.js, pero el frontend renderizando ese reason no tenía
    // E2E. Si VerifyEmail.jsx olvida renderizar el reason o lo mapea mal,
    // el user ve mensaje confuso. Este test lockea el flow real.
    const email = `expired_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
    await fillSignupAndSubmit(page, {
      nombre: 'Expired Token User',
      email,
      password: 'TestPass1234!',
      empresa: 'Empresa Expired',
    });
    await expect(page.getByRole('heading', { name: /revisá tu email/i }))
      .toBeVisible({ timeout: 10_000 });

    const verifyToken = await getVerificationToken(email);
    // Forzamos el token vencido vía DB.
    await expireVerificationToken(verifyToken);

    // Visitamos el link "viejo".
    await page.goto(`/verify-email?token=${verifyToken}`);

    // VerifyEmail.jsx debería mostrar el estado 'error' con mensaje claro.
    await expect(page.getByRole('heading', { name: /no se pudo verificar/i }))
      .toBeVisible({ timeout: 10_000 });
    // El mensaje del backend (reason="expired") debe llegar al texto visible.
    await expect(page.getByText(/expir/i)).toBeVisible();

    // El CTA "Iniciá sesión" sigue ahí — el user puede recuperarse pidiendo
    // un email nuevo desde el banner del dashboard post-login.
    await expect(page.getByRole('link', { name: /iniciá sesión/i })).toBeVisible();

    // U6 verificación a11y: el card tiene role="alert" + aria-live="assertive"
    // (no "polite") cuando hay error → screen reader interrumpe lectura.
    const alertCard = page.locator('[role="alert"]');
    await expect(alertCard).toBeVisible();
    await expect(alertCard).toHaveAttribute('aria-live', 'assertive');
  });
});
