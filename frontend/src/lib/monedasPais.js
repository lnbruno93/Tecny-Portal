// Multi-país F3 (#469): helpers puros para derivar el set de monedas
// operativas y la moneda local a partir del país del tenant.
//
// Convención durable (sec 5.1.4 del design doc multi-pais-uyu.md):
//   · AR → ARS local + USD/USDT transversales
//   · UY → UYU local + USD/USDT transversales
//
// Fail-safe: cualquier país desconocido (o undefined) cae a AR. Esto cubre:
//   · JWT legacy emitido antes de F2 que no tiene tenant.pais.
//   · Refresh de página antes de que /api/auth/me hidrate al user.
//   · Cualquier valor no esperado del backend (defensa en profundidad).
// El fallback a AR es deliberado: el portal nació argentino y la mayoría
// de tenants son AR. UY se opta-in vía signup explícito (F4).

const MONEDAS_POR_PAIS = {
  AR: ['ARS', 'USD', 'USDT'],
  UY: ['UYU', 'USD', 'USDT'],
};

const MONEDA_LOCAL_POR_PAIS = {
  AR: 'ARS',
  UY: 'UYU',
};

// Para mostrar en banner / topbar. Flag emoji + label legible.
// Mantenemos solo los países habilitados — si en el futuro se agrega CL/MX,
// se extiende acá y en la migration de DB.
const PAIS_LABEL = {
  AR: { flag: '🇦🇷', nombre: 'Argentina' },
  UY: { flag: '🇺🇾', nombre: 'Uruguay' },
};

export function getMonedasParaPais(pais) {
  return MONEDAS_POR_PAIS[pais] || MONEDAS_POR_PAIS.AR;
}

export function getMonedaLocalParaPais(pais) {
  return MONEDA_LOCAL_POR_PAIS[pais] || 'ARS';
}

export function getPaisLabel(pais) {
  return PAIS_LABEL[pais] || PAIS_LABEL.AR;
}

// Helper para dropdowns que editan registros existentes: si el valor
// preexistente (e.g. una venta vieja con moneda='ARS' en un tenant que
// ahora es UY) no está en la lista, lo agregamos para no romper la
// edición. Evita el "valor inválido / select vacío" en records legacy.
export function getMonedasConValor(pais, valorActual) {
  const base = getMonedasParaPais(pais);
  if (!valorActual || base.includes(valorActual)) return base;
  return [...base, valorActual];
}
