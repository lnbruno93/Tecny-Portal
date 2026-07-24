// SortableTable — tabla genérica con sort por columna (U-14 auditoría 2026-06-10).
//
// API:
//   <SortableTable
//     columns={[
//       { key: 'nombre', label: 'Nombre', sortable: true },
//       { key: 'precio', label: 'Precio', sortable: true,
//         render: (row) => fmtMoney(row.precio, row.moneda) },
//       { key: 'stock',  label: 'Stock',  sortable: true,
//         sorter: (a, b) => Number(a.stock) - Number(b.stock) },
//     ]}
//     data={rows}
//     initialSort={{ key: 'nombre', dir: 'asc' }}
//     getRowKey={(row) => row.id}
//     className="table"
//   />
//
// Sort:
//   · Click en header con `sortable: true` cicla 3 estados: asc → desc → none.
//   · `aria-sort` se mantiene en cada <th> ('ascending'|'descending'|'none').
//   · Comparator default: numérico si los valores son Number, lexicográfico
//     case-insensitive si son string. Override con `sorter(a, b)` por columna.
//   · Null/undefined se ordenan al final (en asc y desc) — convención
//     "valor faltante = peor que cualquier valor".
//
// Render row:
//   · Si la columna tiene `render(row)`, se usa ese resultado como JSX.
//   · Si no, se renderiza `row[col.key]` tal cual.
//
// Auditoría 2026-06-30 E-04 — perf: paginación cliente opcional vía prop
// `pageSize`. Default `Infinity` (= sin paginar, render todo). Para listados
// grandes (5000 filas del export Tarjetas/Financiera) pasar `pageSize={200}`:
// el componente renderiza solo la slice + nav [« Prev] Página X de Y [Next »].
// La paginación opera SOBRE el resultado ya filtrado/sorteado, así que se
// integra natural con el sort existente (cambiar de página NO altera el sort).
//
// Esta versión NO migra tablas existentes — sólo provee el componente para
// adopción gradual desde el próximo sprint.
import { useMemo, useState, useEffect } from 'react';

function defaultSorter(key) {
  // Devuelve una función comparator (a, b) => number según el tipo del valor.
  // Se decide en tiempo de sort, en base al primer valor no-null encontrado.
  return (a, b) => {
    const va = a?.[key];
    const vb = b?.[key];
    // Null/undefined siempre al final.
    const aNil = va === null || va === undefined || va === '';
    const bNil = vb === null || vb === undefined || vb === '';
    if (aNil && bNil) return 0;
    if (aNil) return 1;
    if (bNil) return -1;
    // Si ambos son números (o strings que parsean limpio), comparar numérico.
    const na = typeof va === 'number' ? va : Number(va);
    const nb = typeof vb === 'number' ? vb : Number(vb);
    if (Number.isFinite(na) && Number.isFinite(nb)
        && String(na) === String(va) && String(nb) === String(vb)) {
      return na - nb;
    }
    if (typeof va === 'number' && typeof vb === 'number') {
      return va - vb;
    }
    // Lexicográfico case-insensitive (es-AR para acentos).
    return String(va).localeCompare(String(vb), 'es-AR', { sensitivity: 'base' });
  };
}

const ARIA_SORT = {
  asc: 'ascending',
  desc: 'descending',
  none: 'none',
};

export default function SortableTable({
  columns,
  data,
  initialSort,
  getRowKey,
  className = 'table',
  // Auditoría 2026-06-30 E-04: si se pasa, activa la paginación cliente.
  // Default Infinity = sin paginar (compat backwards con todas las callsites
  // pre-E-04). Valores numéricos finitos > 0 renderizan solo la slice activa.
  pageSize = Infinity,
}) {
  // Estado del sort: { key, dir } con dir ∈ 'asc' | 'desc' | 'none'.
  // 'none' = sin sort (orden original del array de entrada).
  const [sort, setSort] = useState(() => initialSort || { key: null, dir: 'none' });

  // Paginación cliente (E-04). Página 0-indexed. Si pageSize no es finito,
  // queda en 0 y se renderiza todo (la slice abajo se vuelve no-op).
  const [page, setPage] = useState(0);
  const paginate = Number.isFinite(pageSize) && pageSize > 0;

  function onHeaderClick(col) {
    if (!col.sortable) return;
    setSort(prev => {
      if (prev.key !== col.key) return { key: col.key, dir: 'asc' };
      // Mismo key: cicla asc → desc → none → asc.
      if (prev.dir === 'asc') return { key: col.key, dir: 'desc' };
      if (prev.dir === 'desc') return { key: null, dir: 'none' };
      return { key: col.key, dir: 'asc' };
    });
  }

  const sortedData = useMemo(() => {
    if (!Array.isArray(data)) return [];
    if (!sort.key || sort.dir === 'none') return data;
    const col = columns.find(c => c.key === sort.key);
    if (!col) return data;
    const cmp = col.sorter || defaultSorter(col.key);
    // Copia para no mutar el array entrante.
    const copy = [...data];
    copy.sort((a, b) => {
      const r = cmp(a, b);
      return sort.dir === 'asc' ? r : -r;
    });
    return copy;
  }, [data, columns, sort]);

  // Páginas totales sobre el resultado ya sorteado. Si no paginamos = 1.
  const totalPages = paginate
    ? Math.max(1, Math.ceil(sortedData.length / pageSize))
    : 1;

  // Si el dataset se achica (filtro externo) y la página actual quedó fuera
  // de rango, calculamos un effectivePage clampeado para el render. Además
  // sincronizamos el state vía effect — pero la slice usa `effectivePage`
  // (derivado) así que aun antes del re-render NUNCA mostramos página vacía.
  const effectivePage = paginate ? Math.min(page, totalPages - 1) : 0;
  useEffect(() => {
    // Solo sync de state cuando hay un desfasaje real (page > totalPages-1).
    // Esto cubre el caso "data cambió, page queda obsoleto" sin generar el
    // warning de setState-in-effect en el flujo normal. El render NUNCA
    // depende del state desactualizado porque usamos `effectivePage` derivado.
    if (paginate && page !== effectivePage) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPage(effectivePage);
    }
  }, [paginate, page, effectivePage]);

  // Slice de filas visibles. Sin paginar = todas las filas.
  const visibleRows = useMemo(() => {
    if (!paginate) return sortedData;
    const start = effectivePage * pageSize;
    return sortedData.slice(start, start + pageSize);
  }, [paginate, sortedData, effectivePage, pageSize]);

  return (
    <>
      <table className={className}>
        <thead>
          <tr>
            {columns.map(col => {
              const isActive = sort.key === col.key && sort.dir !== 'none';
              const ariaSort = isActive ? ARIA_SORT[sort.dir] : 'none';
              return (
                <th
                  key={col.key}
                  aria-sort={col.sortable ? ariaSort : undefined}
                  onClick={col.sortable ? () => onHeaderClick(col) : undefined}
                  className={col.sortable ? 'u-sortable-th' : undefined}
                  scope="col"
                >
                  {col.label}
                  {col.sortable && isActive && (
                    <span aria-hidden="true" className="u-ml-4">
                      {sort.dir === 'asc' ? '▲' : '▼'}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row, i) => (
            <tr key={getRowKey ? getRowKey(row) : (row.id ?? i)}>
              {columns.map(col => (
                <td key={col.key}>
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {paginate && totalPages > 1 && (
        // Nav simple — usa clases btn/btn-sm si están disponibles en el host
        // (el resto del portal); el styling cae a defaults del browser si no.
        <div
          className="sortable-table-pager u-sortable-pager"
          role="navigation"
          aria-label="Paginación tabla"
        >
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={effectivePage === 0}
            aria-label="Página anterior"
          >
            « Prev
          </button>
          <span className="tiny mono" aria-live="polite">
            Página {effectivePage + 1} de {totalPages}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={effectivePage >= totalPages - 1}
            aria-label="Página siguiente"
          >
            Next »
          </button>
        </div>
      )}
    </>
  );
}
