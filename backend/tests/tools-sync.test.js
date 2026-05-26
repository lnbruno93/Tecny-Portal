/**
 * Guard anti-drift: la lista TOOLS del frontend (frontend/src/lib/tools.js)
 * debe coincidir con la del backend (src/lib/tools.js). Si alguien agrega un
 * módulo en un lado y olvida el otro, este test falla en CI.
 */
const fs = require('fs');
const path = require('path');
const { TOOLS } = require('../src/lib/tools');

test('TOOLS del frontend coincide con el del backend', () => {
  const file = path.join(__dirname, '../../frontend/src/lib/tools.js');
  const src = fs.readFileSync(file, 'utf8');
  const block = src.match(/export const TOOLS = \[([\s\S]*?)\]/);
  expect(block).toBeTruthy();
  const frontTools = (block[1].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''));
  expect([...frontTools].sort()).toEqual([...TOOLS].sort());
});
