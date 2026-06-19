// Login E2E — primer flow real del portal.
//
// Cubre 3 casos:
//   1. Happy path → dashboard + token JWT en localStorage('fin_token').
//   2. Password incorrecto → URL queda en /login, mensaje de error visible.
//   3. Logout → click en botón con title="Cerrar sesión", redirect a /login,
//      localStorage sin token.
//
// IMPORTANTE: el AuthContext guarda el JWT en localStorage('fin_token'), no en
// cookies httpOnly. Si en el futuro migramos a cookies, hay que actualizar
// la aserción del token.

const { test, expect } = require('@playwright/test');
const { login, TEST_USER } = require('../helpers/auth');

test.describe('Login flow', () => {
  test('happy path: usuario válido entra al dashboard', async ({ page }) => {
    await login(page);

    // Estamos en /inicio
    await expect(page).toHaveURL(/\/inicio/);

    // El header del dashboard muestra el saludo "Buen día/tardes/noches, X"
    // (Inicio.jsx renderiza un <h1> dinámico). Match laxo por las 3 variantes.
    await expect(
      page.getByRole('heading', { name: /Buen día|Buenas tardes|Buenas noches/i }).first()
    ).toBeVisible({ timeout: 10_000 });

    // El token JWT quedó persistido en localStorage('fin_token').
    const token = await page.evaluate(() => localStorage.getItem('fin_token'));
    expect(token, 'token JWT no quedó en localStorage').toBeTruthy();
    // Sanity check: forma JWT (3 segmentos base64 separados por '.').
    expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  test('password incorrecto: NO redirige al dashboard y muestra error', async ({ page }) => {
    // Post-#331: `/` es la landing; el form de login vive en `/login`.
    await page.goto('/login');
    await page.getByLabel('Usuario').fill(TEST_USER.username);
    await page.getByLabel('Contraseña', { exact: true }).fill('wrong-password-zzz');
    await page.getByRole('button', { name: /Ingresar/i }).click();

    // El mensaje de error es exacto — viene de Login.jsx (handleSubmit catch).
    // role="alert" + aria-live garantizan que sea visible inmediatamente.
    await expect(page.getByRole('alert')).toContainText('Usuario o contraseña incorrectos');

    // URL NO debe redirigir a /inicio (el form de login sigue arriba).
    await expect(page).not.toHaveURL(/\/inicio/);
    await expect(
      page.getByRole('heading', { name: /Ingresá a tu portal/i })
    ).toBeVisible();

    // Token NO se guardó.
    const token = await page.evaluate(() => localStorage.getItem('fin_token'));
    expect(token).toBeNull();
  });

  test('logout: cierra sesión y muestra el form de login otra vez', async ({ page }) => {
    await login(page);

    // Sanity check: estamos logueados.
    const tokenBefore = await page.evaluate(() => localStorage.getItem('fin_token'));
    expect(tokenBefore).toBeTruthy();

    // El botón de logout vive en UserPill (sidebar) con title="Cerrar sesión".
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();

    // Tras logout, el AuthContext setea user=null y RequireAuth muestra <Login />.
    // La URL puede o no cambiar a /login (depende de cómo el shell ruta), pero
    // sí debe verse el form de login otra vez.
    await expect(
      page.getByRole('heading', { name: /Ingresá a tu portal/i })
    ).toBeVisible({ timeout: 5_000 });

    // Token borrado.
    const tokenAfter = await page.evaluate(() => localStorage.getItem('fin_token'));
    expect(tokenAfter).toBeNull();
  });
});
