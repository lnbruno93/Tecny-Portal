// Envío → Entregado E2E — alta del envío y validación del flow completo
// "envío → entregado + venta acreditada".
//
// Cubre la regla de negocio clave del módulo Envíos (2026-06-10):
//   · Todo envío genera una venta asociada con `estado='pendiente'` al crearse.
//   · Cuando el envío pasa a estado 'Entregado', la venta queda 'acreditado'.
//   · La transición es atómica (la maneja el PUT /api/envios/:id en el backend
//     — ver routes/envios.js, bloque "Sincronizar estado de la venta").
//
// Happy path (1 producto USD, 1 pago USD):
//   1. Pre-condición vía API: seedProductoForB2B crea producto USD disponible.
//   2. Login UI como testadmin → /envios.
//   3. Click "Nuevo envío" — abre el modal.
//   4. Llenar form: cliente, dirección, barrio (combobox texto libre), prioridad.
//   5. Agregar producto del inventario via buscador (debounce + dropdown).
//   6. Agregar pago en "USD | Efectivo" cubriendo el precio.
//   7. Submit. Intercepto el POST para capturar `venta_id` del response.
//   8. Verificar que el envío aparece seleccionado y con estado "Pendiente".
//   9. Click "Marcar en camino" → estado "En camino" en el detail panel.
//   10. Click "Marcar entregado" → estado "Entregado".
//   11. Verificar vía API GET /api/ventas que la venta asociada quedó
//       `estado='acreditado'`. Esta es la validación crítica del flow.
//
// Decisiones de selectores:
//   · Botones del header / action panel: getByRole con texto único.
//     - "Nuevo envío" — único en la página (overrides el primary action del shell).
//     - "Marcar en camino" / "Marcar entregado" — textos derivados de
//       nextEstadoLabel() en Envios.jsx; son únicos por estado del envío.
//   · Modal scope: [role="dialog"][aria-labelledby="envio-modal-title"].
//   · Form fields por placeholder/label: "Nombre del cliente",
//     "ej. San Martín 450", "Buscar barrio o localidad…".
//   · Picker del producto: input "Empezá a tipear…" + click en el botón del
//     dropdown que matchea el nombre seedeado.
//   · Pagos: select "Método…" + input "Monto".
//   · Submit: button text "Crear envío" dentro del modal.
//
// Verificación de venta acreditada:
//   No hay GET /api/ventas/:id en backend → usamos GET /api/ventas?limit=200
//   y filtramos por id (que conocemos del response del POST envío que
//   incluye `venta_id`). Es API-only — la UI no muestra el estado interno
//   de la venta desde la pantalla de envíos.
//
// Lo que NO cubre (otros PRs):
//   · Cancelar envío.
//   · Editar envío.
//   · Verificación de impacto en dashboard.
//   · Pago con cuenta corriente (ya no es opción en el modal de envíos).
//   · Múltiples items / pagos mixtos / TC requerido (todo USD para evitar TC).

const { test, expect, request } = require('@playwright/test');
const { login } = require('../helpers/auth');
const { seedProductoForB2B } = require('../helpers/clienteCc');
const { TEST_USER } = require('../helpers/globalSetup');

const API_URL = 'http://localhost:3001';

// Helper local: login API + GET. Replica el patrón de clienteCc.js pero
// usando el `request` context de Playwright (más limpio para asserts y
// reutiliza el storage de cookies del runner).
async function apiToken(req) {
  const r = await req.post(`${API_URL}/api/auth/login`, {
    data: { username: TEST_USER.username, password: TEST_USER.password },
  });
  const json = await r.json();
  if (!r.ok()) throw new Error(json.error || `login failed (${r.status()})`);
  return json.token;
}

test.describe('Envíos — envío → entregado + venta acreditada', () => {
  test('happy path: producto USD + pago USD → envío Entregado + venta acreditada', async ({ page }) => {
    // ── Pre-condición vía API ────────────────────────────────────────────
    // Producto USD con cantidad > 1 (tipo_carga='lote' en seedProductoForB2B
    // por default). El precio_venta=200 USD se autocompleta al pickearlo.
    //
    // 2026-06-11 fix flakiness en CI: nombre único por run. Antes el nombre
    // era literal "Envío Test E2E" y otros tests de la suite (b2b, dashboard,
    // editar-venta) podían dejar residuos que matcheaban el regex del search
    // y rompían el strict mode del .click() del dropdown. Con sufijo único
    // garantizamos que el resultado del search es un único botón.
    const nombreProducto = `Envío Test E2E ${Date.now()}`;
    const producto = await seedProductoForB2B({
      nombre: nombreProducto, cantidad: 3, costo: 100, precio: 200,
    });
    expect(producto.id).toBeGreaterThan(0);

    // ── Login + nav ──────────────────────────────────────────────────────
    await login(page);
    await page.goto('/envios');
    await expect(page).toHaveURL(/\/envios/);
    await expect(page.getByRole('heading', { name: 'Envíos' })).toBeVisible();

    // ── Abrir el modal ───────────────────────────────────────────────────
    // "Nuevo envío" está en el header (.btn-primary). El primary action del
    // Shell también lo expone — usamos .first() por consistencia con otros specs.
    await page.getByRole('button', { name: /Nuevo envío/i }).first().click();

    const modal = page.locator('[role="dialog"][aria-labelledby="envio-modal-title"]');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('heading', { name: /Nuevo envío/i })).toBeVisible();

    // ── Form fields ──────────────────────────────────────────────────────
    // Cliente / dirección — los únicos required. autofocus pone el foco en cliente.
    await modal.getByPlaceholder('Nombre del cliente').fill('Cliente E2E Envío');
    await modal.getByPlaceholder('ej. San Martín 450').fill('Av. Test 123');
    // Barrio (BarrioCombobox): el componente acepta texto libre — el onChange
    // se dispara con cada keystroke y propaga el valor. No hace falta
    // seleccionar opción del dropdown. Simple y estable.
    await modal.getByPlaceholder('Buscar barrio o localidad…').fill('Palermo');
    // Prioridad opcional — la dejamos en Media para ejercer el path real.
    await modal.locator('select').filter({ hasText: 'Sin prioridad' }).selectOption('Media');

    // ── Agregar producto del inventario ──────────────────────────────────
    // El picker es debounced (300ms). Esperamos el response de /api/inventario/productos
    // antes de clickear el resultado para evitar race contra el dropdown vacío.
    const buscarInput = modal.getByPlaceholder('Empezá a tipear…').first();
    const productosResp = page.waitForResponse(
      r => r.url().includes('/api/inventario/productos') && r.status() === 200
    );
    // Buscamos por el sufijo timestamp único — garantiza un único resultado
    // aunque otros tests hayan dejado productos con prefijo "Envío Test E2E".
    await buscarInput.fill(nombreProducto);
    await productosResp;

    // El dropdown renderea cada resultado como <button> con el nombre.
    // 2026-06-11 fix CI flakiness: el `waitForResponse` garantiza que la HTTP
    // response llegó, pero NO que React re-renderizó el dropdown con los
    // resultados. En CI con menos CPU el `.click()` se ejecutaba antes del
    // render → strict mode violation (0 matches) o click sobre overlay.
    // waitFor visible explícito antes del click resuelve el race.
    const productoBtn = modal.getByRole('button', { name: nombreProducto });
    await productoBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await productoBtn.click();

    // Tras pickear, el modal pasa al modo "hero card" — el precio_venta=200 USD
    // se autocompleta en el input numérico del item linkeado.
    await expect(modal.getByText('Producto seleccionado')).toBeVisible();
    // El label "Precio venta" en Envios.jsx no usa htmlFor → no es accesible
    // vía getByLabel. Scopeamos al card del producto linkeado (contiene el
    // texto "Producto seleccionado") y tomamos su único input[type=number]
    // (el de precio). El input arranca con value="200" (precio_venta del seed
    // copiado en pickProducto → setItem(idx, 'monto', String(p.precio_venta))).
    const productoCard = modal.locator('.card-tight').filter({ hasText: 'Producto seleccionado' });
    const precioInput = productoCard.locator('input[type="number"]');
    // Postgres NUMERIC(_,2) → backend devuelve "200.00" como string; matcheamos
    // con regex para tolerar ese sufijo (no es 200 plano sino 200.00).
    await expect(precioInput).toHaveValue(/^200(\.0+)?$/);

    // ── Agregar pago en USD | Efectivo ───────────────────────────────────
    await modal.getByRole('button', { name: /Agregar método/i }).click();

    // Para evitar matchear inputs del producto, scopeamos al row de pagos.
    // El primer select del row de pagos ofrece "Método…" como placeholder
    // y las opciones vienen de cajasPago (cargado async desde /api/cajas/metodos-pago).
    // Esperamos que la option esté disponible antes de selectOption.
    const metodoSelect = modal.locator('select').filter({ hasText: 'Método…' }).first();
    await expect(metodoSelect.locator('option', { hasText: 'USD | Efectivo' }))
      .toHaveCount(1, { timeout: 5_000 });
    await metodoSelect.selectOption({ label: 'USD | Efectivo' });

    // Monto del pago. El placeholder "Monto" lo identifica unívocamente
    // dentro del row de pagos (los inputs del item linkeado usan "Precio venta"
    // como label, no placeholder).
    await modal.getByPlaceholder('Monto').fill('200');

    // Resumen: cubierto ✓ (total venta 200 = pagos 200).
    await expect(modal.getByText(/Cubierto/)).toBeVisible();

    // ── Submit ───────────────────────────────────────────────────────────
    // Interceptamos el POST para capturar el `venta_id` que devuelve el backend.
    // Eso evita un GET adicional para buscar la venta después.
    const createEnvioResp = page.waitForResponse(
      r => r.url().includes('/api/envios') && r.request().method() === 'POST' && r.status() === 201
    );
    await modal.getByRole('button', { name: 'Crear envío', exact: true }).click();
    const envioCreado = await (await createEnvioResp).json();
    expect(envioCreado.id).toBeGreaterThan(0);
    expect(envioCreado.venta_id).toBeGreaterThan(0); // crearVentaDesdeEnvio devolvió OK
    const ventaId = envioCreado.venta_id;

    await expect(modal).toBeHidden({ timeout: 10_000 });

    // ── Verificar estado "Pendiente" en el detail panel ──────────────────
    // setSelectedId(nuevo.id) corrió al submit → el envío recién creado
    // aparece seleccionado a la derecha. El badge en card-hd muestra "Pendiente".
    const detail = page.locator('.card-flush').filter({ hasText: `Envío #${envioCreado.id}` });
    await expect(detail).toBeVisible();
    await expect(detail.getByText('Pendiente', { exact: true })).toBeVisible();

    // ── Marcar en camino ─────────────────────────────────────────────────
    await detail.getByRole('button', { name: 'Marcar en camino' }).click();
    // El label del badge cambia a "En camino" cuando setEnviosList propaga el update.
    await expect(detail.getByText('En camino', { exact: true })).toBeVisible({ timeout: 5_000 });

    // ── Marcar entregado ─────────────────────────────────────────────────
    await detail.getByRole('button', { name: 'Marcar entregado' }).click();
    await expect(detail.getByText('Entregado', { exact: true })).toBeVisible({ timeout: 5_000 });
    // Ya no debe haber botón de "siguiente estado" cuando es Entregado
    // (nextEstadoLabel('Entregado') === null).
    await expect(detail.getByRole('button', { name: 'Marcar entregado' })).toHaveCount(0);

    // ── Validación crítica: venta asociada queda 'acreditado' ────────────
    // No hay GET /api/ventas/:id. Pedimos la lista paginada y filtramos por id.
    // El backend sincroniza ventas.estado='acreditado' dentro de la misma tx
    // del PUT /api/envios/:id (línea 288-296 de routes/envios.js).
    const apiReq = await request.newContext();
    const token = await apiToken(apiReq);
    const ventasResp = await apiReq.get(`${API_URL}/api/ventas?limit=200`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ventasResp.ok()).toBe(true);
    const ventasJson = await ventasResp.json();
    const ventas = Array.isArray(ventasJson?.data) ? ventasJson.data : (Array.isArray(ventasJson) ? ventasJson : []);
    const venta = ventas.find(v => v.id === ventaId);
    expect(venta, `venta id=${ventaId} debería estar en la lista`).toBeTruthy();
    expect(venta.estado).toBe('acreditado');
    await apiReq.dispose();
  });
});
