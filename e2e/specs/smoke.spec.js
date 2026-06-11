// Smoke test mínimo — verifica que el webServer arrancó y la página /login
// se renderiza. Es el "está vivo todo" check antes de los flows reales.

const { test, expect } = require('@playwright/test');

test('login screen renderiza', async ({ page }) => {
  await page.goto('/login');
  // El form tiene heading "Ingresá a tu portal" (rediseño split-screen).
  await expect(page.getByRole('heading', { name: /Ingresá a tu portal/i })).toBeVisible();
  // Y el botón principal.
  await expect(page.getByRole('button', { name: /Ingresar/i })).toBeVisible();
});
