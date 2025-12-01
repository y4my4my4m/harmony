-- =====================================================
-- Add metadata to reaction responses
-- This allows displaying Discord user info for bridged reactions
-- =====================================================

-- Update get_message_reactions to include metadata in reactions array
DROP FUNCTION IF EXISTS public.get_message_reactions(uuid);

CREATE FUNCTION public.get_message_reactions(message_id uuid)
RETURNS TABLE(
  count bigint, 
  emoji jsonb, 
  reactions jsonb, 
  message_id_of_reactions uuid
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(r.id)::bigint as count,
        CASE 
            WHEN r.emoji_id IS NOT NULL THEN
                -- Custom server emoji - use emoji table data
                jsonb_build_object(
                    'id', e.id,
                    'name', e.name,
                    'url', e.url,
                    'is_native', false
                )
            ELSE
                -- Native unicode emoji - use custom_emoji_content
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
                    'created_at', r2.created_at
                )
            )
            FROM reactions r2
            WHERE r2.message_id = get_message_reactions.message_id
            AND (
                (r.emoji_id IS NOT NULL AND r2.emoji_id = r.emoji_id) OR
                (r.emoji_id IS NULL AND r.custom_emoji_content IS NOT NULL 
                 AND r2.custom_emoji_content = r.custom_emoji_content AND r2.emoji_id IS NULL)
            )
        ) as reactions,
        get_message_reactions.message_id as message_id_of_reactions
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = get_message_reactions.message_id
    GROUP BY r.emoji_id, r.custom_emoji_content, e.id, e.name, e.url;
END;
$$;

-- Update batch function too
DROP FUNCTION IF EXISTS public.get_batch_message_reactions(uuid[]);

CREATE FUNCTION public.get_batch_message_reactions(message_ids uuid[])
RETURNS TABLE(
  message_id uuid, 
  emoji_id uuid, 
  emoji_name varchar, 
  emoji_url varchar, 
  custom_emoji_content text,
  reaction_count bigint, 
  users jsonb
)
LANGUAGE plpgsql STABLE
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
    ORDER BY r.message_id, reaction_count DESC;
END;
$$;

-- Comments
COMMENT ON FUNCTION public.get_message_reactions(uuid) IS 
'Returns reaction groups for a message including metadata for bridged users (Discord, etc.)';

COMMENT ON FUNCTION public.get_batch_message_reactions(uuid[]) IS 
'Batch fetch reactions for multiple messages including metadata for bridged users';

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';


