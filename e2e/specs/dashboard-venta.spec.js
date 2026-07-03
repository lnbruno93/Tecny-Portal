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
    // → cae como "accesorio" en el split de unidades del dashboard.
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
    // Unidades vendidas — el item sin producto_id cuenta como accesorio
    // en el backend (split por clase del producto, NULL → accesorio default).
    const totalUnidades = Number(d.unidades.celulares || 0) + Number(d.unidades.accesorios || 0);
    expect(totalUnidades).toBe(1);
    await apiReq.dispose();

    // ── UI ───────────────────────────────────────────────────────────────
    await login(page);
    await page.goto('/ventas');
    await expect(page).toHaveURL(/\/ventas/);

    // El dashboard arranca con rango "hoy/hoy" (default en Ventas.jsx).
    // Cambiamos `desde` y `hasta` a nuestra fecha futura para que el dashboard
    // refleje SÓLO nuestra venta. Los inputs son `<input type="date">` con
    // value bindeado a state — fill() dispara onChange y re-fetch del dashboard.
    // Hay dos `<input type="date">` en la pantalla (desde + hasta). Tomamos
    // por orden de aparición (DOM): nth(0) = desde, nth(1) = hasta.
    const dateInputs = page.locator('input[type="date"]');

    // Esperamos a que el dashboard re-fetchee con el nuevo rango. El bloque
    // "Ingresos totales" siempre está visible (Dashboard render todo o nada),
    // pero su contenido cambia. Esperamos al GET de dashboard explícitamente
    // para evitar leer el render viejo (de "hoy/hoy").
    //
    // 2026-07-04 fix flaky CI: REGISTRAR el waitForResponse ANTES del fill.
    // Antes lo hacíamos DESPUÉS y había race: el 1er fill(desde) disparaba un
    // fetch con `?desde=X&hasta=<hoy>` que NO matcheaba el filtro, y el 2do
    // fill(hasta) disparaba `?desde=X&hasta=X` que SÍ matcheaba — pero si el
    // 2do request completaba antes de que empezara el `waitForResponse`,
    // Playwright colgaba 10s esperando algo que ya había pasado. Con el
    // promise registrado ANTES del fill, capturamos cualquier response futuro.
    // Timeout subido de 10s → 20s como defensa en profundidad para CI lento.
    // Mismo patrón usado en envio-entregado.spec.js:116 (documented CI fix).
    const dashboardResp = page.waitForResponse(
      r => r.url().includes(`/api/ventas/dashboard?desde=${fecha}&hasta=${fecha}`) && r.status() === 200,
      { timeout: 20_000 },
    );
    await dateInputs.nth(0).fill(fecha);
    await dateInputs.nth(1).fill(fecha);
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
    // Render: "📱 {celulares} · 🎧 {accesorios}" en .kpi-value. Para nuestro
    // item (sin producto_id) el backend lo clasifica como celular por default
    // (rama del CASE: COALESCE(p.clase, 'celular')). El total = 1; no asertamos
    // qué bucket (eso ya lo verifica el bloque de API arriba) — sólo que la
    // suma sea 1 unidad. Regex tolera ambas combinaciones (0·1 o 1·0).
    const unidadesCard = page.locator('.card-tight', { has: page.getByText('Unidades vendidas', { exact: true }) });
    await expect(unidadesCard).toBeVisible();
    await expect(unidadesCard.locator('.kpi-value')).toHaveText(/(?:^|\D)(?:0\s+·.*?\s+1|1\s+·.*?\s+0)(?:\D|$)/);

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
