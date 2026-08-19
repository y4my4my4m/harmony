-- Post emoji reaction chips: one match key, and a user limit that limits.
--
-- 1. The match key was OR-shaped where the GROUP BY is AND-shaped.
--
-- get_post_emoji_reactions and get_batch_post_emoji_reactions group on
-- (emoji_id, custom_emoji_content), but their member subquery and their current_user_reacted
-- EXISTS accepted a row when EITHER column matched. A local picker reaction stores
-- (uuid, ':name:'); the same shortcode arriving from a remote actor stores (NULL, ':name:').
-- The two groups are distinct rows in the output and each was handed the other's reactors,
-- and current_user_reacted was true on both chips for anyone holding either row.
--
-- Measured on a fresh init/ build, one post with seven (uuid, ':party:') reactions and two
-- (NULL, ':party:') reactions: both chips returned all nine reactors, and as the user who
-- held only the remote row both chips reported current_user_reacted = true.
--
-- remove_post_emoji_reaction repeated the OR in its DELETE, so removing one chip deleted the
-- caller's row in the other one too. Same build: one call removing the (uuid, ':party:')
-- chip deleted two rows and update_post_reaction_counts drove favorites_count from 9 to 7.
--
-- All three now compare both columns with IS NOT DISTINCT FROM, matching the message
-- reaction RPCs. In the DELETE, p_custom_emoji_content omitted alongside a p_emoji_id leaves
-- the content unconstrained - the emoji picker sends only the emoji id, and every row under
-- one emoji_id is the same emoji. p_emoji_id NULL is a value, not a wildcard: it selects the
-- shortcode-only group and never the local emoji's.
--
-- 2. p_user_limit was inert.
--
-- The LIMIT sat beside jsonb_agg, where it bounds the aggregate's single output row.
-- Callers ask for 5 (src/stores/postReactions.ts) and received every reactor's username,
-- display name, avatar and timestamp - for every chip of every post in a timeline batch.
-- Same build: the seven-reactor chip returned seven entries for p_user_limit = 5. The LIMIT
-- now sits in an inner subquery that jsonb_agg reads from.
--
-- Mirrors db_schema/init/13_functions_rpc_extended.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_batch_post_emoji_reactions(p_post_ids uuid[], p_user_limit integer DEFAULT 5) RETURNS TABLE(post_id uuid, emoji_id uuid, emoji_name text, emoji_url text, custom_emoji_content text, reaction_count bigint, user_reactions jsonb, current_user_reacted boolean)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
    current_profile_id uuid;
BEGIN
    -- post_interactions.user_id stores profile ids, not auth user ids.
    current_profile_id := public.get_current_profile_id();

    RETURN QUERY
    SELECT
        pi.post_id,
        pi.emoji_id,
        e.name::text as emoji_name,
        -- Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Limited user data for tooltips. p_user_limit is applied in the inner subquery:
        -- a LIMIT beside jsonb_agg bounds the aggregate's single output row and truncates
        -- nothing.
        (
            SELECT jsonb_agg(recent.entry ORDER BY recent.created_at DESC)
            FROM (
                SELECT jsonb_build_object(
                           'user_id', sub_pi.user_id,
                           'username', sub_p.username,
                           'display_name', sub_p.display_name,
                           'avatar_url', sub_p.avatar_url,
                           'created_at', sub_pi.created_at
                       ) AS entry,
                       sub_pi.created_at
                FROM post_interactions sub_pi
                LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
                WHERE sub_pi.post_id = pi.post_id
                  AND sub_pi.interaction_type = 'emoji_reaction'
                  AND sub_pi.emoji_id IS NOT DISTINCT FROM pi.emoji_id
                  AND sub_pi.custom_emoji_content IS NOT DISTINCT FROM pi.custom_emoji_content
                ORDER BY sub_pi.created_at DESC
                LIMIT p_user_limit
            ) recent
        ) as user_reactions,
        CASE
            WHEN current_profile_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = pi.post_id
                  AND check_pi.user_id = current_profile_id
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND check_pi.emoji_id IS NOT DISTINCT FROM pi.emoji_id
                  AND check_pi.custom_emoji_content IS NOT DISTINCT FROM pi.custom_emoji_content
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = ANY(p_post_ids)
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.post_id, pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY pi.post_id, MIN(pi.created_at) ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_post_emoji_reactions(p_post_id uuid, p_user_limit integer DEFAULT 5) RETURNS TABLE(emoji_id uuid, emoji_name text, emoji_url text, custom_emoji_content text, reaction_count bigint, user_reactions jsonb, current_user_reacted boolean)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
    current_profile_id uuid;
BEGIN
    -- post_interactions.user_id stores profile ids, not auth user ids.
    current_profile_id := public.get_current_profile_id();

    RETURN QUERY
    SELECT
        pi.emoji_id,
        e.name::text as emoji_name,
        -- Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Only include limited user data for tooltips
        (
            SELECT jsonb_agg(recent.entry ORDER BY recent.created_at DESC)
            FROM (
                SELECT jsonb_build_object(
                           'user_id', sub_pi.user_id,
                           'username', sub_p.username,
                           'display_name', sub_p.display_name,
                           'avatar_url', sub_p.avatar_url,
                           'created_at', sub_pi.created_at
                       ) AS entry,
                       sub_pi.created_at
                FROM post_interactions sub_pi
                LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
                WHERE sub_pi.post_id = p_post_id
                  AND sub_pi.interaction_type = 'emoji_reaction'
                  AND sub_pi.emoji_id IS NOT DISTINCT FROM pi.emoji_id
                  AND sub_pi.custom_emoji_content IS NOT DISTINCT FROM pi.custom_emoji_content
                ORDER BY sub_pi.created_at DESC
                LIMIT p_user_limit
            ) recent
        ) as user_reactions,
        CASE
            WHEN current_profile_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = p_post_id
                  AND check_pi.user_id = current_profile_id
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND check_pi.emoji_id IS NOT DISTINCT FROM pi.emoji_id
                  AND check_pi.custom_emoji_content IS NOT DISTINCT FROM pi.custom_emoji_content
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = p_post_id
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY MIN(pi.created_at) ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid DEFAULT NULL::uuid, p_custom_emoji_content text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
    v_deleted_count integer;
BEGIN
    -- SECURITY: Verify the caller owns this profile. SECURITY DEFINER bypasses
    -- post_interactions_delete_own, so without this the caller-supplied p_user_id is the
    -- only thing selecting rows and any caller can delete anyone's reactions. anon holds
    -- EXECUTE. add_post_emoji_reaction carries the identical check.
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot remove reactions as another user';
    END IF;

    -- emoji_id is compared exactly, NULL included: it is what separates a local picker
    -- reaction (uuid, ':name:') from a remote actor's shortcode (NULL, ':name:'), which the
    -- read RPCs return as two chips. Matching on custom_emoji_content alone deletes both.
    -- p_custom_emoji_content omitted alongside a p_emoji_id leaves the content
    -- unconstrained: the emoji picker knows only the emoji id, and every row under one
    -- emoji_id is the same emoji.
    DELETE FROM post_interactions
    WHERE user_id = p_user_id
      AND post_id = p_post_id
      AND interaction_type = 'emoji_reaction'
      AND emoji_id IS NOT DISTINCT FROM p_emoji_id
      AND (custom_emoji_content IS NOT DISTINCT FROM p_custom_emoji_content
           OR (p_custom_emoji_content IS NULL AND p_emoji_id IS NOT NULL));

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_deleted_count > 0;
END;
$$;

COMMIT;
