import { createContext, useContext, useState, useCallback } from 'react';

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

  return (
    <PageActionsContext.Provider value={{ primaryAction, setPrimaryAction }}>
      {children}
    </PageActionsContext.Provider>
  );
}

export function usePageActions() {
  const ctx = useContext(PageActionsContext);
  if (!ctx) throw new Error('usePageActions must be used inside PageActionsProvider');
  return ctx;
}
