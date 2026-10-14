-- Server banner above the channel list, as Discord shows it. servers.sidebar_banner is the
-- owner's choice (off by default); the banner itself is servers.banner, cropped to 16:5.
--
-- update_server writes the flag (boolean, MANAGE_SERVER like the other settings), and the
-- server:updated broadcast carries it so open clients show or hide the banner at once.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS sidebar_banner boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.servers.sidebar_banner IS
    'Show servers.banner above the channel list. Set through update_server.';

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
        'allow_cross_server_emojis', 'rules', 'category', 'sidebar_banner'];
    v_key text;
    v_type text;
    v_text text;
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
        ELSIF v_key IN ('public', 'federation_enabled', 'allow_cross_server_emojis', 'sidebar_banner') THEN
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
        v_text := public.sanitize_profile_string(p_changes ->> 'name', 2147483647, false);
        IF v_text = '' THEN
            RAISE EXCEPTION 'server name must not be blank' USING ERRCODE = '23514';
        END IF;
        IF char_length(v_text) > 100 THEN
            RAISE EXCEPTION 'server name exceeds 100 characters' USING ERRCODE = '23514';
        END IF;
        v_row.name := v_text;
    END IF;
    IF p_changes ? 'description' THEN
        v_text := NULLIF(public.sanitize_profile_string(p_changes ->> 'description', 2147483647, true), '');
        IF char_length(v_text) > 500 THEN
            RAISE EXCEPTION 'server description exceeds 500 characters' USING ERRCODE = '23514';
        END IF;
        v_row.description := v_text;
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
           updated_at = now()
     WHERE s.id = p_server_id
       AND (s.name, s.description, s.icon, s.banner, s.public, s.federation_enabled,
            s.allow_cross_server_emojis, s.rules, s.category, s.sidebar_banner)
           IS DISTINCT FROM
           (v_row.name, v_row.description, v_row.icon, v_row.banner, v_row.public,
            v_row.federation_enabled, v_row.allow_cross_server_emojis, v_row.rules, v_row.category,
            v_row.sidebar_banner);

    RETURN (SELECT jsonb_build_object(
                'id', s.id, 'name', s.name, 'description', s.description, 'icon', s.icon,
                'banner', s.banner, 'public', s.public, 'federation_enabled', s.federation_enabled,
                'allow_cross_server_emojis', s.allow_cross_server_emojis, 'rules', s.rules,
                'category', s.category, 'sidebar_banner', s.sidebar_banner,
                'updated_at', s.updated_at)
              FROM public.servers s
             WHERE s.id = p_server_id);
END;
$$;

REVOKE ALL ON FUNCTION public.update_server(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_server(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.broadcast_server_change_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR v_member_id IN
      SELECT user_id FROM user_servers WHERE server_id = NEW.id
    LOOP
      PERFORM realtime.send(
        jsonb_build_object(
          'type', 'server:updated',
          'server', jsonb_build_object(
            'id', NEW.id,
            'name', NEW.name,
            'description', NEW.description,
            'icon', NEW.icon,
            'banner', NEW.banner,
            'sidebar_banner', NEW.sidebar_banner,
            'public', NEW.public,
            'federation_enabled', NEW.federation_enabled,
            'updated_at', NEW.updated_at
          )
        ),
        'user_event',
        'user:' || v_member_id::text,
        true
      );
    END LOOP;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
