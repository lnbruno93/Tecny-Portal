/**
 * Helpers de paginación offset-based.
 *
 * parsePagination(query)  → { page, limit, offset }
 * paginatedResponse(rows, total, opts) → { data, pagination: { total, page, limit, pages } }
 */

function parsePagination(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

function paginatedResponse(rows, total, { page, limit }) {
  return {
    data: rows,
    pagination: {
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

module.exports = { parsePagination, paginatedResponse };
