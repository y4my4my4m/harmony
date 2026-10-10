-- Server management for permission holders, bounded by role rank.
--
-- Roles, role assignments, server emojis, server settings, bot installations and channel
-- permission overrides admitted the server owner (and instance admins for some) only, though
-- the client offers them to MANAGE_ROLES, MANAGE_EMOJIS and MANAGE_SERVER holders. The
-- default role refused every update, the owner's included, so @everyone's permissions could
-- not be saved.
--
-- Writes now follow the permission, as Discord's do:
--   server_roles, user_roles       MANAGE_ROLES; only roles ranked below the caller's highest
--                                  role (get_user_highest_role_position), and no permission
--                                  bit the caller lacks. @everyone keeps position 0.
--   emojis (scope 'server')        MANAGE_EMOJIS
--   server_settings                MANAGE_SERVER; default_role_id as for user_roles
--   bot_server_permissions         MANAGE_SERVER; no flag whose permission the caller lacks
--   channel_permission_overrides   MANAGE_ROLES or MANAGE_CHANNELS on the channel; no allowed
--                                  bit the caller lacks there. Instance moderators no longer
--                                  qualify.
-- The server owner and instance admins pass every rank and grant check. A user_roles row must
-- name a role of its own server. Rank and grant checks run in BEFORE triggers on client writes
-- (current_user authenticated), where OLD is visible.
--
-- add_bot_to_server admits MANAGE_SERVER holders under the same flag check.
--
-- Converges by state: other write policies on these tables are dropped, rerunning changes
-- nothing.

BEGIN;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.tablename, p.policyname
          FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND ((p.tablename IN ('server_roles', 'user_roles', 'server_settings',
                                 'bot_server_permissions', 'channel_permission_overrides')
                 AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL'))
             OR (p.tablename = 'emojis' AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE')
                 AND p.policyname LIKE '%server%'))
           AND p.policyname NOT IN (
               'server_roles_insert_manager', 'server_roles_update_manager', 'server_roles_delete_manager',
               'user_roles_insert_manager', 'user_roles_delete_manager',
               'emojis_insert_server_manager', 'emojis_update_server_manager', 'emojis_delete_server_manager',
               'server_settings_insert_manager', 'server_settings_update_manager', 'server_settings_delete_manager',
               'bot_server_permissions_insert_manager', 'bot_server_permissions_update_manager',
               'bot_server_permissions_delete_manager',
               'channel_permission_overrides_insert_manager', 'channel_permission_overrides_update_manager',
               'channel_permission_overrides_delete_manager')
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
        RAISE NOTICE 'dropped policy % on %', r.policyname, r.tablename;
    END LOOP;
END;
$$;

-- Owner, instance admin, or holder of p_permission (on p_channel_id when given).
CREATE OR REPLACE FUNCTION pg_temp.manager_check(p_server text, p_permission text, p_channel text DEFAULT 'NULL')
RETURNS text LANGUAGE sql IMMUTABLE AS $f$
    SELECT format($c$(EXISTS (SELECT 1 FROM public.servers s
                              WHERE s.id = %1$s
                                AND s.owner = (SELECT public.get_current_profile_id()))
            OR (SELECT public.is_current_user_admin())
            OR public.has_permission((SELECT public.get_current_profile_id()), %1$s, %2$L, %3$s))$c$,
                  p_server, p_permission, p_channel)
$f$;

DO $$
DECLARE
    v_roles text := pg_temp.manager_check('server_roles.server_id', 'MANAGE_ROLES');
    v_user_roles text := pg_temp.manager_check('user_roles.server_id', 'MANAGE_ROLES');
    v_emojis text := pg_temp.manager_check('emojis.server_id', 'MANAGE_EMOJIS');
    v_settings text := pg_temp.manager_check('server_settings.server_id', 'MANAGE_SERVER');
    v_bots text := pg_temp.manager_check('bot_server_permissions.server_id', 'MANAGE_SERVER');
    v_override_server text := '(SELECT c.server_id FROM public.channels c WHERE c.id = channel_permission_overrides.channel_id)';
    v_overrides text;
BEGIN
    v_overrides := format('(%s OR %s)',
        pg_temp.manager_check(v_override_server, 'MANAGE_ROLES', 'channel_permission_overrides.channel_id'),
        pg_temp.manager_check(v_override_server, 'MANAGE_CHANNELS', 'channel_permission_overrides.channel_id'));

    DROP POLICY IF EXISTS server_roles_insert_manager ON public.server_roles;
    EXECUTE format('CREATE POLICY server_roles_insert_manager ON public.server_roles FOR INSERT TO authenticated WITH CHECK (%s)', v_roles);
    DROP POLICY IF EXISTS server_roles_update_manager ON public.server_roles;
    EXECUTE format('CREATE POLICY server_roles_update_manager ON public.server_roles FOR UPDATE TO authenticated USING (%1$s) WITH CHECK (%1$s)', v_roles);
    DROP POLICY IF EXISTS server_roles_delete_manager ON public.server_roles;
    EXECUTE format('CREATE POLICY server_roles_delete_manager ON public.server_roles FOR DELETE TO authenticated USING (NOT is_default AND %s)', v_roles);

    DROP POLICY IF EXISTS user_roles_insert_manager ON public.user_roles;
    EXECUTE format('CREATE POLICY user_roles_insert_manager ON public.user_roles FOR INSERT TO authenticated WITH CHECK (%s)', v_user_roles);
    DROP POLICY IF EXISTS user_roles_delete_manager ON public.user_roles;
    EXECUTE format('CREATE POLICY user_roles_delete_manager ON public.user_roles FOR DELETE TO authenticated USING (%s)', v_user_roles);

    DROP POLICY IF EXISTS emojis_insert_server_manager ON public.emojis;
    EXECUTE format('CREATE POLICY emojis_insert_server_manager ON public.emojis FOR INSERT TO authenticated WITH CHECK (scope = ''server'' AND server_id IS NOT NULL AND %s)', v_emojis);
    DROP POLICY IF EXISTS emojis_update_server_manager ON public.emojis;
    EXECUTE format('CREATE POLICY emojis_update_server_manager ON public.emojis FOR UPDATE TO authenticated USING (scope = ''server'' AND server_id IS NOT NULL AND %1$s) WITH CHECK (scope = ''server'' AND server_id IS NOT NULL AND %1$s)', v_emojis);
    DROP POLICY IF EXISTS emojis_delete_server_manager ON public.emojis;
    EXECUTE format('CREATE POLICY emojis_delete_server_manager ON public.emojis FOR DELETE TO authenticated USING (scope = ''server'' AND server_id IS NOT NULL AND %s)', v_emojis);

    DROP POLICY IF EXISTS server_settings_insert_manager ON public.server_settings;
    EXECUTE format('CREATE POLICY server_settings_insert_manager ON public.server_settings FOR INSERT TO authenticated WITH CHECK (%s)', v_settings);
    DROP POLICY IF EXISTS server_settings_update_manager ON public.server_settings;
    EXECUTE format('CREATE POLICY server_settings_update_manager ON public.server_settings FOR UPDATE TO authenticated USING (%1$s) WITH CHECK (%1$s)', v_settings);
    DROP POLICY IF EXISTS server_settings_delete_manager ON public.server_settings;
    EXECUTE format('CREATE POLICY server_settings_delete_manager ON public.server_settings FOR DELETE TO authenticated USING (%s)', v_settings);

    DROP POLICY IF EXISTS bot_server_permissions_insert_manager ON public.bot_server_permissions;
    EXECUTE format('CREATE POLICY bot_server_permissions_insert_manager ON public.bot_server_permissions FOR INSERT TO authenticated WITH CHECK (%s)', v_bots);
    DROP POLICY IF EXISTS bot_server_permissions_update_manager ON public.bot_server_permissions;
    EXECUTE format('CREATE POLICY bot_server_permissions_update_manager ON public.bot_server_permissions FOR UPDATE TO authenticated USING (%1$s) WITH CHECK (%1$s)', v_bots);
    DROP POLICY IF EXISTS bot_server_permissions_delete_manager ON public.bot_server_permissions;
    EXECUTE format('CREATE POLICY bot_server_permissions_delete_manager ON public.bot_server_permissions FOR DELETE TO authenticated USING (%s)', v_bots);

    DROP POLICY IF EXISTS channel_permission_overrides_insert_manager ON public.channel_permission_overrides;
    EXECUTE format('CREATE POLICY channel_permission_overrides_insert_manager ON public.channel_permission_overrides FOR INSERT TO authenticated WITH CHECK %s', v_overrides);
    DROP POLICY IF EXISTS channel_permission_overrides_update_manager ON public.channel_permission_overrides;
    EXECUTE format('CREATE POLICY channel_permission_overrides_update_manager ON public.channel_permission_overrides FOR UPDATE TO authenticated USING %1$s WITH CHECK %1$s', v_overrides);
    DROP POLICY IF EXISTS channel_permission_overrides_delete_manager ON public.channel_permission_overrides;
    EXECUTE format('CREATE POLICY channel_permission_overrides_delete_manager ON public.channel_permission_overrides FOR DELETE TO authenticated USING %s', v_overrides);
END;
$$;

-- ---------------------------------------------------------------------------
-- Rank and grant checks
-- ---------------------------------------------------------------------------

-- Bit order of server_roles.permissions and channel_permission_overrides allow/deny, as in
-- get_user_permissions. Index 1 is bit 0.
CREATE OR REPLACE FUNCTION public.permission_bit_names()
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT ARRAY[
        'ADMINISTRATOR','VIEW_CHANNEL','MANAGE_CHANNELS','MANAGE_ROLES',
        'MANAGE_EMOJIS','VIEW_AUDIT_LOG','MANAGE_WEBHOOKS','MANAGE_SERVER',
        'CREATE_INVITE','KICK_MEMBERS','BAN_MEMBERS','TIMEOUT_MEMBERS',
        'SEND_MESSAGES','SEND_MESSAGES_IN_THREADS','CREATE_PUBLIC_THREADS','CREATE_PRIVATE_THREADS',
        'EMBED_LINKS','ATTACH_FILES','ADD_REACTIONS','USE_EXTERNAL_EMOJIS',
        'MENTION_EVERYONE','MANAGE_MESSAGES','READ_MESSAGE_HISTORY','PIN_MESSAGES',
        'CONNECT','SPEAK','STREAM','MUTE_MEMBERS','DEAFEN_MEMBERS','MOVE_MEMBERS']
$$;

-- Raises 42501 when p_bits names a permission p_permissions (get_user_permissions output) lacks.
-- ADMINISTRATOR grants every bit.
CREATE OR REPLACE FUNCTION public.assert_grantable_bits(p_permissions jsonb, p_bits bigint)
RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_names text[] := public.permission_bit_names();
    i int;
BEGIN
    IF p_bits IS NULL OR p_bits = 0 OR COALESCE((p_permissions->>'ADMINISTRATOR')::boolean, false) THEN
        RETURN;
    END IF;
    FOR i IN 1..array_length(v_names, 1) LOOP
        IF (p_bits & (1::bigint << (i - 1))) <> 0
           AND NOT COALESCE((p_permissions->>v_names[i])::boolean, false) THEN
            RAISE EXCEPTION 'Cannot grant % without holding it', v_names[i] USING ERRCODE = '42501';
        END IF;
    END LOOP;
END;
$$;

-- True when the caller is the server's owner or an instance admin: rank and grant checks pass.
CREATE OR REPLACE FUNCTION public.caller_outranks_all(p_server_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    SELECT public.is_current_user_admin()
        OR EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.owner = public.get_current_profile_id())
$$;

CREATE OR REPLACE FUNCTION public.guard_server_role_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid;
    v_server uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.server_id ELSE NEW.server_id END;
    v_rank integer;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1
       OR public.caller_outranks_all(v_server) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    v_me := public.get_current_profile_id();
    v_rank := public.get_user_highest_role_position(v_me, v_server);

    IF TG_OP = 'DELETE' THEN
        IF OLD.position >= v_rank THEN
            RAISE EXCEPTION 'Cannot delete a role ranked at or above your highest role' USING ERRCODE = '42501';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.server_id IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.server_id ELSE NEW.server_id END) THEN
        RAISE EXCEPTION 'a role stays in its server' USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.is_default OR NEW.is_admin THEN
            RAISE EXCEPTION 'Only the server owner creates protected roles' USING ERRCODE = '42501';
        END IF;
        IF NEW.position >= v_rank THEN
            RAISE EXCEPTION 'A new role must rank below your highest role' USING ERRCODE = '42501';
        END IF;
        PERFORM public.assert_grantable_bits(public.get_user_permissions(v_me, v_server), NEW.permissions);
        RETURN NEW;
    END IF;

    IF NEW.is_admin IS DISTINCT FROM OLD.is_admin OR NEW.is_default IS DISTINCT FROM OLD.is_default THEN
        RAISE EXCEPTION 'Only the server owner changes protected role flags' USING ERRCODE = '42501';
    END IF;
    IF OLD.is_default THEN
        IF NEW.position IS DISTINCT FROM OLD.position THEN
            RAISE EXCEPTION '@everyone keeps its position' USING ERRCODE = '42501';
        END IF;
    ELSIF OLD.position >= v_rank OR NEW.position >= v_rank THEN
        RAISE EXCEPTION 'Cannot edit or move a role to rank at or above your highest role' USING ERRCODE = '42501';
    END IF;
    PERFORM public.assert_grantable_bits(public.get_user_permissions(v_me, v_server),
                                         COALESCE(NEW.permissions, 0) & ~COALESCE(OLD.permissions, 0));
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_server_roles_hierarchy_guard ON public.server_roles;
CREATE TRIGGER a_server_roles_hierarchy_guard
    BEFORE INSERT OR UPDATE OR DELETE ON public.server_roles
    FOR EACH ROW EXECUTE FUNCTION public.guard_server_role_hierarchy();

CREATE OR REPLACE FUNCTION public.guard_user_role_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.user_roles := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    v_role_server uuid;
    v_role_position integer;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN v_row;
    END IF;

    SELECT sr.server_id, sr.position INTO v_role_server, v_role_position
      FROM public.server_roles sr WHERE sr.id = v_row.role_id;

    IF TG_OP <> 'DELETE' AND v_role_server IS DISTINCT FROM v_row.server_id THEN
        RAISE EXCEPTION 'A role is assigned in its own server' USING ERRCODE = '42501';
    END IF;

    IF public.caller_outranks_all(v_row.server_id) THEN
        RETURN v_row;
    END IF;

    IF v_role_position IS NOT NULL
       AND v_role_position >= public.get_user_highest_role_position(public.get_current_profile_id(), v_row.server_id) THEN
        RAISE EXCEPTION 'Cannot assign or remove a role ranked at or above your highest role' USING ERRCODE = '42501';
    END IF;
    RETURN v_row;
END;
$$;

DROP TRIGGER IF EXISTS a_user_roles_hierarchy_guard ON public.user_roles;
CREATE TRIGGER a_user_roles_hierarchy_guard
    BEFORE INSERT OR UPDATE OR DELETE ON public.user_roles
    FOR EACH ROW EXECUTE FUNCTION public.guard_user_role_hierarchy();

-- default_role_id is assigned to every member who joins.
CREATE OR REPLACE FUNCTION public.guard_server_settings_default_role()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role_server uuid;
    v_role_position integer;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1
       OR NEW.default_role_id IS NULL
       OR (TG_OP = 'UPDATE' AND NEW.default_role_id IS NOT DISTINCT FROM OLD.default_role_id) THEN
        RETURN NEW;
    END IF;

    SELECT sr.server_id, sr.position INTO v_role_server, v_role_position
      FROM public.server_roles sr WHERE sr.id = NEW.default_role_id;
    IF v_role_server IS DISTINCT FROM NEW.server_id THEN
        RAISE EXCEPTION 'The default role belongs to this server' USING ERRCODE = '42501';
    END IF;

    IF public.caller_outranks_all(NEW.server_id) THEN
        RETURN NEW;
    END IF;
    IF NOT public.has_permission(public.get_current_profile_id(), NEW.server_id, 'MANAGE_ROLES')
       OR v_role_position >= public.get_user_highest_role_position(public.get_current_profile_id(), NEW.server_id) THEN
        RAISE EXCEPTION 'Cannot make a role you cannot assign the default role' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_server_settings_default_role_guard ON public.server_settings;
CREATE TRIGGER a_server_settings_default_role_guard
    BEFORE INSERT OR UPDATE ON public.server_settings
    FOR EACH ROW EXECUTE FUNCTION public.guard_server_settings_default_role();

-- bot_server_permissions flag -> the server permission the installer must hold to enable it.
CREATE OR REPLACE FUNCTION public.bot_flag_permission(p_flag text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE p_flag
        WHEN 'read_messages' THEN 'VIEW_CHANNEL'
        WHEN 'view_channels' THEN 'VIEW_CHANNEL'
        WHEN 'send_messages' THEN 'SEND_MESSAGES'
        WHEN 'send_tts_messages' THEN 'SEND_MESSAGES'
        WHEN 'manage_messages' THEN 'MANAGE_MESSAGES'
        WHEN 'embed_links' THEN 'EMBED_LINKS'
        WHEN 'attach_files' THEN 'ATTACH_FILES'
        WHEN 'read_message_history' THEN 'READ_MESSAGE_HISTORY'
        WHEN 'mention_everyone' THEN 'MENTION_EVERYONE'
        WHEN 'use_external_emojis' THEN 'USE_EXTERNAL_EMOJIS'
        WHEN 'add_reactions' THEN 'ADD_REACTIONS'
        WHEN 'manage_channels' THEN 'MANAGE_CHANNELS'
        WHEN 'manage_webhooks' THEN 'MANAGE_WEBHOOKS'
        WHEN 'create_instant_invite' THEN 'CREATE_INVITE'
        WHEN 'connect_voice' THEN 'CONNECT'
        WHEN 'speak' THEN 'SPEAK'
        WHEN 'mute_members' THEN 'MUTE_MEMBERS'
        WHEN 'deafen_members' THEN 'DEAFEN_MEMBERS'
        WHEN 'move_members' THEN 'MOVE_MEMBERS'
        WHEN 'manage_nicknames' THEN 'MANAGE_ROLES'
        WHEN 'manage_roles' THEN 'MANAGE_ROLES'
        WHEN 'kick_members' THEN 'KICK_MEMBERS'
        WHEN 'ban_members' THEN 'BAN_MEMBERS'
    END
$$;

-- Raises 42501 for a flag true in p_new and not in p_old whose permission the caller lacks.
CREATE OR REPLACE FUNCTION public.assert_grantable_bot_flags(p_server_id uuid, p_new jsonb, p_old jsonb)
RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_perms jsonb;
    v_flag text;
    v_permission text;
BEGIN
    IF public.caller_outranks_all(p_server_id) THEN
        RETURN;
    END IF;
    v_perms := public.get_user_permissions(public.get_current_profile_id(), p_server_id);
    IF COALESCE((v_perms->>'ADMINISTRATOR')::boolean, false) THEN
        RETURN;
    END IF;
    FOR v_flag IN SELECT key FROM jsonb_each(p_new) WHERE jsonb_typeof(value) = 'boolean' AND value = 'true'::jsonb LOOP
        CONTINUE WHEN COALESCE((p_old->>v_flag)::boolean, false);
        v_permission := public.bot_flag_permission(v_flag);
        CONTINUE WHEN v_permission IS NULL;
        IF NOT COALESCE((v_perms->>v_permission)::boolean, false) THEN
            RAISE EXCEPTION 'Cannot give a bot % without holding %', v_flag, v_permission USING ERRCODE = '42501';
        END IF;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_bot_permission_grants()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.server_id IS DISTINCT FROM OLD.server_id OR NEW.bot_id IS DISTINCT FROM OLD.bot_id) THEN
        RAISE EXCEPTION 'an installation stays with its bot and server' USING ERRCODE = '42501';
    END IF;
    PERFORM public.assert_grantable_bot_flags(NEW.server_id, to_jsonb(NEW),
                                              CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_bot_server_permissions_grant_guard ON public.bot_server_permissions;
CREATE TRIGGER a_bot_server_permissions_grant_guard
    BEFORE INSERT OR UPDATE ON public.bot_server_permissions
    FOR EACH ROW EXECUTE FUNCTION public.guard_bot_permission_grants();

CREATE OR REPLACE FUNCTION public.guard_override_grants()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.channel_id IS DISTINCT FROM OLD.channel_id THEN
        RAISE EXCEPTION 'an override stays on its channel' USING ERRCODE = '42501';
    END IF;
    SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = NEW.channel_id;
    IF public.caller_outranks_all(v_server) THEN
        RETURN NEW;
    END IF;
    PERFORM public.assert_grantable_bits(
        public.get_user_permissions(public.get_current_profile_id(), v_server, NEW.channel_id),
        COALESCE(NEW.allow_permissions, 0)
          & ~(CASE WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.allow_permissions, 0) ELSE 0 END));
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_channel_overrides_grant_guard ON public.channel_permission_overrides;
CREATE TRIGGER a_channel_overrides_grant_guard
    BEFORE INSERT OR UPDATE ON public.channel_permission_overrides
    FOR EACH ROW EXECUTE FUNCTION public.guard_override_grants();

-- ---------------------------------------------------------------------------
-- add_bot_to_server: MANAGE_SERVER, flags the caller holds
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.add_bot_to_server(p_bot_id uuid, p_server_id uuid, p_installed_by uuid, p_permissions jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_permission_id uuid;
    v_caller_profile_id uuid := public.get_current_profile_id();
    v_flags jsonb;
BEGIN
    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    IF NOT public.caller_outranks_all(p_server_id)
       AND NOT public.has_permission(v_caller_profile_id, p_server_id, 'MANAGE_SERVER') THEN
        RAISE EXCEPTION 'Unauthorized: MANAGE_SERVER required to add bots' USING ERRCODE = '42501';
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

    v_flags := jsonb_build_object(
        'read_messages', COALESCE((p_permissions->>'read_messages')::boolean, true),
        'send_messages', COALESCE((p_permissions->>'send_messages')::boolean, true),
        'manage_messages', COALESCE((p_permissions->>'manage_messages')::boolean, false),
        'embed_links', COALESCE((p_permissions->>'embed_links')::boolean, true),
        'attach_files', COALESCE((p_permissions->>'attach_files')::boolean, true),
        'mention_everyone', COALESCE((p_permissions->>'mention_everyone')::boolean, false),
        'add_reactions', COALESCE((p_permissions->>'add_reactions')::boolean, true),
        'manage_channels', COALESCE((p_permissions->>'manage_channels')::boolean, false),
        'kick_members', COALESCE((p_permissions->>'kick_members')::boolean, false),
        'ban_members', COALESCE((p_permissions->>'ban_members')::boolean, false));
    PERFORM public.assert_grantable_bot_flags(p_server_id, v_flags, '{}'::jsonb);

    INSERT INTO bot_server_permissions (
        bot_id, server_id, installed_by, is_active,
        read_messages, send_messages, manage_messages,
        embed_links, attach_files, mention_everyone,
        add_reactions, manage_channels, kick_members, ban_members
    ) VALUES (
        p_bot_id, p_server_id, p_installed_by, true,
        (v_flags->>'read_messages')::boolean,
        (v_flags->>'send_messages')::boolean,
        (v_flags->>'manage_messages')::boolean,
        (v_flags->>'embed_links')::boolean,
        (v_flags->>'attach_files')::boolean,
        (v_flags->>'mention_everyone')::boolean,
        (v_flags->>'add_reactions')::boolean,
        (v_flags->>'manage_channels')::boolean,
        (v_flags->>'kick_members')::boolean,
        (v_flags->>'ban_members')::boolean
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

-- Called from the guard triggers, which run as the client role, and add_bot_to_server.
REVOKE ALL ON FUNCTION public.permission_bit_names() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assert_grantable_bits(jsonb, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.caller_outranks_all(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bot_flag_permission(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assert_grantable_bot_flags(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.permission_bit_names() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_grantable_bits(jsonb, bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.caller_outranks_all(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bot_flag_permission(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_grantable_bot_flags(uuid, jsonb, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_server_role_hierarchy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_user_role_hierarchy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_server_settings_default_role() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_bot_permission_grants() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_override_grants() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_bot_to_server(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_bot_to_server(uuid, uuid, uuid, jsonb) TO authenticated, service_role;

COMMIT;
