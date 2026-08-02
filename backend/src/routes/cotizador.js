// routes/cotizador.js — endpoints scoped al feature Cotizador.
//
// 2026-08-02 (task #286, P0 vendedor cotizador):
// Este file nació de una regresión de PR #978 (task #284): el hook
// `useComisionesTenant()` del Cotizador leía las % desde:
//   · configApi.get()      → gated con `config.general|alertas|mantenimiento`
//   · cajasApi.listCajas() → gated con `cajas.ver`
// Ninguna de esas caps la tiene el rol `vendedor` (roleDefaults.js). Los
// dos fetches devolvían 403, los `.catch(() => [])` del hook silenciaban
// el error, y el vendedor terminaba viendo el resultado del Cotizador SIN
// las líneas de tarjetas de crédito. Lucas lo cazó minutos después del
// deploy de PR #979.
//
// Fix: exponer un endpoint de LECTURA-SOLA scoped a lo que el Cotizador
// necesita, gated con la cap operacional del feature (`cotizador.trabajar`).
// El payload es minimal — NO leakea saldos, es_financiera flag ni otros
// campos de metodos_pago que un vendedor no debería ver. Solo lo
// estrictamente necesario para calcular las % del cotizador:
//   · pctFinanciera → config.pct_financiera (transferencias)
//   · tarjetas      → [{ id, nombre, comision_pct }]
//                      filtro es_tarjeta=true + deleted_at IS NULL
//                      ordenadas por orden ASC, nombre ASC
//
// La ESCRITURA (edición de %) sigue viviendo en /api/config (PUT) y
// /api/cajas/cajas/:id (PUT), gated con adminOnly / capability. El panel
// de edición del Cotizador (Configuración > Comisiones) sigue usando esos
// endpoints y sólo se muestra a admins — este endpoint es puramente de
// lectura para que TODOS los usuarios que ven el Cotizador (incluido
// vendedor) calculen con las % configuradas del tenant, no con hardcodes.
//
// RLS: usa db.withTenant(req.tenantId). Solo lee las tarjetas del tenant
// del user autenticado (defense-in-depth vs cross-tenant leak).
const router = require('express').Router();
const db = require('../config/database');


// GET /api/cotizador/comisiones
// → { pctFinanciera: number, tarjetas: [{ id, nombre, comision_pct }] }
//
// Devuelve las % vigentes del tenant para el cálculo del Cotizador.
// pctFinanciera default 3 si config.pct_financiera está NULL (matchea el
// default histórico del schema y lo que hardcodeaba el frontend).
router.get('/comisiones', async (req, res, next) => {
  try {
    const data = await db.withTenant(req.tenantId, async (client) => {
      // Fetch en paralelo — ambas queries son sobre el mismo tenant y no
      // dependen entre sí. Tenant scoping lo hace RLS (client.withTenant).
      const [cfgRes, tarjetasRes] = await Promise.all([
        client.query('SELECT pct_financiera FROM config LIMIT 1'),
        client.query(
          `SELECT id, nombre, comision_pct
             FROM metodos_pago
            WHERE es_tarjeta = true
              AND deleted_at IS NULL
            ORDER BY orden ASC NULLS LAST, nombre ASC`
        ),
      ]);

      const pctFinanciera = cfgRes.rows[0]?.pct_financiera != null
        ? Number(cfgRes.rows[0].pct_financiera)
        : 3;

      const tarjetas = tarjetasRes.rows.map(r => ({
        id: r.id,
        nombre: r.nombre,
        comision_pct: Number(r.comision_pct ?? 0),
      }));

      return { pctFinanciera, tarjetas };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});


module.exports = router;
