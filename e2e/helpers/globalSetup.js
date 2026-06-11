// globalSetup — corre UNA vez antes de toda la suite Playwright.
//
// Replica lo que backend/tests/helpers/setup.js hace para integración:
//   1. Aplica migraciones (npm run migrate en backend/) contra DATABASE_URL.
//   2. TRUNCATE de todas las tablas + RESTART IDENTITY (DB determinística).
//   3. Re-seed mínimo de metodos_pago (las migraciones lo hacen pero TRUNCATE
//      lo borra; el frontend espera al menos una caja FV).
//   4. Crea el usuario `testadmin` (password `testpass123`, role admin) con
//      TODOS los permisos activos.
//
// Diseño:
//   - NO importamos directamente backend/tests/helpers/setup.js para no
//     acoplarnos a su lifecycle (jest tiene su propio setEnv que toca
//     dotenv). Replicamos el SQL acá. Si el schema cambia, hay que tocar
//     este archivo Y el del backend — anotado como deuda en e2e/README.md.
//
//   - Las vars de entorno (DATABASE_URL etc.) ya las puso playwright.config.js
//     via el `env` del webServer Y también este globalSetup tiene acceso a
//     process.env (Playwright las pasa al proceso globalSetup también).

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');
const { execSync } = require('child_process');

// Repite lo que el config define para asegurar consistencia si alguien
// corre el helper standalone (debug).
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://lucasbruno@localhost:5432/ipro_e2e';
process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'e2e_test_jwt_secret_min_32_chars_padding_xyz';
process.env.TWOFA_ENCRYPTION_KEY = process.env.TWOFA_ENCRYPTION_KEY ||
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Tabla de permisos (lista de tools). Importamos del backend porque la
// lista cambia con features y queremos mantener sync automático.
const { TOOLS } = require(path.resolve(__dirname, '../../backend/src/lib/tools'));

const TEST_USER = {
  nombre:   'Test Admin',
  username: 'testadmin',
  password: 'testpass123',
  role:     'admin',
};

async function globalSetup() {
  // eslint-disable-next-line no-console
  console.log('[e2e] globalSetup — DATABASE_URL=', maskUrl(process.env.DATABASE_URL));

  // 1) Migraciones — corremos el mismo script que producción (node-pg-migrate)
  //    para garantizar paridad con backend tests + prod.
  execSync('npm run migrate', {
    cwd: path.resolve(__dirname, '../../backend'),
    env: { ...process.env },
    stdio: 'inherit',
  });

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // 2) TRUNCATE — copia literal de backend/tests/helpers/setup.js.
  //    CASCADE + RESTART IDENTITY para arrancar con secuencias en 1.
  await pool.query(`
    TRUNCATE TABLE
      audit_logs,
      caja_movimientos,
      cambio_movimientos, cambio_entidades,
      tarjeta_movimientos,
      egresos, egresos_recurrentes, egreso_categorias, ventas_rapidas, canjes, venta_comprobantes, venta_pagos, venta_items, ventas, etiquetas, metodos_pago, plantillas_garantia,
      productos, categorias, depositos,
      proveedor_movimiento_items, proveedor_movimientos, proveedores,
      proyecto_movimientos, proyecto_participantes, proyectos,
      items_movimiento_cc, movimientos_cc, clientes_cc,
      envio_items, envios,
      movimientos_inversiones, movimientos_deudas, contactos,
      comprobantes, pagos, vendedores,
      user_permissions, users
    RESTART IDENTITY CASCADE
  `);

  // 3) Re-seed cajas mínimo (la migración 002 las crea, pero TRUNCATE las borró).
  await pool.query(`
    INSERT INTO metodos_pago (nombre, moneda, orden) VALUES
      ('USD | Efectivo',      'USD',  1),
      ('Pesos Ars | Efectivo','ARS',  2),
      ('Pesos Ars | BBVA GL', 'ARS',  3),
      ('Pesos Ars | BBVA LB', 'ARS',  4),
      ('USD | BBVA GL',       'USD',  5),
      ('Binance | GL',        'USDT', 6)
    ON CONFLICT DO NOTHING
  `);
  await pool.query(`
    UPDATE metodos_pago SET es_financiera = true WHERE nombre = 'Pesos Ars | Efectivo'
  `);

  // 4) Usuario admin de prueba + todos los permisos.
  const hash = await bcrypt.hash(TEST_USER.password, 10);
  const { rows } = await pool.query(
    'INSERT INTO users (nombre, username, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id',
    [TEST_USER.nombre, TEST_USER.username, hash, TEST_USER.role]
  );
  const userId = rows[0].id;

  for (const tool of TOOLS) {
    await pool.query(
      'INSERT INTO user_permissions (user_id, tool, enabled) VALUES ($1,$2,$3)',
      [userId, tool, true]
    );
  }

  await pool.end();
  // eslint-disable-next-line no-console
  console.log('[e2e] globalSetup OK — usuario testadmin creado con id', userId);
}

function maskUrl(u) {
  if (!u) return '(unset)';
  return u.replace(/:[^:@/]+@/, ':***@');
}

module.exports = globalSetup;
module.exports.TEST_USER = TEST_USER;
