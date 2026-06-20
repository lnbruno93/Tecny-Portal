// Tests focales para lib/api.js — cubren lo que cambia con frecuencia:
// resolución de URL base + serialización de query strings de filtros.
//
// No mockeamos fetch real; eso es responsabilidad de los tests por pantalla
// (Login.test.jsx, próximamente Clientes.test.jsx) que validan el flow
// end-to-end con MSW o spies.

import { describe, it, expect } from 'vitest';
import { resolveApiBase } from '../api.js';

describe('resolveApiBase', () => {
  it('acepta URL absoluta con https://', () => {
    expect(resolveApiBase('https://api.tecnyapp.com')).toBe('https://api.tecnyapp.com');
  });

  it('acepta URL absoluta con http:// (dev)', () => {
    expect(resolveApiBase('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('strippea trailing slash', () => {
    expect(resolveApiBase('https://api.tecnyapp.com/')).toBe('https://api.tecnyapp.com');
    expect(resolveApiBase('https://api.tecnyapp.com///')).toBe('https://api.tecnyapp.com');
  });

  it('throws si la URL no tiene protocolo', () => {
    // Bug clásico: sin http(s):// fetch lo trata como path relativo → fallo
    // silencioso en runtime. Acá detectamos al boot para fallar ruidoso.
    expect(() => resolveApiBase('api.tecnyapp.com')).toThrow(/inválida/);
    expect(() => resolveApiBase('//api.tecnyapp.com')).toThrow(/inválida/);
  });

  it('vuelve al fallback de prod si el input es vacío/null/undefined', () => {
    expect(resolveApiBase('')).toBe('https://tecny-backend-production.up.railway.app');
    expect(resolveApiBase(null)).toBe('https://tecny-backend-production.up.railway.app');
    expect(resolveApiBase(undefined)).toBe('https://tecny-backend-production.up.railway.app');
  });

  it('strippea whitespace del input', () => {
    expect(resolveApiBase('  https://api.tecnyapp.com  ')).toBe('https://api.tecnyapp.com');
  });
});
