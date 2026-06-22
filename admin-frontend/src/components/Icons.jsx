// Set de iconos Lucide-style del handoff de Claude Design, portado a
// módulo ES. Patrón objeto (no switch en un componente) para que el
// bundler haga tree-shake fácil cuando empecemos a usarlos selectivamente.
//
// Convención: `<Icon name="Box" size={16} />` o `<Icons.Box size={16} />`.
// Stroke en currentColor para que cada icono herede del contexto (text-muted,
// accent, etc.) sin necesidad de override por prop.

function ICO({ size = 16, stroke = 1.7, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icons = {
  Grid: (p) => (
    <ICO {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </ICO>
  ),
  Users: (p) => (
    <ICO {...p}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <circle cx="17" cy="9.5" r="2.5" />
      <path d="M15.5 14.5a5 5 0 0 1 6 5" />
    </ICO>
  ),
  Search: (p) => <ICO {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></ICO>,
  Bell: (p) => (
    <ICO {...p}>
      <path d="M6 8a6 6 0 0 1 12 0v5l1.5 3h-15L6 13Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </ICO>
  ),
  Plus: (p) => <ICO {...p}><path d="M12 5v14M5 12h14" /></ICO>,
  Download: (p) => <ICO {...p}><path d="M12 3v13M6 11l6 6 6-6M4 21h16" /></ICO>,
  X: (p) => <ICO {...p}><path d="M6 6l12 12M18 6 6 18" /></ICO>,
  ChevronRight: (p) => <ICO {...p}><path d="M9 6l6 6-6 6" /></ICO>,
  ChevronUp: (p) => <ICO {...p}><path d="M6 15l6-6 6 6" /></ICO>,
  Sliders: (p) => (
    <ICO {...p}>
      <path d="M4 6h10M18 6h2" />
      <circle cx="16" cy="6" r="2" />
      <path d="M4 12h2M10 12h10" />
      <circle cx="8" cy="12" r="2" />
      <path d="M4 18h12M20 18h0" />
      <circle cx="18" cy="18" r="2" />
    </ICO>
  ),
  CreditCard: (p) => (
    <ICO {...p}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19M6 15h3" />
    </ICO>
  ),
  Dollar: (p) => (
    <ICO {...p}>
      <path d="M12 2v20" />
      <path d="M17 6.5a4 4 0 0 0-4-2.5h-2a3.5 3.5 0 0 0 0 7h2a3.5 3.5 0 0 1 0 7h-2a4 4 0 0 1-4-2.5" />
    </ICO>
  ),
  Refresh: (p) => (
    <ICO {...p}>
      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
      <path d="M3 21v-5h5" />
    </ICO>
  ),
  TrendUp: (p) => <ICO {...p}><path d="M3 17 9 11l4 4 8-9" /><path d="M14 6h7v7" /></ICO>,
  Box: (p) => (
    <ICO {...p}>
      <path d="M3 7v10l9 5 9-5V7l-9-5Z" />
      <path d="M3 7l9 5 9-5M12 12v10" />
    </ICO>
  ),
  Edit: (p) => (
    <ICO {...p}>
      <path d="M4 20h4l11-11-4-4L4 16Z" />
      <path d="m14 6 4 4" />
    </ICO>
  ),
  Logout: (p) => (
    <ICO {...p}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </ICO>
  ),
  Calendar: (p) => (
    <ICO {...p}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </ICO>
  ),
  Tag: (p) => <ICO {...p}><path d="M3 12V3h9l9 9-9 9Z" /><circle cx="8" cy="8" r="1.5" /></ICO>,
  Building: (p) => (
    <ICO {...p}>
      <path d="M4 21V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16" />
      <path d="M9 7h1M9 11h1M9 15h1M14 7h1M14 11h1M14 15h1" />
      <path d="M2 21h20" />
    </ICO>
  ),
  Sparkle: (p) => (
    <ICO {...p}>
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6" />
      <path d="m5 5 4 4M15 15l4 4M19 5l-4 4M9 15l-4 4" />
    </ICO>
  ),
  Lock: (p) => (
    <ICO {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 1 1 8 0v3" />
    </ICO>
  ),
  Bolt: (p) => <ICO {...p}><path d="M13 2 4 14h7l-1 8 9-12h-7Z" /></ICO>,
};

// Helper para resolver iconos por nombre (string). Las primitivas Btn/Tab
// reciben strings (no componentes) para no obligar a importar cada icono
// en cada call-site.
export function Icon({ name, size = 16, ...rest }) {
  const Cmp = Icons[name];
  if (!Cmp) return null;
  return <Cmp size={size} {...rest} />;
}

export default Icons;
