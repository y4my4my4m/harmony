-- servers.federation_enabled closes a server to other instances in the database, not only in
-- the federation backend (groupAccess.ts):
--   federation_group_access        a server with federation off reads as private with no member
--                                  and no readable channel (Group document, collections, threads,
--                                  messages, and federation_room_media_access's '*' case);
--   federation_channel_recipients  lists no remote recipient, so no channel content is delivered
--                                  and federation_room_media_access refuses every instance.
-- Bodies as in 20261001100001_federation_channel_access.sql otherwise.

BEGIN;

CREATE OR REPLACE FUNCTION public.federation_group_access(
    p_server_id uuid,
    p_actor_ap_id text DEFAULT NULL
)
RETURNS TABLE (
    is_public boolean,
    member_id uuid,
    everyone_channel_ids uuid[],
    member_channel_ids uuid[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_public boolean;
    v_local boolean;
    v_federated boolean;
    v_member uuid;
    v_everyone_role uuid;
    v_everyone_perms bigint;
BEGIN
    SELECT s.public, s.is_local_server, s.federation_enabled INTO v_public, v_local, v_federated
      FROM public.servers s
     WHERE s.id = p_server_id;

    IF NOT FOUND OR v_local IS FALSE THEN
        RETURN;
    END IF;

    -- Federation off: private to every other instance, no member, nothing readable.
    IF v_federated IS NOT TRUE THEN
        RETURN QUERY SELECT false, NULL::uuid, '{}'::uuid[], '{}'::uuid[];
        RETURN;
    END IF;

    IF p_actor_ap_id IS NOT NULL THEN
        SELECT p.id INTO v_member
          FROM public.profiles p
          JOIN public.user_servers us ON us.user_id = p.id AND us.server_id = p_server_id
         WHERE p.federated_id = p_actor_ap_id
           AND p.is_local IS FALSE
           AND p.is_suspended IS NOT TRUE
           AND us.status = 'accepted'
           AND NOT EXISTS (
                SELECT 1 FROM public.server_bans b
                 WHERE b.server_id = p_server_id AND b.user_id = p.id
           )
         LIMIT 1;
    END IF;

    SELECT r.id, COALESCE(r.permissions, 0) INTO v_everyone_role, v_everyone_perms
      FROM public.server_roles r
     WHERE r.server_id = p_server_id AND r.is_default = true
     LIMIT 1;
    v_everyone_perms := COALESCE(v_everyone_perms, 0);

    RETURN QUERY
    SELECT
        COALESCE(v_public, false),
        v_member,
        COALESCE((
            SELECT array_agg(c.id ORDER BY c.id)
              FROM public.channels c
              LEFT JOIN LATERAL (
                    SELECT bit_or(COALESCE(o.allow_permissions, 0)) AS allow_p,
                           bit_or(COALESCE(o.deny_permissions, 0))  AS deny_p
                      FROM public.channel_permission_overrides o
                     WHERE o.channel_id = c.id
                       AND o.role_id = v_everyone_role
                       AND o.user_id IS NULL
              ) ov ON true
             WHERE c.server_id = p_server_id
               AND c.is_remote IS NOT TRUE
               AND (
                    (v_everyone_perms & 1) <> 0
                    OR (((v_everyone_perms & ~COALESCE(ov.deny_p, 0)) | COALESCE(ov.allow_p, 0)) & 2) <> 0
               )
        ), '{}'::uuid[]),
        CASE WHEN v_member IS NULL THEN '{}'::uuid[] ELSE COALESCE((
            SELECT array_agg(c.id ORDER BY c.id)
              FROM public.channels c
             WHERE c.server_id = p_server_id
               AND c.is_remote IS NOT TRUE
               AND public.has_permission(v_member, p_server_id, 'VIEW_CHANNEL', c.id)
        ), '{}'::uuid[]) END;
END;
$$;


REVOKE ALL ON FUNCTION public.federation_group_access(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.federation_group_access(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.federation_channel_recipients(p_channel_id uuid)
RETURNS TABLE (
    instance text,
    member_ap_ids text[],
    member_count integer,
    shared_inbox text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT lower(p.domain) AS instance,
           array_agg(p.federated_id ORDER BY p.federated_id) AS member_ap_ids,
           count(*)::integer AS member_count,
           (array_agg(p.shared_inbox_url ORDER BY p.shared_inbox_url)
                FILTER (WHERE p.shared_inbox_url IS NOT NULL))[1] AS shared_inbox
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id AND s.federation_enabled IS TRUE
      JOIN public.user_servers us ON us.server_id = c.server_id AND us.status = 'accepted'
      JOIN public.profiles p ON p.id = us.user_id
     WHERE c.id = p_channel_id
       AND p.is_local IS FALSE
       AND p.is_suspended IS NOT TRUE
       AND p.federated_id IS NOT NULL
       AND NOT EXISTS (
            SELECT 1 FROM public.server_bans b
             WHERE b.server_id = c.server_id AND b.user_id = p.id
       )
       AND public.has_permission(p.id, c.server_id, 'VIEW_CHANNEL', c.id)
     GROUP BY lower(p.domain);
$$;

REVOKE ALL ON FUNCTION public.federation_channel_recipients(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.federation_channel_recipients(uuid) TO service_role;

COMMIT;
