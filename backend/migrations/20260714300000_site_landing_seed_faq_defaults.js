/**
 * Seed las 6 FAQ default de la landing en `site_landing_config.faq`.
 *
 * 2026-07-14 (bug reportado por Lucas): la landing muestra 6 FAQ hardcodeadas
 * (FALLBACK_FAQ en `frontend/src/screens/Landing.jsx`) cuando `faq = []` en DB.
 * El back office (admin.tecnyapp.com → Sitio público) muestra "Todavía no
 * cargaste ninguna pregunta", lo que es confuso — el operador no ve lo que
 * está publicado. Este seed lo alinea: al abrir el admin, ve las 6 preguntas
 * reales que el visitante lee, y puede editarlas o borrarlas.
 *
 * Idempotente: solo actualiza si `faq` está vacío / es `[]`. Si el operador
 * ya editó (aunque sea 1 pregunta), no tocamos. Rollback: down borra el seed
 * SOLO si el JSON sigue exactamente igual al que sembramos (comparación por
 * jsonb =). No tocamos ediciones del operador.
 *
 * IDs: UUIDs canónicos generados una vez y hardcodeados acá — así el shape
 * es estable, el rollback puede comparar por `=`, y el front puede react-key
 * de forma determinística.
 *
 * Nota conceptual: mantenemos también el FALLBACK_FAQ en Landing.jsx como
 * safety net (si el fetch al backend falla, la landing sigue mostrando algo
 * razonable). Este seed hace que en el caso normal, DB manda.
 */

const FAQ_DEFAULTS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    question: '¿Necesito instalar algo?',
    answer: 'No. Tecny funciona desde el navegador, en la compu o el celular. Creás tu cuenta y empezás a usarlo en minutos, sin descargas ni configuración técnica.',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    question: '¿Cómo funciona el lector de comprobantes (OCR)?',
    answer: 'Sacás una foto del comprobante de pago o subís el PDF, y el sistema detecta el monto automáticamente con inteligencia artificial. Si la confianza es alta, queda pre-cargado; si no, te avisa para que lo revises. Aceptamos JPG, PNG, WEBP y PDF de hasta 5 MB.',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    question: '¿Mis vendedores van a ver toda la información?',
    answer: 'Vos decidís. Cada usuario tiene permisos por módulo: podés darle acceso solo al Cotizador y Envíos, por ejemplo, mientras que la parte financiera y de caja queda reservada para administradores.',
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    question: '¿Puedo manejar pesos y dólares?',
    answer: 'Sí. Cuentas corrientes, cajas, comprobantes y catálogo de usados manejan ARS y USD por separado, sin mezclarlos. El cotizador convierte con el tipo de cambio que vos cargues.',
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    question: '¿Qué pasa con mis datos si dejo de usarlo?',
    answer: 'Tus datos son tuyos. Podés exportarlos en cualquier momento. Nada se borra de forma definitiva sin tu confirmación — el sistema usa borrado suave para que nunca pierdas un registro por error.',
  },
  {
    id: '66666666-6666-4666-8666-666666666666',
    question: '¿Ofrecen prueba gratis?',
    answer: '14 días gratis con todas las funciones, sin tarjeta de crédito. Si te sirve, elegís un plan; si no, no pagás nada.',
  },
];

// Escapamos single-quotes para inlining SQL. Los answers pueden contener
// apostrofes en frases como "no" — pattern estándar en PG: '' escapa una.
// node-pg-migrate `pgm.sql` no soporta parámetros $1, así que inlineamos.
const FAQ_JSON = JSON.stringify(FAQ_DEFAULTS).replace(/'/g, "''");

exports.up = (pgm) => {
  // Idempotente: solo aplicamos si `faq` está vacío. Evita pisar ediciones
  // del operador si por algún motivo la migration se re-ejecuta o si el
  // seed corre después de que el operador cargó algo.
  pgm.sql(`
    UPDATE site_landing_config
       SET faq = '${FAQ_JSON}'::jsonb
     WHERE id = 1
       AND (faq IS NULL OR jsonb_array_length(faq) = 0)
  `);
};

exports.down = (pgm) => {
  // Solo revertimos si el JSON sigue siendo EXACTAMENTE el que sembramos.
  // Si el operador editó cualquier cosa, respetamos su versión.
  pgm.sql(`
    UPDATE site_landing_config
       SET faq = '[]'::jsonb
     WHERE id = 1
       AND faq = '${FAQ_JSON}'::jsonb
  `);
};
