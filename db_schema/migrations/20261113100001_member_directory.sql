-- Server members read by range, by search and by id, never as a whole list.
--
-- server_member_stats(server_id, member_count)
--   Accepted members of a server. Statement triggers on user_servers keep it on insert and
--   delete, a row trigger on a change of status or server. Backfilled here. servers.member_count
--   is not used for it: every UPDATE of a servers row sends one broadcast per member
--   (broadcast_server_change_event).
-- get_server_member_counts(ids)
--   Reads server_member_stats; signature and visibility rule unchanged. Counted accepted,
--   pending and banned rows before.
-- get_server_member_list(server, offset, limit, query)
--   One JSON object: total, groups in display order with counts, and the members of
--   [offset, offset + limit) in that order. Groups as the member sidebar draws them: a present
--   member under its highest hoisted role, else online, away or busy; an absent one under
--   federated (remote account) or offline. Order in a group: display name, then username, then
--   id, names compared as browsers compare them (collation member_name). query keeps members
--   whose username or display name contains it. limit is 1 to 200.
--   The caller is listed where others will see it, in a list of any length: by the status it
--   chose, at once, offline while invisible. Other members by published presence, absent for
--   one who blocks the caller.
--   A server of at most 200 members, a query, and a caller some member blocks are answered
--   from the tables. A longer list is answered from server_member_order, the same order for
--   every caller, with the caller moved to its own place (server_member_order_for):
--   max_age_ms says how old that order may be (0 for an answer from the tables). live says
--   whether presence:update reaches server-presence:<server> for this server.
-- server_member_order(server_id, member_ids, groups, ...)
--   The order of a server's list, built when a list is read and the order held is older than
--   5 s or 20 times its build time. One builder at a time per server. Unlogged: lost in a
--   crash and built again on the next read.
-- presence_publish
--   20261006800001 minus one thing: a server of more than 1000 members gets no
--   presence:update on server-presence:<server>. One change went to every subscriber of every
--   server of the profile, so a large server cost its member count squared. Its lists are read
--   again on a timer (live false). DM partners and smaller servers are told as before.
-- search_server_members(server, query, limit)
--   Members whose username or display name contains query: exact first, then prefix, then the
--   rest. limit is 1 to 50.
-- get_server_member_roles(server, ids)
--   {profile id: [role id]} for up to 200 members, default role left out.
-- get_server_role_member_counts(server)
--   {role id: members}. The default role counts every accepted member.
-- Each is refused (42501) to a caller who is neither an accepted member nor instance staff
-- with the admin flag. Each answers one row, so a PostgREST row cap cuts none of them.
-- get_room_member_id_list(room)
--   get_room_member_ids as one uuid[]: the members a Megolm session is shared with, whole.
-- A user_servers row with a NULL status is an accepted member here, as it is to
-- current_user_server_ids.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.server_member_stats (
    server_id    uuid PRIMARY KEY REFERENCES public.servers(id) ON DELETE CASCADE,
    member_count integer NOT NULL DEFAULT 0,
    CONSTRAINT server_member_stats_count_check CHECK (member_count >= 0)
);

ALTER TABLE public.server_member_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.server_member_stats FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.server_member_stats TO service_role;
DROP POLICY IF EXISTS server_member_stats_service_role ON public.server_member_stats;
CREATE POLICY server_member_stats_service_role ON public.server_member_stats
    TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.server_member_stats IS
'Accepted members per server, kept by triggers on user_servers. Read through get_server_member_counts.';

-- Servers in id order: two statements that touch the same servers lock them in one order.
CREATE OR REPLACE FUNCTION public.server_member_stats_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.server_member_stats AS s (server_id, member_count)
    SELECT n.server_id, count(*)::integer
      FROM new_rows n
     WHERE COALESCE(n.status, 'accepted') = 'accepted'
     GROUP BY n.server_id
     ORDER BY n.server_id
    ON CONFLICT (server_id) DO UPDATE SET member_count = s.member_count + EXCLUDED.member_count;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.server_member_stats_on_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.server_member_stats s
       SET member_count = greatest(s.member_count - d.gone, 0)
      FROM (SELECT o.server_id, count(*)::integer AS gone
              FROM old_rows o
             WHERE COALESCE(o.status, 'accepted') = 'accepted'
             GROUP BY o.server_id
             ORDER BY o.server_id) d
     WHERE s.server_id = d.server_id;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.server_member_stats_on_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF COALESCE(OLD.status, 'accepted') = 'accepted' THEN
        UPDATE public.server_member_stats s
           SET member_count = greatest(s.member_count - 1, 0)
         WHERE s.server_id = OLD.server_id;
    END IF;
    IF COALESCE(NEW.status, 'accepted') = 'accepted' THEN
        INSERT INTO public.server_member_stats AS s (server_id, member_count)
        VALUES (NEW.server_id, 1)
        ON CONFLICT (server_id) DO UPDATE SET member_count = s.member_count + 1;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_user_servers_member_stats_insert ON public.user_servers;
CREATE TRIGGER z_user_servers_member_stats_insert
    AFTER INSERT ON public.user_servers
    REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.server_member_stats_on_insert();

DROP TRIGGER IF EXISTS z_user_servers_member_stats_delete ON public.user_servers;
CREATE TRIGGER z_user_servers_member_stats_delete
    AFTER DELETE ON public.user_servers
    REFERENCING OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION public.server_member_stats_on_delete();

-- A transition-table trigger takes no column list; this one fires for the two columns only.
DROP TRIGGER IF EXISTS z_user_servers_member_stats_update ON public.user_servers;
CREATE TRIGGER z_user_servers_member_stats_update
    AFTER UPDATE OF status, server_id ON public.user_servers
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.server_id IS DISTINCT FROM NEW.server_id)
    EXECUTE FUNCTION public.server_member_stats_on_update();

-- CREATE TRIGGER holds user_servers against writers until commit: the count below is exact.
INSERT INTO public.server_member_stats (server_id, member_count)
SELECT s.id, count(us.id)::integer
  FROM public.servers s
  LEFT JOIN public.user_servers us ON us.server_id = s.id AND COALESCE(us.status, 'accepted') = 'accepted'
 GROUP BY s.id
ON CONFLICT (server_id) DO UPDATE SET member_count = EXCLUDED.member_count
 WHERE server_member_stats.member_count IS DISTINCT FROM EXCLUDED.member_count;

CREATE OR REPLACE FUNCTION public.get_server_member_counts(p_server_ids uuid[])
RETURNS TABLE (server_id uuid, member_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH visible AS (
    SELECT s.id
      FROM public.servers s
     WHERE s.id = ANY(p_server_ids)
       AND (s.public IS TRUE
            OR s.owner = public.get_current_profile_id()
            OR s.id IN (SELECT public.current_user_server_ids())
            OR public.is_current_user_admin())
  )
  SELECT w.sid AS server_id, COALESCE(st.member_count, 0)::bigint AS member_count
    FROM unnest(p_server_ids) AS w(sid)
    LEFT JOIN visible v ON v.id = w.sid
    LEFT JOIN public.server_member_stats st ON st.server_id = v.id;
$$;

-- The caller's profile when it may read the members of p_server_id; raises otherwise.
CREATE OR REPLACE FUNCTION public.server_member_reader(p_server_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL OR p_server_id IS NULL THEN
        RAISE EXCEPTION 'server members: not signed in' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = v_me
                      AND COALESCE(us.status, 'accepted') = 'accepted')
       AND NOT COALESCE(public.is_current_user_admin(), false) THEN
        RAISE EXCEPTION 'server members: not a member' USING ERRCODE = '42501';
    END IF;
    RETURN v_me;
END;
$$;

-- A member as the client caches it: the profile columns of a bulk profile read, presence as
-- the caller sees it, and the member's roles on the server without the default one. Null
-- columns are left out.
CREATE OR REPLACE FUNCTION public.server_member_json(
    p_profile public.profiles,
    p_server_id uuid,
    p_group text,
    p_online boolean,
    p_status smallint,
    p_mobile boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_strip_nulls(jsonb_build_object(
        'id', p_profile.id,
        'group', p_group,
        'username', p_profile.username,
        'web_handle', p_profile.web_handle,
        'display_name', p_profile.display_name,
        'avatar_url', p_profile.avatar_url,
        'banner_url', p_profile.banner_url,
        'bio', p_profile.bio,
        'color', p_profile.color,
        'status', p_profile.status,
        'domain', p_profile.domain,
        'updated_at', p_profile.updated_at,
        'created_at', p_profile.created_at,
        'is_local', p_profile.is_local,
        'custom_status', p_profile.custom_status,
        'is_admin', p_profile.is_admin,
        'is_moderator', p_profile.is_moderator,
        'instance_role', p_profile.instance_role,
        'online', p_online,
        'presence_status', p_status,
        'is_mobile', p_mobile,
        'role_ids', COALESCE((SELECT jsonb_agg(ur.role_id ORDER BY r.position DESC, r.id)
                                FROM public.user_roles ur
                                JOIN public.server_roles r ON r.id = ur.role_id
                               WHERE ur.user_id = p_profile.id
                                 AND ur.server_id = p_server_id
                                 AND r.is_default IS NOT TRUE), '[]'::jsonb)));
$$;

-- Accepted members of p_server_id with presence as p_viewer sees it. p_like, when given, is an
-- ILIKE pattern over username and display name; p_only, when given, is the one member wanted.
-- An absent member, one who blocks the viewer included, carries status 0 and no device kind:
-- nothing tells it from a member who is offline. The viewer reads itself by the status it
-- chose, not by what has been published yet: present unless invisible, as others will see it.
CREATE OR REPLACE FUNCTION public.server_member_presence(
    p_server_id uuid,
    p_viewer uuid,
    p_like text,
    p_only uuid DEFAULT NULL)
RETURNS TABLE (id uuid, username text, sort_name text, is_local boolean, present boolean, pstatus smallint, mobile boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT m.id, m.username, m.sort_name, m.is_local, m.present,
           CASE WHEN m.present THEN m.shown_status ELSE 0::smallint END,
           m.present AND m.shown_mobile
      FROM (SELECT p.id,
                   COALESCE(p.username, '') AS username,
                   lower(COALESCE(NULLIF(btrim(p.display_name), ''), p.username, '')) AS sort_name,
                   COALESCE(p.is_local, true) AS is_local,
                   CASE WHEN p.id = p_viewer THEN COALESCE(up.status, 1) <> 4
                        ELSE COALESCE(up.published_status, 0) <> 0
                             AND NOT EXISTS (SELECT 1 FROM public.user_blocks bl
                                              WHERE bl.blocker_id = p.id AND bl.blocked_user_id = p_viewer
                                                AND (bl.expires_at IS NULL OR bl.expires_at > now()))
                   END AS present,
                   CASE WHEN p.id = p_viewer THEN COALESCE(up.status, 1::smallint)
                        ELSE COALESCE(up.published_status, 0::smallint) END AS shown_status,
                   CASE WHEN p.id = p_viewer THEN COALESCE(up.is_mobile, false)
                        ELSE COALESCE(up.published_mobile, false) END AS shown_mobile
              FROM public.user_servers us
              JOIN public.profiles p ON p.id = us.user_id
              LEFT JOIN public.user_presence up ON up.profile_id = us.user_id
             WHERE us.server_id = p_server_id
               AND (p_only IS NULL OR us.user_id = p_only)
               AND COALESCE(us.status, 'accepted') = 'accepted'
               AND (p_like IS NULL OR p.username ILIKE p_like OR p.display_name ILIKE p_like)) m;
$$;

-- p_query as a contains pattern, its wildcards literal; NULL for a blank query.
CREATE OR REPLACE FUNCTION public.member_search_pattern(p_query text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN NULLIF(btrim(COALESCE(p_query, '')), '') IS NULL THEN NULL
                ELSE '%' || replace(replace(replace(left(btrim(p_query), 64), '\', '\\'), '%', '\%'), '_', '\_') || '%'
           END;
$$;

-- The order of names in the member list. The ICU root collation where the build has ICU:
-- browsers compare names with Intl.Collator, which is ICU. The database's own order elsewhere.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_collation c
                WHERE c.collnamespace = 'public'::regnamespace AND c.collname = 'member_name') THEN
        RETURN;
    END IF;
    BEGIN
        CREATE COLLATION public.member_name (provider = icu, locale = 'und');
    EXCEPTION WHEN OTHERS THEN
        EXECUTE format('CREATE COLLATION public.member_name (provider = libc, locale = %L)',
                       (SELECT d.datcollate FROM pg_database d WHERE d.datname = current_database()));
    END;
END;
$$;

-- Lists longer than this are answered from server_member_order.
CREATE OR REPLACE FUNCTION public.member_order_min()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 200; $$;

-- A server of more members than this gets no presence:update on its server-presence topic.
CREATE OR REPLACE FUNCTION public.server_is_large(p_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((SELECT st.member_count FROM public.server_member_stats st
                      WHERE st.server_id = p_server_id), 0) > 1000;
$$;

-- server_member_presence with each member's group and the keys the list is ordered by:
-- grp_rank, role_pos descending, grp, sort_name, username, id.
CREATE OR REPLACE FUNCTION public.server_member_keyed(
    p_server_id uuid,
    p_viewer uuid,
    p_like text,
    p_only uuid DEFAULT NULL)
RETURNS TABLE (id uuid, username text, sort_name text, present boolean, pstatus smallint, mobile boolean,
               grp text, grp_rank integer, role_pos integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH hoisted AS (
        SELECT r.id, COALESCE(r.position, 0) AS position
          FROM public.server_roles r
         WHERE r.server_id = p_server_id AND r.hoist IS TRUE AND r.is_default IS NOT TRUE
    ),
    seen AS MATERIALIZED (
        SELECT m.*,
               CASE WHEN m.present THEN
                   (SELECT h.id
                      FROM public.user_roles ur
                      JOIN hoisted h ON h.id = ur.role_id
                     WHERE ur.user_id = m.id AND ur.server_id = p_server_id
                     ORDER BY h.position DESC, h.id
                     LIMIT 1)
               END AS hoist_role
          FROM public.server_member_presence(p_server_id, p_viewer, p_like, p_only) m
    )
    SELECT s.id, s.username, s.sort_name, s.present, s.pstatus, s.mobile,
           CASE WHEN s.hoist_role IS NOT NULL THEN 'role:' || s.hoist_role::text
                WHEN s.present AND s.pstatus = 2 THEN 'away'
                WHEN s.present AND s.pstatus = 3 THEN 'busy'
                WHEN s.present THEN 'online'
                WHEN NOT s.is_local THEN 'federated'
                ELSE 'offline' END,
           CASE WHEN s.hoist_role IS NOT NULL THEN 0
                WHEN s.present AND s.pstatus = 2 THEN 2
                WHEN s.present AND s.pstatus = 3 THEN 3
                WHEN s.present THEN 1
                WHEN NOT s.is_local THEN 4
                ELSE 5 END,
           COALESCE((SELECT h.position FROM hoisted h WHERE h.id = s.hoist_role), 0)
      FROM seen s;
$$;

CREATE UNLOGGED TABLE IF NOT EXISTS public.server_member_order (
    server_id  uuid PRIMARY KEY REFERENCES public.servers(id) ON DELETE CASCADE,
    built_at   timestamptz NOT NULL,
    build_ms   integer NOT NULL DEFAULT 0,
    total      integer NOT NULL,
    -- [{"key": group, "count": members}] in list order.
    groups     jsonb NOT NULL,
    -- Members in list order.
    member_ids uuid[] NOT NULL
);

ALTER TABLE public.server_member_order ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.server_member_order FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.server_member_order TO service_role;
DROP POLICY IF EXISTS server_member_order_service_role ON public.server_member_order;
CREATE POLICY server_member_order_service_role ON public.server_member_order
    TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.server_member_order IS
'The member list order of a server by published presence, built on read by server_member_order_fresh. Unlogged.';

-- The order held for p_server_id, built first when it is older than its age limit. A second
-- builder does not wait: it answers the order held, and waits only when there is none.
CREATE OR REPLACE FUNCTION public.server_member_order_fresh(p_server_id uuid)
RETURNS public.server_member_order
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row     public.server_member_order;
    v_have    boolean;
    v_lock    bigint := hashtextextended('server_member_order:' || p_server_id::text, 0);
    v_started timestamptz;
    v_total   integer;
    v_groups  jsonb;
    v_ids     uuid[];
BEGIN
    SELECT * INTO v_row FROM public.server_member_order o WHERE o.server_id = p_server_id;
    v_have := FOUND;
    IF v_have AND v_row.built_at > clock_timestamp()
                                   - greatest(interval '5 seconds', v_row.build_ms * interval '20 milliseconds') THEN
        RETURN v_row;
    END IF;

    IF NOT pg_try_advisory_xact_lock(v_lock) THEN
        IF v_have THEN
            RETURN v_row;
        END IF;
        PERFORM pg_advisory_xact_lock(v_lock);
        SELECT * INTO v_row FROM public.server_member_order o WHERE o.server_id = p_server_id;
        IF FOUND THEN
            RETURN v_row;
        END IF;
    END IF;

    v_started := clock_timestamp();
    WITH keyed AS MATERIALIZED (
        SELECT k.*, row_number() OVER (ORDER BY k.grp_rank, k.role_pos DESC, k.grp,
                                                k.sort_name COLLATE public.member_name, k.username, k.id) AS ord
          FROM public.server_member_keyed(p_server_id, NULL, NULL) k
    ),
    tally AS (
        SELECT k.grp, min(k.ord) AS first_ord, count(*) AS n FROM keyed k GROUP BY k.grp
    )
    SELECT (SELECT count(*) FROM keyed)::integer,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('key', t.grp, 'count', t.n) ORDER BY t.first_ord) FROM tally t), '[]'::jsonb),
           COALESCE((SELECT array_agg(k.id ORDER BY k.ord) FROM keyed k), '{}'::uuid[])
      INTO v_total, v_groups, v_ids;

    INSERT INTO public.server_member_order AS o (server_id, built_at, build_ms, total, groups, member_ids)
    VALUES (p_server_id, clock_timestamp(),
            (extract(epoch FROM clock_timestamp() - v_started) * 1000)::integer, v_total, v_groups, v_ids)
    ON CONFLICT (server_id) DO UPDATE
       SET built_at = EXCLUDED.built_at,
           build_ms = EXCLUDED.build_ms,
           total = EXCLUDED.total,
           groups = EXCLUDED.groups,
           -- An unchanged order keeps its stored array: no rewrite of a value this size.
           member_ids = CASE WHEN o.member_ids = EXCLUDED.member_ids THEN o.member_ids ELSE EXCLUDED.member_ids END
    RETURNING * INTO v_row;
    RETURN v_row;
END;
$$;

-- The rank a group key sorts by, and for a role group the role's position.
CREATE OR REPLACE FUNCTION public.member_group_rank(p_group text, OUT grp_rank integer, OUT role_pos integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE p_group WHEN 'online' THEN 1 WHEN 'away' THEN 2 WHEN 'busy' THEN 3
                        WHEN 'federated' THEN 4 WHEN 'offline' THEN 5 ELSE 0 END,
           CASE WHEN p_group LIKE 'role:%'
                THEN COALESCE((SELECT r.position FROM public.server_roles r
                                WHERE r.id::text = substr(p_group, 6)), 0)
                ELSE 0 END;
$$;

-- A stored order with p_viewer where the viewer sees itself. The order places every member by
-- published presence and may be seconds old; the viewer's own place follows the status it
-- chose, now. The viewer is taken out of its stored place and put into its group at its place
-- by name, found by halving: a profile read per step.
CREATE OR REPLACE FUNCTION public.server_member_order_for(p_order public.server_member_order, p_viewer uuid)
RETURNS public.server_member_order
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_at      integer := array_position(p_order.member_ids, p_viewer);
    v_self    record;
    v_stored  text;
    v_ids     uuid[];
    v_groups  jsonb := '[]'::jsonb;
    v_group   jsonb;
    v_rank    record;
    v_before  integer := 0;
    v_lo      integer;
    v_hi      integer;
    v_mid     integer;
    v_other   record;
    v_placed  boolean := false;
    v_out     public.server_member_order := p_order;
BEGIN
    IF v_at IS NULL THEN
        RETURN p_order;
    END IF;
    SELECT k.* INTO v_self
      FROM public.server_member_keyed(p_order.server_id, p_viewer, NULL, p_viewer) k;
    IF NOT FOUND THEN
        RETURN p_order;
    END IF;
    SELECT g.key INTO v_stored
      FROM (SELECT e ->> 'key' AS key, n, sum((e ->> 'count')::integer) OVER (ORDER BY n) AS upto
              FROM jsonb_array_elements(p_order.groups) WITH ORDINALITY AS t(e, n)) g
     WHERE g.upto >= v_at
     ORDER BY g.n
     LIMIT 1;
    IF v_stored = v_self.grp THEN
        RETURN p_order;
    END IF;

    v_ids := p_order.member_ids[1 : v_at - 1] || p_order.member_ids[v_at + 1 :];

    -- The groups again: the stored group one short, the viewer's group one longer, added in
    -- its place when no other member is in it.
    FOR v_group IN SELECT e FROM jsonb_array_elements(p_order.groups) WITH ORDINALITY AS t(e, n) ORDER BY n LOOP
        IF NOT v_placed AND v_group ->> 'key' <> v_self.grp THEN
            SELECT * INTO v_rank FROM public.member_group_rank(v_group ->> 'key');
            IF (v_rank.grp_rank, -v_rank.role_pos, v_group ->> 'key') > (v_self.grp_rank, -v_self.role_pos, v_self.grp) THEN
                v_groups := v_groups || jsonb_build_object('key', v_self.grp, 'count', 1);
                v_lo := v_before + 1;
                v_placed := true;
            END IF;
        END IF;
        IF v_group ->> 'key' = v_stored THEN
            IF (v_group ->> 'count')::integer > 1 THEN
                v_groups := v_groups || jsonb_build_object('key', v_stored, 'count', (v_group ->> 'count')::integer - 1);
                v_before := v_before + (v_group ->> 'count')::integer - 1;
            END IF;
        ELSIF v_group ->> 'key' = v_self.grp THEN
            -- Its members are v_ids[v_before + 1 .. v_before + count]: the viewer's place among them.
            v_lo := v_before + 1;
            v_hi := v_before + (v_group ->> 'count')::integer + 1;
            WHILE v_lo < v_hi LOOP
                v_mid := (v_lo + v_hi) / 2;
                SELECT lower(COALESCE(NULLIF(btrim(p.display_name), ''), p.username, '')) AS sort_name,
                       COALESCE(p.username, '') AS username
                  INTO v_other
                  FROM public.profiles p WHERE p.id = v_ids[v_mid];
                IF FOUND AND (v_other.sort_name COLLATE public.member_name < v_self.sort_name COLLATE public.member_name
                              OR (v_other.sort_name = v_self.sort_name
                                  AND (v_other.username < v_self.username
                                       OR (v_other.username = v_self.username AND v_ids[v_mid] < p_viewer)))) THEN
                    v_lo := v_mid + 1;
                ELSE
                    v_hi := v_mid;
                END IF;
            END LOOP;
            v_groups := v_groups || jsonb_build_object('key', v_self.grp, 'count', (v_group ->> 'count')::integer + 1);
            v_before := v_before + (v_group ->> 'count')::integer;
            v_placed := true;
        ELSE
            v_groups := v_groups || v_group;
            v_before := v_before + (v_group ->> 'count')::integer;
        END IF;
    END LOOP;
    IF NOT v_placed THEN
        v_groups := v_groups || jsonb_build_object('key', v_self.grp, 'count', 1);
        v_lo := v_before + 1;
    END IF;

    v_out.member_ids := v_ids[1 : v_lo - 1] || p_viewer || v_ids[v_lo :];
    v_out.groups := v_groups;
    RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_server_member_list(
    p_server_id uuid,
    p_offset integer DEFAULT 0,
    p_limit integer DEFAULT 100,
    p_query text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me      uuid := public.server_member_reader(p_server_id);
    v_offset  integer := greatest(COALESCE(p_offset, 0), 0);
    v_limit   integer := least(greatest(COALESCE(p_limit, 100), 1), 200);
    v_like    text := public.member_search_pattern(p_query);
    v_live    boolean := NOT public.server_is_large(p_server_id);
    v_order   public.server_member_order;
    v_result  jsonb;
BEGIN
    -- The stored order is the same for every caller. A caller some member blocks sees that
    -- member absent, so its list is its own.
    IF v_like IS NULL
       AND COALESCE((SELECT st.member_count FROM public.server_member_stats st
                      WHERE st.server_id = p_server_id), 0) > public.member_order_min()
       AND NOT EXISTS (SELECT 1
                         FROM public.user_blocks bl
                         JOIN public.user_servers us ON us.user_id = bl.blocker_id AND us.server_id = p_server_id
                        WHERE bl.blocked_user_id = v_me
                          AND (bl.expires_at IS NULL OR bl.expires_at > now()))
    THEN
        v_order := public.server_member_order_for(public.server_member_order_fresh(p_server_id), v_me);

        WITH bounds AS (
            SELECT e ->> 'key' AS key, n,
                   sum((e ->> 'count')::integer) OVER (ORDER BY n) AS upto
              FROM jsonb_array_elements(v_order.groups) WITH ORDINALITY AS t(e, n)
        ),
        page AS (
            SELECT u.id, v_offset + u.ord AS pos
              FROM unnest(v_order.member_ids[v_offset + 1 : v_offset + v_limit]) WITH ORDINALITY AS u(id, ord)
        )
        SELECT jsonb_build_object(
                   'total', v_order.total,
                   'offset', v_offset,
                   'live', v_live,
                   'max_age_ms', (extract(epoch FROM greatest(interval '5 seconds', v_order.build_ms * interval '20 milliseconds')) * 1000)::integer,
                   'groups', v_order.groups,
                   'members', COALESCE((
                       SELECT jsonb_agg(public.server_member_json(
                                  pr, p_server_id,
                                  (SELECT b.key FROM bounds b WHERE b.upto >= pg.pos ORDER BY b.n LIMIT 1),
                                  CASE WHEN pg.id = v_me THEN COALESCE(up.status, 1) <> 4
                                       ELSE COALESCE(up.published_status, 0) <> 0 END,
                                  CASE WHEN pg.id <> v_me THEN COALESCE(up.published_status, 0::smallint)
                                       WHEN COALESCE(up.status, 1) <> 4 THEN COALESCE(up.status, 1::smallint)
                                       ELSE 0::smallint END,
                                  CASE WHEN pg.id = v_me THEN COALESCE(up.status, 1) <> 4 AND COALESCE(up.is_mobile, false)
                                       ELSE COALESCE(up.published_status, 0) <> 0 AND COALESCE(up.published_mobile, false) END)
                              ORDER BY pg.pos)
                         FROM page pg
                         JOIN public.profiles pr ON pr.id = pg.id
                         LEFT JOIN public.user_presence up ON up.profile_id = pg.id), '[]'::jsonb))
          INTO v_result;
        RETURN v_result;
    END IF;

    WITH keyed AS MATERIALIZED (
        SELECT k.* FROM public.server_member_keyed(p_server_id, v_me, v_like) k
    ),
    page AS (
        SELECT k.*, row_number() OVER (ORDER BY k.grp_rank, k.role_pos DESC, k.grp,
                                                k.sort_name COLLATE public.member_name, k.username, k.id) AS ord
          FROM keyed k
         ORDER BY k.grp_rank, k.role_pos DESC, k.grp, k.sort_name COLLATE public.member_name, k.username, k.id
        OFFSET v_offset
         LIMIT v_limit
    ),
    tally AS (
        SELECT k.grp, min(k.grp_rank) AS grp_rank, max(k.role_pos) AS role_pos, count(*) AS n
          FROM keyed k
         GROUP BY k.grp
    )
    SELECT jsonb_build_object(
               'total', (SELECT count(*) FROM keyed),
               'offset', v_offset,
               'live', v_live,
               'max_age_ms', 0,
               'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', t.grp, 'count', t.n)
                                                    ORDER BY t.grp_rank, t.role_pos DESC, t.grp)
                                     FROM tally t), '[]'::jsonb),
               'members', COALESCE((SELECT jsonb_agg(public.server_member_json(pr, p_server_id, pg.grp, pg.present, pg.pstatus, pg.mobile)
                                                     ORDER BY pg.ord)
                                      FROM page pg
                                      JOIN public.profiles pr ON pr.id = pg.id), '[]'::jsonb))
      INTO v_result;
    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.search_server_members(
    p_server_id uuid,
    p_query text,
    p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me     uuid := public.server_member_reader(p_server_id);
    v_limit  integer := least(greatest(COALESCE(p_limit, 20), 1), 50);
    v_like   text := public.member_search_pattern(p_query);
    v_needle text := lower(left(btrim(COALESCE(p_query, '')), 64));
    v_result jsonb;
BEGIN
    IF v_like IS NULL THEN
        RETURN '[]'::jsonb;
    END IF;

    WITH found AS (
        SELECT m.*,
               CASE WHEN lower(m.username) = v_needle OR m.sort_name = v_needle THEN 0
                    WHEN starts_with(lower(m.username), v_needle) OR starts_with(m.sort_name, v_needle) THEN 1
                    ELSE 2 END AS match_rank
          FROM public.server_member_presence(p_server_id, v_me, v_like) m
    ),
    page AS (
        SELECT f.*, row_number() OVER (ORDER BY f.match_rank, f.sort_name COLLATE public.member_name, f.username, f.id) AS ord
          FROM found f
         ORDER BY f.match_rank, f.sort_name COLLATE public.member_name, f.username, f.id
         LIMIT v_limit
    )
    SELECT COALESCE(jsonb_agg(public.server_member_json(pr, p_server_id, NULL, pg.present, pg.pstatus, pg.mobile)
                              ORDER BY pg.ord), '[]'::jsonb)
      INTO v_result
      FROM page pg
      JOIN public.profiles pr ON pr.id = pg.id;
    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_server_member_roles(p_server_id uuid, p_user_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result jsonb;
BEGIN
    PERFORM public.server_member_reader(p_server_id);
    IF p_user_ids IS NULL OR cardinality(p_user_ids) = 0 THEN
        RETURN '{}'::jsonb;
    END IF;
    IF cardinality(p_user_ids) > 200 THEN
        RAISE EXCEPTION 'get_server_member_roles: at most 200 members' USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(jsonb_object_agg(x.user_id, x.role_ids), '{}'::jsonb)
      INTO v_result
      FROM (SELECT ur.user_id::text AS user_id, jsonb_agg(ur.role_id ORDER BY r.position DESC, r.id) AS role_ids
              FROM public.user_roles ur
              JOIN public.server_roles r ON r.id = ur.role_id
             WHERE ur.server_id = p_server_id
               AND ur.user_id = ANY (p_user_ids)
               AND r.is_default IS NOT TRUE
             GROUP BY ur.user_id) x;
    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_server_role_member_counts(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result jsonb;
BEGIN
    PERFORM public.server_member_reader(p_server_id);

    SELECT COALESCE(jsonb_object_agg(x.role_id, x.n), '{}'::jsonb)
      INTO v_result
      FROM (SELECT r.id::text AS role_id,
                   CASE WHEN r.is_default IS TRUE
                        THEN COALESCE((SELECT st.member_count FROM public.server_member_stats st
                                        WHERE st.server_id = p_server_id), 0)::bigint
                        ELSE (SELECT count(*) FROM public.user_roles ur
                               JOIN public.user_servers us
                                 ON us.user_id = ur.user_id AND us.server_id = ur.server_id
                                AND COALESCE(us.status, 'accepted') = 'accepted'
                              WHERE ur.role_id = r.id) END AS n
              FROM public.server_roles r
             WHERE r.server_id = p_server_id) x;
    RETURN v_result;
END;
$$;

-- 20261006800001 with one change: no presence:update for a server of more than 1000 members.
CREATE OR REPLACE FUNCTION public.presence_publish(p_profile_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row     public.user_presence%ROWTYPE;
    v_online  boolean;
    v_mobile  boolean;
    v_seen    timestamptz;
    v_status  smallint;
    v_pmobile boolean;
    v_payload jsonb;
    v_target  uuid;
BEGIN
    SELECT * INTO v_row FROM public.user_presence WHERE profile_id = p_profile_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT count(*) > 0, COALESCE(bool_and(d.is_mobile), false), max(d.last_seen_at)
      INTO v_online, v_mobile, v_seen
      FROM public.presence_devices d
     WHERE d.profile_id = p_profile_id
       AND d.last_seen_at > now() - interval '150 seconds';

    v_status := CASE WHEN v_online AND v_row.status <> 4 THEN v_row.status ELSE 0 END;
    v_pmobile := v_status <> 0 AND v_mobile;

    UPDATE public.user_presence
       SET online = v_online,
           is_mobile = v_mobile AND v_online,
           last_seen_at = COALESCE(v_seen, last_seen_at)
     WHERE profile_id = p_profile_id;

    IF v_status = v_row.published_status AND v_pmobile = v_row.published_mobile THEN
        RETURN;
    END IF;
    IF v_row.published_at > now() - interval '1 second' THEN
        RETURN;
    END IF;

    UPDATE public.user_presence
       SET published_status = v_status, published_mobile = v_pmobile, published_at = now()
     WHERE profile_id = p_profile_id;

    v_payload := jsonb_build_object(
        'type', 'presence:update',
        'user_id', p_profile_id,
        'online', v_status <> 0,
        'status', v_status,
        'is_mobile', v_pmobile);

    FOR v_target IN
        SELECT us.server_id FROM public.user_servers us
         WHERE us.user_id = p_profile_id AND us.status = 'accepted'
           AND NOT public.server_is_large(us.server_id)
    LOOP
        PERFORM realtime.send(v_payload, 'presence_event', 'server-presence:' || v_target::text, true);
    END LOOP;

    FOR v_target IN
        SELECT DISTINCT other.user_id
          FROM public.conversation_participants mine
          JOIN public.conversation_participants other ON other.conversation_id = mine.conversation_id
          JOIN public.profiles p ON p.id = other.user_id
         WHERE mine.user_id = p_profile_id AND mine.left_at IS NULL
           AND other.left_at IS NULL AND other.user_id <> p_profile_id
           AND p.is_local IS TRUE
           AND NOT EXISTS (SELECT 1 FROM public.user_blocks bl
                            WHERE bl.blocker_id = p_profile_id AND bl.blocked_user_id = other.user_id
                              AND (bl.expires_at IS NULL OR bl.expires_at > now()))
    LOOP
        PERFORM realtime.send(v_payload, 'user_event', 'user:' || v_target::text, true);
    END LOOP;
END;
$$;

-- get_room_member_ids as one value. Invoker: get_room_member_ids applies its own gate to the
-- caller's role and profile.
CREATE OR REPLACE FUNCTION public.get_room_member_id_list(p_room_id text)
RETURNS uuid[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(array_agg(m), '{}'::uuid[]) FROM public.get_room_member_ids(p_room_id) AS m;
$$;

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('get_server_member_list', 'search_server_members',
                             'get_server_member_roles', 'get_server_role_member_counts',
                             'get_room_member_id_list')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;

    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('server_member_stats_on_insert', 'server_member_stats_on_delete',
                             'server_member_stats_on_update', 'server_member_reader',
                             'server_member_json', 'server_member_presence', 'member_search_pattern',
                             'server_member_keyed', 'server_member_order_fresh', 'server_member_order_for',
                             'member_group_rank', 'server_is_large', 'member_order_min', 'presence_publish')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.get_server_member_counts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_server_member_counts(uuid[]) TO anon, authenticated, service_role;

COMMIT;
