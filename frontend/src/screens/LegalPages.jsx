// Páginas legales públicas — Términos, Privacidad, Seguridad (#332).
//
// Boilerplate para SaaS en Argentina, alineado con:
//   · Ley 25.326 de Protección de Datos Personales (Habeas Data)
//   · Ley 26.388 de Delitos Informáticos
//   · Código Civil y Comercial (CCyCN) para contratos electrónicos
//   · Disposiciones DNPDP 60-E/2016 (consentimiento) y 18/2015 (transferencias)
//
// El texto es funcional pero NO sustituye revisión legal profesional —
// Lucas afina con abogado especializado en derecho digital antes del primer
// signup pago. Comentario en el commit message del PR para que quede claro.
//
// Diseño:
//   · Una sola route page por doc, todas comparten <LegalLayout>.
//   · Lazy-loaded desde App.jsx (no inflan el bundle del Landing/portal).
//   · Estilo dedicado en LegalPages.css con scope `.tecny-legal`.
//   · ToC inline al inicio para navegación rápida — el contenido es largo
//     y la lectura completa no es realista en mobile.

import { Link } from 'react-router-dom';
import './LegalPages.css';

// ────────────────────────────────────────────────────────────────────────
// Layout compartido — nav minimalista + content area + footer.
// ────────────────────────────────────────────────────────────────────────
function LegalLayout({ kicker, title, lastUpdated, lead, toc, children }) {
  return (
    <div className="tecny-legal">
      <nav className="legal-nav">
        <div className="legal-nav-inner">
          <Link to="/" className="legal-brand">
            <span className="mk">T</span> Tecny
          </Link>
          <Link to="/" className="legal-back">← Volver al inicio</Link>
        </div>
      </nav>

      <main className="legal-wrap" id="main-content">
        <div className="legal-eyebrow">{kicker}</div>
        <h1>{title}</h1>
        <div className="legal-meta">Última actualización: {lastUpdated}</div>

        {lead && <p className="legal-lead">{lead}</p>}

        {toc && (
          <nav className="legal-toc" aria-label="Tabla de contenidos">
            <div className="legal-toc-title">En esta página</div>
            <ol>
              {toc.map((item) => (
                <li key={item.id}>
                  <a href={`#${item.id}`}>{item.label}</a>
                </li>
              ))}
            </ol>
          </nav>
        )}

        {children}
      </main>

      <footer className="legal-foot">
        <div className="legal-foot-inner">
          <div>© 2026 Tecny · Buenos Aires, Argentina</div>
          <div className="legal-foot-links">
            <Link to="/terms">Términos</Link>
            <Link to="/privacy">Privacidad</Link>
            <Link to="/security">Seguridad</Link>
            <Link to="/">Inicio</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// TÉRMINOS Y CONDICIONES
// ────────────────────────────────────────────────────────────────────────
export function TermsPage() {
  const toc = [
    { id: 'aceptacion',    label: '1. Aceptación' },
    { id: 'servicio',      label: '2. El servicio' },
    { id: 'cuenta',        label: '3. Tu cuenta' },
    { id: 'prueba',        label: '4. Prueba gratuita' },
    { id: 'pagos',         label: '5. Planes y pagos' },
    { id: 'uso',           label: '6. Uso aceptable' },
    { id: 'datos',         label: '7. Tus datos' },
    { id: 'propiedad',     label: '8. Propiedad intelectual' },
    { id: 'suspension',    label: '9. Suspensión y baja' },
    { id: 'responsabilidad', label: '10. Limitación de responsabilidad' },
    { id: 'cambios',       label: '11. Cambios en los términos' },
    { id: 'ley',           label: '12. Ley aplicable y jurisdicción' },
    { id: 'contacto',      label: '13. Contacto' },
  ];

  return (
    <LegalLayout
      kicker="Legal"
      title="Términos y Condiciones de uso"
      lastUpdated="22 de junio de 2026"
      lead="Estos términos regulan cómo usás Tecny. Al crear una cuenta o usar el servicio aceptás estos términos. Si no estás de acuerdo, mejor no uses el servicio."
      toc={toc}
    >
      <h2 id="aceptacion">1. Aceptación</h2>
      <p>
        Al registrarte o usar Tecny (el "Servicio") aceptás estos Términos
        y nuestra <Link to="/privacy">Política de Privacidad</Link>. Si lo
        usás en representación de una empresa, confirmás tener autoridad
        para vincular a esa empresa.
      </p>

      <h2 id="servicio">2. El servicio</h2>
      <p>
        Tecny es una plataforma SaaS pensada para revendedores de tecnología:
        cotizaciones, comprobantes con lectura OCR, cuentas corrientes,
        envíos, cajas, gestión de stock y reportes. Operamos desde
        <code> tecnyapp.com</code> y subdominios.
      </p>
      <p>
        El servicio se ofrece "tal cual". Hacemos esfuerzos razonables para
        mantener alta disponibilidad pero no garantizamos uptime 100%. Las
        ventanas de mantenimiento se anuncian con anticipación cuando sean
        planificadas.
      </p>

      <h2 id="cuenta">3. Tu cuenta</h2>
      <ul>
        <li>Necesitás un email válido y verificado para crear cuenta.</li>
        <li>Sos responsable de la confidencialidad de tu contraseña. Te
            recomendamos activar autenticación de dos factores (2FA).</li>
        <li>Sos responsable de toda actividad realizada bajo tu cuenta.</li>
        <li>Notificanos en <code>hola@tecnyapp.com</code> si sospechás de
            uso no autorizado.</li>
      </ul>

      <h2 id="prueba">4. Prueba gratuita</h2>
      <p>
        Toda cuenta nueva incluye <strong>14 días de prueba gratuita</strong>
        con acceso a todas las funcionalidades del plan elegido, sin
        necesidad de cargar tarjeta de crédito. Al finalizar el período,
        si no contrataste un plan pago, las funcionalidades quedan
        suspendidas pero tus datos se conservan según el plazo descrito
        en la Política de Privacidad.
      </p>

      <h2 id="pagos">5. Planes y pagos</h2>
      <p>
        Los planes y precios vigentes están publicados en
        {' '}<Link to="/">tecnyapp.com</Link>. Los precios están expresados
        en dólares estadounidenses (USD) y se facturan mensualmente por
        adelantado. Podemos modificar precios con un preaviso mínimo de
        30 días.
      </p>
      <p>
        Cancelás tu suscripción en cualquier momento desde la configuración
        de tu cuenta. La cancelación tiene efecto al final del período
        facturado en curso — no hay reembolsos por períodos no consumidos.
      </p>

      <h2 id="uso">6. Uso aceptable</h2>
      <p>No podés usar el Servicio para:</p>
      <ul>
        <li>Actividades ilegales bajo la ley argentina o del país desde
            donde accedés.</li>
        <li>Cargar contenido que infrinja derechos de terceros (marcas,
            propiedad intelectual, privacidad).</li>
        <li>Intentar acceder a cuentas de otros usuarios, escanear nuestra
            infraestructura, o interferir con la operación del Servicio.</li>
        <li>Hacer scraping masivo o uso automatizado que degrade el
            rendimiento para otros usuarios.</li>
        <li>Revender o sublicenciar el acceso sin autorización escrita.</li>
      </ul>

      <h2 id="datos">7. Tus datos</h2>
      <p>
        <strong>Los datos que cargás son tuyos.</strong> Los procesamos
        únicamente para prestarte el Servicio. Podés exportar tus datos
        en cualquier momento desde la app o solicitándolos por email.
      </p>
      <p>
        Detalles completos en nuestra <Link to="/privacy">Política de
        Privacidad</Link>. Las medidas técnicas que aplicamos están
        descritas en <Link to="/security">Seguridad</Link>.
      </p>

      <h2 id="propiedad">8. Propiedad intelectual</h2>
      <p>
        Tecny (software, diseño, marca, documentación) es propiedad nuestra
        y de nuestros licenciantes. No te otorgamos derechos sobre el
        software más allá del uso normal del Servicio durante tu
        suscripción.
      </p>
      <p>
        Si nos enviás sugerencias o feedback, podemos usarlos sin
        compensación ni reconocimiento para mejorar el producto.
      </p>

      <h2 id="suspension">9. Suspensión y baja</h2>
      <p>
        Podemos suspender o dar de baja una cuenta que viole estos
        Términos, con preaviso razonable cuando sea posible. En casos
        graves (fraude, intento de breach de seguridad, abuso) podemos
        actuar sin preaviso y notificar después.
      </p>
      <p>
        Vos podés dar de baja tu cuenta en cualquier momento. Tras la baja,
        tus datos se conservan por el plazo descrito en Privacidad y luego
        se eliminan de forma permanente.
      </p>

      <h2 id="responsabilidad">10. Limitación de responsabilidad</h2>
      <p>
        Dentro de los límites permitidos por la ley aplicable, nuestra
        responsabilidad por cualquier reclamo relacionado con el Servicio
        está limitada al monto efectivamente pagado por vos en los últimos
        12 meses. No respondemos por daños indirectos, lucro cesante,
        pérdida de oportunidades o daños consecuenciales.
      </p>
      <p>
        Sos responsable de mantener copias de seguridad propias de la
        información crítica para tu operación. Aunque hacemos backups
        diarios, ningún sistema es 100% infalible.
      </p>

      <h2 id="cambios">11. Cambios en los términos</h2>
      <p>
        Podemos actualizar estos Términos. Para cambios materiales te
        avisamos por email y/o dentro de la app con al menos 30 días de
        anticipación. Continuar usando el Servicio después de la fecha de
        vigencia implica aceptación de la nueva versión.
      </p>

      <h2 id="ley">12. Ley aplicable y jurisdicción</h2>
      <p>
        Estos Términos se rigen por las leyes de la República Argentina.
        Cualquier controversia se somete a la jurisdicción exclusiva de
        los Tribunales Ordinarios de la Ciudad Autónoma de Buenos Aires,
        con renuncia a cualquier otro fuero que pudiera corresponder.
      </p>

      <h2 id="contacto">13. Contacto</h2>
      <p>
        Dudas sobre estos términos: <code>hola@tecnyapp.com</code>.
      </p>

      <div className="legal-callout">
        <strong>Versión de trabajo.</strong> Este documento es funcional
        pero está pendiente de revisión por asesoramiento legal
        especializado. Si encontrás algo que necesite aclaración,
        escribinos.
      </div>
    </LegalLayout>
  );
}

// ────────────────────────────────────────────────────────────────────────
// POLÍTICA DE PRIVACIDAD
// ────────────────────────────────────────────────────────────────────────
export function PrivacyPage() {
  const toc = [
    { id: 'responsable',   label: '1. Responsable del tratamiento' },
    { id: 'datos',         label: '2. Qué datos tratamos' },
    { id: 'fines',         label: '3. Para qué los usamos' },
    { id: 'base-legal',    label: '4. Base legal del tratamiento' },
    { id: 'terceros',      label: '5. Compartición con terceros' },
    { id: 'internacional', label: '6. Transferencias internacionales' },
    { id: 'retencion',     label: '7. Tiempo de conservación' },
    { id: 'derechos',      label: '8. Tus derechos (ARCO)' },
    { id: 'cookies',       label: '9. Cookies y tecnologías similares' },
    { id: 'seguridad',     label: '10. Seguridad' },
    { id: 'menores',       label: '11. Menores de edad' },
    { id: 'cambios',       label: '12. Cambios en esta política' },
    { id: 'contacto',      label: '13. Contacto y autoridad de control' },
  ];

  return (
    <LegalLayout
      kicker="Privacidad"
      title="Política de Privacidad"
      lastUpdated="22 de junio de 2026"
      lead="Esta política explica qué datos recolectamos, por qué los procesamos, con quién los compartimos y qué derechos tenés sobre ellos. Está alineada con la Ley 25.326 de Protección de Datos Personales de Argentina."
      toc={toc}
    >
      <h2 id="responsable">1. Responsable del tratamiento</h2>
      <p>
        El responsable del tratamiento de los datos personales que
        proceses a través de Tecny es <strong>Tecny</strong>, con
        domicilio en la Ciudad Autónoma de Buenos Aires, Argentina.
        Contacto: <code>hola@tecnyapp.com</code>.
      </p>

      <h2 id="datos">2. Qué datos tratamos</h2>

      <h3>2.1. Datos que vos nos das</h3>
      <ul>
        <li><strong>De cuenta:</strong> email, nombre, contraseña
            (almacenada con hash bcrypt), preferencias de idioma y
            zona horaria, configuración de 2FA si la activás.</li>
        <li><strong>De facturación:</strong> razón social, CUIT, dirección,
            datos de contacto financiero (cuando contratás un plan pago).</li>
        <li><strong>De operación:</strong> información que cargás como
            parte de tu negocio — contactos, clientes, vendedores,
            productos, comprobantes con imágenes, ventas, pagos.
            Estos datos son tuyos: nosotros somos meros encargados de
            tratamiento.</li>
      </ul>

      <h3>2.2. Datos que recolectamos automáticamente</h3>
      <ul>
        <li><strong>Técnicos:</strong> dirección IP, identificador de
            sesión, navegador y sistema operativo, timestamps de acceso,
            request_id para diagnóstico.</li>
        <li><strong>De uso:</strong> qué pantallas visitás dentro de la
            app, qué acciones disparás, latencias de las operaciones.</li>
        <li><strong>De auditoría:</strong> registro inmutable de acciones
            materiales dentro de la app (quién creó/modificó/eliminó
            qué, cuándo) para integridad operativa.</li>
      </ul>

      <h2 id="fines">3. Para qué los usamos</h2>
      <ul>
        <li><strong>Prestar el Servicio:</strong> autenticarte, mostrarte
            tu información, calcular saldos, generar reportes.</li>
        <li><strong>Soporte y comunicación:</strong> responder consultas,
            notificarte de cambios materiales, alertas de seguridad.</li>
        <li><strong>Seguridad:</strong> detectar y prevenir fraude,
            abuso, rate limiting, auditoría forense ante incidentes.</li>
        <li><strong>Mejora del producto:</strong> análisis agregado y
            anonimizado de uso para decidir qué construir. Nunca
            vendemos tus datos para publicidad.</li>
        <li><strong>Obligaciones legales:</strong> conservar registros
            que la ley argentina exige.</li>
      </ul>

      <h2 id="base-legal">4. Base legal del tratamiento</h2>
      <p>
        Tratamos tus datos sobre las siguientes bases legales (Art. 5
        Ley 25.326):
      </p>
      <ul>
        <li><strong>Ejecución del contrato:</strong> cuando el tratamiento
            es necesario para prestarte el Servicio que contrataste.</li>
        <li><strong>Consentimiento:</strong> para usos opcionales (ej.
            newsletters), que podés revocar en cualquier momento.</li>
        <li><strong>Interés legítimo:</strong> para seguridad, prevención
            de fraude y mejora del producto, balanceado con tus derechos.</li>
        <li><strong>Obligación legal:</strong> cuando una norma nos exige
            conservar o reportar.</li>
      </ul>

      <h2 id="terceros">5. Compartición con terceros</h2>
      <p>
        Para operar el Servicio compartimos datos estrictamente necesarios
        con los siguientes proveedores. Todos están bajo contratos que
        los obligan a tratar la información solo para los fines que les
        encomendamos.
      </p>
      <ul>
        <li><strong>Railway:</strong> infraestructura de aplicación y
            base de datos PostgreSQL. Servidores en EEUU.</li>
        <li><strong>Cloudflare R2:</strong> almacenamiento de archivos
            (comprobantes, imágenes de productos). Cuenta empresarial
            con cifrado en reposo.</li>
        <li><strong>Resend:</strong> envío de emails transaccionales
            (verificación de email, reset de contraseña, notificaciones).</li>
        <li><strong>Sentry:</strong> tracking de errores técnicos.
            Sanitizamos PII antes de enviarles datos.</li>
        <li><strong>Anthropic:</strong> proveedor del modelo de lenguaje
            que potencia el asistente conversacional opcional dentro
            de la app. Solo se envían las consultas explícitas del usuario.</li>
        <li><strong>Netlify / Cloudflare DNS:</strong> hosting estático
            del frontend y resolución de DNS.</li>
      </ul>
      <p>
        No vendemos ni alquilamos tus datos personales a terceros para
        fines de marketing.
      </p>

      <h2 id="internacional">6. Transferencias internacionales</h2>
      <p>
        Algunos proveedores citados procesan datos fuera de Argentina
        (principalmente EEUU y la Unión Europea). Las transferencias se
        realizan amparadas en las Disposiciones DNPDP 60-E/2016 y
        contratos con cláusulas estándar que garantizan un nivel de
        protección equivalente al exigido por la Ley 25.326.
      </p>

      <h2 id="retencion">7. Tiempo de conservación</h2>
      <ul>
        <li><strong>Datos de cuenta y operación:</strong> mientras la
            cuenta esté activa, y hasta 90 días después de la baja para
            permitir reactivación o exportación.</li>
        <li><strong>Registros de auditoría:</strong> 5 años post-creación,
            por razones de integridad operativa y eventuales auditorías
            contables/fiscales que pudieran afectarte.</li>
        <li><strong>Comprobantes financieros:</strong> al menos 10 años
            según las normas fiscales y comerciales argentinas.</li>
        <li><strong>Datos técnicos de seguridad (IPs, logs):</strong>
            entre 90 y 180 días.</li>
      </ul>

      <h2 id="derechos">8. Tus derechos (ARCO)</h2>
      <p>
        La Ley 25.326 te reconoce derechos sobre tus datos personales,
        conocidos colectivamente como derechos ARCO:
      </p>
      <ul>
        <li><strong>Acceso:</strong> saber qué datos tuyos tratamos y
            cómo los usamos.</li>
        <li><strong>Rectificación:</strong> corregir datos inexactos o
            incompletos.</li>
        <li><strong>Cancelación:</strong> solicitar la eliminación de
            tus datos cuando ya no sean necesarios o hayas retirado
            tu consentimiento.</li>
        <li><strong>Oposición:</strong> oponerte al tratamiento por
            motivos legítimos.</li>
      </ul>
      <p>
        Para ejercerlos, escribinos a <code>hola@tecnyapp.com</code>
        identificándote. Respondemos dentro de los 10 días corridos
        (Art. 14 Ley 25.326).
      </p>

      <h2 id="cookies">9. Cookies y tecnologías similares</h2>
      <p>
        Usamos cookies estrictamente funcionales para mantener tu sesión
        autenticada (JWT) y recordar preferencias de la app (tema
        claro/oscuro, idioma). No usamos cookies de tracking publicitario
        ni compartimos información con redes sociales para perfilado.
      </p>

      <h2 id="seguridad">10. Seguridad</h2>
      <p>
        Implementamos medidas técnicas y organizativas razonables para
        proteger tus datos: cifrado HTTPS/TLS en tránsito, cifrado en
        reposo, aislamiento estricto entre tenants mediante Row-Level
        Security, hashing de contraseñas con bcrypt, autenticación de
        dos factores opcional, registros de auditoría y backups diarios.
      </p>
      <p>
        Detalle completo en nuestra página de
        {' '}<Link to="/security">Seguridad</Link>.
      </p>

      <h2 id="menores">11. Menores de edad</h2>
      <p>
        Tecny está orientado a uso profesional. No recolectamos
        conscientemente datos de menores de 18 años. Si detectamos una
        cuenta creada por un menor sin consentimiento parental válido,
        la suspenderemos y eliminaremos los datos asociados.
      </p>

      <h2 id="cambios">12. Cambios en esta política</h2>
      <p>
        Si cambiamos esta política te avisaremos por email y dentro de
        la app con preaviso razonable. Continuar usando el Servicio
        después de la fecha de vigencia implica aceptación de la nueva
        versión.
      </p>

      <h2 id="contacto">13. Contacto y autoridad de control</h2>
      <p>
        Para dudas o reclamos relacionados con tus datos personales:
      </p>
      <ul>
        <li>Email: <code>hola@tecnyapp.com</code></li>
        <li>Asunto sugerido: "Privacidad — &lt;tu motivo&gt;"</li>
      </ul>
      <p>
        Si considerás que no atendimos correctamente tu solicitud, podés
        reclamar ante la <strong>Agencia de Acceso a la Información
        Pública</strong> (autoridad de control en materia de protección
        de datos personales en Argentina).
      </p>

      <div className="legal-callout">
        <strong>Versión de trabajo.</strong> Este documento es funcional
        pero está pendiente de revisión por asesoramiento legal
        especializado. Si encontrás algo que necesite aclaración,
        escribinos.
      </div>
    </LegalLayout>
  );
}

// ────────────────────────────────────────────────────────────────────────
// SEGURIDAD
// ────────────────────────────────────────────────────────────────────────
export function SecurityPage() {
  const toc = [
    { id: 'enfoque',       label: '1. Nuestro enfoque' },
    { id: 'arquitectura',  label: '2. Arquitectura multi-tenant' },
    { id: 'cifrado',       label: '3. Cifrado' },
    { id: 'autenticacion', label: '4. Autenticación y autorización' },
    { id: 'auditoria',     label: '5. Auditoría y trazabilidad' },
    { id: 'backups',       label: '6. Backups y continuidad' },
    { id: 'acceso',        label: '7. Acceso interno' },
    { id: 'monitoreo',     label: '8. Monitoreo y respuesta a incidentes' },
    { id: 'reporte',       label: '9. Reportar una vulnerabilidad' },
    { id: 'roadmap',       label: '10. Roadmap de compliance' },
  ];

  return (
    <LegalLayout
      kicker="Seguridad"
      title="Cómo protegemos tus datos"
      lastUpdated="22 de junio de 2026"
      lead="La seguridad no es una feature, es un piso. Tecny maneja información sensible de negocios reales — comprobantes, cuentas corrientes, saldos. Estas son las medidas técnicas que aplicamos para que tu data esté segura."
      toc={toc}
    >
      <h2 id="enfoque">1. Nuestro enfoque</h2>
      <p>
        Diseñamos pensando en aislamiento estricto entre tenants,
        principio de menor privilegio y trazabilidad de toda acción
        material. Cada decisión técnica importante pasa por una
        revisión que considera el impacto si algo sale mal.
      </p>

      <h2 id="arquitectura">2. Arquitectura multi-tenant</h2>
      <p>
        Tu información vive físicamente en una base de datos compartida
        pero está aislada lógicamente del resto de los tenants mediante
        <strong> Row-Level Security (RLS)</strong> de PostgreSQL. Las
        políticas RLS se aplican en cada consulta a nivel de la base, no
        en el código de la aplicación: aunque una capa superior tuviera
        un bug, la base de datos sigue rechazando lecturas cruzadas
        entre tenants.
      </p>
      <ul>
        <li>Cada tabla de operación tiene política <code>FORCE RLS</code>
            por <code>tenant_id</code>.</li>
        <li>El rol de la aplicación es <code>NOSUPERUSER</code> en
            producción: no puede saltearse RLS aunque lo intente.</li>
        <li>Tenemos tests automatizados que verifican el aislamiento
            cross-tenant en cada despliegue.</li>
      </ul>

      <h2 id="cifrado">3. Cifrado</h2>
      <ul>
        <li><strong>En tránsito:</strong> todas las conexiones usan
            HTTPS/TLS 1.2+ con certificados gestionados automáticamente.
            Tenemos HSTS habilitado y una Content Security Policy (CSP)
            restrictiva.</li>
        <li><strong>En reposo:</strong> la base de datos y el storage
            de archivos (Cloudflare R2) están cifrados con AES-256 a
            nivel de proveedor de infraestructura.</li>
        <li><strong>Contraseñas:</strong> nunca se guardan en texto plano.
            Usamos <code>bcrypt</code> con cost factor alto.</li>
      </ul>

      <h2 id="autenticacion">4. Autenticación y autorización</h2>
      <ul>
        <li><strong>Email verificado obligatorio</strong> antes de operar.</li>
        <li><strong>Política de contraseñas:</strong> mínimo 10 caracteres,
            combinación de mayúsculas, minúsculas, números y símbolos.
            Bloqueo de las contraseñas más comunes filtradas.</li>
        <li><strong>2FA con TOTP</strong> opcional para todos los usuarios,
            recomendado fuertemente para administradores.</li>
        <li><strong>JWT de corta duración</strong> con rotación al cambiar
            contraseña.</li>
        <li><strong>Rate limiting</strong> en endpoints de auth para
            prevenir fuerza bruta y enumeración de cuentas.</li>
        <li><strong>Permisos por módulo</strong> dentro del tenant: el
            admin puede dar acceso granular a cada vendedor.</li>
      </ul>

      <h2 id="auditoria">5. Auditoría y trazabilidad</h2>
      <p>
        Cada acción material (creación, modificación, eliminación de
        registros sensibles, cambios de configuración, pagos, etc.)
        queda registrada en un log de auditoría inmutable con:
      </p>
      <ul>
        <li>Usuario que ejecutó la acción</li>
        <li>Timestamp con precisión de milisegundo</li>
        <li>Tabla y registro afectado</li>
        <li>Diff (valor anterior vs. nuevo)</li>
        <li>IP de origen y request_id correlacionable</li>
      </ul>
      <p>
        Los logs están particionados por mes para escalabilidad y
        sometidos a RLS estricto: solo el tenant dueño ve sus propios
        registros.
      </p>

      <h2 id="backups">6. Backups y continuidad</h2>
      <ul>
        <li><strong>Backups automáticos diarios</strong> de la base de
            datos, con retención de 30 días.</li>
        <li><strong>Restauración point-in-time</strong> dentro de la
            ventana de retención.</li>
        <li><strong>Storage de archivos replicado</strong> en múltiples
            regiones de Cloudflare R2.</li>
        <li>Practicamos restauraciones de prueba para verificar que los
            backups efectivamente funcionan, no solo se generan.</li>
      </ul>

      <h2 id="acceso">7. Acceso interno</h2>
      <p>
        El acceso a producción está limitado al equipo de Tecny, con
        registro de cada acceso. Existe una consola separada de
        super-administración (en un dominio distinto y con credenciales
        propias) usada únicamente para gestión de cuentas a nivel de
        proveedor del SaaS — no para acceder a datos operativos de los
        tenants.
      </p>
      <p>
        Toda acción del equipo Tecny sobre datos de tenants queda
        registrada en el mismo log de auditoría que verías sobre tu
        propia operación.
      </p>

      <h2 id="monitoreo">8. Monitoreo y respuesta a incidentes</h2>
      <ul>
        <li>Tracking de errores en tiempo real con sanitización de PII.</li>
        <li>Métricas de latencia, tasa de error y disponibilidad
            monitoreadas continuamente.</li>
        <li>Alertas automáticas ante patrones anómalos (picos de 401,
            errores de DB, latencias fuera de baseline).</li>
        <li>En caso de incidente de seguridad que afecte tus datos,
            te notificaremos por email dentro de las <strong>72 horas</strong>
            de haberlo confirmado, junto con: qué pasó, qué datos
            estuvieron involucrados, qué medidas tomamos y qué
            recomendamos que hagas.</li>
      </ul>

      <h2 id="reporte">9. Reportar una vulnerabilidad</h2>
      <p>
        Si encontraste un problema de seguridad, queremos saberlo.
        Reportalo a <code>hola@tecnyapp.com</code> con el asunto
        "Reporte de seguridad" e idealmente:
      </p>
      <ul>
        <li>Descripción del problema y cómo reproducirlo.</li>
        <li>Impacto potencial (qué tipo de información o acción se
            expondría).</li>
        <li>Sugerencia de remediación si la tenés.</li>
      </ul>
      <p>
        Practicamos <strong>responsible disclosure</strong>: te pedimos
        no divulgar públicamente el detalle hasta que tengamos un fix
        desplegado. Reconocemos el aporte y, cuando aplique, ofrecemos
        compensación a discreción.
      </p>
      <p>
        No iniciamos acciones legales contra reportes de buena fe que
        respeten esta política.
      </p>

      <h2 id="roadmap">10. Roadmap de compliance</h2>
      <p>
        Estamos en proceso de evaluar certificaciones formales (SOC 2
        Type II, ISO 27001) a medida que la base de clientes lo justifique.
        Estos términos y nuestra arquitectura ya están diseñados con esos
        marcos en mente.
      </p>

      <div className="legal-callout">
        <strong>¿Tu empresa requiere un acuerdo de tratamiento de datos
        formal (DPA) o información adicional sobre nuestra postura
        de seguridad?</strong> Escribinos a
        {' '}<code>hola@tecnyapp.com</code> y conversamos.
      </div>
    </LegalLayout>
  );
}
