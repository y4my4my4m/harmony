-- get_owned_bot_servers: the servers an owner's bots are installed in, by name,
-- including servers the owner cannot read through servers RLS.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(7);

CREATE OR REPLACE FUNCTION pg_temp.granted_execute(p_name text, p_role text)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    WHERE n.nspname = 'public' AND p.proname = p_name
      AND a.grantee = p_role::regrole
      AND a.privilege_type = 'EXECUTE'
  );
$fn$;

SELECT is(
    (SELECT pg_get_function_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_owned_bot_servers'),
    ' -> TABLE(bot_id uuid, server_id uuid, server_name text)',
    'get_owned_bot_servers returns one row per installation');

SELECT ok(pg_temp.granted_execute('get_owned_bot_servers', 'authenticated')
          AND NOT pg_temp.granted_execute('get_owned_bot_servers', 'anon'),
          'get_owned_bot_servers is executable by authenticated and not by anon');

-- Mallory owns a bot installed in Alice's Test Server and in a private server
-- of Bob's, neither of which she is a member of; a third install is inactive.
INSERT INTO public.servers (id, name, owner)
VALUES ('5555aaaa-0000-0000-0000-0000000000b1', 'Bob Private', '22222222-0000-0000-0000-000000000002'),
       ('5555aaaa-0000-0000-0000-0000000000b2', 'Removed From', '22222222-0000-0000-0000-000000000002');

INSERT INTO public.bots (id, owner_id, username, display_name, bot_type, is_public)
VALUES ('b0b0b0b0-0000-0000-0000-0000000000b1', '33333333-0000-0000-0000-000000000003',
        'mallory-bridge', 'Mallory Bridge', 'bridge', false),
       ('b0b0b0b0-0000-0000-0000-0000000000b2', '33333333-0000-0000-0000-000000000003',
        'mallory-idle', 'Mallory Idle', 'bot', false);

INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by, is_active)
VALUES ('b0b0b0b0-0000-0000-0000-0000000000b1', '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', true),
       ('b0b0b0b0-0000-0000-0000-0000000000b1', '5555aaaa-0000-0000-0000-0000000000b1', '22222222-0000-0000-0000-000000000002', true),
       ('b0b0b0b0-0000-0000-0000-0000000000b1', '5555aaaa-0000-0000-0000-0000000000b2', '22222222-0000-0000-0000-000000000002', false);

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');

SELECT is_empty(
    $q$SELECT 1 FROM public.servers WHERE id = '5555aaaa-0000-0000-0000-0000000000b1'$q$,
    'the owner cannot read the private server through servers RLS');

SELECT results_eq(
    $q$SELECT server_name FROM public.get_owned_bot_servers()
        WHERE bot_id = 'b0b0b0b0-0000-0000-0000-0000000000b1'$q$,
    $q$VALUES ('Bob Private'::text), ('Test Server'::text)$q$,
    'active installations are named, private servers included, ordered by name');

SELECT is_empty(
    $q$SELECT 1 FROM public.get_owned_bot_servers()
        WHERE bot_id = 'b0b0b0b0-0000-0000-0000-0000000000b2'
           OR server_id = '5555aaaa-0000-0000-0000-0000000000b2'$q$,
    'uninstalled bots and inactive installations have no rows');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');

SELECT is_empty(
    $q$SELECT 1 FROM public.get_owned_bot_servers()
        WHERE bot_id = 'b0b0b0b0-0000-0000-0000-0000000000b1'$q$,
    'another user''s bots are not listed, even in their own servers');

SELECT tests.clear_authentication();

SELECT throws_ok(
    $q$SET LOCAL ROLE anon; SELECT * FROM public.get_owned_bot_servers()$q$,
    '42501', NULL,
    'anon cannot call it');

SELECT * FROM finish();
ROLLBACK;
