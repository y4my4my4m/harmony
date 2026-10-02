-- A reaction is also a favourite; reaction limits
-- (20261007200001_reactions_favourites_limits.sql).
--
-- Profiles:
--   viewer   local, has an auth user
--   admin    local, has an auth user, instance admin
--   author   local
--   misskey  remote, mk74.test
--   akkoma   remote, ak74.test
--   friend   local, has an auth user
--
-- Posts, all public:
--   01  author   local    implied favourite through the RPCs; heart on an implied favourite
--   02  author   local    explicit favourite kept
--   03  author   local    unfavourite; favourites per person
--   04  author   local    per-person limit
--   05  misskey  remote   inbound reactions over the limit, origin count 5
--   06  author   local    backfill, stale count 1
--   07  misskey  remote   backfill, origin count 9
--
-- Message M1 is a DM between viewer and friend.
--
-- queue_federation_job is replaced for the transaction by one recording each job.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(47);

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES
  ('f7400000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'viewer74@test.local'),
  ('f7400000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'admin74@test.local'),
  ('f7400000-0000-0000-0000-0000000000a6', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'friend74@test.local');

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_admin)
VALUES
  ('f7410000-0000-0000-0000-0000000000a1', 'f7400000-0000-0000-0000-0000000000a1', 'viewer74', 'Viewer', true, false),
  ('f7410000-0000-0000-0000-0000000000a2', 'f7400000-0000-0000-0000-0000000000a2', 'admin74', 'Admin', true, true),
  ('f7410000-0000-0000-0000-0000000000a3', NULL, 'author74', 'Author', true, false),
  ('f7410000-0000-0000-0000-0000000000a6', 'f7400000-0000-0000-0000-0000000000a6', 'friend74', 'Friend', true, false);

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
VALUES
  ('f7410000-0000-0000-0000-0000000000a4', NULL, 'misskey74', 'Misskey', false, 'mk74.test'),
  ('f7410000-0000-0000-0000-0000000000a5', NULL, 'akkoma74', 'Akkoma', false, 'ak74.test');

INSERT INTO public.posts (id, author_id, content, visibility, is_local, favorites_count)
SELECT ('f7420000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       CASE WHEN n IN (5, 7) THEN 'f7410000-0000-0000-0000-0000000000a4'::uuid
            ELSE 'f7410000-0000-0000-0000-0000000000a3'::uuid END,
       jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'post ' || n)),
       'public', n NOT IN (5, 7),
       CASE n WHEN 5 THEN 5 WHEN 6 THEN 1 WHEN 7 THEN 9 ELSE 0 END
  FROM generate_series(1, 7) n;

INSERT INTO public.conversations (id, type)
VALUES ('f7440000-0000-0000-0000-000000000001', 'direct');
INSERT INTO public.conversation_participants (conversation_id, user_id)
VALUES ('f7440000-0000-0000-0000-000000000001', 'f7410000-0000-0000-0000-0000000000a1'),
       ('f7440000-0000-0000-0000-000000000001', 'f7410000-0000-0000-0000-0000000000a6');
INSERT INTO public.messages (id, conversation_id, user_id, content)
VALUES ('f7450000-0000-0000-0000-000000000001', 'f7440000-0000-0000-0000-000000000001',
        'f7410000-0000-0000-0000-0000000000a1', '[{"type":"text","text":"m1"}]'::jsonb);

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

CREATE TEMP VIEW rows74 AS
SELECT right(pi.post_id::text, 2) AS post, right(pi.user_id::text, 2) AS who,
       pi.interaction_type, pi.custom_emoji_content, pi.implied_by_reaction AS implied
  FROM public.post_interactions pi
 WHERE pi.post_id::text LIKE 'f7420000-%';

CREATE TEMP VIEW jobs74 AS
SELECT data->>'type' AS op, data->>'interaction_type' AS kind,
       data->>'custom_emoji_content' AS emoji, (data->>'implied')::boolean AS implied
  FROM captured_jobs
 WHERE name = 'federate-reaction';

CREATE FUNCTION pg_temp.favs(p_post text) RETURNS integer LANGUAGE sql AS
$$ SELECT favorites_count FROM public.posts WHERE id = ('f7420000-0000-0000-0000-0000000000' || p_post)::uuid $$;

-- Catalog -------------------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'post_interactions'
          AND column_name = 'implied_by_reaction'$q$,
    $q$VALUES ('NO'::information_schema.yes_or_no, 'false'::information_schema.character_data)$q$,
    'post_interactions.implied_by_reaction is NOT NULL DEFAULT false');

SELECT throws_ok(
    $q$INSERT INTO public.post_interactions (user_id, post_id, interaction_type, custom_emoji_content, implied_by_reaction)
       VALUES ('f7410000-0000-0000-0000-0000000000a3', 'f7420000-0000-0000-0000-000000000002', 'emoji_reaction', '🎉', true)$q$,
    '23514', NULL, 'only a favourite can be implied');

SELECT ok('max_post_reactions_per_user' = ANY (public.public_instance_config_keys())
          AND (SELECT config_value FROM public.instance_config
                WHERE config_key = 'max_post_reactions_per_user') = '10'::jsonb,
          'max_post_reactions_per_user is a public key, 10 by default');

SELECT results_eq(
    $q$SELECT p.proname::text COLLATE "default", p.prosecdef,
              'search_path=public, pg_temp' = ANY (p.proconfig),
              has_function_privilege('anon', p.oid, 'EXECUTE'),
              has_function_privilege('authenticated', p.oid, 'EXECUTE')
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('sync_reaction_favourite', 'check_emoji_reaction_limit',
                            'check_message_emoji_reaction_limit')
        ORDER BY 1$q$,
    $q$VALUES ('check_emoji_reaction_limit'::text, true, true, false, false),
              ('check_message_emoji_reaction_limit'::text, true, true, false, false),
              ('sync_reaction_favourite'::text, true, true, false, false)$q$,
    'the trigger definers pin search_path and are not executable by clients');

SELECT ok((SELECT pg_get_triggerdef(t.oid) ~ 'WHEN \(\(NOT new\.implied_by_reaction\)\)'
             FROM pg_trigger t
            WHERE t.tgrelid = 'public.post_interactions'::regclass
              AND t.tgname = 'trigger_unified_notification_interactions'),
          'the interaction notification trigger skips implied favourites');

-- A reaction implies the favourite, as the viewer. -------------------------------------
SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a1');
SELECT public.add_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000001', NULL, '🎉');
SELECT tests.clear_authentication();

SELECT results_eq(
    $q$SELECT interaction_type, custom_emoji_content, implied FROM rows74
        WHERE post = '01' ORDER BY interaction_type$q$,
    $q$VALUES ('emoji_reaction'::text, '🎉'::text, false), ('favorite'::text, NULL::text, true)$q$,
    'the first reaction adds an implied favourite');
SELECT ok(pg_temp.favs('01') = 1
          AND (public.get_post_with_context('f7420000-0000-0000-0000-000000000001',
                 'f7410000-0000-0000-0000-0000000000a1')->'mainPost'->>'is_favorited') = 'true',
          'the reactor''s heart is filled and counted');
SELECT results_eq(
    $q$SELECT op, kind, emoji, implied FROM jobs74 ORDER BY kind$q$,
    $q$VALUES ('create'::text, 'emoji_reaction'::text, '🎉'::text, false),
              ('create'::text, 'favorite'::text, NULL::text, true)$q$,
    'the reaction and its implied favourite each queue a job; the favourite''s says implied');
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'f7410000-0000-0000-0000-0000000000a3'
              AND type = 'activitypub_favorite'), 0,
          'an implied favourite notifies no one');
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'f7410000-0000-0000-0000-0000000000a3'
              AND type = 'activitypub_reaction'), 1,
          'the reaction notifies the author');

SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a1');
SELECT public.add_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000001', NULL, '👀');
SELECT tests.clear_authentication();
SELECT ok((SELECT count(*) FROM rows74 WHERE post = '01' AND interaction_type = 'favorite') = 1
          AND pg_temp.favs('01') = 1,
          'a second reaction adds no second favourite');

TRUNCATE captured_jobs;
SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a1');
SELECT public.remove_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000001', NULL, '🎉');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT interaction_type, custom_emoji_content, implied FROM rows74
        WHERE post = '01' ORDER BY interaction_type$q$,
    $q$VALUES ('emoji_reaction'::text, '👀'::text, false), ('favorite'::text, NULL::text, true)$q$,
    'removing one of two reactions keeps the implied favourite');
SELECT results_eq(
    $q$SELECT op, kind, emoji FROM jobs74$q$,
    $q$VALUES ('delete'::text, 'emoji_reaction'::text, '🎉'::text)$q$,
    'only the reaction''s delete is queued');

TRUNCATE captured_jobs;
SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a1');
SELECT public.remove_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000001', NULL, '👀');
SELECT tests.clear_authentication();
SELECT ok(NOT EXISTS (SELECT 1 FROM rows74 WHERE post = '01') AND pg_temp.favs('01') = 0,
          'the last reaction takes the implied favourite with it');
SELECT results_eq(
    $q$SELECT op, kind, implied FROM jobs74 ORDER BY kind$q$,
    $q$VALUES ('delete'::text, 'emoji_reaction'::text, false), ('delete'::text, 'favorite'::text, true)$q$,
    'the reaction and the implied favourite each queue a delete');

-- A heart on an implied favourite makes it explicit.
SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a1');
SELECT public.add_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000001', NULL, '🎉');
SELECT is(public.add_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
            'f7420000-0000-0000-0000-000000000001', NULL, '❤️'),
          (SELECT id FROM public.post_interactions
            WHERE user_id = 'f7410000-0000-0000-0000-0000000000a1'
              AND post_id = 'f7420000-0000-0000-0000-000000000001'
              AND interaction_type = 'favorite'),
          'picking ❤ returns the implied favourite');
SELECT public.remove_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000001', NULL, '🎉');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT interaction_type, implied FROM rows74 WHERE post = '01'$q$,
    $q$VALUES ('favorite'::text, false)$q$,
    'the hearted favourite is explicit and outlives the last reaction');

-- An explicit favourite stays. ---------------------------------------------------------
SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a1');
INSERT INTO public.post_interactions (post_id, user_id, interaction_type, is_local)
VALUES ('f7420000-0000-0000-0000-000000000002', 'f7410000-0000-0000-0000-0000000000a1', 'favorite', true);
SELECT public.add_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000002', NULL, '🎉');
SELECT public.remove_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000002', NULL, '🎉');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT interaction_type, implied FROM rows74 WHERE post = '02'$q$,
    $q$VALUES ('favorite'::text, false)$q$,
    'a favourite clicked before the reaction outlives it');
SELECT is(pg_temp.favs('02'), 1, 'and counts once');

-- Unfavouriting takes the reactions. ----------------------------------------------------
SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a1');
SELECT public.add_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000003', NULL, e) FROM unnest(ARRAY['🎉', '👀', '🔥']) e;
SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a6');
SELECT public.add_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a6',
         'f7420000-0000-0000-0000-000000000003', NULL, e) FROM unnest(ARRAY['🎉', '👀', '🔥']) e;
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT (SELECT count(*)::int FROM rows74 WHERE post = '03' AND interaction_type = 'emoji_reaction'),
              (SELECT count(*)::int FROM rows74 WHERE post = '03' AND interaction_type = 'favorite'),
              pg_temp.favs('03')$q$,
    $q$VALUES (6, 2, 2)$q$,
    'two people with three reactions each are two favourites');

TRUNCATE captured_jobs;
SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a1');
DELETE FROM public.post_interactions
 WHERE post_id = 'f7420000-0000-0000-0000-000000000003'
   AND user_id = 'f7410000-0000-0000-0000-0000000000a1'
   AND interaction_type = 'favorite';
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT who, count(*)::int FROM rows74 WHERE post = '03' GROUP BY who ORDER BY who$q$,
    $q$VALUES ('a6'::text, 4)$q$,
    'unfavouriting removes the viewer''s reactions and leaves the friend''s');
SELECT ok(pg_temp.favs('03') = 1
          AND (SELECT count(*) FROM jobs74 WHERE op = 'delete' AND kind = 'emoji_reaction') = 3
          AND (SELECT count(*) FROM jobs74 WHERE op = 'delete' AND kind = 'favorite') = 1,
          'the favourite and each reaction queue a delete; the count drops by one');

TRUNCATE captured_jobs;
SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a6');
SELECT public.remove_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a6',
         'f7420000-0000-0000-0000-000000000003', NULL, '❤');
SELECT tests.clear_authentication();
SELECT ok(NOT EXISTS (SELECT 1 FROM rows74 WHERE post = '03') AND pg_temp.favs('03') = 0,
          'removing the ❤ unfavourites, reactions included');

-- Per-person limit on a post. -----------------------------------------------------------
SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a1');
SELECT public.add_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000004', NULL, e)
  FROM unnest(ARRAY['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊']) e;
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM rows74 WHERE post = '04' AND interaction_type = 'emoji_reaction'), 10,
          'ten reactions fit');

SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a1');
SELECT throws_ok(
    $q$SELECT public.add_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000004', NULL, '😋')$q$,
    '23514', 'REACTION_LIMIT: 10 reactions per person on a post',
    'an eleventh different emoji is refused');
SELECT lives_ok(
    $q$SELECT public.add_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000004', NULL, '😀')$q$,
    'repeating a held emoji at the limit is not an error');
SELECT lives_ok(
    $q$SELECT public.add_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000004', NULL, '❤')$q$,
    'the heart is the favourite and not counted');
SELECT throws_ok(
    $q$SELECT public.batch_set_instance_config(ARRAY['max_post_reactions_per_user'], ARRAY['12'::jsonb])$q$,
    '42501', 'Unauthorized: Admin role required',
    'a member cannot change the limit');

SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a2');
SELECT public.batch_set_instance_config(ARRAY['max_post_reactions_per_user'], ARRAY['12'::jsonb]);
SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a1');
SELECT lives_ok(
    $q$SELECT public.add_post_emoji_reaction('f7410000-0000-0000-0000-0000000000a1',
         'f7420000-0000-0000-0000-000000000004', NULL, '😋')$q$,
    'the admin raised the limit and the eleventh fits');
SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a2');
SELECT public.batch_set_instance_config(ARRAY['max_post_reactions_per_user'], ARRAY['"3"'::jsonb]);
SELECT tests.clear_authentication();

-- Inbound, as the federation backend writes it.
SET LOCAL ROLE service_role;
INSERT INTO public.post_interactions (user_id, post_id, interaction_type, custom_emoji_content, is_local)
SELECT 'f7410000-0000-0000-0000-0000000000a4', 'f7420000-0000-0000-0000-000000000005', 'emoji_reaction', e, false
  FROM unnest(ARRAY['🎉', '👀', '🔥', '🚀']) e;
RESET ROLE;
SELECT results_eq(
    $q$SELECT (SELECT count(*)::int FROM rows74 WHERE post = '05' AND interaction_type = 'emoji_reaction'),
              (SELECT count(*)::int FROM rows74 WHERE post = '05' AND interaction_type = 'favorite' AND implied)$q$,
    $q$VALUES (3, 1)$q$,
    'an inbound reaction over the limit (a string "3") is dropped without error; the reactor holds an implied favourite');
SELECT is(pg_temp.favs('05'), 6, 'the remote reactor adds one to the origin''s count');

-- Message reactions: 20 different emoji, any number per person. --------------------------
INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
SELECT 'f7450000-0000-0000-0000-000000000001', 'f7410000-0000-0000-0000-0000000000a1', chr(128512 + n)
  FROM generate_series(0, 19) n;
SELECT is((SELECT count(*)::int FROM public.reactions WHERE message_id = 'f7450000-0000-0000-0000-000000000001'), 20,
          'one person can hold twenty different emoji on a message');

SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a6');
SELECT lives_ok(
    $q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
       VALUES ('f7450000-0000-0000-0000-000000000001', 'f7410000-0000-0000-0000-0000000000a6', chr(128512))$q$,
    'at twenty, adding to an existing emoji works');
SELECT throws_ok(
    $q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
       VALUES ('f7450000-0000-0000-0000-000000000001', 'f7410000-0000-0000-0000-0000000000a6', '🚀')$q$,
    '23514', 'REACTION_LIMIT: 20 different emoji per message',
    'a twenty-first emoji is refused for a client');
SELECT tests.clear_authentication();

-- Service writers (bot-gateway, federation-backend) meet the same trigger.
SELECT throws_ok(
    $q$INSERT INTO public.reactions (message_id, bot_id, custom_emoji_content)
       VALUES ('f7450000-0000-0000-0000-000000000001', gen_random_uuid(), '🚀')$q$,
    '23514', 'REACTION_LIMIT: 20 different emoji per message',
    'and for a bot');
SELECT lives_ok(
    $q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content, metadata)
       VALUES ('f7450000-0000-0000-0000-000000000001', 'f7410000-0000-0000-0000-0000000000a4', '🚀',
               '{"federated": true}'::jsonb)$q$,
    'a federated twenty-first emoji raises nothing');
SELECT is((SELECT count(*)::int FROM public.reactions
            WHERE message_id = 'f7450000-0000-0000-0000-000000000001' AND custom_emoji_content = '🚀'), 0,
          'and is dropped');

-- Instance config writers. -------------------------------------------------------------
-- record_instance_software. -------------------------------------------------------------
SELECT throws_ok(
    $q$SELECT public.record_instance_software('mk74.test', 'misskey', NULL, 'document')$q$,
    '42501', NULL, 'a client cannot record instance software')
  FROM (SELECT tests.authenticate_as('f7400000-0000-0000-0000-0000000000a2')) a;
SELECT tests.clear_authentication();

INSERT INTO public.federated_instances (domain, software, metadata)
VALUES ('admin74.test', 'pleroma', '{}'), ('stale74.test', 'unknown', '{}');
SELECT results_eq(
    $q$SELECT public.record_instance_software('new74.test', 'Sharkey', NULL, 'document'),
              public.record_instance_software('admin74.test', 'misskey', NULL, 'document'),
              public.record_instance_software('admin74.test', 'misskey', '2025.1', 'nodeinfo'),
              public.record_instance_software('stale74.test', 'mastodon', NULL, 'document')$q$,
    $q$VALUES ('sharkey'::text, 'pleroma'::text, 'pleroma'::text, 'mastodon'::text)$q$,
    'a document fills an unknown or missing instance; an admin-set value stands against both sources');
SELECT results_eq(
    $q$SELECT public.record_instance_software('new74.test', 'misskey', '2025.4.0', 'nodeinfo'),
              public.record_instance_software('new74.test', 'firefish', NULL, 'document'),
              public.record_instance_software('new74.test', NULL, NULL, 'nodeinfo')$q$,
    $q$VALUES ('misskey'::text, 'misskey'::text, 'misskey'::text)$q$,
    'NodeInfo replaces a document''s answer, a document never replaces NodeInfo''s, a failed NodeInfo keeps it');
SELECT results_eq(
    $q$SELECT software, version, metadata->>'software_source', metadata ? 'software_checked_at'
         FROM public.federated_instances WHERE domain IN ('new74.test', 'admin74.test', 'stale74.test')
        ORDER BY domain$q$,
    $q$VALUES ('pleroma'::text, NULL::text, NULL::text, false),
              ('misskey'::text, '2025.4.0'::text, 'nodeinfo'::text, true),
              ('mastodon'::text, NULL::text, 'document'::text, false)$q$,
    'the stored row names its source; software_checked_at stamps NodeInfo attempts alone');

-- Existing rows, converged by the migration's own block. ---------------------------------
-- The pre-migration state: reactions with no favourite, written with the new trigger off.
-- 06 (local, stale count 1): viewer 🎉 👀; friend 🎉 with an explicit favourite; misskey 🔥.
-- 07 (remote, origin count 9): viewer 🎉; akkoma 👀 🎉.
ALTER TABLE public.post_interactions DISABLE TRIGGER trg_reaction_implies_favourite;
INSERT INTO public.post_interactions (user_id, post_id, interaction_type, custom_emoji_content, is_local, created_at)
VALUES
  ('f7410000-0000-0000-0000-0000000000a1', 'f7420000-0000-0000-0000-000000000006', 'emoji_reaction', '👀', true, '2026-09-01 10:05+00'),
  ('f7410000-0000-0000-0000-0000000000a1', 'f7420000-0000-0000-0000-000000000006', 'emoji_reaction', '🎉', true, '2026-09-01 10:01+00'),
  ('f7410000-0000-0000-0000-0000000000a6', 'f7420000-0000-0000-0000-000000000006', 'emoji_reaction', '🎉', true, '2026-09-01 10:02+00'),
  ('f7410000-0000-0000-0000-0000000000a4', 'f7420000-0000-0000-0000-000000000006', 'emoji_reaction', '🔥', false, '2026-09-01 10:03+00'),
  ('f7410000-0000-0000-0000-0000000000a1', 'f7420000-0000-0000-0000-000000000007', 'emoji_reaction', '🎉', true, '2026-09-01 10:04+00'),
  ('f7410000-0000-0000-0000-0000000000a5', 'f7420000-0000-0000-0000-000000000007', 'emoji_reaction', '👀', false, '2026-09-01 10:06+00'),
  ('f7410000-0000-0000-0000-0000000000a5', 'f7420000-0000-0000-0000-000000000007', 'emoji_reaction', '🎉', false, '2026-09-01 10:07+00');
INSERT INTO public.post_interactions (user_id, post_id, interaction_type, is_local)
VALUES ('f7410000-0000-0000-0000-0000000000a6', 'f7420000-0000-0000-0000-000000000006', 'favorite', true);
UPDATE public.posts SET favorites_count = 1 WHERE id = 'f7420000-0000-0000-0000-000000000006';
UPDATE public.posts SET favorites_count = 9 WHERE id = 'f7420000-0000-0000-0000-000000000007';
ALTER TABLE public.post_interactions ENABLE TRIGGER trg_reaction_implies_favourite;
-- A trigger left disabled stays disabled.
ALTER TABLE public.post_interactions DISABLE TRIGGER trg_broadcast_post_interaction;

CREATE TEMP TABLE triggers_before AS
SELECT tgname::text, tgenabled::text FROM pg_trigger
 WHERE tgrelid = 'public.post_interactions'::regclass AND NOT tgisinternal;
TRUNCATE captured_jobs;
CREATE TEMP TABLE notifications_before AS SELECT count(*) AS n FROM public.notifications;

-- The block is read from the migration file at /db_schema/migrations, where
-- scripts/run-db-tests.sh copies db_schema. Absent, the line below prints an ERROR the
-- runner reports.
\! sed -n '/^-- Existing rows$/,/^\$\$;$/p' /db_schema/migrations/20261007200001_reactions_favourites_limits.sql > /tmp/backfill74.sql
\! test -s /tmp/backfill74.sql || echo 'ERROR: /db_schema/migrations/20261007200001_reactions_favourites_limits.sql is not in the container; copy db_schema to /db_schema'
\i /tmp/backfill74.sql

SELECT results_eq(
    $q$SELECT post, who, implied FROM rows74
        WHERE post IN ('06', '07') AND interaction_type = 'favorite' ORDER BY post, who$q$,
    $q$VALUES ('06'::text, 'a1'::text, true), ('06', 'a4', true), ('06', 'a6', false),
              ('07', 'a1', true), ('07', 'a5', true)$q$,
    'every reactor without a favourite gets one implied favourite; an explicit one is kept');
SELECT results_eq(
    $q$SELECT pi.federation_status, pi.created_at, pi.is_local FROM public.post_interactions pi
        WHERE pi.post_id = 'f7420000-0000-0000-0000-000000000006'
          AND pi.user_id IN ('f7410000-0000-0000-0000-0000000000a1', 'f7410000-0000-0000-0000-0000000000a4')
          AND pi.interaction_type = 'favorite'
        ORDER BY pi.user_id$q$,
    $q$VALUES ('skipped'::text, '2026-09-01 10:01+00'::timestamptz, true),
              ('skipped'::text, '2026-09-01 10:03+00'::timestamptz, false)$q$,
    'a backfilled favourite is marked skipped, dated from the first reaction, local as its reactor');
SELECT results_eq(
    $q$SELECT pg_temp.favs('06'), pg_temp.favs('07')$q$,
    $q$VALUES (3, 11)$q$,
    'the local post recounts its favourites; the remote post adds the two inserted');
SELECT ok((SELECT count(*) FROM captured_jobs) = 0
          AND (SELECT count(*) FROM public.notifications) = (SELECT n FROM notifications_before),
          'the backfill queues no federation job and sends no notification');
SELECT results_eq(
    $q$SELECT tgname::text, tgenabled::text FROM pg_trigger
        WHERE tgrelid = 'public.post_interactions'::regclass AND NOT tgisinternal ORDER BY 1$q$,
    $q$SELECT tgname, tgenabled FROM triggers_before ORDER BY 1$q$,
    'every trigger is back in its prior state, a disabled one included');

\i /tmp/backfill74.sql
SELECT results_eq(
    $q$SELECT (SELECT count(*)::int FROM rows74 WHERE post IN ('06', '07') AND interaction_type = 'favorite'),
              pg_temp.favs('06'), pg_temp.favs('07')$q$,
    $q$VALUES (5, 3, 11)$q$,
    'a second run changes nothing');

SELECT * FROM finish();
ROLLBACK;
