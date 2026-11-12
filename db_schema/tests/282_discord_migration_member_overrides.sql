-- "Migrate from Discord": Discord member channel overrides carried to linked members,
-- 20261112800002_discord_migration_member_overrides.sql.
--
--   alice   owner of the server (Discord account 600000000000000003)
--   bob     accepted member, linked to Discord 600000000000000001
--   dave    claims during the test, Discord 600000000000000004
--
--   channels  general (paired with Discord 800..1), staff (paired 800..3, bob has an admin-made override),
--             lounge (not paired, Discord 800..2), owners (paired 800..4)
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(35);

CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON out TO PUBLIC;
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2800000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave280@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f2800000-0000-0000-0000-0000000000d2', 'f2800000-0000-0000-0000-0000000000d1', 'dave280', 'Dave', true);

INSERT INTO public.servers (id, name, owner) VALUES
  ('f2800000-0000-0000-0000-0000000000a1', 'S1 280', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2800000-0000-0000-0000-0000000000a1', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f2800000-0000-0000-0000-0000000000a1', 'accepted');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f2800000-0000-0000-0000-0000000000e1', 'f2800000-0000-0000-0000-0000000000a1', 'general280', 0),
  ('f2800000-0000-0000-0000-0000000000e2', 'f2800000-0000-0000-0000-0000000000a1', 'lounge280', 0),
  ('f2800000-0000-0000-0000-0000000000e3', 'f2800000-0000-0000-0000-0000000000a1', 'staff280', 0),
  ('f2800000-0000-0000-0000-0000000000e4', 'f2800000-0000-0000-0000-0000000000a1', 'owners280', 0);
INSERT INTO public.discord_bridges (id, server_id, mode, discord_guild_id, created_by) VALUES
  ('f2800000-0000-0000-0000-0000000000b1', 'f2800000-0000-0000-0000-0000000000a1', 'hosted',
   '900000000000000280', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.discord_bridge_channels (bridge_id, harmony_channel_id, discord_channel_id) VALUES
  ('f2800000-0000-0000-0000-0000000000b1', 'f2800000-0000-0000-0000-0000000000e1', '800000000000000001'),
  ('f2800000-0000-0000-0000-0000000000b1', 'f2800000-0000-0000-0000-0000000000e3', '800000000000000003'),
  ('f2800000-0000-0000-0000-0000000000b1', 'f2800000-0000-0000-0000-0000000000e4', '800000000000000004');
INSERT INTO public.discord_migrations (server_id, discord_guild_id, credential_source, state, opened_at) VALUES
  ('f2800000-0000-0000-0000-0000000000a1', '900000000000000280', 'instance_bot', 'open', now());
INSERT INTO public.discord_migration_links (server_id, user_id, discord_user_id, status) VALUES
  ('f2800000-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-000000000002', '600000000000000001', 'active'),
  ('f2800000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000001', '600000000000000003', 'active');
-- A user override a Harmony admin made on staff.
INSERT INTO public.channel_permission_overrides (channel_id, target_type, user_id, allow_permissions, deny_permissions) VALUES
  ('f2800000-0000-0000-0000-0000000000e3', 'user', '22222222-0000-0000-0000-000000000002', 4, 0);

-- Grants -------------------------------------------------------------------------------------------
SELECT ok(has_function_privilege('service_role', 'public.discord_migration_store_member_overrides(uuid, jsonb)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.discord_migration_store_member_overrides(uuid, jsonb)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.discord_migration_store_member_overrides(uuid, jsonb)', 'EXECUTE'),
  'only service_role stores the snapshot');
SELECT ok(NOT has_function_privilege('service_role', 'public.discord_migration_apply_member_overrides(uuid, uuid)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.discord_migration_apply_member_overrides(uuid, uuid)', 'EXECUTE'),
  'the apply function is granted to no role');
SELECT is_empty($q$SELECT t FROM (VALUES ('discord_migration_member_overrides'), ('discord_migration_applied_overrides')) v(t)
                    WHERE has_table_privilege('authenticated', 'public.' || t, 'SELECT')
                       OR has_table_privilege('anon', 'public.' || t, 'SELECT')
                       OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)$q$,
  'the tables are service_role only with row level security on');

-- Snapshot ---------------------------------------------------------------------------------------------
-- bit values: VIEW_CHANNEL 2, SEND_MESSAGES 4096, ATTACH_FILES 131072, ADMINISTRATOR 1
SET LOCAL role service_role;
SELECT public.discord_migration_store_member_overrides('f2800000-0000-0000-0000-0000000000a1', $j$[
  {"channel_id":"800000000000000001","channel_name":"general","user_id":"600000000000000001","allow":"4098","deny":"131073"},
  {"channel_id":"800000000000000001","channel_name":"general","user_id":"600000000000000002","allow":"2","deny":"0"},
  {"channel_id":"800000000000000002","channel_name":"lounge","user_id":"600000000000000001","allow":"2","deny":"0"},
  {"channel_id":"800000000000000003","channel_name":"staff","user_id":"600000000000000001","allow":"2","deny":"0"},
  {"channel_id":"800000000000000004","channel_name":"owners","user_id":"600000000000000003","allow":"2","deny":"0"},
  {"channel_id":"not a snowflake","user_id":"600000000000000001","allow":"2","deny":"0"}
]$j$::jsonb);
RESET role;
SELECT is((SELECT count(*)::int FROM public.discord_migration_member_overrides
            WHERE server_id = 'f2800000-0000-0000-0000-0000000000a1'), 5, 'the snapshot keeps the valid rows');
SELECT results_eq($q$SELECT allow_harmony, deny_harmony, discord_channel_name FROM public.discord_migration_member_overrides
                      WHERE discord_channel_id = '800000000000000001' AND discord_user_id = '600000000000000001'$q$,
  $q$VALUES (4098::bigint, 131072::bigint, 'general'::text)$q$,
  'the bits are stored without ADMINISTRATOR');
SET LOCAL role service_role;
SELECT throws_ok($q$SELECT public.discord_migration_store_member_overrides('f2800000-0000-0000-0000-0000000000f9', '[]'::jsonb)$q$,
  'P0002', 'migration_not_configured', 'a server without a migration refuses the snapshot');
SELECT throws_ok($q$SELECT public.discord_migration_store_member_overrides('f2800000-0000-0000-0000-0000000000a1', '{}'::jsonb)$q$,
  '22023', 'overrides must be an array', 'the snapshot must be an array');
RESET role;

-- Apply on sync ----------------------------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('s1', public.discord_migration_sync_member('f2800000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present":true}'::jsonb));
INSERT INTO out VALUES ('s1o', public.discord_migration_sync_member('f2800000-0000-0000-0000-0000000000a1',
  '11111111-0000-0000-0000-000000000001', '{"present":true}'::jsonb));
RESET role;
SELECT results_eq($q$SELECT allow_permissions, deny_permissions FROM public.channel_permission_overrides
                      WHERE channel_id = 'f2800000-0000-0000-0000-0000000000e1' AND user_id = '22222222-0000-0000-0000-000000000002'
                        AND target_type = 'user'$q$,
  $q$VALUES (4098::bigint, 131072::bigint)$q$, 'sync gives bob the override on the paired channel');
SELECT is((SELECT v -> 'member_overrides' ->> 'created' FROM out WHERE k = 's1'), '1', 'sync reports the created override');
SELECT is((SELECT count(*)::int FROM public.channel_permission_overrides
            WHERE channel_id = 'f2800000-0000-0000-0000-0000000000e2'), 0, 'a channel that is not paired gets none');
SELECT results_eq($q$SELECT allow_permissions, deny_permissions FROM public.channel_permission_overrides
                      WHERE channel_id = 'f2800000-0000-0000-0000-0000000000e3' AND user_id = '22222222-0000-0000-0000-000000000002'$q$,
  $q$VALUES (4::bigint, 0::bigint)$q$, 'an override a Harmony admin made is never overwritten');
SELECT is((SELECT v -> 'member_overrides' ->> 'skipped' FROM out WHERE k = 's1'), '1', 'and is reported as skipped');
SELECT is((SELECT count(*)::int FROM public.discord_migration_applied_overrides
            WHERE server_id = 'f2800000-0000-0000-0000-0000000000a1'), 1, 'only the migration-made override is tracked');
SELECT is((SELECT count(*)::int FROM public.channel_permission_overrides
            WHERE channel_id = 'f2800000-0000-0000-0000-0000000000e4'), 0, 'the server owner gets none');
SELECT is((SELECT count(*)::int FROM public.discord_migration_applied_overrides
            WHERE user_id = '11111111-0000-0000-0000-000000000001'), 0, 'and none is tracked for the owner');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE server_id = 'f2800000-0000-0000-0000-0000000000a1' AND action = 'override.create'
              AND source = 'system' AND details ->> 'via' = 'discord_migration'
              AND target_id = 'f2800000-0000-0000-0000-0000000000e1' AND details ->> 'user_name' = 'bob'),
  1, 'the create wrote one system audit row naming the migration');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE server_id = 'f2800000-0000-0000-0000-0000000000a1' AND action = 'override.create'
              AND target_id = 'f2800000-0000-0000-0000-0000000000e1'), 1, 'and the generic trigger wrote no second one');

-- A second sync changes nothing --------------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('s2', public.discord_migration_sync_member('f2800000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present":true}'::jsonb));
RESET role;
SELECT is((SELECT v -> 'member_overrides' ->> 'created' FROM out WHERE k = 's2') || (SELECT v -> 'member_overrides' ->> 'updated' FROM out WHERE k = 's2'),
  '00', 'syncing again creates and updates nothing');

-- Discord changes the overwrite -------------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT public.discord_migration_store_member_overrides('f2800000-0000-0000-0000-0000000000a1', $j$[
  {"channel_id":"800000000000000001","channel_name":"general","user_id":"600000000000000001","allow":"2","deny":"0"},
  {"channel_id":"800000000000000003","channel_name":"staff","user_id":"600000000000000001","allow":"2","deny":"0"}
]$j$::jsonb);
SELECT public.discord_migration_sync_member('f2800000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present":true}'::jsonb);
RESET role;
SELECT results_eq($q$SELECT allow_permissions, deny_permissions FROM public.channel_permission_overrides
                      WHERE channel_id = 'f2800000-0000-0000-0000-0000000000e1' AND user_id = '22222222-0000-0000-0000-000000000002'$q$,
  $q$VALUES (2::bigint, 0::bigint)$q$, 'a changed overwrite updates the migration-made override');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE action = 'override.update' AND source = 'system' AND details ->> 'via' = 'discord_migration'
              AND target_id = 'f2800000-0000-0000-0000-0000000000e1'), 1, 'and writes a system update row');

-- Discord removes it --------------------------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT public.discord_migration_store_member_overrides('f2800000-0000-0000-0000-0000000000a1', $j$[
  {"channel_id":"800000000000000003","channel_name":"staff","user_id":"600000000000000001","allow":"2","deny":"0"}
]$j$::jsonb);
SELECT public.discord_migration_sync_member('f2800000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present":true}'::jsonb);
RESET role;
SELECT is((SELECT count(*)::int FROM public.channel_permission_overrides
            WHERE channel_id = 'f2800000-0000-0000-0000-0000000000e1' AND user_id = '22222222-0000-0000-0000-000000000002'),
  0, 'an overwrite Discord no longer has deletes the migration-made override');
SELECT is((SELECT count(*)::int FROM public.discord_migration_applied_overrides
            WHERE server_id = 'f2800000-0000-0000-0000-0000000000a1'), 0, 'and its tracking row');
SELECT results_eq($q$SELECT allow_permissions, deny_permissions FROM public.channel_permission_overrides
                      WHERE channel_id = 'f2800000-0000-0000-0000-0000000000e3' AND user_id = '22222222-0000-0000-0000-000000000002'$q$,
  $q$VALUES (4::bigint, 0::bigint)$q$, 'the admin-made override stays untouched');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE action = 'override.delete' AND source = 'system' AND details ->> 'via' = 'discord_migration'
              AND target_id = 'f2800000-0000-0000-0000-0000000000e1'), 1, 'the delete wrote a system audit row');

-- Claim ---------------------------------------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT public.discord_migration_store_member_overrides('f2800000-0000-0000-0000-0000000000a1', $j$[
  {"channel_id":"800000000000000001","channel_name":"general","user_id":"600000000000000004","allow":"4096","deny":"2"}
]$j$::jsonb);
INSERT INTO out VALUES ('t1', public.discord_migration_create_claim('f2800000-0000-0000-0000-0000000000a1',
  '{"id":"600000000000000004","username":"dave"}'::jsonb, ARRAY[]::text[], '2020-01-02 03:04:05+00'));
RESET role;
SELECT tests.authenticate_as('f2800000-0000-0000-0000-0000000000d1');
INSERT INTO out SELECT 'c1', public.discord_migration_claim(v ->> 'ticket') FROM out WHERE k = 't1';
SELECT tests.clear_authentication();
SELECT results_eq($q$SELECT allow_permissions, deny_permissions FROM public.channel_permission_overrides
                      WHERE channel_id = 'f2800000-0000-0000-0000-0000000000e1' AND user_id = 'f2800000-0000-0000-0000-0000000000d2'$q$,
  $q$VALUES (4096::bigint, 2::bigint)$q$, 'a claim applies the member''s overrides');
SELECT is((SELECT count(*)::int FROM public.discord_migration_applied_overrides
            WHERE user_id = 'f2800000-0000-0000-0000-0000000000d2'), 1, 'and tracks them');

-- Readiness list ------------------------------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT public.discord_migration_store_member_overrides('f2800000-0000-0000-0000-0000000000a1', $j$[
  {"channel_id":"800000000000000001","channel_name":"general","user_id":"600000000000000004","allow":"4096","deny":"2"},
  {"channel_id":"800000000000000001","channel_name":"general","user_id":"600000000000000009","allow":"2","deny":"0"},
  {"channel_id":"800000000000000002","channel_name":"lounge","user_id":"600000000000000001","allow":"2","deny":"0"}
]$j$::jsonb);
RESET role;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO out VALUES ('g1', public.discord_migration_get('f2800000-0000-0000-0000-0000000000a1'));
SELECT tests.clear_authentication();
SELECT is((SELECT jsonb_array_length(v -> 'member_overrides') FROM out WHERE k = 'g1'), 3, 'get lists the snapshot rows');
SELECT is((SELECT e ->> 'status' FROM out, jsonb_array_elements(v -> 'member_overrides') e
            WHERE k = 'g1' AND e ->> 'discord_user_id' = '600000000000000004'), 'linked', 'a claimed member is linked');
SELECT is((SELECT e ->> 'username' FROM out, jsonb_array_elements(v -> 'member_overrides') e
            WHERE k = 'g1' AND e ->> 'discord_user_id' = '600000000000000004'), 'dave280', 'and names the Harmony user');
SELECT is((SELECT e ->> 'status' FROM out, jsonb_array_elements(v -> 'member_overrides') e
            WHERE k = 'g1' AND e ->> 'discord_user_id' = '600000000000000009'), 'not_linked', 'a member without a link is not linked yet');
SELECT is((SELECT e ->> 'status' FROM out, jsonb_array_elements(v -> 'member_overrides') e
            WHERE k = 'g1' AND e ->> 'channel_name' = 'lounge'), 'unpaired', 'an unpaired channel says so');
SELECT is((SELECT e -> 'allow' FROM out, jsonb_array_elements(v -> 'member_overrides') e
            WHERE k = 'g1' AND e ->> 'discord_user_id' = '600000000000000004'), '["SEND_MESSAGES"]'::jsonb, 'allowed bits come as permission names');
SELECT is((SELECT e -> 'deny' FROM out, jsonb_array_elements(v -> 'member_overrides') e
            WHERE k = 'g1' AND e ->> 'discord_user_id' = '600000000000000004'), '["VIEW_CHANNEL"]'::jsonb, 'and denied bits too');

-- Finishing keeps them ------------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_migration_set_state('f2800000-0000-0000-0000-0000000000a1', 'finished');
SELECT tests.clear_authentication();
SELECT is((SELECT state FROM public.discord_migrations WHERE server_id = 'f2800000-0000-0000-0000-0000000000a1'), 'finished',
  'the migration finished');
SELECT is((SELECT count(*)::int FROM public.channel_permission_overrides
            WHERE channel_id = 'f2800000-0000-0000-0000-0000000000e1' AND user_id = 'f2800000-0000-0000-0000-0000000000d2'),
  1, 'finishing leaves the overrides in place');

SELECT * FROM finish();
ROLLBACK;
