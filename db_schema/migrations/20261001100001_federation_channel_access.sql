-- Read access and push recipients for local servers over federation.
--
-- A remote reader is the key owner of a verified HTTP signature, matched to
-- profiles.federated_id. It is a member of a server when that profile is not
-- local, not suspended, has an accepted user_servers row and no server_bans
-- row. A member sees a channel when has_permission(..., 'VIEW_CHANNEL', ...)
-- holds, the check the client applies.
--
-- get_server_members_by_instance returns accepted members only: pending and
-- banned rows receive no server-level delivery.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- One row per local server, none for an unknown id or a remote reference.
--   is_public             servers.public; NULL reads as private.
--   member_id             profile of p_actor_ap_id when it is a remote member, else NULL.
--   everyone_channel_ids  local channels @everyone can view, whether or not the server is public.
--   member_channel_ids    local channels member_id can view; empty without a member.
--
-- @everyone visibility is get_user_permissions layers 1 and 2 for a caller who
-- owns nothing and holds no role or user override: ADMINISTRATOR (bit 0) on the
-- @everyone role grants all; otherwise VIEW_CHANNEL (bit 1) after the @everyone
-- channel override, deny cleared before allow is set.
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
    v_member uuid;
    v_everyone_role uuid;
    v_everyone_perms bigint;
BEGIN
    SELECT s.public, s.is_local_server INTO v_public, v_local
      FROM public.servers s
     WHERE s.id = p_server_id;

    IF NOT FOUND OR v_local IS FALSE THEN
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

-- Remote members who can view p_channel_id, grouped by instance domain. One
-- delivery per row; shared_inbox is any shared inbox a member of that instance
-- advertises, NULL when none does.
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

CREATE OR REPLACE FUNCTION public.get_server_members_by_instance(p_server_id uuid)
RETURNS TABLE(instance text, member_ids uuid[], member_ap_ids text[], member_count integer)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
  SELECT
    COALESCE(p.domain, 'local') as instance,
    array_agg(p.id) as member_ids,
    array_agg(p.federated_id) as member_ap_ids,
    COUNT(*)::INT as member_count
  FROM user_servers us
  JOIN profiles p ON us.user_id = p.id
  WHERE us.server_id = p_server_id
    AND us.status = 'accepted'
  GROUP BY COALESCE(p.domain, 'local');
$$;

COMMIT;
