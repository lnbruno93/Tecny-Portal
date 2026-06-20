// Primitivas UI compartidas del admin console. Cada una es un wrapper
// fino sobre las clases CSS de styles.css — no contienen lógica salvo
// formateo trivial (iconos por nombre, on/off por value match).
//
// Mantenemos el set chico a propósito: estas son las piezas que se repiten
// 3+ veces en mocks. Cualquier cosa nueva debería justificarse en otro PR.

import { Icon } from '../Icons.jsx';

/**
 * Botón base. `kind` define color (default/primary/ghost/danger). `icon` es un
 * nombre del set Icons. `iconOnly` arma un cuadrado sin children visibles.
 *
 * El variant 'danger' (rojo) se usa para acciones destructivas críticas —
 * el caso típico es "Suspender cuenta" en la Ficha de cliente. El color
 * vivo obliga al super-admin a confirmar lo que está haciendo.
 */
export function Btn({
  kind = 'default',
  icon,
  children,
  sm = false,
  iconOnly = false,
  onClick,
  type = 'button',
  disabled = false,
  className = '',
  title,
  ...rest
}) {
  const classes = ['btn'];
  if (kind === 'primary') classes.push('btn-primary');
  else if (kind === 'ghost') classes.push('btn-ghost');
  else if (kind === 'danger') classes.push('btn-danger');
  if (sm) classes.push('btn-sm');
  if (iconOnly) classes.push('btn-icon');
  if (className) classes.push(className);

  return (
    <button
      type={type}
      className={classes.join(' ')}
      onClick={onClick}
      disabled={disabled}
      title={title}
      {...rest}
    >
      {icon && <span className="ico"><Icon name={icon} size={sm ? 13 : 15} /></span>}
      {!iconOnly && children}
    </button>
  );
}

/**
 * Badge tipo chip. `dot` agrega un punto coloreado a la izquierda — útil
 * cuando el badge sustituye a un status sin label.
 */
export function Badge({ tone = 'default', dot = false, children, className = '' }) {
  const classes = ['badge'];
  if (tone && tone !== 'default') classes.push(`badge-${tone}`);
  if (className) classes.push(className);

  return (
    <span className={classes.join(' ')}>
      {dot && (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'currentColor',
            display: 'inline-block',
          }}
        />
      )}
      {children}
    </span>
  );
}

/**
 * Status: dot + label. Tones: pos/neg/info/warn/muted. El dot lo agrega
 * el CSS via ::before — más liviano que renderizar un span por elemento.
 */
export function Status({ tone = 'muted', children, className = '' }) {
  const classes = ['status', `s-${tone}`];
  if (className) classes.push(className);
  return <span className={classes.join(' ')}>{children}</span>;
}

/**
 * Card. Tres variantes:
 *   - default: padding regular, title/actions opcionales arriba
 *   - flush: padding 0, header con border (lo provee card-hd)
 *   - tight: padding chico (para cards densas tipo activity feed)
 */
export function Card({
  title,
  subtitle,
  actions,
  children,
  flush = false,
  tight = false,
  style,
  className = '',
}) {
  const classes = ['card'];
  if (flush) classes.push('card-flush');
  if (tight) classes.push('card-tight');
  if (className) classes.push(className);

  // En flush, el header con border-bottom (.card-hd) hace de separador
  // visual. En default, si hay title lo renderizamos arriba del body con
  // margen pero sin border.
  const hasHeader = title || subtitle || actions;

  return (
    <section className={classes.join(' ')} style={style}>
      {hasHeader && flush && (
        <header className="card-hd">
          <div>
            {title && <div className="card-title">{title}</div>}
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions && <div className="flex-row">{actions}</div>}
        </header>
      )}
      {hasHeader && !flush && (
        <header className="flex-between" style={{ marginBottom: 12 }}>
          <div>
            {title && <div className="card-title">{title}</div>}
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions && <div className="flex-row">{actions}</div>}
        </header>
      )}
      {flush ? <div className="card-body">{children}</div> : children}
    </section>
  );
}

// Helper común: normaliza options que pueden venir como strings o {value,label}.
function normalizeOptions(options) {
  return (options || []).map((o) =>
    typeof o === 'string' ? { value: o, label: o } : o
  );
}

/**
 * Segmented control (pill switcher). Stateless: parent maneja value.
 */
export function Seg({ value, options, onChange, className = '' }) {
  const opts = normalizeOptions(options);
  const classes = ['seg'];
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} role="tablist">
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange?.(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Tabs con underline. Misma API que Seg pero look distinto (full-width
 * row con border-bottom). Stateless también.
 */
export function Tabs({ value, options, onChange, className = '' }) {
  const opts = normalizeOptions(options);
  const classes = ['tabs'];
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} role="tablist">
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange?.(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Header de página: label chip (uppercase pequeño), título, subtítulo,
 * acciones a la derecha. Reemplaza el patrón ad-hoc de `<h1>` + flex-between
 * que se repetía en cada pantalla del portal.
 */
export function PageHead({ label, title, subtitle, actions, breadcrumb }) {
  return (
    <div className="page-head">
      <div>
        {label && <div className="label-chip">{label}</div>}
        {breadcrumb}
        {title && <h1 className="page-title">{title}</h1>}
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
