import { useState, useEffect, useCallback } from 'react';
import { contactoTipos as api } from './api';

/**
 * Hook para cargar los tipos de contacto del tenant (task #290).
 *
 * Reemplaza las 3 listas hardcoded que había en Contactos.jsx / Cajas.jsx /
 * ContactoPickerEmbedded.jsx. Cada tenant tiene su propia lista editable
 * desde el CRUD en Contactos (admin only).
 *
 * Devuelve:
 *   · tipos       — array de `{id, slug, nombre, orden, activo, is_system}`
 *                  ordenado por (orden ASC, nombre ASC). Solo los ACTIVOS
 *                  (el dropdown no muestra desactivados).
 *   · tiposAll    — array completo incluyendo desactivados (para admin CRUD).
 *   · loading     — true durante el primer fetch.
 *   · error       — string o null.
 *   · reload      — trigger manual de refetch (post mutación).
 *   · labelFor    — helper `(slug) => nombre` para resolver el pretty label
 *                  de un slug legacy. Si el slug NO existe (contacto viejo
 *                  con tipo custom desactivado y borrado), devuelve el slug
 *                  raw como fallback (mejor que romper el UI).
 *
 * Diseño: fetch al mount + `reload()` explícito post-CRUD. Sin cache global
 * — cada consumer tiene su propia copia del state (baratísimo, la lista
 * tiene <10 items típicamente). Si aparece contención, migrar a Context.
 */
export function useContactoTipos() {
  const [tipos, setTipos] = useState([]);
  const [tiposAll, setTiposAll] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    api.list()
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setTiposAll(list);
        setTipos(list.filter((t) => t.activo));
      })
      .catch((e) => { setError(e.message || 'No se pudieron cargar los tipos.'); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const labelFor = useCallback((slug) => {
    if (!slug) return '';
    const t = tiposAll.find((x) => x.slug === slug);
    // Fallback: si el slug ya no existe (borrado post-migración), devolver
    // el slug raw para no mostrar vacío al user.
    return t ? t.nombre : slug;
  }, [tiposAll]);

  return { tipos, tiposAll, loading, error, reload, labelFor };
}
