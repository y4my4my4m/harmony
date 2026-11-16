-- Group conversations hold at most 10 active participants after 20261116100001.
--
--   u01..u12   local accounts c296, a month old and members of the fixture server: no new-account
--              or stranger limit applies
--   g          group made by u01 through create_group_conversation
--   big        group of 12 that predates the limit
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(15);
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT format('c2960000-0000-0000-0000-0000000000%s', lpad(n::text, 2, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', format('u%s@c296.test', n)
  FROM generate_series(1, 12) n;
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, created_at)
SELECT format('c2961000-0000-0000-0000-0000000000%s', lpad(n::text, 2, '0'))::uuid,
       format('c2960000-0000-0000-0000-0000000000%s', lpad(n::text, 2, '0'))::uuid,
       format('c296u%s', n), format('U%s', n), true, now() - interval '30 days'
  FROM generate_series(1, 12) n;
INSERT INTO public.user_servers (user_id, server_id, status)
SELECT format('c2961000-0000-0000-0000-0000000000%s', lpad(n::text, 2, '0'))::uuid,
       '55555555-0000-0000-0000-000000000005', 'accepted'
  FROM generate_series(1, 12) n;

CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT format('c2961000-0000-0000-0000-0000000000%s', lpad(n::text, 2, '0'))::uuid
$$;
CREATE FUNCTION pg_temp.auth(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT format('c2960000-0000-0000-0000-0000000000%s', lpad(n::text, 2, '0'))::uuid
$$;
CREATE FUNCTION pg_temp.active(p_conversation uuid) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.conversation_participants WHERE conversation_id = p_conversation AND left_at IS NULL
$$;

-- Creating ------------------------------------------------------------------------------------------
SELECT tests.authenticate_as(pg_temp.auth(1));
SELECT throws_ok(format($q$SELECT public.create_group_conversation(%L, %L::uuid[], 'eleven', true)$q$,
                        pg_temp.u(1), ARRAY(SELECT pg_temp.u(n) FROM generate_series(2, 11) n)),
                 'P0001'::char(5), 'GROUP_CONVERSATION_FULL:10', 'a new group of 11 is refused');
SELECT lives_ok(format($q$SELECT public.create_group_conversation(%L, %L::uuid[], 'ten', true)$q$,
                       pg_temp.u(1), ARRAY(SELECT pg_temp.u(n) FROM generate_series(2, 10) n)),
                'a new group of 10 is made');
RESET ROLE;
SELECT tests.clear_authentication();
CREATE TEMP TABLE g AS
  SELECT c.id FROM public.conversations c WHERE c.type = 'group' AND c.name = 'ten' AND c.created_by = pg_temp.u(1);
GRANT SELECT ON g TO PUBLIC;
SELECT is(pg_temp.active((SELECT id FROM g)), 10, 'it holds 10');
SELECT is((SELECT count(*)::int FROM public.conversations WHERE name = 'eleven'), 0, 'and the refused one left nothing');

-- Adding --------------------------------------------------------------------------------------------
SELECT tests.authenticate_as(pg_temp.auth(1));
SELECT throws_ok(format($q$SELECT public.add_user_to_conversation(%L, %L)$q$, (SELECT id FROM g), pg_temp.u(11)),
                 'P0001'::char(5), 'GROUP_CONVERSATION_FULL:10', 'an 11th member is refused');
SELECT lives_ok(format($q$SELECT public.add_user_to_conversation(%L, %L)$q$, (SELECT id FROM g), pg_temp.u(5)),
                'adding a member again changes nothing and passes');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT is(pg_temp.active((SELECT id FROM g)), 10, 'still 10');

-- Leaving and coming back ---------------------------------------------------------------------------
UPDATE public.conversation_participants SET left_at = now()
 WHERE conversation_id = (SELECT id FROM g) AND user_id = pg_temp.u(10);
SELECT lives_ok(format($q$INSERT INTO public.conversation_participants (conversation_id, user_id, role)
                          VALUES (%L, %L, 'member')$q$, (SELECT id FROM g), pg_temp.u(11)),
                'a place freed is taken');
SELECT throws_ok(format($q$INSERT INTO public.conversation_participants (conversation_id, user_id, role)
                           VALUES (%L, %L, 'member')
                           ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL$q$,
                        (SELECT id FROM g), pg_temp.u(10)),
                 'P0001'::char(5), 'GROUP_CONVERSATION_FULL:10', 'then the one who left cannot rejoin through the RPC shape');
SELECT throws_ok(format($q$UPDATE public.conversation_participants SET left_at = NULL
                           WHERE conversation_id = %L AND user_id = %L$q$, (SELECT id FROM g), pg_temp.u(10)),
                 'P0001'::char(5), 'GROUP_CONVERSATION_FULL:10', 'nor by clearing left_at');
SELECT lives_ok(format($q$UPDATE public.conversation_participants SET left_at = now()
                          WHERE conversation_id = %L AND user_id = %L$q$, (SELECT id FROM g), pg_temp.u(2)),
                'anyone can leave a full group');

-- A group that predates the limit -------------------------------------------------------------------
INSERT INTO public.conversations (id, type, name, created_by)
VALUES ('c2962000-0000-0000-0000-000000000001', 'group', 'big', pg_temp.u(1));
ALTER TABLE public.conversation_participants DISABLE TRIGGER b_group_conversation_limit;
INSERT INTO public.conversation_participants (conversation_id, user_id, role)
SELECT 'c2962000-0000-0000-0000-000000000001', pg_temp.u(n), 'member' FROM generate_series(1, 11) n;
ALTER TABLE public.conversation_participants ENABLE TRIGGER b_group_conversation_limit;
SELECT lives_ok($q$INSERT INTO public.conversation_participants (conversation_id, user_id, role)
                   VALUES ('c2962000-0000-0000-0000-000000000001', pg_temp.u(3), 'member')
                   ON CONFLICT (conversation_id, user_id) DO NOTHING$q$,
                'a group of 11 from before keeps its members');
SELECT throws_ok($q$INSERT INTO public.conversation_participants (conversation_id, user_id, role)
                    VALUES ('c2962000-0000-0000-0000-000000000001', pg_temp.u(12), 'member')$q$,
                 'P0001'::char(5), 'GROUP_CONVERSATION_FULL:10', 'and admits nobody new');

-- Federated and direct conversations ----------------------------------------------------------------
SET LOCAL role service_role;
SELECT throws_ok(format($q$SELECT public.get_or_create_federated_group_conversation(%L, %L::uuid[], 'remote-c296')$q$,
                        pg_temp.u(12), ARRAY(SELECT pg_temp.u(n) FROM generate_series(1, 10) n)),
                 'P0001'::char(5), 'GROUP_CONVERSATION_FULL:10', 'a federated group of 11 is refused');
RESET ROLE;
INSERT INTO public.conversations (id, type, created_by)
VALUES ('c2962000-0000-0000-0000-000000000002', 'direct', pg_temp.u(1));
SELECT lives_ok($q$INSERT INTO public.conversation_participants (conversation_id, user_id, role)
                   SELECT 'c2962000-0000-0000-0000-000000000002', pg_temp.u(n), 'member' FROM generate_series(1, 12) n$q$,
                'a direct conversation is not counted here');

SELECT * FROM finish();
ROLLBACK;
