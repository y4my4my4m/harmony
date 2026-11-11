-- Discord bridge: sync a Discord server's name, icon, banner and description onto its paired
-- Harmony server.
--
-- Adds four columns to discord_bridges that remember where the
-- server's current icon and banner came from, and two RPCs for the bot of a server's Discord
-- bridge, called through bot-gateway (service_role):
--   profile_icon_discord_hash / profile_icon_path        the Discord icon hash and the storage
--   profile_banner_discord_hash / profile_banner_path    path the Harmony icon / banner was
--                                                        copied from (NULL: not synced)
-- Like the rest of the row they are readable by the bridge's managers (the existing RLS policy
-- and table-wide SELECT) and written only by the RPCs below.
-- bot-gateway compares a fresh Discord hash with the stored one to skip an unchanged image.
-- A hash is Discord's image hash: 32 hex digits, prefixed a_ when the image is animated.
--
-- bridge_get_server_profile(p_bot_id, p_server_id)
-- One row: the server's name, description, icon and banner and the four source columns.
--
-- bridge_update_server_profile(p_bot_id, p_server_id, p_changes)
-- p_changes is an object with any of name, description, icon, banner, icon_discord_hash and
-- banner_discord_hash. name is a string; the others are a string or null. icon and
-- icon_discord_hash arrive together (both strings or both null), and so do banner and
-- banner_discord_hash. name and description go through server_profile_name and
-- server_profile_description, the rules update_server applies too. The servers row is written
-- only when name, description, icon or banner differ; the source columns are written whenever
-- their keys are sent. Returns changed, the previous icon and banner (the caller deletes the
-- old files) and the resulting name, description, icon and banner.
-- Errors: 42501 the bot does not bridge the server, or the server is remote; 22023 a bad key,
-- type, pair or hash; 23514 a blank or too long name, a too long description.
--
-- The server audit log writes server.update as for any edit; bot-gateway logs
-- server_profile_synced (metadata serverId) in bot_audit_log, which attributes that row to the bot.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.discord_bridges
    ADD COLUMN IF NOT EXISTS profile_icon_discord_hash text
        CONSTRAINT discord_bridges_profile_icon_hash_check
            CHECK (profile_icon_discord_hash IS NULL OR profile_icon_discord_hash ~ '^(a_)?[0-9a-f]{32}$'),
    ADD COLUMN IF NOT EXISTS profile_icon_path text,
    ADD COLUMN IF NOT EXISTS profile_banner_discord_hash text
        CONSTRAINT discord_bridges_profile_banner_hash_check
            CHECK (profile_banner_discord_hash IS NULL OR profile_banner_discord_hash ~ '^(a_)?[0-9a-f]{32}$'),
    ADD COLUMN IF NOT EXISTS profile_banner_path text;

-- ---------------------------------------------------------------------------
-- Shared name and description rules (moved out of update_server)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.server_profile_name(p_name text)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_text text;
BEGIN
    v_text := public.sanitize_profile_string(p_name, 2147483647, false);
    IF v_text = '' THEN
        RAISE EXCEPTION 'server name must not be blank' USING ERRCODE = '23514';
    END IF;
    IF char_length(v_text) > 100 THEN
        RAISE EXCEPTION 'server name exceeds 100 characters' USING ERRCODE = '23514';
    END IF;
    RETURN v_text;
END;
$$;

CREATE OR REPLACE FUNCTION public.server_profile_description(p_description text)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_text text;
BEGIN
    v_text := NULLIF(public.sanitize_profile_string(p_description, 2147483647, true), '');
    IF char_length(v_text) > 500 THEN
        RAISE EXCEPTION 'server description exceeds 500 characters' USING ERRCODE = '23514';
    END IF;
    RETURN v_text;
END;
$$;

REVOKE ALL ON FUNCTION public.server_profile_name(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_profile_description(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- update_server: as 20261107900001, the name and description rules in the helpers above.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_server(p_server_id uuid, p_changes jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_writable CONSTANT text[] := ARRAY[
        'name', 'description', 'icon', 'banner', 'public', 'federation_enabled',
        'allow_cross_server_emojis', 'rules', 'category', 'sidebar_banner',
        'federation_discoverable'];
    v_key text;
    v_type text;
    v_row public.servers%ROWTYPE;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN
        RAISE EXCEPTION 'changes must be a JSON object' USING ERRCODE = '22023';
    END IF;

    -- Locked: unchanged columns are written back from this read.
    SELECT * INTO v_row
      FROM public.servers s
     WHERE s.id = p_server_id
       AND s.is_local_server IS NOT FALSE
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;

    -- has_permission reads @everyone for any profile, member or not.
    IF v_row.owner IS DISTINCT FROM v_caller
       AND NOT (EXISTS (SELECT 1 FROM public.user_servers us
                         WHERE us.server_id = p_server_id
                           AND us.user_id = v_caller
                           AND us.status = 'accepted')
                AND public.has_permission(v_caller, p_server_id, 'MANAGE_SERVER')) THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;

    FOR v_key IN SELECT jsonb_object_keys(p_changes) LOOP
        v_type := jsonb_typeof(p_changes -> v_key);
        IF NOT v_key = ANY (v_writable) THEN
            RAISE EXCEPTION 'server setting % is not writable', v_key USING ERRCODE = '22023';
        ELSIF v_key IN ('public', 'federation_enabled', 'allow_cross_server_emojis', 'sidebar_banner',
                        'federation_discoverable') THEN
            IF v_type IS DISTINCT FROM 'boolean' THEN
                RAISE EXCEPTION '% must be a boolean', v_key USING ERRCODE = '22023';
            END IF;
        ELSIF v_key = 'rules' THEN
            IF v_type IS DISTINCT FROM 'array' THEN
                RAISE EXCEPTION 'rules must be an array of strings' USING ERRCODE = '22023';
            END IF;
            IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_changes -> 'rules') e
                        WHERE jsonb_typeof(e) <> 'string') THEN
                RAISE EXCEPTION 'rules must be an array of strings' USING ERRCODE = '22023';
            END IF;
            IF jsonb_array_length(p_changes -> 'rules') > 25 THEN
                RAISE EXCEPTION 'at most 25 rules' USING ERRCODE = '23514';
            END IF;
        ELSIF v_type = 'null' AND v_key <> 'name' THEN
            NULL;
        ELSIF v_type IS DISTINCT FROM 'string' THEN
            RAISE EXCEPTION '% must be a string', v_key USING ERRCODE = '22023';
        END IF;
    END LOOP;

    IF p_changes ? 'name' THEN
        v_row.name := public.server_profile_name(p_changes ->> 'name');
    END IF;
    IF p_changes ? 'description' THEN
        v_row.description := public.server_profile_description(p_changes ->> 'description');
    END IF;
    IF p_changes ? 'icon' THEN
        v_row.icon := NULLIF(p_changes ->> 'icon', '');
    END IF;
    IF p_changes ? 'banner' THEN
        v_row.banner := NULLIF(p_changes ->> 'banner', '');
    END IF;
    IF p_changes ? 'public' THEN
        v_row.public := (p_changes ->> 'public')::boolean;
    END IF;
    IF p_changes ? 'federation_enabled' THEN
        v_row.federation_enabled := (p_changes ->> 'federation_enabled')::boolean;
    END IF;
    IF p_changes ? 'allow_cross_server_emojis' THEN
        v_row.allow_cross_server_emojis := (p_changes ->> 'allow_cross_server_emojis')::boolean;
    END IF;
    IF p_changes ? 'rules' THEN
        v_row.rules := p_changes -> 'rules';
    END IF;
    IF p_changes ? 'category' THEN
        v_row.category := p_changes ->> 'category';
    END IF;
    IF p_changes ? 'sidebar_banner' THEN
        v_row.sidebar_banner := (p_changes ->> 'sidebar_banner')::boolean;
    END IF;
    IF p_changes ? 'federation_discoverable' THEN
        v_row.federation_discoverable := (p_changes ->> 'federation_discoverable')::boolean;
    END IF;

    -- An unchanged row writes nothing: every servers UPDATE broadcasts to each member.
    UPDATE public.servers s
       SET name = v_row.name,
           description = v_row.description,
           icon = v_row.icon,
           banner = v_row.banner,
           public = v_row.public,
           federation_enabled = v_row.federation_enabled,
           allow_cross_server_emojis = v_row.allow_cross_server_emojis,
           rules = v_row.rules,
           category = v_row.category,
           sidebar_banner = v_row.sidebar_banner,
           federation_discoverable = v_row.federation_discoverable,
           updated_at = now()
     WHERE s.id = p_server_id
       AND (s.name, s.description, s.icon, s.banner, s.public, s.federation_enabled,
            s.allow_cross_server_emojis, s.rules, s.category, s.sidebar_banner,
            s.federation_discoverable)
           IS DISTINCT FROM
           (v_row.name, v_row.description, v_row.icon, v_row.banner, v_row.public,
            v_row.federation_enabled, v_row.allow_cross_server_emojis, v_row.rules, v_row.category,
            v_row.sidebar_banner, v_row.federation_discoverable);

    RETURN (SELECT jsonb_build_object(
                'id', s.id, 'name', s.name, 'description', s.description, 'icon', s.icon,
                'banner', s.banner, 'public', s.public, 'federation_enabled', s.federation_enabled,
                'allow_cross_server_emojis', s.allow_cross_server_emojis, 'rules', s.rules,
                'category', s.category, 'sidebar_banner', s.sidebar_banner,
                'federation_discoverable', s.federation_discoverable,
                'updated_at', s.updated_at)
              FROM public.servers s
             WHERE s.id = p_server_id);
END;
$$;

REVOKE ALL ON FUNCTION public.update_server(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_server(uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- Bot attribution
-- ---------------------------------------------------------------------------
-- As 20261112300001, plus server_profile_synced: the server.update row a sync writes belongs
-- to the bot. Its target is the server, named in the metadata as serverId.
CREATE OR REPLACE FUNCTION public.server_audit_attribute_bot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_meta jsonb := COALESCE(NEW.metadata, '{}'::jsonb);
    v_actions text[];
    v_target text;
    v_server text;
BEGIN
    v_actions := CASE NEW.action_type
        WHEN 'channel_created' THEN ARRAY['channel.create']
        WHEN 'category_created' THEN ARRAY['category.create']
        WHEN 'role_created' THEN ARRAY['role.create']
        WHEN 'role_updated' THEN ARRAY['role.update']
        WHEN 'role_deleted' THEN ARRAY['role.delete']
        WHEN 'emoji_imported' THEN ARRAY['emoji.create']
        WHEN 'emoji_updated' THEN ARRAY['emoji.update', 'emoji.create']
        WHEN 'emoji_removed' THEN ARRAY['emoji.delete']
        WHEN 'sticker_imported' THEN ARRAY['sticker.create']
        WHEN 'sticker_updated' THEN ARRAY['sticker.update', 'sticker.create']
        WHEN 'sticker_removed' THEN ARRAY['sticker.delete']
        WHEN 'server_profile_synced' THEN ARRAY['server.update']
    END;
    IF NEW.action_type = 'server_profile_synced' THEN
        v_target := v_meta ->> 'serverId';
    END IF;
    v_target := COALESCE(v_target, v_meta ->> 'channel_id', v_meta ->> 'category_id', v_meta ->> 'role_id',
                         v_meta ->> 'emojiId', v_meta ->> 'stickerId');
    v_server := COALESCE(NEW.server_id::text, v_meta ->> 'server_id', v_meta ->> 'serverId');
    IF v_actions IS NULL OR v_target IS NULL OR v_server IS NULL
       OR v_server !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN NULL;
    END IF;

    UPDATE public.server_audit_log l
       SET source = 'bot', actor_bot_id = NEW.bot_id
     WHERE l.server_id = v_server::uuid
       AND l.action = ANY (v_actions)
       AND l.target_id = v_target
       AND l.source = 'system'
       AND l.actor_id IS NULL
       AND l.created_at > clock_timestamp() - interval '5 minutes';
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_bot_audit_log_server_audit ON public.bot_audit_log;
CREATE TRIGGER z_bot_audit_log_server_audit
    AFTER INSERT ON public.bot_audit_log
    FOR EACH ROW
    WHEN (NEW.success IS NOT FALSE AND NEW.bot_id IS NOT NULL
          AND NEW.action_type IN ('channel_created', 'category_created', 'role_created',
                                  'role_updated', 'role_deleted', 'emoji_imported',
                                  'emoji_updated', 'emoji_removed', 'sticker_imported',
                                  'sticker_updated', 'sticker_removed', 'server_profile_synced'))
    EXECUTE FUNCTION public.server_audit_attribute_bot();

-- ---------------------------------------------------------------------------
-- Bridge RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bridge_get_server_profile(
    p_bot_id uuid,
    p_server_id uuid
)
RETURNS TABLE(name text, description text, icon text, banner text,
              icon_discord_hash text, icon_path text, banner_discord_hash text, banner_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- Output columns share names with servers columns; references mean the table.
#variable_conflict use_column
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM public.discord_bridges b
          JOIN public.servers s ON s.id = b.server_id
         WHERE b.server_id = p_server_id AND b.bot_id = p_bot_id
           AND s.is_local_server IS NOT FALSE
    ) THEN
        RAISE EXCEPTION 'bot does not bridge this server' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT s.name, s.description, s.icon, s.banner,
           b.profile_icon_discord_hash, b.profile_icon_path,
           b.profile_banner_discord_hash, b.profile_banner_path
      FROM public.servers s
      JOIN public.discord_bridges b ON b.server_id = s.id
     WHERE s.id = p_server_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_update_server_profile(
    p_bot_id uuid,
    p_server_id uuid,
    p_changes jsonb
)
RETURNS TABLE(changed boolean, previous_icon text, previous_banner text,
              name text, description text, icon text, banner text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- Output columns share names with servers columns; references mean the table.
#variable_conflict use_column
DECLARE
    v_allowed CONSTANT text[] := ARRAY['name', 'description', 'icon', 'banner',
                                       'icon_discord_hash', 'banner_discord_hash'];
    v_key text;
    v_type text;
    v_old public.servers%ROWTYPE;
    v_name text;
    v_description text;
    v_icon text;
    v_banner text;
    v_changed boolean;
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM public.discord_bridges b
          JOIN public.servers s ON s.id = b.server_id
         WHERE b.server_id = p_server_id AND b.bot_id = p_bot_id
           AND s.is_local_server IS NOT FALSE
    ) THEN
        RAISE EXCEPTION 'bot does not bridge this server' USING ERRCODE = '42501';
    END IF;

    IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN
        RAISE EXCEPTION 'changes must be a JSON object' USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(p_changes) LOOP
        v_type := jsonb_typeof(p_changes -> v_key);
        IF NOT v_key = ANY (v_allowed) THEN
            RAISE EXCEPTION 'server profile setting % is not writable', v_key USING ERRCODE = '22023';
        ELSIF v_key = 'name' THEN
            IF v_type IS DISTINCT FROM 'string' THEN
                RAISE EXCEPTION 'name must be a string' USING ERRCODE = '22023';
            END IF;
        ELSIF v_type NOT IN ('string', 'null') THEN
            RAISE EXCEPTION '% must be a string or null', v_key USING ERRCODE = '22023';
        END IF;
    END LOOP;
    -- An image and its Discord hash arrive together: both strings or both null.
    IF (p_changes ? 'icon') <> (p_changes ? 'icon_discord_hash')
       OR (p_changes ? 'banner') <> (p_changes ? 'banner_discord_hash')
       OR jsonb_typeof(p_changes -> 'icon') IS DISTINCT FROM jsonb_typeof(p_changes -> 'icon_discord_hash')
       OR jsonb_typeof(p_changes -> 'banner') IS DISTINCT FROM jsonb_typeof(p_changes -> 'banner_discord_hash') THEN
        RAISE EXCEPTION 'an image and its Discord hash arrive together' USING ERRCODE = '22023';
    END IF;
    IF p_changes ->> 'icon' = '' OR p_changes ->> 'banner' = '' THEN
        RAISE EXCEPTION 'an image path must not be empty' USING ERRCODE = '22023';
    END IF;
    IF p_changes ->> 'icon_discord_hash' !~ '^(a_)?[0-9a-f]{32}$'
       OR p_changes ->> 'banner_discord_hash' !~ '^(a_)?[0-9a-f]{32}$' THEN
        RAISE EXCEPTION 'invalid Discord image hash' USING ERRCODE = '22023';
    END IF;

    IF p_changes ? 'name' THEN
        v_name := public.server_profile_name(p_changes ->> 'name');
    END IF;
    IF p_changes ? 'description' THEN
        v_description := public.server_profile_description(p_changes ->> 'description');
    END IF;

    SELECT * INTO v_old FROM public.servers s WHERE s.id = p_server_id FOR UPDATE;

    v_name := CASE WHEN p_changes ? 'name' THEN v_name ELSE v_old.name END;
    v_description := CASE WHEN p_changes ? 'description' THEN v_description ELSE v_old.description END;
    v_icon := CASE WHEN p_changes ? 'icon' THEN p_changes ->> 'icon' ELSE v_old.icon END;
    v_banner := CASE WHEN p_changes ? 'banner' THEN p_changes ->> 'banner' ELSE v_old.banner END;

    v_changed := (v_old.name, v_old.description, v_old.icon, v_old.banner)
                 IS DISTINCT FROM (v_name, v_description, v_icon, v_banner);
    IF v_changed THEN
        UPDATE public.servers s
           SET name = v_name, description = v_description, icon = v_icon, banner = v_banner,
               updated_at = now()
         WHERE s.id = p_server_id;
    END IF;

    IF p_changes ? 'icon' THEN
        UPDATE public.discord_bridges b
           SET profile_icon_discord_hash = p_changes ->> 'icon_discord_hash',
               profile_icon_path = p_changes ->> 'icon'
         WHERE b.server_id = p_server_id;
    END IF;
    IF p_changes ? 'banner' THEN
        UPDATE public.discord_bridges b
           SET profile_banner_discord_hash = p_changes ->> 'banner_discord_hash',
               profile_banner_path = p_changes ->> 'banner'
         WHERE b.server_id = p_server_id;
    END IF;

    RETURN QUERY SELECT v_changed, v_old.icon, v_old.banner, v_name, v_description, v_icon, v_banner;
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_get_server_profile(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_get_server_profile(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.bridge_update_server_profile(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_update_server_profile(uuid, uuid, jsonb) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
