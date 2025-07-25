-- Fix the get_post_emoji_reactions function to handle character varying to text type mismatch
CREATE OR REPLACE FUNCTION public.get_post_emoji_reactions(p_post_id uuid)
RETURNS TABLE(emoji_id uuid, emoji_name text, emoji_url text, custom_emoji_content text, reaction_count bigint, user_reactions jsonb)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
    RETURN QUERY
    SELECT 
        pi.emoji_id,
        e.name::text as emoji_name,  -- Cast character varying to text
        e.url::text as emoji_url,    -- Cast character varying to text
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        jsonb_agg(
            jsonb_build_object(
                'user_id', pi.user_id,
                'created_at', pi.created_at
            )
        ) as user_reactions
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = p_post_id 
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY reaction_count DESC;
END;
$function$;

COMMENT ON FUNCTION public.get_post_emoji_reactions(p_post_id uuid) IS 'Get emoji reactions for a post, grouped by emoji with counts and user lists. Fixed character varying to text type casting.';
