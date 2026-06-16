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
module.exports = function adminOnly(req, res, next) {
  const tenantRol = req.tenantRol;
  if (tenantRol !== 'owner' && tenantRol !== 'admin') {
    return res.status(403).json({ error: 'Requiere rol admin del tenant' });
  }
  next();
};
