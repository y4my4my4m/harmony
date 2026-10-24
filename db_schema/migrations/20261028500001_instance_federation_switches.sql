-- The instance's federation switches, enforced: instance_config enable_inbound_federation and
-- enable_outbound_federation (update_federation_settings; federation_settings holds the same keys
-- as written before 1.9.0). Before this the switches changed what the admin panel showed only.
--
--   instance_federation_switches()
--        inbound, outbound: the individual key, else the federation_settings key, else true;
--        federation_settings.federation_enabled false is both off. The federation backend reads it
--        (cache invalidated by pg_notify 'federation_switches'): outbound off drops every delivery,
--        inbound off refuses every inbox and signed request.
--   both off closes the instance
--        every local server's federation turns off as its owner turning it off does
--        (remove_members_from_other_instances: the Group's Remove to each member from another
--        instance), and every local member of a server hosted elsewhere leaves it
--        (instance_server_member_leaves, action 'federation_off': the member's Leave to its Group).
--        Those Removes and Leaves are delivered; nothing else is.
--   instance_federation_closures
--        local servers the closing turned off. Either switch on again turns them on again; nobody
--        removed comes back.
--   a_servers_instance_federation_guard
--        while closed, a local server's federation does not turn on, and a server created then
--        starts with it off.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Switches
-- ---------------------------------------------------------------------------

-- A stored switch: jsonb true/false, or the strings 'true'/'false' an older writer left. Null when
-- the value says neither.
CREATE OR REPLACE FUNCTION public.instance_config_flag(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE lower(btrim(p_value #>> '{}'))
        WHEN 'true' THEN true
        WHEN 'false' THEN false
    END
$$;

CREATE OR REPLACE FUNCTION public.instance_federation_switches(OUT inbound boolean, OUT outbound boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_settings jsonb;
BEGIN
    SELECT CASE WHEN jsonb_typeof(c.config_value) = 'object' THEN c.config_value END
      INTO v_settings
      FROM public.instance_config c WHERE c.config_key = 'federation_settings';

    IF public.instance_config_flag(v_settings -> 'federation_enabled') IS FALSE THEN
        inbound := false;
        outbound := false;
        RETURN;
    END IF;

    inbound := COALESCE(
        (SELECT public.instance_config_flag(c.config_value) FROM public.instance_config c
          WHERE c.config_key = 'enable_inbound_federation'),
        public.instance_config_flag(v_settings -> 'enable_inbound_federation'),
        true);
    outbound := COALESCE(
        (SELECT public.instance_config_flag(c.config_value) FROM public.instance_config c
          WHERE c.config_key = 'enable_outbound_federation'),
        public.instance_config_flag(v_settings -> 'enable_outbound_federation'),
        true);
END;
$$;

-- What the app shows: the same switches. federation_auto_accept_follows as before.
CREATE OR REPLACE FUNCTION public.get_public_federation_settings()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_switches record;
    v_settings jsonb;
BEGIN
    SELECT * INTO v_switches FROM public.instance_federation_switches();
    SELECT CASE WHEN jsonb_typeof(c.config_value) = 'object' THEN c.config_value END
      INTO v_settings
      FROM public.instance_config c WHERE c.config_key = 'federation_settings';
    RETURN jsonb_build_object(
        'federation_enabled', v_switches.inbound OR v_switches.outbound,
        'enable_inbound_federation', v_switches.inbound,
        'enable_outbound_federation', v_switches.outbound,
        'federation_auto_accept_follows',
            COALESCE(public.instance_config_flag(v_settings -> 'federation_auto_accept_follows'), true));
END;
$$;

CREATE OR REPLACE FUNCTION public.instance_federation_closed()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT NOT s.inbound AND NOT s.outbound FROM public.instance_federation_switches() s
$$;

-- ---------------------------------------------------------------------------
-- Closing and reopening
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.instance_federation_closures (
    server_id uuid PRIMARY KEY REFERENCES public.servers(id) ON DELETE CASCADE,
    closed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.instance_federation_closures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instance_federation_closures_service_role ON public.instance_federation_closures;
CREATE POLICY instance_federation_closures_service_role ON public.instance_federation_closures
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.instance_federation_closures FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.instance_federation_closures IS
    'Local servers whose federation the instance turned off when both switches went off; turned on again when one is on.';

ALTER TABLE public.instance_server_leaves DROP CONSTRAINT IF EXISTS instance_server_leaves_reason_check;
ALTER TABLE public.instance_server_leaves ADD CONSTRAINT instance_server_leaves_reason_check
    CHECK (reason IN ('removed', 'blocked', 'federation_off'));

-- p_action 'remove' | 'block' | 'federation_off'. False when the profile held no membership.
CREATE OR REPLACE FUNCTION public.instance_server_member_leaves(
    p_server_id uuid, p_profile_id uuid, p_action text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server record;
    v_leave_id uuid;
BEGIN
    SELECT s.id, s.name, s.ap_id INTO v_server FROM public.servers s WHERE s.id = p_server_id;

    -- A leave of a copy records no membership event: the host records the member's Leave.
    PERFORM set_config('harmony.skip_leave_message', '1', true);
    DELETE FROM public.user_servers WHERE server_id = p_server_id AND user_id = p_profile_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    INSERT INTO public.instance_server_leaves (server_id, profile_id, reason)
    VALUES (p_server_id, p_profile_id, CASE p_action
        WHEN 'block' THEN 'blocked'
        WHEN 'federation_off' THEN 'federation_off'
        ELSE 'removed' END)
    RETURNING id INTO v_leave_id;
    PERFORM public.queue_federation_job(
        'federate-instance-leave', jsonb_build_object('type', 'delete', 'leave_id', v_leave_id));

    INSERT INTO public.notifications (user_id, type, data)
    VALUES (p_profile_id, 'server_instance_removed', jsonb_build_object(
        'server', jsonb_build_object('id', v_server.id, 'name', v_server.name, 'ap_id', v_server.ap_id),
        'action', p_action,
        'reason', p_reason));
    RETURN true;
END;
$$;

-- Closes the instance when both switches are off, reopens what it closed when one is on.
-- Idempotent: a closed instance has no federated local server and no local member of a copy left.
CREATE OR REPLACE FUNCTION public.apply_instance_federation_switches()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_member record;
BEGIN
    IF public.instance_federation_closed() THEN
        INSERT INTO public.instance_federation_closures (server_id)
        SELECT s.id FROM public.servers s
         WHERE s.is_local_server IS NOT FALSE AND s.federation_enabled IS TRUE
        ON CONFLICT (server_id) DO NOTHING;

        -- z_servers_federation_closed_removals removes each server's members from other instances.
        UPDATE public.servers s SET federation_enabled = false
         WHERE s.is_local_server IS NOT FALSE AND s.federation_enabled IS TRUE;

        FOR v_member IN
            SELECT us.server_id, us.user_id
              FROM public.user_servers us
              JOIN public.servers s ON s.id = us.server_id
              JOIN public.profiles p ON p.id = us.user_id
             WHERE s.is_local_server IS FALSE AND p.is_local IS TRUE
        LOOP
            PERFORM public.instance_server_member_leaves(v_member.server_id, v_member.user_id, 'federation_off', NULL);
        END LOOP;
    ELSE
        UPDATE public.servers s SET federation_enabled = true
          FROM public.instance_federation_closures c
         WHERE c.server_id = s.id AND s.federation_enabled IS NOT TRUE;
        -- pg_safeupdate refuses a DELETE without WHERE in PostgREST sessions.
        DELETE FROM public.instance_federation_closures WHERE server_id IS NOT NULL;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_instance_federation_switches()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF COALESCE(NEW.config_key, OLD.config_key)
       NOT IN ('enable_inbound_federation', 'enable_outbound_federation', 'federation_settings') THEN
        RETURN NULL;
    END IF;
    PERFORM public.apply_instance_federation_switches();
    PERFORM pg_notify('federation_switches', '');
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_instance_config_federation_switches ON public.instance_config;
CREATE TRIGGER z_instance_config_federation_switches
    AFTER INSERT OR UPDATE OR DELETE ON public.instance_config
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_instance_federation_switches();

-- ---------------------------------------------------------------------------
-- No local server federates while the instance is closed
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_server_federation_instance_closed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_local_server IS FALSE OR NEW.federation_enabled IS NOT TRUE
       OR NOT public.instance_federation_closed() THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.federation_enabled := false;
        RETURN NEW;
    END IF;
    IF OLD.federation_enabled IS NOT TRUE THEN
        RAISE EXCEPTION 'INSTANCE_FEDERATION_OFF: federation is off on this instance'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_servers_instance_federation_guard ON public.servers;
CREATE TRIGGER a_servers_instance_federation_guard
    BEFORE INSERT OR UPDATE OF federation_enabled ON public.servers
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_server_federation_instance_closed();

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.instance_config_flag(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instance_federation_switches() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instance_federation_closed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_instance_federation_switches() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_instance_federation_switches() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_server_federation_instance_closed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instance_server_member_leaves(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.instance_federation_switches() TO service_role;
GRANT EXECUTE ON FUNCTION public.instance_federation_closed() TO service_role;
GRANT EXECUTE ON FUNCTION public.instance_server_member_leaves(uuid, uuid, text, text) TO service_role;

-- An instance already off at upgrade closes now.
SELECT public.apply_instance_federation_switches();

COMMIT;
