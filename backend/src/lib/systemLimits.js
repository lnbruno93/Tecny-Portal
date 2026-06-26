/**
 * System limits informativos (#443).
 *
 * Centraliza los límites operacionales que se muestran al usuario en
 * Config → Limitaciones del sistema. Antes esta lista vivía hardcoded
 * en frontend/screens/Config.jsx — y se había desincronizado de la
 * realidad (decía 10 OCR/hora cuando son 60, 5MB cuando son 10MB).
 *
 * Estos valores son "verdad declarada": describen el comportamiento del
 * sistema. NO son leídos por los rate-limiters (cada uno tiene su propio
 * `max:` hoy). Si querés cambiar un límite real, hay que editar TANTO el
 * rate-limiter (ej. `routes/ocr.js` línea 19: max: 60) COMO el descriptor
 * de acá. La sincronización es manual por ahora — un refactor que centralice
 * los rate-limiters está en el backlog (#450 no es exactamente esto pero
 * apunta en la misma dirección de single-source-of-truth).
 *
 * Por qué no derivar de los rate-limiters: porque algunos límites son de
 * comportamiento (soft-delete, audit) y otros son de configuración Express
 * (body limit). No hay un lugar único de donde "leer todo".
 */

const SYSTEM_LIMITS = [
  {
    t: 'OCR rate-limit',
    d: '60 solicitudes/hora por usuario',
  },
  {
    t: 'Tamaño máximo archivos',
    d: 'Máximo 10 MB por archivo subido',
  },
  {
    t: 'Soft delete',
    d: 'Los registros nunca se borran físicamente — recuperables con script admin',
  },
  {
    t: 'Permisos',
    d: 'Owner + Admin bypassean checks de capability; otros roles según permisos asignados',
  },
  {
    t: 'Auditoría',
    d: 'Cambios sobre datos críticos quedan registrados en historial por 90 días',
  },
  {
    t: 'Cotizador',
    d: 'Client-side, sin persistencia — el TC default usa el último cambio del tenant',
  },
];

/**
 * Returns la lista de límites para exponer al frontend.
 * Wrapper trivial pero permite agregar lógica (filter por plan, override
 * por env, etc.) sin tocar callers.
 */
function getSystemLimits() {
  return SYSTEM_LIMITS;
}

module.exports = {
  SYSTEM_LIMITS,
  getSystemLimits,
};
