-- Add native emoji support to message reactions
-- This allows users to react with standard Unicode emojis (like 👍❤️😂)
-- without requiring them to be registered in the emojis table
-- 
-- Follows the same pattern as post_interactions table:
-- - emoji_id: UUID reference to emojis table (for custom server emojis)
-- - custom_emoji_content: text content (native unicode OR emoji shortcode for display)

-- 1. Add custom_emoji_content column for native Unicode emojis
-- (Similar to post_interactions.custom_emoji_content)
ALTER TABLE public.reactions 
ADD COLUMN IF NOT EXISTS custom_emoji_content text;

-- 2. Make emoji_id nullable so we can store native emojis without a reference
ALTER TABLE public.reactions 
ALTER COLUMN emoji_id DROP NOT NULL;

-- 3. Add constraint: must have either emoji_id OR custom_emoji_content (or both for caching)
-- This is more flexible - allows:
--   - Custom emoji: emoji_id set, custom_emoji_content optional (can store shortcode)
--   - Native emoji: emoji_id NULL, custom_emoji_content has the unicode char
ALTER TABLE public.reactions
DROP CONSTRAINT IF EXISTS reactions_emoji_check;

ALTER TABLE public.reactions
ADD CONSTRAINT reactions_emoji_check 
CHECK (
  emoji_id IS NOT NULL OR custom_emoji_content IS NOT NULL
);

-- 4. Add index for custom_emoji_content lookups (for native emoji reactions)
CREATE INDEX IF NOT EXISTS idx_reactions_custom_emoji 
ON public.reactions (message_id, custom_emoji_content) 
WHERE custom_emoji_content IS NOT NULL AND emoji_id IS NULL;

-- 5. Update get_message_reactions function to support both types
-- Must drop first because return type might change
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

-- 6. Update get_batch_message_reactions to support native emojis
-- Must drop first because return columns changed
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
            jsonb_build_object('user_id', r.user_id)
        ) as users
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = ANY(get_batch_message_reactions.message_ids)
    GROUP BY r.message_id, r.emoji_id, e.name, e.url, r.custom_emoji_content
    ORDER BY r.message_id, reaction_count DESC;
END;
$$;

-- Comments
COMMENT ON COLUMN public.reactions.custom_emoji_content IS 
'For native emojis: stores the unicode character (e.g., 👍, ❤️). For custom emojis: optionally stores the shortcode for caching. Native emojis have emoji_id=NULL.';

COMMENT ON FUNCTION public.get_message_reactions(uuid) IS 
'Returns reaction groups for a message. Supports both custom emojis (emoji_id references emojis table) and native Unicode emojis (custom_emoji_content with emoji_id=NULL).';

COMMENT ON FUNCTION public.get_batch_message_reactions(uuid[]) IS 
'Batch fetch reactions for multiple messages. Returns custom_emoji_content for native emoji support.';

-- 7. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

