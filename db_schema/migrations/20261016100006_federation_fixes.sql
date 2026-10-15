-- Group actor keys and NodeInfo active users.
--
-- server_actor_keys holds the key pair of a local server's Group actor,
-- https://<domain>/servers/<id>, published as <actor>#main-key. Accept and Reject of a Join,
-- channel Add/Update/Remove, server Update and a message Delete have the Group as actor;
-- receivers require the signing key's owner to equal activity.actor, so these are signed with
-- this key. The federation backend generates a pair on first use. A remote server's local
-- copy has none.
--
-- federation_delivery_queue.sender_server_id names the Group whose key signs a queued retry.
-- Such a row has no sender_id.
--
-- nodeinfo_active_users(p_since) counts local accounts active at or after p_since: a sign-in,
-- an auth session created or refreshed, a post, or a message they wrote. System notices, a
-- join announcement among them, are not written by the account. Accounts without an auth user
-- (bots), suspended and deleted accounts are not counted. plpgsql: auth.sessions is created by
-- GoTrue at service start and may not exist when this file runs.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.server_actor_keys (
    server_id uuid PRIMARY KEY REFERENCES public.servers(id) ON DELETE CASCADE,
    public_key text NOT NULL,
    private_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.server_actor_keys IS 'Group actor key pair of each local server - accessible only via service_role';

ALTER TABLE public.server_actor_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.server_actor_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.server_actor_keys TO service_role;

DROP POLICY IF EXISTS "Service role manages Group keys" ON public.server_actor_keys;
CREATE POLICY "Service role manages Group keys" ON public.server_actor_keys
    AS PERMISSIVE FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

ALTER TABLE public.federation_delivery_queue
    ADD COLUMN IF NOT EXISTS sender_server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.federation_delivery_queue.sender_server_id IS
    'Local server whose Group actor key signs the delivery; set when sender_id is NULL';

CREATE OR REPLACE FUNCTION public.nodeinfo_active_users(p_since timestamptz)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_since IS NULL THEN
        RETURN 0;
    END IF;
    RETURN (
        SELECT count(*)
          FROM public.profiles p
         WHERE p.is_local IS TRUE
           AND p.auth_user_id IS NOT NULL
           AND p.is_suspended IS NOT TRUE
           AND p.deleted_at IS NULL
           AND (EXISTS (SELECT 1 FROM auth.users u
                         WHERE u.id = p.auth_user_id
                           AND u.last_sign_in_at >= p_since)
                OR EXISTS (SELECT 1 FROM auth.sessions s
                            WHERE s.user_id = p.auth_user_id
                              AND greatest(s.created_at, s.updated_at,
                                           s.refreshed_at AT TIME ZONE 'UTC') >= p_since)
                OR EXISTS (SELECT 1 FROM public.posts po
                            WHERE po.author_id = p.id
                              AND po.created_at >= p_since)
                OR EXISTS (SELECT 1 FROM public.messages m
                            WHERE m.user_id = p.id
                              AND m.is_system IS NOT TRUE
                              AND m.created_at >= p_since))
    );
END;
$$;

REVOKE ALL ON FUNCTION public.nodeinfo_active_users(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.nodeinfo_active_users(timestamptz) TO service_role;

COMMIT;
