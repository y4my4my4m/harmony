-- Servers are listed across federation by default.
--
-- servers.federation_discoverable (20261105100001) was off for every server until its owner
-- turned it on, so no instance's directory listed anything. It is now the owner's choice with
-- listing as the default: true for new servers, and kept as set when the server goes private or
-- its federation goes off. Listing itself is unchanged: federation_server_directory lists a
-- server only while it is local, public, federated and not suspended and both instance switches
-- are on, so the flag alone never exposes a private server.
--
--   backfill
--        every local server's flag is set to true, once: the block runs while the column default
--        is still false. No record of an owner's choice under 20261105100001 exists (the audit
--        trigger did not capture the column), so none is kept off. Remote copies are left as
--        they are; the directory reads local servers only.
--   update_server
--        as 20261105100001, without refusing the flag on a server that is not public or not
--        federated and without clearing it when the server stops being either.
--   server_audit_servers, z_servers_audit
--        as 20261010600001, plus federation_discoverable: a change of the flag is a
--        server.update audit row.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF (SELECT c.column_default FROM information_schema.columns c
         WHERE c.table_schema = 'public' AND c.table_name = 'servers'
           AND c.column_name = 'federation_discoverable') = 'false' THEN
        UPDATE public.servers s
           SET federation_discoverable = true
         WHERE s.federation_discoverable IS NOT TRUE
           AND s.is_local_server IS NOT FALSE;
    END IF;
END;
$$;

ALTER TABLE public.servers ALTER COLUMN federation_discoverable SET DEFAULT true;

-- End of backfill.

COMMENT ON COLUMN public.servers.federation_discoverable IS
    'The owner''s choice to list the server in this instance''s server directory for other instances, on by default. Listed while also public, federated and not suspended. Set through update_server.';

-- ---------------------------------------------------------------------------
-- update_server: as 20261105100001, the flag written as given.
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
-- Audit: as 20261010600001, plus federation_discoverable.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.server_audit_servers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['name', 'description', 'icon', 'banner', 'public', 'category',
                                    'allow_cross_server_emojis', 'federation_enabled', 'invite_code', 'rules',
                                    'federation_discoverable'];
    v_changes jsonb;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    v_changes := public.server_audit_diff(
        public.server_audit_pick(to_jsonb(OLD), v_keys)
            || jsonb_build_object('owner', (SELECT p.username FROM public.profiles p WHERE p.id = OLD.owner)),
        public.server_audit_pick(to_jsonb(NEW), v_keys)
            || jsonb_build_object('owner', (SELECT p.username FROM public.profiles p WHERE p.id = NEW.owner)));
    IF v_changes <> '{}'::jsonb THEN
        PERFORM public.server_audit_write(NEW.id, 'server.update', 'server', NEW.id::text, NEW.name, v_changes);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_servers_audit ON public.servers;
CREATE TRIGGER z_servers_audit
    AFTER UPDATE ON public.servers
    FOR EACH ROW
    WHEN ((OLD.name, OLD.description, OLD.icon, OLD.banner, OLD.public, OLD.category,
           OLD.allow_cross_server_emojis, OLD.federation_enabled, OLD.invite_code, OLD.rules, OLD.owner,
           OLD.federation_discoverable)
          IS DISTINCT FROM (NEW.name, NEW.description, NEW.icon, NEW.banner, NEW.public, NEW.category,
                            NEW.allow_cross_server_emojis, NEW.federation_enabled, NEW.invite_code, NEW.rules, NEW.owner,
                            NEW.federation_discoverable))
    EXECUTE FUNCTION public.server_audit_servers();

COMMIT;

NOTIFY pgrst, 'reload schema';
