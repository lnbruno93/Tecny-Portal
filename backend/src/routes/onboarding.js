/**
 * Onboarding status — TANDA 1 H3 #323 (audit E2E 2026-06-18).
 *
 * Endpoint para que el frontend (Inicio.jsx) sepa qué pasos del checklist
 * de onboarding ya completó el user. Sin esto, brand new tenant aterriza
 * en Inicio con KPIs $0 y "Sin actividad reciente" — sin guía de por dónde
 * arrancar.
 *
 * GET /api/onboarding/status
 *   Auth: requireAuth (cualquier user del tenant puede consultar).
 *   Response: {
 *     has_productos: bool,   // tenant tiene al menos 1 producto no-eliminado
 *     has_contactos: bool,   // tenant tiene al menos 1 contacto no-eliminado
 *     has_ventas:    bool,   // tenant tiene al menos 1 venta no-eliminada
 *   }
 *
 * Decisiones durables:
 *   - EXISTS en vez de COUNT — short-circuit al primer match. Con 100k+
 *     productos/ventas en un tenant grande, COUNT escanea toda la tabla
 *     (incluso con index, lee N rows); EXISTS para en el primer hit.
 *   - 3 queries en una sola response. El cliente quiere todo junto, no 3
 *     round-trips. Las queries van sequenciales sobre el mismo `client`
 *     porque pg no soporta queries concurrentes sobre un mismo client
 *     (deprecation warning + comportamiento indefinido). 3 EXISTS sobre
 *     índices son <2ms, secuencial está perfecto.
 *   - Todas las queries van DENTRO de un único withTenant() — comparten
 *     el mismo SET LOCAL app.current_tenant, ahorra ~3 BEGIN+SET+COMMIT.
 *   - Filtramos por deleted_at IS NULL: borrar el único producto/contacto
 *     vuelve a marcar el step como pendiente. Esto es DESEABLE: si el
 *     onboarding tiene 1 item y el user lo borra, el checklist le vuelve
 *     a aparecer (estado coherente con lo que ve en pantalla).
 *
 * Frontend uso (OnboardingCard.jsx):
 *   - Llama una vez al mount del Inicio.
 *   - Cachea el resultado en memoria del componente.
 *   - Si los 3 son true → card no se muestra.
 *   - Refetch cuando el user navega de vuelta a Inicio (re-mount).
 *   - Dismiss manual del user → localStorage flag, ya no llama acá.
 */

const router = require('express').Router();
const db = require('../config/database');

router.get('/status', async (req, res, next) => {
  try {
    const status = await db.withTenant(req.tenantId, async (client) => {
      // 3 EXISTS secuenciales sobre el mismo `client`. pg no soporta queries
      // concurrentes sobre un mismo client (deprecated en pg@8, removido en
      // pg@9). EXISTS sobre índices es <1ms cada uno, secuencial está OK.
      const productos = await client.query('SELECT EXISTS(SELECT 1 FROM productos WHERE deleted_at IS NULL) AS x');
      const contactos = await client.query('SELECT EXISTS(SELECT 1 FROM contactos WHERE deleted_at IS NULL) AS x');
      const ventas    = await client.query('SELECT EXISTS(SELECT 1 FROM ventas    WHERE deleted_at IS NULL) AS x');
      return {
        has_productos: productos.rows[0].x,
        has_contactos: contactos.rows[0].x,
        has_ventas:    ventas.rows[0].x,
      };
    });
    res.json(status);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
