-- Fix: liking a post / reacting to a message failed with
--   42703: record "old" has no field "status"
-- Regression from 20260704_follow_request_notification_type.sql: the shared
-- notification trigger's ELSIF condition referenced OLD.status. The function
-- is also attached to AFTER INSERT triggers on reactions and post_interactions,
-- whose row types have no status column; plpgsql resolves OLD.status while
-- evaluating the condition even though TG_TABLE_NAME check is false, so every
-- favorite/reaction INSERT errored. The status check now lives inside a
-- follows-only nested IF.

CREATE OR REPLACE FUNCTION public.handle_unified_notification_processing() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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
            SELECT author_id INTO post_author_id
            FROM posts
            WHERE id = NEW.post_id;

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

COMMENT ON FUNCTION public.handle_unified_notification_processing() IS 'Handles notifications for follows (follow vs follow_request based on status, follow_accepted on pending->accepted), reactions, and ActivityPub emoji reactions. Includes full reactor/sender profile in notification data for proper display.';

-- Clarify a recurring confusion: is_local describes where the INTERACTION
-- originated (local user acting), not whether the target post is local. A
-- local user's favorite of a remote (e.g. Misskey) post is is_local = true,
-- which is what queues the outbound federated Like.
COMMENT ON COLUMN public.post_interactions.is_local IS 'True when the interaction originated on this instance (local user acting). Independent of whether the target post is local or remote.';
