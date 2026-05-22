/* eslint-disable camelcase */
'use strict';

/**
 * Seed inicial del catálogo de usados — 50 equipos cargados desde Celnyx / Google Sheets
 * Migración idempotente: solo inserta si la tabla está vacía.
 */
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO catalogo_usados (equipo, capacidad, pct_bateria, precio_usd, comentarios)
    SELECT equipo, capacidad, pct_bateria, precio_usd, comentarios
    FROM (VALUES
      ('iPhone 13',        '128GB', '85% a 89%',  200.00, NULL),
      ('iPhone 13',        '128GB', '90% a 100%', 220.00, NULL),
      ('iPhone 13 Pro',    '128GB', '85% a 89%',  300.00, NULL),
      ('iPhone 13 Pro',    '128GB', '90% a 100%', 320.00, NULL),
      ('iPhone 13 Pro',    '256GB', '85% a 89%',  330.00, NULL),
      ('iPhone 13 Pro',    '256GB', '90% a 100%', 350.00, NULL),
      ('iPhone 13 Pro Max','128GB', '85% a 89%',  360.00, NULL),
      ('iPhone 13 Pro Max','128GB', '90% a 100%', 380.00, NULL),
      ('iPhone 13 Pro Max','256GB', '85% a 89%',  410.00, NULL),
      ('iPhone 13 Pro Max','256GB', '90% a 100%', 430.00, NULL),
      ('iPhone 14',        '128GB', '85% a 89%',  260.00, NULL),
      ('iPhone 14',        '128GB', '90% a 100%', 280.00, NULL),
      ('iPhone 14',        '256GB', '85% a 89%',  280.00, NULL),
      ('iPhone 14',        '256GB', '90% a 100%', 300.00, NULL),
      ('iPhone 14 Plus',   '128GB', '85% a 89%',  270.00, NULL),
      ('iPhone 14 Plus',   '128GB', '90% a 100%', 290.00, NULL),
      ('iPhone 14 Plus',   '256GB', '85% a 89%',  300.00, NULL),
      ('iPhone 14 Plus',   '256GB', '90% a 100%', 320.00, NULL),
      ('iPhone 14 Pro',    '128GB', '85% a 89%',  400.00, NULL),
      ('iPhone 14 Pro',    '128GB', '90% a 100%', 420.00, NULL),
      ('iPhone 14 Pro',    '256GB', '85% a 89%',  410.00, NULL),
      ('iPhone 14 Pro',    '256GB', '90% a 100%', 440.00, NULL),
      ('iPhone 14 Pro Max','128GB', '85% a 89%',  450.00, NULL),
      ('iPhone 14 Pro Max','128GB', '90% a 100%', 460.00, NULL),
      ('iPhone 14 Pro Max','256GB', '85% a 89%',  460.00, NULL),
      ('iPhone 14 Pro Max','256GB', '90% a 100%', 480.00, NULL),
      ('iPhone 15',        '128GB', '85% a 89%',  380.00, 'Aplica a 15 Plus'),
      ('iPhone 15',        '128GB', '90% a 100%', 400.00, 'Aplica a 15 Plus'),
      ('iPhone 15',        '256GB', '85% a 89%',  390.00, 'Aplica a 15 Plus'),
      ('iPhone 15',        '256GB', '90% a 100%', 410.00, 'Aplica a 15 Plus'),
      ('iPhone 15 Pro',    '128GB', '85% a 89%',  490.00, NULL),
      ('iPhone 15 Pro',    '128GB', '90% a 100%', 530.00, NULL),
      ('iPhone 15 Pro',    '256GB', '85% a 89%',  510.00, NULL),
      ('iPhone 15 Pro',    '256GB', '90% a 100%', 540.00, NULL),
      ('iPhone 15 Pro Max','256GB', '85% a 89%',  580.00, NULL),
      ('iPhone 15 Pro Max','256GB', '90% a 100%', 600.00, NULL),
      ('iPhone 15 Pro Max','512GB', '85% a 89%',  650.00, NULL),
      ('iPhone 15 Pro Max','512GB', '90% a 100%', 670.00, NULL),
      ('iPhone 16',        '128GB', '85% a 89%',  480.00, 'Aplica a 16 Plus [ +15 USD, a considerar ]'),
      ('iPhone 16',        '128GB', '90% a 100%', 500.00, 'Aplica a 16 Plus [ +15 USD, a considerar ]'),
      ('iPhone 16',        '256GB', '85% a 89%',  500.00, 'Aplica a 16 Plus [ +15 USD, a considerar ]'),
      ('iPhone 16',        '256GB', '90% a 100%', 520.00, 'Aplica a 16 Plus [ +15 USD, a considerar ]'),
      ('iPhone 16 Pro',    '128GB', '85% a 89%',  630.00, NULL),
      ('iPhone 16 Pro',    '128GB', '90% a 100%', 650.00, NULL),
      ('iPhone 16 Pro',    '256GB', '85% a 89%',  700.00, NULL),
      ('iPhone 16 Pro',    '256GB', '90% a 100%', 730.00, NULL),
      ('iPhone 16 Pro Max','256GB', '85% a 89%',  790.00, NULL),
      ('iPhone 16 Pro Max','256GB', '90% a 100%', 820.00, NULL),
      ('iPhone 16 Pro Max','512GB', '85% a 89%',  800.00, NULL),
      ('iPhone 16 Pro Max','512GB', '90% a 100%', 840.00, NULL)
    ) AS t(equipo, capacidad, pct_bateria, precio_usd, comentarios)
    WHERE NOT EXISTS (SELECT 1 FROM catalogo_usados WHERE deleted_at IS NULL LIMIT 1);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM catalogo_usados WHERE created_at >= '2026-05-22';`);
};
