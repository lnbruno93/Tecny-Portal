// downloadBlob — helper compartido para descargar un Blob desde el browser.
//
// Auditoría 2026-07-04 P3: había 6 call sites duplicando el mismo pattern
// (createObjectURL → createElement('a') → click → revokeObjectURL), con
// pequeñas variantes: unos con setTimeout para el revoke, otros sin;
// unos con appendChild antes del click, otros sin. Consolidamos acá con
// la versión más robusta.
//
// Detalles del pattern robusto:
//   - `document.body.appendChild(a)` antes del click: en Firefox el anchor
//     desanexado a veces no dispara el download. Adjuntar y luego remover
//     es la práctica standard (misma razón por la que FileSaver.js lo hace).
//   - `setTimeout(revoke, 0)` en vez de revoke sincrónico: dar un tick al
//     browser para que efectivamente inicie la descarga antes de invalidar
//     la URL. Con `revoke` sincrónico, Safari ocasionalmente cancela.
//   - No aceptamos filename vacío — el browser cae a "download" sin extensión,
//     lo cual es UX confusa. Callers deben pasar filename explícito.
export function downloadBlob(blob, filename) {
  if (!blob) throw new Error('downloadBlob: blob requerido');
  if (!filename) throw new Error('downloadBlob: filename requerido');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Liberar la URL después de un tick — el browser ya disparó la descarga.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default downloadBlob;
