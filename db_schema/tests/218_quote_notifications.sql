-- 20261105200001_quote_notifications.sql: a post quoting a local user's post notifies its
-- author with activitypub_quote, through send_notification: blocks, hiding mutes and
-- activitypub_quotes hold it back. Not notified: one's own post, a quote replying to the
-- quoted post, a quote mentioning its author, a direct quote, a followers-only quote of an
-- account the author does not follow, a quote of a remote post, a boost.
--
--   alice, bob      fixture members (01_fixtures.sql)
--   remote218       a profile of another instance
--   carol218        a local profile alice blocks, then mutes

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(19);

INSERT INTO public.profiles (id, username, display_name, domain, is_local)
VALUES ('f2180000-0000-0000-0000-0000000000a1', 'remote218', 'Remote', 'quotes218.test', false);
INSERT INTO public.profiles (id, username, display_name, is_local)
VALUES ('f2180000-0000-0000-0000-0000000000a2', 'carol218', 'Carol', true);

INSERT INTO public.posts (id, author_id, visibility, is_local, content) VALUES
  ('f2180000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'public', true,
   '[{"type":"text","text":"quote me"}]'),
  ('f2180000-0000-0000-0000-000000000002', 'f2180000-0000-0000-0000-0000000000a1', 'public', false,
   '[{"type":"text","text":"a remote post"}]');

CREATE FUNCTION pg_temp.quote(p_id text, p_author text, p_visibility text DEFAULT 'public',
                              p_quoted text DEFAULT 'f2180000-0000-0000-0000-000000000001',
                              p_in_reply_to text DEFAULT NULL, p_is_quote boolean DEFAULT true,
                              p_content jsonb DEFAULT '[{"type":"text","text":"look at this"}]')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.posts (id, author_id, visibility, is_local, in_reply_to, content, metadata)
  VALUES (p_id::uuid, p_author::uuid, p_visibility,
          (SELECT is_local FROM public.profiles WHERE id = p_author::uuid),
          p_in_reply_to::uuid, p_content,
          CASE WHEN p_is_quote THEN jsonb_build_object('reblog_of', p_quoted, 'is_quote', true)
               ELSE jsonb_build_object('reblog_of', p_quoted) END);
$$;

CREATE FUNCTION pg_temp.quotes_for(p_post text) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.notifications
   WHERE user_id = '11111111-0000-0000-0000-000000000001'
     AND type = 'activitypub_quote' AND data->>'post_id' = p_post;
$$;

-- Preferences. -------------------------------------------------------------------------------------
SELECT is((SELECT array_agg(column_default::text ORDER BY column_name) FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'notification_preferences'
              AND column_name IN ('activitypub_quotes', 'activitypub_desktop_quotes', 'activitypub_sound_quotes')),
  ARRAY['true', 'true', 'true'],
  'quotes alert in the bell, as a system notification and with a sound by default');
SELECT ok(has_column_privilege('authenticated', 'public.notification_preferences', 'activitypub_sound_quotes', 'UPDATE'),
  'a signed-in user can change the quote settings');

-- A remote quote. ----------------------------------------------------------------------------------
SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000101', 'f2180000-0000-0000-0000-0000000000a1');
SELECT is(pg_temp.quotes_for('f2180000-0000-0000-0000-000000000101'), 1,
  'a quote from another instance notifies the quoted author');
SELECT is((SELECT data->'sender'->>'username' || '|' || (data->>'from_user_id') || '|' || (data->>'quoted_post_id')
             || '|' || (data->'post'->>'content_preview')
             FROM public.notifications
            WHERE type = 'activitypub_quote' AND data->>'post_id' = 'f2180000-0000-0000-0000-000000000101'),
  'remote218|f2180000-0000-0000-0000-0000000000a1|f2180000-0000-0000-0000-000000000001|look at this',
  'naming the quoter, the quoted post and the quote''s text');

-- A local quote. -----------------------------------------------------------------------------------
SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000102', '22222222-0000-0000-0000-000000000002');
SELECT is(pg_temp.quotes_for('f2180000-0000-0000-0000-000000000102'), 1, 'a local quote notifies too');

-- Not notified. ------------------------------------------------------------------------------------
SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000103', '11111111-0000-0000-0000-000000000001');
SELECT is(pg_temp.quotes_for('f2180000-0000-0000-0000-000000000103'), 0, 'quoting one''s own post');

SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000104', '22222222-0000-0000-0000-000000000002',
                     p_in_reply_to => 'f2180000-0000-0000-0000-000000000001');
SELECT is(pg_temp.quotes_for('f2180000-0000-0000-0000-000000000104'), 0, 'a quote replying to the quoted post');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE type = 'activitypub_reply'
            AND data->>'post_id' = 'f2180000-0000-0000-0000-000000000104'), 1, 'which notifies as a reply');

SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000105', '22222222-0000-0000-0000-000000000002',
                     p_content => '[{"type":"mention","username":"alice","isLocal":true},{"type":"text","text":" see"}]');
SELECT is(pg_temp.quotes_for('f2180000-0000-0000-0000-000000000105'), 0, 'a quote mentioning the quoted author');
SELECT ok((SELECT count(*) FROM public.notifications WHERE type IN ('activitypub_mention', 'mention')
            AND user_id = '11111111-0000-0000-0000-000000000001'
            AND data->>'post_id' = 'f2180000-0000-0000-0000-000000000105') > 0, 'which notifies as a mention');

SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000106', '22222222-0000-0000-0000-000000000002', 'direct');
SELECT is(pg_temp.quotes_for('f2180000-0000-0000-0000-000000000106'), 0, 'a direct quote');

SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000107', '22222222-0000-0000-0000-000000000002', 'followers');
SELECT is(pg_temp.quotes_for('f2180000-0000-0000-0000-000000000107'), 0,
  'a followers-only quote by an account the quoted author does not follow');
INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'accepted');
SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000108', '22222222-0000-0000-0000-000000000002', 'followers');
SELECT is(pg_temp.quotes_for('f2180000-0000-0000-0000-000000000108'), 1, 'one by an account the quoted author follows');

SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000109', '22222222-0000-0000-0000-000000000002',
                     p_quoted => 'f2180000-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE type = 'activitypub_quote'
            AND data->>'post_id' = 'f2180000-0000-0000-0000-000000000109'), 0, 'a quote of a remote post');

SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000110', '22222222-0000-0000-0000-000000000002',
                     p_is_quote => false);
SELECT is(pg_temp.quotes_for('f2180000-0000-0000-0000-000000000110'), 0, 'a boost');

INSERT INTO public.user_blocks (blocker_id, blocked_user_id)
VALUES ('11111111-0000-0000-0000-000000000001', 'f2180000-0000-0000-0000-0000000000a2');
SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000111', 'f2180000-0000-0000-0000-0000000000a2');
SELECT is(pg_temp.quotes_for('f2180000-0000-0000-0000-000000000111'), 0, 'a quote by a blocked account');
DELETE FROM public.user_blocks WHERE blocker_id = '11111111-0000-0000-0000-000000000001';

INSERT INTO public.user_mutes (muter_id, muted_user_id, hide_notifications)
VALUES ('11111111-0000-0000-0000-000000000001', 'f2180000-0000-0000-0000-0000000000a2', true);
SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000112', 'f2180000-0000-0000-0000-0000000000a2');
SELECT is(pg_temp.quotes_for('f2180000-0000-0000-0000-000000000112'), 0, 'a quote by an account muted with its notifications');
DELETE FROM public.user_mutes WHERE muter_id = '11111111-0000-0000-0000-000000000001';

INSERT INTO public.notification_preferences (user_id, activitypub_quotes)
VALUES ('11111111-0000-0000-0000-000000000001', false)
ON CONFLICT (user_id) DO UPDATE SET activitypub_quotes = false;
SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000113', 'f2180000-0000-0000-0000-0000000000a2');
SELECT is(pg_temp.quotes_for('f2180000-0000-0000-0000-000000000113'), 0, 'quotes turned off in the settings');
UPDATE public.notification_preferences SET activitypub_quotes = true
 WHERE user_id = '11111111-0000-0000-0000-000000000001';
SELECT pg_temp.quote('f2180000-0000-0000-0000-000000000114', 'f2180000-0000-0000-0000-0000000000a2');
SELECT is(pg_temp.quotes_for('f2180000-0000-0000-0000-000000000114'), 1, 'and on again');

SELECT * FROM finish();
ROLLBACK;
