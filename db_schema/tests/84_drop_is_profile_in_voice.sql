-- 20261008100001_drop_is_profile_in_voice.sql: voice presence of a profile is not a client RPC.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(1);

SELECT hasnt_function('public', 'is_profile_in_voice', ARRAY['uuid'], 'is_profile_in_voice is gone');

SELECT * FROM finish();
ROLLBACK;
