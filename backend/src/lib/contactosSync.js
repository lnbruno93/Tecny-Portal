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
  //
  // 2026-06-15 multi-tenant (PR 4.3): seteamos tenant_id EXPLÍCITAMENTE
  // leyendo app.current_tenant. Sin esto la columna toma DEFAULT 1 (legacy
  // compat) y la policy RLS WITH CHECK bloquea el INSERT cuando el caller
  // está dentro de un withTenant con un tenant != 1. El COALESCE preserva
  // el comportamiento legacy: llamadas sin SET LOCAL siguen yendo al tenant 1.
  const { rows } = await exec.query(
    `INSERT INTO contactos (nombre, apellido, telefono, email, dni, tipo, origen, origen_ref_tabla, origen_ref_id, tenant_id)
     VALUES ($1,$2,$3,$4,$5,'cliente',$6,$7,$8,
             COALESCE(NULLIF(current_setting('app.current_tenant', true), '')::int, 1))
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
//
// #B-1: el caso MUY común es 23505 (unique_violation) — el contacto YA existe
// con (nombre, apellido, tipo) pero con un origen_ref distinto (típico: alguien
// creó "Juan Pérez" como cliente antes, ahora lo damos de alta como proveedor).
// El ON CONFLICT que tenemos arriba es (origen_ref_tabla, origen_ref_id), no
// captura el constraint contactos_nombre_apellido_tipo_unique_active. No es
// un error real — el contacto ya está, y forzar el sync sería sobreescribir.
// Lo degradamos a `info` para no llenar el log con stacks "warn" inocuos
// (también afecta a la salida de tests, sin gusto a sangre).
async function syncContactoSafe(exec, data) {
  try {
    return await syncContactoDesde(exec, data);
  } catch (err) {
    const isDup = err?.code === '23505';
    const level = isDup ? 'info' : 'warn';
    const msg   = isDup
      ? 'sync de contacto: ya existe con (nombre, apellido, tipo) — se ignora'
      : 'sync de contacto a la agenda falló (best-effort)';
    // En logs `info` no incluimos el stack completo del err — solo code + detail.
    const payload = isDup
      ? { code: err.code, detail: err.detail, origen: data?.origen, ref_id: data?.ref_id }
      : { err, origen: data?.origen, ref_id: data?.ref_id };
    logger[level](payload, msg);
    return null;
  }
}

module.exports = { syncContactoDesde, syncContactoSafe };
