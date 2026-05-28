const { z } = require('zod');

const updateConfigSchema = z.object({
  pct_financiera: z.number().min(0, 'No puede ser negativo').max(100, 'No puede superar 100'),
}).strict();

module.exports = { updateConfigSchema };
