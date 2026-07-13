/**
 * Habilita transferencias entre cajas de DISTINTA moneda con TC manual.
 *
 * 2026-07-13 (feature): antes las transferencias solo se permitían entre
 * cajas del mismo grupo de moneda (ARS↔ARS, UYU↔UYU, USD↔USD/USDT). El
 * cliente reportó que necesita mover plata entre bancos de distinta moneda
 * (ej. Banco Pesos ARS → Banco Dólar USD), especificando él mismo el TC.
 *
 * Ejemplo canónico:
 *   · Banco Tute Pesos baja $1.500.000 (ARS)
 *   · Banco Tute Dólar sube USD 1.500
 *   · TC = 1000 (lo tipea el operador)
 *
 * Diseño (backward-compat):
 *   · Los 3 campos nuevos son nullable. Rows viejas (same-currency) quedan
 *     todas NULL — el handler las lee igual que antes (moneda destino =
 *     moneda origen, monto destino = monto).
 *   · Nuevas rows cross-currency populate los 3.
 *   · CHECK "todo o nada": los 3 juntos o los 3 NULL. Evita estados raros.
 *   · CHECK moneda_destino en el enum del sistema (ARS/UYU/USD/USDT).
 *   · CHECK monto_destino > 0 y tc > 0 cuando presentes.
 *
 * Sin backfill: rows existentes NO se tocan. Su moneda destino sigue
 * infiriéndose como moneda origen en el handler.
 */

exports.up = (pgm) => {
  pgm.addColumns('caja_transferencias', {
    moneda_destino: {
      type: 'text',
      notNull: false,
    },
    monto_destino: {
      type: 'numeric(15,2)',
      notNull: false,
    },
    tc: {
      type: 'numeric(15,6)',
      notNull: false,
    },
  });

  // Todo-o-nada: los 3 campos van juntos o los 3 son NULL.
  pgm.addConstraint('caja_transferencias', 'caja_transferencias_cross_currency_completo', {
    check: `(moneda_destino IS NULL AND monto_destino IS NULL AND tc IS NULL)
         OR (moneda_destino IS NOT NULL AND monto_destino IS NOT NULL AND tc IS NOT NULL)`,
  });

  // Enum de moneda_destino (mismo set que resto del sistema).
  pgm.addConstraint('caja_transferencias', 'caja_transferencias_moneda_destino_check', {
    check: `moneda_destino IS NULL OR moneda_destino IN ('ARS','UYU','USD','USDT')`,
  });

  // Positividad cuando presentes.
  pgm.addConstraint('caja_transferencias', 'caja_transferencias_monto_destino_positive', {
    check: `monto_destino IS NULL OR monto_destino > 0`,
  });
  pgm.addConstraint('caja_transferencias', 'caja_transferencias_tc_positive', {
    check: `tc IS NULL OR tc > 0`,
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('caja_transferencias', 'caja_transferencias_tc_positive', { ifExists: true });
  pgm.dropConstraint('caja_transferencias', 'caja_transferencias_monto_destino_positive', { ifExists: true });
  pgm.dropConstraint('caja_transferencias', 'caja_transferencias_moneda_destino_check', { ifExists: true });
  pgm.dropConstraint('caja_transferencias', 'caja_transferencias_cross_currency_completo', { ifExists: true });
  pgm.dropColumns('caja_transferencias', ['moneda_destino', 'monto_destino', 'tc']);
};
