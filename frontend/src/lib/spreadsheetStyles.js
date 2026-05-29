/**
 * Estilos compartidos para los modales spreadsheet de iPro.
 * Auditoría #R-01: antes había objetos cellInp y th IDÉNTICOS en los 3
 * modales (CompraProveedorModal, VentaB2BModal, CobranzaMasivaModal).
 */

// Input chico de celda spreadsheet.
export const cellInp = {
  padding: '3px 6px', fontSize: 12, height: 26,
  border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--text)', borderRadius: 4, width: '100%',
  outline: 'none', boxSizing: 'border-box',
};

// Header de columna (<th>) de la planilla.
export const headerTh = {
  padding: '6px 6px', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.05em', textTransform: 'uppercase',
  color: 'var(--text-muted)', textAlign: 'left',
  borderBottom: '1px solid var(--border)',
  borderRight: '1px solid var(--hairline)',
  background: 'var(--surface-2)', whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis',
};

// Banner de error de catálogos (auditoría #H-12).
export const catalogosErrorBanner = {
  padding: '8px 12px', marginBottom: 12, borderRadius: 6,
  background: 'rgba(217,119,6,0.10)', color: 'var(--warn, #d97706)',
  border: '1px solid rgba(217,119,6,0.30)', fontSize: 12,
};
