// SE-05 — Audit logs: capturar IP, User-Agent y request_id
//
// Hasta hoy, audit_logs guardaba quién (user_id) y qué (tabla, accion, datos),
// pero no DESDE DÓNDE. Si un incidente de seguridad ocurría (borrado masivo,
// cambio sospechoso), no había forma de responder "¿desde qué IP/dispositivo?".
// Gap de compliance bajo Ley 25.326 art. 9 (medidas de seguridad razonables
// incluyen logging completo).
//
// Esta migración agrega 3 columnas opcionales:
//   - ip          (INET): la IP origen del request, vía req.ip de express
//     (respeta `trust proxy` de Railway).
//   - user_agent  (TEXT): el header User-Agent del request, max 512 chars
//     (truncamos para evitar abuso de almacenamiento).
//   - request_id  (UUID): ID único asignado al request al entrar al middleware
//     (también propagado al logger pino para correlación cross-log).
//
// Las 3 son NULLABLE — registros viejos no se rellenan y nuevos pueden seguir
// loggeando sin IP/UA si el caller no las pasa (defense in depth contra
// regresión).

exports.up = pgm => {
  pgm.addColumns('audit_logs', {
    ip:         { type: 'inet', notNull: false },
    user_agent: { type: 'text', notNull: false },
    request_id: { type: 'uuid', notNull: false },
  });

  // Índice opcional para queries forenses por IP (ej. "todo lo que hizo
  // esta IP en las últimas 24h"). Pequeño costo de escritura, mucho valor
  // en incident response.
  pgm.createIndex('audit_logs', 'ip', {
    name: 'idx_audit_logs_ip',
    where: 'ip IS NOT NULL',
  });

  // Índice por request_id para tracing distribuido (correlar audit + logs
  // de pino). Esperamos volumen bajo de queries por este campo, pero indexar
  // es barato y permite búsqueda O(1).
  pgm.createIndex('audit_logs', 'request_id', {
    name: 'idx_audit_logs_request_id',
    where: 'request_id IS NOT NULL',
  });
};

exports.down = pgm => {
  pgm.dropIndex('audit_logs', 'request_id', { name: 'idx_audit_logs_request_id', ifExists: true });
  pgm.dropIndex('audit_logs', 'ip',         { name: 'idx_audit_logs_ip',         ifExists: true });
  pgm.dropColumns('audit_logs', ['ip', 'user_agent', 'request_id']);
};
