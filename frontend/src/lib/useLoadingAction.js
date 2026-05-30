// useLoadingAction — hook para acciones async con anti-click-spam.
//
// #F-2: el patrón apareció primero en Ventas.jsx para el botón "Descargar
// comprobante" (M-12): durante la generación del PDF (que importa jspdf,
// ~400KB), el usuario podía clickear varias veces y disparar N descargas.
// Lo solucionamos con un useState(pdfLoading) + early return + try/finally.
//
// Este hook extrae ese patrón para reusar cuando se agregue:
//   - Botón "Generar comprobante" en B2B (futuro)
//   - "Exportar Excel" en cualquier listado grande
//   - "Generar resumen mensual" en CC / Proveedores
//   - Cualquier otra acción async donde queremos disabled + label dinámico.
//
// Uso:
//   const { loading, run } = useLoadingAction();
//
//   async function generarPDF(venta) {
//     await run(async () => {
//       const mod = await import('../lib/generarComprobantePdf');
//       await mod.generarComprobantePdf(venta);
//     });
//   }
//
//   <button disabled={loading} onClick={() => generarPDF(v)}>
//     {loading ? 'Generando…' : 'Descargar comprobante'}
//   </button>
//
// El hook NO maneja errores — el caller es responsable de catchear y mostrar
// el toast. Esto preserva la flexibilidad (cada caller decide el mensaje +
// duración + nivel de detalle).
import { useState, useCallback } from 'react';

export default function useLoadingAction() {
  const [loading, setLoading] = useState(false);

  const run = useCallback(async (asyncFn) => {
    if (loading) return undefined; // anti-click-spam: ignore segundo click
    setLoading(true);
    try {
      return await asyncFn();
    } finally {
      setLoading(false);
    }
  }, [loading]);

  return { loading, run };
}
