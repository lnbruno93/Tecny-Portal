# TypeScript en frontend

Decisión: TANDA 6 / M-07 (auditoría 2026-06-10). Migración **gradual**, archivo
por archivo. Base instalada en `tanda/6-typescript-setup` (2026-06-11). Solo
frontend en este sprint — backend queda en JS, requiere su propio scope.

## Estado actual

- `typescript@^6` + `@types/react` + `@types/react-dom` instalados como devDeps.
- `tsconfig.json` con `strict: true` desde el día 1, `allowJs: true` para que
  `.js` y `.ts` coexistan durante la migración. `checkJs: false` — solo
  type-check de archivos `.ts`/`.tsx`, los `.js` quedan tal cual.
- `noEmit: true` — Vite (esbuild/SWC) compila el código; `tsc` solo valida.
- Archivos ya migrados: `src/lib/format.ts`, `src/lib/money.ts`.

## Comandos

```bash
# Validar tipos (cero errores esperado).
npm run typecheck

# Tests, build, dev → no cambian. Vitest y Vite leen .ts/.tsx nativamente.
npm test
npm run build
npm run dev
```

CI corre `npm run typecheck` antes de los tests en el job `Frontend Tests`.
Un PR que rompa los tipos falla el build.

## Cómo agregar tipos

**Archivos nuevos**: escribir en `.ts` (utilidad pura) o `.tsx` (componente
React) directamente. Sin gymnastics — tipos básicos en parámetros y retornos.

**Archivos viejos** — orden sugerido (heurística "menos riesgo primero"):

1. `src/lib/*.js` puras (sin React, sin estado, sin DOM). Ej: parsers,
   helpers de fecha, formatos. Migración trivial: tipar argumentos.
2. Componentes simples sin estado ni hooks propios.
3. Componentes con `useState`/`useEffect` locales.
4. Hooks custom (`use*.js`).
5. Pantallas grandes (`Ventas`, `Inventario`, `Envios`, etc.).
6. Routers, contexts, `App.jsx`.

### Ejemplo paso a paso (función pura)

Antes — `src/lib/foo.js`:

```js
export function suma(a, b) {
  return Number(a) + Number(b);
}
```

Después — `src/lib/foo.ts`:

```ts
export function suma(a: number | string, b: number | string): number {
  return Number(a) + Number(b);
}
```

`git mv foo.js foo.ts`, agregar tipos, correr `npm run typecheck`. Los imports
de otros `.js`/`.jsx` siguen funcionando porque `allowJs: true` y `moduleResolution: "Bundler"`
permiten extensión transparente.

### Ejemplo (componente React)

```tsx
type Props = { titulo: string; onClose: () => void };

export function Modal({ titulo, onClose }: Props) {
  return <div onClick={onClose}>{titulo}</div>;
}
```

## Política de tipos

- `strict: true` siempre. Prohibido `// @ts-ignore` sin comentario que explique.
- Preferir `unknown` sobre `any`. Si no queda otra, comentar por qué.
- Tipos compartidos (Moneda, IDs, payloads de API) van en `src/lib/types.ts`
  o exportados desde el archivo que los define (ej. `Moneda` en `format.ts`).
- Tests `.test.js` pueden consumir módulos `.ts` sin tocar nada — Vitest
  resuelve `.ts` con esbuild internamente.

## Limitaciones del setup gradual

- `checkJs: false` significa que los bugs de tipo en `.js` no se detectan.
  Por diseño: queremos migrar sin bloquear el día a día. Cuando un módulo
  pase a `.ts`, gana el chequeo completo.
- El proyecto NO emite `.d.ts` ni publica como librería. `noEmit: true`
  asegura que `tsc` solo valida.
- Vite 8 con SWC ya soporta `.ts`/`.tsx` sin config extra. No tocamos
  `vite.config.js`.
