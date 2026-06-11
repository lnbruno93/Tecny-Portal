// Starter del backend para E2E.
//
// Problema central: backend/server.js corre `dotenv.config({ override: true })`
// que pisa nuestras vars con `backend/.env` (apunta a ipro_preview, la DB de
// dev de Lucas — NUNCA queremos pegarle desde un test).
//
// Solución (3 pasos):
//   1. Forzamos las vars que queremos en process.env.
//   2. Cargamos backend/server.js — su dotenv.config va a override las vars
//      con backend/.env (incluido NODE_ENV=development).
//   3. NO podemos: ya pasó. Por eso necesitamos UN PASO ADICIONAL: monkey-patch
//      del módulo dotenv que backend usa. Ojo: backend tiene su PROPIA copia
//      de dotenv en backend/node_modules/dotenv — distinta de la del root.
//      Hay que patchear ESA específicamente.
//
// La versión final usa `Module._resolveFilename` para forzar que cualquier
// `require('dotenv')` resuelva al patch en lugar del módulo real.

const path = require('path');
const Module = require('module');

// 1) Vars de e2e/.env (si existe) — fallback a defaults.
//    Usamos el dotenv del root para esto (loaded lazily).
try {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
} catch { /* dotenv root puede no estar instalado en CI minimal */ }

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://lucasbruno@localhost:5432/ipro_e2e';
process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'e2e_test_jwt_secret_min_32_chars_padding_xyz';
process.env.TWOFA_ENCRYPTION_KEY = process.env.TWOFA_ENCRYPTION_KEY ||
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.PORT = process.env.PORT || '3001';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

// 2) Interceptar TODO require('dotenv') (cualquier ruta de resolución, sea
//    root o backend) para que devuelva un stub no-op. Así, cuando server.js
//    haga `require('dotenv').config({override:true})`, no pasa nada.
const stubDotenv = {
  config: () => ({ parsed: {} }),
  parse: () => ({}),
  configDotenv: () => ({ parsed: {} }),
  populate: () => ({}),
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'dotenv') {
    // Devolvemos una ruta virtual que mapeamos en _load más abajo.
    return path.resolve(__dirname, '__dotenv_stub__.js');
  }
  return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === 'dotenv' ||
      (typeof request === 'string' && request.endsWith('__dotenv_stub__.js'))) {
    return stubDotenv;
  }
  return origLoad.call(this, request, parent, ...rest);
};

// 3) Arrancar el server (chdir para que rutas relativas resuelvan igual que
//    cuando se corre `node server.js` desde backend/).
process.chdir(path.resolve(__dirname, '../../backend'));
require('../../backend/server.js');
