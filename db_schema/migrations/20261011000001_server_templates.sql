-- Server templates: a server's structure as a file, and a new server built from one.
--
-- A template is structure only: no messages, members, role assignments, emojis, icon, banner,
-- invites, bans, bots, bridges, encryption settings or federation state. Identifiers are
-- symbolic refs local to the document; it carries no uuid, profile id or secret.
--
--   {"format": "harmony.server-template", "version": 1, "exported_at": "...Z",
--    "server":     {name, description, public, allow_cross_server_emojis, rules, category},
--    "roles":      [{ref, name, color, position, permissions, is_default, is_admin,
--                    mentionable, hoist, unicode_emoji}],
--    "categories": [{ref, name, order}],
--    "channels":   [{ref, name, description, type, order, slowmode_seconds, category,
--                    private, overrides: [{role, allow, deny}]}],
--    "settings":   {default_role, system_channel, system_messages_enabled, newcomer_alerts,
--                   default_message_notifications, invite_permissions} | null,
--    "welcome":    {enabled, message, rules, require_acceptance} | null,
--    "automod":    {enabled, alert_channel, exempt_bots, raid_settings,
--                   rules: [{name, rule_type, enabled, config, actions, exempt_roles,
--                            exempt_channels, position}]} | null}
--
-- Permission masks (permissions, allow, deny) are decimal strings of the bits named by
-- permission_bit_names(); bits above them are dropped on export and refused on import. Refs
-- are unique across roles, categories and channels. category, overrides[].role,
-- default_role, system_channel, allowed_roles, alert_channel and the exempt lists name refs.
-- private: @everyone's channel override denies VIEW_CHANNEL (bit 1) and does not allow it,
-- as create_channel writes it. Overrides target roles only; member overrides are not
-- exported. Keys a section does not list are ignored.
--
-- export_server_template(server)     owner, instance admin, or an accepted member holding
--                                     MANAGE_SERVER, of a local server. Channels of type 0
--                                     and 1. is_admin marks the highest is_admin role only.
--
-- create_server_from_template(name, template)
--                                     any authenticated caller; servers INSERT carries no
--                                     per-user limit. server_template_canonical() validates
--                                     the document first: limits as the schema's (25
--                                     categories, check_category_limit; 100 channels,
--                                     check_channel_limit; 25 server rules; 20 welcome
--                                     rules; 25 AutoMod rules) and 250 roles, Discord's cap.
--                                     The servers INSERT runs the creation triggers (@everyone,
--                                     Admin assigned to the owner, default categories and
--                                     channels, AutoMod preset). The default categories and
--                                     channels are deleted. @everyone and Admin are updated in
--                                     place from the template's is_default and is_admin roles,
--                                     names kept (prevent_protected_role_modification); Admin
--                                     keeps ADMINISTRATOR. Other roles take positions 1..n in
--                                     template order, below Admin. With an automod section the
--                                     preset rules are replaced through
--                                     update_server_automod_settings and
--                                     upsert_server_automod_rule, which validate and compile;
--                                     without one the preset stays. The welcome screen goes
--                                     through set_server_welcome. The owner's membership is
--                                     inserted last: trigger_server_owner_membership fires for
--                                     client roles only. One statement: a raise leaves nothing.
--
-- Writes here run as the function owner, so the client guard triggers (role rank, protected
-- flags, default role, override grants) do not run. Their invariants hold by construction:
-- the caller owns the new server, protected flags are never set on inserted roles, and every
-- role, channel and category id comes from rows this call created in that server.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Field readers. Each raises 22023 TEMPLATE_INVALID naming p_path.
-- ---------------------------------------------------------------------------

-- p_type 'object' or 'array'. Absent or null gives NULL; an array holds at most p_max items.
CREATE OR REPLACE FUNCTION public.server_template_json(p_value jsonb, p_path text, p_type text, p_max integer)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p_value) <> p_type THEN
        RAISE EXCEPTION 'TEMPLATE_INVALID: % is an %', p_path, p_type USING ERRCODE = '22023';
    END IF;
    IF p_type = 'array' AND p_max IS NOT NULL AND jsonb_array_length(p_value) > p_max THEN
        RAISE EXCEPTION 'TEMPLATE_INVALID: % holds at most % items', p_path, p_max USING ERRCODE = '22023';
    END IF;
    RETURN p_value;
END;
$$;

-- Absent or null gives NULL, or raises when p_required. p_required also refuses a value that
-- sanitize_profile_string empties.
CREATE OR REPLACE FUNCTION public.server_template_text(p_value jsonb, p_path text, p_max integer, p_required boolean)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v text;
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
        IF p_required THEN
            RAISE EXCEPTION 'TEMPLATE_INVALID: % is required', p_path USING ERRCODE = '22023';
        END IF;
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p_value) <> 'string' THEN
        RAISE EXCEPTION 'TEMPLATE_INVALID: % is a string', p_path USING ERRCODE = '22023';
    END IF;
    v := p_value #>> '{}';
    IF char_length(v) > p_max THEN
        RAISE EXCEPTION 'TEMPLATE_INVALID: % is at most % characters', p_path, p_max USING ERRCODE = '22023';
    END IF;
    IF p_required AND public.sanitize_profile_string(v, p_max, false) = '' THEN
        RAISE EXCEPTION 'TEMPLATE_INVALID: % must not be blank', p_path USING ERRCODE = '22023';
    END IF;
    RETURN v;
END;
$$;

-- A JSON number without fraction in p_min..p_max; absent or null gives p_default. With
-- p_strict false any other value gives p_default, and numeric strings are read.
CREATE OR REPLACE FUNCTION public.server_template_int(
    p_value jsonb, p_path text, p_default integer, p_min integer, p_max integer,
    p_strict boolean DEFAULT true)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v numeric;
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
        RETURN p_default;
    END IF;
    IF jsonb_typeof(p_value) = 'number'
       OR (NOT p_strict AND jsonb_typeof(p_value) = 'string' AND (p_value #>> '{}') ~ '^\s*-?[0-9]{1,10}\s*$') THEN
        v := (p_value #>> '{}')::numeric;
        IF v = trunc(v) AND v BETWEEN p_min AND p_max THEN
            RETURN v::integer;
        END IF;
    END IF;
    IF NOT p_strict THEN
        RETURN p_default;
    END IF;
    RAISE EXCEPTION 'TEMPLATE_INVALID: % is an integer from % to %', p_path, p_min, p_max USING ERRCODE = '22023';
END;
$$;

-- Absent or null gives p_default.
CREATE OR REPLACE FUNCTION public.server_template_bool(p_value jsonb, p_path text, p_default boolean)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
        RETURN p_default;
    END IF;
    IF jsonb_typeof(p_value) <> 'boolean' THEN
        RAISE EXCEPTION 'TEMPLATE_INVALID: % is true or false', p_path USING ERRCODE = '22023';
    END IF;
    RETURN (p_value #>> '{}')::boolean;
END;
$$;

-- A decimal string or JSON integer using only the bits permission_bit_names() names.
-- Absent or null is 0.
CREATE OR REPLACE FUNCTION public.server_template_bits(p_value jsonb, p_path text)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bits integer := array_length(public.permission_bit_names(), 1);
    v numeric;
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
        RETURN 0;
    END IF;
    IF jsonb_typeof(p_value) = 'number'
       OR (jsonb_typeof(p_value) = 'string' AND (p_value #>> '{}') ~ '^[0-9]{1,19}$') THEN
        v := (p_value #>> '{}')::numeric;
        IF v = trunc(v) AND v BETWEEN 0 AND ((1::bigint << v_bits) - 1) THEN
            RETURN v::bigint;
        END IF;
    END IF;
    RAISE EXCEPTION 'TEMPLATE_INVALID: % is a permission mask of bits 0 to %', p_path, v_bits - 1
        USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.server_template_ref(p_value jsonb, p_path text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' OR (p_value #>> '{}') !~ '^[A-Za-z0-9_.-]{1,40}$' THEN
        RAISE EXCEPTION 'TEMPLATE_INVALID: % is a ref of 1 to 40 letters, digits, ".", "_" or "-"', p_path
            USING ERRCODE = '22023';
    END IF;
    RETURN p_value #>> '{}';
END;
$$;

-- ---------------------------------------------------------------------------
-- Validation
-- ---------------------------------------------------------------------------

-- Validates a template and returns it with every field present, defaults applied and refs
-- resolved to their kind. Raises 22023: TEMPLATE_INVALID for a malformed document,
-- TEMPLATE_VERSION for another version. Welcome rules, AutoMod config, actions and
-- raid_settings are checked by their writers at creation.
CREATE OR REPLACE FUNCTION public.server_template_canonical(p_template jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_kinds jsonb := '{}'::jsonb;
    v_types jsonb := '{}'::jsonb;
    v_admin_ref text;
    v_default_ref text;
    v_server jsonb;
    v_item jsonb;
    v_sub jsonb;
    v_idx integer;
    v_sidx integer;
    v_path text;
    v_ref text;
    v_target text;
    v_color text;
    v_default boolean;
    v_admin boolean;
    v_seen jsonb;
    v_overrides jsonb;
    v_rules jsonb := '[]'::jsonb;
    v_roles jsonb := '[]'::jsonb;
    v_categories jsonb := '[]'::jsonb;
    v_channels jsonb := '[]'::jsonb;
    v_refs jsonb;
    v_exempt jsonb;
    v_settings jsonb;
    v_invite jsonb;
    v_text text;
    v_welcome jsonb;
    v_automod jsonb;
    v_automod_rules jsonb := '[]'::jsonb;
BEGIN
    IF p_template IS NULL OR jsonb_typeof(p_template) <> 'object' THEN
        RAISE EXCEPTION 'TEMPLATE_INVALID: a template is a JSON object' USING ERRCODE = '22023';
    END IF;
    IF octet_length(p_template::text) > 2000000 THEN
        RAISE EXCEPTION 'TEMPLATE_INVALID: a template is at most 2 MB' USING ERRCODE = '22023';
    END IF;
    IF p_template -> 'format' IS DISTINCT FROM '"harmony.server-template"'::jsonb THEN
        RAISE EXCEPTION 'TEMPLATE_INVALID: not a Harmony server template' USING ERRCODE = '22023';
    END IF;
    IF p_template -> 'version' IS DISTINCT FROM '1'::jsonb THEN
        RAISE EXCEPTION 'TEMPLATE_VERSION: template version % is not supported', p_template -> 'version'
            USING ERRCODE = '22023';
    END IF;

    -- Server ---------------------------------------------------------------
    v_server := COALESCE(public.server_template_json(p_template -> 'server', 'server', 'object', NULL), '{}'::jsonb);
    FOR v_item, v_idx IN
        SELECT e.value, e.ordinality - 1
          FROM jsonb_array_elements(COALESCE(
                   public.server_template_json(v_server -> 'rules', 'server.rules', 'array', 25), '[]'::jsonb))
               WITH ORDINALITY e
    LOOP
        v_rules := v_rules || to_jsonb(public.server_template_text(v_item, format('server.rules[%s]', v_idx), 500, true));
    END LOOP;

    -- Roles ----------------------------------------------------------------
    FOR v_item, v_idx IN
        SELECT e.value, e.ordinality - 1
          FROM jsonb_array_elements(COALESCE(
                   public.server_template_json(p_template -> 'roles', 'roles', 'array', 250), '[]'::jsonb))
               WITH ORDINALITY e
    LOOP
        v_path := format('roles[%s]', v_idx);
        IF jsonb_typeof(v_item) <> 'object' THEN
            RAISE EXCEPTION 'TEMPLATE_INVALID: % is an object', v_path USING ERRCODE = '22023';
        END IF;
        v_ref := public.server_template_ref(v_item -> 'ref', v_path || '.ref');
        IF v_kinds ? v_ref THEN
            RAISE EXCEPTION 'TEMPLATE_INVALID: ref "%" is used more than once', v_ref USING ERRCODE = '22023';
        END IF;
        v_kinds := v_kinds || jsonb_build_object(v_ref, 'role');

        v_default := public.server_template_bool(v_item -> 'is_default', v_path || '.is_default', false);
        v_admin := public.server_template_bool(v_item -> 'is_admin', v_path || '.is_admin', false);
        IF v_default AND v_admin THEN
            RAISE EXCEPTION 'TEMPLATE_INVALID: % is not both @everyone and the Admin role', v_path USING ERRCODE = '22023';
        END IF;
        IF v_default THEN
            IF v_default_ref IS NOT NULL THEN
                RAISE EXCEPTION 'TEMPLATE_INVALID: only one role is @everyone' USING ERRCODE = '22023';
            END IF;
            v_default_ref := v_ref;
        END IF;
        IF v_admin THEN
            IF v_admin_ref IS NOT NULL THEN
                RAISE EXCEPTION 'TEMPLATE_INVALID: only one role is the Admin role' USING ERRCODE = '22023';
            END IF;
            v_admin_ref := v_ref;
        END IF;

        v_color := public.server_template_text(v_item -> 'color', v_path || '.color', 9, false);
        IF v_color IS NOT NULL AND v_color !~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$' THEN
            RAISE EXCEPTION 'TEMPLATE_INVALID: %.color is a hex color', v_path USING ERRCODE = '22023';
        END IF;

        v_roles := v_roles || jsonb_build_array(jsonb_build_object(
            'ref', v_ref,
            'name', public.server_template_text(v_item -> 'name', v_path || '.name', 100, true),
            'color', v_color,
            'position', public.server_template_int(v_item -> 'position', v_path || '.position', 0, -2147483647, 2147483647),
            'permissions', public.server_template_bits(v_item -> 'permissions', v_path || '.permissions')::text,
            'is_default', v_default,
            'is_admin', v_admin,
            'mentionable', public.server_template_bool(v_item -> 'mentionable', v_path || '.mentionable', true),
            'hoist', public.server_template_bool(v_item -> 'hoist', v_path || '.hoist', false),
            'unicode_emoji', public.server_template_text(v_item -> 'unicode_emoji', v_path || '.unicode_emoji', 64, false)));
    END LOOP;

    -- Categories -----------------------------------------------------------
    FOR v_item, v_idx IN
        SELECT e.value, e.ordinality - 1
          FROM jsonb_array_elements(COALESCE(
                   public.server_template_json(p_template -> 'categories', 'categories', 'array', 25), '[]'::jsonb))
               WITH ORDINALITY e
    LOOP
        v_path := format('categories[%s]', v_idx);
        IF jsonb_typeof(v_item) <> 'object' THEN
            RAISE EXCEPTION 'TEMPLATE_INVALID: % is an object', v_path USING ERRCODE = '22023';
        END IF;
        v_ref := public.server_template_ref(v_item -> 'ref', v_path || '.ref');
        IF v_kinds ? v_ref THEN
            RAISE EXCEPTION 'TEMPLATE_INVALID: ref "%" is used more than once', v_ref USING ERRCODE = '22023';
        END IF;
        v_kinds := v_kinds || jsonb_build_object(v_ref, 'category');
        v_categories := v_categories || jsonb_build_array(jsonb_build_object(
            'ref', v_ref,
            'name', public.server_template_text(v_item -> 'name', v_path || '.name', 100, true),
            'order', public.server_template_int(v_item -> 'order', v_path || '.order', 0, -2147483647, 2147483647)));
    END LOOP;

    -- Channels -------------------------------------------------------------
    FOR v_item, v_idx IN
        SELECT e.value, e.ordinality - 1
          FROM jsonb_array_elements(COALESCE(
                   public.server_template_json(p_template -> 'channels', 'channels', 'array', 100), '[]'::jsonb))
               WITH ORDINALITY e
    LOOP
        v_path := format('channels[%s]', v_idx);
        IF jsonb_typeof(v_item) <> 'object' THEN
            RAISE EXCEPTION 'TEMPLATE_INVALID: % is an object', v_path USING ERRCODE = '22023';
        END IF;
        v_ref := public.server_template_ref(v_item -> 'ref', v_path || '.ref');
        IF v_kinds ? v_ref THEN
            RAISE EXCEPTION 'TEMPLATE_INVALID: ref "%" is used more than once', v_ref USING ERRCODE = '22023';
        END IF;
        v_kinds := v_kinds || jsonb_build_object(v_ref, 'channel');
        v_types := v_types || jsonb_build_object(v_ref,
            public.server_template_int(v_item -> 'type', v_path || '.type', 0, 0, 1));

        v_target := NULL;
        IF jsonb_typeof(v_item -> 'category') IS DISTINCT FROM 'null' AND v_item ? 'category' THEN
            v_target := public.server_template_ref(v_item -> 'category', v_path || '.category');
            IF v_kinds ->> v_target IS DISTINCT FROM 'category' THEN
                RAISE EXCEPTION 'TEMPLATE_INVALID: %.category "%" names no category', v_path, v_target
                    USING ERRCODE = '22023';
            END IF;
        END IF;

        v_overrides := '[]'::jsonb;
        v_seen := '{}'::jsonb;
        FOR v_sub, v_sidx IN
            SELECT e.value, e.ordinality - 1
              FROM jsonb_array_elements(COALESCE(
                       public.server_template_json(v_item -> 'overrides', v_path || '.overrides', 'array', 250), '[]'::jsonb))
                   WITH ORDINALITY e
        LOOP
            IF jsonb_typeof(v_sub) <> 'object' THEN
                RAISE EXCEPTION 'TEMPLATE_INVALID: %.overrides[%] is an object', v_path, v_sidx USING ERRCODE = '22023';
            END IF;
            v_ref := public.server_template_ref(v_sub -> 'role', format('%s.overrides[%s].role', v_path, v_sidx));
            IF v_kinds ->> v_ref IS DISTINCT FROM 'role' THEN
                RAISE EXCEPTION 'TEMPLATE_INVALID: %.overrides[%].role "%" names no role', v_path, v_sidx, v_ref
                    USING ERRCODE = '22023';
            END IF;
            IF v_seen ? v_ref THEN
                RAISE EXCEPTION 'TEMPLATE_INVALID: % has more than one override for role "%"', v_path, v_ref
                    USING ERRCODE = '22023';
            END IF;
            v_seen := v_seen || jsonb_build_object(v_ref, true);
            v_overrides := v_overrides || jsonb_build_array(jsonb_build_object(
                'role', v_ref,
                'allow', public.server_template_bits(v_sub -> 'allow', format('%s.overrides[%s].allow', v_path, v_sidx))::text,
                'deny', public.server_template_bits(v_sub -> 'deny', format('%s.overrides[%s].deny', v_path, v_sidx))::text));
        END LOOP;

        v_channels := v_channels || jsonb_build_array(jsonb_build_object(
            'ref', v_item ->> 'ref',
            'name', public.server_template_text(v_item -> 'name', v_path || '.name', 100, true),
            'description', public.server_template_text(v_item -> 'description', v_path || '.description', 1024, false),
            'type', v_types -> (v_item ->> 'ref'),
            'order', public.server_template_int(v_item -> 'order', v_path || '.order', 0, -2147483647, 2147483647),
            'slowmode_seconds', public.server_template_int(v_item -> 'slowmode_seconds', v_path || '.slowmode_seconds', 0, 0, 21600),
            'category', v_target,
            'private', public.server_template_bool(v_item -> 'private', v_path || '.private', false),
            'overrides', v_overrides));
    END LOOP;

    -- Settings -------------------------------------------------------------
    v_settings := public.server_template_json(p_template -> 'settings', 'settings', 'object', NULL);
    IF v_settings IS NOT NULL THEN
        v_target := NULL;
        IF jsonb_typeof(v_settings -> 'default_role') IS DISTINCT FROM 'null' AND v_settings ? 'default_role' THEN
            v_target := public.server_template_ref(v_settings -> 'default_role', 'settings.default_role');
            IF v_kinds ->> v_target IS DISTINCT FROM 'role' THEN
                RAISE EXCEPTION 'TEMPLATE_INVALID: settings.default_role "%" names no role', v_target USING ERRCODE = '22023';
            END IF;
            IF v_target = v_admin_ref THEN
                RAISE EXCEPTION 'TEMPLATE_INVALID: the Admin role is not the default role' USING ERRCODE = '22023';
            END IF;
        END IF;

        v_ref := NULL;
        IF jsonb_typeof(v_settings -> 'system_channel') IS DISTINCT FROM 'null' AND v_settings ? 'system_channel' THEN
            v_ref := public.server_template_ref(v_settings -> 'system_channel', 'settings.system_channel');
            IF v_types -> v_ref IS DISTINCT FROM '0'::jsonb THEN
                RAISE EXCEPTION 'TEMPLATE_INVALID: settings.system_channel "%" names no text channel', v_ref
                    USING ERRCODE = '22023';
            END IF;
        END IF;

        v_text := COALESCE(public.server_template_text(v_settings -> 'default_message_notifications',
                                                       'settings.default_message_notifications', 16, false), 'mentions');
        IF v_text NOT IN ('all', 'mentions', 'none') THEN
            RAISE EXCEPTION 'TEMPLATE_INVALID: settings.default_message_notifications is all, mentions or none'
                USING ERRCODE = '22023';
        END IF;

        v_invite := COALESCE(public.server_template_json(v_settings -> 'invite_permissions',
                                                         'settings.invite_permissions', 'object', NULL), '{}'::jsonb);
        v_refs := '[]'::jsonb;
        FOR v_sub, v_sidx IN
            SELECT e.value, e.ordinality - 1
              FROM jsonb_array_elements(COALESCE(
                       public.server_template_json(v_invite -> 'allowed_roles', 'settings.invite_permissions.allowed_roles',
                                                   'array', 250), '[]'::jsonb))
                   WITH ORDINALITY e
        LOOP
            v_path := format('settings.invite_permissions.allowed_roles[%s]', v_sidx);
            IF v_kinds ->> public.server_template_ref(v_sub, v_path) IS DISTINCT FROM 'role' THEN
                RAISE EXCEPTION 'TEMPLATE_INVALID: % names no role', v_path USING ERRCODE = '22023';
            END IF;
            v_refs := v_refs || jsonb_build_array(v_sub);
        END LOOP;

        v_settings := jsonb_build_object(
            'default_role', v_target,
            'system_channel', v_ref,
            'system_messages_enabled', public.server_template_bool(v_settings -> 'system_messages_enabled',
                                                                   'settings.system_messages_enabled', true),
            'newcomer_alerts', public.server_template_bool(v_settings -> 'newcomer_alerts', 'settings.newcomer_alerts', NULL),
            'default_message_notifications', v_text,
            'invite_permissions', jsonb_build_object(
                'who_can_create', COALESCE(public.server_template_text(v_invite -> 'who_can_create',
                                           'settings.invite_permissions.who_can_create', 16, false), 'everyone'),
                'allowed_roles', v_refs,
                'default_expiration', public.server_template_int(v_invite -> 'default_expiration',
                                      'settings.invite_permissions.default_expiration', 1440, 0, 525600),
                'max_expiration', public.server_template_int(v_invite -> 'max_expiration',
                                  'settings.invite_permissions.max_expiration', 0, 0, 525600),
                'allow_temporary', public.server_template_bool(v_invite -> 'allow_temporary',
                                   'settings.invite_permissions.allow_temporary', true),
                'max_uses_limit', public.server_template_int(v_invite -> 'max_uses_limit',
                                  'settings.invite_permissions.max_uses_limit', 0, 0, 1000000)));
        IF v_settings #>> '{invite_permissions,who_can_create}' NOT IN ('everyone', 'roles', 'administrators') THEN
            RAISE EXCEPTION 'TEMPLATE_INVALID: settings.invite_permissions.who_can_create is everyone, roles or administrators'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    -- Welcome screen -------------------------------------------------------
    v_welcome := public.server_template_json(p_template -> 'welcome', 'welcome', 'object', NULL);
    IF v_welcome IS NOT NULL THEN
        v_welcome := jsonb_build_object(
            'enabled', public.server_template_bool(v_welcome -> 'enabled', 'welcome.enabled', false),
            'message', COALESCE(public.server_template_text(v_welcome -> 'message', 'welcome.message', 2000, false), ''),
            'rules', COALESCE(public.server_template_json(v_welcome -> 'rules', 'welcome.rules', 'array', 20), '[]'::jsonb),
            'require_acceptance', public.server_template_bool(v_welcome -> 'require_acceptance',
                                                              'welcome.require_acceptance', false));
    END IF;

    -- AutoMod --------------------------------------------------------------
    v_automod := public.server_template_json(p_template -> 'automod', 'automod', 'object', NULL);
    IF v_automod IS NOT NULL THEN
        v_ref := NULL;
        IF jsonb_typeof(v_automod -> 'alert_channel') IS DISTINCT FROM 'null' AND v_automod ? 'alert_channel' THEN
            v_ref := public.server_template_ref(v_automod -> 'alert_channel', 'automod.alert_channel');
            IF v_types -> v_ref IS DISTINCT FROM '0'::jsonb THEN
                RAISE EXCEPTION 'TEMPLATE_INVALID: automod.alert_channel "%" names no text channel', v_ref
                    USING ERRCODE = '22023';
            END IF;
        END IF;

        FOR v_item, v_idx IN
            SELECT e.value, e.ordinality - 1
              FROM jsonb_array_elements(COALESCE(
                       public.server_template_json(v_automod -> 'rules', 'automod.rules', 'array', 25), '[]'::jsonb))
                   WITH ORDINALITY e
        LOOP
            v_path := format('automod.rules[%s]', v_idx);
            IF jsonb_typeof(v_item) <> 'object' THEN
                RAISE EXCEPTION 'TEMPLATE_INVALID: % is an object', v_path USING ERRCODE = '22023';
            END IF;

            v_exempt := '[]'::jsonb;
            FOR v_sub, v_sidx IN
                SELECT e.value, e.ordinality - 1
                  FROM jsonb_array_elements(COALESCE(
                           public.server_template_json(v_item -> 'exempt_roles', v_path || '.exempt_roles', 'array', 50),
                           '[]'::jsonb)) WITH ORDINALITY e
            LOOP
                IF v_kinds ->> public.server_template_ref(v_sub, format('%s.exempt_roles[%s]', v_path, v_sidx))
                   IS DISTINCT FROM 'role' THEN
                    RAISE EXCEPTION 'TEMPLATE_INVALID: %.exempt_roles[%] names no role', v_path, v_sidx
                        USING ERRCODE = '22023';
                END IF;
                v_exempt := v_exempt || jsonb_build_array(v_sub);
            END LOOP;

            v_refs := '[]'::jsonb;
            FOR v_sub, v_sidx IN
                SELECT e.value, e.ordinality - 1
                  FROM jsonb_array_elements(COALESCE(
                           public.server_template_json(v_item -> 'exempt_channels', v_path || '.exempt_channels', 'array', 100),
                           '[]'::jsonb)) WITH ORDINALITY e
            LOOP
                IF COALESCE(v_kinds ->> public.server_template_ref(v_sub, format('%s.exempt_channels[%s]', v_path, v_sidx)), '')
                   NOT IN ('channel', 'category') THEN
                    RAISE EXCEPTION 'TEMPLATE_INVALID: %.exempt_channels[%] names no channel or category', v_path, v_sidx
                        USING ERRCODE = '22023';
                END IF;
                v_refs := v_refs || jsonb_build_array(v_sub);
            END LOOP;

            v_automod_rules := v_automod_rules || jsonb_build_array(jsonb_build_object(
                'name', public.server_template_text(v_item -> 'name', v_path || '.name', 100, true),
                'rule_type', public.server_template_text(v_item -> 'rule_type', v_path || '.rule_type', 32, true),
                'enabled', public.server_template_bool(v_item -> 'enabled', v_path || '.enabled', true),
                'config', COALESCE(public.server_template_json(v_item -> 'config', v_path || '.config', 'object', NULL), '{}'::jsonb),
                'actions', COALESCE(public.server_template_json(v_item -> 'actions', v_path || '.actions', 'object', NULL), '{}'::jsonb),
                'exempt_roles', v_exempt,
                'exempt_channels', v_refs,
                'position', public.server_template_int(v_item -> 'position', v_path || '.position', v_idx, 0, 2147483647)));
        END LOOP;

        v_automod := jsonb_build_object(
            'enabled', public.server_template_bool(v_automod -> 'enabled', 'automod.enabled', true),
            'alert_channel', v_ref,
            'exempt_bots', public.server_template_bool(v_automod -> 'exempt_bots', 'automod.exempt_bots', true),
            'raid_settings', public.server_template_json(v_automod -> 'raid_settings', 'automod.raid_settings', 'object', NULL),
            'rules', v_automod_rules);
    END IF;

    RETURN jsonb_build_object(
        'server', jsonb_build_object(
            'description', public.server_template_text(v_server -> 'description', 'server.description', 500, false),
            'public', public.server_template_bool(v_server -> 'public', 'server.public', false),
            'allow_cross_server_emojis', public.server_template_bool(v_server -> 'allow_cross_server_emojis',
                                                                     'server.allow_cross_server_emojis', true),
            'rules', v_rules,
            'category', public.server_template_text(v_server -> 'category', 'server.category', 32, false)),
        'roles', v_roles,
        'categories', v_categories,
        'channels', v_channels,
        'settings', v_settings,
        'welcome', v_welcome,
        'automod', v_automod);
END;
$$;

-- ---------------------------------------------------------------------------
-- Export
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.export_server_template(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_srv public.servers%ROWTYPE;
    v_mask bigint := (1::bigint << array_length(public.permission_bit_names(), 1)) - 1;
    v_admin uuid;
    v_everyone uuid;
    v_roles jsonb;
    v_categories jsonb;
    v_channels jsonb;
    v_types jsonb;
    v_order jsonb;
    v_settings jsonb;
    v_welcome jsonb;
    v_automod jsonb;
    v_rows jsonb;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_srv
      FROM public.servers s
     WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE;
    -- has_permission reads @everyone for any profile, member or not.
    IF NOT FOUND
       OR NOT (v_srv.owner IS NOT DISTINCT FROM v_me
               OR public.is_current_user_admin()
               OR (EXISTS (SELECT 1 FROM public.user_servers us
                            WHERE us.server_id = p_server_id AND us.user_id = v_me AND us.status = 'accepted')
                   AND public.has_permission(v_me, p_server_id, 'MANAGE_SERVER'))) THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;

    SELECT sr.id INTO v_everyone
      FROM public.server_roles sr WHERE sr.server_id = p_server_id AND sr.is_default;
    SELECT sr.id INTO v_admin
      FROM public.server_roles sr
     WHERE sr.server_id = p_server_id AND sr.is_admin AND sr.is_default IS NOT TRUE
     ORDER BY sr.position DESC NULLS LAST, sr.created_at, sr.id
     LIMIT 1;

    -- Refs: r<n>, c<n>, ch<n> in export order; uuid text -> ref.
    SELECT COALESCE(jsonb_object_agg(x.id::text, 'r' || x.n), '{}'::jsonb) INTO v_rows
      FROM (SELECT sr.id, row_number() OVER (ORDER BY COALESCE(sr.position, 0), sr.created_at, sr.id) AS n
              FROM public.server_roles sr WHERE sr.server_id = p_server_id) x;
    SELECT v_rows || COALESCE(jsonb_object_agg(x.id::text, 'c' || x.n), '{}'::jsonb) INTO v_rows
      FROM (SELECT cc.id, row_number() OVER (ORDER BY COALESCE(cc."order", 0), cc.created_at, cc.id) AS n
              FROM public.channel_categories cc WHERE cc.server_id = p_server_id) x;
    SELECT v_rows || COALESCE(jsonb_object_agg(x.id::text, 'ch' || x.n), '{}'::jsonb),
           COALESCE(jsonb_object_agg(x.id::text, x.type), '{}'::jsonb),
           COALESCE(jsonb_object_agg(x.id::text, x.n), '{}'::jsonb)
      INTO v_rows, v_types, v_order
      FROM (SELECT c.id, c.type,
                   row_number() OVER (ORDER BY cc."order" NULLS FIRST, cc.created_at, COALESCE(c."order", 0),
                                               c.created_at, c.id) AS n
              FROM public.channels c
              LEFT JOIN public.channel_categories cc ON cc.id = c.category
             WHERE c.server_id = p_server_id AND c.type IN (0, 1)) x;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'ref', v_rows ->> sr.id::text,
               'name', sr.name,
               'color', CASE WHEN sr.color ~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$' THEN sr.color END,
               'position', COALESCE(sr.position, 0),
               'permissions', (COALESCE(sr.permissions, 0) & v_mask)::text,
               'is_default', COALESCE(sr.is_default, false),
               'is_admin', sr.id IS NOT DISTINCT FROM v_admin,
               'mentionable', COALESCE(sr.mentionable, true),
               'hoist', COALESCE(sr.hoist, false),
               'unicode_emoji', CASE WHEN char_length(sr.unicode_emoji) <= 64 THEN sr.unicode_emoji END)
           ORDER BY COALESCE(sr.position, 0), sr.created_at, sr.id), '[]'::jsonb)
      INTO v_roles
      FROM public.server_roles sr
     WHERE sr.server_id = p_server_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'ref', v_rows ->> cc.id::text,
               'name', cc.name,
               'order', COALESCE(cc."order", 0))
           ORDER BY COALESCE(cc."order", 0), cc.created_at, cc.id), '[]'::jsonb)
      INTO v_categories
      FROM public.channel_categories cc
     WHERE cc.server_id = p_server_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'ref', v_rows ->> c.id::text,
               'name', c.name,
               'description', c.description,
               'type', c.type,
               'order', COALESCE(c."order", 0),
               'slowmode_seconds', LEAST(GREATEST(COALESCE(c.slowmode_seconds, 0), 0), 21600),
               'category', v_rows ->> c.category::text,
               'private', EXISTS (SELECT 1 FROM public.channel_permission_overrides o
                                   WHERE o.channel_id = c.id AND o.role_id = v_everyone AND o.user_id IS NULL
                                     AND (COALESCE(o.deny_permissions, 0) & 2) <> 0
                                     AND (COALESCE(o.allow_permissions, 0) & 2) = 0),
               'overrides', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                        'role', v_rows ->> o.role_id::text,
                                        'allow', (COALESCE(o.allow_permissions, 0) & v_mask)::text,
                                        'deny', (COALESCE(o.deny_permissions, 0) & v_mask)::text)
                                    ORDER BY COALESCE(r.position, 0), r.created_at, r.id), '[]'::jsonb)
                               FROM public.channel_permission_overrides o
                               JOIN public.server_roles r ON r.id = o.role_id AND r.server_id = p_server_id
                              WHERE o.channel_id = c.id AND o.target_type = 'role' AND o.user_id IS NULL))
           ORDER BY (v_order ->> c.id::text)::integer), '[]'::jsonb)
      INTO v_channels
      FROM public.channels c
     WHERE c.server_id = p_server_id AND c.type IN (0, 1);

    SELECT jsonb_build_object(
               'default_role', CASE WHEN ss.default_role_id IS DISTINCT FROM v_admin
                                    THEN v_rows ->> ss.default_role_id::text END,
               'system_channel', CASE WHEN v_types -> ss.system_channel_id::text = '0'::jsonb
                                      THEN v_rows ->> ss.system_channel_id::text END,
               'system_messages_enabled', COALESCE(ss.system_messages_enabled, true),
               'newcomer_alerts', ss.newcomer_alerts,
               'default_message_notifications', COALESCE(ss.default_message_notifications, 'mentions'),
               'invite_permissions', jsonb_build_object(
                   'who_can_create', CASE WHEN ip ->> 'who_can_create' IN ('everyone', 'roles', 'administrators')
                                          THEN ip ->> 'who_can_create' ELSE 'everyone' END,
                   'allowed_roles', (SELECT COALESCE(jsonb_agg(v_rows -> (x #>> '{}')), '[]'::jsonb)
                                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ip -> 'allowed_roles') = 'array'
                                                                      THEN ip -> 'allowed_roles' ELSE '[]'::jsonb END) x
                                      WHERE jsonb_typeof(x) = 'string'
                                        AND left(v_rows ->> (x #>> '{}'), 1) = 'r'),
                   'default_expiration', public.server_template_int(ip -> 'default_expiration', '', 1440, 0, 525600, false),
                   'max_expiration', public.server_template_int(ip -> 'max_expiration', '', 0, 0, 525600, false),
                   'allow_temporary', CASE WHEN jsonb_typeof(ip -> 'allow_temporary') = 'boolean'
                                           THEN (ip ->> 'allow_temporary')::boolean ELSE true END,
                   'max_uses_limit', public.server_template_int(ip -> 'max_uses_limit', '', 0, 0, 1000000, false)))
      INTO v_settings
      FROM public.server_settings ss
      CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(ss.invite_permissions) = 'object'
                                      THEN ss.invite_permissions ELSE '{}'::jsonb END AS ip) i
     WHERE ss.server_id = p_server_id;

    SELECT jsonb_build_object(
               'enabled', w.enabled,
               'message', w.message,
               'rules', w.rules,
               'require_acceptance', w.require_acceptance)
      INTO v_welcome
      FROM public.server_welcome_screens w
     WHERE w.server_id = p_server_id;

    SELECT jsonb_build_object(
               'enabled', st.enabled,
               'alert_channel', CASE WHEN v_types -> st.alert_channel_id::text = '0'::jsonb
                                     THEN v_rows ->> st.alert_channel_id::text END,
               'exempt_bots', st.exempt_bots,
               'raid_settings', st.raid_settings,
               'rules', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                    'name', r.name,
                                    'rule_type', r.rule_type,
                                    'enabled', r.enabled,
                                    'config', r.config,
                                    'actions', r.actions,
                                    'exempt_roles', (SELECT COALESCE(jsonb_agg(v_rows -> x::text ORDER BY o), '[]'::jsonb)
                                                       FROM unnest(r.exempt_role_ids) WITH ORDINALITY u(x, o)
                                                      WHERE left(v_rows ->> x::text, 1) = 'r'),
                                    'exempt_channels', (SELECT COALESCE(jsonb_agg(v_rows -> x::text ORDER BY o), '[]'::jsonb)
                                                          FROM unnest(r.exempt_channel_ids) WITH ORDINALITY u(x, o)
                                                         WHERE left(v_rows ->> x::text, 1) = 'c'),
                                    'position', GREATEST(r.position, 0))
                                ORDER BY r.position, r.created_at, r.id), '[]'::jsonb)
                           FROM public.server_automod_rules r
                          WHERE r.server_id = p_server_id))
      INTO v_automod
      FROM public.server_automod_settings st
     WHERE st.server_id = p_server_id;

    RETURN jsonb_build_object(
        'format', 'harmony.server-template',
        'version', 1,
        'exported_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'server', jsonb_build_object(
            'name', v_srv.name,
            'description', v_srv.description,
            'public', COALESCE(v_srv.public, false),
            'allow_cross_server_emojis', COALESCE(v_srv.allow_cross_server_emojis, true),
            'rules', (SELECT COALESCE(jsonb_agg(to_jsonb(left(e #>> '{}', 500)) ORDER BY o), '[]'::jsonb)
                        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_srv.rules) = 'array'
                                                       THEN v_srv.rules ELSE '[]'::jsonb END) WITH ORDINALITY a(e, o)
                       WHERE jsonb_typeof(e) = 'string' AND btrim(e #>> '{}') <> ''),
            'category', v_srv.category),
        'roles', v_roles,
        'categories', v_categories,
        'channels', v_channels,
        'settings', v_settings,
        'welcome', v_welcome,
        'automod', v_automod);
END;
$$;

COMMENT ON FUNCTION public.export_server_template(uuid) IS
    'Server structure as a harmony.server-template document; owner, instance admin or MANAGE_SERVER, local servers.';

-- ---------------------------------------------------------------------------
-- Create
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
            UPDATE public.server_roles
               SET color = v_item ->> 'color',
                   permissions = (v_item ->> 'permissions')::bigint,
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
        INSERT INTO public.channels (server_id, name, description, type, "order", slowmode_seconds, category)
        VALUES (v_server, v_item ->> 'name', v_item ->> 'description', (v_item ->> 'type')::smallint,
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
-- Privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.server_template_json(jsonb, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_template_text(jsonb, text, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_template_int(jsonb, text, integer, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_template_bool(jsonb, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_template_bits(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_template_ref(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_template_canonical(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_template_json(jsonb, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_template_text(jsonb, text, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_template_int(jsonb, text, integer, integer, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_template_bool(jsonb, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_template_bits(jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_template_ref(jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_template_canonical(jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.export_server_template(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_server_from_template(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.export_server_template(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_server_from_template(text, jsonb) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
