import { createContext, useContext, useState, useCallback, useMemo } from 'react';

// Each screen can register a "primary action" that the global + button triggers.
// Usage in a screen:
//   const { setPrimaryAction } = usePageActions();
//   useEffect(() => {
//     setPrimaryAction({ label: 'Nuevo equipo', onClick: () => setShowCreate(true) });
//     return () => setPrimaryAction(null);   // cleanup on unmount
//   }, []);

const PageActionsContext = createContext(null);

export function PageActionsProvider({ children }) {
  const [primaryAction, setPrimaryActionState] = useState(null);

  const setPrimaryAction = useCallback((action) => {
    setPrimaryActionState(action);
  }, []);

  // Auditoría 2026-06-30 F-25: memoizar value. Lo consume el Shell para
  // pintar el botón global + cada screen via usePageActions. Sin useMemo,
  // cada cambio en cualquier consumer dispara re-render del Shell entero.
  const value = useMemo(
    () => ({ primaryAction, setPrimaryAction }),
    [primaryAction, setPrimaryAction]
  );

  return (
    <PageActionsContext.Provider value={value}>
      {children}
    </PageActionsContext.Provider>
  );
}

export function usePageActions() {
  const ctx = useContext(PageActionsContext);
  if (!ctx) throw new Error('usePageActions must be used inside PageActionsProvider');
  return ctx;
}
