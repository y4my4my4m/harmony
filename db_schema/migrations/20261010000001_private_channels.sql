-- Private channels.
--
-- A private channel denies VIEW_CHANNEL to @everyone and allows it to chosen roles. Created as
-- a plain channel and then restricted by separate requests, its full row (name included) went to
-- every member on server-structure:<server> before the overrides existed.
--
-- - create_channel: SECURITY INVOKER, so channels and channel_permission_overrides RLS apply as
--   for direct writes. Inserts the channel and, when private, the @everyone VIEW_CHANNEL deny and
--   an allow for each listed role of the server, in one transaction.
-- - trg_broadcast_channel_change splits: UPDATE and DELETE stay immediate; INSERT becomes a
--   deferred constraint trigger, so channel_is_restricted() runs at commit and sees overrides
--   written in the same transaction. A private channel goes out as ids from its first event.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.create_channel(
    p_server_id uuid,
    p_name text,
    p_type integer DEFAULT 0,
    p_category uuid DEFAULT NULL,
    p_private boolean DEFAULT false,
    p_allowed_role_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS public.channels
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel public.channels%ROWTYPE;
    v_everyone uuid;
    v_role uuid;
BEGIN
    INSERT INTO public.channels (name, server_id, type, category)
    VALUES (p_name, p_server_id, COALESCE(p_type, 0), p_category)
    RETURNING * INTO v_channel;

    IF p_private IS TRUE THEN
        SELECT id INTO v_everyone
          FROM public.server_roles
         WHERE server_id = p_server_id AND is_default = true;
        IF v_everyone IS NULL THEN
            RAISE EXCEPTION 'Server has no @everyone role' USING ERRCODE = 'P0002';
        END IF;

        -- VIEW_CHANNEL is bit 1.
        INSERT INTO public.channel_permission_overrides
            (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
        VALUES (v_channel.id, 'role', v_everyone, NULL, 0, 2);

        FOREACH v_role IN ARRAY COALESCE(p_allowed_role_ids, '{}'::uuid[]) LOOP
            CONTINUE WHEN v_role = v_everyone;
            IF NOT EXISTS (SELECT 1 FROM public.server_roles
                            WHERE id = v_role AND server_id = p_server_id) THEN
                RAISE EXCEPTION 'Role % is not a role of this server', v_role USING ERRCODE = '22023';
            END IF;
            INSERT INTO public.channel_permission_overrides
                (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
            VALUES (v_channel.id, 'role', v_role, NULL, 2, 0);
        END LOOP;
    END IF;

    RETURN v_channel;
END;
$$;

COMMENT ON FUNCTION public.create_channel(uuid, text, integer, uuid, boolean, uuid[]) IS
    'Create a channel as the caller (RLS applies); private: @everyone VIEW_CHANNEL denied, listed roles allowed, in one transaction.';

REVOKE ALL ON FUNCTION public.create_channel(uuid, text, integer, uuid, boolean, uuid[])
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_channel(uuid, text, integer, uuid, boolean, uuid[])
    TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_broadcast_channel_change ON public.channels;
CREATE TRIGGER trg_broadcast_channel_change
    AFTER UPDATE OR DELETE ON public.channels
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_channel_change();

DROP TRIGGER IF EXISTS trg_broadcast_channel_insert ON public.channels;
CREATE CONSTRAINT TRIGGER trg_broadcast_channel_insert
    AFTER INSERT ON public.channels
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_channel_change();

COMMIT;
