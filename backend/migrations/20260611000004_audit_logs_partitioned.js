/* eslint-disable camelcase */
/**
 * P-19 GRAN auditoría 2026-06-10 — Particionado de `audit_logs` por mes.
 *
 * Contexto:
 *   audit_logs persiste cada INSERT/UPDATE/DELETE de las tablas críticas. Crece
 *   linealmente con la operación del negocio. A 6 meses la tabla ya tiene cientos
 *   de miles de filas y las queries del dashboard de Mantenimiento empiezan a
 *   sentirlo (a pesar de los índices). La auditoría 2026-06-10 lo marcó como
 *   blocker de escalabilidad.
 *
 * Solución:
 *   PARTITION BY RANGE (created_at) — una partición por mes.
 *
 *   Beneficios:
 *     · Queries con filtro temporal (lo común en /historial) escanean solo
 *       las partitions relevantes vía partition pruning.
 *     · Retención por DROP de partition vieja (milisegundos) en vez de DELETE
 *       masivo (minutos a horas con lock contention).
 *     · VACUUM/ANALYZE corre por partición — más rápido y menos lock-time.
 *
 *   Costos / trade-offs (documentados):
 *     · El backfill `INSERT INTO ... SELECT FROM audit_logs_old` corre 1 vez en
 *       el deploy. Aceptable: no es path crítico de runtime. Si más adelante
 *       hay millones de filas y backfill tarda >5min, considerar COPY o batches.
 *     · NO creamos partición default. Si llega un INSERT con created_at fuera
 *       del rango cubierto, falla con error claro. Decisión intencional —
 *       mejor fail loud que silenciar data en limbo. El cron pre-crea la
 *       partición del próximo mes con anticipación.
 *     · La PK pasa de `(id)` a `(id, created_at)` — requirement de Postgres
 *       para tablas particionadas (la column de partición DEBE estar en el
 *       PK). Como solo `audit.js` INSERTea sin leer id de vuelta, no hay
 *       impacto en el código de aplicación.
 *     · Particionado solo por created_at: no soportamos drill-down por
 *       tenant_id porque no hay tenant_id todavía (P-17 SaaS arch). Cuando
 *       llegue, sub-particionado por hash(tenant_id) es la extensión natural.
 *
 * Scope strictly P-19 (no P-07 async):
 *   NO tocamos el path de escritura de `audit()`. Sigue siendo síncrono e in-tx.
 *   Solo cambia el storage layout. Las funciones helper (ensure_audit_partition,
 *   drop_old_audit_partitions) quedan disponibles para el cron de mantenimiento
 *   (backend/src/jobs/auditPartitionsJob.js).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- ────────────────────────────────────────────────────────────────────────
    -- 1. Renombrar tabla actual + índices, para preservar datos durante la
    --    transición sin colisión de nombres cuando creemos la nueva.
    -- ────────────────────────────────────────────────────────────────────────
    ALTER TABLE audit_logs RENAME TO audit_logs_old;

    ALTER INDEX idx_audit_tabla          RENAME TO idx_audit_tabla_old;
    ALTER INDEX idx_audit_created        RENAME TO idx_audit_created_old;
    ALTER INDEX idx_audit_user           RENAME TO idx_audit_user_old;
    ALTER INDEX idx_audit_logs_ip        RENAME TO idx_audit_logs_ip_old;
    ALTER INDEX idx_audit_logs_request_id RENAME TO idx_audit_logs_request_id_old;
    -- La PK también tiene un nombre auto-generado (típicamente audit_logs_pkey,
    -- pero en re-deploys post-rollback puede ser audit_logs_pkey1, etc.).
    -- Lo descubrimos dinámicamente y lo renombramos para evitar colisión con
    -- el PK de la nueva tabla particionada.
    DO $do$
    DECLARE
      pk_name text;
    BEGIN
      SELECT conname INTO pk_name
        FROM pg_constraint
       WHERE conrelid = 'audit_logs_old'::regclass
         AND contype = 'p';
      IF pk_name IS NOT NULL AND pk_name <> 'audit_logs_old_pkey' THEN
        EXECUTE format('ALTER TABLE audit_logs_old RENAME CONSTRAINT %I TO audit_logs_old_pkey', pk_name);
      END IF;
    END
    $do$;
    -- La secuencia se llama audit_logs_id_seq (Postgres no la renombra con
    -- RENAME TABLE en versiones viejas; sí lo hace en PG12+, pero por las dudas
    -- la dejamos quieta — sigue funcionando vinculada a la columna id de la
    -- tabla renombrada). Más abajo la reasignamos a la tabla nueva.
  `);

  pgm.sql(`
    -- ────────────────────────────────────────────────────────────────────────
    -- 2. Tabla nueva, particionada por RANGE (created_at).
    --    Schema idéntico a audit_logs_old, con PK extendida (id, created_at)
    --    — requerimiento de Postgres: toda PK/UNIQUE en una particionada debe
    --    incluir la column de partición.
    --
    --    La secuencia ya existe de la tabla vieja — la descubrimos
    --    dinámicamente con pg_get_serial_sequence (resuelve el caso post-
    --    rollback donde la sec puede llamarse audit_logs_id_seq1 etc.).
    -- ────────────────────────────────────────────────────────────────────────
    DO $do$
    DECLARE
      seq_name text;
    BEGIN
      seq_name := pg_get_serial_sequence('audit_logs_old', 'id');
      IF seq_name IS NULL THEN
        RAISE EXCEPTION 'No se encontró la secuencia asociada a audit_logs_old.id';
      END IF;
      EXECUTE format($q$
        CREATE TABLE audit_logs (
          id            INTEGER NOT NULL DEFAULT nextval(%L),
          tabla         TEXT NOT NULL,
          accion        TEXT NOT NULL CHECK (accion IN ('INSERT','UPDATE','DELETE')),
          registro_id   INTEGER,
          datos_antes   JSONB,
          datos_despues JSONB,
          user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ip            INET,
          user_agent    TEXT,
          request_id    UUID,
          PRIMARY KEY (id, created_at)
        ) PARTITION BY RANGE (created_at)
      $q$, seq_name);
      EXECUTE format('ALTER SEQUENCE %s OWNED BY audit_logs.id', seq_name);
    END
    $do$;
  `);

  pgm.sql(`
    -- ────────────────────────────────────────────────────────────────────────
    -- 3. Recrear índices a nivel "padre" (se replican automáticamente en cada
    --    partición existente + en las futuras). Misma semántica que los
    --    originales — preservamos el comportamiento de las queries actuales.
    -- ────────────────────────────────────────────────────────────────────────
    CREATE INDEX idx_audit_tabla   ON audit_logs (tabla, registro_id);
    CREATE INDEX idx_audit_created ON audit_logs (created_at DESC);
    CREATE INDEX idx_audit_user    ON audit_logs (user_id);
    CREATE INDEX idx_audit_logs_ip          ON audit_logs (ip)         WHERE ip         IS NOT NULL;
    CREATE INDEX idx_audit_logs_request_id  ON audit_logs (request_id) WHERE request_id IS NOT NULL;
  `);

  pgm.sql(`
    -- ────────────────────────────────────────────────────────────────────────
    -- 4. Helper idempotente: ensure_audit_partition(month_start)
    --    Crea la partition del mes que cubre month_start si no existe.
    --    Nombre: audit_logs_YYYY_MM. Usado por la migración (init) y por el
    --    cron nocturno (pre-crear próximo mes).
    -- ────────────────────────────────────────────────────────────────────────
    CREATE OR REPLACE FUNCTION ensure_audit_partition(month_start date)
    RETURNS void AS $fn$
    DECLARE
      start_date     date;
      end_date       date;
      partition_name text;
    BEGIN
      start_date := date_trunc('month', month_start)::date;
      end_date   := (start_date + INTERVAL '1 month')::date;
      partition_name := 'audit_logs_' || to_char(start_date, 'YYYY_MM');
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs ' ||
        'FOR VALUES FROM (%L) TO (%L)',
        partition_name, start_date, end_date
      );
    END;
    $fn$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    -- ────────────────────────────────────────────────────────────────────────
    -- 5. Crear partitions iniciales: últimos 12 meses + próximos 3.
    --    Rango = 16 meses, cubre con margen tanto el histórico actual como
    --    los INSERTs hasta el próximo run del cron.
    -- ────────────────────────────────────────────────────────────────────────
    DO $do$
    DECLARE
      i int;
      m date;
    BEGIN
      FOR i IN -12..3 LOOP
        m := date_trunc('month', NOW() + (i || ' month')::interval)::date;
        PERFORM ensure_audit_partition(m);
      END LOOP;
    END
    $do$;
  `);

  pgm.sql(`
    -- ────────────────────────────────────────────────────────────────────────
    -- 6. Defensa adicional: si por algún motivo en audit_logs_old hay filas
    --    con created_at fuera del rango (-12 meses..+3 meses) — por ejemplo,
    --    backfills históricos manuales o data importada — creamos las
    --    partitions extra ANTES del backfill para que el INSERT no rompa.
    -- ────────────────────────────────────────────────────────────────────────
    DO $do$
    DECLARE
      r record;
    BEGIN
      FOR r IN
        SELECT DISTINCT date_trunc('month', created_at)::date AS m
        FROM audit_logs_old
      LOOP
        PERFORM ensure_audit_partition(r.m);
      END LOOP;
    END
    $do$;
  `);

  pgm.sql(`
    -- ────────────────────────────────────────────────────────────────────────
    -- 7. Backfill: copiar todos los datos viejos a la tabla particionada.
    --    Postgres rutea automáticamente cada row a la partición que cubre su
    --    created_at. Listamos columnas explícitas para evitar bugs si en el
    --    futuro el orden cambia.
    -- ────────────────────────────────────────────────────────────────────────
    INSERT INTO audit_logs
      (id, tabla, accion, registro_id, datos_antes, datos_despues, user_id, created_at, ip, user_agent, request_id)
    SELECT
      id, tabla, accion, registro_id, datos_antes, datos_despues, user_id, created_at, ip, user_agent, request_id
    FROM audit_logs_old;
  `);

  pgm.sql(`
    -- ────────────────────────────────────────────────────────────────────────
    -- 8. Resetear la secuencia al MAX(id) actual para que próximos INSERTs no
    --    choquen con los ids importados. Resolvemos la sec dinámicamente
    --    porque post-rollback puede llamarse audit_logs_id_seq1.
    -- ────────────────────────────────────────────────────────────────────────
    DO $do$
    DECLARE
      seq_name text;
      max_id   bigint;
    BEGIN
      seq_name := pg_get_serial_sequence('audit_logs', 'id');
      SELECT COALESCE(MAX(id), 1) INTO max_id FROM audit_logs;
      EXECUTE format('SELECT setval(%L, %s)', seq_name, max_id);
    END
    $do$;
  `);

  pgm.sql(`
    -- ────────────────────────────────────────────────────────────────────────
    -- 9. Helper de retención: drop_old_audit_partitions(retention_months)
    --    Dropea (cascade) toda partition cuyo mes es ESTRICTAMENTE menor que
    --    cutoff = trunc('month', NOW() - retention_months meses).
    --    Devuelve el número de partitions dropeadas (útil para logs/tests).
    -- ────────────────────────────────────────────────────────────────────────
    CREATE OR REPLACE FUNCTION drop_old_audit_partitions(retention_months int DEFAULT 12)
    RETURNS int AS $fn$
    DECLARE
      rec              record;
      dropped          int := 0;
      cutoff           date;
      partition_month  date;
      year_part        int;
      month_part       int;
    BEGIN
      cutoff := date_trunc('month', NOW() - (retention_months || ' month')::interval)::date;

      FOR rec IN
        SELECT child.relname AS partition_name
        FROM pg_inherits
        JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
        JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
        WHERE parent.relname = 'audit_logs'
          AND child.relname ~ '^audit_logs_[0-9]{4}_[0-9]{2}$'
      LOOP
        -- Parse YYYY_MM del nombre 'audit_logs_YYYY_MM' (prefijo = 11 chars,
        -- 1-based: posición 12 arranca el año).
        year_part  := substring(rec.partition_name from 12 for 4)::int;
        month_part := substring(rec.partition_name from 17 for 2)::int;
        partition_month := make_date(year_part, month_part, 1);

        IF partition_month < cutoff THEN
          EXECUTE format('DROP TABLE IF EXISTS %I', rec.partition_name);
          dropped := dropped + 1;
        END IF;
      END LOOP;

      RETURN dropped;
    END;
    $fn$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    -- ────────────────────────────────────────────────────────────────────────
    -- 10. Dropear la tabla vieja — el backfill ya está completo y los ids
    --     están reset. CASCADE no debería ser necesario (no hay FKs hacia
    --     audit_logs_old), pero lo dejamos defensivo.
    -- ────────────────────────────────────────────────────────────────────────
    DROP TABLE audit_logs_old CASCADE;
  `);
};

exports.down = (pgm) => {
  // Rollback raro pero T-05 exige down() funcional en TODA migración.
  // El down rehidrata audit_logs plana, backfillea de la particionada,
  // y dropea las funciones helper.
  pgm.sql(`
    -- 1. Renombrar la tabla particionada (con todas sus partitions) para
    --    preservar los datos durante el rollback.
    ALTER TABLE audit_logs RENAME TO audit_logs_partitioned_dead;

    -- También renombrar los índices del padre + el PK constraint para que la
    -- nueva tabla plana pueda usar los nombres canónicos.
    ALTER INDEX idx_audit_tabla   RENAME TO idx_audit_tabla_dead;
    ALTER INDEX idx_audit_created RENAME TO idx_audit_created_dead;
    ALTER INDEX idx_audit_user    RENAME TO idx_audit_user_dead;
    ALTER INDEX idx_audit_logs_ip         RENAME TO idx_audit_logs_ip_dead;
    ALTER INDEX idx_audit_logs_request_id RENAME TO idx_audit_logs_request_id_dead;
  `);

  pgm.sql(`
    -- 2. Crear nueva audit_logs PLANA con schema original (post-migraciones previas).
    CREATE TABLE audit_logs (
      id            SERIAL PRIMARY KEY,
      tabla         TEXT NOT NULL,
      accion        TEXT NOT NULL CHECK (accion IN ('INSERT','UPDATE','DELETE')),
      registro_id   INTEGER,
      datos_antes   JSONB,
      datos_despues JSONB,
      user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      ip            INET,
      user_agent    TEXT,
      request_id    UUID
    );

    CREATE INDEX idx_audit_tabla   ON audit_logs (tabla, registro_id);
    CREATE INDEX idx_audit_created ON audit_logs (created_at DESC);
    CREATE INDEX idx_audit_user    ON audit_logs (user_id);
    CREATE INDEX idx_audit_logs_ip         ON audit_logs (ip)         WHERE ip         IS NOT NULL;
    CREATE INDEX idx_audit_logs_request_id ON audit_logs (request_id) WHERE request_id IS NOT NULL;
  `);

  pgm.sql(`
    -- 3. Backfill desde la particionada renombrada.
    INSERT INTO audit_logs
      (id, tabla, accion, registro_id, datos_antes, datos_despues, user_id, created_at, ip, user_agent, request_id)
    SELECT
      id, tabla, accion, registro_id, datos_antes, datos_despues, user_id, created_at, ip, user_agent, request_id
    FROM audit_logs_partitioned_dead;

    -- Reset secuencia con MAX(id).
    SELECT setval('audit_logs_id_seq', COALESCE((SELECT MAX(id) FROM audit_logs), 1));
  `);

  pgm.sql(`
    -- 4. Drop de la particionada dead (CASCADE dropea las partitions hijas).
    DROP TABLE audit_logs_partitioned_dead CASCADE;

    -- 5. Drop de las funciones helper — no las necesitamos sin particionado.
    DROP FUNCTION IF EXISTS ensure_audit_partition(date);
    DROP FUNCTION IF EXISTS drop_old_audit_partitions(int);
  `);
};
