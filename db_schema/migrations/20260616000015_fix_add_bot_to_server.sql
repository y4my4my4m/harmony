BEGIN;

-- Fix add_bot_to_server: apply permission flags, allow owner to install private bots,
-- and upsert on re-install. Frontend was also passing auth.uid() instead of profile id.
CREATE OR REPLACE FUNCTION public.add_bot_to_server(
    p_bot_id uuid,
    p_server_id uuid,
    p_installed_by uuid,
    p_permissions jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_permission_id uuid;
    v_caller_profile_id uuid;
BEGIN
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();

    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM servers WHERE id = p_server_id AND owner = v_caller_profile_id
    ) AND NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = v_caller_profile_id AND is_admin = true
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Only server owners can add bots';
    END IF;

    IF p_installed_by != v_caller_profile_id THEN
        RAISE EXCEPTION 'Unauthorized: Cannot claim installation by another user';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM bots
        WHERE id = p_bot_id
          AND (is_public = true OR owner_id = v_caller_profile_id)
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Bot is not public';
    END IF;

    INSERT INTO bot_server_permissions (
        bot_id, server_id, installed_by, is_active,
        read_messages, send_messages, manage_messages,
        embed_links, attach_files, mention_everyone,
        add_reactions, manage_channels, kick_members, ban_members
    ) VALUES (
        p_bot_id, p_server_id, p_installed_by, true,
        COALESCE((p_permissions->>'read_messages')::boolean, true),
        COALESCE((p_permissions->>'send_messages')::boolean, true),
        COALESCE((p_permissions->>'manage_messages')::boolean, false),
        COALESCE((p_permissions->>'embed_links')::boolean, true),
        COALESCE((p_permissions->>'attach_files')::boolean, true),
        COALESCE((p_permissions->>'mention_everyone')::boolean, false),
        COALESCE((p_permissions->>'add_reactions')::boolean, true),
        COALESCE((p_permissions->>'manage_channels')::boolean, false),
        COALESCE((p_permissions->>'kick_members')::boolean, false),
        COALESCE((p_permissions->>'ban_members')::boolean, false)
    )
    ON CONFLICT (bot_id, server_id) DO UPDATE SET
        is_active = true,
        installed_by = EXCLUDED.installed_by,
        read_messages = EXCLUDED.read_messages,
        send_messages = EXCLUDED.send_messages,
        manage_messages = EXCLUDED.manage_messages,
        embed_links = EXCLUDED.embed_links,
        attach_files = EXCLUDED.attach_files,
        mention_everyone = EXCLUDED.mention_everyone,
        add_reactions = EXCLUDED.add_reactions,
        manage_channels = EXCLUDED.manage_channels,
        kick_members = EXCLUDED.kick_members,
        ban_members = EXCLUDED.ban_members
    RETURNING id INTO v_permission_id;

    RETURN v_permission_id;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
