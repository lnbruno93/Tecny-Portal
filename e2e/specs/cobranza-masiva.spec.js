// Cobranza masiva B2B E2E — registrar N pagos en bloque sobre clientes CC.
//
// Cubre el happy path mínimo del modal CobranzaMasivaModal (la planilla de
// pagos masivos del módulo Venta & Gestión B2B):
//   1. Pre-condición vía API: crear 2 clientes CC con deuda inicial.
//      - Cliente A E2E Cob: deuda 500 USD.
//      - Cliente B E2E Cob: deuda 300 USD.
//      (saldo_inicial del POST /api/cuentas/clientes genera el movimiento_cc
//      'saldo_inicial' que computa como deuda.)
//   2. Login UI como testadmin → /cuentas (vista global, sin cliente
//      seleccionado).
//   3. Click "Cobranza masiva" → abre modal con planilla.
//   4. En el modal:
//      - Fila 1: pickear Cliente A → monto 200 USD → caja "USD | Efectivo".
//      - Fila 2: pickear Cliente B → monto 300 USD → caja "USD | Efectivo".
//   5. Submit → modal cierra (no hay confirm; toast success + onSaved).
//   6. Verificación vía API: GET /api/cuentas/clientes muestra saldos
//      actualizados:
//        - Cliente A: 500 - 200 = 300 (sigue debiendo).
//        - Cliente B: 300 - 300 = 0   (saldado).
//
// Decisiones de selectores:
//   - Modal por aria-labelledby="cobranza-masiva-modal-title".
//   - Filas por data-testid="cobranza-row" (agregado en commit anterior) +
//     nth(idx). La planilla arranca con 8 filas vacías, así que .nth(0/1)
//     son los slots libres iniciales.
//   - ClientePicker scopeado por su placeholder único "Buscar cliente…".
//     Tipear ≥2 chars dispara fetch a /api/cuentas/clientes/search; el
//     dropdown muestra "Saldo USD N.NN" — usamos ese texto para el .click()
//     porque solo aparece dentro del dropdown (no en el input).
//   - Monto: el único input type=number visible en la fila (los TC se
//     muestran solo cuando la caja no es USD; con USD | Efectivo se ocultan
//     y el única numeric input es el monto). Lo localizamos por placeholder="0".
//   - Caja: el primer <select> de la fila (hay 2 selects: caja + tipo de
//     pago). Usamos label "USD | Efectivo (USD)" del seed globalSetup.
//   - Submit por data-testid="cobranza-submit" (label muta con la cantidad
//     de filas usadas → "Guardar cobranzas (2)" / "Guardando…").
//
// Lo que NO cubre (otros specs / futuros PRs):
//   - Cobranza con monedas mixtas (ARS + USD con TC).
//   - Edición / borrado de una cobranza ya hecha.
//   - Verificación del impacto en la caja (caja_movimientos).
//   - Sobrepago (cliente queda con saldo a favor).

const { test, expect } = require('@playwright/test');
const { login } = require('../helpers/auth');
const { seedClientesConDeuda, getSaldosByIds } = require('../helpers/cobranzaMasiva');

test.describe('Cobranza masiva B2B — registro en bloque', () => {
  test('happy path: 2 cobranzas → saldos actualizados (300 + 0 USD)', async ({ page }) => {
    // ── Pre-condición vía API ────────────────────────────────────────────
    // 2 clientes CC con deuda inicial. saldo_inicial > 0 genera un
    // movimientos_cc tipo 'saldo_inicial' que suma al saldo del cliente.
    const [clienteA, clienteB] = await seedClientesConDeuda([
      { name: 'Cliente A E2ECob', deuda: 500 },
      { name: 'Cliente B E2ECob', deuda: 300 },
    ]);
    expect(Number(clienteA.saldo)).toBe(500);
    expect(Number(clienteB.saldo)).toBe(300);

    // ── Login + nav ──────────────────────────────────────────────────────
    await login(page);
    await page.goto('/cuentas');
    await expect(page.getByRole('heading', { name: 'Venta & Gestión B2B' })).toBeVisible();

    // ── Abrir modal "Cobranza masiva" ────────────────────────────────────
    await page.getByRole('button', { name: /Cobranza masiva/i }).click();

    const modal = page.locator('[role="dialog"][aria-labelledby="cobranza-masiva-modal-title"]');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('heading', { name: 'Cobranza masiva' })).toBeVisible();

    // El modal carga cajas async vía /api/cajas/cajas. Esperamos a que
    // aparezca la option "USD | Efectivo (USD)" en al menos un select.
    // Cada fila tiene su propio select de caja → usamos el primero.
    const fila1 = modal.getByTestId('cobranza-row').nth(0);
    const cajaSelect1 = fila1.locator('select').first();
    await expect(cajaSelect1.locator('option', { hasText: 'USD | Efectivo' }))
      .toHaveCount(1, { timeout: 5_000 });

    // ── Fila 1: Cliente A → 200 USD ──────────────────────────────────────
    // Tipear ≥2 chars dispara fetch debounced. El dropdown muestra cada
    // cliente con "Saldo USD N.NN" — match estable porque ese texto solo
    // existe en el render del picker.
    await fila1.getByPlaceholder('Buscar cliente…').fill('E2ECob');
    // El dropdown lista ambos clientes. Click en la opción con saldo 500
    // (cliente A). Scopeamos al modal para evitar matches en otros lugares
    // de la página (no debería haber otros, pero defensivo).
    await modal.getByText(/Saldo USD\s*500/).click({ timeout: 5_000 });
    // Monto: el único type=number visible en la fila con caja=USD es el
    // monto (TC se oculta cuando moneda=USD). Usamos placeholder="0".
    await fila1.getByPlaceholder('0').fill('200');
    // Caja: select por label "USD | Efectivo (USD)" del seed globalSetup.
    await cajaSelect1.selectOption({ label: 'USD | Efectivo (USD)' });

    // ── Fila 2: Cliente B → 300 USD ──────────────────────────────────────
    const fila2 = modal.getByTestId('cobranza-row').nth(1);
    await fila2.getByPlaceholder('Buscar cliente…').fill('E2ECob');
    // Cliente B tiene saldo 300. El dropdown re-fetcha por fila (el
    // AutocompletePicker es por instancia), así que vuelve a aparecer.
    await modal.getByText(/Saldo USD\s*300/).click({ timeout: 5_000 });
    await fila2.getByPlaceholder('0').fill('300');
    const cajaSelect2 = fila2.locator('select').first();
    await cajaSelect2.selectOption({ label: 'USD | Efectivo (USD)' });

    // ── Submit ───────────────────────────────────────────────────────────
    // El botón muestra "Guardar cobranzas (2)" cuando hay 2 filas usadas.
    // Usamos el testid para evitar acoplamiento al texto dinámico.
    await modal.getByTestId('cobranza-submit').click();

    // El modal cierra al éxito (toast.success + onSaved → onClose).
    await expect(modal).toBeHidden({ timeout: 10_000 });

    // ── Verificación vía API ─────────────────────────────────────────────
    // GET /api/cuentas/clientes devuelve `saldo` computado en una sola query.
    // Cliente A: 500 - 200 = 300 (sigue debiendo).
    // Cliente B: 300 - 300 = 0   (saldado).
    const saldos = await getSaldosByIds([clienteA.id, clienteB.id]);
    expect(saldos.get(clienteA.id)).toBe(300);
    expect(saldos.get(clienteB.id)).toBe(0);
  });
});
