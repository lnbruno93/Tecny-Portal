const { z } = require('zod');

// Schema para PUT /api/tenant-profile (#multi-tenant Google profile).
//
// Reglas de coherencia (validadas en el handler además del schema):
//   · Si `google_business_enabled` es true, `google_business_name` debe
//     tener al menos 1 char no-whitespace. Sin nombre no tiene sentido
//     mostrar la oración "Nos encontrás en Google como ...".
//   · `google_reviews_count` es opcional incluso con enabled=true — un
//     negocio recién creado puede tener 0 reseñas o no querer mostrar
//     el conteo. El template del cotizador se ajusta:
//       - count > 0 → "...con +N reseñas 5 estrellas"
//       - count = 0 o null → "...en Google" (sin la parte de reseñas)
//
// Sin `.strict()` por diseño: si en el futuro agregamos campos al perfil
// (logo URL, dirección física, teléfono, etc.) queremos que los nuevos
// clientes con builds nuevos puedan enviar esos campos sin romper.
// Actualizar a strict cuando estabilicemos la API.
const updateTenantProfileSchema = z.object({
  google_business_enabled: z.boolean(),
  google_business_name:
    z.string()
      .trim()
      .min(1, 'Nombre del negocio requerido cuando Google está habilitado.')
      .max(200, 'Nombre del negocio demasiado largo (máx 200 caracteres).')
      .nullable()
      .optional(),
  google_reviews_count:
    z.number()
      .int('Cantidad de reseñas debe ser entero')
      .min(0, 'No puede ser negativo')
      .max(1_000_000, 'Cantidad de reseñas demasiado alta')
      .nullable()
      .optional(),
});

module.exports = { updateTenantProfileSchema };
