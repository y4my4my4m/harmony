-- What other instances read of a local server's channels.
--
-- A member instance keeps one copy of a server for all of its users: channels and messages
-- delivered to it, or fetched under one member's signature, are shown to every local member of
-- that copy. An instance therefore receives a channel only when every accepted, unbanned
-- member it hosts can view the channel:
--   federation_channel_recipients   an instance's group is dropped when any of its members
--                                   lacks VIEW_CHANNEL (suspended members and members without
--                                   a federated_id count; they are still members there).
--   federation_group_access         member_channel_ids keeps a channel only when every member
--                                   on the signer's instance views it. A channel @everyone
--                                   views with no VIEW_CHANNEL deny on any role or member
--                                   skips the per-member scan.
-- federation_room_media_access reads federation_channel_recipients, so attachments follow.
--
-- federation_history_cutoffs(server, actor) -> {channel id: earliest created_at served} for the
-- channels a reader holds without READ_MESSAGE_HISTORY (bit 22): a signed member from the time
-- its membership was accepted, an anonymous reader nothing ('infinity'). Same rule as
-- current_user_history_cutoffs for local members, without channel_history_views.
--
-- federation_media_access: a room object named only by deleted messages is not served, as
-- message_media_readable decides for local members.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.federation_channel_recipients(p_channel_id uuid)
 RETURNS TABLE(instance text, member_ap_ids text[], member_count integer, shared_inbox text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
    WITH members AS (
        SELECT lower(p.domain) AS instance, p.federated_id, p.shared_inbox_url,
               p.is_suspended IS NOT TRUE AND p.federated_id IS NOT NULL AS addressable,
               public.has_permission(p.id, c.server_id, 'VIEW_CHANNEL', c.id) AS can_view
          FROM public.channels c
          JOIN public.servers s ON s.id = c.server_id AND s.federation_enabled IS TRUE
          JOIN public.user_servers us ON us.server_id = c.server_id AND us.status = 'accepted'
          JOIN public.profiles p ON p.id = us.user_id
         WHERE c.id = p_channel_id
           AND p.is_local IS FALSE
           AND NOT EXISTS (
                SELECT 1 FROM public.server_bans b
                 WHERE b.server_id = c.server_id AND b.user_id = p.id
           )
    )
    SELECT m.instance,
           array_agg(m.federated_id ORDER BY m.federated_id) FILTER (WHERE m.addressable) AS member_ap_ids,
           (count(*) FILTER (WHERE m.addressable))::integer AS member_count,
           (array_agg(m.shared_inbox_url ORDER BY m.shared_inbox_url)
                FILTER (WHERE m.addressable AND m.shared_inbox_url IS NOT NULL))[1] AS shared_inbox
      FROM members m
     GROUP BY m.instance
    HAVING bool_and(m.can_view) AND count(*) FILTER (WHERE m.addressable) > 0;
$function$;

REVOKE ALL ON FUNCTION public.federation_channel_recipients(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.federation_channel_recipients(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.federation_group_access(p_server_id uuid, p_actor_ap_id text DEFAULT NULL::text)
 RETURNS TABLE(is_public boolean, member_id uuid, everyone_channel_ids uuid[], member_channel_ids uuid[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_public boolean;
    v_local boolean;
    v_federated boolean;
    v_member uuid;
    v_member_domain text;
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
        SELECT p.id, lower(p.domain) INTO v_member, v_member_domain
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
    WITH everyone AS (
        SELECT c.id
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
    ),
    domain_members AS (
        SELECT p.id
          FROM public.user_servers us
          JOIN public.profiles p ON p.id = us.user_id
         WHERE v_member IS NOT NULL
           AND us.server_id = p_server_id
           AND us.status = 'accepted'
           AND p.is_local IS FALSE
           AND lower(p.domain) IS NOT DISTINCT FROM v_member_domain
           AND p.id <> v_member
           AND NOT EXISTS (
                SELECT 1 FROM public.server_bans b
                 WHERE b.server_id = p_server_id AND b.user_id = p.id
           )
    )
    SELECT
        COALESCE(v_public, false),
        v_member,
        COALESCE((SELECT array_agg(e.id ORDER BY e.id) FROM everyone e), '{}'::uuid[]),
        CASE WHEN v_member IS NULL THEN '{}'::uuid[] ELSE COALESCE((
            SELECT array_agg(c.id ORDER BY c.id)
              FROM public.channels c
             WHERE c.server_id = p_server_id
               AND c.is_remote IS NOT TRUE
               AND public.has_permission(v_member, p_server_id, 'VIEW_CHANNEL', c.id)
               AND (
                    -- Viewed by @everyone and denied to no role or member: every member views it.
                    (c.id IN (SELECT e.id FROM everyone e)
                     AND NOT EXISTS (
                         SELECT 1 FROM public.channel_permission_overrides o
                          WHERE o.channel_id = c.id
                            AND (o.deny_permissions & 2) <> 0
                            AND o.role_id IS DISTINCT FROM v_everyone_role))
                    OR NOT EXISTS (
                         SELECT 1 FROM domain_members dm
                          WHERE NOT public.has_permission(dm.id, p_server_id, 'VIEW_CHANNEL', c.id))
               )
        ), '{}'::uuid[]) END;
END;
$function$;

REVOKE ALL ON FUNCTION public.federation_group_access(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.federation_group_access(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.federation_history_cutoffs(p_server_id uuid, p_actor_ap_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_member uuid;
    v_joined timestamptz;
    v_everyone_role uuid;
    v_everyone_perms bigint;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'federation_history_cutoffs is for service callers' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE AND s.federation_enabled IS TRUE) THEN
        RETURN '{}'::jsonb;
    END IF;

    IF p_actor_ap_id IS NOT NULL THEN
        SELECT p.id, us.created_at INTO v_member, v_joined
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

    IF v_member IS NOT NULL THEN
        RETURN COALESCE((
            SELECT jsonb_object_agg(c.id, COALESCE(v_joined, 'infinity'::timestamptz))
              FROM public.channels c
             WHERE c.server_id = p_server_id
               AND c.is_remote IS NOT TRUE
               AND NOT public.has_permission(v_member, p_server_id, 'READ_MESSAGE_HISTORY', c.id)
        ), '{}'::jsonb);
    END IF;

    SELECT r.id, COALESCE(r.permissions, 0) INTO v_everyone_role, v_everyone_perms
      FROM public.server_roles r
     WHERE r.server_id = p_server_id AND r.is_default = true
     LIMIT 1;
    v_everyone_perms := COALESCE(v_everyone_perms, 0);
    IF (v_everyone_perms & 1) <> 0 THEN
        RETURN '{}'::jsonb;
    END IF;

    RETURN COALESCE((
        SELECT jsonb_object_agg(c.id, 'infinity'::timestamptz)
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
           AND (((v_everyone_perms & ~COALESCE(ov.deny_p, 0)) | COALESCE(ov.allow_p, 0)) & 4194304) = 0
    ), '{}'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.federation_history_cutoffs(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.federation_history_cutoffs(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.federation_media_access(p_name text, p_domain text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_kind text := split_part(p_name, '/', 1);
    v_room text := split_part(p_name, '/', 2);
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'federation_media_access is for service callers' USING ERRCODE = '42501';
    END IF;
    IF p_domain IS NULL OR btrim(p_domain) = '' THEN
        RETURN false;
    END IF;

    IF EXISTS (SELECT 1 FROM public.drive_files f
                WHERE f.bucket = 'message_media' AND f.path = p_name
                  AND f.state NOT IN ('drive', 'ephemeral')) THEN
        RETURN false;
    END IF;

    -- Named by messages, all of them deleted: gone from the room, as for local members.
    IF EXISTS (SELECT 1 FROM public.messages m
                WHERE public.message_media_refs(m.content, m.media_paths) @> ARRAY[p_name]
                  AND m.is_deleted IS TRUE)
       AND NOT EXISTS (SELECT 1 FROM public.messages m
                        WHERE public.message_media_refs(m.content, m.media_paths) @> ARRAY[p_name]
                          AND m.is_deleted IS NOT TRUE) THEN
        RETURN false;
    END IF;

    IF v_kind IN ('c', 'd')
       AND v_room ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND public.federation_room_media_access(v_kind, v_room::uuid, p_domain) THEN
        RETURN true;
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM public.messages m
         WHERE public.message_media_refs(m.content, m.media_paths) @> ARRAY[p_name]
           AND m.is_deleted IS NOT TRUE
           AND public.federation_room_media_access(
                   CASE WHEN m.channel_id IS NOT NULL THEN 'c' ELSE 'd' END,
                   coalesce(m.channel_id, m.conversation_id),
                   p_domain));
END;
$function$;

REVOKE ALL ON FUNCTION public.federation_media_access(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.federation_media_access(text, text) TO service_role;

COMMIT;
