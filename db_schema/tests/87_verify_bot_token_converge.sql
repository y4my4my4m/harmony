-- 20261008400001_verify_bot_token_converge.sql: bot-gateway's token check exists and runs.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(3);

SELECT has_function('public', 'verify_bot_token', ARRAY['text'], 'verify_bot_token exists');
SELECT ok(has_function_privilege('service_role', 'public.verify_bot_token(text)', 'EXECUTE'),
          'service_role executes verify_bot_token');
SELECT is((public.verify_bot_token(repeat('0', 64))->>'valid')::boolean, false,
          'an unknown token hash is refused');

SELECT * FROM finish();
ROLLBACK;
