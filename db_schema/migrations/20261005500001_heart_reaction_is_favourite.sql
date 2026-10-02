-- The heart reaction is the favourite.
--
-- Mastodon has no reactions: every Like is a favourite. Misskey stores its like as the
-- reaction U+2764 with variation selectors stripped and maps a Like carrying no
-- `_misskey_reaction` to it. A post holds one heart per actor, as a `favorite` row;
-- `emoji_reaction` rows carry every other emoji. Existing rows hold an inbound Mastodon
-- Like or Misskey ❤ as a ❤️ emoji_reaction, a chip beside an unfilled heart, and the
-- read paths fill the heart for any reaction the caller holds.
--
--   is_heart_reaction(text)          ❤ and ♥, with or without U+FE0E/U+FE0F. 💗 and the
--                                    other coloured hearts are reactions. Mirrors
--                                    isHeartReaction in src/utils/heartReaction.ts and
--                                    federation-backend/src/utils/heartReaction.ts.
--   trg_fold_heart_reaction          BEFORE INSERT: a heart emoji_reaction is written as
--                                    the favourite, or dropped when the actor holds one.
--                                    Sorts before trigger_federate_post_interaction, which
--                                    then queues a favourite.
--   add/remove_post_emoji_reaction   a heart adds or removes the caller's favourite.
--   update_post_reaction_counts      favorites_count counts favourites only.
--   trigger_queue_interaction_federation
--                                    the delete payload carries the emoji, so the Undo
--                                    names the reaction it removes. A reblog row is
--                                    skipped: the boost post federates the Announce, and
--                                    the reaction job sent it as a Like.
--   handle_post_interaction_federation
--                                    the baseline no-op. Production carries an older body
--                                    that queues every emoji reaction on a local post to
--                                    the shared inbox of up to 20 arbitrary domains.
--   get_enhanced_timeline_posts, get_federated_timeline, get_post_with_context,
--   get_trending_posts               is_favorited is the caller's favourite alone.
--                                    get_trending_posts is the keyset version of
--                                    20261005300001_trending_keyset.sql, the seven-
--                                    parameter overload dropped as there.
--
-- Existing rows converge by state:
--
--   A heart emoji_reaction whose actor already holds the favourite, or an older heart, is
--   deleted. The remote side holds one like for the actor either way, so the delete
--   federates nothing: trigger_federate_post_interaction_delete is disabled for the
--   statement and restored to its prior state.
--   Every remaining heart emoji_reaction becomes the favourite in place, keeping its id,
--   ap_id and federation_status.
--   Local posts recount favorites_count from their favourite rows. Remote posts keep the
--   origin-supplied figure, less what the outgoing trigger counted for duplicate hearts
--   and for every other emoji; the next fetch from the origin replaces it.
--   update_post_reaction_counts is replaced last, so the fold runs under the trigger that
--   counted the rows it removes.
--
-- Rerunning finds no heart emoji_reaction, and the installed trigger counts no emoji
-- reaction to give back.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- is_heart_reaction
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_heart_reaction(p_content text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
    SELECT COALESCE(
        translate(btrim(p_content), E'\uFE0E\uFE0F', '') IN (E'\u2764', E'\u2665'),
        false
    )
$$;

COMMENT ON FUNCTION public.is_heart_reaction(text) IS
'True for a unicode heart reaction (U+2764, U+2665, with or without a variation selector): the favourite.';

-- ---------------------------------------------------------------------------
-- trg_fold_heart_reaction
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fold_heart_reaction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_heart_reaction(NEW.custom_emoji_content) THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.post_interactions
         WHERE user_id = NEW.user_id
           AND post_id = NEW.post_id
           AND interaction_type = 'favorite'
    ) THEN
        RETURN NULL;
    END IF;

    NEW.interaction_type := 'favorite';
    NEW.emoji_id := NULL;
    NEW.custom_emoji_content := NULL;
    RETURN NEW;
END;
$$;

-- BEFORE triggers fire in name order; trg_ precedes trigger_check_emoji_reaction_limit and
-- trigger_federate_post_interaction.
DROP TRIGGER IF EXISTS trg_fold_heart_reaction ON public.post_interactions;
CREATE TRIGGER trg_fold_heart_reaction
    BEFORE INSERT ON public.post_interactions
    FOR EACH ROW
    WHEN (NEW.interaction_type = 'emoji_reaction')
    EXECUTE FUNCTION public.fold_heart_reaction();

-- ---------------------------------------------------------------------------
-- trigger_queue_interaction_federation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_queue_interaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    -- Bookmarks are private. A reblog federates as the Announce of its boost post.
    IF TG_OP = 'INSERT' AND NEW.interaction_type IN ('bookmark', 'reblog') THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' AND OLD.interaction_type IN ('bookmark', 'reblog') THEN
        RETURN OLD;
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-reaction',
            jsonb_build_object(
                'type', 'create',
                'interaction_id', NEW.id,
                'interaction_type', NEW.interaction_type,
                'post_id', NEW.post_id,
                'user_id', NEW.user_id,
                'emoji_id', NEW.emoji_id,
                'custom_emoji_content', NEW.custom_emoji_content
            ), 5, 3, 1800
        );
    ELSIF TG_OP = 'DELETE' THEN
        -- The Undo embeds the Like it reverses, emoji included.
        PERFORM public.queue_federation_job(
            'federate-reaction',
            jsonb_build_object(
                'type', 'delete',
                'interaction_id', OLD.id,
                'interaction_type', OLD.interaction_type,
                'post_id', OLD.post_id,
                'user_id', OLD.user_id,
                'emoji_id', OLD.emoji_id,
                'custom_emoji_content', OLD.custom_emoji_content
            ), 5, 3, 1800
        );
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- handle_post_interaction_federation
-- ---------------------------------------------------------------------------
-- Post interactions federate through trigger_queue_interaction_federation.
CREATE OR REPLACE FUNCTION public.handle_post_interaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        RETURN NEW;
    ELSE
        RETURN OLD;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- add_post_emoji_reaction / remove_post_emoji_reaction
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_post_emoji_reaction(
    p_user_id uuid,
    p_post_id uuid,
    p_emoji_id uuid DEFAULT NULL,
    p_custom_emoji_content text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_interaction_id uuid;
    v_resolved_content text;
BEGIN
    -- SECURITY: Verify the caller owns this profile
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot create reactions as another user';
    END IF;

    IF p_emoji_id IS NULL AND p_custom_emoji_content IS NULL THEN
        RAISE EXCEPTION 'Must provide either emoji_id or custom_emoji_content';
    END IF;

    -- Auto-populate custom_emoji_content from emoji table when missing
    v_resolved_content := p_custom_emoji_content;
    IF p_emoji_id IS NOT NULL AND v_resolved_content IS NULL THEN
        SELECT CASE
            WHEN e.url IS NOT NULL THEN ':' || e.name || ':'
            ELSE e.name
        END INTO v_resolved_content
        FROM emojis e WHERE e.id = p_emoji_id;
    END IF;

    -- The heart is the caller's favourite (is_heart_reaction). Idempotent, as below.
    IF public.is_heart_reaction(v_resolved_content) THEN
        SELECT id INTO v_interaction_id
        FROM post_interactions
        WHERE user_id = p_user_id
          AND post_id = p_post_id
          AND interaction_type = 'favorite';

        IF v_interaction_id IS NOT NULL THEN
            RETURN v_interaction_id;
        END IF;

        BEGIN
            INSERT INTO post_interactions (user_id, post_id, interaction_type, is_local)
            VALUES (p_user_id, p_post_id, 'favorite', true)
            RETURNING id INTO v_interaction_id;
        EXCEPTION WHEN unique_violation THEN
            SELECT id INTO v_interaction_id
            FROM post_interactions
            WHERE user_id = p_user_id
              AND post_id = p_post_id
              AND interaction_type = 'favorite';
        END;

        RETURN v_interaction_id;
    END IF;

    -- Idempotent: an existing reaction is returned, not duplicated. A second row is a
    -- second count on the chip, and remove_post_emoji_reaction deletes every matching row
    -- in one statement.
    -- IS NOT DISTINCT FROM matches idx_post_interactions_emoji_unique, which is
    -- NULLS NOT DISTINCT: emoji_id is null on a unicode reaction, custom_emoji_content is
    -- null on a row written without one.
    SELECT id INTO v_interaction_id
    FROM post_interactions
    WHERE user_id = p_user_id
      AND post_id = p_post_id
      AND interaction_type = 'emoji_reaction'
      AND emoji_id IS NOT DISTINCT FROM p_emoji_id
      AND custom_emoji_content IS NOT DISTINCT FROM v_resolved_content
    ORDER BY created_at, id
    LIMIT 1;

    IF v_interaction_id IS NOT NULL THEN
        RETURN v_interaction_id;
    END IF;

    BEGIN
        INSERT INTO post_interactions (
            user_id, post_id, interaction_type,
            emoji_id, custom_emoji_content, is_local
        ) VALUES (
            p_user_id, p_post_id, 'emoji_reaction',
            p_emoji_id, v_resolved_content, true
        ) RETURNING id INTO v_interaction_id;
    EXCEPTION WHEN unique_violation THEN
        -- Concurrent caller committed the same reaction between the check and the insert.
        -- READ COMMITTED gives the re-read a fresh snapshot, so the winning row is visible.
        SELECT id INTO v_interaction_id
        FROM post_interactions
        WHERE user_id = p_user_id
          AND post_id = p_post_id
          AND interaction_type = 'emoji_reaction'
          AND emoji_id IS NOT DISTINCT FROM p_emoji_id
          AND custom_emoji_content IS NOT DISTINCT FROM v_resolved_content
        ORDER BY created_at, id
        LIMIT 1;
    END;

    RETURN v_interaction_id;
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

    -- The heart is the caller's favourite (is_heart_reaction).
    IF p_emoji_id IS NULL AND public.is_heart_reaction(p_custom_emoji_content) THEN
        DELETE FROM post_interactions
        WHERE user_id = p_user_id
          AND post_id = p_post_id
          AND interaction_type = 'favorite';

        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
        RETURN v_deleted_count > 0;
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

-- ---------------------------------------------------------------------------
-- is_favorited: the caller's favourite row
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_enhanced_timeline_posts(p_user_id uuid, p_timeline_type text DEFAULT 'home'::text, p_limit integer DEFAULT 20, p_max_id text DEFAULT NULL::text) RETURNS TABLE(id text, created_at timestamp with time zone, updated_at timestamp with time zone, content jsonb, content_warning text, language text, author_id text, ap_id text, ap_type text, url text, reply_context jsonb, conversation_id text, visibility text, is_local boolean, is_federated boolean, replies_count integer, reblogs_count integer, favorites_count integer, media_attachments jsonb, metadata jsonb, is_sensitive boolean, is_deleted boolean, deleted_at timestamp with time zone, author jsonb, is_favorited boolean, is_reblogged boolean, is_bookmarked boolean, reblog jsonb, reblog_author jsonb)
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        tp.id::TEXT,
        tp.created_at,
        tp.updated_at,
        tp.content,
        tp.content_warning,
        'en'::TEXT as language,
        (tp.author->>'id')::TEXT as author_id,
        p.ap_id::TEXT,
        COALESCE(p.ap_type, 'Note')::TEXT as ap_type,
        tp.url,
        tp.reply_context,
        tp.conversation_id::TEXT,
        tp.visibility,
        (tp.author->>'is_local')::BOOLEAN as is_local,
        NOT (tp.author->>'is_local')::BOOLEAN as is_federated,
        tp.replies_count,
        tp.reblogs_count,
        tp.favorites_count,
        tp.media_attachments,
        COALESCE(p.metadata, '{}'::JSONB) as metadata,
        tp.is_sensitive,
        COALESCE(p.is_deleted, false) as is_deleted,
        p.deleted_at,
        tp.author,
        
        -- User interaction states
        COALESCE(fav.user_id IS NOT NULL, false) as is_favorited,
        COALESCE(reb.user_id IS NOT NULL, false) as is_reblogged,
        COALESCE(book.user_id IS NOT NULL, false) as is_bookmarked,
        
        -- Reblog fields
        tp.reblog,
        tp.reblog_author
        
    FROM timeline_posts tp
    JOIN posts p ON tp.id = p.id
    LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
        AND fav.user_id = p_user_id 
        AND fav.interaction_type = 'favorite'
    LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
        AND reb.user_id = p_user_id 
        AND reb.interaction_type = 'reblog'
    LEFT JOIN post_interactions book ON tp.id = book.post_id 
        AND book.user_id = p_user_id 
        AND book.interaction_type = 'bookmark'
    
    WHERE 
        CASE 
            -- HOME: Use timeline_entries for proper following logic
            WHEN p_timeline_type = 'home' THEN 
                EXISTS (
                    SELECT 1 FROM timeline_entries te 
                    WHERE te.user_id = p_user_id 
                      AND te.post_id = tp.id 
                      AND te.timeline_type = 'home'
                )
            
            -- LOCAL: Only public posts from local users
            WHEN p_timeline_type = 'local' THEN 
                tp.visibility = 'public' 
                AND (tp.author->>'is_local')::BOOLEAN = true
            
            -- PUBLIC/FEDERATED: All public posts (local + remote) - standard ActivityPub timeline
            WHEN p_timeline_type IN ('public', 'federated') THEN 
                tp.visibility = 'public'
                
            ELSE tp.visibility = 'public'
        END
        
        -- Hide silenced users from public/local/federated timelines (keep on home)
        AND (
            p_timeline_type = 'home'
            OR NOT EXISTS (
                SELECT 1 FROM profiles spr
                WHERE spr.id = tp.author_id
                  AND spr.is_silenced = true
            )
        )
        
        -- Pagination
        AND (p_max_id IS NULL OR tp.created_at < (
            SELECT tp2.created_at FROM timeline_posts tp2 WHERE tp2.id = p_max_id::UUID
        ))
    
    ORDER BY tp.created_at DESC
    LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_federated_timeline(p_user_id uuid, p_limit integer DEFAULT 20, p_max_id text DEFAULT NULL::text) RETURNS TABLE(id text, created_at timestamp with time zone, updated_at timestamp with time zone, content jsonb, content_warning text, language text, author_id text, ap_id text, ap_type text, url text, conversation_id text, visibility text, is_local boolean, is_federated boolean, replies_count integer, reblogs_count integer, favorites_count integer, media_attachments jsonb, metadata jsonb, is_sensitive boolean, author jsonb, is_favorited boolean, is_reblogged boolean, is_bookmarked boolean)
    LANGUAGE plpgsql STABLE
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id::TEXT,
        p.created_at,
        p.updated_at,
        p.content,
        p.content_warning,
        p.language,
        p.author_id::TEXT,
        p.ap_id,
        p.ap_type,
        p.url,
        p.conversation_id::TEXT,
        p.visibility,
        p.is_local,
        p.is_federated,
        COALESCE(p.replies_count, 0)::INTEGER,
        COALESCE(p.reblogs_count, 0)::INTEGER,
        COALESCE(p.favorites_count, 0)::INTEGER,
        COALESCE(p.media_attachments, '[]'::jsonb),
        COALESCE(p.metadata, '{}'::jsonb),
        COALESCE(p.is_sensitive, false),
        -- Author object
        jsonb_build_object(
            'id', pr.id,
            'username', pr.username,
            'display_name', pr.display_name,
            'avatar_url', pr.avatar_url,
            'domain', COALESCE(pr.domain, 'har.mony.lol'),
            'handle', CASE 
                WHEN COALESCE(pr.is_local, true) THEN '@' || pr.username
                ELSE '@' || pr.username || '@' || pr.domain
            END,
            'is_local', COALESCE(pr.is_local, true),
            'bio', pr.bio,
            'color', pr.color
        ) AS author,
        -- User interaction states
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
              AND pi.user_id = p_user_id 
              AND pi.interaction_type = 'favorite'
        ) AS is_favorited,
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
              AND pi.user_id = p_user_id 
              AND pi.interaction_type = 'reblog'
        ) AS is_reblogged,
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
              AND pi.user_id = p_user_id 
              AND pi.interaction_type = 'bookmark'
        ) AS is_bookmarked
        
    FROM posts p
    INNER JOIN profiles pr ON p.author_id = pr.id
    
    WHERE 
        -- Remote posts only (federated content from other instances)
        p.is_local = false
        -- Public visibility only
        AND p.visibility = 'public'
        -- Not deleted (check both fields for safety)
        AND (p.is_deleted = false OR p.is_deleted IS NULL)
        AND p.deleted_at IS NULL
        -- Not from suspended or silenced users
        AND (pr.is_suspended = false OR pr.is_suspended IS NULL)
        AND (pr.is_silenced = false OR pr.is_silenced IS NULL)
        -- Top-level posts only (not replies)
        AND p.in_reply_to IS NULL
        -- Pagination
        AND (p_max_id IS NULL OR p.created_at < (
            SELECT p2.created_at FROM posts p2 WHERE p2.id::TEXT = p_max_id
        ))
    
    ORDER BY p.created_at DESC
    LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_post_with_context(p_post_id uuid, p_user_id uuid, p_context_type text DEFAULT 'minimal'::text, p_highlight_reply uuid DEFAULT NULL::uuid, p_max_depth integer DEFAULT 10, p_include_interactions boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_main_post JSONB;
  v_ancestors JSONB := '[]'::jsonb;
  v_descendants JSONB := '[]'::jsonb;
  v_thread_info JSONB;
  v_thread_id UUID;
  v_root_post_id UUID;
  v_total_posts INTEGER := 1;
  v_participant_count INTEGER := 1;
  v_max_depth INTEGER := 0;
  v_last_activity TIMESTAMP WITH TIME ZONE;
BEGIN
  -- Get the main post with all required fields and user interaction states
  SELECT to_jsonb(post_data) INTO v_main_post
  FROM (
    SELECT 
      p.*,
      profiles.id as author_id,
      profiles.username as author_username,
      profiles.display_name as author_display_name,
      profiles.avatar_url as author_avatar_url,
      profiles.domain as author_domain,
      profiles.bio as author_bio,
      profiles.is_local as author_is_local,
      profiles.followers_count as author_followers_count,
      profiles.following_count as author_following_count,
      profiles.posts_count as author_posts_count,
      profiles.created_at as author_created_at,
      profiles.updated_at as author_updated_at,
      -- Generate handle from username and domain
      CASE 
        WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
          '@' || profiles.username || '@' || profiles.domain
        ELSE 
          '@' || profiles.username
      END as author_handle,
      -- User interaction states (only if p_include_interactions is true)
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'favorite')
        ELSE false
      END as is_favorited,
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'reblog')
        ELSE false
      END as is_reblogged,
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'bookmark')
        ELSE false
      END as is_bookmarked,
      -- Author object for nested structure
      jsonb_build_object(
        'id', profiles.id,
        'username', profiles.username,
        'display_name', profiles.display_name,
        'avatar_url', profiles.avatar_url,
        'domain', profiles.domain,
        'bio', profiles.bio,
        'is_local', profiles.is_local,
        'followers_count', profiles.followers_count,
        'following_count', profiles.following_count,
        'posts_count', profiles.posts_count,
        'created_at', profiles.created_at,
        'updated_at', profiles.updated_at,
        'handle', CASE 
          WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
            '@' || profiles.username || '@' || profiles.domain
          ELSE 
            '@' || profiles.username
        END
      ) as author
    FROM posts p
    JOIN profiles ON profiles.id = p.author_id
    WHERE p.id = p_post_id
      AND p.is_deleted = false
  ) as post_data;

  -- If main post not found, return error
  IF v_main_post IS NULL THEN
    RETURN jsonb_build_object('error', 'Post not found');
  END IF;

  -- Get thread_id for thread context (may be null, that's ok)
  SELECT conversation_id INTO v_thread_id 
  FROM posts 
  WHERE id = p_post_id;

  -- For non-minimal contexts, get thread data
  IF p_context_type != 'minimal' THEN
    -- Find root post of the thread by following in_reply_to chain upward
    WITH RECURSIVE thread_root AS (
      -- Base case: start with the current post
      SELECT id, in_reply_to, 0 as depth
      FROM posts 
      WHERE id = p_post_id
      
      UNION ALL
      
      -- Recursive case: follow in_reply_to chain upward
      SELECT p.id, p.in_reply_to, tr.depth + 1
      FROM posts p
      JOIN thread_root tr ON p.id = tr.in_reply_to
      WHERE tr.depth < 50 -- Prevent infinite recursion
    )
    SELECT id INTO v_root_post_id 
    FROM thread_root 
    WHERE in_reply_to IS NULL
    ORDER BY depth DESC 
    LIMIT 1;

    -- If no root found, current post is the root
    IF v_root_post_id IS NULL THEN
      v_root_post_id := p_post_id;
    END IF;

    -- Get thread statistics using the conversation_root_id chain instead of conversation_id
    WITH RECURSIVE all_thread_posts AS (
      -- Start from the root post
      SELECT id, in_reply_to, author_id, created_at, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      
      UNION ALL
      
      -- Get all posts that are replies in this thread
      SELECT p.id, p.in_reply_to, p.author_id, p.created_at, atp.depth + 1
      FROM posts p
      JOIN all_thread_posts atp ON p.in_reply_to = atp.id
      WHERE atp.depth < 50 -- Prevent infinite recursion
        AND p.is_deleted = false
    )
    SELECT 
      COUNT(DISTINCT id),
      COUNT(DISTINCT author_id),
      MAX(created_at)
    INTO v_total_posts, v_participant_count, v_last_activity
    FROM all_thread_posts;

    -- Get ancestors (posts this is replying to) if requested
    IF p_context_type IN ('thread', 'ancestors') THEN
      WITH RECURSIVE ancestors AS (
        -- Base case: direct parent
        SELECT p.*, 0 as depth
        FROM posts p
        WHERE p.id = (SELECT in_reply_to FROM posts WHERE id = p_post_id)
          AND p.is_deleted = false
        
        UNION ALL
        
        -- Recursive case: follow the reply chain upward
        SELECT p.*, a.depth + 1
        FROM posts p
        JOIN ancestors a ON p.id = (SELECT in_reply_to FROM posts WHERE id = a.id)
        WHERE a.depth < p_max_depth
          AND p.is_deleted = false
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'created_at', a.created_at,
          'updated_at', a.updated_at,
          'content', a.content,
          'content_warning', a.content_warning,
          'language', a.language,
          'author_id', a.author_id,
          'ap_id', a.ap_id,
          'ap_type', a.ap_type,
          'url', a.url,
          'conversation_id', a.conversation_id,
          'visibility', a.visibility,
          'is_local', a.is_local,
          'is_federated', a.is_federated,
          'replies_count', a.replies_count,
          'reblogs_count', a.reblogs_count,
          'favorites_count', a.favorites_count,
          'media_attachments', a.media_attachments,
          'metadata', a.metadata,
          'is_sensitive', a.is_sensitive,
          'is_deleted', a.is_deleted,
          'deleted_at', a.deleted_at,
          'is_favorited', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'favorite')
            ELSE false
          END,
          'is_reblogged', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'reblog')
            ELSE false
          END,
          'is_bookmarked', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'bookmark')
            ELSE false
          END,
          'author', jsonb_build_object(
            'id', profiles.id,
            'username', profiles.username,
            'display_name', profiles.display_name,
            'avatar_url', profiles.avatar_url,
            'domain', profiles.domain,
            'bio', profiles.bio,
            'is_local', profiles.is_local,
            'followers_count', profiles.followers_count,
            'following_count', profiles.following_count,
            'posts_count', profiles.posts_count,
            'created_at', profiles.created_at,
            'updated_at', profiles.updated_at,
            'handle', CASE 
              WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
                '@' || profiles.username || '@' || profiles.domain
              ELSE 
                '@' || profiles.username
            END
          )
        ) ORDER BY a.depth DESC -- Oldest ancestor first
      ) INTO v_ancestors
      FROM ancestors a
      JOIN profiles ON profiles.id = a.author_id;
    END IF;

    -- Get descendants (replies to this post) if requested
    IF p_context_type IN ('thread', 'descendants') THEN
      WITH RECURSIVE descendants AS (
        -- Base case: direct replies
        SELECT p.*, 0 as depth, ARRAY[p.created_at::text, p.id::text] as sort_path
        FROM posts p
        WHERE p.in_reply_to = p_post_id
          AND p.is_deleted = false
        
        UNION ALL
        
        -- Recursive case: follow reply chains downward
        SELECT p.*, d.depth + 1, d.sort_path || ARRAY[p.created_at::text, p.id::text]
        FROM posts p
        JOIN descendants d ON p.in_reply_to = d.id
        WHERE d.depth < p_max_depth
          AND p.is_deleted = false
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'created_at', d.created_at,
          'updated_at', d.updated_at,
          'content', d.content,
          'content_warning', d.content_warning,
          'language', d.language,
          'author_id', d.author_id,
          'ap_id', d.ap_id,
          'ap_type', d.ap_type,
          'url', d.url,
          'conversation_id', d.conversation_id,
          'visibility', d.visibility,
          'is_local', d.is_local,
          'is_federated', d.is_federated,
          'replies_count', d.replies_count,
          'reblogs_count', d.reblogs_count,
          'favorites_count', d.favorites_count,
          'media_attachments', d.media_attachments,
          'metadata', d.metadata,
          'is_sensitive', d.is_sensitive,
          'is_deleted', d.is_deleted,
          'deleted_at', d.deleted_at,
          'depth', d.depth,
          'is_favorited', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'favorite')
            ELSE false
          END,
          'is_reblogged', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'reblog')
            ELSE false
          END,
          'is_bookmarked', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'bookmark')
            ELSE false
          END,
          'author', jsonb_build_object(
            'id', profiles.id,
            'username', profiles.username,
            'display_name', profiles.display_name,
            'avatar_url', profiles.avatar_url,
            'domain', profiles.domain,
            'bio', profiles.bio,
            'is_local', profiles.is_local,
            'followers_count', profiles.followers_count,
            'following_count', profiles.following_count,
            'posts_count', profiles.posts_count,
            'created_at', profiles.created_at,
            'updated_at', profiles.updated_at,
            'handle', CASE 
              WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
                '@' || profiles.username || '@' || profiles.domain
              ELSE 
                '@' || profiles.username
            END
          )
        ) ORDER BY d.sort_path -- Chronological order preserving thread structure
      ) INTO v_descendants
      FROM descendants d
      JOIN profiles ON profiles.id = d.author_id;
    END IF;

    -- Calculate max depth for thread info using reply chain instead of conversation_id
    WITH RECURSIVE depth_calc AS (
      SELECT id, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      
      UNION ALL
      
      SELECT p.id, dc.depth + 1
      FROM posts p
      JOIN depth_calc dc ON p.in_reply_to = dc.id
      WHERE dc.depth < 50 -- Prevent infinite recursion
        AND p.is_deleted = false
    )
    SELECT COALESCE(MAX(depth), 0) INTO v_max_depth
    FROM depth_calc;
  END IF;

  -- Build thread info
  v_thread_info := jsonb_build_object(
    'totalPosts', COALESCE(v_total_posts, 1),
    'participantCount', COALESCE(v_participant_count, 1),
    'depth', COALESCE(v_max_depth, 0),
    'rootPostId', COALESCE(v_root_post_id, p_post_id),
    'lastActivity', COALESCE(v_last_activity, (v_main_post->>'created_at')::timestamp with time zone)
  );

  -- Return the complete result
  RETURN jsonb_build_object(
    'mainPost', v_main_post,
    'ancestors', COALESCE(v_ancestors, '[]'::jsonb),
    'descendants', COALESCE(v_descendants, '[]'::jsonb),
    'threadInfo', v_thread_info
  );

EXCEPTION WHEN OTHERS THEN
  -- Log error and return structured error response
  RAISE LOG 'Error in get_post_with_context: %', SQLERRM;
  RETURN jsonb_build_object(
    'error', 'Database error: ' || SQLERRM,
    'mainPost', null,
    'ancestors', '[]'::jsonb,
    'descendants', '[]'::jsonb,
    'threadInfo', jsonb_build_object(
      'totalPosts', 0,
      'participantCount', 0,
      'depth', 0,
      'rootPostId', null,
      'lastActivity', null
    )
  );
END;
$$;

-- The keyset signature of 20261005300001_trending_keyset.sql. The seven-parameter function
-- is dropped as there: beside the ten-parameter one, a seven-argument call matches both.
DROP FUNCTION IF EXISTS public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz);

CREATE OR REPLACE FUNCTION public.get_trending_posts(
    p_hours integer DEFAULT 24,
    p_media_only boolean DEFAULT false,
    p_local_only boolean DEFAULT false,
    p_domain text DEFAULT NULL,
    p_limit integer DEFAULT 20,
    p_offset integer DEFAULT 0,
    p_as_of timestamptz DEFAULT NULL,
    p_after_score double precision DEFAULT NULL,
    p_after_created_at timestamptz DEFAULT NULL,
    p_after_id uuid DEFAULT NULL
) RETURNS TABLE (
    id uuid,
    created_at timestamptz,
    updated_at timestamptz,
    content jsonb,
    content_warning text,
    language text,
    author_id uuid,
    ap_id text,
    ap_type text,
    url text,
    conversation_id uuid,
    visibility text,
    is_local boolean,
    is_federated boolean,
    replies_count integer,
    reblogs_count integer,
    favorites_count integer,
    media_attachments jsonb,
    metadata jsonb,
    is_sensitive boolean,
    author jsonb,
    is_favorited boolean,
    is_reblogged boolean,
    is_bookmarked boolean,
    score double precision,
    as_of timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_as_of timestamptz := LEAST(COALESCE(p_as_of, now()), now());
    v_hours integer := LEAST(GREATEST(COALESCE(p_hours, 24), 1), 720);
    v_since timestamptz;
    v_half_life double precision;
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 40);
    v_offset integer := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 400);
    v_media_only boolean := COALESCE(p_media_only, false);
    v_local_only boolean := COALESCE(p_local_only, false);
    v_domain text := NULLIF(lower(btrim(p_domain)), '');
    -- A cursor needs all three parts; a partial one is ignored.
    v_keyset boolean := p_after_score IS NOT NULL AND p_after_created_at IS NOT NULL
                        AND p_after_id IS NOT NULL;
BEGIN
    v_since := v_as_of - make_interval(hours => v_hours);
    v_half_life := v_hours * 1800.0;

    -- EXECUTE plans each call with its arguments. A cached generic plan does not know the
    -- window's width and joins profiles to posts by author: 34 s against 0.6 s for 7 days.
    RETURN QUERY EXECUTE $q$
    WITH ranked AS (
        -- float8 throughout: numeric power() cost 13 us a row (get_today_summary).
        SELECT p.*,
               (power(greatest(coalesce(p.replies_count, 0), 0)::float8, 0.9::float8) * 3
                + power(greatest(coalesce(p.reblogs_count, 0), 0)::float8, 0.8::float8) * 2
                + power(greatest(coalesce(p.favorites_count, 0), 0)::float8, 0.7::float8))
               * power(0.5::float8, extract(epoch FROM $2 - p.created_at)::float8 / $3)
                   AS rank_score
          FROM public.posts p
         WHERE p.visibility = 'public'
           AND p.is_deleted = false
           AND p.created_at > $1
           AND p.created_at <= $2
           AND p.reblog IS NULL
           AND p.in_reply_to IS NULL
           AND NOT (COALESCE(p.metadata, '{}'::jsonb) ? 'in_reply_to_ap_url')
           AND (coalesce(p.replies_count, 0) > 0
                OR coalesce(p.reblogs_count, 0) > 0
                OR coalesce(p.favorites_count, 0) > 0)
           AND (NOT $5 OR p.is_local)
           AND (NOT $4 OR public.post_has_profile_media(p.media_attachments, p.content))
    ),
    page AS (
        SELECT r.*, a.username AS a_username, a.display_name AS a_display_name,
               a.avatar_url AS a_avatar_url, a.banner_url AS a_banner_url, a.bio AS a_bio,
               a.color AS a_color, a.domain AS a_domain, a.is_local AS a_is_local,
               a.created_at AS a_created_at, a.updated_at AS a_updated_at,
               a.followers_count AS a_followers_count, a.following_count AS a_following_count,
               a.posts_count AS a_posts_count
          FROM ranked r
          JOIN public.profiles a ON a.id = r.author_id
         WHERE a.is_suspended IS NOT TRUE
           AND a.is_silenced IS NOT TRUE
           AND a.federation_discoverable IS NOT FALSE
           AND ($6::text IS NULL OR lower(a.domain) = $6)
           AND (NOT $10 OR (r.rank_score, r.created_at, r.id) < ($11, $12, $13))
         ORDER BY r.rank_score DESC, r.created_at DESC, r.id DESC
         LIMIT $7 OFFSET $8
    )
    SELECT pg.id,
           pg.created_at,
           pg.updated_at,
           pg.content,
           pg.content_warning,
           pg.language,
           pg.author_id,
           pg.ap_id,
           pg.ap_type,
           pg.url,
           pg.conversation_id,
           pg.visibility,
           pg.is_local,
           pg.is_federated,
           coalesce(pg.replies_count, 0),
           coalesce(pg.reblogs_count, 0),
           coalesce(pg.favorites_count, 0),
           coalesce(pg.media_attachments, '[]'::jsonb),
           coalesce(pg.metadata, '{}'::jsonb),
           coalesce(pg.is_sensitive, false),
           jsonb_build_object(
               'id', pg.author_id,
               'username', pg.a_username,
               'display_name', pg.a_display_name,
               'avatar_url', pg.a_avatar_url,
               'banner_url', pg.a_banner_url,
               'bio', pg.a_bio,
               'color', pg.a_color,
               'domain', pg.a_domain,
               'is_local', pg.a_is_local,
               'created_at', pg.a_created_at,
               'updated_at', pg.a_updated_at,
               'followers_count', pg.a_followers_count,
               'following_count', pg.a_following_count,
               'posts_count', pg.a_posts_count),
           EXISTS (SELECT 1 FROM public.post_interactions i
                    WHERE i.user_id = $9 AND i.post_id = pg.id
                      AND i.interaction_type = 'favorite'),
           EXISTS (SELECT 1 FROM public.post_interactions i
                    WHERE i.user_id = $9 AND i.post_id = pg.id
                      AND i.interaction_type = 'reblog'),
           EXISTS (SELECT 1 FROM public.post_interactions i
                    WHERE i.user_id = $9 AND i.post_id = pg.id
                      AND i.interaction_type = 'bookmark'),
           pg.rank_score,
           $2
      FROM page pg
     ORDER BY pg.rank_score DESC, pg.created_at DESC, pg.id DESC
    $q$
    USING v_since, v_as_of, v_half_life, v_media_only, v_local_only, v_domain, v_limit,
          v_offset, v_me, v_keyset, p_after_score, p_after_created_at, p_after_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz, double precision, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz, double precision, timestamptz, uuid) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Existing rows
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_trigger_state "char";
    v_dropped bigint;
    v_remote_adjusted bigint := 0;
    v_converted bigint;
    v_recounted bigint;
BEGIN
    SELECT t.tgenabled INTO v_trigger_state
      FROM pg_trigger t
     WHERE t.tgrelid = 'public.post_interactions'::regclass
       AND t.tgname = 'trigger_federate_post_interaction_delete';

    IF v_trigger_state IS NULL THEN
        RAISE NOTICE 'trigger_federate_post_interaction_delete absent; deletes below queue nothing';
    ELSIF v_trigger_state <> 'D' THEN
        ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction_delete;
    END IF;

    -- update_post_reaction_counts counts each delete down while it counts the row.
    DELETE FROM public.post_interactions h
     WHERE h.interaction_type = 'emoji_reaction'
       AND public.is_heart_reaction(h.custom_emoji_content)
       AND (
           EXISTS (
               SELECT 1 FROM public.post_interactions f
                WHERE f.user_id = h.user_id
                  AND f.post_id = h.post_id
                  AND f.interaction_type = 'favorite'
           )
           OR EXISTS (
               SELECT 1 FROM public.post_interactions o
                WHERE o.user_id = h.user_id
                  AND o.post_id = h.post_id
                  AND o.interaction_type = 'emoji_reaction'
                  AND public.is_heart_reaction(o.custom_emoji_content)
                  AND (o.created_at, o.id) < (h.created_at, h.id)
           )
       );
    GET DIAGNOSTICS v_dropped = ROW_COUNT;

    CASE v_trigger_state
        WHEN 'O' THEN ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction_delete;
        WHEN 'A' THEN ALTER TABLE public.post_interactions ENABLE ALWAYS TRIGGER trigger_federate_post_interaction_delete;
        WHEN 'R' THEN ALTER TABLE public.post_interactions ENABLE REPLICA TRIGGER trigger_federate_post_interaction_delete;
        ELSE NULL;
    END CASE;

    -- A remote post gives back what the outgoing trigger counted for its other emoji. Only
    -- while that trigger is installed: replaced below, it has counted nothing to give back.
    IF (SELECT p.prosrc ~ 'emoji_reaction'
          FROM pg_proc p
         WHERE p.oid = 'public.update_post_reaction_counts()'::regprocedure) THEN
        UPDATE public.posts p
           SET favorites_count = GREATEST(COALESCE(p.favorites_count, 0) - r.n, 0)
          FROM (SELECT post_id, count(*)::int AS n
                  FROM public.post_interactions
                 WHERE interaction_type = 'emoji_reaction'
                   AND NOT public.is_heart_reaction(custom_emoji_content)
                 GROUP BY post_id) r
         WHERE p.id = r.post_id
           AND p.is_local IS NOT TRUE;
        GET DIAGNOSTICS v_remote_adjusted = ROW_COUNT;
    END IF;

    UPDATE public.post_interactions h
       SET interaction_type = 'favorite',
           emoji_id = NULL,
           custom_emoji_content = NULL
     WHERE h.interaction_type = 'emoji_reaction'
       AND public.is_heart_reaction(h.custom_emoji_content);
    GET DIAGNOSTICS v_converted = ROW_COUNT;

    WITH counted AS (
        SELECT p.id, count(f.id)::int AS n
          FROM public.posts p
          LEFT JOIN public.post_interactions f
                 ON f.post_id = p.id
                AND f.interaction_type = 'favorite'
         WHERE p.is_local IS TRUE
         GROUP BY p.id
    )
    UPDATE public.posts p
       SET favorites_count = c.n
      FROM counted c
     WHERE p.id = c.id
       AND p.favorites_count IS DISTINCT FROM c.n;
    GET DIAGNOSTICS v_recounted = ROW_COUNT;

    RAISE NOTICE 'heart reactions: % duplicate(s) deleted, % converted to favourites; % remote and % local post count(s) adjusted',
                 v_dropped, v_converted, v_remote_adjusted, v_recounted;
END
$$;

-- ---------------------------------------------------------------------------
-- update_post_reaction_counts
-- ---------------------------------------------------------------------------
-- Replaced after the fold, whose deletes the old body counts down.
-- favorites_count counts favourite rows. reblogs_count is maintained by
-- update_post_reblog_count from posts.metadata->>'reblog_of'.
-- SECURITY DEFINER: the row written is a post the caller does not own, and
-- posts_update_own would filter the UPDATE to nothing.
CREATE OR REPLACE FUNCTION public.update_post_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.interaction_type = 'favorite' THEN
      UPDATE posts
      SET favorites_count = favorites_count + 1
      WHERE id = NEW.post_id;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.interaction_type = 'favorite' THEN
      UPDATE posts
      SET favorites_count = GREATEST(favorites_count - 1, 0)
      WHERE id = OLD.post_id;
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
