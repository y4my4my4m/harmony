-- Inbound federated posts: length limit, quotes of deleted posts, notifications to remote
-- authors, ap_activities retention.
--
-- enforce_post_length applied instance_config.max_post_length to every posts row. A remote
-- post longer than the local limit failed its insert and was dropped on every inbound path
-- (inbox, boosts, URL resolve, replies crawl, outbox import), and a remote edit growing past
-- the limit failed its update: the longest of ~25k remote posts on production was exactly 500
-- characters. The limit now applies to local rows only; posts_text_length_check caps every
-- row at 50000. Locality is OLD.is_local on UPDATE: a_posts_client_write_guard keeps is_local
-- fixed for clients, and the old row is authoritative whatever the trigger order.
--
-- cascade_delete_reblogs soft-deleted every row whose reblog snapshot named the deleted post.
-- Quotes carry that snapshot too, so deleting a post deleted every quote of it, and a local
-- quote sent a federated Delete. Quotes (metadata.is_quote) are posts of their own and stay.
--
-- handle_unified_notification_processing notified the author of a post on every
-- post_interactions insert. Announces of remote posts reach this instance through followers
-- of the booster, so remote authors collected activitypub_reblog rows nobody reads (5,462 on
-- production). Only local authors are notified; the rows already addressed to remote
-- profiles by this path are deleted.
--
-- The activitypub-cleanup-old-activities job, scheduled on production outside the
-- migrations, deleted ap_activities rows with status 'processed' and attempts < 3.
-- complete_ap_activity writes 'completed', so nothing was ever purged (148k rows). The job
-- now calls purge_processed_ap_activities(), which deletes 'completed' and 'processed' rows
-- older than 30 days whatever their attempt count. The job is created where it is absent.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Post length: local rows only
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_post_length()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    soft_limit integer;
    text_len integer;
BEGIN
    IF (CASE WHEN TG_OP = 'UPDATE' THEN OLD.is_local ELSE NEW.is_local END) IS FALSE THEN
        RETURN NEW;
    END IF;

    soft_limit := public.get_instance_config_int('max_post_length', 500, 50000);

    text_len := public.jsonb_text_content_length(NEW.content);
    IF text_len > soft_limit THEN
        RAISE EXCEPTION 'Post text exceeds the instance limit of % characters (got %)', soft_limit, text_len
            USING ERRCODE = 'check_violation',
                  HINT = 'Trim the post or ask an instance admin to raise max_post_length.';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_post_length() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Deleting a post: boosts follow it, quotes stay
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cascade_delete_reblogs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.posts
       SET is_deleted = true, deleted_at = now()
     WHERE reblog ->> 'id' = NEW.id::text
       AND is_deleted IS NOT TRUE
       AND NOT COALESCE(metadata -> 'is_quote' IN ('true'::jsonb, '"true"'::jsonb), false);

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.cascade_delete_reblogs() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Interaction notifications: local authors only
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_unified_notification_processing() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
    single_target_id uuid;
    notification_data jsonb;
    msg_channel_id uuid;
    msg_server_id uuid;
    msg_conversation_id uuid;
    msg_channel_name text;
    msg_server_name text;
    post_author_id uuid;
    post_record RECORD;
    emoji_record RECORD;
    emoji_name text;
    emoji_url text;
    reactor_profile RECORD;
    follower_profile RECORD;
    accepter_profile RECORD;
    follow_notification_type text;
BEGIN
    -- Handle follows
    IF TG_TABLE_NAME = 'follows' AND TG_OP = 'INSERT' THEN
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO follower_profile
        FROM profiles
        WHERE id = NEW.follower_id;

        IF follower_profile.id IS NOT NULL THEN
            follow_notification_type := CASE
                WHEN NEW.status = 'pending' THEN 'activitypub_follow_request'
                ELSE 'activitypub_follow'
            END;

            notification_data := jsonb_build_object(
                'type', follow_notification_type,
                'follower_id', NEW.follower_id,
                'follower', notification_actor_json(
                    follower_profile.id,
                    follower_profile.username,
                    follower_profile.display_name,
                    follower_profile.avatar_url,
                    follower_profile.domain,
                    follower_profile.is_local
                ),
                -- 'sender' alias: push payload builder reads data.sender for actor name/avatar
                'sender', notification_actor_json(
                    follower_profile.id,
                    follower_profile.username,
                    follower_profile.display_name,
                    follower_profile.avatar_url,
                    follower_profile.domain,
                    follower_profile.is_local
                )
            );

            PERFORM send_notification_to_user(
                follow_notification_type,
                NEW.following_id,
                notification_data,
                NULL, NULL, NULL,
                NEW.follower_id,
                'normal'
            );
        END IF;

    -- Follow request approved: notify the requester.
    -- OLD.status must only be referenced inside the follows-only branch: this
    -- function also fires for INSERTs on reactions/post_interactions, whose
    -- row types have no status column, and plpgsql resolves record fields in
    -- the ELSIF condition even when the table check is false (42703).
    ELSIF TG_TABLE_NAME = 'follows' AND TG_OP = 'UPDATE' THEN
      IF OLD.status = 'pending' AND NEW.status = 'accepted' THEN
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO follower_profile
        FROM profiles
        WHERE id = NEW.follower_id;

        -- Remote followers are notified by their own instance via the federated Accept
        IF follower_profile.id IS NOT NULL AND COALESCE(follower_profile.is_local, true) THEN
            SELECT id, username, display_name, avatar_url, domain, is_local
            INTO accepter_profile
            FROM profiles
            WHERE id = NEW.following_id;

            IF accepter_profile.id IS NOT NULL THEN
                notification_data := jsonb_build_object(
                    'type', 'activitypub_follow_accepted',
                    'followed_id', NEW.following_id,
                    'sender', notification_actor_json(
                        accepter_profile.id,
                        accepter_profile.username,
                        accepter_profile.display_name,
                        accepter_profile.avatar_url,
                        accepter_profile.domain,
                        accepter_profile.is_local
                    )
                );

                PERFORM send_notification_to_user(
                    'activitypub_follow_accepted',
                    NEW.follower_id,
                    notification_data,
                    NULL, NULL, NULL,
                    NEW.following_id,
                    'normal'
                );
            END IF;
        END IF;

      END IF;

    ELSIF TG_TABLE_NAME = 'reactions' AND TG_OP = 'INSERT' THEN
        SELECT user_id INTO single_target_id FROM messages WHERE id = NEW.message_id;

        IF single_target_id IS NOT NULL AND single_target_id != NEW.user_id THEN
            SELECT m.channel_id, c.server_id, m.conversation_id, c.name, s.name
            INTO msg_channel_id, msg_server_id, msg_conversation_id, msg_channel_name, msg_server_name
            FROM messages m
            LEFT JOIN channels c ON m.channel_id = c.id
            LEFT JOIN servers s ON c.server_id = s.id
            WHERE m.id = NEW.message_id;

            SELECT id, username, display_name, avatar_url, domain, is_local
            INTO reactor_profile
            FROM profiles
            WHERE id = NEW.user_id;

            emoji_name := NULL;
            emoji_url := NULL;
            IF NEW.emoji_id IS NOT NULL THEN
                SELECT name, url INTO emoji_record FROM emojis WHERE id = NEW.emoji_id;
                IF FOUND THEN
                    emoji_name := emoji_record.name;
                    emoji_url := emoji_record.url;
                END IF;
            END IF;

            notification_data := jsonb_build_object(
                'type', 'reaction',
                'message_id', NEW.message_id,
                'channel_id', msg_channel_id,
                'server_id', msg_server_id,
                'channel_name', msg_channel_name,
                'server_name', msg_server_name,
                'message_preview', extract_message_text((SELECT content FROM messages WHERE id = NEW.message_id)),
                'reaction', jsonb_build_object(
                    'emoji_id', NEW.emoji_id,
                    'emoji_name', COALESCE(emoji_name, NEW.custom_emoji_content),
                    'emoji_url', emoji_url,
                    'custom_emoji_content', NEW.custom_emoji_content
                ),
                'sender', CASE WHEN reactor_profile.id IS NOT NULL THEN
                    notification_actor_json(
                        reactor_profile.id,
                        reactor_profile.username,
                        reactor_profile.display_name,
                        reactor_profile.avatar_url,
                        reactor_profile.domain,
                        reactor_profile.is_local
                    )
                ELSE NULL END
            );

            IF msg_conversation_id IS NOT NULL THEN
                notification_data := notification_data || jsonb_build_object(
                    'conversation_id', msg_conversation_id
                );
            END IF;

            PERFORM send_notification_to_user(
                'reaction',
                single_target_id,
                notification_data,
                msg_server_id, msg_channel_id, msg_conversation_id,
                NEW.user_id,
                'normal'
            );
        END IF;

    ELSIF TG_TABLE_NAME = 'post_interactions' AND TG_OP = 'INSERT' THEN
        IF NEW.interaction_type IN ('emoji_reaction', 'favorite', 'reblog') THEN
            -- A remote author is notified by its own instance.
            SELECT p.author_id INTO post_author_id
            FROM posts p
            JOIN profiles pr ON pr.id = p.author_id
            WHERE p.id = NEW.post_id
              AND COALESCE(pr.is_local, true);

            IF post_author_id IS NOT NULL AND post_author_id != NEW.user_id THEN
                SELECT * INTO post_record FROM posts WHERE id = NEW.post_id;

                SELECT id, username, display_name, avatar_url, domain, is_local
                INTO reactor_profile
                FROM profiles
                WHERE id = NEW.user_id;

                emoji_name := NULL;
                emoji_url := NULL;
                IF NEW.emoji_id IS NOT NULL THEN
                    SELECT name, url INTO emoji_record FROM emojis WHERE id = NEW.emoji_id;
                    IF FOUND THEN
                        emoji_name := emoji_record.name;
                        emoji_url := emoji_record.url;
                    END IF;
                END IF;

                notification_data := jsonb_build_object(
                    'type', CASE
                        WHEN NEW.interaction_type = 'favorite' THEN 'activitypub_favorite'
                        WHEN NEW.interaction_type = 'reblog' THEN 'activitypub_reblog'
                        ELSE 'activitypub_reaction'
                    END,
                    'post_id', NEW.post_id,
                    'post', jsonb_build_object(
                        'id', post_record.id,
                        'content_preview', extract_message_text(post_record.content)
                    ),
                    'reaction', jsonb_build_object(
                        'emoji_id', NEW.emoji_id,
                        'emoji_name', COALESCE(emoji_name, NEW.custom_emoji_content),
                        'emoji_url', emoji_url,
                        'custom_emoji_content', NEW.custom_emoji_content
                    ),
                    'sender', CASE WHEN reactor_profile.id IS NOT NULL THEN
                        notification_actor_json(
                            reactor_profile.id,
                            reactor_profile.username,
                            reactor_profile.display_name,
                            reactor_profile.avatar_url,
                            reactor_profile.domain,
                            reactor_profile.is_local
                        )
                    ELSE NULL END
                );

                PERFORM send_notification_to_user(
                    CASE
                        WHEN NEW.interaction_type = 'favorite' THEN 'activitypub_favorite'
                        WHEN NEW.interaction_type = 'reblog' THEN 'activitypub_reblog'
                        ELSE 'activitypub_reaction'
                    END,
                    post_author_id,
                    notification_data,
                    NULL, NULL, NULL,
                    NEW.user_id,
                    'normal'
                );
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_unified_notification_processing() IS 'Handles notifications for follows (follow vs follow_request based on status, follow_accepted on pending->accepted), reactions, and ActivityPub emoji reactions, favourites and boosts of posts by local authors. Includes full reactor/sender profile in notification data for proper display.';

REVOKE ALL ON FUNCTION public.handle_unified_notification_processing() FROM PUBLIC, anon, authenticated;

DELETE FROM public.notifications n
 USING public.profiles p
 WHERE p.id = n.user_id
   AND p.is_local IS FALSE
   AND n.type IN ('activitypub_reblog', 'activitypub_favorite', 'activitypub_reaction');

-- ---------------------------------------------------------------------------
-- ap_activities retention
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.purge_processed_ap_activities()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_deleted integer;
BEGIN
    DELETE FROM public.ap_activities
     WHERE status IN ('completed', 'processed')
       AND created_at < now() - interval '30 days';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.purge_processed_ap_activities() IS
    'Deletes ap_activities rows completed over 30 days ago. Scheduled daily via pg_cron.';

REVOKE ALL ON FUNCTION public.purge_processed_ap_activities() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_processed_ap_activities() TO service_role;

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN PERFORM cron.unschedule('activitypub-cleanup-old-activities'); EXCEPTION WHEN OTHERS THEN NULL; END;
        PERFORM cron.schedule('activitypub-cleanup-old-activities', '0 3 * * *', 'SELECT public.purge_processed_ap_activities()');
        RAISE NOTICE 'activitypub-cleanup-old-activities scheduled';
    ELSE
        RAISE NOTICE 'pg_cron not available; purge_processed_ap_activities() is not scheduled';
    END IF;
END
$do$;

COMMIT;

NOTIFY pgrst, 'reload schema';
