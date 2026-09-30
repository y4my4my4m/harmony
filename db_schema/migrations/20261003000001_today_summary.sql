-- get_today_summary: the Today dashboard in one round trip.
--
-- SECURITY INVOKER. Every row it returns passes the caller's own RLS: a channel, thread or
-- channel message only when its channel is in current_user_viewable_channel_ids(), a
-- conversation message only for a participant who has not left, a post only as posts RLS
-- admits it. The function adds narrowing of its own and never widens.
--
-- Sections, keys of the returned object:
--   mentions         'mention' notifications and replies to the caller's messages, last 14 days,
--                    one entry per message, newest first, 20 at most. unread: created at or after
--                    the channel's or conversation's unread_counts.last_read_at and, for a
--                    notification, not marked read.
--   conversations    conversations with unread messages, the caller a current participant, not
--                    muted, not dismissed since the last message; newest first, 8 at most.
--   servers          unread channels grouped by server; 12 channels per server, 20 servers.
--   threads          threads the caller is in, not archived or muted, with messages from others
--                    after the caller last read or posted there; 20 at most.
--   voice            voice channels with participants now; rows older than 12 hours are left
--                    out, since a crashed client's row is removed only when another participant
--                    observes the departure.
--   follow_requests  pending follows of the caller.
--   new_followers    accepted follows of the caller created since `since`.
--   social           unread activitypub_* notification counts by type, and the latest 5 unread
--                    post mentions and replies.
--   followed_posts   top-level posts since `since` by accounts the caller follows, 5 at most,
--                    ranked by (3 replies^0.9 + 2 reblogs^0.8 + favourites^0.7 + 0.1) with an
--                    18-hour half-life.
--   announcements    active instance announcements the caller has not read, those started
--                    before the caller's profile existed only when pinned. announcement_reads
--                    keys on auth.uid(), as its RLS does.
--   totals           counts over each whole section rather than its truncated list, except
--                    mentions_unread, which counts the listed mentions.
--
-- `since` is p_since clamped to [now - 7 days, now - 12 hours]; NULL reads as now - 1 day.
-- Encrypted message content is returned as stored; the client decrypts or shows a placeholder.
--
-- Seeded local DB, supabase/postgres 15.8.1.060, warm, best of six: a caller in 40 servers
-- (1,000 channels) with 300k messages, 1,000 unread channels, 400 active threads, 8k
-- notifications, 60 conversations and 300 followed accounts posting 30k posts takes 31 ms; a
-- member of the same servers with nothing unread takes 10 ms. Most of the floor is RLS: every
-- reference to channels, threads or messages evaluates current_user_viewable_channel_ids(),
-- about 0.5 ms each at 1,000 channels.

BEGIN;

SET LOCAL lock_timeout = '3s';

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
BEGIN
    IF v_me IS NULL THEN
        RETURN NULL;
    END IF;

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
           AND (m.user_id IS NULL OR m.user_id NOT IN (SELECT public.current_user_block_peer_ids()))
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
          FROM public.unread_counts u
          JOIN public.conversation_participants cp
            ON cp.conversation_id = u.conversation_id
           AND cp.user_id = v_me
           AND cp.left_at IS NULL
         WHERE u.user_id = v_me
           AND u.conversation_id IS NOT NULL
           AND (u.unread_messages > 0 OR u.unread_mentions > 0)
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
               u.updated_at
          FROM public.unread_counts u
          JOIN public.channels c ON c.id = u.channel_id
         WHERE u.user_id = v_me
           AND u.channel_id IS NOT NULL
           AND (u.unread_messages > 0 OR u.unread_mentions > 0)
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

-- Supabase default privileges grant new functions to anon, authenticated and service_role by
-- name; a service_role caller has no profile and would only ever get NULL.
REVOKE ALL ON FUNCTION public.get_today_summary(timestamp with time zone) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_today_summary(timestamp with time zone) TO authenticated;

COMMIT;
