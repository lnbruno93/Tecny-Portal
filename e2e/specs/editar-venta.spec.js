// Edición de venta retail E2E — modificar el precio de un item de una venta
// existente y verificar la persistencia (UI + API).
//
// Cubre el happy path mínimo del flow de edición (apertura del modal
// Editar venta desde la grilla):
//   1. Pre-condición vía API: crear una venta con 1 item manual a USD 100
//      ("Original Item E2E") + 1 pago USD efectivo 100 (helper createVentaViaApi).
//   2. Login UI como testadmin → /ventas.
//   3. Encontrar la fila en la grilla por el texto del item.
//   4. Click en el icon-btn "Editar venta" de esa fila.
//   5. Modal abierto con heading "Editar venta" (en vez de "Nueva venta") y
//      el item ya cargado.
//   6. Modificar el precio del item de 100 a 175. Ajustar también el monto
//      del pago a 175 para que cuadre (el backend valida que la suma de
//      pagos cierre con el total de items en estado retiene-stock).
//   7. Submit → modal cierra.
//   8. Verificar:
//      - UI: la grilla muestra el nuevo total/precio.
//      - API: GET /api/ventas?buscar=... devuelve items[0].precio_vendido=175.
//
// Decisiones de selectores:
//   - Fila de la venta: scopear por texto del item ("Original Item E2E") y
//     después subir al `<tr>` con `locator('xpath=ancestor::tr')` — no hay
//     data-testid por fila en la grilla y no queremos agregarlo solo para el
//     test (las reglas duras prohiben tocar producción).
//   - Botón editar: `getByTitle('Editar venta')` dentro de la fila. El
//     `title` lo pone VentasList.jsx en función del origen (retail vs B2B):
//     "Editar venta" para retail, "Ir al cliente B2B" para B2B. Como la venta
//     del helper nace retail, el title es estable.
//   - Modal: heading "Editar venta" (id="venta-modal-title"). El modal es el
//     mismo de "Nueva venta" pero muta el header cuando hay editId.
//   - Input precio del item: la 2da columna numeric (cantidad, precio) dentro
//     del primer `[data-testid="venta-item-row"]`. Usamos
//     `input[type="number"]` y nth(1) — el orden DOM es cantidad → precio.
//   - Input monto del pago: el input `placeholder="Monto"` dentro del primer
//     `[data-testid="venta-pago-row"]`.
//   - Submit: `data-testid="venta-submit"` (el texto muta a "Guardando…").
//
// Lo que NO cubre:
//   - Edición de moneda, agregar/eliminar items, edición de pago method.
//   - Venta B2B (otro path — el botón redirige a /cuentas).
//   - Edición con producto_id (el backend devuelve y descuenta stock).

const { test, expect } = require('@playwright/test');
const { login } = require('../helpers/auth');
const { createVentaViaApi, fetchVentaConItems } = require('../helpers/venta');

test.describe('Edición de venta retail', () => {
  test('happy path: cambiar precio 100→175 → persiste en UI y API', async ({ page }) => {
    // ── Pre-condición vía API ────────────────────────────────────────────
    // Una venta manual (sin producto_id en el item) deja el flow de edición
    // limpio: el backend NO tiene que reponer ni descontar stock.
    const venta = await createVentaViaApi();
    expect(venta.id).toBeGreaterThan(0);

    // ── Login + nav ──────────────────────────────────────────────────────
    await login(page);
    await page.goto('/ventas');
    await expect(page).toHaveURL(/\/ventas/);

    // ── Encontrar la fila en la grilla ───────────────────────────────────
    // La grilla async-carga vía GET /api/ventas. Scopeamos a la <table> que
    // contiene el botón "Editar venta" — el Dashboard arriba tiene otras
    // <table> (Métodos de pago, Top productos, etc.) sin ese botón, así que
    // este filtro nos lleva sí o sí a la grilla VentasList.
    const tablaVentas = page.locator('table', { has: page.getByTitle('Editar venta') });
    await expect(tablaVentas).toBeVisible({ timeout: 10_000 });
    const fila = tablaVentas.locator('tr', { hasText: 'Original Item E2E' }).first();
    await expect(fila).toBeVisible({ timeout: 10_000 });
    await fila.getByTitle('Editar venta').click();

    // ── Modal "Editar venta" abierto ─────────────────────────────────────
    const modal = page.locator('[role="dialog"][aria-labelledby="venta-modal-title"]');
    await expect(modal).toBeVisible();
    // El heading muta a "Editar venta" cuando editId está set (Ventas.jsx:807).
    await expect(modal.getByRole('heading', { name: 'Editar venta' })).toBeVisible();

    // El item ya viene cargado en el cart. Hay exactamente 1 fila item.
    const itemRow = modal.getByTestId('venta-item-row').first();
    await expect(itemRow).toBeVisible();
    // Cantidad (nth 0) y precio (nth 1) — confirmamos el precio actual antes
    // de tocarlo. El backend devuelve precio_vendido numeric; React lo
    // setea como Number, así el input number muestra "100".
    const numericInputs = itemRow.locator('input[type="number"]');
    await expect(numericInputs.nth(1)).toHaveValue('100');

    // ── Modificar precio: 100 → 175 ──────────────────────────────────────
    // fill() reemplaza el valor (no append). Después de fill, dispara change
    // → setItem → setCart con Number(175).
    await numericInputs.nth(1).fill('175');

    // ── Ajustar USD del pago a 175 ───────────────────────────────────────
    // Para retiene-stock (acreditado) el backend exige que la suma de pagos
    // cierre con el total. Si dejamos el pago en 100, validarTc() rechaza.
    // Tema C rev5 (2026-06-14): el form ahora pide USD (no monto ARS bruto).
    // El input está marcado con data-testid="venta-pago-usd".
    const pagoRow = modal.getByTestId('venta-pago-row').first();
    await expect(pagoRow).toBeVisible();
    await pagoRow.getByTestId('venta-pago-usd').fill('175');

    // ── Submit ───────────────────────────────────────────────────────────
    await modal.getByTestId('venta-submit').click();

    // El modal cierra al éxito (no hay ExitoModal en el path de edición —
    // Ventas.jsx solo navega/abre ExitoModal en path de creación con CC).
    await expect(modal).toBeHidden({ timeout: 10_000 });

    // ── Verificación API (la crítica) ────────────────────────────────────
    // GET /api/ventas?buscar=Original Item E2E → encontrar la venta por id
    // y leer items[0].precio_vendido.
    const ventaActualizada = await fetchVentaConItems(venta.id, {
      buscar: 'Original Item E2E',
    });
    expect(ventaActualizada).not.toBeNull();
    expect(ventaActualizada.items).toBeDefined();
    expect(ventaActualizada.items.length).toBe(1);
    expect(Number(ventaActualizada.items[0].precio_vendido)).toBe(175);

    // ── Verificación UI ─────────────────────────────────────────────────
    // La grilla ya muestra el item con "venta u$s175" (el render de
    // VentasList incluye `venta u$s{precio_vendido}` debajo de la descripción).
    // Reload por las dudas — el modal cierra y dispara refresh, pero según
    // el state actual de la grilla puede tardar un tick.
    await page.reload();
    await expect(page.getByText('Original Item E2E', { exact: false }).first())
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/venta\s+u\$s\s*175/i).first()).toBeVisible();
  });
});
