/**
 * Jest globalTeardown — se ejecuta DESPUÉS de que todas las suites terminan.
 *
 * Cierra el pool singleton de PostgreSQL (src/config/database.js) que las rutas
 * comparten durante los tests. Sin esto, Jest detecta el socket TCP del pool como
 * un "open handle" y fuerza la salida con un warning.
 *
 * Con --runInBand todo corre en el mismo proceso, así que require() devuelve
 * la misma instancia del pool que usaron las rutas durante los tests.
 */
module.exports = async function globalTeardown() {
  try {
    // Cargar las vars de entorno de test (DATABASE_URL) antes de requerir el pool
    const path = require('path');
    require('dotenv').config({ path: path.resolve(__dirname, '../../.env.test') });

    const db = require('../../src/config/database');
    await db.end();
  } catch {
    // Si el pool ya fue cerrado o nunca se abrió — no hay nada que hacer
  }
};
