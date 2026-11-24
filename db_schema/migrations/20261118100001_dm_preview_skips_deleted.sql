-- A deleted direct message leaves the conversation list's preview, as in Discord and Slack: the
-- newest message still shown takes its place.
--
-- get_user_conversations: last_message is the newest row neither deleted nor a thread reply. The
-- predicate is the one of idx_messages_conversation_created, which the lookup can now use. Measured
-- on 302k rows with the caller's two conversations idle a year: 101 ms walking idx_messages_created
-- before, 3.4 ms on the partial index after. A thread belongs to a channel (threads.channel_id NOT
-- NULL): no conversation row has a thread_id. Body otherwise as
-- 20261005700001_compute_unread_on_read.sql.
--
-- broadcast_dm_message_deleted, AFTER UPDATE OF is_deleted on messages: a conversation row turning
-- deleted sends conversation:message_deleted {conversation_id, message_id} on user:<id> of each
-- active local participant. dm-conversation-<id> reaches only the conversation open on a device;
-- this event reaches the list and the message cache of every other one. Ids only, no content.
-- Quiet during a history import, as broadcast_message_event.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.get_user_conversations()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
WITH me AS (
    SELECT public.get_current_profile_id() AS id
),
parts AS (
    SELECT
        cp.conversation_id,
        cp.role,
        cp.joined_at,
        cp.hidden_at,
        c.created_at,
        c.updated_at,
        c.type,
        c.name,
        c.created_by,
        c.is_active,
        c.metadata
    FROM public.conversation_participants cp
    JOIN public.conversations c ON c.id = cp.conversation_id
    WHERE cp.user_id = (SELECT id FROM me)
      AND cp.left_at IS NULL
)
SELECT COALESCE(
    jsonb_agg(
        jsonb_build_object(
            'conversation_id', p.conversation_id,
            'created_at', p.created_at,
            'updated_at', p.updated_at,
            'type', COALESCE(p.type, 'direct'),
            'name', p.name,
            'created_by', p.created_by,
            'is_active', p.is_active,
            'metadata', p.metadata,
            'hidden_at', p.hidden_at,
            'user_role', p.role,
            'user_joined_at', p.joined_at,
            'other_participants', COALESCE(op.others, '[]'::jsonb),
            'last_message', CASE WHEN lm.id IS NULL THEN NULL ELSE
                jsonb_build_object(
                    'id', lm.id,
                    'user_id', lm.user_id,
                    'content', lm.content,
                    'encrypted', COALESCE(lm.encrypted, false),
                    'created_at', lm.created_at,
                    'metadata', lm.metadata
                ) END,
            'unread_messages', GREATEST(
                COALESCE(uc.muted_at_seq, hd.message_seq, 0) - COALESCE(uc.read_seq, 0) - COALESCE(uc.skipped, 0), 0),
            'unread_mentions', COALESCE(uc.unread_mentions, 0),
            'is_muted', COALESCE(nc.muted, false)
        )
        ORDER BY COALESCE(lm.created_at, p.updated_at, p.created_at) DESC
    ),
    '[]'::jsonb
)
FROM parts p
LEFT JOIN LATERAL (
    SELECT m.id, m.user_id, m.content, m.encrypted, m.created_at, m.metadata
    FROM public.messages m
    WHERE m.conversation_id = p.conversation_id
      AND m.thread_id IS NULL
      AND (m.is_deleted IS NULL OR m.is_deleted = false)
    ORDER BY m.created_at DESC
    LIMIT 1
) lm ON true
LEFT JOIN LATERAL (
    SELECT jsonb_agg(
        jsonb_build_object(
            'user_id', cp2.user_id,
            'role', cp2.role,
            'joined_at', cp2.joined_at,
            'profile', jsonb_build_object(
                'id', pr.id,
                'username', pr.username,
                'display_name', pr.display_name,
                'avatar_url', pr.avatar_url,
                'domain', pr.domain,
                'is_local', pr.is_local,
                'federated_id', pr.federated_id
            )
        )
        ORDER BY cp2.joined_at ASC
    ) AS others
    FROM public.conversation_participants cp2
    JOIN public.profiles pr ON pr.id = cp2.user_id
    WHERE cp2.conversation_id = p.conversation_id
      AND cp2.user_id <> (SELECT id FROM me)
      AND cp2.left_at IS NULL
) op ON true
LEFT JOIN LATERAL (
    SELECT u.read_seq, u.skipped, u.muted_at_seq, u.unread_mentions
    FROM public.unread_counts u
    WHERE u.conversation_id = p.conversation_id
      AND u.user_id = (SELECT id FROM me)
    LIMIT 1
) uc ON true
LEFT JOIN public.message_heads hd ON hd.conversation_id = p.conversation_id
LEFT JOIN LATERAL (
    SELECT n.muted
    FROM public.notification_channels n
    WHERE n.conversation_id = p.conversation_id
      AND n.user_id = (SELECT id FROM me)
      AND n.channel_id IS NULL
    LIMIT 1
) nc ON true
$$;

CREATE OR REPLACE FUNCTION public.broadcast_dm_message_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.is_history_import() THEN
        RETURN NEW;
    END IF;
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'conversation:message_deleted',
            'conversation_id', NEW.conversation_id,
            'message_id', NEW.id),
        'user_event', 'user:' || cp.user_id::text, true)
      FROM public.conversation_participants cp
      JOIN public.profiles pr ON pr.id = cp.user_id
     WHERE cp.conversation_id = NEW.conversation_id
       AND cp.left_at IS NULL
       AND pr.is_local IS NOT FALSE;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Delivery is best-effort; the delete must not fail because realtime is unavailable.
    RAISE WARNING 'broadcast_dm_message_deleted failed: %', SQLERRM;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.broadcast_dm_message_deleted() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.broadcast_dm_message_deleted() TO service_role;

-- CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE; DROP TRIGGER would take ACCESS EXCLUSIVE
-- and stop reads too.
CREATE OR REPLACE TRIGGER trigger_broadcast_dm_message_deleted
    AFTER UPDATE OF is_deleted ON public.messages
    FOR EACH ROW
    WHEN (NEW.conversation_id IS NOT NULL
          AND NEW.is_deleted IS TRUE
          AND OLD.is_deleted IS NOT TRUE)
    EXECUTE FUNCTION public.broadcast_dm_message_deleted();

COMMIT;
