// Endpoints del perfil del tenant — datos del negocio del cliente Tecny.
//
// Fix bug multi-tenant 2026-06-22: el Cotizador tenía hardcodeada la oración
// "Nos encontrás en Google como 'Tecny Tech | Reseller' con +3200 reseñas"
// en el mensaje generado. Esa frase se filtraba a TODOS los tenants del
// SaaS — cada cliente Tecny veía datos de Tecny Tech (el negocio personal
// de Lucas), no del suyo.
//
// Endpoints:
//   GET /api/tenant-profile — devuelve el perfil del tenant del request.
//     Cualquier usuario autenticado del tenant puede leerlo (el Cotizador
//     lo consume, y al Cotizador llegan owner/admin/member por igual).
//
//   PUT /api/tenant-profile — actualiza el perfil del tenant.
//     Solo owner/admin del tenant (vía adminOnly middleware) — un member
//     o vendedor común no debería poder cambiar la ficha de Google que
//     se va a leer en TODOS los mensajes de cotización del equipo.
//
// La tabla `tenants` NO tiene RLS por tenant_id (es la tabla master que
// el super-admin gestiona via app separado). Pero el filtro
// `WHERE id = req.tenantId` garantiza que cada usuario solo lea/edite
// SU propio tenant — RLS lógica a nivel handler.

const router = require('express').Router();
const db = require('../config/database');
const adminOnly = require('../middleware/adminOnly');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { updateTenantProfileSchema } = require('../schemas/tenantProfile');

// Subset de columnas devueltas: solo lo que el frontend necesita para
// renderear el cotizador + Config. NO devolvemos plan/suspended_at/etc.
// — eso es información del super-admin, no del tenant.
const PROFILE_COLUMNS = `
  id,
  nombre,
  google_business_enabled,
  google_business_name,
  google_reviews_count
`;

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ${PROFILE_COLUMNS}
         FROM tenants
        WHERE id = $1 AND deleted_at IS NULL`,
      [req.tenantId]
    );
    if (!rows[0]) {
      // Caso defensivo: el JWT tiene tenantId pero el tenant fue
      // soft-deleted o no existe. Mejor 404 que 200 con {} confuso.
      return res.status(404).json({ error: 'Tenant no encontrado' });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/', adminOnly, validate(updateTenantProfileSchema), async (req, res, next) => {
  try {
    const {
      google_business_enabled,
      google_business_name,
      google_reviews_count,
    } = req.body;

    // Coherencia cruzada: si enabled=true requiere name no-vacío. El schema
    // ya valida que si name viene sea válido, pero NO obliga su presencia
    // cuando enabled=true. Validamos acá para mensaje claro al usuario.
    if (google_business_enabled === true) {
      const trimmedName = typeof google_business_name === 'string'
        ? google_business_name.trim()
        : '';
      if (!trimmedName) {
        return res.status(400).json({
          error: 'Si activás Google, necesitás cargar el nombre del negocio.',
        });
      }
    }

    // Normalización: si enabled=false, limpiamos name y count para que el
    // estado quede consistente. Si después el usuario reactiva, vuelve a
    // cargar los datos — la alternativa (preservar los valores ocultos)
    // genera ambigüedad ("¿están guardados o no?").
    const normalizedName  = google_business_enabled ? (google_business_name?.trim() ?? null) : null;
    const normalizedCount = google_business_enabled ? (google_reviews_count ?? null) : null;

    const result = await db.query(
      `UPDATE tenants
          SET google_business_enabled = $1,
              google_business_name    = $2,
              google_reviews_count    = $3
        WHERE id = $4 AND deleted_at IS NULL
        RETURNING ${PROFILE_COLUMNS}`,
      [google_business_enabled, normalizedName, normalizedCount, req.tenantId]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Tenant no encontrado' });
    }

    // Audit trail. El insert necesita un client en transacción del pool
    // del tenant — usamos withTenant solo para esto (sin meter el UPDATE
    // dentro porque ya se ejecutó arriba).
    await db.withTenant(req.tenantId, async (client) => {
      await audit(client, 'tenant_profile', 'UPDATE', req.tenantId, {
        despues: result.rows[0],
        user_id: req.user.id,
      });
    });

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
