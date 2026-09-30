-- Channel visibility follows VIEW_CHANNEL.
--
-- Channel reads and writes checked accepted server membership only, so a member read every
-- channel through PostgREST, including channels VIEW_CHANNEL overrides hide, and posted
-- without SEND_MESSAGES. The same gap reached every other path to channel content:
--
--   messages                 SELECT: VIEW_CHANNEL. INSERT: VIEW_CHANNEL and SEND_MESSAGES; a
--                            thread reply needs SEND_MESSAGES_IN_THREADS and must name its
--                            thread's channel
--   channels                 SELECT: VIEW_CHANNEL; the server owner keeps every row
--   threads                  SELECT was `true`, anon included; now VIEW_CHANNEL. INSERT:
--                            VIEW_CHANNEL and CREATE_PUBLIC_THREADS or CREATE_PRIVATE_THREADS.
--                            UPDATE/DELETE: VIEW_CHANNEL and creator or MANAGE_CHANNELS, the
--                            gate ThreadFullView applies
--   thread_members           SELECT was `true`; now follows the thread
--   reactions                SELECT was `true`, anon included; now follows the message. INSERT
--                            requires a visible message
--   message_search_index     channel rows: VIEW_CHANNEL (search_messages is SECURITY INVOKER)
--   can_subscribe_to_topic   channel-messages-<id>: VIEW_CHANNEL
--   send_notification        a channel-scoped notification reaches only recipients who can view
--                            the channel. Mention, @everyone, role-mention, thread-reply and
--                            reaction notifications all carry a content preview
--   create_thread            VIEW_CHANNEL and a thread-creation permission; a hidden message
--                            reads as absent
--   handle_new_message_unread  no unread row for a member who cannot view the channel
--   broadcast_channel_change, broadcast_thread_change
--                            server-structure:<server> reaches every member; a row of a channel
--                            some member cannot view goes out as ids only
--
-- VIEW_CHANNEL is get_user_permissions(): server owner, then ADMINISTRATOR in the merged role
-- mask, then @everyone, role and member overrides layered in that order. Membership is an
-- accepted user_servers row, or ownership.
--
-- current_user_viewable_channel_ids() is that rule for the caller, set-based; RLS evaluates it
-- once per statement as a hashed subplan. channel_viewer_ids() is the rule for one channel
-- over its members. can_view_channel() is membership plus has_permission(), skipped for a
-- channel channel_is_restricted() proves open. db_schema/tests/
-- 40_rls_convergence_and_channel_view.sql asserts all three agree with has_permission().
--
-- Seeded local DB (2.3M messages, 50 servers, 5,000-member server, one channel per server
-- hidden from @everyone; supabase/postgres 15.8.1.060), best of warm runs, ms, before -> after,
-- member of 6 servers / member of all 50 (451 viewable channels):
--   channel page, 50 of 400k rows       2.6 -> 0.61   3.9 -> 1.5
--   get_message_page(50)                6.8 -> 2.1    8.4 -> 4.3
--   reactions of that page              2.9 -> 0.63   2.7 -> 1.4
--   channel list of a server            2.3 -> 0.99   2.1 -> 1.5
--   count(*) over messages, 2.3M rows   257 -> 203    239 -> 231
--   message insert, open channel        ~190 -> ~190 (unread rows for 5,000 members)
--   message insert, hidden channel      180-450 -> 30 (unread rows for its 50 viewers only)
--   @everyone mention, open channel     1,300 -> 1,600 (5,000 can_view_channel calls)
--   @everyone mention, hidden channel   1,300-2,300 -> 950-1,100

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- VIEW_CHANNEL, set-based and scalar
-- ---------------------------------------------------------------------------

-- plpgsql rather than sql: a non-inlined SQL function is planned on every call, and
-- send_notification() calls can_view_channel() once per recipient. With sql bodies the
-- @everyone mention above took 3,500-4,200 ms.

-- Channels the caller can view. Mirrors get_user_permissions(): bit 0 ADMINISTRATOR, bit 1
-- VIEW_CHANNEL. An override row is the member layer when its user_id is the caller, else the
-- @everyone layer when its role is @everyone, else the role layer.
CREATE OR REPLACE FUNCTION public.current_user_viewable_channel_ids()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH srv AS (
        SELECT us.server_id
          FROM public.user_servers us
         WHERE us.user_id = v_me AND us.status = 'accepted'
        UNION
        SELECT s.id
          FROM public.servers s
         WHERE s.owner = v_me
    ),
    my_roles AS (
        SELECT ur.server_id, ur.role_id
          FROM public.user_roles ur
         WHERE ur.user_id = v_me
    ),
    base AS (
        SELECT srv.server_id,
               s.owner = v_me AS is_owner,
               ev.id AS everyone_id,
               COALESCE(ev.permissions, 0) | COALESCE(rm.mask, 0) AS mask
          FROM srv
          JOIN public.servers s ON s.id = srv.server_id
          LEFT JOIN public.server_roles ev ON ev.server_id = srv.server_id AND ev.is_default = true
          LEFT JOIN (
              SELECT mr.server_id, bit_or(sr.permissions) AS mask
                FROM my_roles mr
                JOIN public.server_roles sr ON sr.id = mr.role_id
               GROUP BY mr.server_id
          ) rm ON rm.server_id = srv.server_id
    ),
    chan AS (
        SELECT c.id, b.server_id, b.is_owner, b.everyone_id, b.mask
          FROM base b
          JOIN public.channels c ON c.server_id = b.server_id
    ),
    ovr AS (
        SELECT l.channel_id,
               COALESCE(bit_or(l.allow_p) FILTER (WHERE l.layer = 1), 0) AS everyone_allow,
               COALESCE(bit_or(l.deny_p)  FILTER (WHERE l.layer = 1), 0) AS everyone_deny,
               COALESCE(bit_or(l.allow_p) FILTER (WHERE l.layer = 2), 0) AS role_allow,
               COALESCE(bit_or(l.deny_p)  FILTER (WHERE l.layer = 2), 0) AS role_deny,
               COALESCE(bit_or(l.allow_p) FILTER (WHERE l.layer = 3), 0) AS user_allow,
               COALESCE(bit_or(l.deny_p)  FILTER (WHERE l.layer = 3), 0) AS user_deny
          FROM (
              SELECT ov.channel_id,
                     CASE WHEN ov.user_id = v_me THEN 3
                          WHEN ov.role_id = chan.everyone_id THEN 1
                          WHEN ov.role_id IS NOT NULL THEN 2
                     END AS layer,
                     COALESCE(ov.allow_permissions, 0) AS allow_p,
                     COALESCE(ov.deny_permissions, 0) AS deny_p
                FROM chan
                JOIN public.channel_permission_overrides ov ON ov.channel_id = chan.id
               WHERE ov.role_id = chan.everyone_id
                  OR ov.user_id = v_me
                  OR EXISTS (SELECT 1 FROM my_roles mr
                              WHERE mr.server_id = chan.server_id AND mr.role_id = ov.role_id)
          ) l
         GROUP BY l.channel_id
    )
    SELECT chan.id
      FROM chan
      LEFT JOIN ovr ON ovr.channel_id = chan.id
     WHERE chan.is_owner
        OR (chan.mask & 1) <> 0
        OR ((((((((chan.mask & ~COALESCE(ovr.everyone_deny, 0)) | COALESCE(ovr.everyone_allow, 0))
                  & ~COALESCE(ovr.role_deny, 0)) | COALESCE(ovr.role_allow, 0))
                  & ~COALESCE(ovr.user_deny, 0)) | COALESCE(ovr.user_allow, 0)) & 2) <> 0);
END;
$$;

-- Policies below are TO public and execute as the querying role; anon needs EXECUTE and gets
-- an empty set.
REVOKE ALL ON FUNCTION public.current_user_viewable_channel_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_viewable_channel_ids() TO anon, authenticated, service_role;

-- Members of the channel's server who can view it. Same rule as above, per member.
-- The internal helpers below are EXECUTE-able by postgres, which owns part of production's
-- SECURITY DEFINER callers.
CREATE OR REPLACE FUNCTION public.channel_viewer_ids(p_channel_id uuid)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    WITH ch AS (
        SELECT c.id, c.server_id, s.owner, ev.id AS everyone_id,
               COALESCE(ev.permissions, 0) AS everyone_mask
          FROM public.channels c
          JOIN public.servers s ON s.id = c.server_id
          LEFT JOIN public.server_roles ev ON ev.server_id = c.server_id AND ev.is_default = true
         WHERE c.id = p_channel_id
    ),
    mem AS (
        SELECT us.user_id
          FROM public.user_servers us
          JOIN ch ON ch.server_id = us.server_id
         WHERE us.status = 'accepted'
        UNION
        SELECT ch.owner FROM ch WHERE ch.owner IS NOT NULL
    ),
    their_roles AS (
        SELECT ur.user_id, ur.role_id
          FROM public.user_roles ur
          JOIN ch ON ch.server_id = ur.server_id
    ),
    mask AS (
        SELECT m.user_id,
               ch.everyone_mask | COALESCE((
                   SELECT bit_or(sr.permissions)
                     FROM their_roles tr
                     JOIN public.server_roles sr ON sr.id = tr.role_id
                    WHERE tr.user_id = m.user_id
               ), 0) AS mask
          FROM mem m
         CROSS JOIN ch
    ),
    ovr AS (
        SELECT l.user_id,
               COALESCE(bit_or(l.allow_p) FILTER (WHERE l.layer = 1), 0) AS everyone_allow,
               COALESCE(bit_or(l.deny_p)  FILTER (WHERE l.layer = 1), 0) AS everyone_deny,
               COALESCE(bit_or(l.allow_p) FILTER (WHERE l.layer = 2), 0) AS role_allow,
               COALESCE(bit_or(l.deny_p)  FILTER (WHERE l.layer = 2), 0) AS role_deny,
               COALESCE(bit_or(l.allow_p) FILTER (WHERE l.layer = 3), 0) AS user_allow,
               COALESCE(bit_or(l.deny_p)  FILTER (WHERE l.layer = 3), 0) AS user_deny
          FROM (
              SELECT m.user_id,
                     CASE WHEN ov.user_id = m.user_id THEN 3
                          WHEN ov.role_id = ch.everyone_id THEN 1
                          WHEN ov.role_id IS NOT NULL THEN 2
                     END AS layer,
                     COALESCE(ov.allow_permissions, 0) AS allow_p,
                     COALESCE(ov.deny_permissions, 0) AS deny_p
                FROM mem m
               CROSS JOIN ch
                JOIN public.channel_permission_overrides ov ON ov.channel_id = ch.id
               WHERE ov.role_id = ch.everyone_id
                  OR ov.user_id = m.user_id
                  OR EXISTS (SELECT 1 FROM their_roles tr
                              WHERE tr.user_id = m.user_id AND tr.role_id = ov.role_id)
          ) l
         GROUP BY l.user_id
    )
    SELECT mk.user_id
      FROM mask mk
     CROSS JOIN ch
      LEFT JOIN ovr ON ovr.user_id = mk.user_id
     WHERE mk.user_id = ch.owner
        OR (mk.mask & 1) <> 0
        OR ((((((((mk.mask & ~COALESCE(ovr.everyone_deny, 0)) | COALESCE(ovr.everyone_allow, 0))
                  & ~COALESCE(ovr.role_deny, 0)) | COALESCE(ovr.role_allow, 0))
                  & ~COALESCE(ovr.user_deny, 0)) | COALESCE(ovr.user_allow, 0)) & 2) <> 0);
END;
$$;

REVOKE ALL ON FUNCTION public.channel_viewer_ids(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.channel_viewer_ids(uuid) TO postgres, service_role;

-- False only when every accepted member can view the channel: @everyone keeps VIEW_CHANNEL
-- after its channel override, and no role or member override denies it. Conservative: true
-- for a missing channel, and for any layout it does not prove open.
CREATE OR REPLACE FUNCTION public.channel_is_restricted(p_channel_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_open boolean;
BEGIN
    SELECT ((((COALESCE(ev.permissions, 0) & ~COALESCE(eo.deny_p, 0)) | COALESCE(eo.allow_p, 0)) & 2) <> 0)
           AND NOT EXISTS (
               SELECT 1 FROM public.channel_permission_overrides o
                WHERE o.channel_id = c.id
                  AND (o.role_id IS DISTINCT FROM ev.id OR o.user_id IS NOT NULL)
                  AND (COALESCE(o.deny_permissions, 0) & 2) <> 0
           )
      INTO v_open
      FROM public.channels c
      LEFT JOIN public.server_roles ev ON ev.server_id = c.server_id AND ev.is_default = true
      LEFT JOIN LATERAL (
          SELECT bit_or(COALESCE(o.allow_permissions, 0)) AS allow_p,
                 bit_or(COALESCE(o.deny_permissions, 0)) AS deny_p
            FROM public.channel_permission_overrides o
           WHERE o.channel_id = c.id AND o.role_id = ev.id AND o.user_id IS NULL
      ) eo ON true
     WHERE c.id = p_channel_id;

    RETURN NOT COALESCE(v_open, false);
END;
$$;

REVOKE ALL ON FUNCTION public.channel_is_restricted(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.channel_is_restricted(uuid) TO postgres, service_role;

-- Accepted membership, or ownership, and VIEW_CHANNEL. has_permission() builds a 30-key jsonb
-- per call; an open channel skips it, since every accepted member can view one.
CREATE OR REPLACE FUNCTION public.can_view_channel(p_user_id uuid, p_channel_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server_id uuid;
    v_owner     uuid;
BEGIN
    SELECT c.server_id, s.owner INTO v_server_id, v_owner
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = p_channel_id;

    IF v_server_id IS NULL OR p_user_id IS NULL THEN
        RETURN false;
    END IF;

    IF v_owner IS DISTINCT FROM p_user_id AND NOT EXISTS (
        SELECT 1 FROM public.user_servers us
         WHERE us.server_id = v_server_id
           AND us.user_id = p_user_id
           AND us.status = 'accepted'
    ) THEN
        RETURN false;
    END IF;

    RETURN NOT public.channel_is_restricted(p_channel_id)
        OR public.has_permission(p_user_id, v_server_id, 'VIEW_CHANNEL', p_channel_id);
END;
$$;

REVOKE ALL ON FUNCTION public.can_view_channel(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_channel(uuid, uuid) TO postgres, service_role;

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "messages_select_channel_member" ON public.messages;
CREATE POLICY "messages_select_channel_member" ON public.messages
    FOR SELECT
    USING (
        (channel_id IS NOT NULL
         AND channel_id IN (SELECT public.current_user_viewable_channel_ids()))
        OR (conversation_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.conversation_participants cp
             WHERE cp.conversation_id = messages.conversation_id
               AND cp.user_id = (SELECT public.get_current_profile_id())
               AND cp.left_at IS NULL
        ))
    );

-- A thread reply names its thread's channel.
DROP POLICY IF EXISTS "messages_insert_member" ON public.messages;
CREATE POLICY "messages_insert_member" ON public.messages
    FOR INSERT
    WITH CHECK (
        user_id = (SELECT public.get_current_profile_id())
        AND (
            (channel_id IS NOT NULL
             AND channel_id IN (SELECT public.current_user_viewable_channel_ids())
             AND (thread_id IS NULL OR EXISTS (
                 SELECT 1 FROM public.threads t
                  WHERE t.id = messages.thread_id AND t.channel_id = messages.channel_id
             ))
             AND public.has_permission(
                 (SELECT public.get_current_profile_id()),
                 (SELECT c.server_id FROM public.channels c WHERE c.id = messages.channel_id),
                 CASE WHEN thread_id IS NULL THEN 'SEND_MESSAGES' ELSE 'SEND_MESSAGES_IN_THREADS' END,
                 channel_id))
            OR (conversation_id IS NOT NULL
                AND EXISTS (
                    SELECT 1 FROM public.conversation_participants cp
                     WHERE cp.conversation_id = messages.conversation_id
                       AND cp.user_id = (SELECT public.get_current_profile_id())
                       AND cp.left_at IS NULL
                )
                AND NOT EXISTS (
                    SELECT 1 FROM public.conversation_participants cp
                     WHERE cp.conversation_id = messages.conversation_id
                       AND cp.user_id <> (SELECT public.get_current_profile_id())
                       AND cp.left_at IS NULL
                       AND public.is_blocked_by(cp.user_id)
                ))
        )
    );

DROP POLICY IF EXISTS "message_search_index_channel_access" ON public.message_search_index;
CREATE POLICY "message_search_index_channel_access" ON public.message_search_index
    FOR SELECT
    USING (
        channel_id IS NOT NULL
        AND channel_id IN (SELECT public.current_user_viewable_channel_ids())
    );

-- ---------------------------------------------------------------------------
-- channels
-- ---------------------------------------------------------------------------

-- The owner branch admits a channel inserted in the same statement, which the function's
-- snapshot does not hold (INSERT ... RETURNING checks SELECT policies against the new row).
DROP POLICY IF EXISTS "channels_select_member" ON public.channels;
CREATE POLICY "channels_select_member" ON public.channels
    FOR SELECT
    USING (
        id IN (SELECT public.current_user_viewable_channel_ids())
        OR EXISTS (
            SELECT 1 FROM public.servers s
             WHERE s.id = channels.server_id
               AND s.owner = (SELECT public.get_current_profile_id())
        )
    );

-- ---------------------------------------------------------------------------
-- threads, thread_members
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "threads_select_member" ON public.threads;
CREATE POLICY "threads_select_member" ON public.threads
    FOR SELECT
    USING (channel_id IN (SELECT public.current_user_viewable_channel_ids()));

DROP POLICY IF EXISTS "threads_insert_member" ON public.threads;
CREATE POLICY "threads_insert_member" ON public.threads
    FOR INSERT
    WITH CHECK (
        created_by = (SELECT public.get_current_profile_id())
        AND channel_id IN (SELECT public.current_user_viewable_channel_ids())
        AND (
            public.has_permission((SELECT public.get_current_profile_id()),
                (SELECT c.server_id FROM public.channels c WHERE c.id = threads.channel_id),
                'CREATE_PUBLIC_THREADS', channel_id)
            OR public.has_permission((SELECT public.get_current_profile_id()),
                (SELECT c.server_id FROM public.channels c WHERE c.id = threads.channel_id),
                'CREATE_PRIVATE_THREADS', channel_id)
        )
    );

DROP POLICY IF EXISTS "threads_update_authorized" ON public.threads;
CREATE POLICY "threads_update_authorized" ON public.threads
    FOR UPDATE
    USING (
        (channel_id IN (SELECT public.current_user_viewable_channel_ids())
         AND (created_by = (SELECT public.get_current_profile_id())
              OR public.has_permission((SELECT public.get_current_profile_id()),
                     (SELECT c.server_id FROM public.channels c WHERE c.id = threads.channel_id),
                     'MANAGE_CHANNELS', channel_id)))
        OR (SELECT public.is_current_user_admin())
    );

DROP POLICY IF EXISTS "threads_delete_authorized" ON public.threads;
CREATE POLICY "threads_delete_authorized" ON public.threads
    FOR DELETE
    USING (
        (channel_id IN (SELECT public.current_user_viewable_channel_ids())
         AND (created_by = (SELECT public.get_current_profile_id())
              OR public.has_permission((SELECT public.get_current_profile_id()),
                     (SELECT c.server_id FROM public.channels c WHERE c.id = threads.channel_id),
                     'MANAGE_CHANNELS', channel_id)))
        OR (SELECT public.is_current_user_admin())
    );

-- thread_members has no channel column; threads RLS decides.
DROP POLICY IF EXISTS "thread_members_select_all" ON public.thread_members;
DROP POLICY IF EXISTS "thread_members_select_visible" ON public.thread_members;
CREATE POLICY "thread_members_select_visible" ON public.thread_members
    FOR SELECT
    USING (EXISTS (SELECT 1 FROM public.threads t WHERE t.id = thread_members.thread_id));

-- ---------------------------------------------------------------------------
-- reactions
-- ---------------------------------------------------------------------------

-- populate_reaction_context() fills channel_id from the message; rows without it defer to
-- messages RLS.
DROP POLICY IF EXISTS "reactions_select_all" ON public.reactions;
DROP POLICY IF EXISTS "reactions_select_visible" ON public.reactions;
CREATE POLICY "reactions_select_visible" ON public.reactions
    FOR SELECT
    USING (
        (channel_id IS NOT NULL
         AND channel_id IN (SELECT public.current_user_viewable_channel_ids()))
        OR (channel_id IS NULL
            AND EXISTS (SELECT 1 FROM public.messages m WHERE m.id = reactions.message_id))
    );

DROP POLICY IF EXISTS "reactions_insert_own" ON public.reactions;
CREATE POLICY "reactions_insert_own" ON public.reactions
    FOR INSERT
    WITH CHECK (
        user_id = (SELECT public.get_current_profile_id())
        AND EXISTS (SELECT 1 FROM public.messages m WHERE m.id = reactions.message_id)
        AND NOT public.is_blocked_by((SELECT m.user_id FROM public.messages m WHERE m.id = reactions.message_id))
    );

-- ---------------------------------------------------------------------------
-- Realtime: channel-messages-<channel_id>
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_subscribe_to_topic(p_topic text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_profile_id uuid;
  v_id         uuid;
BEGIN
  IF p_topic IS NULL THEN
    RETURN false;
  END IF;

  v_profile_id := public.get_current_profile_id();
  IF v_profile_id IS NULL THEN
    RETURN false;
  END IF;

  IF p_topic LIKE 'dm-conversation-%' THEN
    BEGIN
      v_id := substring(p_topic from 17)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN public.is_conversation_participant(v_id, v_profile_id);
  END IF;

  -- Replaces messages_select_channel_member for delivery: accepted membership and
  -- VIEW_CHANNEL.
  IF p_topic LIKE 'channel-messages-%' THEN
    BEGIN
      v_id := substring(p_topic from 18)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN public.can_view_channel(v_profile_id, v_id);
  END IF;

  IF p_topic LIKE 'server-presence:%' OR p_topic LIKE 'server-structure:%' THEN
    BEGIN
      v_id := split_part(p_topic, ':', 2)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN EXISTS (
      SELECT 1 FROM public.user_servers
      WHERE server_id = v_id
        AND user_id = v_profile_id
        AND status = 'accepted'
    );
  END IF;

  IF p_topic LIKE 'user:%' THEN
    BEGIN
      v_id := substring(p_topic from 6)::uuid;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN v_id = v_profile_id;
  END IF;

  -- Feed topics carry only public, non-deleted posts: broadcast_post_event
  -- gates every send on visibility = 'public'. No per-user check applies.
  IF p_topic IN ('feed:public', 'feed:local')
     OR p_topic LIKE 'feed:user:%'
     OR p_topic LIKE 'feed:hashtag:%' THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$function$;

-- server-structure:<server> reaches every accepted member. A channel some member cannot view
-- goes out as ids, flagged restricted; its row is read back through channels RLS.
CREATE OR REPLACE FUNCTION public.broadcast_channel_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_server     uuid;
  v_restricted boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_server := OLD.server_id;
  ELSE
    v_server := NEW.server_id;
  END IF;

  -- AFTER DELETE: the row is gone and reads as restricted.
  v_restricted := public.channel_is_restricted(COALESCE(NEW.id, OLD.id));

  IF v_restricted THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'channel:' || lower(TG_OP),
        'restricted', true,
        'new', CASE WHEN TG_OP != 'DELETE' THEN jsonb_build_object(
                 'id', NEW.id, 'server_id', NEW.server_id, 'category', NEW.category,
                 'type', NEW.type, 'order', NEW."order") ELSE NULL END,
        'old', CASE WHEN TG_OP != 'INSERT' THEN jsonb_build_object(
                 'id', OLD.id, 'server_id', OLD.server_id, 'category', OLD.category,
                 'type', OLD.type, 'order', OLD."order") ELSE NULL END
      ),
      'server_event',
      'server-structure:' || v_server::text,
      true
    );
  ELSE
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'channel:' || lower(TG_OP),
        'new', CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
        'old', CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
      ),
      'server_event',
      'server-structure:' || v_server::text,
      true
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_channel_change failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- A thread in a channel some member cannot view goes out as ids, flagged restricted.
CREATE OR REPLACE FUNCTION public.broadcast_thread_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_channel_id uuid;
  v_server_id  uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_channel_id := OLD.channel_id;
  ELSE
    v_channel_id := NEW.channel_id;
  END IF;

  SELECT server_id INTO v_server_id
  FROM channels
  WHERE id = v_channel_id;

  IF v_server_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF public.channel_is_restricted(v_channel_id) THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'thread:' || lower(TG_OP),
        'restricted', true,
        'new', CASE WHEN TG_OP != 'DELETE' THEN jsonb_build_object(
                 'id', NEW.id, 'channel_id', NEW.channel_id) ELSE NULL END,
        'old', CASE WHEN TG_OP != 'INSERT' THEN jsonb_build_object(
                 'id', OLD.id, 'channel_id', OLD.channel_id) ELSE NULL END
      ),
      'server_event',
      'server-structure:' || v_server_id::text,
      true
    );
  ELSE
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'thread:' || lower(TG_OP),
        'new', CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
        'old', CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
      ),
      'server_event',
      'server-structure:' || v_server_id::text,
      true
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- ---------------------------------------------------------------------------
-- create_thread
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_thread(p_message_id uuid, p_name text, p_auto_archive_duration integer DEFAULT 1440)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_thread_id uuid;
    v_channel_id uuid;
    v_server_id uuid;
    v_caller_profile_id uuid;
BEGIN
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();

    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    SELECT m.channel_id, c.server_id INTO v_channel_id, v_server_id
      FROM messages m
      JOIN channels c ON c.id = m.channel_id
     WHERE m.id = p_message_id;

    -- A message in a channel the caller cannot view reads as absent.
    IF v_channel_id IS NULL OR NOT public.can_view_channel(v_caller_profile_id, v_channel_id) THEN
        RAISE EXCEPTION 'Message not found or not in a channel';
    END IF;

    IF NOT (public.has_permission(v_caller_profile_id, v_server_id, 'CREATE_PUBLIC_THREADS', v_channel_id)
            OR public.has_permission(v_caller_profile_id, v_server_id, 'CREATE_PRIVATE_THREADS', v_channel_id)) THEN
        RAISE EXCEPTION 'Unauthorized: CREATE_PUBLIC_THREADS or CREATE_PRIVATE_THREADS required';
    END IF;

    -- One thread per message. threads.parent_message_id carries no unique index; the lock
    -- serialises concurrent calls for the same message.
    PERFORM pg_advisory_xact_lock(hashtext('create_thread:' || p_message_id::text));
    IF EXISTS (SELECT 1 FROM threads WHERE parent_message_id = p_message_id) THEN
        RAISE EXCEPTION 'Thread already exists for this message';
    END IF;

    INSERT INTO threads (
        channel_id, parent_message_id, name, created_by, auto_archive_duration
    ) VALUES (
        v_channel_id, p_message_id, p_name, v_caller_profile_id, p_auto_archive_duration
    ) RETURNING id INTO v_thread_id;

    INSERT INTO thread_members (thread_id, user_id)
    VALUES (v_thread_id, v_caller_profile_id);

    -- The parent message's author joins with the creator, when it can view the channel.
    INSERT INTO thread_members (thread_id, user_id)
    SELECT v_thread_id, m.user_id
      FROM messages m
     WHERE m.id = p_message_id
       AND m.user_id IS NOT NULL
       AND m.user_id <> v_caller_profile_id
       AND public.can_view_channel(m.user_id, v_channel_id)
    ON CONFLICT (thread_id, user_id) DO NOTHING;

    UPDATE threads
       SET member_count = (SELECT count(*) FROM thread_members WHERE thread_id = v_thread_id)
     WHERE id = v_thread_id;

    RETURN v_thread_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Unread counts
-- ---------------------------------------------------------------------------

-- An open channel skips channel_viewer_ids(): every accepted member can view it.
CREATE OR REPLACE FUNCTION public.handle_new_message_unread()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_server_id  uuid;
    v_restricted boolean;
BEGIN
    IF NEW.channel_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT server_id INTO v_server_id
    FROM public.channels WHERE id = NEW.channel_id;

    IF v_server_id IS NULL THEN
        RETURN NEW;
    END IF;

    v_restricted := public.channel_is_restricted(NEW.channel_id);

    INSERT INTO public.unread_counts (user_id, server_id, channel_id, unread_messages)
    SELECT us.user_id, v_server_id, NEW.channel_id, 1
    FROM public.user_servers us
    WHERE us.server_id = v_server_id
      AND us.status = 'accepted'
      AND (NEW.user_id IS NULL OR us.user_id <> NEW.user_id)
      AND (NOT v_restricted OR us.user_id IN (SELECT public.channel_viewer_ids(NEW.channel_id)))
      AND NOT EXISTS (
          SELECT 1 FROM public.notification_channels nc
          WHERE nc.user_id = us.user_id
            AND nc.channel_id = NEW.channel_id
            AND nc.muted = true
            AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
      )
    ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL
    DO UPDATE SET
        unread_messages = unread_counts.unread_messages + 1,
        updated_at = now();

    RETURN NEW;
END;
$function$;

-- Unread rows already written for members who cannot view the channel.
DO $$
DECLARE
    v_channel uuid;
    v_deleted bigint := 0;
    v_n       bigint;
BEGIN
    FOR v_channel IN
        SELECT c.id
          FROM public.channels c
         WHERE EXISTS (SELECT 1 FROM public.unread_counts u WHERE u.channel_id = c.id)
           AND public.channel_is_restricted(c.id)
    LOOP
        DELETE FROM public.unread_counts u
         WHERE u.channel_id = v_channel
           AND u.user_id NOT IN (SELECT public.channel_viewer_ids(v_channel));
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_deleted := v_deleted + v_n;
    END LOOP;
    RAISE NOTICE 'unread_counts: % rows removed for channels their user cannot view', v_deleted;
END;
$$;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.send_notification(p_notification_type character varying, to_user_ids uuid[], notification_data jsonb DEFAULT '{}'::jsonb, p_server_id uuid DEFAULT NULL::uuid, p_channel_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid, p_from_user_id uuid DEFAULT NULL::uuid, p_priority character varying DEFAULT 'normal'::character varying)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    created_notification_ids uuid[] := '{}';
    recipient_id uuid;
    user_prefs record;
    should_send boolean;
    notification_id uuid;
    current_timestamp timestamp with time zone := now();
    enhanced_data jsonb;
    is_blocked boolean;
    is_muted boolean;
    is_channel_muted boolean;
    v_muted_until timestamp with time zone;
    is_rate_limited boolean;
    is_activitypub_type boolean;
    v_time_threshold timestamp with time zone := NOW() - INTERVAL '2 minutes';
    v_notification_level varchar(20);
    v_server_default varchar(20);
    v_is_mention_type boolean;
    v_is_content_feedback_type boolean;
BEGIN
    IF p_notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    is_activitypub_type := p_notification_type LIKE 'activitypub_%';
    v_is_mention_type := p_notification_type IN ('mention', 'activitypub_mention');
    -- Reactions / favorites / reblogs are about the recipient's own message or post;
    -- allow them when a channel is set to "mentions only" (general chat noise stays off).
    v_is_content_feedback_type := p_notification_type IN (
        'reaction', 'activitypub_reaction', 'activitypub_favorite', 'activitypub_reblog'
    );

    FOREACH recipient_id IN ARRAY to_user_ids LOOP
        IF p_from_user_id IS NOT NULL AND recipient_id = p_from_user_id THEN
            CONTINUE;
        END IF;

        -- Check if sender is blocked by recipient
        IF p_from_user_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 FROM user_blocks ub
                WHERE ub.blocker_id = recipient_id
                AND ub.blocked_user_id = p_from_user_id
                AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
            ) INTO is_blocked;
            IF is_blocked THEN CONTINUE; END IF;
        END IF;

        -- Check if sender is muted by recipient
        IF p_from_user_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 FROM user_mutes um
                WHERE um.muter_id = recipient_id
                AND um.muted_user_id = p_from_user_id
                AND um.hide_notifications = true
                AND (um.expires_at IS NULL OR um.expires_at > NOW())
            ) INTO is_muted;
            IF is_muted THEN CONTINUE; END IF;
        END IF;

        -- Server-scoped notifications require current membership: users who left
        -- (or are pending/banned) get nothing for reactions/replies/mentions there
        IF p_server_id IS NOT NULL THEN
            IF NOT EXISTS (
                SELECT 1 FROM user_servers us
                WHERE us.server_id = p_server_id
                AND us.user_id = recipient_id
                AND COALESCE(us.status, 'accepted') = 'accepted'
            ) THEN
                CONTINUE;
            END IF;
        END IF;

        -- Channel-scoped notifications carry channel content: VIEW_CHANNEL.
        IF p_channel_id IS NOT NULL AND NOT public.can_view_channel(recipient_id, p_channel_id) THEN
            CONTINUE;
        END IF;

        -- Check channel/conversation mute + notification level
        IF p_channel_id IS NOT NULL OR p_conversation_id IS NOT NULL THEN
            SELECT nc.muted, nc.notification_level, nc.muted_until
            INTO is_channel_muted, v_notification_level, v_muted_until
            FROM notification_channels nc
            WHERE nc.user_id = recipient_id
            AND (
                (p_channel_id IS NOT NULL AND nc.channel_id = p_channel_id)
                OR
                (p_conversation_id IS NOT NULL AND nc.conversation_id = p_conversation_id)
            )
            LIMIT 1;

            -- Check if temporary mute has expired
            IF COALESCE(is_channel_muted, false) = true
               AND v_muted_until IS NOT NULL
               AND v_muted_until <= NOW() THEN
                is_channel_muted := false;
            END IF;

            -- Muted channel: skip everything EXCEPT mentions (Discord behavior)
            IF COALESCE(is_channel_muted, false) = true THEN
                IF NOT v_is_mention_type THEN
                    CONTINUE;
                END IF;
            END IF;

            -- Notification level enforcement (only for channels, not conversations).
            -- Fallback is 'mentions' (was 'all') so new channels notify only on
            -- @mentions by default. See 20260520_default_notification_level_mentions.sql.
            IF p_channel_id IS NOT NULL AND v_notification_level IS NULL THEN
                SELECT ss.default_message_notifications INTO v_server_default
                FROM server_settings ss
                WHERE ss.server_id = p_server_id;
                v_notification_level := COALESCE(v_server_default, 'mentions');
            END IF;

            IF v_notification_level = 'none' THEN
                CONTINUE;
            ELSIF v_notification_level = 'mentions' THEN
                IF NOT v_is_mention_type AND NOT v_is_content_feedback_type THEN
                    CONTINUE;
                END IF;
            END IF;
        END IF;

        -- View-context suppression
        IF (p_server_id IS NOT NULL AND p_channel_id IS NOT NULL) OR p_conversation_id IS NOT NULL THEN
            IF public.is_user_viewing_context(recipient_id, p_server_id, p_channel_id, p_conversation_id) THEN
                CONTINUE;
            END IF;
        END IF;

        -- Rate limit reaction notifications (sliding window: resets after 2 min of quiet)
        IF p_from_user_id IS NOT NULL AND p_notification_type IN ('reaction', 'activitypub_reaction') THEN
            INSERT INTO notification_rate_limits (user_id, notification_type, source_user_id,
                                                  notification_count, last_notification_at, suppressed_until)
            VALUES (recipient_id, p_notification_type, p_from_user_id, 1, NOW(), NULL)
            ON CONFLICT (user_id, notification_type, source_user_id)
            DO UPDATE SET
                notification_count = CASE
                    WHEN notification_rate_limits.last_notification_at < v_time_threshold
                    THEN 1
                    ELSE notification_rate_limits.notification_count + 1
                END,
                last_notification_at = NOW(),
                suppressed_until = CASE
                    WHEN notification_rate_limits.last_notification_at < v_time_threshold
                    THEN NULL
                    ELSE notification_rate_limits.suppressed_until
                END;

            SELECT
                nrl.notification_count > 3 OR
                (nrl.suppressed_until IS NOT NULL AND nrl.suppressed_until > NOW())
            INTO is_rate_limited
            FROM notification_rate_limits nrl
            WHERE nrl.user_id = recipient_id
              AND nrl.notification_type = p_notification_type
              AND nrl.source_user_id = p_from_user_id;

            IF is_rate_limited THEN
                UPDATE notification_rate_limits nrl
                SET suppressed_until = NOW() + INTERVAL '2 minutes'
                WHERE nrl.user_id = recipient_id
                  AND nrl.notification_type = p_notification_type
                  AND nrl.source_user_id = p_from_user_id;
                CONTINUE;
            END IF;
        END IF;

        -- Get user notification preferences
        user_prefs := NULL;
        BEGIN
            SELECT * INTO user_prefs FROM notification_preferences WHERE user_id = recipient_id;
        EXCEPTION
            WHEN undefined_table THEN
                user_prefs := NULL;
        END;

        should_send := true;

        IF user_prefs IS NOT NULL THEN
            IF is_activitypub_type THEN
                IF COALESCE(user_prefs.activitypub_notifications, true) = false THEN
                    should_send := false;
                ELSE
                    CASE p_notification_type
                        WHEN 'activitypub_follow' THEN
                            should_send := COALESCE(user_prefs.activitypub_follows, true);
                        WHEN 'activitypub_follow_request' THEN
                            should_send := COALESCE(user_prefs.activitypub_follow_requests, true);
                        WHEN 'activitypub_favorite' THEN
                            should_send := COALESCE(user_prefs.activitypub_favorites, true);
                        WHEN 'activitypub_reblog' THEN
                            should_send := COALESCE(user_prefs.activitypub_reblogs, true);
                        WHEN 'activitypub_mention' THEN
                            should_send := COALESCE(user_prefs.activitypub_mentions, true);
                        WHEN 'activitypub_reply' THEN
                            should_send := COALESCE(user_prefs.activitypub_replies, true);
                        WHEN 'activitypub_reaction' THEN
                            should_send := COALESCE(user_prefs.activitypub_favorites, true);
                        ELSE
                            should_send := true;
                    END CASE;
                END IF;
            ELSE
                IF COALESCE(user_prefs.desktop_notifications, true) = false THEN
                    IF p_notification_type NOT IN ('mention', 'dm') THEN
                        should_send := false;
                    END IF;
                END IF;

                IF should_send THEN
                    CASE p_notification_type
                        WHEN 'mention' THEN
                            should_send := COALESCE(user_prefs.desktop_mentions, true);
                        WHEN 'reply' THEN
                            should_send := COALESCE(user_prefs.desktop_replies, true);
                        WHEN 'dm' THEN
                            should_send := COALESCE(user_prefs.desktop_dms, true);
                        WHEN 'chat_message' THEN
                            should_send := COALESCE(user_prefs.desktop_chat_messages, true);
                        WHEN 'reaction' THEN
                            should_send := COALESCE(user_prefs.desktop_reactions, true);
                        WHEN 'voice_channel_activity' THEN
                            should_send := COALESCE(user_prefs.sound_voice_activity, true);
                        WHEN 'server_invite' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'friend_request' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'server_update' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'emoji_added' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'thread_reply' THEN
                            should_send := COALESCE(user_prefs.desktop_replies, true);
                        ELSE
                            should_send := true;
                    END CASE;
                END IF;
            END IF;

            -- DND enforcement
            IF user_prefs.dnd_enabled IS TRUE AND should_send THEN
                DECLARE
                    current_time_of_day time := current_timestamp::time;
                    dnd_start time := COALESCE(user_prefs.dnd_start_time, '22:00'::time);
                    dnd_end time := COALESCE(user_prefs.dnd_end_time, '08:00'::time);
                BEGIN
                    IF dnd_start > dnd_end THEN
                        IF current_time_of_day >= dnd_start OR current_time_of_day <= dnd_end THEN
                            should_send := false;
                        END IF;
                    ELSE
                        IF current_time_of_day >= dnd_start AND current_time_of_day <= dnd_end THEN
                            should_send := false;
                        END IF;
                    END IF;
                END;
            END IF;
        END IF;

        -- Build enhanced data
        enhanced_data := notification_data;
        IF p_server_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('server_id', p_server_id);
        END IF;
        IF p_channel_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('channel_id', p_channel_id);
        END IF;
        IF p_conversation_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('conversation_id', p_conversation_id);
        END IF;
        IF p_from_user_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('from_user_id', p_from_user_id);
        END IF;
        IF p_priority IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('priority', p_priority);
        END IF;

        IF should_send THEN
            INSERT INTO notifications (type, user_id, data, created_at)
            VALUES (p_notification_type, recipient_id, enhanced_data, current_timestamp)
            RETURNING id INTO notification_id;

            created_notification_ids := array_append(created_notification_ids, notification_id);
        END IF;

    END LOOP;

    RETURN created_notification_ids;
END;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';
