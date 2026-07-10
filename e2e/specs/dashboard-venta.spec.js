// Dashboard refleja venta — E2E.
//
// Valida que cuando se crea una venta acreditada, el dashboard de /ventas
// muestra los KPIs reflejando esa venta. Cubre el camino crítico:
//   1. Backend agrega correctamente (sumas USD/ARS, ganancia neta).
//   2. Frontend lee /api/ventas/dashboard al montar la pantalla.
//   3. UI renderiza los valores con el formato esperado (es-AR, sin decimales).
//
// Pre-condición vía API (sin UI, evita acoplamiento al modal):
//   · 1 venta retail acreditada con 1 item USD: precio=200, costo=50, qty=1.
//   · 1 pago en USD | Efectivo por 200.
//   · Sin TC requerido (item USD + pago USD).
//
// Aislamiento del rango: otros specs (b2b, envio, retail) crean ventas con
// `fecha = hoy` y las dejan en la DB (no hay cleanup entre tests — globalSetup
// TRUNCATEa una sola vez al inicio de la suite). Para que este test sea
// determinista usamos una `fecha` FUTURA única (hoy + 7 días). El dashboard
// filtra por `desde/hasta` exactos, así que sólo nuestra venta aparece.
// Bonus: evita el cache TTL 30s del dashboard (el cache es per-rango, y este
// rango sólo lo usa este spec).
//
// Valores esperados del dashboard:
//   · ingresos.usd = 200
//   · costos_usd = 50
//   · ganancia_neta_usd = 150  (ingresos − costos − egresos − inv. canjes)
//   · ventas_count = 1
//   · ticket_promedio_usd = 200
//   · unidades.accesorios = 1  (item sin producto_id → cuenta como accesorio
//                               según la lógica de routes/ventas.js dashboard)
//
// Decisiones de selectores:
//   · Los KPIs no tienen data-testid (NO tocamos código de producción).
//     Cada KPI tiene <div class="kpi-label">Texto</div><div>Valor</div>.
//     Scopeamos por el `.card`/`.card-tight` que contiene el label exacto y
//     después matcheamos el value adentro. Esto es estable porque los textos
//     de label son únicos en el dashboard (no se repiten).
//   · Tolerancia de formato: fmt() devuelve "200" (sin decimales, separador
//     es-AR para >999). Para valores <1000 no hay miles, así que regex
//     `(^|\D)200(\D|$)` evita matches espurios (ej. el "200" dentro de "2000").
//
// Cache TTL 30s (TANDA 3 P-05):
//   · globalSetup TRUNCATEa al inicio de la suite — primera corrida el cache
//     está frío. El API check usa `?_=${Date.now()}` para forzar bypass de
//     cualquier caché intermedio (defensa en profundidad).

const { test, expect, request } = require('@playwright/test');
const { login } = require('../helpers/auth');
const { createVentaViaApi } = require('../helpers/venta');
const { TEST_USER } = require('../helpers/globalSetup');

const API_URL = 'http://localhost:3001';

// fecha YYYY-MM-DD en TZ local del runner. Para este spec usamos una fecha
// FUTURA única para aislarnos de las ventas que otros specs dejan con fecha=hoy
// (no hay cleanup entre tests). El dashboard filtra por rango exacto.
//
// 2026-06-11 fix CI flakiness — dos capas de aislamiento:
//
// PROBLEMA 1: el dashboard del backend usa cache TTL 30s con key
//   `(desde, hasta)` (ventas.js:201) y NO valida query params extras
//   (queryDashboardSchema no es .strict()) — el cache buster `?_=Date.now()`
//   es invisible para el cache server-side. Si dos runs distintos del test
//   usan la misma fecha, el segundo recibe el resultado cacheado del primero.
//
// PROBLEMA 2: Playwright tiene retry automático en CI. Cuando un test falla
//   y se reintenta, `globalSetup` NO se reejecuta (solo corre una vez al
//   inicio de la suite). Por lo tanto la venta que se sembró en el intento 1
//   sigue en la DB durante el intento 2 → la nueva venta del intento 2 se
//   acumula → el dashboard ahora cuenta 2 ventas con esa fecha en vez de 1
//   → el assert `ventas_count === 1` falla.
//
// SOLUCIÓN: la fecha incluye DOS componentes en el seed:
//   1) `GITHUB_RUN_ID`/`GITHUB_RUN_NUMBER` o `Date.now()` — único por run.
//      Aísla cache entre PR runs distintos.
//   2) `test.info().retry` — único por intento dentro del mismo run.
//      Aísla del problema 2: cada retry usa una fecha *distinta* a la del
//      intento previo → la venta vieja queda en la DB pero NO matchea el
//      filtro `desde/hasta` del dashboard del nuevo intento. Cache miss
//      garantizado por la fecha nueva.
//
// Rango grande (100-100100 días futuros) para que el offset de retry
// (+10000 días por retry) no choque con otros runs próximos.
function fechaFutura(retryAttempt = 0) {
  const seed = Number(
    process.env.GITHUB_RUN_ID || process.env.GITHUB_RUN_NUMBER || Date.now()
  );
  const baseOffset = 100 + (Math.abs(seed) % 5000);
  const retryShift = retryAttempt * 10_000; // 10k días = ~27 años entre retries
  const offsetDias = baseOffset + retryShift;
  const d = new Date();
  d.setDate(d.getDate() + offsetDias);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function apiToken(req) {
  const r = await req.post(`${API_URL}/api/auth/login`, {
    data: { username: TEST_USER.username, password: TEST_USER.password },
  });
  const json = await r.json();
  if (!r.ok()) throw new Error(json.error || `login failed (${r.status()})`);
  return json.token;
}

test.describe('Dashboard de ventas — refleja la venta creada', () => {
  test('happy path: venta acreditada USD se refleja en KPIs (UI + API)', async ({ page }, testInfo) => {
    // Fecha única para este spec — aislada de las ventas que otros specs dejan
    // con fecha=hoy. Mismo valor para ambos lados (venta + filtro dashboard).
    // Pasamos `testInfo.retry` (0, 1, 2, ...) para que cada retry use una
    // fecha *distinta* del intento previo — globalSetup NO se reejecuta en
    // retry, así que la venta del intento anterior queda en DB pero con
    // OTRA fecha → no contamina el filtro del dashboard del intento actual.
    const fecha = fechaFutura(testInfo.retry);

    // ── Pre-condición vía API ────────────────────────────────────────────
    // Item: descripcion única para no chocar con otros specs. Sin producto_id
    // → NO cuenta en el KPI de unidades del dashboard (fix 2026-07-08 bug
    // iOStoreUY: antes items sin producto caían como "celular" por el brazo
    // `pr.id IS NULL` del CASE, contaminando el KPI con diferencias de cambio,
    // ajustes y canjes). Ingresos/costos/ganancia SÍ impactan — este item
    // aporta 200 USD ingreso y 50 USD costo.
    const venta = await createVentaViaApi({
      fecha,
      items: [{
        descripcion:    'Item Dashboard E2E',
        cantidad:       1,
        precio_vendido: 200,
        costo:          50,
        moneda:         'USD',
      }],
      pagos: [{ monto: 200, moneda: 'USD' }], // resuelve USD | Efectivo
      estado: 'acreditado',
    });
    expect(venta.id).toBeGreaterThan(0);
    expect(venta.estado).toBe('acreditado');

    // ── Verificación vía API ─────────────────────────────────────────────
    // Esto es la fuente determinista de verdad. Lo hacemos ANTES de la UI
    // para que si la UI falla por otro motivo, ya sepamos que el backend
    // está agregando bien.
    const apiReq = await request.newContext();
    const token = await apiToken(apiReq);
    const dashResp = await apiReq.get(
      `${API_URL}/api/ventas/dashboard?desde=${fecha}&hasta=${fecha}&_=${Date.now()}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(dashResp.ok()).toBe(true);
    const d = await dashResp.json();

    // Ingreso 200 - costo 50 = ganancia neta 150 (sin egresos ni canjes).
    expect(Number(d.ganancia_neta_usd)).toBe(150);
    expect(Number(d.costos_usd)).toBe(50);
    expect(Number(d.ventas_count)).toBe(1);
    expect(Number(d.ticket_promedio_usd)).toBe(200);
    expect(Number(d.ingresos.usd)).toBe(200);
    // Unidades vendidas — items sin producto_id NO se cuentan en el KPI
    // (fix 2026-07-08). El backend agrupa por las 9 clases nuevas de F1:
    // celulares = clase IN ('celular_sellado','celular_usado'); accesorios =
    // el resto de las 7 slugs con producto asociado. Items manuales (sin
    // producto_id → clase NULL) quedan fuera de ambos buckets. Este spec
    // crea 1 item manual → 0 unidades esperado.
    const totalUnidades = Number(d.unidades.celulares || 0) + Number(d.unidades.accesorios || 0);
    expect(totalUnidades).toBe(0);
    await apiReq.dispose();

    // ── UI ───────────────────────────────────────────────────────────────
    await login(page);

    // Ventas.jsx persiste el rango en la URL via `useSearchParams`
    // (Ventas.jsx:117-127 — `?periodo=custom&desde=X&hasta=X`). Aprovechamos
    // esto: navegamos DIRECTO con los query params ya seteados. El
    // componente monta con el rango correcto y hace UN ÚNICO fetch
    // `/api/ventas/dashboard?desde=fecha&hasta=fecha`.
    //
    // Historial del approach anterior + racionalidad del cambio actual:
    // - 2026-07-04 (fix #1 flaky): registrar `waitForResponse` antes de
    //   los `fill()` para no perder el response.
    // - 2026-07-10 (fix #2 flaky) [este PR]: los 2 `fill()` disparaban 2
    //   fetches paralelos con race donde el fetch stale (`?desde=fecha&
    //   hasta=<hoy>`) sobrescribía el estado del correcto post-response,
    //   dejando el card en "u$s0". Probamos evaluate atómico + setter
    //   nativo + change event → el fetch tampoco se disparaba
    //   (controlled input de React ignoraba los eventos sintéticos).
    // - Solución final [este PR]: eliminar el fill del todo. Navegación
    //   directa con query params. Cero race, cero eventos sintéticos,
    //   comportamiento determinista.
    const dashboardResp = page.waitForResponse(
      r => r.url().includes(`/api/ventas/dashboard?desde=${fecha}&hasta=${fecha}`) && r.status() === 200,
      { timeout: 20_000 },
    );
    await page.goto(`/ventas?periodo=custom&desde=${fecha}&hasta=${fecha}`);
    await expect(page).toHaveURL(/\/ventas/);

    await dashboardResp;

    const ingresosCard = page.locator('.card', { has: page.getByText('Ingresos totales', { exact: true }) });
    await expect(ingresosCard).toBeVisible({ timeout: 10_000 });

    // ── KPI: Ingresos totales ────────────────────────────────────────────
    // Render: "u$s{fmt(i.usd)} + ${fmt(i.ars)} ARS" → para nuestra venta queda
    // "u$s200 + $0 ARS". El value está en un <span class="mono"> bajo el card.
    // Validamos por texto exacto del span (evita textos contigentes como "200"
    // dentro de "u$s2000" si más adelante hay otro card).
    await expect(ingresosCard.locator('span.mono').first()).toHaveText('u$s200');
    // Bottom line: "1 venta" (singular cuando ventas_count===1).
    await expect(ingresosCard).toContainText(/1\s+venta(\s|$)/);

    // ── KPI: Unidades vendidas ───────────────────────────────────────────
    // 2026-07-09 (post-#544): items sin producto_id ahora cuentan en
    // `unidades_por_clase[]` como fila "Sin categoría" con emoji 📦 —
    // resuelve el bug UX del rediseño Opción C (#541) donde el card
    // mostraba "0 · 0" aunque hubiera ventas manuales legítimas.
    //
    // Este spec crea 1 item manual (200 USD, sin producto_id) → el card
    // renderiza el rediseño: total "1" + "en 1 categoría" + "Top:
    // 📦 Sin categoría 1" + botón "Ver detalle". Los buckets legacy
    // `unidades.celulares/accesorios` siguen en 0 (fix iOStoreUY) —
    // consistente con el patrón aditivo Fase 2.
    //
    // Nota: el fallback binario "📱 0 · 🎧 0" solo aparece cuando NO
    // hay ningún item vendido en el rango. Con items manuales, el
    // rediseño Opción C toma el control.
    const unidadesCard = page.locator('.card-tight', { has: page.getByText('Unidades vendidas', { exact: true }) });
    await expect(unidadesCard).toBeVisible();
    // Total agregado en el .kpi-value: 1 unidad (nuestro item manual).
    await expect(unidadesCard.locator('.kpi-value')).toHaveText('1');
    // Label "en 1 categoría" (singular, 1 fila visible: "Sin categoría").
    await expect(unidadesCard).toContainText(/en\s+1\s+categoría/i);
    // Top badge muestra la única categoría con ventas.
    await expect(unidadesCard).toContainText(/Top:\s*📦?\s*Sin categoría/i);

    // ── KPI: Ganancia neta ───────────────────────────────────────────────
    // Render: <.kpi-value>u$s150</.kpi-value> + <.muted><.margen> 75% · egresos…
    // Scopeamos al .kpi-value para evitar que el "75" del margen pegue con "150".
    const gananciaCard = page.locator('.card-tight', { has: page.getByText('Ganancia neta', { exact: true }) });
    await expect(gananciaCard).toBeVisible();
    await expect(gananciaCard.locator('.kpi-value')).toHaveText('u$s150');

    // ── KPI: Costos productos ────────────────────────────────────────────
    // Render: <.kpi-value>u$s50</.kpi-value> (card sólo tiene label + value).
    const costosCard = page.locator('.card-tight', { has: page.getByText('Costos productos', { exact: true }) });
    await expect(costosCard).toBeVisible();
    await expect(costosCard.locator('.kpi-value')).toHaveText('u$s50');

    // ── KPI: Ticket promedio ─────────────────────────────────────────────
    // Render: <.kpi-value>u$s200</.kpi-value>.
    const ticketCard = page.locator('.card-tight', { has: page.getByText('Ticket promedio', { exact: true }) });
    await expect(ticketCard).toBeVisible();
    await expect(ticketCard.locator('.kpi-value')).toHaveText('u$s200');
  });
});
