-- create_bot, rotate_bot_token and get_owned_bot_server_counts.
--
-- UserBotsManagement.vue sends the argument names asserted below and reads
-- `bot`, `token`, `token_hint` and `token_created_at` off the returned object.
-- The gateway authenticates by SHA-256 of the presented token, so a token this
-- schema issues must verify through verify_bot_token unchanged.
--
-- Plaintext tokens are carried between statements in transaction-local GUCs:
-- the caller switches roles, and a GUC is readable under every one of them.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(27);

CREATE OR REPLACE FUNCTION pg_temp.sig(p_name text) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT pg_get_function_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = p_name;
$fn$;

-- Named grantee in proacl; see 32_rpc_contracts.sql for why not has_function_privilege.
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

CREATE OR REPLACE FUNCTION pg_temp.sha256_hex(p_token text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
$fn$;

-- Contracts ---------------------------------------------------------------------

SELECT is(pg_temp.sig('create_bot'),
          'p_username text, p_display_name text DEFAULT NULL::text, p_bio text DEFAULT NULL::text, '
          || 'p_bot_type text DEFAULT ''bot''::text, p_is_public boolean DEFAULT true -> jsonb',
          'create_bot takes the keys the client sends and returns jsonb');
SELECT is(pg_temp.sig('rotate_bot_token'), 'p_bot_id uuid -> jsonb',
          'rotate_bot_token takes p_bot_id and returns jsonb');
SELECT is(pg_temp.sig('get_owned_bot_server_counts'),
          ' -> TABLE(bot_id uuid, server_count integer)',
          'get_owned_bot_server_counts returns one row per owned bot');

SELECT ok(pg_temp.granted_execute('create_bot', 'authenticated')
          AND NOT pg_temp.granted_execute('create_bot', 'anon'),
          'create_bot is executable by authenticated and not by anon');
SELECT ok(pg_temp.granted_execute('rotate_bot_token', 'authenticated')
          AND NOT pg_temp.granted_execute('rotate_bot_token', 'anon'),
          'rotate_bot_token is executable by authenticated and not by anon');
SELECT ok(pg_temp.granted_execute('get_owned_bot_server_counts', 'authenticated')
          AND NOT pg_temp.granted_execute('get_owned_bot_server_counts', 'anon'),
          'get_owned_bot_server_counts is executable by authenticated and not by anon');
-- issue_bot_token takes any bot id and trusts it. Callable directly, it mints a
-- live token for a bot the caller does not own.
SELECT ok(NOT pg_temp.granted_execute('issue_bot_token', 'authenticated')
          AND NOT pg_temp.granted_execute('issue_bot_token', 'anon')
          AND NOT has_function_privilege('authenticated', 'public.issue_bot_token(uuid, text)', 'EXECUTE'),
          'issue_bot_token is not executable by client roles');

-- Creation ----------------------------------------------------------------------

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT lives_ok(
    $q$SELECT set_config('tests.create_result',
                         public.create_bot('devportal-bot', '  Dev Portal  ', 'Test bot', 'bot', false)::text,
                         true)$q$,
    'an authenticated caller creates a bot');

SELECT matches(current_setting('tests.create_result')::jsonb->>'token',
               '^harmony_bot_[0-9a-f]{64}$',
               'the issued token has the harmony_bot_ prefix and 64 hex characters');

SELECT is(current_setting('tests.create_result')::jsonb->>'token_hint',
          right(current_setting('tests.create_result')::jsonb->>'token', 4),
          'token_hint is the last four characters of the token');

SELECT tests.clear_authentication();

SELECT set_config('tests.bot_id', current_setting('tests.create_result')::jsonb->'bot'->>'id', true);
SELECT set_config('tests.token_1', current_setting('tests.create_result')::jsonb->>'token', true);

SELECT results_eq(
    $q$SELECT owner_id, username, display_name, bio, bot_type, is_public
         FROM public.bots WHERE id = current_setting('tests.bot_id')::uuid$q$,
    $q$VALUES ('11111111-0000-0000-0000-000000000001'::uuid, 'devportal-bot'::text,
               'Dev Portal'::text, 'Test bot'::text, 'bot'::text, false)$q$,
    'the bot row belongs to the caller and carries the submitted fields');

SELECT results_eq(
    $q$SELECT token_hash, token_prefix, is_active, scopes
         FROM public.bot_tokens WHERE bot_id = current_setting('tests.bot_id')::uuid$q$,
    $q$VALUES (pg_temp.sha256_hex(current_setting('tests.token_1')),
               right(current_setting('tests.token_1'), 4), true, ARRAY['bot'])$q$,
    'exactly one active token is stored, as the SHA-256 hex digest the gateway computes');

SELECT is(public.verify_bot_token(pg_temp.sha256_hex(current_setting('tests.token_1')))->>'bot_id',
          current_setting('tests.bot_id'),
          'the issued token verifies to the new bot');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT is(public.create_bot('devportal-bare')->'bot'->>'display_name', 'devportal-bare',
          'display_name falls back to the username');

SELECT throws_ok(
    $q$SELECT public.create_bot('devportal-integration', NULL, NULL, 'integration', true)$q$,
    '22023', NULL,
    'the integration type is refused');

-- valid_username CHECK. Raised inside the function, so no bot row survives.
SELECT throws_ok(
    $q$SELECT public.create_bot('Bad Name!')$q$,
    '23514', NULL,
    'an invalid username is refused by the table constraint');

SELECT tests.clear_authentication();

SELECT is((SELECT count(*) FROM public.bots WHERE username IN ('Bad Name!', 'devportal-integration')),
          0::bigint,
          'a refused creation leaves no bot row');

SELECT tests.authenticate_as_anon();

SELECT throws_ok(
    $q$SELECT public.create_bot('anon-bot')$q$,
    '42501', NULL,
    'anon cannot create a bot');

-- Rotation ----------------------------------------------------------------------

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');

SELECT throws_ok(
    format('SELECT public.rotate_bot_token(%L::uuid)', current_setting('tests.bot_id')),
    '42501', NULL,
    'a non-owner cannot rotate the token');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT lives_ok(
    format($q$SELECT set_config('tests.token_2',
                                public.rotate_bot_token(%L::uuid)->>'token', true)$q$,
           current_setting('tests.bot_id')),
    'the owner rotates the token');

SELECT tests.clear_authentication();

SELECT is(public.verify_bot_token(pg_temp.sha256_hex(current_setting('tests.token_1')))->>'valid',
          'false',
          'the superseded token no longer verifies');

SELECT is(public.verify_bot_token(pg_temp.sha256_hex(current_setting('tests.token_2')))->>'bot_id',
          current_setting('tests.bot_id'),
          'the replacement token verifies');

SELECT results_eq(
    $q$SELECT count(*) FILTER (WHERE is_active),
              count(*) FILTER (WHERE NOT is_active AND revoked_at IS NOT NULL)
         FROM public.bot_tokens WHERE bot_id = current_setting('tests.bot_id')::uuid$q$,
    $q$VALUES (1::bigint, 1::bigint)$q$,
    'rotation leaves one active token and stamps the revoked one');

-- Install counts ----------------------------------------------------------------

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT lives_ok(
    format($q$SELECT public.add_bot_to_server(%L::uuid, '55555555-0000-0000-0000-000000000005'::uuid,
                                              '11111111-0000-0000-0000-000000000001'::uuid, '{}'::jsonb)$q$,
           current_setting('tests.bot_id')),
    'the owner installs the bot in their server');

SELECT results_eq(
    $q$SELECT server_count FROM public.get_owned_bot_server_counts()
        WHERE bot_id = current_setting('tests.bot_id')::uuid$q$,
    $q$VALUES (1)$q$,
    'an active installation is counted');

SELECT results_eq(
    $q$SELECT c.server_count FROM public.get_owned_bot_server_counts() c
         JOIN public.bots b ON b.id = c.bot_id WHERE b.username = 'devportal-bare'$q$,
    $q$VALUES (0)$q$,
    'an uninstalled bot is listed with zero');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');

SELECT is_empty(
    $q$SELECT * FROM public.get_owned_bot_server_counts()$q$,
    'a caller who owns no bots gets no rows');

SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
