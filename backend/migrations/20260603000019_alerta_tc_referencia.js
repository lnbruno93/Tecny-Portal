/* eslint-disable camelcase */
/**
 * Migración — sumar tipo de alerta 'tc_referencia' a la tabla alertas_config.
 *
 * Diferente a los otros 4 tipos del MVP: 'tc_referencia' NO es una alerta
 * que se evalúa contra la DB (no genera lista de items en /api/alertas).
 * Es un SETTING global que el front consume para mostrar warnings inline
 * en los inputs de TC. Si el usuario tipea un TC por debajo del umbral
 * configurado, ve un mensaje "Chequear Tipo de Cambio. Posible error".
 *
 * Parametros:
 *   - valor              número (default 1400) — TC de referencia ARS/USD.
 *   - tolerancia_pct     número 0-50 (default 1) — % por debajo permitido.
 *   - alerta_por_debajo  boolean (default true) — si activar el warning.
 *
 * El backend NO valida con este valor (no rechaza ventas con TC bajo).
 * Solo es un hint visual del front. La decisión final queda en el usuario.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO alertas_config (tipo, activa, parametros) VALUES
      ('tc_referencia', true, '{"valor": 1400, "tolerancia_pct": 1, "alerta_por_debajo": true}')
    ON CONFLICT (tipo) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM alertas_config WHERE tipo = 'tc_referencia';`);
};
