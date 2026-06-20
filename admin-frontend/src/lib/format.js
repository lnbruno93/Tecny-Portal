// Formatters compartidos para toda la app admin. Centralizados acá para
// que clientes/ficha/resumen rendericen idéntico — el portal de usuarios
// sufrió mucho de cada pantalla armando su propio fmt(); mantenemos esa
// lección.

export const fmt = (n) => {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(Math.round(n));
  return (n < 0 ? '-' : '') + new Intl.NumberFormat('es-AR').format(abs);
};

export const fmtMoney = (n, ccy = 'USD') => {
  if (n == null || isNaN(n)) return '—';
  const sym = ccy === 'USD' ? '$' : ccy + ' ';
  return sym + fmt(n);
};

export const fmtPct = (n, decimals = 1) => {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(decimals) + '%';
};

export const fmtDate = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('es-AR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
};

export const fmtDateTime = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
};

// "Hace X" relativo. Usado en feeds de actividad y last-login del tenant.
// Si pasa de 1 semana, mostramos fecha absoluta — relativo deja de aportar.
export const ago = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const sec = Math.round((now - d) / 1000);
  if (sec < 60) return 'recién';
  if (sec < 3600) return `hace ${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `hace ${Math.floor(sec / 3600)} h`;
  if (sec < 172800) return 'ayer';
  if (sec < 604800) return `hace ${Math.floor(sec / 86400)} d`;
  return fmtDate(iso);
};
