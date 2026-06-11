// Re-export para back-compat con Ventas.jsx — el componente real vive ahora
// en frontend/src/components/Seg.jsx (U-13, auditoría 2026-06-10). Cuando
// Ventas.jsx migre su import a '../components/Seg', este archivo se borra.
export { default } from '../../components/Seg';
