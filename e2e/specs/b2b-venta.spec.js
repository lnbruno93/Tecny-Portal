// Venta B2B E2E — alta de una venta con planilla (2 items) sobre cuenta
// corriente del cliente.
//
// Cubre el happy path mínimo del modal VentaB2BModal (la "planilla
// spreadsheet" del módulo Venta & Gestión B2B):
//   1. Pre-condición vía API: crear cliente CC "Mayorista E2E Test" y 2
//      productos disponibles en inventario (necesario porque el modal exige
//      producto_id por línea — no hay "ítem manual" como en VentaModal retail).
//   2. Login UI como testadmin → /cuentas.
//   3. Click en la row del cliente "Mayorista E2E Test" en la sidebar.
//   4. Click en "Cargar venta" (abre VentaB2BModal).
//   5. Planilla: cargar 2 items vía el autocomplete picker.
//      - Item 1: iPhone 13 E2E · cantidad 2 · precio 300 USD.
//      - Item 2: Cargador E2E  · cantidad 5 · precio 10 USD.
//      Total esperado: 2×300 + 5×10 = 650 USD.
//   6. Submit → modal cierra (no hay ExitoModal en B2B, solo toast + onSaved
//      callback que cierra el modal y refresca el resumen).
//   7. Verificar saldo del cliente = USD 650 (deuda) en el header del cliente.
//
// Decisiones de selectores:
//   - Botón "Cargar venta" + cliente "Mayorista E2E" son únicos por texto en
//     la pantalla → getByRole / getByText. No requiere data-testid.
//   - Cabecera del modal: heading "Cargar venta B2B · Mayorista E2E Test"
//     (id="b2b-modal-title"). Scopeamos al dialog por aria-labelledby para
//     evitar matches fuera del modal.
//   - Filas del spreadsheet scopeadas con `getByTestId("b2b-item-row")`. Cada
//     fila contiene un picker (input con placeholder "Buscar nombre o IMEI…")
//     + cantidad (input numeric sin placeholder específico, default "1") +
//     precio (input con placeholder "0") + moneda (select USD/ARS).
//   - El picker: tipear ≥2 chars dispara fetch debounced 200ms → dropdown.
//     Click en la <div> de la opción la elige (uses onMouseDown con
//     preventDefault → Playwright .click() funciona). Después de elegir,
//     el input queda `readOnly` (locked=true) y aparece la X de "limpiar".
//   - Submit por data-testid="b2b-submit" (el label muta a "Guardando…").
//   - Saldo del cliente por data-testid="b2b-cliente-saldo" en el header.
//
// Lo que NO cubre (otros specs / otros PRs):
//   - Cobranza masiva.
//   - Edición / devolución de items B2B.
//   - Verificación de impacto en dashboard de ventas.
//   - Cargar venta CONTADO (con caja_id seleccionada) — este test va por CC.
//   - Etiquetas custom — el seed auto-asigna B2B y no hay picker en el modal.
//
// Cleanup:
//   No es necesario un afterAll: cada `npm run e2e` corre globalSetup que
//   TRUNCATEa toda la DB antes de empezar la suite. El cliente y los
//   productos quedan, pero el próximo run los borra.

const { test, expect } = require('@playwright/test');
const { login } = require('../helpers/auth');
const { createClienteCc, seedProductoForB2B } = require('../helpers/clienteCc');

test.describe('Venta B2B — alta con planilla', () => {
  test('happy path: 2 items → saldo del cliente queda en USD 650 (deuda)', async ({ page }) => {
    // ── Pre-condición vía API ────────────────────────────────────────────
    // Crear cliente CC + 2 productos disponibles antes de tocar la UI.
    // Hacemos esto en serie (no Promise.all) porque cada llamada hace su
    // propio login API; paralelizar no aporta y complica el log de errores.
    await createClienteCc('Mayorista E2E Test');
    await seedProductoForB2B({ nombre: 'iPhone 13 E2E', cantidad: 5, costo: 200, precio: 300 });
    await seedProductoForB2B({ nombre: 'Cargador E2E',  cantidad: 10, costo: 5,   precio: 10  });

    // ── Login + nav ──────────────────────────────────────────────────────
    await login(page);
    await page.goto('/cuentas');
    await expect(page).toHaveURL(/\/cuentas/);
    await expect(page.getByRole('heading', { name: 'Venta & Gestión B2B' })).toBeVisible();

    // ── Seleccionar cliente en la sidebar ────────────────────────────────
    // El listado renderea cada row con el nombre+apellido. El texto es único.
    // .click() en el <div> dispara setSelectedId(c.id).
    await page.getByText('Mayorista E2E Test', { exact: false }).first().click();

    // El panel derecho carga el detalle async. Esperamos a que aparezca el
    // botón "Cargar venta" (existe solo cuando `cliente` está poblado).
    const cargarVentaBtn = page.getByRole('button', { name: /Cargar venta/i });
    await expect(cargarVentaBtn).toBeVisible({ timeout: 10_000 });
    await cargarVentaBtn.click();

    // ── Modal abierto ────────────────────────────────────────────────────
    // Scopeamos al dialog para no matchear elementos por fuera del modal.
    const modal = page.locator('[role="dialog"][aria-labelledby="b2b-modal-title"]');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('heading', { name: /Cargar venta B2B/i })).toBeVisible();

    // ── Fila 1: iPhone 13 E2E ────────────────────────────────────────────
    // La planilla arranca con 10 filas vacías. Usamos la primera.
    const fila1 = modal.getByTestId('b2b-item-row').nth(0);

    // Picker: tipear → esperar dropdown → clickear opción.
    // El placeholder "Buscar nombre o IMEI…" es único en la fila.
    await fila1.getByPlaceholder('Buscar nombre o IMEI…').fill('iPhone 13 E2E');
    // El dropdown aparece async (fetch debounced 200ms + roundtrip). La opción
    // se identifica de manera estable por su texto "Precio sugerido: USD 300"
    // que solo existe en el dropdown del picker (input value no matchea con
    // getByText). Esperamos hasta 5s para tolerar latencia DB.
    await page.getByText(/Precio sugerido: USD 300/).click({ timeout: 5_000 });
    // Cantidad: el primer input type=number de la fila (cantidad). Hay varios
    // type=number en la fila (cantidad + precio); cantidad va antes en el DOM.
    // Usamos locator de inputs numéricos en orden.
    const numericInputs1 = fila1.locator('input[type="number"]');
    await numericInputs1.nth(0).fill('2');                   // cantidad
    await numericInputs1.nth(1).fill('300');                 // precio
    // Moneda: USD default — chequeamos.
    await expect(fila1.locator('select')).toHaveValue('USD');

    // ── Fila 2: Cargador E2E ─────────────────────────────────────────────
    const fila2 = modal.getByTestId('b2b-item-row').nth(1);
    await fila2.getByPlaceholder('Buscar nombre o IMEI…').fill('Cargador E2E');
    // \b boundary para no matchear "USD 100" / "USD 1000" si más adelante se
    // siembra un producto con precio cercano.
    await page.getByText(/Precio sugerido: USD 10\b/).click({ timeout: 5_000 });
    const numericInputs2 = fila2.locator('input[type="number"]');
    await numericInputs2.nth(0).fill('5');                   // cantidad
    await numericInputs2.nth(1).fill('10');                  // precio
    await expect(fila2.locator('select')).toHaveValue('USD');

    // ── Total visible ────────────────────────────────────────────────────
    // El modal calcula totalUsd = 2×300 + 5×10 = 650. Aparece como "USD 650".
    await expect(modal.getByText(/USD\s*650/)).toBeVisible();

    // ── Submit ───────────────────────────────────────────────────────────
    await modal.getByTestId('b2b-submit').click();

    // El modal cierra al éxito (onSaved → onClose). No hay ExitoModal en B2B,
    // solo un toast.success — pero el cierre del modal es señal suficiente.
    await expect(modal).toBeHidden({ timeout: 10_000 });

    // ── Verificar saldo del cliente = USD 650 ────────────────────────────
    // Después de onSaved el componente refresca el resumen del cliente. El
    // saldo aparece en el header del detalle con data-testid="b2b-cliente-saldo".
    // Compra de USD 650 sin caja_id → suma deuda → saldo positivo = 650.
    const saldoEl = page.getByTestId('b2b-cliente-saldo');
    await expect(saldoEl).toBeVisible();
    await expect(saldoEl).toHaveText(/USD\s*650/, { timeout: 10_000 });
  });
});
