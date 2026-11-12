-- Nickname permissions: CHANGE_NICKNAME and MANAGE_NICKNAMES, as Discord's Change Nickname and
-- Manage Nicknames.
--
-- Permission bits. CHANGE_NICKNAME is bit 32 and MANAGE_NICKNAMES bit 33, appended to the bit
-- map after USE_EXTERNAL_SOUNDS; server_roles.permissions and channel_permission_overrides
-- allow/deny are bigint. The RPCs that read and write server profiles check them (later
-- migrations); this one only names the bits.
--
-- Defaults. New servers' @everyone carries CHANGE_NICKNAME, not MANAGE_NICKNAMES
-- (create_default_server_role: 3343872258 -> 7638839554). A server made from a template gets
-- CHANGE_NICKNAME on its @everyone too: a template written before the bit existed cannot say
-- whether the source withheld it, so create_server_from_template adds it and the owner can
-- remove it afterwards. Existing local servers' @everyone gains CHANGE_NICKNAME once, when this
-- migration first extends the bit map, and a server that removes the bit afterwards keeps it
-- removed on a rerun. Remote servers' copies keep the fixed copy mask. Other roles are
-- unchanged.
--
-- Converges by state.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Permission bits 32 and 33
-- ---------------------------------------------------------------------------

-- Existing @everyone roles
-- Runs before permission_bit_names() names the bit, so exactly once per instance.
DO $$
BEGIN
    IF 'CHANGE_NICKNAME' = ANY (public.permission_bit_names()) THEN
        RETURN;
    END IF;
    UPDATE public.server_roles r
       SET permissions = r.permissions | (1::bigint << 32)
      FROM public.servers s
     WHERE s.id = r.server_id
       AND s.is_local_server IS NOT FALSE
       AND r.is_default
       AND (COALESCE(r.permissions, 0) & (1::bigint << 32)) = 0;
END;
$$;

-- Bit order of server_roles.permissions and channel_permission_overrides allow/deny. Index 1
-- is bit 0.
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
        'CONNECT','SPEAK','STREAM','MUTE_MEMBERS','DEAFEN_MEMBERS','MOVE_MEMBERS',
        'USE_SOUNDBOARD','USE_EXTERNAL_SOUNDS','CHANGE_NICKNAME','MANAGE_NICKNAMES']
$$;

-- As 20261027200001, with CHANGE_NICKNAME on a local server's @everyone. A copy keeps the
-- fixed copy mask, 3343872258.
CREATE OR REPLACE FUNCTION public.create_default_server_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    everyone_role_id uuid;
    admin_role_id uuid;
BEGIN
    INSERT INTO server_roles (
        server_id,
        name,
        color,
        position,
        is_default,
        is_admin,
        permissions
    ) VALUES (
        NEW.id,
        'everyone',
        '#99AAB5',
        0,
        true,
        false,
        CASE WHEN NEW.is_local_server IS NOT FALSE THEN 7638839554 ELSE 3343872258 END
    ) RETURNING id INTO everyone_role_id;

    INSERT INTO server_roles (
        server_id,
        name,
        color,
        position,
        is_default,
        is_admin,
        permissions
    ) VALUES (
        NEW.id,
        'Admin',
        '#e74c3c',
        999,
        false,
        true,
        2199023255551
    ) RETURNING id INTO admin_role_id;

    IF NEW.is_local_server AND NEW.owner IS NOT NULL THEN
        INSERT INTO user_roles (user_id, role_id, server_id)
        VALUES (NEW.owner, admin_role_id, NEW.id)
        ON CONFLICT (user_id, role_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- create_server_from_template: as 20261030700001, with CHANGE_NICKNAME (bit 32) added to the
-- template's @everyone mask.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_server_from_template(p_name text, p_template jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_name text;
    v_tpl jsonb;
    v_server uuid;
    v_everyone uuid;
    v_admin uuid;
    v_ids jsonb := '{}'::jsonb;
    v_item jsonb;
    v_id uuid;
    v_rank integer := 0;
    v_part jsonb;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    v_name := public.sanitize_profile_string(p_name, 2147483647, false);
    IF COALESCE(v_name, '') = '' THEN
        RAISE EXCEPTION 'server name must not be blank' USING ERRCODE = '23514';
    END IF;
    IF char_length(v_name) > 100 THEN
        RAISE EXCEPTION 'server name exceeds 100 characters' USING ERRCODE = '23514';
    END IF;

    v_tpl := public.server_template_canonical(p_template);

    INSERT INTO public.servers (name, description, owner, public, allow_cross_server_emojis, rules, category)
    VALUES (v_name,
            v_tpl #>> '{server,description}',
            v_me,
            (v_tpl #>> '{server,public}')::boolean,
            (v_tpl #>> '{server,allow_cross_server_emojis}')::boolean,
            v_tpl #> '{server,rules}',
            v_tpl #>> '{server,category}')
    RETURNING id INTO v_server;

    DELETE FROM public.channels WHERE server_id = v_server;
    DELETE FROM public.channel_categories WHERE server_id = v_server;

    SELECT sr.id INTO v_everyone FROM public.server_roles sr WHERE sr.server_id = v_server AND sr.is_default;
    SELECT sr.id INTO v_admin FROM public.server_roles sr WHERE sr.server_id = v_server AND sr.is_admin;
    IF v_everyone IS NULL OR v_admin IS NULL THEN
        RAISE EXCEPTION 'server creation did not create @everyone and Admin' USING ERRCODE = 'P0002';
    END IF;

    -- Roles ----------------------------------------------------------------
    FOR v_item IN
        SELECT e.value
          FROM jsonb_array_elements(v_tpl -> 'roles') WITH ORDINALITY e
         ORDER BY (e.value ->> 'position')::integer, e.ordinality
    LOOP
        IF (v_item ->> 'is_default')::boolean THEN
            -- CHANGE_NICKNAME is bit 32.
            UPDATE public.server_roles
               SET color = v_item ->> 'color',
                   permissions = (v_item ->> 'permissions')::bigint | (1::bigint << 32),
                   mentionable = (v_item ->> 'mentionable')::boolean,
                   hoist = (v_item ->> 'hoist')::boolean,
                   unicode_emoji = v_item ->> 'unicode_emoji'
             WHERE id = v_everyone;
            v_id := v_everyone;
        ELSIF (v_item ->> 'is_admin')::boolean THEN
            -- ADMINISTRATOR is bit 0.
            UPDATE public.server_roles
               SET color = v_item ->> 'color',
                   permissions = (v_item ->> 'permissions')::bigint | 1,
                   mentionable = (v_item ->> 'mentionable')::boolean,
                   hoist = (v_item ->> 'hoist')::boolean,
                   unicode_emoji = v_item ->> 'unicode_emoji'
             WHERE id = v_admin;
            v_id := v_admin;
        ELSE
            v_rank := v_rank + 1;
            INSERT INTO public.server_roles
                   (server_id, name, color, position, permissions, is_default, is_admin, mentionable, hoist, unicode_emoji)
            VALUES (v_server, v_item ->> 'name', v_item ->> 'color', v_rank, (v_item ->> 'permissions')::bigint,
                    false, false, (v_item ->> 'mentionable')::boolean, (v_item ->> 'hoist')::boolean,
                    v_item ->> 'unicode_emoji')
            RETURNING id INTO v_id;
        END IF;
        v_ids := v_ids || jsonb_build_object(v_item ->> 'ref', v_id);
    END LOOP;

    -- Categories and channels ----------------------------------------------
    FOR v_item IN SELECT e.value FROM jsonb_array_elements(v_tpl -> 'categories') e LOOP
        INSERT INTO public.channel_categories (server_id, name, "order")
        VALUES (v_server, v_item ->> 'name', (v_item ->> 'order')::integer)
        RETURNING id INTO v_id;
        v_ids := v_ids || jsonb_build_object(v_item ->> 'ref', v_id);
    END LOOP;

    FOR v_item IN SELECT e.value FROM jsonb_array_elements(v_tpl -> 'channels') e LOOP
        -- t_channels_name_rule refuses a name it empties; a template from before the rule may
        -- hold one.
        INSERT INTO public.channels (server_id, name, description, type, "order", slowmode_seconds, category)
        VALUES (v_server,
                COALESCE(NULLIF(public.channel_name_normalized(v_item ->> 'name', (v_item ->> 'type')::integer), ''),
                         CASE WHEN (v_item ->> 'type')::integer = 1 THEN 'voice' ELSE 'channel' END),
                v_item ->> 'description', (v_item ->> 'type')::smallint,
                (v_item ->> 'order')::integer, (v_item ->> 'slowmode_seconds')::integer,
                (v_ids ->> (v_item ->> 'category'))::uuid)
        RETURNING id INTO v_id;
        v_ids := v_ids || jsonb_build_object(v_item ->> 'ref', v_id);

        INSERT INTO public.channel_permission_overrides
               (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
        SELECT v_id, 'role', (v_ids ->> (o ->> 'role'))::uuid, NULL, (o ->> 'allow')::bigint, (o ->> 'deny')::bigint
          FROM jsonb_array_elements(v_item -> 'overrides') o;

        -- VIEW_CHANNEL is bit 1.
        IF (v_item ->> 'private')::boolean THEN
            INSERT INTO public.channel_permission_overrides AS cpo
                   (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
            VALUES (v_id, 'role', v_everyone, NULL, 0, 2)
            ON CONFLICT (channel_id, role_id) WHERE user_id IS NULL DO UPDATE
               SET allow_permissions = COALESCE(cpo.allow_permissions, 0) & ~2::bigint,
                   deny_permissions = COALESCE(cpo.deny_permissions, 0) | 2;
        END IF;
    END LOOP;

    -- Settings -------------------------------------------------------------
    v_part := v_tpl -> 'settings';
    IF jsonb_typeof(v_part) = 'object' THEN
        INSERT INTO public.server_settings AS ss
               (server_id, default_role_id, invite_permissions, default_message_notifications,
                system_channel_id, newcomer_alerts, system_messages_enabled)
        VALUES (v_server,
                (v_ids ->> (v_part ->> 'default_role'))::uuid,
                jsonb_set(v_part -> 'invite_permissions', '{allowed_roles}',
                          (SELECT COALESCE(jsonb_agg(v_ids -> (x #>> '{}')), '[]'::jsonb)
                             FROM jsonb_array_elements(v_part #> '{invite_permissions,allowed_roles}') x)),
                v_part ->> 'default_message_notifications',
                (v_ids ->> (v_part ->> 'system_channel'))::uuid,
                (v_part ->> 'newcomer_alerts')::boolean,
                (v_part ->> 'system_messages_enabled')::boolean)
        ON CONFLICT (server_id) DO UPDATE
           SET default_role_id = EXCLUDED.default_role_id,
               invite_permissions = EXCLUDED.invite_permissions,
               default_message_notifications = EXCLUDED.default_message_notifications,
               system_channel_id = EXCLUDED.system_channel_id,
               newcomer_alerts = EXCLUDED.newcomer_alerts,
               system_messages_enabled = EXCLUDED.system_messages_enabled;
    END IF;

    -- Welcome screen -------------------------------------------------------
    v_part := v_tpl -> 'welcome';
    IF jsonb_typeof(v_part) = 'object' THEN
        PERFORM public.set_server_welcome(v_server, (v_part ->> 'enabled')::boolean, v_part ->> 'message',
                                          v_part -> 'rules', (v_part ->> 'require_acceptance')::boolean);
    END IF;

    -- AutoMod --------------------------------------------------------------
    v_part := v_tpl -> 'automod';
    IF jsonb_typeof(v_part) = 'object' THEN
        DELETE FROM public.server_automod_rules WHERE server_id = v_server;
        PERFORM public.update_server_automod_settings(v_server,
            jsonb_build_object('enabled', v_part -> 'enabled',
                               'exempt_bots', v_part -> 'exempt_bots',
                               'alert_channel_id', v_ids -> (v_part ->> 'alert_channel'))
            || CASE WHEN jsonb_typeof(v_part -> 'raid_settings') = 'object'
                    THEN jsonb_build_object('raid_settings', v_part -> 'raid_settings')
                    ELSE '{}'::jsonb END);
        FOR v_item IN SELECT e.value FROM jsonb_array_elements(v_part -> 'rules') e LOOP
            PERFORM public.upsert_server_automod_rule(v_server, jsonb_build_object(
                'name', v_item -> 'name',
                'rule_type', v_item -> 'rule_type',
                'enabled', v_item -> 'enabled',
                'config', v_item -> 'config',
                'actions', v_item -> 'actions',
                'exempt_role_ids', (SELECT COALESCE(jsonb_agg(v_ids -> (x #>> '{}')), '[]'::jsonb)
                                      FROM jsonb_array_elements(v_item -> 'exempt_roles') x),
                'exempt_channel_ids', (SELECT COALESCE(jsonb_agg(v_ids -> (x #>> '{}')), '[]'::jsonb)
                                         FROM jsonb_array_elements(v_item -> 'exempt_channels') x),
                'position', v_item -> 'position'));
        END LOOP;
    END IF;

    INSERT INTO public.user_servers (server_id, user_id, status)
    VALUES (v_server, v_me, 'accepted')
    ON CONFLICT (user_id, server_id) DO NOTHING;

    RETURN v_server;
END;
$$;

COMMENT ON FUNCTION public.create_server_from_template(text, jsonb) IS
    'Create a server owned by the caller from a harmony.server-template document, in one transaction.';

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.create_server_from_template(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_server_from_template(text, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
