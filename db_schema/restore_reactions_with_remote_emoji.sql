-- Restore working version with ONLY remote emoji URL support added
DROP FUNCTION IF EXISTS public.get_post_emoji_reactions(uuid);
DROP FUNCTION IF EXISTS public.get_post_emoji_reactions(uuid, integer);

CREATE OR REPLACE FUNCTION public.get_post_emoji_reactions(p_post_id uuid, p_user_limit integer DEFAULT 5)
RETURNS TABLE(emoji_id uuid, emoji_name text, emoji_url text, custom_emoji_content text, reaction_count bigint, user_reactions jsonb, current_user_reacted boolean)
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
    current_user_id uuid;
BEGIN
    -- Get current user ID from session (if authenticated)
    current_user_id := auth.uid();
    
    RETURN QUERY
    SELECT 
        pi.emoji_id,
        e.name::text as emoji_name,
        -- ONLY CHANGE: Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Only include limited user data for tooltips
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', sub_pi.user_id,
                    'username', sub_p.username,
                    'display_name', sub_p.display_name,
                    'avatar_url', sub_p.avatar_url,
                    'created_at', sub_pi.created_at
                )
                ORDER BY sub_pi.created_at DESC
            )
            FROM post_interactions sub_pi
            LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
            WHERE sub_pi.post_id = p_post_id
              AND sub_pi.interaction_type = 'emoji_reaction'
              AND (
                  (pi.emoji_id IS NOT NULL AND sub_pi.emoji_id = pi.emoji_id) OR
                  (pi.custom_emoji_content IS NOT NULL AND sub_pi.custom_emoji_content = pi.custom_emoji_content)
              )
            LIMIT p_user_limit
        ) as user_reactions,
        -- Check if current user has reacted with this emoji
        CASE 
            WHEN current_user_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = p_post_id
                  AND check_pi.user_id = current_user_id
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND (
                      (pi.emoji_id IS NOT NULL AND check_pi.emoji_id = pi.emoji_id) OR
                      (pi.custom_emoji_content IS NOT NULL AND check_pi.custom_emoji_content = pi.custom_emoji_content)
                  )
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = p_post_id 
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY reaction_count DESC, MIN(pi.created_at) ASC;
END;
$function$;

-- Also update batch version
DROP FUNCTION IF EXISTS public.get_batch_post_emoji_reactions(uuid[]);
DROP FUNCTION IF EXISTS public.get_batch_post_emoji_reactions(uuid[], integer);

CREATE OR REPLACE FUNCTION public.get_batch_post_emoji_reactions(p_post_ids uuid[], p_user_limit integer DEFAULT 5)
RETURNS TABLE(post_id uuid, emoji_id uuid, emoji_name text, emoji_url text, custom_emoji_content text, reaction_count bigint, user_reactions jsonb, current_user_reacted boolean)
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
    current_user_id uuid;
BEGIN
    -- Get current user ID from session (if authenticated)
    current_user_id := auth.uid();
    
    RETURN QUERY
    SELECT 
        pi.post_id,
        pi.emoji_id,
        e.name::text as emoji_name,
        -- ONLY CHANGE: Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Limited user data for tooltips
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', sub_pi.user_id,
                    'username', sub_p.username,
                    'display_name', sub_p.display_name,
                    'avatar_url', sub_p.avatar_url,
                    'created_at', sub_pi.created_at
                )
                ORDER BY sub_pi.created_at DESC
            )
            FROM post_interactions sub_pi
            LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
            WHERE sub_pi.post_id = pi.post_id
              AND sub_pi.interaction_type = 'emoji_reaction'
              AND (
                  (pi.emoji_id IS NOT NULL AND sub_pi.emoji_id = pi.emoji_id) OR
                  (pi.custom_emoji_content IS NOT NULL AND sub_pi.custom_emoji_content = pi.custom_emoji_content)
              )
            LIMIT p_user_limit
        ) as user_reactions,
        -- Check if current user has reacted
        CASE 
            WHEN current_user_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = pi.post_id
                  AND check_pi.user_id = current_user_id
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND (
                      (pi.emoji_id IS NOT NULL AND check_pi.emoji_id = pi.emoji_id) OR
                      (pi.custom_emoji_content IS NOT NULL AND check_pi.custom_emoji_content = pi.custom_emoji_content)
                  )
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = ANY(p_post_ids)
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.post_id, pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY pi.post_id, reaction_count DESC, MIN(pi.created_at) ASC;
END;
$function$;

