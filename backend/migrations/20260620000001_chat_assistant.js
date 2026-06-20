/**
 * Migration: Chat Assistant — tablas + RLS multi-tenant (#340 Fase 1).
 *
 * Contexto:
 *   Feature nueva — bot conversacional analítico. Cada user del portal puede
 *   abrir el widget y hacer preguntas en lenguaje natural sobre la data de
 *   SU tenant. El bot llama tools read-only del backend (get_ventas,
 *   get_kpis_cajas, etc.) y responde con datos reales.
 *
 *   Decisiones de diseño (tomadas con Lucas 2026-06-20):
 *     - Conversaciones persisten en DB (no solo en localStorage) para que:
 *       (a) sobrevivan refresh / cambio de dispositivo,
 *       (b) sirvan para context (Claude lee historial al continuar charla),
 *       (c) habiliten future feature "ver mis conversaciones pasadas".
 *     - Multi-tenant: cada conversación es de UN user de UN tenant. RLS lo
 *       filtra automáticamente — un user solo ve SUS conversaciones, no
 *       las de compañeros del mismo tenant ni de otros tenants.
 *     - Mensajes en tabla separada (no JSONB en conversation) para queries
 *       eficientes por rango temporal + paginación nativa + permitir editar
 *       individual sin reescribir toda la conversación.
 *
 * Esquema:
 *   chat_conversations
 *     id           BIGSERIAL PK
 *     tenant_id    INT NOT NULL (RLS — current_setting('app.current_tenant'))
 *     user_id      INT NOT NULL (FK users, RESTRICT delete — perder
 *                  conversaciones por borrar user accidental sería malo)
 *     titulo       TEXT (auto-generado del primer mensaje, editable)
 *     created_at   TIMESTAMPTZ DEFAULT NOW()
 *     updated_at   TIMESTAMPTZ DEFAULT NOW() (refresh on new message)
 *
 *   chat_messages
 *     id              BIGSERIAL PK
 *     conversation_id BIGINT NOT NULL (FK CASCADE — borrar conversación
 *                     borra mensajes)
 *     tenant_id       INT NOT NULL (denormalizado para RLS directa sin
 *                     necesitar JOIN a conversations — perf en feeds grandes)
 *     role            TEXT CHECK (role IN ('user','assistant'))
 *     content         JSONB (formato Anthropic messages API:
 *                     [{type:'text', text:'...'}, {type:'tool_use', ...},
 *                      {type:'tool_result', ...}])
 *                     JSONB porque permite tool_use + tool_result en
 *                     mensajes assistant, multimedia futuro, etc.
 *     tokens_input    INT (cost tracking)
 *     tokens_output   INT
 *     tokens_cached   INT (prompt caching hit — costo distinto)
 *     model           TEXT (audit: qué versión respondió, futureproof
 *                     para cambio de modelos)
 *     created_at      TIMESTAMPTZ DEFAULT NOW()
 *
 *   chat_rate_limits (in-memory sería más rápido pero perderíamos cuenta
 *     al restart — DB-backed más sólido, costos bajos: 1 row por user por
 *     ventana, índice por user_id + window_start)
 *     id           BIGSERIAL PK
 *     tenant_id    INT NOT NULL (RLS)
 *     user_id      INT NOT NULL
 *     window_start TIMESTAMPTZ (truncado a inicio de día UTC)
 *     messages     INT DEFAULT 0
 *     UNIQUE (user_id, window_start) — upsert eficiente
 *
 * Índices:
 *   - chat_conversations(user_id, updated_at DESC): lista "mis conversaciones
 *     recientes" del widget.
 *   - chat_messages(conversation_id, created_at): cargar historial ordenado.
 *   - chat_messages(tenant_id, created_at): observabilidad cost dashboard.
 *   - chat_rate_limits(user_id, window_start): chequeo de límite (UNIQUE
 *     ya provee este índice).
 *
 * RLS:
 *   Las 3 tablas heredan policy tenant_isolation (estricta, sin NULL,
 *   misma del fail-closed migration 20260616000002). Ningún path puede
 *   ver/editar conversaciones cross-tenant.
 */

const TABLAS_CON_RLS = [
  'chat_conversations',
  'chat_messages',
  'chat_rate_limits',
];

const PREDICATE_CLOSED = `tenant_id = current_setting('app.current_tenant', true)::int`;

exports.up = (pgm) => {
  // ── chat_conversations ────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id          BIGSERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      titulo      TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_chat_conv_user_updated
      ON chat_conversations (user_id, updated_at DESC);
    CREATE INDEX idx_chat_conv_tenant
      ON chat_conversations (tenant_id);
  `);

  // ── chat_messages ─────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id              BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content         JSONB NOT NULL,
      tokens_input    INTEGER DEFAULT 0,
      tokens_output   INTEGER DEFAULT 0,
      tokens_cached   INTEGER DEFAULT 0,
      model           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_chat_msg_conv_created
      ON chat_messages (conversation_id, created_at);
    CREATE INDEX idx_chat_msg_tenant_created
      ON chat_messages (tenant_id, created_at DESC);
  `);

  // ── chat_rate_limits ──────────────────────────────────────────────────
  // Tracking per-user diario. Reset implícito al día siguiente vía
  // window_start nueva. Cleanup periódico (job) puede borrar rows con
  // window_start < NOW() - 7 days.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS chat_rate_limits (
      id           BIGSERIAL PRIMARY KEY,
      tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      window_start TIMESTAMPTZ NOT NULL,
      messages     INTEGER NOT NULL DEFAULT 0,
      UNIQUE (user_id, window_start)
    );

    CREATE INDEX idx_chat_rl_tenant_window
      ON chat_rate_limits (tenant_id, window_start);
  `);

  // ── RLS: habilitar + policy estricta (sin NULL fallback) ──────────────
  for (const tabla of TABLAS_CON_RLS) {
    pgm.sql(`
      ALTER TABLE ${tabla} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${tabla} FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ${tabla}
        FOR ALL TO PUBLIC
        USING (${PREDICATE_CLOSED})
        WITH CHECK (${PREDICATE_CLOSED});
    `);
  }
};

exports.down = (pgm) => {
  for (const tabla of TABLAS_CON_RLS) {
    pgm.sql(`
      DROP POLICY IF EXISTS tenant_isolation ON ${tabla};
      ALTER TABLE ${tabla} NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE ${tabla} DISABLE ROW LEVEL SECURITY;
    `);
  }
  pgm.sql(`
    DROP TABLE IF EXISTS chat_rate_limits;
    DROP TABLE IF EXISTS chat_messages;
    DROP TABLE IF EXISTS chat_conversations;
  `);
};
