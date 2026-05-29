/**
 * useSpreadsheetRows — hook común para los modales spreadsheet de iPro.
 *
 * Auditoría #R-01: CompraProveedorModal, VentaB2BModal y CobranzaMasivaModal
 * repetían el mismo patrón ~80 líneas: state de rows, mkRow, isUsedRow,
 * updCell, addRows, removeRow, applyDefaultsToEmpty, totalUsd, contador
 * "X usadas / N filas".
 *
 * Este hook encapsula esa lógica. El caller solo provee:
 *   - mkRow(prevDefaults): cómo crear una fila vacía (con sticky values)
 *   - isUsedRow(r): cuándo una fila está "usada" (para totales y add)
 *   - initialCount: cuántas filas arranca (default 10)
 *   - addBatch: cuántas filas suma el "+ N filas" (default 10)
 *
 * Devuelve:
 *   - rows, setRows
 *   - updCell(idx, field, val)
 *   - addRows(n?), removeRow(idx)
 *   - applyDefaultsToEmpty(defaults?): pisa filas no usadas con defaults
 *   - usedCount, totalCount
 */
import { useState, useCallback, useMemo } from 'react';

export function useSpreadsheetRows({ mkRow, isUsedRow, initialCount = 10, addBatch = 10, defaults = {} }) {
  const [rows, setRows] = useState(() =>
    Array.from({ length: initialCount }, () => mkRow(defaults))
  );

  const updCell = useCallback((idx, field, val) => {
    setRows(rs => rs.map((r, i) => i === idx ? { ...r, [field]: val } : r));
  }, []);

  const addRows = useCallback((n = addBatch, withDefaults = defaults) => {
    setRows(rs => [...rs, ...Array.from({ length: n }, () => mkRow(withDefaults))]);
  }, [mkRow, addBatch, defaults]);

  const removeRow = useCallback((idx) => {
    setRows(rs => rs.length <= 1 ? rs : rs.filter((_, i) => i !== idx));
  }, []);

  const applyDefaultsToEmpty = useCallback((newDefaults) => {
    setRows(rs => rs.map(r => isUsedRow(r) ? r : mkRow(newDefaults)));
  }, [mkRow, isUsedRow]);

  const usedCount = useMemo(() => rows.filter(isUsedRow).length, [rows, isUsedRow]);

  return {
    rows, setRows,
    updCell, addRows, removeRow, applyDefaultsToEmpty,
    usedCount, totalCount: rows.length,
  };
}

export default useSpreadsheetRows;
