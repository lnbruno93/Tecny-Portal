const router = require('express').Router();
const db = require('../config/database');
const adminOnly = require('../middleware/adminOnly');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { updateConfigSchema } = require('../schemas/config');
const { recalcComprobantesFinancieraByTenant } = require('../lib/financiera');


router.get('/', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query('SELECT * FROM config LIMIT 1');
      return rows;
    });
    res.json(rows[0] || {});
  } catch (err) {
    next(err);
  }
});

// Solo admins pueden cambiar la configuración global
router.put('/', adminOnly, validate(updateConfigSchema), async (req, res, next) => {
  try {
    const { pct_financiera } = req.body;
    // 2026-06-25 Bug #2 (primer cliente iDeals Ar tenant=12):
    //
    // ANTES (PR 4 olvidado del proyecto multi-tenant): el INSERT no especificaba
    // tenant_id y confiaba en el DEFAULT dinámico (current_setting('app.current
    // _tenant')). Diagnóstico real en prod confirmó que para tenant=12, la fila
    // de config NUNCA se persistió aunque el cliente apretó "Guardar" varias
    // veces. Resultado: pct_financiera nunca se aplicaba a sus comprobantes.
    //
    // AHORA: tenant_id explícito desde req.tenantId. Defense-in-depth — no
    // confiamos en el DEFAULT dinámico, lo seteamos directo. Además el signup
    // ya siembra la fila inicial (ver signup.js §5d), entonces el ON CONFLICT
    // siempre debería hacer UPDATE en la práctica. El INSERT branch queda como
    // safety net para tenants legacy que se crearon antes de este fix.
    //
    // Después del UPDATE: re-calcular monto_financiera y monto_neto de TODOS
    // los comprobantes activos del tenant con el nuevo %. Esto cubre el caso
    // "owner cambia el % después de cargar comprobantes" que el usuario espera
    // intuitivamente. Sin esto, las ventas históricas quedan con el % viejo
    // cacheado y el dashboard miente.
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO config (id, tenant_id, pct_financiera) VALUES (1, $1, $2)
         ON CONFLICT (tenant_id, id) DO UPDATE SET pct_financiera = $2, updated_at = NOW()
         RETURNING *`,
        [req.tenantId, pct_financiera]
      );

      // Recalc retroactivo: actualizar monto_financiera y monto_neto de los
      // comprobantes activos con el nuevo pct. Devuelve count para el audit log.
      const recalcCount = await recalcComprobantesFinancieraByTenant(client, pct_financiera);

      await audit(client, 'config', 'UPDATE', 1, {
        despues: rows[0],
        recalc_comprobantes_count: recalcCount,
        user_id: req.user.id,
      });
      return rows;
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
