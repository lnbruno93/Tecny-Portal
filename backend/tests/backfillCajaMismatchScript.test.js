/**
 * Tests del CLI + helpers del script backfill-caja-mismatch.js.
 *
 * NO probamos la parte que toca DB — eso vive en el helper puro
 * (backfillCajaMismatch.js, cubierto en su propio test) + el apply real
 * se valida en staging/prod con el dry-run antes.
 *
 * Sí probamos el CLI porque un bug en parseArgs puede hacer que el
 * operador crea que está corriendo dry-run cuando en realidad está
 * aplicando (o al revés). Ese error costaría plata real.
 */

// Sobreescribir process.argv NO funciona porque el script hace `require.main
// === module` para arrancar main() — pero como lo importamos, no llega. Los
// exports son puros.
const { parseArgs, tenantLockOffset, SELECT_CANDIDATOS } = require('../scripts/backfill-caja-mismatch');

describe('parseArgs — CLI del backfill', () => {
  it('sin flags → dry-run puro, sin tenant filter', () => {
    expect(parseArgs(['node', 'script.js'])).toEqual({
      apply: false, verbose: false, tenantSlug: null,
    });
  });

  it('--apply solo activa apply (pero apply sin tenant-slug rechazado en runtime)', () => {
    expect(parseArgs(['node', 'script.js', '--apply'])).toEqual({
      apply: true, verbose: false, tenantSlug: null,
    });
  });

  it('--tenant-slug X con espacio como separador', () => {
    expect(parseArgs(['node', 'script.js', '--tenant-slug', 'tekhaus'])).toEqual({
      apply: false, verbose: false, tenantSlug: 'tekhaus',
    });
  });

  it('--tenant-slug=X con equals como separador', () => {
    expect(parseArgs(['node', 'script.js', '--tenant-slug=tekhaus'])).toEqual({
      apply: false, verbose: false, tenantSlug: 'tekhaus',
    });
  });

  it('combinación --apply + --tenant-slug + --verbose', () => {
    expect(parseArgs(['node', 'script.js', '--apply', '--tenant-slug', 'uy1', '-v'])).toEqual({
      apply: true, verbose: true, tenantSlug: 'uy1',
    });
  });

  it('flag desconocido → process.exit(2)', () => {
    const spyErr  = jest.spyOn(console, 'error').mockImplementation(() => {});
    const spyExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    expect(() => parseArgs(['node', 'script.js', '--foo'])).toThrow('exit');
    expect(spyExit).toHaveBeenCalledWith(2);
    spyErr.mockRestore();
    spyExit.mockRestore();
  });
});

describe('tenantLockOffset — hash estable para advisory lock', () => {
  it('mismo slug → mismo offset (determinista)', () => {
    expect(tenantLockOffset('tekhaus')).toBe(tenantLockOffset('tekhaus'));
  });

  it('slugs distintos → offsets distintos (evita colisión de advisory lock)', () => {
    expect(tenantLockOffset('tekhaus')).not.toBe(tenantLockOffset('uytenant'));
    expect(tenantLockOffset('a')).not.toBe(tenantLockOffset('b'));
  });

  it('resultado siempre es int31 no-negativo (compatible con pg_try_advisory_xact_lock int)', () => {
    for (const slug of ['tekhaus', 'uytenant', 'x', 'zzzz-zzz', 'un-tenant-muy-largo-con-guiones']) {
      const off = tenantLockOffset(slug);
      expect(Number.isInteger(off)).toBe(true);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThanOrEqual(0x7FFFFFFF);
    }
  });
});

describe('SELECT_CANDIDATOS — shape del SQL exportado', () => {
  it('menciona los joins críticos (venta_pagos + metodos_pago + tenants)', () => {
    expect(SELECT_CANDIDATOS).toMatch(/FROM caja_movimientos/);
    expect(SELECT_CANDIDATOS).toMatch(/JOIN metodos_pago/);
    expect(SELECT_CANDIDATOS).toMatch(/JOIN venta_pagos/);
    expect(SELECT_CANDIDATOS).toMatch(/JOIN tenants/);
  });

  it('filtra por mismatch de moneda + ref_tabla=ventas + soft-delete', () => {
    expect(SELECT_CANDIDATOS).toMatch(/vp\.moneda != mp\.moneda/);
    expect(SELECT_CANDIDATOS).toMatch(/cm\.ref_tabla = 'ventas'/);
    expect(SELECT_CANDIDATOS).toMatch(/cm\.deleted_at IS NULL/);
    expect(SELECT_CANDIDATOS).toMatch(/mp\.deleted_at IS NULL/);
    expect(SELECT_CANDIDATOS).toMatch(/v\.deleted_at\s+IS NULL/);
  });

  it('excluye CC pagos (no van a caja)', () => {
    expect(SELECT_CANDIDATOS).toMatch(/vp\.es_cuenta_corriente\s*=\s*false/);
  });

  it('acepta filtro opcional por tenant_slug (parametrizado, no interpolado)', () => {
    expect(SELECT_CANDIDATOS).toMatch(/\$1::text IS NULL OR t\.slug = \$1/);
    // Sanity: no hay interpolación literal del slug (evita SQL injection).
    expect(SELECT_CANDIDATOS).not.toMatch(/\+ .*slug/);
  });
});
