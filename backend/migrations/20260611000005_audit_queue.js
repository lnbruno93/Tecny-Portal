/* eslint-disable camelcase */
/**
 * P-07 GRAN auditoría 2026-06-10 — Cola async para audit_logs.
 *
 * Doc de diseño: docs/design/p07-async-audit.md (aprobado por Lucas 2026-06-11).
 *
 * Contexto:
 *   El INSERT a audit_logs se hace dentro del request del caller — agrega
 *   5-15ms por audit y, en handlers bulk (cobranza masiva, venta B2B con N
 *   items), suma >500ms a la latencia del response. El fix recomendado por la
 *   GRAN auditoría es mover el INSERT a una cola persistente procesada por
 *   un worker en background con SKIP LOCKED para multi-instance.
 *
 * Esta migración:
 *   1) Crea la tabla audit_queue con los mismos campos que audit_logs
 *      (excepto created_at, que se preserva como enqueued_at).
 *   2) Seed del feature flag audit_async_enabled con enabled = false. El
 *      bifurcador en audit.js lee este flag (cache TTL 60s) y decide si
 *      encola o persiste sync. Default OFF = comportamiento idéntico al
 *      actual hasta que un admin lo active explícitamente.
 *
 * Notas de diseño:
 *   · NO usamos columna status. Filas pending viven en la queue; al persistir
 *     en audit_logs, se DELETE atomicamente. Evita cleanup posterior + mantiene
 *     la tabla chica en steady state (depth ≈ rate × interval_ms).
 *   · El worker usa DELETE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
 *     RETURNING — patrón estándar de "tomar N rows, procesarlos, no duplicar
 *     entre réplicas". Mismo mecanismo que usa BullMQ + Redis internamente
 *     pero en Postgres puro.
 *   · attempts + last_error quedan reservados para DLQ futuro (TODO
 *     P-07 DLQ en el worker). Por ahora son metadata de debug si una fila
 *     falla N veces.
 *   · NO hay índice en (attempts) ni en last_error — son writes-rarely,
 *     reads-never en operación normal. Si hace falta inspeccionar poison
 *     messages, hacer SELECT * FROM audit_queue WHERE last_error IS NOT NULL
 *     (full scan ok porque la queue es chica).
 *
 * Down: T-05 enforcement. Dropea la tabla + remueve el flag.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE audit_queue (
      id            BIGSERIAL PRIMARY KEY,
      tabla         TEXT NOT NULL,
      accion        TEXT NOT NULL CHECK (accion IN ('INSERT','UPDATE','DELETE')),
      registro_id   INTEGER,
      datos_antes   JSONB,
      datos_despues JSONB,
      user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ip            INET,
      user_agent    TEXT,
      request_id    UUID,
      -- Timestamp del momento que el caller encoló el audit. Lo preservamos
      -- como created_at cuando el worker mueve la fila a audit_logs — así el
      -- orden temporal refleja la operación, no el procesamiento async.
      enqueued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- Metadata de retry / DLQ. attempts++ por cada error; last_error guarda
      -- el mensaje del último fallo. TODO P-07 DLQ: si attempts > 5, mover a
      -- audit_queue_dead.
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT
    );

    -- Indice para el SELECT FOR UPDATE SKIP LOCKED del worker (ordena por
    -- enqueued_at para preservar FIFO).
    CREATE INDEX idx_audit_queue_enqueued ON audit_queue (enqueued_at);
  `);

  pgm.sql(`
    -- Seed del feature flag con enabled=false. El bifurcador en audit.js
    -- arranca leyendo este flag — con default OFF, comportamiento identico al
    -- actual hasta que un admin lo active via PATCH /api/feature-flags.
    INSERT INTO feature_flags (name, enabled, description)
    VALUES (
      'audit_async_enabled',
      false,
      'P-07: encolar audits en audit_queue y procesar async. Default OFF en todos los entornos. Activar manualmente desde PATCH /api/feature-flags/audit_async_enabled cuando este listo para rollout. Rollback = poner enabled=false (toma efecto en <=60s por TTL del cache).'
    )
    ON CONFLICT (name) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS audit_queue;
    DELETE FROM feature_flags WHERE name = 'audit_async_enabled';
  `);
};
