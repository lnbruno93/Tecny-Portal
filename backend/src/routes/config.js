const router = require('express').Router();
const db = require('../config/database');
const adminOnly = require('../middleware/adminOnly');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { updateConfigSchema } = require('../schemas/config');


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
    // NOTA sobre recalc retroactivo: NO lo aplicamos automáticamente desde acá.
    // Decisión durable: cambiar el % NO toca comprobantes históricos. Preserva
    // el snapshot del cálculo al momento de la venta (auditabilidad + acuerdo
    // con el contrato implícito que se documentó al original release de la
    // Financiera). Si el operador necesita aplicar el nuevo % a comprobantes
    // existentes, puede:
    //   · Editar/recrear el comprobante manualmente (dispara syncFinanciera
    //     Comprobante que lee el pct ACTUAL).
    //   · Pedir un script de admin que invoque `recalcComprobantesFinancieraByTenant`
    //     desde `lib/financiera.js` (helper exportado, ver tests/config-recalc.test.js).
    // Si en el futuro UX pide un botón "Aplicar a histórico", agregar acá un
    // opt-in (ej: `recalc_retroactivo: true` en el body).
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO config (id, tenant_id, pct_financiera) VALUES (1, $1, $2)
         ON CONFLICT (tenant_id, id) DO UPDATE SET pct_financiera = $2, updated_at = NOW()
         RETURNING *`,
        [req.tenantId, pct_financiera]
      );
      await audit(client, 'config', 'UPDATE', 1, { despues: rows[0], user_id: req.user.id });
      return rows;
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
