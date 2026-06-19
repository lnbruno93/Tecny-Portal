// Login con 2FA E2E.
//
// Cubre el flow completo de login cuando el user tiene 2FA activo:
//   1. Happy path: password OK + TOTP OK → dashboard.
//   2. Sad path: password OK + TOTP incorrecto → queda en form 2FA con error.
//
// Estrategia anti-replay (ver e2e/helpers/twofa.js):
//   Cada test usa su propio `beforeAll` para activar 2FA → genera un secret
//   NUEVO por test. El `afterAll` desactiva (DELETE FROM user_2fa) así
//   `last_used_step` no contamina al siguiente test. Esto es más rápido y
//   determinístico que `waitForTimeout(30_000)`.
//
// Nota sobre el helper de login del flow básico (auth.js): NO lo usamos acá
// porque el helper espera que el redirect a /inicio ocurra inmediatamente
// tras submit. En el flow 2FA, después del primer submit el form muta a
// "Verificación en 2 pasos" — no hay redirect todavía. Replicamos los pasos
// con primitivas de Playwright.

const { test, expect } = require('@playwright/test');
const { TEST_USER } = require('../helpers/globalSetup');
const { enable2faForUser, disable2faForUser, generateTotp } = require('../helpers/twofa');

test.describe('Login con 2FA activo', () => {
  // ─── Test 1: TOTP correcto → entra al dashboard ───
  test.describe('happy path', () => {
    let secret;

    test.beforeAll(async () => {
      // Activamos 2FA vía API antes del test. El secret queda en clausura
      // para que el test genere el TOTP con `generateTotp(secret)`.
      const r = await enable2faForUser(TEST_USER.username, TEST_USER.password);
      secret = r.secret;
    });

    test.afterAll(async () => {
      // Cleanup: desactivar 2FA para no contaminar otros specs.
      // Idempotente — si por alguna razón ya está disabled, no falla.
      await disable2faForUser(TEST_USER.username, TEST_USER.password, secret);
    });

    test('password OK + TOTP OK → dashboard + token JWT', async ({ page }) => {
      // Paso 1: navegar a /login (post-#331 `/` es la landing) y submitear.
      await page.goto('/login');
      await page.getByLabel('Usuario').fill(TEST_USER.username);
      await page.getByLabel('Contraseña', { exact: true }).fill(TEST_USER.password);
      await page.getByRole('button', { name: /Ingresar/i }).click();

      // Paso 2: el form debe mutar al step de 2FA. Heading cambia + aparece
      // el input #login-2fa-code.
      await expect(
        page.getByRole('heading', { name: /Verificación en 2 pasos/i })
      ).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('#login-2fa-code')).toBeVisible();

      // Sanity check: NO debe haber JWT todavía (el step 1 NO logueó).
      const tokenStep1 = await page.evaluate(() => localStorage.getItem('fin_token'));
      expect(tokenStep1, 'JWT no debería existir antes del TOTP').toBeNull();

      // Paso 3: generar TOTP del secret y submitear.
      const code = generateTotp(secret);
      await page.locator('#login-2fa-code').fill(code);
      await page.getByRole('button', { name: /Verificar/i }).click();

      // Paso 4: redirect a /inicio + dashboard renderizado.
      await page.waitForURL(/\/inicio/, { timeout: 10_000 });
      await expect(
        page.getByRole('heading', { name: /Buen día|Buenas tardes|Buenas noches/i }).first()
      ).toBeVisible({ timeout: 10_000 });

      // JWT persistido.
      const token = await page.evaluate(() => localStorage.getItem('fin_token'));
      expect(token, 'JWT debería estar en localStorage tras 2FA OK').toBeTruthy();
      expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    });
  });

  // ─── Test 2: TOTP incorrecto → error, NO entra ───
  test.describe('TOTP incorrecto', () => {
    let secret;

    test.beforeAll(async () => {
      // Secret nuevo (ver nota anti-replay arriba).
      const r = await enable2faForUser(TEST_USER.username, TEST_USER.password);
      secret = r.secret;
    });

    test.afterAll(async () => {
      await disable2faForUser(TEST_USER.username, TEST_USER.password, secret);
    });

    test('password OK + TOTP 000000 → error, no JWT, no redirect', async ({ page }) => {
      // Paso 1: password OK → llegamos al form 2FA (post-#331 `/` es landing).
      await page.goto('/login');
      await page.getByLabel('Usuario').fill(TEST_USER.username);
      await page.getByLabel('Contraseña', { exact: true }).fill(TEST_USER.password);
      await page.getByRole('button', { name: /Ingresar/i }).click();

      await expect(
        page.getByRole('heading', { name: /Verificación en 2 pasos/i })
      ).toBeVisible({ timeout: 10_000 });

      // Paso 2: TOTP inválido.
      await page.locator('#login-2fa-code').fill('000000');
      await page.getByRole('button', { name: /Verificar/i }).click();

      // Paso 3: mensaje de error. Login.jsx muestra el error del backend
      // ("Código 2FA incorrecto.") en .login-err con role="alert".
      // Usamos match laxo en "incorrecto" — robusto si el texto cambia un poco.
      await expect(page.getByRole('alert')).toContainText(/incorrecto/i, { timeout: 10_000 });

      // URL sigue en login (NO redirigió a /inicio).
      await expect(page).not.toHaveURL(/\/inicio/);

      // El form 2FA sigue visible — el user puede reintentar.
      await expect(
        page.getByRole('heading', { name: /Verificación en 2 pasos/i })
      ).toBeVisible();

      // JWT no se guardó.
      const token = await page.evaluate(() => localStorage.getItem('fin_token'));
      expect(token, 'no debería haber JWT tras TOTP fallido').toBeNull();
    });
  });
});

// TODO TANDA-5: test 3 — activar 2FA desde UI Config.
//   El flow es: login normal → Config → tab Seguridad → click "Activar 2FA"
//   → escanear QR (interceptar el secret desde la API) → confirmar.
//   Lo dejamos afuera de esta PR porque requiere navegar varios modales y
//   estabilizar selectores que hoy no existen (necesitaría agregar
//   data-testid en TwoFaSetup.jsx). Mejor en una PR dedicada al flow de
//   setup desde UI, separado de este E2E focal en el login con 2FA activo.
