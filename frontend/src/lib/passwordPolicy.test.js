import { describe, it, expect } from 'vitest';
import {
  validatePasswordPolicy,
  MIN_PASSWORD_LENGTH,
  PASSWORD_POLICY_HINT,
} from './passwordPolicy';

describe('passwordPolicy', () => {
  describe('validatePasswordPolicy', () => {
    it('passwords válidas → null', () => {
      expect(validatePasswordPolicy('abc12345')).toBeNull();
      expect(validatePasswordPolicy('LARGO123')).toBeNull();
      expect(validatePasswordPolicy('mEz1clad@')).toBeNull();
    });

    it('vacío o muy corto → error de longitud', () => {
      expect(validatePasswordPolicy('')).toMatch(/Mínimo 8 caracteres/);
      expect(validatePasswordPolicy('abc12')).toMatch(/Mínimo 8 caracteres/);
      expect(validatePasswordPolicy(null)).toMatch(/Mínimo 8 caracteres/);
      expect(validatePasswordPolicy(undefined)).toMatch(/Mínimo 8 caracteres/);
    });

    it('sin letra → error de letra (longitud OK, número OK)', () => {
      expect(validatePasswordPolicy('12345678')).toMatch(/al menos una letra/i);
      expect(validatePasswordPolicy('1234567890')).toMatch(/al menos una letra/i);
    });

    it('sin número → error de número (longitud OK, letra OK)', () => {
      expect(validatePasswordPolicy('abcdefgh')).toMatch(/al menos un número/i);
      expect(validatePasswordPolicy('ABCDEFGH')).toMatch(/al menos un número/i);
    });

    it('orden de chequeos: longitud antes que letra/número', () => {
      // "abc" falla longitud Y letra/número, pero el mensaje debe ser de longitud.
      expect(validatePasswordPolicy('abc')).toMatch(/Mínimo 8 caracteres/);
      expect(validatePasswordPolicy('abc')).not.toMatch(/letra|número/i);
    });

    it('orden: letra antes que número (cuando ambos fallan y longitud OK)', () => {
      // 8+ chars sin letra ni número → debe disparar letra primero.
      expect(validatePasswordPolicy('!@#$%^&*')).toMatch(/al menos una letra/i);
    });
  });

  describe('exports', () => {
    it('MIN_PASSWORD_LENGTH es 8', () => {
      expect(MIN_PASSWORD_LENGTH).toBe(8);
    });

    it('PASSWORD_POLICY_HINT menciona 8 + letra + número', () => {
      expect(PASSWORD_POLICY_HINT).toMatch(/8/);
      expect(PASSWORD_POLICY_HINT).toMatch(/letra/i);
      expect(PASSWORD_POLICY_HINT).toMatch(/número/i);
    });
  });
});
