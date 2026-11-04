-- Servers listed across federation: the instance's directory of its own Groups, an
-- ActivityStreams OrderedCollection at https://<domain>/servers/directory (federation-backend
-- activitypub/serverDirectory.ts), and the Group's `discoverable` (toot:discoverable).
--
--   servers.federation_discoverable
--        the owner's choice, off by default; existing servers stay off. Written through
--        update_server (MANAGE_SERVER, as the other settings).
--   update_server
--        writes federation_discoverable. Setting it on a server that is not public or not
--        federated is refused (22023); a change that makes the server private or turns its
--        federation off clears it.
--   federation_server_directory(p_limit, p_offset)
--        the listed servers, most members first: local, public, federated, flag on, not
--        suspended by staff, while both instance federation switches are on. member_count counts
--        accepted memberships; total_count is the size of the whole listing.
--   record_instance_directory(p_domain, p_directory)
--        stores on an existing federated_instances row the directory its NodeInfo names
--        (metadata.server_directory, removed for null) and when it was read
--        (metadata.directory_checked_at). No row is created.
--   trigger_queue_server_update_federation
--        a change of federation_discoverable queues federate-server-update: the Group's Update
--        carries the new `discoverable`.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS federation_discoverable boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.servers.federation_discoverable IS
    'Listed in this instance''s server directory for other instances while public, federated and not suspended. Set through update_server.';

-- ---------------------------------------------------------------------------
-- update_server: as 20261014100002, plus federation_discoverable.
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

    -- Listed across federation only while public and federated.
    IF v_row.federation_discoverable AND (v_row.public IS NOT TRUE OR v_row.federation_enabled IS NOT TRUE) THEN
        IF (p_changes ->> 'federation_discoverable')::boolean IS TRUE THEN
            RAISE EXCEPTION 'a server is listed across federation only while it is public and federated'
                USING ERRCODE = '22023';
        END IF;
        v_row.federation_discoverable := false;
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
-- Directory
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.federation_server_directory(p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
RETURNS TABLE(id uuid, slug text, name text, description text, icon text, banner text, category text,
              created_at timestamptz, updated_at timestamptz, member_count bigint, total_count bigint)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    WITH listed AS (
        SELECT s.id, s.slug, s.name, s.description, s.icon, s.banner, s.category, s.created_at, s.updated_at,
               (SELECT count(*) FROM public.user_servers us
                 WHERE us.server_id = s.id AND us.status = 'accepted') AS member_count
          FROM public.servers s
         WHERE s.is_local_server IS NOT FALSE
           AND s.public IS TRUE
           AND s.federation_enabled IS TRUE
           AND s.federation_discoverable IS TRUE
           AND s.suspended_at IS NULL
           AND (SELECT sw.inbound AND sw.outbound FROM public.instance_federation_switches() sw)
    )
    SELECT l.id, l.slug, l.name, l.description, l.icon, l.banner, l.category, l.created_at, l.updated_at,
           l.member_count, count(*) OVER () AS total_count
      FROM listed l
     ORDER BY l.member_count DESC, l.created_at, l.id
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

COMMENT ON FUNCTION public.federation_server_directory(integer, integer) IS
    'Servers this instance lists for other instances (GET /servers/directory), most members first.';

REVOKE ALL ON FUNCTION public.federation_server_directory(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.federation_server_directory(integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.record_instance_directory(p_domain text, p_directory text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_domain text := lower(btrim(p_domain));
    v_url text := NULLIF(btrim(p_directory), '');
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'record_instance_directory is internal' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(v_domain, '') IS NULL OR char_length(v_domain) > 253 THEN
        RAISE EXCEPTION 'a domain of at most 253 characters is required' USING ERRCODE = '22023';
    END IF;
    IF char_length(v_url) > 2048 THEN
        RAISE EXCEPTION 'directory URL exceeds 2048 characters' USING ERRCODE = '22023';
    END IF;

    UPDATE public.federated_instances fi
       SET metadata = (CASE WHEN jsonb_typeof(fi.metadata) = 'object' THEN fi.metadata ELSE '{}'::jsonb END
                         - 'server_directory')
                      || jsonb_build_object('directory_checked_at', now())
                      || CASE WHEN v_url IS NOT NULL THEN jsonb_build_object('server_directory', v_url)
                              ELSE '{}'::jsonb END,
           updated_at = now()
     WHERE fi.domain = v_domain;
    RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.record_instance_directory(text, text) IS
    'The server directory a remote instance''s NodeInfo names, stored on its existing federated_instances row.';

REVOKE ALL ON FUNCTION public.record_instance_directory(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_instance_directory(text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Group Update: as 20260101000000_baseline, its search_path with the pg_temp the baseline's
-- search_path pin appends, plus federation_discoverable.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trigger_queue_server_update_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_local_server IS NOT TRUE OR NEW.federation_enabled IS NOT TRUE THEN
        RETURN NEW;
    END IF;

    IF OLD.name IS NOT DISTINCT FROM NEW.name
       AND OLD.description IS NOT DISTINCT FROM NEW.description
       AND OLD.icon IS NOT DISTINCT FROM NEW.icon
       AND OLD.banner IS NOT DISTINCT FROM NEW.banner
       AND OLD.public IS NOT DISTINCT FROM NEW.public
       AND OLD.federation_enabled IS NOT DISTINCT FROM NEW.federation_enabled
       AND OLD.federation_discoverable IS NOT DISTINCT FROM NEW.federation_discoverable
    THEN
        RETURN NEW;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-server-update',
        jsonb_build_object('type', 'update', 'server_id', NEW.id),
        5, 5, 900
    );
    RETURN NEW;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
