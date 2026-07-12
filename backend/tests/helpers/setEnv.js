/**
 * setupFiles — se ejecuta ANTES de que Jest cargue cualquier módulo de test.
 * Carga .env.test para que DATABASE_URL y JWT_SECRET apunten al entorno de test,
 * no al de desarrollo (ipro_portal).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env.test') });

// 2026-07-12 (auditoría TOTAL Plataforma P1-3): activar la instrumentación
// pg_strtoint en TODOS los tests para preservar la cobertura del wrapper.
// En prod queda OFF por default (elimina overhead baseline); en tests queda
// ON para que `database-instrumentation.test.js` verifique el path efectivo.
if (!process.env.DB_INT_CAST_DEBUG) {
  process.env.DB_INT_CAST_DEBUG = '1';
}
