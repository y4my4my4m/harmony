-- Production state that differs from a fresh install in behaviour, converged.
--
-- messages.metadata. A fresh install defaults it to '{}'; production has no default, so a
-- message inserted without metadata stores NULL. trigger_queue_channel_message_delete_federation
-- returns early for a withheld message only when NOT (NEW.metadata ? 'federated') is true, and
-- for NULL it is NULL: deleting such a message in an encrypted channel queues
-- federate-channel-message-delete for a message never federated. Rows already NULL stay NULL;
-- the column is nullable on a fresh install too.
--
-- Functions. Each definition is the baseline's, with a fresh install's attributes. The
-- baseline is not replayed on live instances, so production kept earlier bodies:
--
--   delete_server_with_cleanup      production compares servers.owner with the p_owner_id
--                                   argument only; any caller, anon included, deletes any
--                                   server by naming its owner
--   clear_custom_status             production clears the status of any profile for any caller
--   count_pinned_messages           SECURITY DEFINER on production, counting pinned messages in
--                                   any channel or conversation past RLS; invoker here
--   get_user_notifications          production hides a muted sender's notifications on
--                                   user_mutes.mute_type IN ('notifications_only', 'all');
--                                   mute_type defaults to 'posts_and_boosts' and no production
--                                   row holds either value. Here: hide_notifications, as in
--                                   send_notification
--   get_public_federation_settings  production omits enable_inbound_federation and
--                                   enable_outbound_federation from the result
--   handle_post_federation          production calls build_post_create_activity(uuid, uuid),
--                                   which production lacks; EXCEPTION WHEN OTHERS turns every
--                                   local public or unlisted post insert into a logged no-op.
--                                   A no-op here
--
-- Staging carries these bodies already, apart from comments and search_path.
-- Privileges are a fresh install's: EXECUTE for PUBLIC, anon, authenticated, service_role.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
    v_default text;
BEGIN
    SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_default
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.messages'::regclass AND a.attname = 'metadata' AND NOT a.attisdropped;

    IF v_default IS NOT DISTINCT FROM '''{}''::jsonb' THEN
        RAISE NOTICE 'messages.metadata: default already ''{}''::jsonb, skipped';
    ELSE
        ALTER TABLE public.messages ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;
        RAISE NOTICE 'messages.metadata: default % -> ''{}''::jsonb', coalesce(v_default, 'none');
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_server_with_cleanup(p_server_id uuid, p_owner_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_profile_id uuid;
BEGIN
    -- SECURITY: Get caller's profile ID
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();

    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    -- SECURITY: Verify p_owner_id matches the caller
    IF v_caller_profile_id != p_owner_id THEN
        RAISE EXCEPTION 'Unauthorized: Cannot delete server as another user';
    END IF;

    -- Verify caller is actually the owner
    IF NOT EXISTS (SELECT 1 FROM servers WHERE id = p_server_id AND owner = v_caller_profile_id) THEN
        RAISE EXCEPTION 'Not authorized to delete this server';
    END IF;

    -- Delete all related data (cascades handle most)
    DELETE FROM servers WHERE id = p_server_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_custom_status(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- SECURITY: Verify the caller owns this profile
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot modify another user''s status';
    END IF;

    UPDATE profiles
    SET custom_status = NULL, last_status_update = NOW()
    WHERE id = p_user_id;

    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.count_pinned_messages(
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    RETURN (
        SELECT COUNT(*)::integer
        FROM messages
        WHERE is_pinned = true
          AND is_deleted = false
          AND (p_channel_id IS NULL OR channel_id = p_channel_id)
          AND (p_conversation_id IS NULL OR conversation_id = p_conversation_id)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_notifications(p_user_id uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_unread_only boolean DEFAULT false, p_notification_types character varying[] DEFAULT NULL::character varying[]) RETURNS TABLE(id uuid, user_id uuid, type character varying, data jsonb, is_read boolean, is_clicked boolean, created_at timestamp with time zone, updated_at timestamp with time zone, expires_at timestamp with time zone, read_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY INVOKER
    SET search_path = public, extensions, pg_temp
    AS $$
BEGIN
    RETURN QUERY
    SELECT
        n.id,
        n.user_id,
        n.type,
        n.data,
        n.is_read,
        n.is_clicked,
        n.created_at,
        n.updated_at,
        n.expires_at,
        n.read_at
    FROM notifications n
    WHERE n.user_id = p_user_id
    AND (NOT p_unread_only OR n.is_read = FALSE)
    AND (p_notification_types IS NULL OR n.type = ANY(p_notification_types))

    -- Filter out notifications from blocked users
    -- Extract sender ID from various possible JSONB structures
    AND NOT EXISTS (
        SELECT 1
        FROM user_blocks ub
        WHERE ub.blocker_id = p_user_id
        AND ub.blocked_user_id = COALESCE(
            NULLIF((n.data->>'from_user_id'), '')::uuid,
            NULLIF((n.data->'sender'->>'id'), '')::uuid,
            NULLIF((n.data->'sender'->>'user_id'), '')::uuid,
            NULLIF((n.data->>'follower_id'), '')::uuid,
            NULLIF((n.data->'follower'->>'id'), '')::uuid,
            NULLIF((n.data->'actor'->>'id'), '')::uuid,
            NULLIF((n.data->'user'->>'id'), '')::uuid,
            NULLIF((n.data->'author'->>'id'), '')::uuid
        )
        AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
    )

    -- Filter out notifications from muted users (hide_notifications)
    AND NOT EXISTS (
        SELECT 1
        FROM user_mutes um
        WHERE um.muter_id = p_user_id
        AND um.muted_user_id = COALESCE(
            NULLIF((n.data->>'from_user_id'), '')::uuid,
            NULLIF((n.data->'sender'->>'id'), '')::uuid,
            NULLIF((n.data->'sender'->>'user_id'), '')::uuid,
            NULLIF((n.data->>'follower_id'), '')::uuid,
            NULLIF((n.data->'follower'->>'id'), '')::uuid,
            NULLIF((n.data->'actor'->>'id'), '')::uuid,
            NULLIF((n.data->'user'->>'id'), '')::uuid,
            NULLIF((n.data->'author'->>'id'), '')::uuid
        )
        AND um.hide_notifications = true
        AND (um.expires_at IS NULL OR um.expires_at > NOW())
    )

    -- Filter out notifications from muted channels/conversations
    AND NOT EXISTS (
        SELECT 1
        FROM notification_channels nc
        WHERE nc.user_id = p_user_id
        AND nc.muted = true
        AND (
            (nc.channel_id IS NOT NULL AND nc.channel_id = COALESCE(
                NULLIF((n.data->>'channel_id'), '')::uuid,
                NULLIF((n.data->'location'->>'channel_id'), '')::uuid
            ))
            OR
            (nc.conversation_id IS NOT NULL AND nc.conversation_id = COALESCE(
                NULLIF((n.data->>'conversation_id'), '')::uuid,
                NULLIF((n.data->'conversation'->>'id'), '')::uuid
            ))
        )
        AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
    )

    ORDER BY n.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_public_federation_settings()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    federation_settings jsonb;
    inbound_enabled boolean;
    outbound_enabled boolean;
BEGIN
    -- Get federation settings from instance_config
    SELECT config_value::jsonb INTO federation_settings
    FROM instance_config
    WHERE config_key = 'federation_settings';

    -- Also check individual inbound/outbound settings
    SELECT
        COALESCE((config_value::text)::boolean, true)
    INTO inbound_enabled
    FROM instance_config
    WHERE config_key = 'enable_inbound_federation';

    SELECT
        COALESCE((config_value::text)::boolean, true)
    INTO outbound_enabled
    FROM instance_config
    WHERE config_key = 'enable_outbound_federation';

    -- Return safe subset of federation settings
    IF federation_settings IS NULL THEN
        RETURN jsonb_build_object(
            'federation_enabled', true,
            'enable_inbound_federation', COALESCE(inbound_enabled, true),
            'enable_outbound_federation', COALESCE(outbound_enabled, true),
            'federation_auto_accept_follows', true
        );
    END IF;

    -- Merge with individual settings (individual takes precedence)
    RETURN jsonb_build_object(
        'federation_enabled', COALESCE((federation_settings->>'federation_enabled')::boolean, true),
        'enable_inbound_federation', COALESCE(
            inbound_enabled,
            (federation_settings->>'enable_inbound_federation')::boolean,
            true
        ),
        'enable_outbound_federation', COALESCE(
            outbound_enabled,
            (federation_settings->>'enable_outbound_federation')::boolean,
            true
        ),
        'federation_auto_accept_follows', COALESCE(
            (federation_settings->>'federation_auto_accept_follows')::boolean,
            true
        )
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_post_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Placeholder for federation handling
    RETURN NEW;
END;
$$;

GRANT EXECUTE ON FUNCTION
    public.delete_server_with_cleanup(uuid, uuid),
    public.clear_custom_status(uuid),
    public.count_pinned_messages(uuid, uuid),
    public.get_user_notifications(uuid, integer, integer, boolean, character varying[]),
    public.get_public_federation_settings(),
    public.handle_post_federation()
TO PUBLIC, anon, authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
