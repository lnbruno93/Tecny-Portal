// Venta retail E2E — alta de una venta básica desde el modal Nueva venta.
//
// Cubre el happy path mínimo del flow más usado del portal:
//   1. Login como testadmin.
//   2. /ventas → click "Nueva venta" (botón btn-primary del header).
//   3. En el modal: agregar un Ítem manual con descripción "Test Item E2E",
//      precio 100, moneda USD (default), cantidad 1 (default).
//   4. Agregar un pago de USD 100 con método "USD | Efectivo" (sembrado por
//      globalSetup en metodos_pago).
//   5. Submit → modal de éxito ("¡Éxito!") + la venta aparece en la grilla.
//
// Decisiones de selectores:
//   - Botones por texto accesible (getByRole 'button', name) cuando hay un
//     solo match en la página activa: "Nueva venta", "Ítem manual",
//     "Agregar método".
//   - Para el botón "Nueva venta" hay 2 en la página (el del header de la
//     pantalla + el icon-btn del Shell con aria-label "Nueva venta"). Usamos
//     el primero — el btn-primary visible del header.
//   - Filas dinámicas (cart item + pago) se scopean por `data-testid` agregado
//     en el commit anterior. Evita CSS frágil del grid template.
//   - Submit por `data-testid="venta-submit"` porque el texto muta a
//     "Guardando…" durante el async.
//   - Verificación final: heading "¡Éxito!" del ExitoModal + presencia de
//     "Test Item E2E" en la lista debajo (VentasList renderea i.descripcion
//     directo). El precio "u$s100" valida que entró como USD.
//
// Lo que NO cubre (otros specs):
//   - Cliente, vendedor, cuenta corriente, canjes, garantía, comprobantes.
//   - Edición de venta, eliminar venta.
//   - Verificación de cifras del dashboard.

const { test, expect } = require('@playwright/test');
const { login } = require('../helpers/auth');

test.describe('Venta retail — alta', () => {
  test('happy path: ítem manual + pago USD efectivo → venta creada y visible', async ({ page }) => {
    await login(page);

    // Nav directo a /ventas — el helper login espera el redirect a /inicio.
    await page.goto('/ventas');
    await expect(page).toHaveURL(/\/ventas/);

    // El header de la pantalla tiene el botón btn-primary "Nueva venta".
    // (Hay un segundo botón a nivel Shell con aria-label "Nueva venta" — por
    // eso .first(), no `exact`. El orden DOM pone el del header primero.)
    await page.getByRole('button', { name: 'Nueva venta' }).first().click();

    // Modal abierto — el heading id es venta-modal-title.
    const modal = page.locator('[role="dialog"][aria-labelledby="venta-modal-title"]');
    await expect(modal).toBeVisible();

    // Agregar ítem manual (botón debajo del buscador de productos).
    await modal.getByRole('button', { name: /Ítem manual/i }).click();

    // Llenar la fila del item — scopeada por data-testid="venta-item-row".
    // Por columna: descripcion(text), cantidad(number), precio(number), moneda(select).
    const itemRow = modal.getByTestId('venta-item-row').first();
    await itemRow.getByPlaceholder('Producto').fill('Test Item E2E');
    // Cantidad: default 1 — lo dejamos sin tocar para ejercer el path real.
    await itemRow.getByPlaceholder('Precio').fill('100');
    // Moneda: default USD (primer <option>USD</option>) — confirmamos por las dudas.
    await expect(itemRow.locator('select')).toHaveValue('USD');

    // Agregar un método de pago. El select de método se llena async desde
    // /api/cajas/metodos-pago; espero que aparezca la option "USD | Efectivo"
    // (sembrada por globalSetup) antes de seleccionar.
    await modal.getByRole('button', { name: /Agregar método/i }).click();
    const pagoRow = modal.getByTestId('venta-pago-row').first();

    // Esperar a que la option esté disponible (catálogo cargado).
    await expect(pagoRow.locator('select').first().locator('option', { hasText: 'USD | Efectivo' }))
      .toHaveCount(1, { timeout: 5_000 });

    // Tema C rev5 (2026-06-14): el form ahora pide USD (no monto ARS bruto).
    // El método "USD | Efectivo" no tiene comisión → solo se ve [Método] [USD] [✕].
    // El dropdown "Moneda" desapareció (la moneda la dicta el método).
    await pagoRow.locator('select').first().selectOption({ label: 'USD | Efectivo' });
    await pagoRow.getByTestId('venta-pago-usd').fill('100');

    // Submit — el botón tiene data-testid estable (texto muta a "Guardando…").
    await modal.getByTestId('venta-submit').click();

    // El modal de éxito aparece — heading "¡Éxito!" en ExitoModal.jsx.
    await expect(
      page.getByRole('heading', { name: /¡Éxito!/ })
    ).toBeVisible({ timeout: 10_000 });

    // Cerrar el modal de éxito (botón "OK" — autoFocus).
    await page.getByRole('button', { name: 'OK', exact: true }).click();

    // La grilla debajo muestra la venta nueva con la descripción del item
    // y el precio en USD. VentasList renderea la descripción en un <div>
    // y abajo el <span> "venta u$s100". `.first()` porque el render envuelve
    // tanto el div como un span ancestro que matchean el mismo texto.
    await expect(page.getByText('Test Item E2E', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/venta\s+u\$s\s*100/i).first()).toBeVisible();
  });
});
