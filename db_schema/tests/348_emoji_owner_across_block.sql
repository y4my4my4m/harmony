-- A personal emoji's owner across a block, after 20261123500006_emoji_owner_across_block.sql.
--
--   bob_own  bob's personal emoji
--   mallory  blocked by bob
--   alice    blocks bob
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(4);

INSERT INTO public.emojis (id, name, url, server_id, uploader, scope, usage_count, domain) VALUES
  ('34800000-0000-0000-0000-0000000000e1', 'bob_own348', 'https://cdn.test/bob_own348.png', NULL,
   '22222222-0000-0000-0000-000000000002', 'user', 0, NULL);
INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES
  ('22222222-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003');

CREATE FUNCTION pg_temp.source() RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.get_emoji_source('34800000-0000-0000-0000-0000000000e1', 'https://cdn.test/bob_own348.png');
$$;

CREATE TEMP TABLE seen (who text, answer jsonb) ON COMMIT DROP;
GRANT INSERT, SELECT ON seen TO authenticated;

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
INSERT INTO seen SELECT 'mallory', pg_temp.source();
SELECT is((SELECT answer -> 'owner' ->> 'username' FROM seen), 'bob',
          'an owner who blocks the viewer is named');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
INSERT INTO seen SELECT 'banned', pg_temp.source();
SELECT tests.clear_authentication();
SELECT is((SELECT answer FROM seen WHERE who = 'mallory'), (SELECT answer FROM seen WHERE who = 'banned'),
          'the answer is the one an account outside the block gets');

INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES
  ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(pg_temp.source(), '{"kind": "personal", "owner": null}'::jsonb,
          'an owner the viewer blocks stays unnamed');
SELECT tests.clear_authentication();

UPDATE public.profiles SET deleted_at = now() WHERE id = '22222222-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.source(), '{"kind": "personal", "owner": null}'::jsonb,
          'as is a deleted owner, to anyone');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
