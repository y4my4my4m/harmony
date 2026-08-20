-- =============================================================================
-- get_message_page: single-round-trip page load for channel chat and DMs
-- =============================================================================
-- Cold-opening a channel previously cost the client 3-4 sequential PostgREST
-- round trips (channels lookup -> servers lookup -> messages -> reactions RPC).
-- This function collapses the messages + reactions steps into ONE round trip.
--
-- Returns: jsonb object
--   {
--     "messages":  [ <messages rows, oldest-first> ],
--     "reactions": [ <rows in the exact shape of get_batch_message_reactions> ]
--   }
--
-- Exactly one of p_channel_id / p_conversation_id must be provided.
-- Channel pages exclude thread replies (thread_id IS NULL) to match the
-- client's main-feed query; conversation (DM) pages do not filter threads,
-- matching the existing loadConversationMessages behavior.
--
-- SECURITY: intentionally SECURITY INVOKER - RLS on messages/reactions applies
-- to the calling user exactly as it does for the direct table queries this
-- replaces. No new data exposure.
--
-- The channel branch keeps its predicates verbatim so the planner can use the
-- partial index idx_messages_channel_created_main
--   (channel_id, created_at DESC) WHERE thread_id IS NULL AND (is_deleted IS NULL OR is_deleted = false)

BEGIN;

CREATE OR REPLACE FUNCTION public.get_message_page(
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 20,
    p_before timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
    -- Hoisted once instead of per-row inside the aggregate (the old
    -- get_batch_message_reactions calls it inside bool_or, per row).
    v_profile_id uuid := public.get_current_profile_id();
    v_messages jsonb;
    v_ids uuid[];
    v_reactions jsonb := '[]'::jsonb;
BEGIN
    IF (p_channel_id IS NULL) = (p_conversation_id IS NULL) THEN
        RAISE EXCEPTION 'get_message_page: provide exactly one of p_channel_id / p_conversation_id';
    END IF;

    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        p_limit := 20;
    END IF;

    IF p_channel_id IS NOT NULL THEN
        WITH page AS (
            SELECT m.*
            FROM public.messages m
            WHERE m.channel_id = p_channel_id
              AND m.thread_id IS NULL
              AND (m.is_deleted IS NULL OR m.is_deleted = false)
              AND (p_before IS NULL OR m.created_at < p_before)
            ORDER BY m.created_at DESC
            LIMIT p_limit
        )
        SELECT
            COALESCE(jsonb_agg(to_jsonb(page.*) ORDER BY page.created_at ASC), '[]'::jsonb),
            array_agg(page.id)
        INTO v_messages, v_ids
        FROM page;
    ELSE
        WITH page AS (
            SELECT m.*
            FROM public.messages m
            WHERE m.conversation_id = p_conversation_id
              AND (m.is_deleted IS NULL OR m.is_deleted = false)
              AND (p_before IS NULL OR m.created_at < p_before)
            ORDER BY m.created_at DESC
            LIMIT p_limit
        )
        SELECT
            COALESCE(jsonb_agg(to_jsonb(page.*) ORDER BY page.created_at ASC), '[]'::jsonb),
            array_agg(page.id)
        INTO v_messages, v_ids
        FROM page;
    END IF;

    -- Same aggregation as get_batch_message_reactions so the client can reuse
    -- its existing row -> reaction-group mapping unchanged.
    IF v_ids IS NOT NULL AND array_length(v_ids, 1) > 0 THEN
        SELECT COALESCE(
            jsonb_agg(to_jsonb(gr.*) ORDER BY gr.message_id, gr.first_reaction_at ASC),
            '[]'::jsonb
        )
        INTO v_reactions
        FROM (
            SELECT
                r.message_id,
                r.emoji_id,
                COALESCE(e.name, r.custom_emoji_content)::varchar AS emoji_name,
                COALESCE(e.url::text, MAX(r.metadata->>'remote_emoji_url'))::varchar AS emoji_url,
                r.custom_emoji_content,
                COUNT(r.id)::bigint AS reaction_count,
                bool_or(r.user_id = v_profile_id) AS current_user_reacted,
                jsonb_agg(
                    jsonb_build_object(
                        'user_id', r.user_id,
                        'bot_id', r.bot_id,
                        'metadata', r.metadata
                    )
                ) AS users,
                MIN(r.created_at) AS first_reaction_at
            FROM public.reactions r
            LEFT JOIN public.emojis e ON r.emoji_id = e.id
            WHERE r.message_id = ANY(v_ids)
            GROUP BY r.message_id, r.emoji_id, e.name, e.url, r.custom_emoji_content
        ) gr;
    END IF;

    RETURN jsonb_build_object(
        'messages', v_messages,
        'reactions', v_reactions
    );
END;
$$;

COMMENT ON FUNCTION public.get_message_page(uuid, uuid, integer, timestamptz) IS
'Single round-trip page load for chat/DM: messages (oldest-first) + grouped reactions in one call. Exactly one of p_channel_id / p_conversation_id required. SECURITY INVOKER so messages/reactions RLS applies.';

GRANT EXECUTE ON FUNCTION public.get_message_page(uuid, uuid, integer, timestamptz) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
