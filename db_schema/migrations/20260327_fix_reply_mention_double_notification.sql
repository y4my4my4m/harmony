BEGIN;

-- Fix: when a federated user replies to a local user's post, the reply content
-- typically includes an @mention of the parent author. This caused two notifications:
-- 1) activitypub_reply (from handle_post_reply_notifications)
-- 2) activitypub_mention (from handle_post_mention_notifications)
--
-- The fix: skip the mention notification when the mentioned user is the parent
-- post's author, since they already receive a reply notification.

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
