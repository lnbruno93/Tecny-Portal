// Helpers de auth para tests E2E.
//
// `login(page, { username, password })` — manda la pareja al endpoint y espera
// que el shell renderice /inicio. Usa el flow real (no setea localStorage a
// pelo) para que también cubra el fetch a /api/auth/login y la persistencia
// del token. Si necesitamos saltar el UI por velocidad, hacemos un helper
// distinto vía API directa más adelante.

const { TEST_USER } = require('./globalSetup');

async function login(page, { username = TEST_USER.username, password = TEST_USER.password } = {}) {
  // Post-#331: `/` ahora es la landing comercial pública. El form de login
  // vive en `/login` (ruta explícita agregada en el mismo PR). Antes este
  // helper navegaba a `/` y dependía del AuthContext renderizando <Login />
  // como fallback del AuthGuard — ese patrón se reemplazó por una Route
  // dedicada. Para tests de auth puro, ir directo a `/login` es más rápido
  // y estable que pasar por el nav de la landing.
  await page.goto('/login');
  // exact:true en 'Contraseña' para no matchear el botón "Mostrar contraseña"
  // (toggle del ojito que tiene aria-label que incluye la palabra).
  await page.getByLabel('Usuario').fill(username);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: /Ingresar/i }).click();
  // Esperamos a que se redirija (el index Route hace Navigate a /inicio).
  await page.waitForURL(/\/inicio/, { timeout: 10_000 });
}

module.exports = { login, TEST_USER };
