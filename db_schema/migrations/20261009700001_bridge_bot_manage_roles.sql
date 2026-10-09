-- Discord bridge bots hold manage_roles on their server.
--
-- discord_bridge_provision_bot installed bridge bots with read_messages, send_messages and
-- manage_channels. bot-gateway refuses every role write without manage_roles (403 "Missing
-- permission: manage_roles"), so /bridge sync-perms, clone-server's role option and Discord role
-- events never created or updated a Harmony role. Production: all four bridges, 2026-10-09.
--
-- The gateway still bounds a bridge bot's role writes: positions below the installer's highest
-- role and below every administrator role, and permission bits within @everyone's plus the
-- install's flags.
--
-- New bridge bots are installed with manage_roles; installs of existing bridge bots gain it.
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- As 20261008900001, plus manage_roles on the install.
CREATE OR REPLACE FUNCTION public.discord_bridge_provision_bot(p_bridge_id uuid, p_owner uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_server uuid;
    v_bot uuid;
BEGIN
    SELECT server_id INTO v_server FROM public.discord_bridges WHERE id = p_bridge_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Discord bridge not found' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO public.bots (username, display_name, bio, avatar_url, bot_type, is_public, owner_id)
    VALUES ('discord-bridge-' || encode(extensions.gen_random_bytes(6), 'hex'),
            'Discord Bridge',
            'Relays messages between this server and Discord.',
            '/discord-bridge-bot.webp',
            'bridge',
            false,
            p_owner)
    RETURNING id INTO v_bot;

    INSERT INTO public.bot_server_permissions
        (bot_id, server_id, installed_by, is_active, read_messages, send_messages, manage_channels,
         manage_roles)
    VALUES (v_bot, v_server, p_owner, true, true, true, true, true);

    UPDATE public.discord_bridges SET bot_id = v_bot WHERE id = p_bridge_id;
    RETURN v_bot;
END;
$$;

-- As 20261008300001: reached only from definers, which run as the owner.
REVOKE ALL ON FUNCTION public.discord_bridge_provision_bot(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

UPDATE public.bot_server_permissions p
   SET manage_roles = true
  FROM public.discord_bridges b
 WHERE p.bot_id = b.bot_id
   AND p.server_id = b.server_id
   AND p.manage_roles IS DISTINCT FROM true;

COMMIT;
