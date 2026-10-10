-- One mention notification per member per message.
--
-- A message mentioning a member directly and through @everyone or one of their roles notified
-- them twice: trg_handle_message_federation sends the direct mention, then
-- handle_role_mention_notifications sent @everyone and role mentions without regard to it.
-- @here already left directly mentioned members out; @everyone and roles now do the same.
--
-- Converges by state: CREATE OR REPLACE of the 20261011600001 body with the exclusion added.

BEGIN;

CREATE OR REPLACE FUNCTION public.handle_role_mention_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_server_id uuid;
    v_channel_name text;
    v_server_name text;
    v_sender_profile profiles%ROWTYPE;
    v_sender_json jsonb;
    v_can_mention_all boolean;
    v_everyone boolean;
    v_here boolean;
    v_here_ids uuid[] := '{}';
    v_direct_ids uuid[];
    v_roles uuid[];
    v_data jsonb;
    content_preview text;
BEGIN
    IF NEW.channel_id IS NULL OR NEW.is_system THEN
        RETURN NEW;
    END IF;

    SELECT c.server_id, c.name INTO v_server_id, v_channel_name
    FROM channels c WHERE c.id = NEW.channel_id;
    IF v_server_id IS NULL THEN RETURN NEW; END IF;

    IF jsonb_typeof(NEW.content) != 'array' THEN RETURN NEW; END IF;

    IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.content) elem
        WHERE elem->>'type' = 'role_mention'
    ) THEN
        RETURN NEW;
    END IF;

    IF NEW.bot_id IS NOT NULL THEN
        v_can_mention_all := check_bot_permission(NEW.bot_id, v_server_id, 'mention_everyone');
    ELSIF NEW.user_id IS NOT NULL THEN
        v_can_mention_all := has_permission(NEW.user_id, v_server_id, 'MENTION_EVERYONE', NEW.channel_id);
    ELSE
        RETURN NEW;
    END IF;

    -- @everyone (the is_default role) needs MENTION_EVERYONE; another role needs to be
    -- mentionable or MENTION_EVERYONE.
    SELECT bool_or(r.is_default), array_agg(r.id) FILTER (WHERE NOT r.is_default)
      INTO v_everyone, v_roles
      FROM server_roles r
     WHERE r.server_id = v_server_id
       AND r.id IN (SELECT (elem->>'roleId')::uuid
                      FROM jsonb_array_elements(NEW.content) elem
                     WHERE elem->>'type' = 'role_mention'
                       AND elem->>'roleId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       AND CASE WHEN r.is_default THEN v_can_mention_all
                ELSE COALESCE(r.mentionable, true) OR v_can_mention_all END;

    v_everyone := COALESCE(v_everyone, false);
    -- @here needs MENTION_EVERYONE.
    v_here := COALESCE(v_can_mention_all, false) AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.content) elem
         WHERE elem->>'type' = 'role_mention' AND elem->>'roleId' = 'here');
    IF NOT v_everyone AND NOT v_here AND v_roles IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;

    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;

    v_sender_json := message_notification_sender_json(
        NEW.user_id, NEW.bot_id, NEW.metadata, v_sender_profile
    );

    content_preview := LEFT(
        (SELECT string_agg(elem->>'text', ' ')
         FROM jsonb_array_elements(NEW.content) elem
         WHERE elem->>'type' = 'text'), 100);

    v_data := jsonb_build_object(
        'sender', v_sender_json,
        'message', jsonb_build_object('id', NEW.id, 'content_preview', content_preview),
        'location', jsonb_build_object(
            'server_id', v_server_id::text,
            'server_name', v_server_name,
            'channel_id', NEW.channel_id::text,
            'channel_name', v_channel_name
        ),
        'message_id', NEW.id,
        'mentioned_by', NEW.user_id,
        'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
        'sender_display_name', COALESCE(
            v_sender_json->>'display_name',
            v_sender_profile.display_name
        ),
        'server_id', v_server_id::text,
        'server_name', v_server_name,
        'channel_id', NEW.channel_id::text,
        'channel_name', v_channel_name,
        'preview', content_preview,
        'is_role_mention', true
    );

    -- Members a direct mention of this message already notified (trg_handle_message_federation
    -- fires first) get no second notification from @everyone, @here or a role.
    v_direct_ids := ARRAY(
        SELECT n.user_id FROM notifications n
         WHERE n.created_at = now() AND n.type = 'mention'
           AND n.data->>'message_id' = NEW.id::text);

    -- Suppressing members are left out here; send_notification applies the same flags.
    IF v_everyone THEN
        PERFORM send_notification(
            'mention',
            ARRAY(SELECT us.user_id FROM user_servers us
                    LEFT JOIN notification_servers ns
                      ON ns.user_id = us.user_id AND ns.server_id = us.server_id
                   WHERE us.server_id = v_server_id
                     AND us.status = 'accepted'
                     AND us.user_id IS DISTINCT FROM NEW.user_id
                     AND NOT COALESCE(ns.suppress_everyone, false)
                     AND us.user_id <> ALL (v_direct_ids)),
            v_data || jsonb_build_object('is_everyone', true),
            v_server_id, NEW.channel_id, NULL, NEW.user_id, 'normal'
        );
    END IF;

    -- Online members; members a mention of this message reached are left out.
    IF v_here AND NOT v_everyone THEN
        v_here_ids := ARRAY(
            SELECT us.user_id FROM user_servers us
              JOIN user_presence up ON up.profile_id = us.user_id
              LEFT JOIN notification_servers ns
                ON ns.user_id = us.user_id AND ns.server_id = us.server_id
             WHERE us.server_id = v_server_id
               AND us.status = 'accepted'
               AND us.user_id IS DISTINCT FROM NEW.user_id
               AND up.status IN (1, 2, 3)
               AND NOT COALESCE(ns.suppress_everyone, false)
               AND EXISTS (SELECT 1 FROM presence_devices d
                            WHERE d.profile_id = us.user_id
                              AND d.last_seen_at > now() - interval '150 seconds')
            EXCEPT
            SELECT unnest(v_direct_ids));
        PERFORM send_notification(
            'mention',
            v_here_ids,
            v_data || jsonb_build_object('is_everyone', true, 'is_here', true),
            v_server_id, NEW.channel_id, NULL, NEW.user_id, 'normal'
        );
    END IF;

    -- Holders @everyone or @here reached are left out.
    IF v_roles IS NOT NULL THEN
        PERFORM send_notification(
            'mention',
            ARRAY(SELECT DISTINCT ur.user_id FROM user_roles ur
                    LEFT JOIN notification_servers ns
                      ON ns.user_id = ur.user_id AND ns.server_id = ur.server_id
                   WHERE ur.server_id = v_server_id
                     AND ur.role_id = ANY (v_roles)
                     AND ur.user_id IS DISTINCT FROM NEW.user_id
                     AND NOT COALESCE(ns.suppress_roles, false)
                     AND (NOT v_everyone OR COALESCE(ns.suppress_everyone, false))
                     AND ur.user_id <> ALL (v_here_ids)
                     AND ur.user_id <> ALL (v_direct_ids)),
            v_data,
            v_server_id, NEW.channel_id, NULL, NEW.user_id, 'normal'
        );
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_role_mention_notifications() FROM PUBLIC, anon, authenticated;

COMMIT;
