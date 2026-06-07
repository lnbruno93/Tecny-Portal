// Convierte el error de un catch en un mensaje amigable para mostrar al
// usuario (toast.error / setError de inline form).
//
// UX H1 auditoría 2026-06-06: el api() wrapper ya hace buena parte del trabajo
// (status → mensaje), pero algunos casos crípticos se cuelan en la UI:
//
//   · err.message === 'NO_AUTH' (401): el wrapper redirige vía
//     'session-expired', pero entremedias el .catch del screen alcanza a
//     mostrar el toast con literal 'NO_AUTH'. Lo neutralizamos.
//   · err undefined / null / Error sin message.
//   · err.message === '' (poco frecuente pero pasa con res.body vacío).
//   · TypeError / errores del propio código del screen (no de api) — se ven
//     como 'Cannot read property X of undefined', muy técnico para el operador.
//
// Cómo usar:
//   import { friendlyError } from '../lib/friendlyError';
//   try { ... } catch (err) { toast.error(friendlyError(err)); }
//
// Cuándo NO usar: en flows donde querés EL mismo mensaje del backend
// (validaciones de schema, "saldo insuficiente en caja X", etc.). Para esos
// casos el wrapper api() ya entrega el body.error, no hace falta envolverlo.

const FALLBACK = 'Hubo un problema. Probá de nuevo en un momento.';

export function friendlyError(err) {
  // null/undefined o no-Error: caso defensivo. No debería pasar pero blindamos.
  if (!err) return FALLBACK;
  const msg = typeof err === 'string' ? err : err.message;
  if (!msg || typeof msg !== 'string') return FALLBACK;

  // El api() wrapper usa 'NO_AUTH' como marker interno para 401 + redirect.
  // Si llegamos a mostrar este string al usuario, es bug — pero mientras el
  // redirect arranca, mejor un mensaje claro que la sigla.
  if (msg === 'NO_AUTH') return 'Tu sesión expiró. Redirigiendo al inicio…';

  // TypeError típicos del frontend (no del backend) — "Cannot read property...",
  // "x is not a function". Muy técnico.
  if (msg.includes("Cannot read") || msg.includes("is not a function") || msg.includes('undefined')) {
    return FALLBACK;
  }

  return msg;
}
