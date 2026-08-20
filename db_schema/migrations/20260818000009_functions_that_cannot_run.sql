-- Four functions that plpgsql_check reports would raise the moment they are called.
--
-- Found by scripts/check-plpgsql.sh, which walks every plpgsql body in a fresh init/ build
-- against the catalog. None of the four has a caller in src/, federation-backend/src or
-- bot-gateway/src, so nothing observable changes; they are fixed because a body that cannot
-- run is a trap for whoever wires it up next, and because the gate is only worth having if
-- it is green on truth.
--
--   get_conversation_context   42702  its DECLARE block named conversation_root_id, which
--                                     shadows posts.conversation_root_id inside the CTE.
--                                     Renamed to v_conversation_root_id.
--   get_conversation_thread    42883  p_conversation_id is text, timeline_posts.conversation_id
--                                     is uuid. The parameter is cast rather than the column,
--                                     so the comparison stays sargable, and the text
--                                     signature is kept because PostgREST dispatches on it.
--   get_custom_status          0A000  declared STABLE while its expiry branch UPDATEs
--                                     profiles. Now VOLATILE.
--   rotate_prekeys             42703  wrote prekeys.metadata, a column neither production
--                                     nor init/ has. The statement is dropped: expires_at
--                                     already carries the fact it was recording.
--
-- get_conversation_context needs this migration rather than the init/ edit alone.
-- 20260315000003_fix_favorited_reply_notifications_mentions.sql recreates it with the
-- shadowing body, so a build that replays the migrations ends up with the broken version
-- and the drift gate fails. That file is below the baseline cutoff and is recorded rather
-- than replayed on every real instance, so editing it would change nothing anywhere and
-- would break the rule that an applied migration is immutable.
--
-- Numbered ahead of 20260818000013, which names pg_temp in every search_path: CREATE OR
-- REPLACE resets function attributes, so a fix landing after the normalisation would strip
-- the pin it just applied.
--
-- Bodies copied verbatim from init/, including each SET search_path, since CREATE OR REPLACE
-- resets function attributes.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_conversation_context(in_post_id uuid, in_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_conversation_root_id uuid;
    result jsonb;
BEGIN
    SELECT COALESCE(p.conversation_root_id, p.id)
    INTO v_conversation_root_id
    FROM posts p
    WHERE p.id = in_post_id
      AND p.deleted_at IS NULL;
    
    IF v_conversation_root_id IS NULL THEN
        RETURN '{}'::jsonb;
    END IF;
    
    WITH conversation_posts AS (
        SELECT 
            p.id,
            p.content,
            p.created_at,
            p.in_reply_to,
            jsonb_build_object(
                'id', pr.id,
                'username', pr.username,
                'display_name', pr.display_name,
                'avatar_url', pr.avatar_url,
                'domain', pr.domain
            ) as author,
            p.visibility,
            p.favorites_count,
            p.reblogs_count,
            p.replies_count,
            p.media_attachments,
            p.content_warning,
            p.is_sensitive,
            p.url,
            CASE 
                WHEN pi_fav.user_id IS NOT NULL THEN true 
                ELSE false 
            END as is_favorited,
            CASE 
                WHEN pi_reb.user_id IS NOT NULL THEN true 
                ELSE false 
            END as is_reblogged,
            CASE 
                WHEN pi_book.user_id IS NOT NULL THEN true 
                ELSE false 
            END as is_bookmarked
        FROM posts p
        JOIN profiles pr ON p.author_id = pr.id
        LEFT JOIN post_interactions pi_fav ON p.id = pi_fav.post_id 
            AND pi_fav.user_id = in_user_id 
            AND pi_fav.interaction_type IN ('favorite', 'emoji_reaction')
        LEFT JOIN post_interactions pi_reb ON p.id = pi_reb.post_id 
            AND pi_reb.user_id = in_user_id 
            AND pi_reb.interaction_type = 'reblog'
        LEFT JOIN post_interactions pi_book ON p.id = pi_book.post_id 
            AND pi_book.user_id = in_user_id 
            AND pi_book.interaction_type = 'bookmark'
        WHERE COALESCE(p.conversation_root_id, p.id) = v_conversation_root_id
          AND p.deleted_at IS NULL
        ORDER BY p.created_at ASC
    )
    SELECT jsonb_build_object(
        'ancestors', COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', cp.id,
                'content', cp.content,
                'created_at', cp.created_at,
                'author', cp.author,
                'visibility', cp.visibility,
                'favorites_count', cp.favorites_count,
                'reblogs_count', cp.reblogs_count,
                'replies_count', cp.replies_count,
                'media_attachments', cp.media_attachments,
                'content_warning', cp.content_warning,
                'is_sensitive', cp.is_sensitive,
                'url', cp.url,
                'is_favorited', cp.is_favorited,
                'is_reblogged', cp.is_reblogged,
                'is_bookmarked', cp.is_bookmarked
            )
        ) FILTER (WHERE cp.created_at < (SELECT created_at FROM posts WHERE id = in_post_id)), '[]'::jsonb),
        'descendants', COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', cp.id,
                'content', cp.content,
                'created_at', cp.created_at,
                'author', cp.author,
                'visibility', cp.visibility,
                'favorites_count', cp.favorites_count,
                'reblogs_count', cp.reblogs_count,
                'replies_count', cp.replies_count,
                'media_attachments', cp.media_attachments,
                'content_warning', cp.content_warning,
                'is_sensitive', cp.is_sensitive,
                'url', cp.url,
                'is_favorited', cp.is_favorited,
                'is_reblogged', cp.is_reblogged,
                'is_bookmarked', cp.is_bookmarked
            )
        ) FILTER (WHERE cp.created_at > (SELECT created_at FROM posts WHERE id = in_post_id)), '[]'::jsonb),
        'conversation_id', v_conversation_root_id
    ) INTO result
    FROM conversation_posts cp;
    
    RETURN COALESCE(result, jsonb_build_object(
        'ancestors', '[]'::jsonb,
        'descendants', '[]'::jsonb,
        'conversation_id', v_conversation_root_id
    ));
END;
$$;

CREATE OR REPLACE FUNCTION public.get_conversation_thread(p_conversation_id text, p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  root_post jsonb;
  thread_posts jsonb;
  reply_count integer;
  participant_count integer;
  last_updated timestamptz;
BEGIN
  -- Get the root post (the one that started the conversation)
  SELECT to_jsonb(tp.*) INTO root_post
  FROM timeline_posts tp
  WHERE tp.conversation_id = p_conversation_id::uuid
    AND tp.reply_context IS NULL
  ORDER BY tp.created_at ASC
  LIMIT 1;
  
  -- Get all posts in the conversation with user interaction state
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', tp.id,
      'content', tp.content,
      'author', tp.author,
      'created_at', tp.created_at,
      'reply_context', tp.reply_context,
      'replies_count', tp.replies_count,
      'reblogs_count', tp.reblogs_count,
      'favorites_count', tp.favorites_count,
      'is_favorited', COALESCE(fav.user_id IS NOT NULL, false),
      'is_reblogged', COALESCE(reb.user_id IS NOT NULL, false),
      'is_bookmarked', COALESCE(book.user_id IS NOT NULL, false)
    ) ORDER BY tp.created_at ASC
  ) INTO thread_posts
  FROM timeline_posts tp
  LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
    AND fav.user_id = p_user_id AND fav.interaction_type IN ('favorite', 'emoji_reaction')
  LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
    AND reb.user_id = p_user_id AND reb.interaction_type = 'reblog'
  LEFT JOIN post_interactions book ON tp.id = book.post_id 
    AND book.user_id = p_user_id AND book.interaction_type = 'bookmark'
  WHERE tp.conversation_id = p_conversation_id::uuid;
  
  -- Get conversation stats
  SELECT 
    COUNT(*) - 1, -- Subtract 1 for root post
    COUNT(DISTINCT tp.author_id),
    MAX(tp.created_at)
  INTO reply_count, participant_count, last_updated
  FROM timeline_posts tp
  WHERE tp.conversation_id = p_conversation_id::uuid;
  
  RETURN jsonb_build_object(
    'root_post', root_post,
    'posts', COALESCE(thread_posts, '[]'::jsonb),
    'reply_count', COALESCE(reply_count, 0),
    'participant_count', COALESCE(participant_count, 0),
    'last_updated', last_updated
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_custom_status(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_status jsonb;
    v_expires_at timestamptz;
BEGIN
    SELECT custom_status INTO v_status
    FROM profiles
    WHERE id = p_user_id;
    
    IF v_status IS NULL THEN
        RETURN NULL;
    END IF;
    
    -- Check if expired
    v_expires_at := (v_status->>'expires_at')::timestamptz;
    IF v_expires_at IS NOT NULL AND v_expires_at < NOW() THEN
        UPDATE profiles SET custom_status = NULL WHERE id = p_user_id;
        RETURN NULL;
    END IF;
    
    RETURN v_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.rotate_prekeys(p_user_id uuid, p_device_id text DEFAULT 'default'::text) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_deleted_count INTEGER;
    v_remaining_count INTEGER;
    v_result JSONB;
BEGIN
    -- Only allow users to rotate their own prekeys
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot rotate prekeys for another user';
    END IF;
    
    -- Delete used one-time prekeys older than 30 days
    DELETE FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = true
        AND used_at < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    
    -- No flag write for expired signed prekeys: prekeys has no metadata column in any
    -- environment, and expires_at already carries the fact.

    -- Count remaining unused one-time prekeys
    SELECT COUNT(*) INTO v_remaining_count
    FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = false;
    
    v_result := jsonb_build_object(
        'deleted_used_prekeys', v_deleted_count,
        'remaining_unused_prekeys', v_remaining_count,
        'rotation_completed_at', NOW()
    );
    
    -- Log the rotation
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        p_user_id,
        'key_rotated',
        'info',
        'Prekey rotation completed',
        v_result
    );
    
    RETURN v_result;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
