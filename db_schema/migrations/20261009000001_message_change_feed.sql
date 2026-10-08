-- Channel message edits and soft deletes as a feed ordered by (updated_at, id).
--
-- messages.updated_at moves only when content changes or the row is soft-deleted:
--   INSERT                                updated_at = created_at
--   content IS DISTINCT FROM old content  updated_at = now()
--   is_deleted false/NULL -> true         updated_at = now()
--   harmony.silent_content_update = true  updated_at unchanged (bridge attachment refresh)
--   any other UPDATE                      updated_at as the statement leaves it; for a client
--                                         guard_message_client_write restores the old value
-- updated_at > created_at therefore marks an edited or soft-deleted row. Metadata merges,
-- pins, federation_status and thread moves leave it in place. A federated Delete sets
-- is_deleted alone; the soft-delete clause moves updated_at for it.
--
-- channel_message_changes(after_at, after_id, limit) pages that feed for bot-gateway's
-- MESSAGE_UPDATE / MESSAGE_DELETE dispatch. Each element of 'messages' is to_jsonb of the row,
-- the shape a PostgREST select('*') returns. 'now' is the database clock: the gateway's
-- starting position, so a restart replays nothing. A NULL position returns no rows.
--
-- Converges by state: the function bodies, the trigger and the index are asserted, not
-- replayed. Prod and staging carry the same trigger and a handle_messages_updated_at
-- differing from the baseline only in its pinned search_path, which is kept.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.handle_messages_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.updated_at := COALESCE(NEW.created_at, NOW());
        RETURN NEW;
    END IF;

    -- Bridge attachment URL refresh: patch content without "(edited)" badge.
    IF current_setting('harmony.silent_content_update', true) = 'true' THEN
        NEW.updated_at := OLD.updated_at;
        RETURN NEW;
    END IF;

    IF OLD.content IS DISTINCT FROM NEW.content
       OR (NEW.is_deleted IS TRUE AND OLD.is_deleted IS NOT TRUE) THEN
        NEW.updated_at := NOW();
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_messages_updated_at() IS
    'updated_at moves on a content change or a soft delete only; updated_at > created_at marks an edited or deleted message.';

DROP TRIGGER IF EXISTS handle_updated_at ON public.messages;
CREATE TRIGGER handle_updated_at
    BEFORE INSERT OR UPDATE ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_messages_updated_at();

-- Holds edited and soft-deleted channel messages only; the feed's predicate repeats this one.
CREATE INDEX IF NOT EXISTS idx_messages_channel_changes
    ON public.messages (updated_at, id)
    WHERE channel_id IS NOT NULL AND updated_at > created_at;

CREATE OR REPLACE FUNCTION public.channel_message_changes(
    p_after_at timestamptz,
    p_after_id uuid,
    p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'now', now(),
        'messages', COALESCE((
            SELECT jsonb_agg(to_jsonb(m) ORDER BY m.updated_at, m.id)
              FROM (SELECT *
                      FROM public.messages
                     WHERE channel_id IS NOT NULL
                       AND updated_at > created_at
                       AND (updated_at, id) > (p_after_at, p_after_id)
                     ORDER BY updated_at, id
                     LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000)) m
        ), '[]'::jsonb)
    );
$$;

REVOKE ALL ON FUNCTION public.channel_message_changes(timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.channel_message_changes(timestamptz, uuid, integer) TO service_role;

COMMIT;
