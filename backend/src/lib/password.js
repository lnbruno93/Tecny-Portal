const { z } = require('zod');

// Política de contraseñas — FUENTE ÚNICA DE VERDAD (auth + usuarios).
// Defensa razonable para un portal de staff interno: mínimo 8, con al menos
// una letra y un número (evita passwords triviales tipo "12345678" o "password").
const MIN_PASSWORD_LENGTH = 8;

const passwordField = () =>
  z.string()
    .min(MIN_PASSWORD_LENGTH, `Password mínimo ${MIN_PASSWORD_LENGTH} caracteres`)
    .regex(/[A-Za-z]/, 'La contraseña debe incluir al menos una letra')
    .regex(/[0-9]/, 'La contraseña debe incluir al menos un número');

module.exports = { MIN_PASSWORD_LENGTH, passwordField };
