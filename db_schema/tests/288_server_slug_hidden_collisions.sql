-- 20261114300001_server_slug_hidden_collisions.sql: a new server's slug skips the slugs of private
-- servers its creator cannot read; clients cannot ask which slugs are taken.
--
-- Fixture: mallory is a member of nothing. Added here, owned by bob:
--   private288      private server named "Harmony", slug harmony
--   private288b     private server named "Harmony 1", slug harmony-1

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(8);

INSERT INTO public.servers (id, name, public, owner)
VALUES ('f2880000-0000-0000-0000-0000000000a1', 'Harmony', false, '22222222-0000-0000-0000-000000000002'),
       ('f2880000-0000-0000-0000-0000000000a2', 'Harmony 1', false, '22222222-0000-0000-0000-000000000002');

SELECT results_eq(
    $q$SELECT slug FROM public.servers WHERE id IN ('f2880000-0000-0000-0000-0000000000a1', 'f2880000-0000-0000-0000-0000000000a2') ORDER BY slug$q$,
    $q$VALUES ('harmony'::text), ('harmony-1'::text)$q$,
    'the private servers hold harmony and harmony-1');

SET LOCAL role authenticated;
SET LOCAL request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000003","role":"authenticated"}';
SET LOCAL request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';

SELECT is((SELECT count(*) FROM public.servers WHERE slug LIKE 'harmony%'), 0::bigint,
    'mallory cannot read them');

SELECT lives_ok(
    $q$INSERT INTO public.servers (id, name, public, owner)
       VALUES ('f2880000-0000-0000-0000-0000000000b1', 'めじたぐharmony支部', true, '33333333-0000-0000-0000-000000000003')$q$,
    'mallory creates a server whose name slugs to a private server''s slug');
SELECT is((SELECT slug FROM public.servers WHERE id = 'f2880000-0000-0000-0000-0000000000b1'), 'harmony-2',
    'and it takes the next slug no server holds');

SELECT lives_ok(
    $q$INSERT INTO public.servers (id, name, public, owner)
       VALUES ('f2880000-0000-0000-0000-0000000000b2', 'めじたぐ支部', true, '33333333-0000-0000-0000-000000000003')$q$,
    'a name with no Latin letters is created');
SELECT is((SELECT slug FROM public.servers WHERE id = 'f2880000-0000-0000-0000-0000000000b2'), 'f2880000',
    'its slug is its id''s first eight characters');

RESET role;

SELECT ok(NOT has_function_privilege('authenticated', 'public.generate_unique_server_slug(text, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.generate_unique_server_slug(text, uuid)', 'EXECUTE'),
    'clients cannot ask which slugs are taken');
SELECT ok((SELECT bool_and(prosecdef) FROM pg_proc
            WHERE oid IN ('public.generate_unique_server_slug(text, uuid)'::regprocedure, 'public.assign_server_slug()'::regprocedure)),
    'the slug is chosen as definer');

SELECT * FROM finish();
ROLLBACK;
