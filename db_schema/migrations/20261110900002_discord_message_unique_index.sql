-- harmony:no-transaction
--
-- One live row per Discord message per channel: a live relay and the history import (and a
-- retried request) may race to insert the same Discord message, and the loser must fail with
-- unique_violation instead of leaving a duplicate. Writers insert with
-- ON CONFLICT (channel_id, (metadata->>'discord_message_id')) WHERE <this predicate> DO NOTHING.
-- 20261110900001 soft-deleted the duplicates that existed.
--
-- No transaction block: CREATE INDEX CONCURRENTLY refuses to run inside one, and the build
-- takes no lock that blocks writes. An interrupted or timed-out build leaves an invalid index;
-- it is dropped before the next build, and the file fails while the index is not valid.
--
-- The soft delete of 20261110900001 runs again here, before the build: a duplicate relayed after
-- that file was recorded would fail every build, and the ledger never runs that file twice.

SET lock_timeout = '5s';

DO $$
BEGIN
    IF EXISTS (SELECT 1
                 FROM pg_index x
                 JOIN pg_class c ON c.oid = x.indexrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relname = 'messages_channel_discord_message_id_unique'
                  AND NOT x.indisvalid) THEN
        DROP INDEX public.messages_channel_discord_message_id_unique;
    END IF;
END
$$;

BEGIN;
SELECT set_config('harmony.silent_content_update', 'true', true);
UPDATE public.messages m
   SET is_deleted = true,
       metadata = m.metadata || '{"bridge_duplicate": true}'::jsonb
  FROM (
      SELECT id,
             row_number() OVER (
                 PARTITION BY channel_id, metadata->>'discord_message_id'
                 ORDER BY created_at, id
             ) AS rn
        FROM public.messages
       WHERE channel_id IS NOT NULL
         AND metadata ? 'discord_message_id'
         AND metadata->>'discord_message_id' IS NOT NULL
         AND is_deleted IS NOT TRUE
  ) d
 WHERE m.id = d.id
   AND d.rn > 1;
COMMIT;

-- A concurrent build waits for transactions open before it; lock_timeout bounds each wait.
SET lock_timeout = '10min';

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS messages_channel_discord_message_id_unique
    ON public.messages (channel_id, (metadata->>'discord_message_id'))
    WHERE channel_id IS NOT NULL AND metadata ? 'discord_message_id' AND is_deleted IS NOT TRUE;

RESET lock_timeout;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM pg_index x
                    WHERE x.indexrelid = to_regclass('public.messages_channel_discord_message_id_unique')
                      AND x.indisvalid) THEN
        RAISE EXCEPTION 'messages_channel_discord_message_id_unique is not valid; run 20261110900002 again';
    END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
