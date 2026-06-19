import { createContext, useContext, useState, useEffect, useCallback } from 'react';

// ThemeContext — toggle dark/light persistido en localStorage.
//
// 2026-06-19: el sistema de tokens CSS ya soportaba 3 temas (vault dark default,
// slate dark variant, linen light editorial). Solo faltaba el control React.
//
// Decisiones de UX tomadas con Lucas:
//   - Light mode = `linen` (warm editorial, NO blanco puro Notion/Linear).
//     Razón: tokens ya estaban y los tints (badges color) ya estaban testeados.
//   - Toggle button en UserPill del sidebar (cerca del avatar, discoverable).
//   - NO respetar `prefers-color-scheme` del SO en primer load — default
//     siempre dark hasta toggleo manual del user. Razón: la base instalada
//     ya está acostumbrada al dark, no queremos saltos visuales sorpresa.
//
// API:
//   const { theme, isLight, isDark, setTheme, toggle } = useTheme();
//   theme ∈ { 'vault' (dark), 'linen' (light) }
//   isLight / isDark son derivados convenientes
//   setTheme('vault' | 'linen') | toggle() ↔ entre los 2
//
// Persist:
//   localStorage('tecny_theme') guarda la elección entre sessions.
//   Si el value es inválido o no hay key → default 'vault' (dark).

const THEMES = ['vault', 'linen'];
const STORAGE_KEY = 'tecny_theme';
const DEFAULT_THEME = 'vault';

const ThemeContext = createContext(null);

function readInitialTheme() {
  // SSR-safe: si window/localStorage no existen (no debería pasar en este
  // proyecto que es 100% client-side, pero por las dudas), default.
  if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_THEME;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && THEMES.includes(saved)) return saved;
  } catch {
    // localStorage puede tirar SecurityError en algunos modos privados/iframe.
    // Fallback silencioso al default.
  }
  return DEFAULT_THEME;
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readInitialTheme);

  // Persistir cada cambio. Aplicamos directamente al <html data-theme=...>
  // como side-effect — así el atributo está disponible incluso si algún
  // componente quiere consultarlo via DOM (e.g. lib externa que detecte
  // tema antes de renderizar React tree).
  //
  // El Shell.jsx también lee `theme` via useTheme() y lo aplica al
  // contenedor `.app data-theme=`, así doble fuente de verdad sincronizada.
  // No es redundancia mala: el documentElement permite que pantallas
  // pre-Shell (loading splash, errores tempranos) hereden el tema sin
  // necesitar que el React tree esté montado.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch { /* localStorage no disponible — el state de React sigue OK */ }
  }, [theme]);

  const setTheme = useCallback((next) => {
    if (!THEMES.includes(next)) {
      // No tirar — solo warn. Defensive: si en el futuro agregamos un tema
      // nuevo y un cliente con bundle viejo recibe el value vía localStorage,
      // que caiga al default en vez de explotar.
      // eslint-disable-next-line no-console
      console.warn(`[ThemeContext] Tema inválido "${next}", se ignora`);
      return;
    }
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    setThemeState(t => (t === 'vault' ? 'linen' : 'vault'));
  }, []);

  const value = {
    theme,
    isDark: theme === 'vault',
    isLight: theme === 'linen',
    setTheme,
    toggle,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme debe usarse dentro de <ThemeProvider>');
  }
  return ctx;
}
