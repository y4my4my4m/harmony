-- Soft-deletes duplicate bridged messages ahead of the unique index in 20261109100002.
--
-- A live relay and a retry could each insert the same Discord message into a channel. For every
-- (channel_id, metadata->>'discord_message_id') held by more than one live row, the oldest
-- (created_at, then id) stays and the others get is_deleted = true. The update runs under
-- harmony.silent_content_update, so no edit badge appears. A federated delete of a duplicate
-- bridged row is acceptable.

BEGIN;

SET LOCAL lock_timeout = '3s';

SELECT set_config('harmony.silent_content_update', 'true', true);

UPDATE public.messages m
   SET is_deleted = true
  FROM (
      SELECT id,
             row_number() OVER (
                 PARTITION BY channel_id, metadata->>'discord_message_id'
                 ORDER BY created_at, id
             ) AS rn
        FROM public.messages
       WHERE channel_id IS NOT NULL
         AND metadata ? 'discord_message_id'
         AND is_deleted IS NOT TRUE
  ) d
 WHERE m.id = d.id
   AND d.rn > 1;

SELECT set_config('harmony.silent_content_update', 'false', true);

COMMIT;

NOTIFY pgrst, 'reload schema';
