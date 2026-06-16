-- ---------------------------------------------------------------------------
-- Add `current_user_reacted` to the message reaction RPCs so the client can
-- use the SAME server-computed-boolean model as post reactions, instead of
-- comparing user ids client-side.
--
-- Why:
-- The chat reaction "did I react?" highlight was derived by comparing the
-- caller's id against the per-reaction user_id array on the client. That model
-- is fragile (auth-id vs profile-id confusion caused the highlight to flicker
-- off) and forces the client to download user arrays just to answer a boolean.
-- Post reactions already solved this by returning `current_user_reacted` from
-- the RPC (`get_post_emoji_reactions`). This brings message reactions in line.
--
-- `bool_or(r.user_id = get_current_profile_id())` is computed within the
-- existing GROUP BY, so it adds no extra round-trips.
-- ---------------------------------------------------------------------------

BEGIN;

-- Return shape changes (new column), so the functions must be dropped first.
DROP FUNCTION IF EXISTS public.get_batch_message_reactions(uuid[]);
DROP FUNCTION IF EXISTS public.get_message_reactions(uuid);

CREATE FUNCTION public.get_batch_message_reactions(message_ids uuid[])
RETURNS TABLE(
    message_id uuid,
    emoji_id uuid,
    emoji_name character varying,
    emoji_url character varying,
    custom_emoji_content text,
    reaction_count bigint,
    current_user_reacted boolean,
    users jsonb
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r.message_id,
        r.emoji_id,
        COALESCE(e.name, r.custom_emoji_content)::varchar as emoji_name,
        e.url::varchar as emoji_url,
        r.custom_emoji_content,
        COUNT(r.id)::bigint as reaction_count,
        bool_or(r.user_id = public.get_current_profile_id()) as current_user_reacted,
        jsonb_agg(
            jsonb_build_object(
                'user_id', r.user_id,
                'bot_id', r.bot_id,
                'metadata', r.metadata
            )
        ) as users
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = ANY(get_batch_message_reactions.message_ids)
    GROUP BY r.message_id, r.emoji_id, e.name, e.url, r.custom_emoji_content
    ORDER BY r.message_id, MIN(r.created_at) ASC;
END;
$$;

COMMENT ON FUNCTION public.get_batch_message_reactions(message_ids uuid[]) IS 'Batch fetch reactions for multiple messages including current_user_reacted + metadata for bridged users';

CREATE FUNCTION public.get_message_reactions(message_id uuid) 
RETURNS TABLE(count bigint, emoji jsonb, reactions jsonb, current_user_reacted boolean, message_id_of_reactions uuid)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(r.id)::bigint as count,
        CASE 
            WHEN r.emoji_id IS NOT NULL THEN
                jsonb_build_object(
                    'id', e.id,
                    'name', e.name,
                    'url', e.url,
                    'is_native', false
                )
            ELSE
                jsonb_build_object(
                    'id', r.custom_emoji_content,
                    'name', r.custom_emoji_content,
                    'url', NULL,
                    'content', r.custom_emoji_content,
                    'is_native', true
                )
        END as emoji,
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', r2.user_id,
                    'bot_id', r2.bot_id,
                    'metadata', r2.metadata,
                    'username', p.username,
                    'display_name', p.display_name,
                    'avatar_url', p.avatar_url
                )
            )
            FROM reactions r2
            LEFT JOIN profiles p ON r2.user_id = p.id
            WHERE r2.message_id = get_message_reactions.message_id
            AND (
                (r2.emoji_id IS NOT DISTINCT FROM r.emoji_id)
                AND (r2.custom_emoji_content IS NOT DISTINCT FROM r.custom_emoji_content)
            )
        ) as reactions,
        bool_or(r.user_id = public.get_current_profile_id()) as current_user_reacted,
        r.message_id as message_id_of_reactions
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = get_message_reactions.message_id
    GROUP BY r.message_id, r.emoji_id, e.id, e.name, e.url, r.custom_emoji_content
    ORDER BY MIN(r.created_at) ASC;
END;
$$;

COMMENT ON FUNCTION public.get_message_reactions(message_id uuid) IS 'Returns reaction groups for a message including current_user_reacted + metadata for bridged users';

GRANT EXECUTE ON FUNCTION public.get_batch_message_reactions(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_message_reactions(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
