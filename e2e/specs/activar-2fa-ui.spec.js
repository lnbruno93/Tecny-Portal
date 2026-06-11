// Activar 2FA desde UI — E2E (TANDA 5).
//
// Cubre el flow happy path de activar 2FA desde el portal real (UI), que es
// como lo va a hacer un user de carne y hueso:
//   1. Login normal (sin 2FA) → /inicio.
//   2. Navegar a /config y clickear la tab "Seguridad".
//   3. Click "Activar 2FA" → aparece TwoFaSetup (QR + secret manual + recovery
//      codes + input de verificación).
//   4. Leer el secret base32 del DOM (data-testid="twofa-secret"), generar el
//      TOTP con el helper compartido, tipear el código, click "Activar 2FA".
//   5. Verificar que el componente muta al estado "Activo" (badge + acciones
//      "Desactivar" / "Regenerar recovery codes").
//
// El test del login con 2FA activo (login-2fa.spec.js) activa el 2FA vía API
// para no acoplar el flow de login al setup. Acá hacemos el opuesto:
// ejercitamos el flow de SETUP desde la UI. Los dos son complementarios.
//
// Cleanup (afterEach):
//   `disable2faForUser` borra el row de user_2fa direct en DB. Esto:
//     1. Es idempotente (DELETE rowCount=0 si ya está disabled, no falla).
//     2. Evita el problema de anti-replay (ver e2e/helpers/twofa.js):
//        el TOTP recién consumido y el siguiente caen en el mismo step de
//        30s y el segundo es rechazado. Con DELETE directo, el próximo
//        enable arranca con last_used_step=0 y secret nuevo.
//   Por eso usamos afterEach (no afterAll): si el test falla a mitad con 2FA
//   ya activo, el cleanup igual corre y deja la DB limpia para los siguientes
//   specs de la suite (el orden de specs no es estable).
//
// Selectores — decisiones:
//   · El botón inicial "Activar 2FA" (en TwoFaSection, estado no configurado)
//     y el botón final "Activar 2FA" (en TwoFaSetup, paso 3) tienen el mismo
//     texto. No usamos un getByRole genérico — disambiguamos por contexto:
//       - El inicial es el único visible cuando todavía no clickeamos: lo
//         buscamos con `getByRole('button', { name: /Activar 2FA/ })` y
//         confiamos en que sea único en ese momento.
//       - Tras clickearlo, montamos el setup. El botón final convive con
//         "Cancelar" en el form de verificación. Lo buscamos por contexto
//         dentro del form (locator de form > button[type=submit]).
//   · El secret se lee por data-testid="twofa-secret" — único cambio a
//     production code de esta PR, justificado en TwoFaSetup.jsx.

const { test, expect } = require('@playwright/test');
const { login, TEST_USER } = require('../helpers/auth');
const { disable2faForUser, generateTotp } = require('../helpers/twofa');

test.describe('Activar 2FA desde UI Config', () => {
  // Cleanup defensivo: si el test deja 2FA activo (haya pasado o fallado),
  // el DELETE directo en DB lo desactiva. Idempotente — si no había nada,
  // no falla. Ver bloque "Anti-replay" en e2e/helpers/twofa.js.
  test.afterEach(async () => {
    await disable2faForUser(TEST_USER.username, TEST_USER.password);
  });

  test('flow completo: setup → QR + secret → verify TOTP → estado activo', async ({ page }) => {
    // ── Paso 1: login normal sin 2FA ───────────────────────────────────────
    await login(page);
    await expect(page).toHaveURL(/\/inicio/);

    // ── Paso 2: ir a /config y clickear tab Seguridad ──────────────────────
    // Navegación directa por URL — el portal soporta deep-link al hash de tab
    // (#seguridad), pero queremos ejercitar el flow real: aterrizar en /config
    // y elegir la tab desde el UI. Si en el futuro removemos los buttons-tab
    // (ej. por dropdown), este test atrapa el cambio.
    await page.goto('/config');
    await page.getByRole('button', { name: /Seguridad/ }).click();

    // Sanity: el badge "No activado" y el botón inicial deben estar visibles.
    // El estado "Activo" usa otro badge — si por alguna razón el cleanup
    // anterior falló, esto va a fallar fuerte con un mensaje claro.
    await expect(page.getByText('No activado')).toBeVisible({ timeout: 10_000 });
    const startBtn = page.getByRole('button', { name: 'Activar 2FA' });
    await expect(startBtn).toBeVisible();

    // ── Paso 3: arrancar el flow de setup ──────────────────────────────────
    //
    // OJO React StrictMode (dev): el useEffect mount-only de TwoFaSetup
    // dispara POST /api/auth/2fa/setup DOS veces en paralelo en dev. Cada
    // setup overwrites el row user_2fa (mismo user, ON CONFLICT update). Si
    // hacemos enable entre setup#1 commit y setup#2 commit, el enable
    // verifica contra el row de setup#1 (OK) PERO setup#2 commitea después
    // y pisa el enabled_at=NOW() con NULL → queda configurado-pero-no-active.
    //
    // En producción StrictMode no aplica → solo hay 1 setup → no hay race.
    // El test corre contra `vite dev` (sí StrictMode) → necesitamos esperar
    // a que el SEGUNDO setup termine antes de tipear el TOTP. El secret en
    // DOM ya refleja el final (whichever setSetupData() corre último), pero
    // el row del backend sigue mutando hasta que ambas responses lleguen.
    //
    // Estrategia: contar responses a /api/auth/2fa/setup y esperar a que el
    // contador se estabilice 500ms (timing-agnostic — vale para 1 o 2 setups).
    let setupResponses = 0;
    const countSetup = (resp) => {
      if (
        resp.url().endsWith('/api/auth/2fa/setup') &&
        resp.request().method() === 'POST'
      ) setupResponses += 1;
    };
    page.on('response', countSetup);

    await startBtn.click();

    // El TwoFaSetup hace POST /api/auth/2fa/setup al montar. Esperamos que
    // el setupData esté listo (el heading "Activar autenticación de dos
    // factores" aparece sólo después).
    await expect(
      page.getByRole('heading', { name: /Activar autenticación de dos factores/i })
    ).toBeVisible({ timeout: 10_000 });

    // Esperar a que el contador de setups se estabilice 500ms → en dev
    // llegan 2 responses casi simultáneas; en prod llega 1 sola. Salimos cuando
    // pasaron 500ms sin nuevas responses.
    let last = setupResponses, stable = 0;
    while (stable < 500) {
      await page.waitForTimeout(100);
      if (setupResponses === last) stable += 100;
      else { last = setupResponses; stable = 0; }
    }
    page.off('response', countSetup);

    // ── Paso 4: extraer secret del DOM ─────────────────────────────────────
    // Tras el wait anterior, el secret en DOM coincide con el row en backend.
    const secretEl = page.getByTestId('twofa-secret');
    await expect(secretEl).toBeVisible();
    const secret = (await secretEl.textContent())?.trim();
    expect(secret, 'secret base32 debe leerse del DOM').toBeTruthy();
    // Sanity: speakeasy genera secrets base32 — sólo letras A-Z y dígitos 2-7.
    // Si esto cambia, el test sigue funcionando — sólo queremos atrapar un
    // DOM vacío o un format inesperado (HTML escapado, espacios, etc.).
    expect(secret).toMatch(/^[A-Z2-7]+$/);

    // ── Paso 5: generar TOTP y verificar ───────────────────────────────────
    const code = generateTotp(secret);

    // El input de verificación: usamos el id que ya está en TwoFaSetup.jsx
    // (#twofa-verify-code). Es estable y no compite con otros inputs.
    await page.locator('#twofa-verify-code').fill(code);

    // El botón "Activar 2FA" del paso 3 (final). Conviene anclar por contexto:
    // está dentro de un <form> que tiene el input #twofa-verify-code.
    // El botón inicial ya no existe en el DOM (TwoFaSection cambió a setup).
    await page.getByRole('button', { name: 'Activar 2FA' }).click();

    // ── Paso 6: verificar estado activo ────────────────────────────────────
    // El flow termina en 2 etapas:
    //   a) TwoFaSetup muestra step='done' (heading "2FA activado") por 800ms.
    //   b) onDone() en TwoFaSection: setShowSetup(false) + refresh status.
    //      Render entra a la rama enabled=true → muestra "Desactivar 2FA",
    //      "Regenerar recovery codes" y "Activado el ...".
    // Anclamos directamente al hito final ("Desactivar 2FA" — único en la
    // rama enabled). Match laxo del state intermedio fue flaky en local —
    // el badge "Activo" puede no aparecer si el refresh tarda. Mejor esperar
    // a algo que sólo existe en estado activo.
    await expect(
      page.getByRole('button', { name: /Desactivar 2FA/ })
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('button', { name: /Regenerar recovery codes/ })
    ).toBeVisible();
    // Texto "Activado el ..." es exclusivo del estado enabled — sanity check
    // de que NO estamos viendo otra pantalla con un botón de mismo nombre.
    await expect(page.getByText(/Activado el/)).toBeVisible();
  });
});
