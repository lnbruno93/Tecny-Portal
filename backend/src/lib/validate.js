/**
 * Middleware factory que valida req.body, req.query o req.params con un schema Zod.
 * Si la validación falla devuelve 400 con errores por campo.
 * Si pasa, reemplaza el source (body/query/params) con los datos parseados por Zod
 * (coerción de tipos incluida).
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const errors = result.error.issues.map(e => ({
        field: e.path.join('.') || 'root',
        error: e.message,
      }));
      return res.status(400).json({ error: 'Datos inválidos', fields: errors });
    }
    req[source] = result.data;
    next();
  };
}

module.exports = validate;
