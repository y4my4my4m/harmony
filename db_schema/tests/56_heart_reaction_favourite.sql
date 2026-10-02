-- The heart reaction is the favourite (20261005500001_heart_reaction_is_favourite.sql).
--
-- Profiles:
--   viewer   local, has an auth user
--   author   local
--   misskey  remote, mk56.test
--   mastodon remote, md56.test
--   akkoma   remote, ak56.test
--
-- Posts, all public:
--   01  author   local    new writes and the RPCs
--   02  misskey  remote   is_favorited on the federated timeline
--   03  author   local    legacy rows folded by the migration
--   04  misskey  remote   legacy rows folded by the migration, origin count 7
--
-- queue_federation_job is replaced for the transaction by one recording each job, so the
-- payloads the triggers queue can be read back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(26);

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES ('f5600000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'viewer56@test.local');

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
VALUES
  ('f5610000-0000-0000-0000-0000000000a1', 'f5600000-0000-0000-0000-0000000000a1', 'viewer56', 'Viewer', true),
  ('f5610000-0000-0000-0000-0000000000a2', NULL, 'author56', 'Author', true);

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
VALUES
  ('f5610000-0000-0000-0000-0000000000a3', NULL, 'misskey56', 'Misskey', false, 'mk56.test'),
  ('f5610000-0000-0000-0000-0000000000a4', NULL, 'mastodon56', 'Mastodon', false, 'md56.test'),
  ('f5610000-0000-0000-0000-0000000000a5', NULL, 'akkoma56', 'Akkoma', false, 'ak56.test');

INSERT INTO public.posts (id, author_id, content, visibility, is_local, favorites_count)
VALUES
  ('f5620000-0000-0000-0000-000000000001', 'f5610000-0000-0000-0000-0000000000a2',
   '[{"type":"text","text":"one"}]', 'public', true, 0),
  ('f5620000-0000-0000-0000-000000000002', 'f5610000-0000-0000-0000-0000000000a3',
   '[{"type":"text","text":"two"}]', 'public', false, 0),
  ('f5620000-0000-0000-0000-000000000003', 'f5610000-0000-0000-0000-0000000000a2',
   '[{"type":"text","text":"three"}]', 'public', true, 0),
  ('f5620000-0000-0000-0000-000000000004', 'f5610000-0000-0000-0000-0000000000a3',
   '[{"type":"text","text":"four"}]', 'public', false, 7);

CREATE TEMP TABLE captured_jobs (name text, data jsonb);
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO pg_temp.captured_jobs VALUES (p_job_name, p_job_data);
    RETURN gen_random_uuid();
END;
$$;

CREATE TEMP VIEW rows56 AS
SELECT right(pi.post_id::text, 2) AS post, right(pi.user_id::text, 2) AS who,
       pi.interaction_type, pi.custom_emoji_content
  FROM public.post_interactions pi
 WHERE pi.post_id::text LIKE 'f5620000-%';
GRANT SELECT ON rows56, captured_jobs TO authenticated;

-- Catalog -------------------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT public.is_heart_reaction(c)
         FROM unnest(ARRAY[E'\u2764', E'\u2764\uFE0F', E'\u2764\uFE0E', E'\u2665', E'\u2665\uFE0F', ' ❤ ',
                           '💗', '🩷', '👍', ':heart:', '', NULL]) WITH ORDINALITY u(c, i)
        ORDER BY i$q$,
    $q$VALUES (true), (true), (true), (true), (true), (true),
              (false), (false), (false), (false), (false), (false)$q$,
    'is_heart_reaction holds for ❤ and ♥ with any variation selector, and for nothing else');

SELECT is((SELECT min(t.tgname::text) FROM pg_trigger t
            WHERE t.tgrelid = 'public.post_interactions'::regclass AND NOT t.tgisinternal
              AND t.tgtype & 2 = 2 AND t.tgtype & 4 = 4),
          'trg_fold_heart_reaction',
          'the fold is the first BEFORE INSERT trigger, ahead of the federation queue');

SELECT ok(NOT EXISTS (
            SELECT 1 FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace
               AND p.proname IN ('get_enhanced_timeline_posts', 'get_federated_timeline',
                                 'get_post_with_context', 'get_trending_posts')
               AND p.prosrc ~ 'emoji_reaction'),
          'no is_favorited predicate counts an emoji reaction');

-- Inbound writes, as the federation backend makes them. ---------------------------------
INSERT INTO public.post_interactions (user_id, post_id, interaction_type, custom_emoji_content, is_local)
VALUES ('f5610000-0000-0000-0000-0000000000a3', 'f5620000-0000-0000-0000-000000000001', 'emoji_reaction', '❤️', false);

SELECT results_eq(
    $q$SELECT who, interaction_type, custom_emoji_content FROM rows56 WHERE post = '01'$q$,
    $q$VALUES ('a3'::text, 'favorite'::text, NULL::text)$q$,
    'a ❤️ reaction is written as the favourite');
SELECT is((SELECT favorites_count FROM public.posts WHERE id = 'f5620000-0000-0000-0000-000000000001'), 1,
          'the favourite counts');
SELECT is((SELECT data->>'interaction_type' FROM captured_jobs WHERE name = 'federate-reaction'), 'favorite',
          'the federation job queued is the favourite''s');

INSERT INTO public.post_interactions (user_id, post_id, interaction_type, custom_emoji_content, is_local)
VALUES ('f5610000-0000-0000-0000-0000000000a3', 'f5620000-0000-0000-0000-000000000001', 'emoji_reaction', '♥', false);
SELECT is((SELECT count(*)::int FROM rows56 WHERE post = '01' AND who = 'a3'), 1,
          'a second heart from the same actor is dropped: one favourite per actor');

INSERT INTO public.post_interactions (user_id, post_id, interaction_type, custom_emoji_content, is_local)
VALUES ('f5610000-0000-0000-0000-0000000000a3', 'f5620000-0000-0000-0000-000000000001', 'emoji_reaction', '🎉', false);
SELECT results_eq(
    $q$SELECT interaction_type, custom_emoji_content FROM rows56 WHERE post = '01' ORDER BY interaction_type$q$,
    $q$VALUES ('emoji_reaction'::text, '🎉'::text), ('favorite'::text, NULL::text)$q$,
    'any other emoji is a reaction beside the favourite');
SELECT is((SELECT favorites_count FROM public.posts WHERE id = 'f5620000-0000-0000-0000-000000000001'), 1,
          'a reaction does not count as a favourite');

TRUNCATE captured_jobs;
DELETE FROM public.post_interactions
 WHERE post_id = 'f5620000-0000-0000-0000-000000000001' AND custom_emoji_content = '🎉';
SELECT results_eq(
    $q$SELECT data->>'type', data->>'interaction_type', data->>'custom_emoji_content'
         FROM captured_jobs WHERE name = 'federate-reaction'$q$,
    $q$VALUES ('delete'::text, 'emoji_reaction'::text, '🎉'::text)$q$,
    'the delete job names the emoji, so the Undo removes that reaction alone');
SELECT is((SELECT favorites_count FROM public.posts WHERE id = 'f5620000-0000-0000-0000-000000000001'), 1,
          'removing a reaction leaves the favourite count alone');

TRUNCATE captured_jobs;
INSERT INTO public.post_interactions (user_id, post_id, interaction_type, is_local)
VALUES ('f5610000-0000-0000-0000-0000000000a1', 'f5620000-0000-0000-0000-000000000001', 'reblog', true);
SELECT results_eq(
    $q$SELECT (SELECT federation_status FROM public.post_interactions
                WHERE post_id = 'f5620000-0000-0000-0000-000000000001' AND interaction_type = 'reblog'),
              (SELECT count(*)::int FROM captured_jobs WHERE name = 'federate-reaction')$q$,
    $q$VALUES ('skipped'::text, 0)$q$,
    'a reblog row queues no Like: the boost post carries the Announce');
DELETE FROM public.post_interactions
 WHERE post_id = 'f5620000-0000-0000-0000-000000000001' AND interaction_type = 'reblog';

-- RPCs, as the viewer. -------------------------------------------------------------------
SELECT tests.authenticate_as('f5600000-0000-0000-0000-0000000000a1');

CREATE TEMP TABLE rpc56 ON COMMIT DROP AS
SELECT public.add_post_emoji_reaction('f5610000-0000-0000-0000-0000000000a1',
         'f5620000-0000-0000-0000-000000000001', NULL, '❤️') AS first_id,
       NULL::uuid AS second_id;
UPDATE rpc56 SET second_id = public.add_post_emoji_reaction('f5610000-0000-0000-0000-0000000000a1',
         'f5620000-0000-0000-0000-000000000001', NULL, '❤');

SELECT is((SELECT first_id FROM rpc56),
          (SELECT id FROM public.post_interactions
            WHERE user_id = 'f5610000-0000-0000-0000-0000000000a1'
              AND post_id = 'f5620000-0000-0000-0000-000000000001'
              AND interaction_type = 'favorite'),
          'picking ❤ favourites and returns the favourite');
SELECT ok((SELECT first_id = second_id FROM rpc56)
          AND (SELECT favorites_count FROM public.posts WHERE id = 'f5620000-0000-0000-0000-000000000001') = 2,
          'picking a heart again returns the same favourite and counts it once');

SELECT public.add_post_emoji_reaction('f5610000-0000-0000-0000-0000000000a1',
         'f5620000-0000-0000-0000-000000000001', NULL, '🎉');
SELECT is(public.remove_post_emoji_reaction('f5610000-0000-0000-0000-0000000000a1',
            'f5620000-0000-0000-0000-000000000001', NULL, '❤'), true,
          'removing the ❤ reaction removes the favourite');
SELECT results_eq(
    $q$SELECT interaction_type, custom_emoji_content FROM rows56 WHERE post = '01' AND who = 'a1'$q$,
    $q$VALUES ('emoji_reaction'::text, '🎉'::text)$q$,
    'the viewer''s other reaction stays');
SELECT is(public.get_post_with_context('f5620000-0000-0000-0000-000000000001',
            'f5610000-0000-0000-0000-0000000000a1')->'mainPost'->>'is_favorited', 'false',
          'a reaction alone does not fill the heart');

SELECT public.add_post_emoji_reaction('f5610000-0000-0000-0000-0000000000a1',
         'f5620000-0000-0000-0000-000000000002', NULL, '🎉');
SELECT is((SELECT is_favorited FROM public.get_federated_timeline('f5610000-0000-0000-0000-0000000000a1', 200)
            WHERE id = 'f5620000-0000-0000-0000-000000000002'), false,
          'the federated timeline reads is_favorited from the favourite alone');
SELECT public.add_post_emoji_reaction('f5610000-0000-0000-0000-0000000000a1',
         'f5620000-0000-0000-0000-000000000002', NULL, '♥️');
SELECT is((SELECT is_favorited FROM public.get_federated_timeline('f5610000-0000-0000-0000-0000000000a1', 200)
            WHERE id = 'f5620000-0000-0000-0000-000000000002'), true,
          'a heart fills it');

SELECT tests.clear_authentication();

-- Legacy rows, folded by the migration's own block. ---------------------------------------
-- The pre-migration state: update_post_reaction_counts counting every emoji reaction, and
-- no fold on insert.
-- 03 (local): misskey ❤️; mastodon favourite and ❤; akkoma ❤ then ❤️ and 🎉. Counted 6.
-- 04 (remote, origin count 7): misskey ❤ then ❤️; mastodon 👍. Counted 10.
CREATE OR REPLACE FUNCTION public.update_post_reaction_counts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions', 'pg_temp' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.interaction_type = 'emoji_reaction' OR NEW.interaction_type = 'favorite' THEN
      UPDATE posts SET favorites_count = favorites_count + 1 WHERE id = NEW.post_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.interaction_type = 'emoji_reaction' OR OLD.interaction_type = 'favorite' THEN
      UPDATE posts SET favorites_count = GREATEST(favorites_count - 1, 0) WHERE id = OLD.post_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;
ALTER TABLE public.post_interactions DISABLE TRIGGER trg_fold_heart_reaction;
INSERT INTO public.post_interactions (id, user_id, post_id, interaction_type, custom_emoji_content, is_local, created_at)
VALUES
  ('f5630000-0000-0000-0000-000000000001', 'f5610000-0000-0000-0000-0000000000a3', 'f5620000-0000-0000-0000-000000000003', 'emoji_reaction', '❤️', false, '2026-09-01 10:00+00'),
  ('f5630000-0000-0000-0000-000000000002', 'f5610000-0000-0000-0000-0000000000a4', 'f5620000-0000-0000-0000-000000000003', 'favorite', NULL, false, '2026-09-01 10:00+00'),
  ('f5630000-0000-0000-0000-000000000003', 'f5610000-0000-0000-0000-0000000000a4', 'f5620000-0000-0000-0000-000000000003', 'emoji_reaction', '❤', false, '2026-09-01 10:01+00'),
  ('f5630000-0000-0000-0000-000000000004', 'f5610000-0000-0000-0000-0000000000a5', 'f5620000-0000-0000-0000-000000000003', 'emoji_reaction', '❤', false, '2026-09-01 10:00+00'),
  ('f5630000-0000-0000-0000-000000000005', 'f5610000-0000-0000-0000-0000000000a5', 'f5620000-0000-0000-0000-000000000003', 'emoji_reaction', '❤️', false, '2026-09-01 10:02+00'),
  ('f5630000-0000-0000-0000-000000000006', 'f5610000-0000-0000-0000-0000000000a5', 'f5620000-0000-0000-0000-000000000003', 'emoji_reaction', '🎉', false, '2026-09-01 10:03+00'),
  ('f5630000-0000-0000-0000-000000000007', 'f5610000-0000-0000-0000-0000000000a3', 'f5620000-0000-0000-0000-000000000004', 'emoji_reaction', '❤', false, '2026-09-01 10:00+00'),
  ('f5630000-0000-0000-0000-000000000008', 'f5610000-0000-0000-0000-0000000000a3', 'f5620000-0000-0000-0000-000000000004', 'emoji_reaction', '❤️', false, '2026-09-01 10:01+00'),
  ('f5630000-0000-0000-0000-000000000009', 'f5610000-0000-0000-0000-0000000000a4', 'f5620000-0000-0000-0000-000000000004', 'emoji_reaction', '👍', false, '2026-09-01 10:00+00');
ALTER TABLE public.post_interactions ENABLE TRIGGER trg_fold_heart_reaction;
SELECT results_eq(
    $q$SELECT favorites_count FROM public.posts
        WHERE id IN ('f5620000-0000-0000-0000-000000000003', 'f5620000-0000-0000-0000-000000000004')
        ORDER BY id$q$,
    $q$VALUES (6), (10)$q$,
    'the old trigger counted every legacy row');
TRUNCATE captured_jobs;

-- The block is read from the migration file at /db_schema/migrations, where
-- scripts/run-db-tests.sh copies db_schema. Absent, the line below prints an ERROR the
-- runner reports.
\! sed -n '/^DO \$\$$/,/^\$\$;$/p' /db_schema/migrations/20261005500001_heart_reaction_is_favourite.sql > /tmp/fold56.sql
\! test -s /tmp/fold56.sql || echo 'ERROR: /db_schema/migrations/20261005500001_heart_reaction_is_favourite.sql is not in the container; copy db_schema to /db_schema'
\i /tmp/fold56.sql

SELECT results_eq(
    $q$SELECT pi.id, pi.interaction_type, pi.custom_emoji_content
         FROM public.post_interactions pi
        WHERE pi.post_id = 'f5620000-0000-0000-0000-000000000003'
        ORDER BY pi.id$q$,
    $q$VALUES ('f5630000-0000-0000-0000-000000000001'::uuid, 'favorite'::text, NULL::text),
              ('f5630000-0000-0000-0000-000000000002'::uuid, 'favorite'::text, NULL::text),
              ('f5630000-0000-0000-0000-000000000004'::uuid, 'favorite'::text, NULL::text),
              ('f5630000-0000-0000-0000-000000000006'::uuid, 'emoji_reaction'::text, '🎉'::text)$q$,
    'a lone heart becomes the favourite in place; a heart beside a favourite or an older heart is deleted');
SELECT results_eq(
    $q$SELECT pi.id, pi.interaction_type, pi.custom_emoji_content
         FROM public.post_interactions pi
        WHERE pi.post_id = 'f5620000-0000-0000-0000-000000000004'
        ORDER BY pi.id$q$,
    $q$VALUES ('f5630000-0000-0000-0000-000000000007'::uuid, 'favorite'::text, NULL::text),
              ('f5630000-0000-0000-0000-000000000009'::uuid, 'emoji_reaction'::text, '👍'::text)$q$,
    'the older of two hearts is kept');
SELECT results_eq(
    $q$SELECT favorites_count FROM public.posts
        WHERE id IN ('f5620000-0000-0000-0000-000000000003', 'f5620000-0000-0000-0000-000000000004')
        ORDER BY id$q$,
    $q$VALUES (3), (8)$q$,
    'a local post recounts its favourites; a remote post gives back the duplicate heart and the 👍');
SELECT is((SELECT count(*)::int FROM captured_jobs WHERE name = 'federate-reaction'), 0,
          'the fold queues no Undo');
SELECT is((SELECT tgenabled FROM pg_trigger
            WHERE tgrelid = 'public.post_interactions'::regclass
              AND tgname = 'trigger_federate_post_interaction_delete'), 'O'::"char",
          'the delete trigger is enabled again');

-- The migration replaces the trigger after the fold; a rerun meets the new one.
\! sed -n '/^CREATE OR REPLACE FUNCTION public.update_post_reaction_counts()/,/^\$\$;$/p' /db_schema/migrations/20261005500001_heart_reaction_is_favourite.sql > /tmp/counts56.sql
\! test -s /tmp/counts56.sql || echo 'ERROR: /db_schema/migrations/20261005500001_heart_reaction_is_favourite.sql is not in the container; copy db_schema to /db_schema'
\i /tmp/counts56.sql
\i /tmp/fold56.sql
SELECT results_eq(
    $q$SELECT favorites_count FROM public.posts
        WHERE id IN ('f5620000-0000-0000-0000-000000000003', 'f5620000-0000-0000-0000-000000000004')
        ORDER BY id$q$,
    $q$VALUES (3), (8)$q$,
    'a second run changes nothing');

SELECT * FROM finish();
ROLLBACK;
