-- An imported thread gets a last message time.
--
-- 20261110900004 made a reply under the history-import flag leave threads.last_message_at alone, so
-- backdated rows never move a thread's activity. A thread the import creates starts with no last
-- message time, though, and keeps none: auto_archive_threads() compares last_message_at with
-- auto_archive_duration and skips NULL, and the client's expiry check does the same, so such a
-- thread stayed active (listed under its channel for everyone) forever.
--
-- thread_message_handler: under the flag a reply now fills last_message_at when it is NULL. A thread
-- that has a last message time keeps it, as before; last_message_id, updated_at and archived stay.
-- The importer reads each thread newest-first, so the first reply it inserts is from its newest page.
--
-- Backfill: a thread with messages but no last_message_at takes its newest non-deleted message's
-- time, under the flag so it is not broadcast or federated. Converges by state: rerunning changes
-- nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- A reply under the flag is counted (message_count, member_count, thread_members) and gives a thread
-- without one its last message time; it moves nothing else: not a set last message time, the last
-- message, updated_at, nor the archived state of an imported thread.
CREATE OR REPLACE FUNCTION public.thread_message_handler()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NEW.thread_id IS NOT NULL THEN
        -- A bot author has no profile to enrol.
        IF NEW.user_id IS NOT NULL THEN
            INSERT INTO public.thread_members (thread_id, user_id)
            VALUES (NEW.thread_id, NEW.user_id)
            ON CONFLICT (thread_id, user_id) DO NOTHING;
        END IF;
        IF public.is_history_import() THEN
            UPDATE public.threads
            SET message_count = message_count + 1,
                last_message_at = COALESCE(last_message_at, NEW.created_at)
            WHERE id = NEW.thread_id;
        ELSE
            UPDATE public.threads
            SET
                message_count = message_count + 1,
                last_message_id = NEW.id,
                last_message_at = NEW.created_at,
                updated_at = NOW(),
                archived = CASE WHEN locked THEN archived ELSE false END,
                archived_at = CASE WHEN locked THEN archived_at ELSE NULL END
            WHERE id = NEW.thread_id;
        END IF;
        UPDATE public.threads t
        SET member_count = (
            SELECT COUNT(*) FROM public.thread_members tm WHERE tm.thread_id = t.id
        )
        WHERE t.id = NEW.thread_id;
    END IF;
    RETURN NEW;
END;
$function$;

-- Under the flag, as an import: the thread triggers neither broadcast nor federate the backfill.
SELECT set_config('harmony.history_import', 'true', true);

UPDATE public.threads t
   SET last_message_at = m.newest
  FROM (SELECT thread_id, max(created_at) AS newest
          FROM public.messages
         WHERE thread_id IS NOT NULL AND is_deleted IS NOT TRUE
         GROUP BY thread_id) m
 WHERE t.id = m.thread_id
   AND t.last_message_at IS NULL;

COMMIT;
