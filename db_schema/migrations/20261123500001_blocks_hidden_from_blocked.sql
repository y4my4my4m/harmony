-- A blocked account no longer reads who blocks it.
--
-- Policy user_blocks_check_if_blocked let a blocked account select every row naming it, and
-- is_blocked_by(target) and current_user_block_peer_ids() answered as RPCs, while DM refusals word a
-- block as a setting. The policy is dropped. Both helpers move to harmony_private, a schema PostgREST
-- does not publish; the policies calling them (posts_select_public, reactions_insert_own,
-- post_interactions_insert_own) hold them by oid and follow the move. get_today_summary,
-- vote_remote_poll, vote_message_poll and current_user_reads_post name them and are restated with
-- the new schema. Body otherwise, volatility, owner and grants as each origin migration names.
--
-- A policy runs as the querying role: anon and authenticated keep USAGE on harmony_private and
-- EXECUTE on both helpers. A definer runs as its owner: each caller's owner is granted the same.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE SCHEMA IF NOT EXISTS harmony_private;
REVOKE ALL ON SCHEMA harmony_private FROM PUBLIC;
GRANT USAGE ON SCHEMA harmony_private TO anon, authenticated, service_role;
COMMENT ON SCHEMA harmony_private IS
    'Helpers of policies and definers. Not in PGRST_DB_SCHEMAS: no RPC reaches them.';

DROP POLICY IF EXISTS "user_blocks_check_if_blocked" ON public.user_blocks;

DO $$
BEGIN
    IF to_regprocedure('harmony_private.is_blocked_by(uuid)') IS NULL THEN
        ALTER FUNCTION public.is_blocked_by(uuid) SET SCHEMA harmony_private;
    END IF;
    IF to_regprocedure('harmony_private.current_user_block_peer_ids()') IS NULL THEN
        ALTER FUNCTION public.current_user_block_peer_ids() SET SCHEMA harmony_private;
    END IF;
END
$$;

REVOKE ALL ON FUNCTION harmony_private.is_blocked_by(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION harmony_private.is_blocked_by(uuid) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION harmony_private.current_user_block_peer_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION harmony_private.current_user_block_peer_ids() TO anon, authenticated, service_role;

-- As 20261005700001_compute_unread_on_read.sql, with the block set from harmony_private.
CREATE OR REPLACE FUNCTION public.get_today_summary(p_since timestamp with time zone DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_auth uuid := auth.uid();
    v_now timestamptz := now();
    v_recent timestamptz := now() - interval '14 days';
    v_since timestamptz;
    v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    v_mentions jsonb;
    v_mentions_unread bigint;
    v_conversations jsonb;
    v_conversation_count bigint;
    v_dm_messages bigint;
    v_servers jsonb;
    v_server_count bigint;
    v_channel_count bigint;
    v_channel_messages bigint;
    v_unread_mentions bigint;
    v_threads jsonb;
    v_thread_count bigint;
    v_voice jsonb;
    v_follow_requests jsonb;
    v_follow_request_count bigint;
    v_new_followers jsonb;
    v_new_follower_count bigint;
    v_social_counts jsonb;
    v_social_items jsonb;
    v_posts jsonb;
    v_announcements jsonb;
    v_announcement_count bigint;
    v_unread jsonb;
BEGIN
    IF v_me IS NULL THEN
        RETURN NULL;
    END IF;

    -- Both sections below read it; one evaluation.
    SELECT COALESCE(jsonb_agg(to_jsonb(g)), '[]'::jsonb) INTO v_unread FROM public.get_unread_counts() g;

    v_since := least(greatest(coalesce(p_since, v_now - interval '1 day'), v_now - interval '7 days'),
                     v_now - interval '12 hours');

    -- Mentions and replies ------------------------------------------------------------------
    -- Candidates are the newest 60 of each kind; the list keeps 20 after visibility, deletion
    -- and blocks narrow them.
    WITH mention_hits AS (
        SELECT n.data->>'message_id' AS ref, coalesce(n.is_read, false) AS is_read
          FROM public.notifications n
         WHERE n.user_id = v_me
           AND n.type = 'mention'
           AND n.created_at > v_recent
         ORDER BY n.created_at DESC
         LIMIT 60
    ),
    reply_hits AS (
        SELECT r.id
          FROM public.messages mine
          JOIN public.messages r ON r.reply_to = mine.id
         WHERE mine.user_id = v_me
           AND mine.created_at > v_recent
           AND r.created_at > v_recent
           AND r.user_id IS DISTINCT FROM v_me
         ORDER BY r.created_at DESC
         LIMIT 60
    ),
    hits AS (
        SELECT CASE WHEN mh.ref ~* v_uuid THEN mh.ref::uuid END AS message_id,
               'mention'::text AS kind, mh.is_read
          FROM mention_hits mh
        UNION ALL
        SELECT rh.id, 'reply', false FROM reply_hits rh
    ),
    per_message AS (
        SELECT h.message_id,
               CASE WHEN bool_or(h.kind = 'mention') THEN 'mention' ELSE 'reply' END AS kind,
               bool_and(h.is_read) AS is_read
          FROM hits h
         WHERE h.message_id IS NOT NULL
         GROUP BY h.message_id
    ),
    picked AS (
        SELECT p.kind, p.is_read, m.*
          FROM per_message p
          JOIN public.messages m ON m.id = p.message_id
         WHERE (m.is_deleted IS NULL OR m.is_deleted = false)
           AND (m.user_id IS NULL OR m.user_id NOT IN (SELECT harmony_private.current_user_block_peer_ids()))
         ORDER BY m.created_at DESC
         LIMIT 20
    ),
    shaped AS (
        SELECT k.created_at,
               NOT k.is_read AND k.created_at >= coalesce(rd.last_read_at, '-infinity'::timestamptz) AS unread,
               jsonb_build_object(
                   'kind', k.kind,
                   'unread', NOT k.is_read AND k.created_at >= coalesce(rd.last_read_at, '-infinity'::timestamptz),
                   'message', jsonb_build_object(
                       'id', k.id,
                       'channel_id', k.channel_id,
                       'conversation_id', k.conversation_id,
                       'thread_id', k.thread_id,
                       'user_id', k.user_id,
                       'bot_id', k.bot_id,
                       'content', k.content,
                       'encrypted', coalesce(k.encrypted, false),
                       'encryption_metadata', k.encryption_metadata,
                       'metadata', k.metadata,
                       'created_at', k.created_at),
                   'server', CASE WHEN s.id IS NULL THEN NULL
                                  ELSE jsonb_build_object('id', s.id, 'name', s.name, 'icon', s.icon) END,
                   'channel_name', c.name,
                   'thread_name', t.name,
                   'conversation', CASE WHEN cv.id IS NULL THEN NULL
                                        ELSE jsonb_build_object('id', cv.id, 'type', coalesce(cv.type, 'direct'),
                                                                'name', cv.name) END,
                   'author', CASE WHEN au.id IS NULL THEN NULL
                                  ELSE jsonb_build_object('id', au.id, 'username', au.username,
                                                          'display_name', au.display_name,
                                                          'avatar_url', au.avatar_url, 'domain', au.domain,
                                                          'is_local', au.is_local) END
               ) AS entry
          FROM picked k
          LEFT JOIN public.profiles au ON au.id = k.user_id
          LEFT JOIN public.channels c ON c.id = k.channel_id
          LEFT JOIN public.servers s ON s.id = c.server_id
          LEFT JOIN public.threads t ON t.id = k.thread_id
          LEFT JOIN public.conversations cv ON cv.id = k.conversation_id
          LEFT JOIN LATERAL (
              SELECT u.last_read_at
                FROM public.unread_counts u
               WHERE u.user_id = v_me
                 AND ((k.channel_id IS NOT NULL AND u.channel_id = k.channel_id)
                      OR (k.channel_id IS NULL AND u.conversation_id = k.conversation_id))
               LIMIT 1
          ) rd ON true
    )
    SELECT coalesce(jsonb_agg(sh.entry ORDER BY sh.created_at DESC), '[]'::jsonb),
           count(*) FILTER (WHERE sh.unread)
      INTO v_mentions, v_mentions_unread
      FROM shaped sh;

    -- Conversations -------------------------------------------------------------------------
    WITH unread AS (
        SELECT u.conversation_id, u.unread_messages, u.unread_mentions, cp.hidden_at
          FROM jsonb_to_recordset(v_unread) AS u(conversation_id uuid, unread_messages integer, unread_mentions integer)
          JOIN public.conversation_participants cp
            ON cp.conversation_id = u.conversation_id
           AND cp.user_id = v_me
           AND cp.left_at IS NULL
         WHERE u.conversation_id IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM public.notification_channels nc
                WHERE nc.user_id = v_me
                  AND nc.conversation_id = u.conversation_id
                  AND nc.channel_id IS NULL
                  AND nc.muted = true
                  AND (nc.muted_until IS NULL OR nc.muted_until > v_now))
    ),
    latest AS (
        SELECT un.*, lm.id AS last_id, lm.user_id AS last_user_id, lm.bot_id AS last_bot_id,
               lm.content AS last_content, lm.encrypted AS last_encrypted,
               lm.encryption_metadata AS last_encryption_metadata, lm.metadata AS last_metadata,
               lm.created_at AS last_at
          FROM unread un
          LEFT JOIN LATERAL (
              SELECT m.id, m.user_id, m.bot_id, m.content, m.encrypted, m.encryption_metadata,
                     m.metadata, m.created_at
                FROM public.messages m
               WHERE m.conversation_id = un.conversation_id
                 AND m.thread_id IS NULL
                 AND (m.is_deleted IS NULL OR m.is_deleted = false)
               ORDER BY m.created_at DESC
               LIMIT 1
          ) lm ON true
         WHERE un.hidden_at IS NULL OR lm.created_at > un.hidden_at
    ),
    top AS (
        SELECT l.* FROM latest l ORDER BY l.last_at DESC NULLS LAST LIMIT 8
    )
    SELECT (SELECT count(*) FROM latest),
           (SELECT coalesce(sum(l.unread_messages), 0) FROM latest l),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', cv.id,
               'type', coalesce(cv.type, 'direct'),
               'name', cv.name,
               'icon_url', CASE WHEN cv.type = 'group' THEN cv.metadata->>'icon_url' END,
               'unread_messages', coalesce(tp.unread_messages, 0),
               'unread_mentions', coalesce(tp.unread_mentions, 0),
               'participant_count', coalesce(op.total, 0) + 1,
               'participants', coalesce(op.people, '[]'::jsonb),
               'last_message', CASE WHEN tp.last_id IS NULL THEN NULL ELSE jsonb_build_object(
                   'id', tp.last_id,
                   'conversation_id', cv.id,
                   'user_id', tp.last_user_id,
                   'bot_id', tp.last_bot_id,
                   'content', tp.last_content,
                   'encrypted', coalesce(tp.last_encrypted, false),
                   'encryption_metadata', tp.last_encryption_metadata,
                   'metadata', tp.last_metadata,
                   'created_at', tp.last_at) END
           ) ORDER BY tp.last_at DESC NULLS LAST), '[]'::jsonb)
      INTO v_conversation_count, v_dm_messages, v_conversations
      FROM top tp
      JOIN public.conversations cv ON cv.id = tp.conversation_id
      LEFT JOIN LATERAL (
          SELECT count(*) AS total,
                 jsonb_agg(jsonb_build_object(
                     'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
                     'avatar_url', pr.avatar_url, 'domain', pr.domain, 'is_local', pr.is_local)
                     ORDER BY o.joined_at) FILTER (WHERE o.rn <= 4) AS people
            FROM (
                SELECT cp2.user_id, cp2.joined_at, row_number() OVER (ORDER BY cp2.joined_at) AS rn
                  FROM public.conversation_participants cp2
                 WHERE cp2.conversation_id = tp.conversation_id
                   AND cp2.user_id <> v_me
                   AND cp2.left_at IS NULL
            ) o
            JOIN public.profiles pr ON pr.id = o.user_id
      ) op ON true;

    -- Unread channels by server -------------------------------------------------------------
    WITH rows AS (
        SELECT c.server_id, c.id AS channel_id, c.name, c.type, u.unread_messages, u.unread_mentions,
               u.last_message_at AS updated_at
          FROM jsonb_to_recordset(v_unread)
               AS u(channel_id uuid, unread_messages integer, unread_mentions integer, last_message_at timestamptz)
          JOIN public.channels c ON c.id = u.channel_id
         WHERE u.channel_id IS NOT NULL
           AND c.server_id IS NOT NULL
    ),
    per_server AS (
        SELECT r.server_id,
               sum(r.unread_messages) AS unread_messages,
               sum(r.unread_mentions) AS unread_mentions,
               count(*) AS channel_count,
               max(r.updated_at) AS last_activity
          FROM rows r
         GROUP BY r.server_id
    ),
    top AS (
        SELECT ps.* FROM per_server ps
         ORDER BY ps.unread_mentions DESC, ps.last_activity DESC NULLS LAST
         LIMIT 20
    )
    SELECT (SELECT count(*) FROM per_server),
           (SELECT coalesce(sum(ps.channel_count), 0) FROM per_server ps),
           (SELECT coalesce(sum(ps.unread_messages), 0) FROM per_server ps),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id,
               'name', s.name,
               'icon', s.icon,
               'unread_messages', tp.unread_messages,
               'unread_mentions', tp.unread_mentions,
               'channel_count', tp.channel_count,
               'last_activity', tp.last_activity,
               'channels', (
                   SELECT jsonb_agg(jsonb_build_object(
                              'id', ch.channel_id, 'name', ch.name, 'type', ch.type,
                              'unread_messages', ch.unread_messages,
                              'unread_mentions', ch.unread_mentions)
                              ORDER BY ch.unread_mentions DESC, ch.unread_messages DESC, ch.channel_id)
                     FROM (SELECT r.* FROM rows r
                            WHERE r.server_id = tp.server_id
                            ORDER BY r.unread_mentions DESC, r.unread_messages DESC, r.channel_id
                            LIMIT 12) ch)
           ) ORDER BY tp.unread_mentions DESC, tp.last_activity DESC NULLS LAST), '[]'::jsonb)
      INTO v_server_count, v_channel_count, v_channel_messages, v_servers
      FROM top tp
      JOIN public.servers s ON s.id = tp.server_id;

    SELECT coalesce(sum(u.unread_mentions), 0)
      INTO v_unread_mentions
      FROM public.unread_counts u
     WHERE u.user_id = v_me
       AND u.unread_mentions > 0
       AND ((u.channel_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.channels c WHERE c.id = u.channel_id))
            OR (u.channel_id IS NULL AND u.conversation_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.conversation_participants cp
                 WHERE cp.conversation_id = u.conversation_id
                   AND cp.user_id = v_me
                   AND cp.left_at IS NULL)));

    -- Threads -------------------------------------------------------------------------------
    -- A thread qualifies when its last message is newer than the caller's read position, join
    -- or last post there. Reply counts and repliers are computed for the 20 listed only.
    -- MATERIALIZED: inlined, the last-post subquery ran once per reference to `mine`.
    WITH mine AS MATERIALIZED (
        SELECT t.id, t.name, t.channel_id, t.last_message_at,
               greatest(tm.last_read_at, tm.joined_at,
                        (SELECT m.created_at FROM public.messages m
                          WHERE m.thread_id = t.id AND m.user_id = v_me
                          ORDER BY m.created_at DESC
                          LIMIT 1)) AS seen_at
          FROM public.thread_members tm
          JOIN public.threads t ON t.id = tm.thread_id
         WHERE tm.user_id = v_me
           AND coalesce(tm.muted, false) = false
           AND coalesce(t.archived, false) = false
           AND t.last_message_at > v_recent
    ),
    fresh AS MATERIALIZED (
        SELECT mi.* FROM mine mi WHERE mi.last_message_at > mi.seen_at
    ),
    top AS (
        SELECT f.*, nr.new_replies, nr.last_reply_at, nr.repliers
          FROM (SELECT * FROM fresh ORDER BY last_message_at DESC LIMIT 20) f
          CROSS JOIN LATERAL (
              SELECT count(*) AS new_replies,
                     max(x.created_at) AS last_reply_at,
                     (SELECT array_agg(y.user_id ORDER BY y.at DESC)
                        FROM (SELECT z.user_id, max(z.created_at) AS at
                                FROM public.messages z
                               WHERE z.thread_id = f.id
                                 AND z.created_at > f.seen_at
                                 AND z.user_id IS NOT NULL
                                 AND z.user_id <> v_me
                                 AND (z.is_deleted IS NULL OR z.is_deleted = false)
                               GROUP BY z.user_id
                               ORDER BY max(z.created_at) DESC
                               LIMIT 3) y) AS repliers
                FROM public.messages x
               WHERE x.thread_id = f.id
                 AND x.created_at > f.seen_at
                 AND x.user_id IS DISTINCT FROM v_me
                 AND (x.is_deleted IS NULL OR x.is_deleted = false)
          ) nr
         WHERE nr.new_replies > 0
    )
    SELECT (SELECT count(*) FROM fresh),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', tp.id,
               'name', tp.name,
               'channel_id', tp.channel_id,
               'channel_name', c.name,
               'server', jsonb_build_object('id', s.id, 'name', s.name, 'icon', s.icon),
               'new_replies', tp.new_replies,
               'last_reply_at', tp.last_reply_at,
               'repliers', coalesce((
                   SELECT jsonb_agg(jsonb_build_object(
                              'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
                              'avatar_url', pr.avatar_url)
                              ORDER BY u.ord)
                     FROM unnest(tp.repliers) WITH ORDINALITY u(id, ord)
                     JOIN public.profiles pr ON pr.id = u.id), '[]'::jsonb)
           ) ORDER BY tp.last_reply_at DESC), '[]'::jsonb)
      INTO v_thread_count, v_threads
      FROM top tp
      JOIN public.channels c ON c.id = tp.channel_id
      JOIN public.servers s ON s.id = c.server_id;

    -- Voice ---------------------------------------------------------------------------------
    WITH live AS (
        SELECT v.channel_id, v.user_id, v.joined_at,
               row_number() OVER (PARTITION BY v.channel_id ORDER BY v.joined_at) AS rn
          FROM public.voice_channel_participants v
          JOIN public.channels c ON c.id = v.channel_id
         WHERE v.joined_at > v_now - interval '12 hours'
    ),
    per_channel AS (
        SELECT l.channel_id,
               count(*) AS participant_count,
               min(l.joined_at) AS started_at,
               bool_or(l.user_id = v_me) AS includes_me,
               jsonb_agg(jsonb_build_object(
                   'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
                   'avatar_url', pr.avatar_url)
                   ORDER BY l.joined_at) FILTER (WHERE l.rn <= 6) AS participants
          FROM live l
          JOIN public.profiles pr ON pr.id = l.user_id
         GROUP BY l.channel_id
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'channel_id', c.id,
               'channel_name', c.name,
               'server', jsonb_build_object('id', s.id, 'name', s.name, 'icon', s.icon,
                                            'is_local', coalesce(s.is_local_server, true)),
               'participant_count', pc.participant_count,
               'started_at', pc.started_at,
               'includes_me', pc.includes_me,
               'participants', coalesce(pc.participants, '[]'::jsonb)
           ) ORDER BY pc.includes_me DESC, pc.participant_count DESC, pc.started_at), '[]'::jsonb)
      INTO v_voice
      FROM (SELECT * FROM per_channel ORDER BY includes_me DESC, participant_count DESC, started_at
             LIMIT 12) pc
      JOIN public.channels c ON c.id = pc.channel_id
      JOIN public.servers s ON s.id = c.server_id;

    -- Follows -------------------------------------------------------------------------------
    SELECT count(*),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
               'avatar_url', pr.avatar_url, 'domain', pr.domain, 'is_local', pr.is_local,
               'requested_at', f.created_at)
               ORDER BY f.created_at DESC) FILTER (WHERE f.rn <= 5), '[]'::jsonb)
      INTO v_follow_request_count, v_follow_requests
      FROM (SELECT fo.follower_id, fo.created_at,
                   row_number() OVER (ORDER BY fo.created_at DESC) AS rn
              FROM public.follows fo
             WHERE fo.following_id = v_me
               AND fo.status = 'pending') f
      JOIN public.profiles pr ON pr.id = f.follower_id;

    SELECT count(*),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
               'avatar_url', pr.avatar_url, 'domain', pr.domain, 'is_local', pr.is_local,
               'followed_at', f.at)
               ORDER BY f.at DESC) FILTER (WHERE f.rn <= 8), '[]'::jsonb)
      INTO v_new_follower_count, v_new_followers
      FROM (SELECT fo.follower_id, coalesce(fo.accepted_at, fo.created_at) AS at,
                   row_number() OVER (ORDER BY coalesce(fo.accepted_at, fo.created_at) DESC) AS rn
              FROM public.follows fo
             WHERE fo.following_id = v_me
               AND fo.status = 'accepted'
               AND coalesce(fo.accepted_at, fo.created_at) > v_since) f
      JOIN public.profiles pr ON pr.id = f.follower_id;

    -- Social notifications ------------------------------------------------------------------
    SELECT coalesce(jsonb_object_agg(x.type, x.n), '{}'::jsonb)
      INTO v_social_counts
      FROM (SELECT n.type, count(*) AS n
              FROM public.notifications n
             WHERE n.user_id = v_me
               AND n.is_read = false
               AND n.type IN ('activitypub_mention', 'activitypub_reply', 'activitypub_favorite',
                              'activitypub_reblog', 'activitypub_reaction', 'activitypub_follow')
               AND n.created_at > v_recent
             GROUP BY n.type) x;

    WITH items AS (
        SELECT n.id, n.type, n.created_at,
               CASE WHEN n.data->>'post_id' ~* v_uuid THEN (n.data->>'post_id')::uuid END AS post_id
          FROM public.notifications n
         WHERE n.user_id = v_me
           AND n.is_read = false
           AND n.type IN ('activitypub_mention', 'activitypub_reply')
           AND n.created_at > v_recent
         ORDER BY n.created_at DESC
         LIMIT 10
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'notification_id', i.id,
               'type', i.type,
               'created_at', i.created_at,
               'post', jsonb_build_object(
                   'id', p.id, 'content', p.content, 'content_warning', p.content_warning,
                   'is_sensitive', coalesce(p.is_sensitive, false), 'created_at', p.created_at),
               'author', jsonb_build_object(
                   'id', a.id, 'username', a.username, 'display_name', a.display_name,
                   'avatar_url', a.avatar_url, 'domain', a.domain, 'is_local', a.is_local)
           ) ORDER BY i.created_at DESC), '[]'::jsonb)
      INTO v_social_items
      FROM (SELECT * FROM items LIMIT 5) i
      JOIN public.posts p ON p.id = i.post_id AND coalesce(p.is_deleted, false) = false
      JOIN public.profiles a ON a.id = p.author_id;

    -- Posts from followed accounts ----------------------------------------------------------
    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', r.id,
               'created_at', r.created_at,
               'content', r.content,
               'content_warning', r.content_warning,
               'is_sensitive', coalesce(r.is_sensitive, false),
               'media_count', jsonb_array_length(coalesce(r.media_attachments, '[]'::jsonb)),
               'replies_count', coalesce(r.replies_count, 0),
               'reblogs_count', coalesce(r.reblogs_count, 0),
               'favorites_count', coalesce(r.favorites_count, 0),
               'author', jsonb_build_object(
                   'id', a.id, 'username', a.username, 'display_name', a.display_name,
                   'avatar_url', a.avatar_url, 'domain', a.domain, 'is_local', a.is_local)
           ) ORDER BY r.score DESC), '[]'::jsonb)
      INTO v_posts
      FROM (
          -- float8 throughout: numeric power() cost 13 us a row.
          SELECT p.*,
                 (power(greatest(coalesce(p.replies_count, 0), 0)::float8, 0.9::float8) * 3
                  + power(greatest(coalesce(p.reblogs_count, 0), 0)::float8, 0.8::float8) * 2
                  + power(greatest(coalesce(p.favorites_count, 0), 0)::float8, 0.7::float8)
                  + 0.1)
                 * power(0.5::float8, extract(epoch FROM v_now - p.created_at)::float8 / 64800.0) AS score
            FROM public.posts p
            JOIN public.follows f
              ON f.following_id = p.author_id
             AND f.follower_id = v_me
             AND f.status = 'accepted'
           WHERE p.created_at > v_since
             AND p.in_reply_to IS NULL
             AND p.reblog IS NULL
             AND coalesce(p.is_deleted, false) = false
             AND p.visibility IN ('public', 'unlisted', 'followers')
           ORDER BY score DESC
           LIMIT 5
      ) r
      JOIN public.profiles a ON a.id = r.author_id;

    -- Instance announcements ----------------------------------------------------------------
    WITH unread AS (
        SELECT a.*
          FROM public.instance_announcements a
         WHERE a.is_active = true
           AND a.starts_at <= v_now
           AND (a.ends_at IS NULL OR a.ends_at > v_now)
           AND (a.is_pinned = true
                OR a.starts_at >= (SELECT pr.created_at FROM public.profiles pr WHERE pr.id = v_me))
           AND NOT EXISTS (SELECT 1 FROM public.announcement_reads ar
                            WHERE ar.announcement_id = a.id AND ar.user_id = v_auth)
    )
    SELECT (SELECT count(*) FROM unread),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', t.id, 'title', t.title, 'content', t.content, 'icon', t.icon,
               'image_url', t.image_url, 'is_pinned', coalesce(t.is_pinned, false),
               'created_at', t.created_at)
               ORDER BY t.is_pinned DESC, t.display_order, t.created_at DESC), '[]'::jsonb)
      INTO v_announcement_count, v_announcements
      FROM (SELECT u.* FROM unread u
             ORDER BY u.is_pinned DESC, u.display_order, u.created_at DESC
             LIMIT 3) t;

    RETURN jsonb_build_object(
        'generated_at', v_now,
        'since', v_since,
        'mentions', v_mentions,
        'conversations', v_conversations,
        'servers', v_servers,
        'threads', v_threads,
        'voice', v_voice,
        'follow_requests', v_follow_requests,
        'new_followers', v_new_followers,
        'social', jsonb_build_object('unread', v_social_counts, 'items', v_social_items),
        'followed_posts', v_posts,
        'announcements', v_announcements,
        'totals', jsonb_build_object(
            'unread_mentions', v_unread_mentions,
            'mentions_unread', v_mentions_unread,
            'conversations', v_conversation_count,
            'dm_messages', v_dm_messages,
            'servers', v_server_count,
            'channels', v_channel_count,
            'channel_messages', v_channel_messages,
            'threads', v_thread_count,
            'follow_requests', v_follow_request_count,
            'new_followers', v_new_follower_count,
            'announcements', v_announcement_count));
END;
$$;

REVOKE ALL ON FUNCTION public.get_today_summary(timestamp with time zone) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_today_summary(timestamp with time zone) TO authenticated;

-- As 20261022100001_remote_poll_votes.sql, with the block set from harmony_private.
CREATE OR REPLACE FUNCTION public.vote_remote_poll(p_post_id uuid, p_choices integer[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_post record;
    v_options jsonb;
    v_choices integer[];
    v_end timestamp with time zone;
    v_voters integer;
    v_sum integer;
    v_metadata jsonb;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'POLL_VOTE_UNAUTHENTICATED: sign in to vote' USING ERRCODE = '42501';
    END IF;

    SELECT p.id, p.author_id, p.visibility, p.content, p.metadata
      INTO v_post
      FROM public.posts p
     WHERE p.id = p_post_id
       AND p.is_local IS FALSE
       AND p.ap_type = 'Question'
       AND p.is_deleted IS NOT TRUE
       AND p.metadata->>'is_poll' = 'true'
     FOR UPDATE;

    -- posts_select_public, for a post the caller did not write.
    IF NOT FOUND
       OR v_post.author_id IN (SELECT harmony_private.current_user_block_peer_ids())
       OR NOT (
            v_post.visibility IN ('public', 'unlisted')
            OR (v_post.visibility = 'followers' AND EXISTS (
                    SELECT 1 FROM public.follows f
                     WHERE f.follower_id = v_me
                       AND f.following_id = v_post.author_id
                       AND f.status = 'accepted'))
            OR (v_post.visibility IN ('followers', 'direct') AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(v_post.content) part
                     WHERE part->>'type' = 'mention'
                       AND part->>'isLocal' = 'true'
                       AND part->>'username' = (SELECT public.current_profile_username())))) THEN
        RAISE EXCEPTION 'POLL_NOT_FOUND: no remote poll %', p_post_id USING ERRCODE = 'P0002';
    END IF;

    v_metadata := v_post.metadata;
    v_end := CASE WHEN v_metadata->>'poll_end_time' ~ '^\d{4}-\d{2}-\d{2}'
                  THEN (v_metadata->>'poll_end_time')::timestamp with time zone END;
    IF v_metadata->>'poll_closed' = 'true' OR v_end <= now() THEN
        RAISE EXCEPTION 'POLL_CLOSED: the poll has ended' USING ERRCODE = '22023';
    END IF;

    v_options := CASE WHEN jsonb_typeof(v_metadata->'poll_options') = 'array'
                      THEN v_metadata->'poll_options' ELSE '[]'::jsonb END;
    SELECT array_agg(DISTINCT c ORDER BY c) INTO v_choices FROM unnest(p_choices) c WHERE c IS NOT NULL;
    IF v_choices IS NULL
       OR EXISTS (SELECT 1 FROM unnest(v_choices) c WHERE c < 0 OR c >= jsonb_array_length(v_options)) THEN
        RAISE EXCEPTION 'POLL_CHOICE_INVALID: answers must name options of the poll' USING ERRCODE = '22023';
    END IF;
    IF cardinality(v_choices) > 1 AND v_metadata->>'poll_multiple_choice' IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'POLL_SINGLE_CHOICE: the poll takes one answer' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (SELECT 1 FROM public.post_poll_votes v WHERE v.post_id = p_post_id AND v.user_id = v_me) THEN
        RAISE EXCEPTION 'POLL_ALREADY_VOTED: a vote is final' USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.post_poll_votes (post_id, user_id, choice)
    SELECT p_post_id, v_me, c FROM unnest(v_choices) c;

    SELECT COALESCE(sum(CASE WHEN (o.value->>'votes') ~ '^\d+$' THEN (o.value->>'votes')::integer ELSE 0 END), 0)
      INTO v_sum
      FROM jsonb_array_elements(v_options) o;

    v_metadata := jsonb_set(v_metadata, '{poll_options}', COALESCE((
        SELECT jsonb_agg(
                   CASE WHEN (o.ord - 1)::integer = ANY (v_choices)
                        THEN o.value || jsonb_build_object('votes',
                                 CASE WHEN (o.value->>'votes') ~ '^\d+$' THEN (o.value->>'votes')::integer ELSE 0 END + 1)
                        ELSE o.value END
                   ORDER BY o.ord)
          FROM jsonb_array_elements(v_options) WITH ORDINALITY o(value, ord)), '[]'::jsonb));

    v_voters := CASE WHEN (v_metadata->>'poll_voters_count') ~ '^\d+$'
                     THEN (v_metadata->>'poll_voters_count')::integer ELSE 0 END;
    IF v_voters > 0 THEN
        v_metadata := jsonb_set(v_metadata, '{poll_voters_count}', to_jsonb(v_voters + 1));
    ELSIF v_sum = 0 THEN
        v_metadata := jsonb_set(v_metadata, '{poll_voters_count}', to_jsonb(1));
    END IF;

    UPDATE public.posts SET metadata = v_metadata WHERE id = p_post_id;

    PERFORM public.queue_federation_job(
        'federate-poll-vote',
        jsonb_build_object('type', 'create', 'post_id', p_post_id, 'user_id', v_me));

    RETURN v_metadata;
END;
$$;

REVOKE ALL ON FUNCTION public.vote_remote_poll(uuid, integer[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vote_remote_poll(uuid, integer[]) TO authenticated, service_role;

-- As 20261105990001_federated_message_polls.sql, with is_blocked_by from harmony_private.
CREATE OR REPLACE FUNCTION public.vote_message_poll(p_poll_id uuid, p_option_ids uuid[])
RETURNS TABLE(poll_id uuid, message_id uuid, question text, allow_multiple boolean,
              expires_at timestamp with time zone, closed boolean, total_voters integer,
              options jsonb, my_option_ids uuid[], is_author boolean, remote boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_allow_multiple boolean;
    v_closed boolean;
    v_remote boolean;
    v_author uuid;
    v_choice uuid[];
    v_removed integer;
    v_added integer;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT g.allow_multiple, g.closed, g.remote INTO v_allow_multiple, v_closed, v_remote
      FROM public.get_message_polls(ARRAY[p_poll_id]) g;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'POLL_NOT_FOUND: poll not found' USING ERRCODE = 'P0002';
    END IF;

    SELECT m.user_id INTO v_author
      FROM public.message_polls p JOIN public.messages m ON m.id = p.message_id
     WHERE p.id = p_poll_id;
    IF v_author IS NOT NULL AND harmony_private.is_blocked_by(v_author) THEN
        RAISE EXCEPTION 'POLL_NOT_FOUND: poll not found' USING ERRCODE = 'P0002';
    END IF;

    IF v_closed THEN
        RAISE EXCEPTION 'POLL_CLOSED: the poll has ended' USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(array_agg(DISTINCT o), '{}'::uuid[]) INTO v_choice
      FROM unnest(p_option_ids) AS o WHERE o IS NOT NULL;

    IF cardinality(v_choice) > 1 AND NOT v_allow_multiple THEN
        RAISE EXCEPTION 'POLL_SINGLE_CHOICE: this poll takes one answer' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1 FROM unnest(v_choice) AS o
         WHERE NOT EXISTS (SELECT 1 FROM public.message_poll_options po
                            WHERE po.poll_id = p_poll_id AND po.id = o)) THEN
        RAISE EXCEPTION 'POLL_OPTION_INVALID: the answer is not part of this poll' USING ERRCODE = '22023';
    END IF;

    -- One vote change per voter and poll at a time: concurrent single-choice votes would
    -- otherwise both insert.
    PERFORM pg_advisory_xact_lock(hashtextextended('message_poll_vote:' || p_poll_id::text || ':' || v_me::text, 0));

    IF v_remote THEN
        IF EXISTS (SELECT 1 FROM public.message_poll_votes v WHERE v.poll_id = p_poll_id AND v.user_id = v_me) THEN
            RAISE EXCEPTION 'POLL_ALREADY_VOTED: a vote on this poll is final' USING ERRCODE = '23505';
        END IF;
        IF cardinality(v_choice) > 0 THEN
            INSERT INTO public.message_poll_votes (poll_id, option_id, user_id)
            SELECT p_poll_id, o, v_me FROM unnest(v_choice) AS o;
            UPDATE public.message_poll_options po SET remote_votes = po.remote_votes + 1
             WHERE po.poll_id = p_poll_id AND po.id = ANY (v_choice);
            UPDATE public.message_polls p SET remote_voters = p.remote_voters + 1 WHERE p.id = p_poll_id;
            PERFORM public.broadcast_message_poll_event(p_poll_id, 'poll:vote');
            PERFORM public.queue_message_poll_federation(p_poll_id, 'vote', v_me);
        END IF;
        RETURN QUERY SELECT * FROM public.get_message_polls(ARRAY[p_poll_id]);
        RETURN;
    END IF;

    DELETE FROM public.message_poll_votes v
     WHERE v.poll_id = p_poll_id
       AND v.user_id = v_me
       AND v.option_id <> ALL (v_choice);
    GET DIAGNOSTICS v_removed = ROW_COUNT;

    INSERT INTO public.message_poll_votes AS v (poll_id, option_id, user_id)
    SELECT p_poll_id, o, v_me FROM unnest(v_choice) AS o
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_added = ROW_COUNT;

    IF v_removed + v_added > 0 THEN
        PERFORM public.broadcast_message_poll_event(p_poll_id, 'poll:vote');
        PERFORM public.queue_message_poll_federation(p_poll_id, 'state');
    END IF;

    RETURN QUERY SELECT * FROM public.get_message_polls(ARRAY[p_poll_id]);
END;
$$;

REVOKE ALL ON FUNCTION public.vote_message_poll(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vote_message_poll(uuid, uuid[]) TO authenticated, service_role;

-- As 20261109600001_client_write_boundaries.sql, with the block set from harmony_private.
CREATE OR REPLACE FUNCTION public.current_user_reads_post(p_post_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.posts
         WHERE posts.id = p_post_id
           AND ((author_id = ( SELECT get_current_profile_id() AS get_current_profile_id)) OR ((NOT (author_id IN ( SELECT harmony_private.current_user_block_peer_ids() AS current_user_block_peer_ids))) AND ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) OR ((visibility = 'followers'::text) AND (EXISTS ( SELECT 1
   FROM follows
  WHERE ((follows.follower_id = ( SELECT get_current_profile_id() AS get_current_profile_id)) AND (follows.following_id = posts.author_id) AND (follows.status = 'accepted'::text))))) OR ((visibility = ANY (ARRAY['followers'::text, 'direct'::text])) AND (EXISTS ( SELECT 1
   FROM jsonb_array_elements(posts.content) part(value)
  WHERE (((part.value ->> 'type'::text) = 'mention'::text) AND ((part.value ->> 'isLocal'::text) = 'true'::text) AND ((part.value ->> 'username'::text) = ( SELECT current_profile_username() AS current_profile_username)))))))))
    );
$$;

REVOKE ALL ON FUNCTION public.current_user_reads_post(uuid) FROM PUBLIC, anon, authenticated;

-- Prod definers have mixed owners, postgres and supabase_admin. A definer runs as its owner, and a
-- non-superuser owner has no EXECUTE on a helper with PUBLIC revoked.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT DISTINCT h.helper, pg_get_userbyid(p.proowner) AS owner
          FROM (VALUES
                  ('is_blocked_by(uuid)', ARRAY['vote_message_poll']),
                  ('current_user_block_peer_ids()', ARRAY['vote_remote_poll', 'current_user_reads_post'])
               ) AS h(helper, callers)
          JOIN pg_proc p ON p.proname = ANY (h.callers) AND p.pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE format('GRANT USAGE ON SCHEMA harmony_private TO %I', r.owner);
        EXECUTE format('GRANT EXECUTE ON FUNCTION harmony_private.%s TO %I', r.helper, r.owner);
    END LOOP;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
