/**
 * useDebouncedValue — devuelve el valor de entrada con un retardo configurable.
 *
 * Patrón para inputs de búsqueda que disparan fetches al backend: en lugar de
 * pedir al servidor en cada keystroke (lo cual con ILIKE + COUNT(*) suma latencia
 * y carga del pool DB), debounceamos el valor `delay` ms y solo el debounced se
 * usa como dependencia del useEffect que dispara el fetch.
 *
 * Uso:
 *   const [search, setSearch] = useState('');
 *   const dSearch = useDebouncedValue(search, 350);
 *   useEffect(() => {
 *     fetchProductos({ buscar: dSearch });
 *   }, [dSearch]);
 *
 * 350 ms es un buen default: imperceptible para el usuario pero suficiente para
 * evitar una request por tecla. Para listas chiquitas (pantallas con &lt;100 items
 * totales), 250 ms también funciona.
 */
import { useState, useEffect } from 'react';

export function useDebouncedValue(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);

  return debounced;
}

export default useDebouncedValue;
