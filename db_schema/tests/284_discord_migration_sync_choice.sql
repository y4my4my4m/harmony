-- "Migrate from Discord": whether a member made a sync choice, 20261112800004_discord_migration_sync_choice.sql.
--
--   bob  linked on s1 with no choice yet
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(6);

INSERT INTO public.servers (id, name, owner) VALUES
  ('f2820000-0000-0000-0000-0000000000a1', 'S1 282', '11111111-0000-0000-0000-000000000001'),
  ('f2820000-0000-0000-0000-0000000000a2', 'S2 282', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_migrations (server_id, discord_guild_id, credential_source, state, opened_at) VALUES
  ('f2820000-0000-0000-0000-0000000000a1', '900000000000000282', 'instance_bot', 'open', now()),
  ('f2820000-0000-0000-0000-0000000000a2', '900000000000000283', 'instance_bot', 'open', now());
INSERT INTO public.discord_migration_links (server_id, user_id, discord_user_id, status, sync_fields) VALUES
  ('f2820000-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-000000000002', '600000000000000001', 'active', '{}');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.discord_migration_my_link('f2820000-0000-0000-0000-0000000000a1') ->> 'sync_chosen', 'false',
  'a link with no saved choice reports sync_chosen false');
SELECT is(public.discord_migration_my_link('f2820000-0000-0000-0000-0000000000a1') -> 'sync_fields', '[]'::jsonb,
  'and no fields');
SELECT lives_ok($q$SELECT public.discord_migration_set_my_sync('f2820000-0000-0000-0000-0000000000a1', '{}')$q$,
  'saving an empty choice works');
SELECT is(public.discord_migration_my_link('f2820000-0000-0000-0000-0000000000a1') ->> 'sync_chosen', 'true',
  'an empty choice is still a choice');
SELECT lives_ok($q$SELECT public.discord_migration_set_my_sync('f2820000-0000-0000-0000-0000000000a1', '{avatar,banner}')$q$,
  'saving fields works');
SELECT is(public.discord_migration_my_link('f2820000-0000-0000-0000-0000000000a1') -> 'sync_fields', '["avatar", "banner"]'::jsonb,
  'the fields are returned');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
