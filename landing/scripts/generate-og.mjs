#!/usr/bin/env node
/**
 * generate-og.mjs — convierte public/og-cover.svg a public/og-cover.png.
 *
 * Corre manualmente cuando se cambia el diseño (o via npm run generate:og).
 * NO corre en el build de Netlify — el PNG se commitea al repo. Motivos:
 *   1. Un solo generate + commit reduce build time de Netlify (~500ms
 *      menos por deploy).
 *   2. La imagen es estable — no cambia por request. Regenerar en cada
 *      build gasta CPU sin ganar nada.
 *   3. Diff visible en git cuando el PNG cambia — audit trail de cuándo
 *      se modificó el og image.
 *
 * Uso:
 *   node scripts/generate-og.mjs
 *   # o
 *   npm run generate:og
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgPath = join(__dirname, '..', 'public', 'og-cover.svg');
const pngPath = join(__dirname, '..', 'public', 'og-cover.png');

const svg = readFileSync(svgPath, 'utf-8');

// Fit-to width 1200 asegura las dimensiones exactas que esperan las platforms
// sociales (1200×630 = 1.91:1 aspect ratio, recomendado por Facebook/Twitter/
// LinkedIn/WhatsApp).
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1200 },
  // Font fallback: si Inter no está en el sistema (típico en macOS local sin
  // instalar), resvg usa system-ui. La imagen queda "correcta" visualmente
  // pero con font distinta. Al re-generar en un sistema con Inter, se
  // actualiza. Para consistencia, considerar embedar Inter en el futuro.
  font: {
    loadSystemFonts: true,
  },
});

const png = resvg.render().asPng();
writeFileSync(pngPath, png);

const kb = (png.length / 1024).toFixed(1);
console.log(`✓ og-cover.png generado (${kb} KB, 1200×630)`);
console.log(`  → ${pngPath}`);
