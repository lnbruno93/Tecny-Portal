// migrations-have-down.test.js — 2026-06-11 T-05
//
// Verifica que TODAS las migraciones tengan función `down` exportada. Sin esto,
// un rollback en producción puede fallar a mitad y dejar el schema inconsistente.
//
// El test es lightweight: no corre las migraciones (eso requiere DB y es lento).
// Sólo importa cada archivo y verifica que exporta `up` y `down`. Si alguien se
// olvida de implementar `down` (típico: "no se revierte el seed"), CI lo detecta.
//
// Para migraciones intencionalmente irreversibles (algunas DROP COLUMN no son
// recuperables sin backup), exportar `down: () => {}` (no-op) con comentario
// explicando la razón. NO omitir la función entera — el contrato es que TODA
// migración debe declarar explícitamente su política de rollback.

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

describe('Migrations have up() and down()', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.js'));

  it('hay al menos 1 migración', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)('%s exporta up() y down()', (file) => {
    const mod = require(path.join(MIGRATIONS_DIR, file));
    expect(typeof mod.up).toBe('function');
    expect(typeof mod.down).toBe('function');
  });

  it('los nombres de archivo siguen el patrón YYYYMMDDXXXXXX_nombre.js', () => {
    const bad = files.filter(f => !/^\d{14}_[a-z0-9_-]+\.js$/.test(f));
    expect(bad).toEqual([]);
  });
});
