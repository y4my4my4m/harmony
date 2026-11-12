-- "Migrate from Discord": the server owner gets mapped roles, add-only,
-- 20261112800003_discord_migration_owner_roles.sql.
--
--   alice  owner of the server (Discord 600000000000000001); claims, then syncs
--   bob    accepted member (Discord 600000000000000002); his roles follow Discord both ways
--
--   roles  Mod (D1 -> Mod, no permissions), Adm (D2 -> Adm, ADMINISTRATOR)
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(13);

CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON out TO PUBLIC;
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO public.servers (id, name, owner) VALUES
  ('f2810000-0000-0000-0000-0000000000a1', 'S1 281', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f2810000-0000-0000-0000-0000000000a1', 'accepted');
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f2810000-0000-0000-0000-0000000000c1', 'f2810000-0000-0000-0000-0000000000a1', 'Mod281', 2, 0),
  ('f2810000-0000-0000-0000-0000000000c2', 'f2810000-0000-0000-0000-0000000000a1', 'Adm281', 3, 1);
INSERT INTO public.discord_migrations (server_id, discord_guild_id, credential_source, state, opened_at) VALUES
  ('f2810000-0000-0000-0000-0000000000a1', '900000000000000281', 'instance_bot', 'open', now());
INSERT INTO public.discord_migration_discord_roles (server_id, discord_role_id, name, position, harmony_permissions) VALUES
  ('f2810000-0000-0000-0000-0000000000a1', '700000000000000001', 'D1', 2, 0),
  ('f2810000-0000-0000-0000-0000000000a1', '700000000000000002', 'D2', 3, 1);
INSERT INTO public.discord_migration_role_map (server_id, discord_role_id, harmony_role_id) VALUES
  ('f2810000-0000-0000-0000-0000000000a1', '700000000000000001', 'f2810000-0000-0000-0000-0000000000c1'),
  ('f2810000-0000-0000-0000-0000000000a1', '700000000000000002', 'f2810000-0000-0000-0000-0000000000c2');
INSERT INTO public.discord_migration_links (server_id, user_id, discord_user_id, status, discord_role_ids) VALUES
  ('f2810000-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-000000000002', '600000000000000002', 'active', ARRAY['700000000000000001']);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f2810000-0000-0000-0000-0000000000c1', 'f2810000-0000-0000-0000-0000000000a1');

-- Claim ---------------------------------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('t1', public.discord_migration_create_claim('f2810000-0000-0000-0000-0000000000a1',
  '{"id":"600000000000000001","username":"alice"}'::jsonb, ARRAY['700000000000000001'], NULL));
RESET role;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out SELECT 'c1', public.discord_migration_claim(v ->> 'ticket') FROM out WHERE k = 't1';
SELECT tests.clear_authentication();
SELECT is((SELECT v -> 'roles_granted' FROM out WHERE k = 'c1'), '["Mod281"]'::jsonb, 'a claim by the owner reports the granted role');
SELECT is((SELECT v ->> 'is_owner' FROM out WHERE k = 'c1'), 'true', 'and says the claimer owns the server');
SELECT is((SELECT array_agg(sr.name) FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id
            WHERE ur.user_id = '11111111-0000-0000-0000-000000000001' AND ur.server_id = 'f2810000-0000-0000-0000-0000000000a1' AND sr.name LIKE '%281'),
  ARRAY['Mod281'], 'the owner holds the mapped role');

-- Sync: add, never remove -----------------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('s1', public.discord_migration_sync_member('f2810000-0000-0000-0000-0000000000a1',
  '11111111-0000-0000-0000-000000000001', '{"present":true,"role_ids":["700000000000000001","700000000000000002"]}'::jsonb));
RESET role;
SELECT is((SELECT array_agg(sr.name ORDER BY sr.name) FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id
            WHERE ur.user_id = '11111111-0000-0000-0000-000000000001' AND ur.server_id = 'f2810000-0000-0000-0000-0000000000a1' AND sr.name LIKE '%281'),
  ARRAY['Adm281', 'Mod281'], 'a sync adds the owner''s newly mapped Administrator role');
SELECT is((SELECT count(*)::int FROM public.notifications n
            WHERE n.user_id = '11111111-0000-0000-0000-000000000001' AND n.type = 'discord_migration_admin_change'),
  0, 'and does not notify the owner about their own role');
SET LOCAL role service_role;
INSERT INTO out VALUES ('s2', public.discord_migration_sync_member('f2810000-0000-0000-0000-0000000000a1',
  '11111111-0000-0000-0000-000000000001', '{"present":true,"role_ids":[]}'::jsonb));
RESET role;
SELECT is((SELECT v -> 'roles' -> 'removed' FROM out WHERE k = 's2'), '[]'::jsonb, 'losing every Discord role removes nothing from the owner');
SELECT is((SELECT count(*)::int FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id
            WHERE ur.user_id = '11111111-0000-0000-0000-000000000001' AND sr.name LIKE '%281'), 2, 'the owner keeps both roles');
SELECT is((SELECT count(*)::int FROM public.server_audit_log WHERE server_id = 'f2810000-0000-0000-0000-0000000000a1'
              AND action = 'member.role_remove' AND target_id = '11111111-0000-0000-0000-000000000001'), 0, 'and no removal is audited');
SELECT is((SELECT status FROM public.user_servers WHERE server_id = 'f2810000-0000-0000-0000-0000000000a1'
              AND user_id = '11111111-0000-0000-0000-000000000001'), 'accepted', 'the owner stays a member');

-- Owner exempt from removals --------------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('r1', public.discord_migration_apply_removals('f2810000-0000-0000-0000-0000000000a1',
  '[{"user_id":"11111111-0000-0000-0000-000000000001","kind":"left"}]'::jsonb));
RESET role;
SELECT is((SELECT v -> 'skipped' -> 0 ->> 'reason' FROM out WHERE k = 'r1'), 'owner', 'a removal candidate who owns the server is still skipped');

-- Non-owner behaviour unchanged ----------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('b1', public.discord_migration_sync_member('f2810000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present":true,"role_ids":["700000000000000002"]}'::jsonb));
RESET role;
SELECT is((SELECT array_agg(sr.name) FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id
            WHERE ur.user_id = '22222222-0000-0000-0000-000000000002' AND sr.name LIKE '%281'),
  ARRAY['Adm281'], 'a member swaps Mod for Adm');
SELECT is((SELECT count(*)::int FROM public.notifications n
            WHERE n.user_id = '11111111-0000-0000-0000-000000000001' AND n.type = 'discord_migration_admin_change'),
  1, 'and the owner is told about a member''s Administrator grant');
SET LOCAL role service_role;
SELECT public.discord_migration_sync_member('f2810000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present":true,"role_ids":[]}'::jsonb);
RESET role;
SELECT is((SELECT count(*)::int FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id
            WHERE ur.user_id = '22222222-0000-0000-0000-000000000002' AND sr.name LIKE '%281'), 0, 'and loses it when Discord drops the role');

SELECT * FROM finish();
ROLLBACK;
