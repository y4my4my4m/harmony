-- federated_instances software, version, user_count and status_count from NodeInfo.
--
-- record_instance_nodeinfo(domain, software, version, user_count, status_count, create)
-- stores one NodeInfo 2.x read: software.name, software.version, usage.users.total and
-- usage.localPosts. It supersedes the 'nodeinfo' source of record_instance_software
-- (20261007200001_reactions_favourites_limits.sql), which stays unchanged for processes
-- of the previous release and for the 'document' source.
--
--   software      as record_instance_software: a value without metadata.software_source,
--                 other than 'unknown', is an admin's and is kept. NULL is an unanswered
--                 read and keeps the stored value.
--   version       written with an answer whose software is the one stored afterwards,
--                 the admin's included; kept otherwise.
--   user_count,   written when given and >= 0, clamped to integer range; NULL keeps the
--   status_count  stored number.
--   metadata      software_checked_at is every attempt; nodeinfo_read_at is the last
--                 answer (non-NULL software); software_source becomes 'nodeinfo' with an
--                 answer unless the software is an admin's.
--   create        true adds a missing row; false updates an existing row only and returns
--                 NULL without one.
--
-- Returns the software in effect, or NULL when none is known. Service callers only.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.record_instance_nodeinfo(
    p_domain text,
    p_software text,
    p_version text,
    p_user_count bigint,
    p_status_count bigint,
    p_create boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_domain text := lower(btrim(p_domain));
    v_software text := NULLIF(lower(btrim(p_software)), '');
    v_row public.federated_instances%ROWTYPE;
    v_meta jsonb;
    v_stored text;
    v_admin boolean;
    v_effective text;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'record_instance_nodeinfo is internal' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(v_domain, '') IS NULL THEN
        RAISE EXCEPTION 'a domain is required' USING ERRCODE = '22023';
    END IF;
    IF char_length(v_domain) > 253 OR char_length(v_software) > 64 THEN
        RAISE EXCEPTION 'domain or software too long' USING ERRCODE = '22023';
    END IF;

    IF p_create IS TRUE THEN
        INSERT INTO public.federated_instances (domain) VALUES (v_domain) ON CONFLICT (domain) DO NOTHING;
    END IF;

    SELECT * INTO v_row FROM public.federated_instances WHERE domain = v_domain FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    v_meta := CASE WHEN jsonb_typeof(v_row.metadata) = 'object' THEN v_row.metadata ELSE '{}'::jsonb END;
    v_stored := NULLIF(NULLIF(lower(btrim(v_row.software)), ''), 'unknown');
    v_admin := v_stored IS NOT NULL AND v_meta->>'software_source' IS NULL;
    v_effective := CASE WHEN v_admin THEN v_stored ELSE COALESCE(v_software, v_stored) END;

    UPDATE public.federated_instances
       SET software = CASE WHEN v_admin OR v_software IS NULL THEN software ELSE v_software END,
           version = CASE WHEN v_software IS NOT NULL AND v_software = v_effective
                          THEN left(p_version, 64) ELSE version END,
           user_count = CASE WHEN p_user_count >= 0
                             THEN LEAST(p_user_count, 2147483647)::integer ELSE user_count END,
           status_count = CASE WHEN p_status_count >= 0
                               THEN LEAST(p_status_count, 2147483647)::integer ELSE status_count END,
           updated_at = now(),
           metadata = v_meta
               || jsonb_build_object('software_checked_at', now())
               || CASE WHEN v_software IS NOT NULL
                       THEN jsonb_build_object('nodeinfo_read_at', now())
                       ELSE '{}'::jsonb END
               || CASE WHEN v_software IS NOT NULL AND NOT v_admin
                       THEN jsonb_build_object('software_source', 'nodeinfo')
                       ELSE '{}'::jsonb END
     WHERE domain = v_domain;
    RETURN v_effective;
END;
$$;
COMMENT ON FUNCTION public.record_instance_nodeinfo(text, text, text, bigint, bigint, boolean) IS
'One NodeInfo read of a remote instance: software, version, users and local posts. An admin-set software is kept.';

DO $$
DECLARE
    grantee text;
BEGIN
    REVOKE ALL ON FUNCTION public.record_instance_nodeinfo(text, text, text, bigint, bigint, boolean)
        FROM PUBLIC, anon, authenticated;
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.record_instance_nodeinfo(text, text, text, bigint, bigint, boolean) TO %I',
                           grantee);
        END IF;
    END LOOP;
END;
$$;

COMMIT;
