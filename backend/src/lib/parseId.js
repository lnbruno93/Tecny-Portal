/**
 * Parsea un parámetro de ruta como ID entero positivo.
 *
 * A diferencia de parseInt(), rechaza strings mixtos como '5abc':
 *   parseId('5')    → 5
 *   parseId('5abc') → NaN   (parseInt devolvería 5 — bug silencioso)
 *   parseId('0')    → NaN   (IDs de DB siempre > 0)
 *   parseId('-1')   → NaN
 *   parseId('')     → NaN
 *
 * Uso en rutas:
 *   const id = parseId(req.params.id);
 *   if (!id) return res.status(400).json({ error: 'ID inválido' });
 */
function parseId(str) {
  if (typeof str !== 'string' || !/^\d+$/.test(str)) return NaN;
  const n = parseInt(str, 10);
  return n > 0 ? n : NaN;
}

module.exports = parseId;
