// Recolección automática de contactos (Fase 2).
// Sincroniza un registro de la agenda central (`contactos`) a partir de un
// registro de otro módulo (proveedor, cliente B2B, etc.). Es idempotente por
// (origen_ref_tabla, origen_ref_id): inserta la primera vez y actualiza después.
//
// Best-effort: pensado para llamarse FUERA de la transacción del módulo y
// envuelto en try/catch — un problema en la agenda nunca debe tumbar el alta o
// edición del proveedor/cliente.
//
// `exec` es cualquier objeto con .query (el pool `db` o un client de transacción).
const logger = require('./logger');

async function syncContactoDesde(exec, { origen, ref_tabla, ref_id, nombre, apellido, telefono, email, dni }) {
  const nom = (nombre || '').trim();
  if (!nom || !ref_tabla || !ref_id) return null; // sin nombre o sin vínculo no creamos ficha

  // No tocamos deleted_at: si el usuario borró la ficha a propósito, una
  // re-sincronización actualiza datos pero la mantiene fuera de la agenda.
  const { rows } = await exec.query(
    `INSERT INTO contactos (nombre, apellido, telefono, email, dni, tipo, origen, origen_ref_tabla, origen_ref_id)
     VALUES ($1,$2,$3,$4,$5,'cliente',$6,$7,$8)
     ON CONFLICT (origen_ref_tabla, origen_ref_id) WHERE origen_ref_id IS NOT NULL
     DO UPDATE SET
       nombre   = EXCLUDED.nombre,
       apellido = EXCLUDED.apellido,
       telefono = COALESCE(EXCLUDED.telefono, contactos.telefono),
       email    = COALESCE(EXCLUDED.email,    contactos.email),
       dni      = COALESCE(EXCLUDED.dni,      contactos.dni)
     RETURNING *`,
    [nom, apellido ?? null, telefono ?? null, email ?? null, dni ?? null, origen, ref_tabla, ref_id]
  );
  return rows[0] || null;
}

// Variante segura: nunca lanza. Loggea y sigue.
async function syncContactoSafe(exec, data) {
  try {
    return await syncContactoDesde(exec, data);
  } catch (err) {
    logger.warn({ err, origen: data?.origen, ref_id: data?.ref_id }, 'sync de contacto a la agenda falló (best-effort)');
    return null;
  }
}

module.exports = { syncContactoDesde, syncContactoSafe };
