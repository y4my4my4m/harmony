-- create_channel for members who manage channels without owning the server.
--
-- create_channel inserted with RETURNING *. RETURNING reads the new row through the SELECT
-- policy channels_select_member, whose current_user_viewable_channel_ids() runs on the INSERT
-- statement's snapshot and does not see the row being inserted; only the owner clause of that
-- policy can pass. Every non-owner holder of MANAGE_CHANNELS or ADMINISTRATOR got 42501 "new row
-- violates row-level security policy for table channels" (reported on prod by a server admin).
--
-- The channel id is generated first, the INSERT carries no RETURNING, and the row is read back
-- by a later statement, which sees it. A creator who manages channels but cannot view the private
-- channel just created gets the row's id, server, name, type and category.
--
-- A private channel's role allows are written before the @everyone VIEW_CHANNEL deny: written
-- after it, the grant guard refused them for any manager without ADMINISTRATOR, who no longer
-- held VIEW_CHANNEL in the channel.
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
    v_id uuid := gen_random_uuid();
    v_channel public.channels%ROWTYPE;
    v_everyone uuid;
    v_role uuid;
BEGIN
    INSERT INTO public.channels (id, name, server_id, type, category)
    VALUES (v_id, p_name, p_server_id, COALESCE(p_type, 0), p_category);

    IF p_private IS TRUE THEN
        SELECT id INTO v_everyone
          FROM public.server_roles
         WHERE server_id = p_server_id AND is_default = true;
        IF v_everyone IS NULL THEN
            RAISE EXCEPTION 'Server has no @everyone role' USING ERRCODE = 'P0002';
        END IF;

        -- VIEW_CHANNEL is bit 1. The role allows go first: the grant guard requires the caller
        -- to hold VIEW_CHANNEL in the channel, which the @everyone deny takes from a manager
        -- without ADMINISTRATOR.
        FOREACH v_role IN ARRAY COALESCE(p_allowed_role_ids, '{}'::uuid[]) LOOP
            CONTINUE WHEN v_role = v_everyone;
            IF NOT EXISTS (SELECT 1 FROM public.server_roles
                            WHERE id = v_role AND server_id = p_server_id) THEN
                RAISE EXCEPTION 'Role % is not a role of this server', v_role USING ERRCODE = '22023';
            END IF;
            INSERT INTO public.channel_permission_overrides
                (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
            VALUES (v_id, 'role', v_role, NULL, 2, 0);
        END LOOP;

        INSERT INTO public.channel_permission_overrides
            (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
        VALUES (v_id, 'role', v_everyone, NULL, 0, 2);
    END IF;

    SELECT * INTO v_channel FROM public.channels WHERE id = v_id;
    IF NOT FOUND THEN
        v_channel.id := v_id;
        v_channel.server_id := p_server_id;
        v_channel.name := p_name;
        v_channel.type := COALESCE(p_type, 0);
        v_channel.category := p_category;
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

COMMIT;
