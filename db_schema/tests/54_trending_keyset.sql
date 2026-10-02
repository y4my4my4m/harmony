-- get_trending_posts keyset paging (20261005300001_trending_keyset.sql).
--
-- Posts by one local author at T-1h, as_of T = 2026-09-01 12:00 UTC, ranked by
-- favourites: 01 60, 02 50, 03 40, 04 30, 05 20, 06 10. 07 and 08 tie with 5 each at the
-- same instant and rank by id, 08 first.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(11);

INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES ('f5400000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'trend54-viewer@test.local');

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
VALUES
  ('f5410000-0000-0000-0000-0000000000a1', 'f5400000-0000-0000-0000-0000000000a1', 't54viewer', 't54viewer', true, 'localhost'),
  ('f5410000-0000-0000-0000-0000000000a2', NULL, 't54author', 't54author', true, 'localhost');

INSERT INTO public.posts (id, author_id, created_at, content, visibility, is_local, favorites_count)
SELECT ('f5420000-0000-0000-0000-0000000000' || n)::uuid,
       'f5410000-0000-0000-0000-0000000000a2',
       '2026-09-01 11:00+00', jsonb_build_array(jsonb_build_object('type', 'text', 'text', n)),
       'public', true, favs
  FROM (VALUES ('01', 60), ('02', 50), ('03', 40), ('04', 30), ('05', 20), ('06', 10),
               ('07', 5), ('08', 5)) v(n, favs);

-- Catalog -------------------------------------------------------------------------------
SELECT ok(to_regprocedure('public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz)') IS NULL,
          'the seven-parameter function is gone');
SELECT ok(NOT (SELECT prosecdef FROM pg_proc
                WHERE oid = 'public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz, double precision, timestamptz, uuid)'::regprocedure),
          'it runs SECURITY INVOKER');
SELECT ok(has_function_privilege('anon', 'public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz, double precision, timestamptz, uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz, double precision, timestamptz, uuid)', 'EXECUTE')
          AND NOT EXISTS (
            SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc
                                       WHERE oid = 'public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz, double precision, timestamptz, uuid)'::regprocedure)) a
             WHERE a.grantee = 0),
          'anon and authenticated may call it; PUBLIC holds no grant');

SELECT tests.authenticate_as('f5400000-0000-0000-0000-0000000000a1');

CREATE TEMP TABLE p1 AS
SELECT id, created_at, score FROM public.get_trending_posts(24, false, false, NULL, 2, 0, '2026-09-01 12:00+00');
CREATE TEMP TABLE c1 AS
SELECT score, created_at, id FROM p1 ORDER BY score, created_at, id LIMIT 1;

-- Paging --------------------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT id FROM p1$q$,
    $q$VALUES ('f5420000-0000-0000-0000-000000000001'::uuid), ('f5420000-0000-0000-0000-000000000002'::uuid)$q$,
    'the first page holds the two best');

SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, false, false, NULL, 2, 0, '2026-09-01 12:00+00',
                                                (SELECT score FROM c1), (SELECT created_at FROM c1), (SELECT id FROM c1))$q$,
    $q$VALUES ('f5420000-0000-0000-0000-000000000003'::uuid), ('f5420000-0000-0000-0000-000000000004'::uuid)$q$,
    'a cursor continues after the last row of the previous page');

SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(p_limit => 2, p_as_of => '2026-09-01 12:00+00',
                                                p_after_score => (SELECT score FROM c1),
                                                p_after_created_at => (SELECT created_at FROM c1),
                                                p_after_id => (SELECT id FROM c1), p_offset => 1)$q$,
    $q$VALUES ('f5420000-0000-0000-0000-000000000004'::uuid), ('f5420000-0000-0000-0000-000000000005'::uuid)$q$,
    'an offset applies after the cursor');

SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, false, false, NULL, 2, 0, '2026-09-01 12:00+00',
                                                (SELECT score FROM c1), NULL, (SELECT id FROM c1))$q$,
    $q$VALUES ('f5420000-0000-0000-0000-000000000001'::uuid), ('f5420000-0000-0000-0000-000000000002'::uuid)$q$,
    'a partial cursor is ignored');

-- A row above the cursor leaves the ranking between pages.
SELECT tests.clear_authentication();
UPDATE public.posts SET is_deleted = true WHERE id = 'f5420000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('f5400000-0000-0000-0000-0000000000a1');

SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, false, false, NULL, 2, 2, '2026-09-01 12:00+00')$q$,
    $q$VALUES ('f5420000-0000-0000-0000-000000000004'::uuid), ('f5420000-0000-0000-0000-000000000005'::uuid)$q$,
    'offset paging now starts one row late and skips 03');

SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, false, false, NULL, 2, 0, '2026-09-01 12:00+00',
                                                (SELECT score FROM c1), (SELECT created_at FROM c1), (SELECT id FROM c1))$q$,
    $q$VALUES ('f5420000-0000-0000-0000-000000000003'::uuid), ('f5420000-0000-0000-0000-000000000004'::uuid)$q$,
    'keyset paging still continues at 03');

-- Ties ------------------------------------------------------------------------------------
CREATE TEMP TABLE tie AS
SELECT score, created_at, id FROM public.get_trending_posts(24, false, false, NULL, 40, 0, '2026-09-01 12:00+00')
 WHERE id = 'f5420000-0000-0000-0000-000000000008';

SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, false, false, NULL, 40, 0, '2026-09-01 12:00+00')
        WHERE id IN ('f5420000-0000-0000-0000-000000000007', 'f5420000-0000-0000-0000-000000000008')$q$,
    $q$VALUES ('f5420000-0000-0000-0000-000000000008'::uuid), ('f5420000-0000-0000-0000-000000000007'::uuid)$q$,
    'equal score and age rank by id, highest first');

SELECT results_eq(
    $q$SELECT id FROM public.get_trending_posts(24, false, false, NULL, 40, 0, '2026-09-01 12:00+00',
                                                (SELECT score FROM tie), (SELECT created_at FROM tie), (SELECT id FROM tie))$q$,
    $q$VALUES ('f5420000-0000-0000-0000-000000000007'::uuid)$q$,
    'a cursor on the first of two tied rows returns the second');

SELECT * FROM finish();
ROLLBACK;
