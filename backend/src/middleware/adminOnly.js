// adminOnly — gate de operaciones sensibles (bulk-delete, admin tools, etc.).
//
// 2026-06-16 multi-tenant hardening: validamos por `req.tenantRol` del JWT,
// NO por `req.user.role` global. Razón: con self-service onboarding, el
// "owner" de un tenant nuevo se hace admin global automáticamente y obtiene
// acceso a endpoints admin sobre datos de OTROS tenants. El rol global ya no
// sirve como gate de autorización post multi-tenant; el rol POR-tenant
// (tenant_users.rol) sí.
//
// req.tenantRol viene del JWT firmado (auth middleware lo decora desde
// decoded.tenant_rol al loguear). Valores posibles: 'owner' | 'admin' |
// 'member' (CHECK en tabla tenant_users). 'owner' y 'admin' tienen permisos
// admin sobre su propio tenant.
//
// Compat con código legacy que asumía role='admin' global: durante la
// migración a este modelo, el JWT viejo (pre-PR3) no tiene tenant_rol →
// fallback a 'member', que NO pasa este gate. Eso forza re-login a esos
// users — comportamiento correcto: un JWT pre-multi-tenant no debe poder
// usar herramientas admin hasta que regenere su token.
//
// ⚠️  2026-07-27 (audit 07-25 Track C P2-4): NAMING LEGACY vs NUEVO ⚠️
//
// Este middleware usa `req.tenantRol` (rol LEGACY del sistema pre-F4:
// owner/admin/member — enum 3 valores de `tenant_users.rol`).
//
// El middleware nuevo `requireCapability` (F4 2026-06-23) usa
// `req.user.tenant_cap_rol` (owner/admin/vendedor/encargado/lectura/custom
// — 6 valores post capabilities system).
//
// Ambos coexisten hoy. Un dev que agregue un middleware nuevo puede usar
// el "equivocado" y crear un gate débil o inconsistente. Sunset del legacy
// `req.tenantRol` = TODO post cutover completo F4.
//
// TODO (post cutover F4 completo): reescribir esta función como
// `requireCapability('admin_tools')` con capability nueva o reusar el
// pattern del cap-based gate. Criterio de retiro: 0 endpoints usando
// `adminOnly` fuera de super-admin scope. Ver también `requireCapability.js`.
module.exports = function adminOnly(req, res, next) {
  const tenantRol = req.tenantRol;
  if (tenantRol !== 'owner' && tenantRol !== 'admin') {
    return res.status(403).json({ error: 'Requiere rol admin del tenant' });
  }
  next();
};
