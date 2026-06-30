import { describe, it, expect } from 'vitest';
import {
  getMonedasParaPais,
  getMonedaLocalParaPais,
  getPaisLabel,
  getMonedasConValor,
} from './monedasPais';

describe('monedasPais', () => {
  describe('getMonedasParaPais', () => {
    it('AR → ARS + USD + USDT', () => {
      expect(getMonedasParaPais('AR')).toEqual(['ARS', 'USD', 'USDT']);
    });

    it('UY → UYU + USD + USDT (sin ARS)', () => {
      expect(getMonedasParaPais('UY')).toEqual(['UYU', 'USD', 'USDT']);
    });

    it('país desconocido → fallback AR', () => {
      expect(getMonedasParaPais('XX')).toEqual(['ARS', 'USD', 'USDT']);
      expect(getMonedasParaPais('CL')).toEqual(['ARS', 'USD', 'USDT']);
    });

    it('undefined/null → fallback AR (cubre JWT legacy sin tenant.pais)', () => {
      expect(getMonedasParaPais(undefined)).toEqual(['ARS', 'USD', 'USDT']);
      expect(getMonedasParaPais(null)).toEqual(['ARS', 'USD', 'USDT']);
      expect(getMonedasParaPais('')).toEqual(['ARS', 'USD', 'USDT']);
    });
  });

  describe('getMonedaLocalParaPais', () => {
    it('AR → ARS, UY → UYU', () => {
      expect(getMonedaLocalParaPais('AR')).toBe('ARS');
      expect(getMonedaLocalParaPais('UY')).toBe('UYU');
    });

    it('fallback AR para país desconocido o undefined', () => {
      expect(getMonedaLocalParaPais('XX')).toBe('ARS');
      expect(getMonedaLocalParaPais(undefined)).toBe('ARS');
    });
  });

  describe('getPaisLabel', () => {
    it('devuelve flag + nombre para países habilitados', () => {
      expect(getPaisLabel('AR')).toEqual({ flag: '🇦🇷', nombre: 'Argentina' });
      expect(getPaisLabel('UY')).toEqual({ flag: '🇺🇾', nombre: 'Uruguay' });
    });

    it('fallback AR para país desconocido', () => {
      expect(getPaisLabel('XX')).toEqual({ flag: '🇦🇷', nombre: 'Argentina' });
    });
  });

  describe('getMonedasConValor (legacy edit guard)', () => {
    // Caso: una venta vieja tiene moneda='ARS' y el tenant ahora es UY.
    // Sin esto, el <select> mostraría el value pero sin <option> matching
    // y el form quedaría visualmente "vacío" — el operador podría sin
    // querer cambiar la moneda al guardar.
    it('si el valor actual ya está en la lista, no duplica', () => {
      expect(getMonedasConValor('UY', 'USD')).toEqual(['UYU', 'USD', 'USDT']);
    });

    it('si el valor actual NO está en la lista, lo agrega al final', () => {
      expect(getMonedasConValor('UY', 'ARS')).toEqual(['UYU', 'USD', 'USDT', 'ARS']);
    });

    it('si el valor actual es falsy, retorna la lista base', () => {
      expect(getMonedasConValor('UY', '')).toEqual(['UYU', 'USD', 'USDT']);
      expect(getMonedasConValor('UY', null)).toEqual(['UYU', 'USD', 'USDT']);
      expect(getMonedasConValor('UY', undefined)).toEqual(['UYU', 'USD', 'USDT']);
    });
  });
});
