/**
 * setupFiles — se ejecuta ANTES de que Jest cargue cualquier módulo de test.
 * Carga .env.test para que DATABASE_URL y JWT_SECRET apunten al entorno de test,
 * no al de desarrollo (ipro_portal).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env.test') });
