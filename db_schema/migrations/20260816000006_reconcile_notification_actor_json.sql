-- Reconciles the reply and mention notification handlers between init/ and
-- migrations/.
--
-- All three build the notification's `actor` object. init/ calls
-- notification_actor_json(); the migrated bodies inline a jsonb_build_object.
-- The two are not the same object:
--
--   key           notification_actor_json      inlined
--   id            p_id                         id
--   user_id       p_id                         MISSING
--   username      p_username                   username
--   display_name  COALESCE(display_name,       display_name, may be NULL
--                          username)
--   avatar_url    p_avatar_url                 avatar_url
--   domain        p_domain                     domain
--   is_local      COALESCE(is_local, true)     is_local, may be NULL
--   handle        profile_web_handle(...)      MISSING
--
-- The inlined form drops `handle` and `user_id` and stops coalescing the other
-- two, so a migrated database emits a weaker payload than a fresh one for every
-- reply and every mention.
--
-- The client depends on it. NotificationFormatter.getActorHandle is documented
-- "Web handle from notification payload (set by DB via notification_actor_json)"
-- and returns null when the key is absent; getUsername falls back to
-- reconstructing a handle from username and domain. So the helper is the
-- contract and inlining it broke that contract silently.
--
-- init/ carried over. The helper already exists on both sides -- nineteen call
-- sites survive in the migrated build -- so these three are the outliers, not a
-- new dependency.
--
-- Pinned by db_schema/tests/30_reconciled_functions.sql, which asserts the
-- actor payload of a reply notification carries handle and user_id.

BEGIN;

CREATE OR REPLACE FUNCTION public.handle_post_reply_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    parent_post RECORD;
    replier_profile RECORD;
    reply_preview TEXT;
BEGIN
    IF NEW.in_reply_to IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT p.id, p.author_id, p.content, pr.is_local
    INTO parent_post
    FROM posts p
    JOIN profiles pr ON pr.id = p.author_id
    WHERE p.id = NEW.in_reply_to;

    IF NOT FOUND OR parent_post.is_local != true THEN
        RETURN NEW;
    END IF;

    IF parent_post.author_id = NEW.author_id THEN
        RETURN NEW;
    END IF;

    SELECT id, username, display_name, avatar_url, domain, is_local
    INTO replier_profile
    FROM profiles
    WHERE id = NEW.author_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    reply_preview := extract_message_text(NEW.content);
    IF LENGTH(reply_preview) > 100 THEN
        reply_preview := LEFT(reply_preview, 100) || '...';
    END IF;
    IF reply_preview = '' OR reply_preview IS NULL THEN
        reply_preview := 'New reply';
    END IF;

    PERFORM send_notification_to_user(
        'activitypub_reply',
        parent_post.author_id,
        jsonb_build_object(
            'actor', notification_actor_json(
                replier_profile.id,
                replier_profile.username,
                replier_profile.display_name,
                replier_profile.avatar_url,
                replier_profile.domain,
                replier_profile.is_local
            ),
            'post', jsonb_build_object(
                'id', NEW.id,
                'ap_id', NEW.ap_id,
                'content_preview', reply_preview,
                'content', NEW.content
            ),
            'parent_post', jsonb_build_object(
                'id', parent_post.id,
                'content_preview', extract_message_text(parent_post.content)
            ),
            'post_id', NEW.id,
            'parent_post_id', parent_post.id,
            'timestamp', NEW.created_at
        ),
        NULL, NULL, NULL,
        NEW.author_id,
        'normal'
    );

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_post_mention_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    author_profile RECORD;
    post_content_preview TEXT;
    reply_parent_author_id UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- If this post is a reply, find the parent author so we can skip
        -- sending a duplicate mention notification (they already get a reply notification).
        IF NEW.in_reply_to IS NOT NULL THEN
            SELECT author_id INTO reply_parent_author_id
            FROM posts WHERE id = NEW.in_reply_to;
        END IF;

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
                            
                            -- Skip if the mentioned user is the parent post's author;
                            -- they already receive an activitypub_reply notification.
                            IF mentioned_user_id IS NOT NULL
                               AND mentioned_user_id IS DISTINCT FROM reply_parent_author_id THEN
                                PERFORM send_notification_to_user(
                                    'activitypub_mention',
                                    mentioned_user_id,
                                    jsonb_build_object(
                                        'actor', notification_actor_json(
                                            author_profile.id,
                                            author_profile.username,
                                            author_profile.display_name,
                                            author_profile.avatar_url,
                                            author_profile.domain,
                                            author_profile.is_local
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

CREATE OR REPLACE FUNCTION public.handle_local_post_mention_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
                                    'actor', notification_actor_json(
                                        author_profile.id,
                                        author_profile.username,
                                        author_profile.display_name,
                                        author_profile.avatar_url,
                                        author_profile.domain,
                                        author_profile.is_local
                                    ),
                                    'post', jsonb_build_object(
                                        'id', NEW.id,
                                        'ap_id', NEW.ap_id,
                                        'content_preview', post_content_preview,
                                        'content', NEW.content
                                    ),
                                    'post_id', NEW.id,
                                    'post_content', NEW.content,
                                    'timestamp', NEW.created_at
                                ),
                                NULL, NULL, NULL,
                                author_profile.id,
                                'normal'
                            );
                        END IF;
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

COMMIT;
