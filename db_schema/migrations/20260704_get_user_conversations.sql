-- =============================================================================
-- get_user_conversations: single-round-trip DM sidebar load
-- =============================================================================
-- The DM list previously cost 4-6 sequential PostgREST round trips:
--   participations -> other participants -> last-messages (scanning up to
--   1000 message rows and deduplicating client-side, because supabase-js has
--   no DISTINCT ON) -> unread counts -> mute states -> profile hydration.
-- This function returns everything in ONE round trip; the per-conversation
-- last message uses a LATERAL LIMIT 1 against
-- idx_messages_conversation_created (conversation_id, created_at DESC).
--
-- The caller's profile id is resolved server-side via get_current_profile_id()
-- (no user-id parameter), which also removes the recurring auth-UUID vs
-- profiles.id confusion for this path.
--
-- Returns: jsonb array, newest activity first. Per element:
--   {
--     conversation_id, created_at, updated_at, type, name, created_by,
--     is_active, metadata, hidden_at, user_role, user_joined_at,
--     other_participants: [ { user_id, role, joined_at, profile: {
--         id, username, display_name, avatar_url, domain, is_local,
--         federated_id } } ],
--     last_message: { id, user_id, content, created_at, metadata } | null,
--     unread_messages, unread_mentions, is_muted
--   }
--
-- SECURITY: intentionally SECURITY INVOKER - RLS on every joined table
-- applies to the calling user exactly as it does for the direct queries this
-- replaces. No new data exposure.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_user_conversations()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
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
                    'created_at', lm.created_at,
                    'metadata', lm.metadata
                ) END,
            'unread_messages', COALESCE(uc.unread_messages, 0),
            'unread_mentions', COALESCE(uc.unread_mentions, 0),
            'is_muted', COALESCE(nc.muted, false)
        )
        ORDER BY COALESCE(lm.created_at, p.updated_at, p.created_at) DESC
    ),
    '[]'::jsonb
)
FROM parts p
LEFT JOIN LATERAL (
    SELECT m.id, m.user_id, m.content, m.created_at, m.metadata
    FROM public.messages m
    WHERE m.conversation_id = p.conversation_id
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
-- LATERAL LIMIT 1 instead of plain joins: neither table has a unique
-- constraint on (user_id, conversation_id), and a duplicate row would
-- otherwise duplicate the conversation in the sidebar.
LEFT JOIN LATERAL (
    SELECT u.unread_messages, u.unread_mentions
    FROM public.unread_counts u
    WHERE u.conversation_id = p.conversation_id
      AND u.user_id = (SELECT id FROM me)
    LIMIT 1
) uc ON true
LEFT JOIN LATERAL (
    SELECT n.muted
    FROM public.notification_channels n
    WHERE n.conversation_id = p.conversation_id
      AND n.user_id = (SELECT id FROM me)
      AND n.channel_id IS NULL
    LIMIT 1
) nc ON true
$$;

COMMENT ON FUNCTION public.get_user_conversations() IS
'Single round-trip DM sidebar load: conversations + other participants (with profiles) + last message + unread counts + mute state, newest activity first. Caller resolved via get_current_profile_id(). SECURITY INVOKER so RLS applies.';

GRANT EXECUTE ON FUNCTION public.get_user_conversations() TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
