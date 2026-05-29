// Icons.jsx — Lucide-style icon set, inline SVG components.
// Adapted from design handoff for Vite + React (standard JSX).

const ICO = ({ size = 16, stroke = 1.7, children, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
       stroke="currentColor" strokeWidth={stroke}
       strokeLinecap="round" strokeLinejoin="round" {...p}>
    {children}
  </svg>
);

export const Icons = {
  Home: (p) => <ICO {...p}><path d="M3 12 12 3l9 9" /><path d="M5 10v10h14V10" /></ICO>,
  Grid: (p) => <ICO {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></ICO>,
  Calculator: (p) => <ICO {...p}><rect x="4" y="3" width="16" height="18" rx="2.5" /><rect x="7" y="6.5" width="10" height="3.5" rx="0.6" /><circle cx="8.5" cy="13.5" r="0.6" fill="currentColor" /><circle cx="12" cy="13.5" r="0.6" fill="currentColor" /><circle cx="15.5" cy="13.5" r="0.6" fill="currentColor" /><circle cx="8.5" cy="17" r="0.6" fill="currentColor" /><circle cx="12" cy="17" r="0.6" fill="currentColor" /><circle cx="15.5" cy="17" r="0.6" fill="currentColor" /></ICO>,
  Trend: (p) => <ICO {...p}><path d="M3 17 9 11l4 4 8-9" /><path d="M14 6h7v7" /></ICO>,
  Wallet: (p) => <ICO {...p}><path d="M21 8H6a3 3 0 0 1 0-6h13v6Z" /><path d="M3 5v13a3 3 0 0 0 3 3h15V8" /><circle cx="17" cy="14" r="1.4" fill="currentColor" /></ICO>,
  Truck: (p) => <ICO {...p}><path d="M2 7h11v9H2z" /><path d="M13 10h4l4 4v2h-8" /><circle cx="7" cy="18" r="2" /><circle cx="17.5" cy="18" r="2" /></ICO>,
  Receipt: (p) => <ICO {...p}><path d="M5 3v18l2-1.5L9 21l2-1.5L13 21l2-1.5L17 21l2-1.5V3l-2 1.5L15 3l-2 1.5L11 3 9 4.5 7 3 5 4.5Z" /><path d="M8.5 8h7M8.5 12h7M8.5 16h4" /></ICO>,
  Phone: (p) => <ICO {...p}><rect x="6" y="2" width="12" height="20" rx="2.5" /><circle cx="12" cy="18" r="0.8" fill="currentColor" /><path d="M10 5h4" /></ICO>,
  Users: (p) => <ICO {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="17" cy="9.5" r="2.5" /><path d="M15.5 14.5a5 5 0 0 1 6 5" /></ICO>,
  Settings: (p) => <ICO {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></ICO>,
  Search: (p) => <ICO {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></ICO>,
  Bell: (p) => <ICO {...p}><path d="M6 8a6 6 0 0 1 12 0v5l1.5 3h-15L6 13Z" /><path d="M10 19a2 2 0 0 0 4 0" /></ICO>,
  Plus: (p) => <ICO {...p}><path d="M12 5v14M5 12h14" /></ICO>,
  ArrowRight: (p) => <ICO {...p}><path d="M5 12h14M13 5l7 7-7 7" /></ICO>,
  ArrowUpRight: (p) => <ICO {...p}><path d="M7 17 17 7M8 7h9v9" /></ICO>,
  ArrowDownRight: (p) => <ICO {...p}><path d="M7 7l10 10M17 8v9h-9" /></ICO>,
  Download: (p) => <ICO {...p}><path d="M12 3v13M6 11l6 6 6-6M4 21h16" /></ICO>,
  Upload: (p) => <ICO {...p}><path d="M12 19V6M6 11l6-6 6 6M4 21h16" /></ICO>,
  Share: (p) => <ICO {...p}><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v14" /></ICO>,
  Filter: (p) => <ICO {...p}><path d="M3 5h18l-7 9v6l-4-2v-4Z" /></ICO>,
  Check: (p) => <ICO {...p}><path d="M5 12.5 10 17.5 20 7" /></ICO>,
  X: (p) => <ICO {...p}><path d="M6 6l12 12M18 6 6 18" /></ICO>,
  ChevronRight: (p) => <ICO {...p}><path d="M9 6l6 6-6 6" /></ICO>,
  ChevronDown: (p) => <ICO {...p}><path d="M6 9l6 6 6-6" /></ICO>,
  ChevronUp: (p) => <ICO {...p}><path d="M6 15l6-6 6 6" /></ICO>,
  More: (p) => <ICO {...p}><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></ICO>,
  Sliders: (p) => <ICO {...p}><path d="M4 6h10M18 6h2" /><circle cx="16" cy="6" r="2" /><path d="M4 12h2M10 12h10" /><circle cx="8" cy="12" r="2" /><path d="M4 18h12M20 18h0" /><circle cx="18" cy="18" r="2" /></ICO>,
  CreditCard: (p) => <ICO {...p}><rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="M2.5 10h19M6 15h3" /></ICO>,
  Dollar: (p) => <ICO {...p}><path d="M12 2v20" /><path d="M17 6.5a4 4 0 0 0-4-2.5h-2a3.5 3.5 0 0 0 0 7h2a3.5 3.5 0 0 1 0 7h-2a4 4 0 0 1-4-2.5" /></ICO>,
  Refresh: (p) => <ICO {...p}><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" /><path d="M3 21v-5h5" /></ICO>,
  TrendUp: (p) => <ICO {...p}><path d="M3 17 9 11l4 4 8-9" /><path d="M14 6h7v7" /></ICO>,
  TrendDown: (p) => <ICO {...p}><path d="M3 7l6 6 4-4 8 9" /><path d="M14 18h7v-7" /></ICO>,
  Box: (p) => <ICO {...p}><path d="M3 7v10l9 5 9-5V7l-9-5Z" /><path d="M3 7l9 5 9-5M12 12v10" /></ICO>,
  PieChart: (p) => <ICO {...p}><path d="M12 2v10l8.5 5A10 10 0 1 1 12 2Z" /><path d="M12 2a10 10 0 0 1 10 10h-10Z" /></ICO>,
  Send: (p) => <ICO {...p}><path d="M3 11 21 3l-8 18-2-8Z" /></ICO>,
  Edit: (p) => <ICO {...p}><path d="M4 20h4l11-11-4-4L4 16Z" /><path d="m14 6 4 4" /></ICO>,
  Trash: (p) => <ICO {...p}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></ICO>,
  Eye: (p) => <ICO {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></ICO>,
  EyeOff: (p) => <ICO {...p}><path d="M3 3l18 18" /><path d="M10.5 6.5A10 10 0 0 1 12 5c6.5 0 10 7 10 7a16 16 0 0 1-3.4 4.3" /><path d="M6.7 6.7C3.6 8.6 2 12 2 12s3.5 7 10 7a10 10 0 0 0 5.3-1.6" /><path d="M9.5 9.5a3 3 0 0 0 4 4" /></ICO>,
  Print: (p) => <ICO {...p}><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="9" rx="2" /><path d="M6 14h12v7H6z" /></ICO>,
  Camera: (p) => <ICO {...p}><path d="M3 7h4l2-3h6l2 3h4v12H3Z" /><circle cx="12" cy="13" r="4" /></ICO>,
  Logout: (p) => <ICO {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></ICO>,
  Calendar: (p) => <ICO {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></ICO>,
  Tag: (p) => <ICO {...p}><path d="M3 12V3h9l9 9-9 9Z" /><circle cx="8" cy="8" r="1.5" /></ICO>,
  Building: (p) => <ICO {...p}><path d="M4 21V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16" /><path d="M9 7h1M9 11h1M9 15h1M14 7h1M14 11h1M14 15h1" /><path d="M2 21h20" /></ICO>,
  Globe: (p) => <ICO {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a13 13 0 0 1 0 18A13 13 0 0 1 12 3Z" /></ICO>,
  Sparkle: (p) => <ICO {...p}><path d="M12 3v6M12 15v6M3 12h6M15 12h6" /><path d="m5 5 4 4M15 15l4 4M19 5l-4 4M9 15l-4 4" /></ICO>,
  Shield: (p) => <ICO {...p}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z" /></ICO>,
  Lock: (p) => <ICO {...p}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V8a4 4 0 1 1 8 0v3" /></ICO>,
  Bolt: (p) => <ICO {...p}><path d="M13 2 4 14h7l-1 8 9-12h-7Z" /></ICO>,
  Menu: (p) => <ICO {...p}><path d="M4 6h16M4 12h16M4 18h16" /></ICO>,
};

export default Icons;
