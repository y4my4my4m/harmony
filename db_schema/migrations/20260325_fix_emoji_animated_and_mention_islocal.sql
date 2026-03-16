BEGIN;

-- =============================================================================
-- Fix 1: upsert_remote_emoji - stop resetting is_animated to false
-- COALESCE(p_is_animated, false) in VALUES always produced false when param was
-- NULL, then EXCLUDED.is_animated was never NULL so the ON CONFLICT update
-- always overwrote the stored value. Removing the COALESCE lets NULL pass
-- through, so COALESCE(EXCLUDED.is_animated, remote_emojis_cache.is_animated)
-- correctly preserves the existing value.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.upsert_remote_emoji(
    p_shortcode text,
    p_origin_domain text,
    p_full_code text,
    p_url text,
    p_static_url text DEFAULT NULL,
    p_category text DEFAULT NULL,
    p_is_animated boolean DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.remote_emojis_cache (
    shortcode, origin_domain, full_code, url, static_url, category, is_animated
  ) VALUES (
    p_shortcode, p_origin_domain, p_full_code, p_url, p_static_url, p_category, p_is_animated
  )
  ON CONFLICT (shortcode, origin_domain) DO UPDATE SET
    url = EXCLUDED.url,
    static_url = COALESCE(EXCLUDED.static_url, remote_emojis_cache.static_url),
    last_seen_at = now(),
    usage_count = remote_emojis_cache.usage_count + 1,
    category = COALESCE(EXCLUDED.category, remote_emojis_cache.category),
    is_animated = COALESCE(EXCLUDED.is_animated, remote_emojis_cache.is_animated)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- =============================================================================
-- Fix 2: handle_post_mention_notifications - fix isLocal boolean cast
-- The ->> operator returns text, so (content_part->>'isLocal')::boolean casts
-- the string 'false' to TRUE (any non-empty string is truthy in PG bool cast).
-- Use text comparison instead.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_post_mention_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    author_profile RECORD;
    post_content_preview TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO author_profile
        FROM profiles 
        WHERE id = NEW.author_id;
        
        IF FOUND AND NEW.content IS NOT NULL THEN
            post_content_preview := extract_message_text(NEW.content);
            IF LENGTH(post_content_preview) > 100 THEN
                post_content_preview := LEFT(post_content_preview, 100) || '...';
            END IF;
            IF post_content_preview = '' OR post_content_preview IS NULL THEN
                post_content_preview := 'New post';
            END IF;
            
            IF jsonb_typeof(NEW.content) = 'array' THEN
                FOR content_part IN SELECT jsonb_array_elements(NEW.content)
                LOOP
                    IF content_part->>'type' = 'mention' THEN
                        mentioned_username := content_part->>'username';
                        
                        IF content_part->>'isLocal' = 'true' THEN
                            SELECT id INTO mentioned_user_id
                            FROM profiles 
                            WHERE username = mentioned_username 
                              AND is_local = true
                              AND id != NEW.author_id;
                            
                            IF mentioned_user_id IS NOT NULL THEN
                                PERFORM send_notification_to_user(
                                    'activitypub_mention',
                                    mentioned_user_id,
                                    jsonb_build_object(
                                        'actor', jsonb_build_object(
                                            'id', author_profile.id,
                                            'username', author_profile.username,
                                            'display_name', author_profile.display_name,
                                            'avatar_url', author_profile.avatar_url,
                                            'domain', author_profile.domain,
                                            'is_local', author_profile.is_local
                                        ),
                                        'post', jsonb_build_object(
                                            'id', NEW.id,
                                            'ap_id', NEW.ap_id,
                                            'content_preview', post_content_preview,
                                            'content', NEW.content
                                        ),
                                        'post_id', NEW.id,
                                        'post_content', NEW.content,
                                        'timestamp', NEW.created_at,
                                        'federated', NEW.is_federated
                                    ),
                                    NULL, NULL, NULL,
                                    author_profile.id,
                                    'normal'
                                );
                            END IF;
                        END IF;
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
