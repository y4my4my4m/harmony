-- "Migrate from Discord": the sync RPCs the gateway calls, 20261112500001_discord_migration.sql.
--
--   alice   owner of s1 (a1), s2 (a2), s3 (a3); linked on s1 and s2
--   bob     member of s1, Discord account U1
--   mallory not a member of s1
--   u01..u40 filler members for the brake tests (u01..u10 on s2, u11..u40 on s3)
--
--   s1  roles Mod (c1), Helper (c4), Artist (c3, unmapped), Admins (c2, ADMINISTRATOR); map D1 -> Mod, D2 -> Admins
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(95);

CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON out TO PUBLIC;
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO public.profiles (id, username, display_name, is_local)
SELECT ('f2760000-0000-0000-0000-' || lpad((1000 + n)::text, 12, '0'))::uuid, 'u276_' || n, 'U' || n, true
  FROM generate_series(1, 40) n;

INSERT INTO public.servers (id, name, owner) VALUES
  ('f2760000-0000-0000-0000-0000000000a1', 'S1 276', '11111111-0000-0000-0000-000000000001'),
  ('f2760000-0000-0000-0000-0000000000a2', 'S2 276', '11111111-0000-0000-0000-000000000001'),
  ('f2760000-0000-0000-0000-0000000000a3', 'S3 276', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2760000-0000-0000-0000-0000000000a1', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f2760000-0000-0000-0000-0000000000a1', 'accepted'),
  ('11111111-0000-0000-0000-000000000001', 'f2760000-0000-0000-0000-0000000000a2', 'accepted'),
  ('11111111-0000-0000-0000-000000000001', 'f2760000-0000-0000-0000-0000000000a3', 'accepted');
INSERT INTO public.user_servers (user_id, server_id, status)
SELECT ('f2760000-0000-0000-0000-' || lpad((1000 + n)::text, 12, '0'))::uuid,
       CASE WHEN n <= 10 THEN 'f2760000-0000-0000-0000-0000000000a2'::uuid ELSE 'f2760000-0000-0000-0000-0000000000a3'::uuid END,
       'accepted'
  FROM generate_series(1, 40) n;
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f2760000-0000-0000-0000-0000000000c1', 'f2760000-0000-0000-0000-0000000000a1', 'Mod276', 2, 8),
  ('f2760000-0000-0000-0000-0000000000c2', 'f2760000-0000-0000-0000-0000000000a1', 'Admins276', 3, 1),
  ('f2760000-0000-0000-0000-0000000000c3', 'f2760000-0000-0000-0000-0000000000a1', 'Artist276', 1, 0),
  ('f2760000-0000-0000-0000-0000000000c4', 'f2760000-0000-0000-0000-0000000000a1', 'Helper276', 1, 0),
  ('f2760000-0000-0000-0000-0000000000c5', 'f2760000-0000-0000-0000-0000000000a2', 'Admins276b', 3, 1);
INSERT INTO public.discord_migrations (server_id, discord_guild_id, credential_source, state, opened_at) VALUES
  ('f2760000-0000-0000-0000-0000000000a1', '900000000000000276', 'instance_bot', 'open', now()),
  ('f2760000-0000-0000-0000-0000000000a2', '900000000000000277', 'instance_bot', 'open', now()),
  ('f2760000-0000-0000-0000-0000000000a3', '900000000000000278', 'instance_bot', 'open', now());
INSERT INTO public.discord_migration_discord_roles (server_id, discord_role_id, name, position, harmony_permissions) VALUES
  ('f2760000-0000-0000-0000-0000000000a1', '700000000000000001', 'D1', 2, 0),
  ('f2760000-0000-0000-0000-0000000000a1', '700000000000000002', 'D2', 3, 1);
INSERT INTO public.discord_migration_role_map (server_id, discord_role_id, harmony_role_id) VALUES
  ('f2760000-0000-0000-0000-0000000000a1', '700000000000000001', 'f2760000-0000-0000-0000-0000000000c1'),
  ('f2760000-0000-0000-0000-0000000000a1', '700000000000000002', 'f2760000-0000-0000-0000-0000000000c2');
INSERT INTO public.discord_migration_links (server_id, user_id, discord_user_id, status) VALUES
  ('f2760000-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-000000000002', '600000000000000001', 'active'),
  ('f2760000-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000001', '600000000000000002', 'active'),
  ('f2760000-0000-0000-0000-0000000000a2', '11111111-0000-0000-0000-000000000001', '600000000000000003', 'active');
INSERT INTO public.discord_migration_links (server_id, user_id, discord_user_id, status)
SELECT CASE WHEN n <= 10 THEN 'f2760000-0000-0000-0000-0000000000a2'::uuid ELSE 'f2760000-0000-0000-0000-0000000000a3'::uuid END,
       ('f2760000-0000-0000-0000-' || lpad((1000 + n)::text, 12, '0'))::uuid, (610000000000000000 + n)::text, 'active'
  FROM generate_series(1, 40) n;

-- Grants -------------------------------------------------------------------------------------------
CREATE TEMP TABLE service_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO service_fns VALUES
  ('public.discord_migration_due(integer, interval)'),
  ('public.discord_migration_links_batch(uuid, integer)'),
  ('public.discord_migration_sync_member(uuid, uuid, jsonb)'),
  ('public.discord_migration_apply_removals(uuid, jsonb)'),
  ('public.discord_migration_pause(uuid, text)'),
  ('public.discord_migration_record_sync(uuid, jsonb, timestamptz, timestamptz, boolean)');
SELECT is_empty($q$SELECT fn FROM service_fns WHERE has_function_privilege('anon', fn, 'EXECUTE')
                                                OR has_function_privilege('authenticated', fn, 'EXECUTE')
                                                OR NOT has_function_privilege('service_role', fn, 'EXECUTE')$q$,
  'only service_role executes the sync RPCs');
SELECT ok(NOT has_function_privilege('service_role', 'public._kick_server_member_internal(uuid, uuid, text, uuid, integer)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._ban_server_member_internal(uuid, uuid, text, uuid, integer)', 'EXECUTE'),
  'the internal kick and ban are granted to no role');

-- role_diff + not_member -------------------------------------------------------------------------------
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f2760000-0000-0000-0000-0000000000c1', 'f2760000-0000-0000-0000-0000000000a1'),
  ('22222222-0000-0000-0000-000000000002', 'f2760000-0000-0000-0000-0000000000c3', 'f2760000-0000-0000-0000-0000000000a1');
SET LOCAL role service_role;
INSERT INTO out VALUES ('rd', public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": true, "role_ids": []}'));
INSERT INTO out VALUES ('nm', public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '33333333-0000-0000-0000-000000000003', '{"present": true, "role_ids": ["700000000000000001"]}'));
RESET role;
SELECT is((SELECT array_agg(sr.name ORDER BY sr.name) FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id AND sr.name LIKE '%276'
            WHERE ur.server_id = 'f2760000-0000-0000-0000-0000000000a1' AND ur.user_id = '22222222-0000-0000-0000-000000000002'),
  ARRAY['Artist276'], 'role_diff: the hand-granted mapped role goes, the unmapped one stays');
SELECT is((SELECT v -> 'roles' -> 'removed' FROM out WHERE k = 'rd'), '["f2760000-0000-0000-0000-0000000000c1"]'::jsonb,
  'role_diff: sync_member reports the removed role');
SELECT is((SELECT v FROM out WHERE k = 'nm'), '{"skipped": "not_member"}'::jsonb, 'not_member: a non-member is skipped');
SELECT is((SELECT count(*)::int FROM public.user_roles WHERE user_id = '33333333-0000-0000-0000-000000000003'
              AND server_id = 'f2760000-0000-0000-0000-0000000000a1'), 0, 'not_member: and gains no role');
SELECT is((SELECT count(*)::int FROM public.user_servers WHERE user_id = '33333333-0000-0000-0000-000000000003'
              AND server_id = 'f2760000-0000-0000-0000-0000000000a1'), 0, 'not_member: and is not added');
SELECT is((SELECT public.discord_migration_apply_roles('f2760000-0000-0000-0000-0000000000a1',
              '33333333-0000-0000-0000-000000000003', ARRAY['700000000000000001'])),
  '{"added": [], "removed": []}'::jsonb, 'not_member: apply_roles changes nothing for a non-member');
SELECT is((SELECT count(*)::int FROM public.server_audit_log WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1'
              AND action = 'member.role_remove' AND source = 'system' AND details ->> 'via' = 'discord_migration'
              AND target_id = '22222222-0000-0000-0000-000000000002'),
  1, 'role_diff: one system audit row for the removal');
SELECT ok((SELECT last_synced_at IS NOT NULL AND discord_role_ids = '{}' FROM public.discord_migration_links
            WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002'),
  'sync_member stamps last_synced_at and stores the role ids');

-- remap_moves_roles -----------------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": true, "role_ids": ["700000000000000001"], "joined_at": "2021-05-06T07:08:09Z"}');
RESET role;
SELECT is((SELECT array_agg(sr.name ORDER BY sr.name) FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id AND sr.name LIKE '%276'
            WHERE ur.server_id = 'f2760000-0000-0000-0000-0000000000a1' AND ur.user_id = '22222222-0000-0000-0000-000000000002'),
  ARRAY['Artist276', 'Mod276'], 'remap: D1 gives bob Mod');
SELECT is((SELECT discord_joined_at FROM public.discord_migration_links
            WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002'),
  '2021-05-06 07:08:09+00'::timestamptz, 'sync_member stores the Discord join date');
UPDATE public.discord_migration_role_map SET harmony_role_id = 'f2760000-0000-0000-0000-0000000000c4'
 WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND discord_role_id = '700000000000000001';
SET LOCAL role service_role;
SELECT public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": true, "role_ids": ["700000000000000001"]}');
RESET role;
SELECT is((SELECT array_agg(sr.name ORDER BY sr.name) FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id AND sr.name LIKE '%276'
            WHERE ur.server_id = 'f2760000-0000-0000-0000-0000000000a1' AND ur.user_id = '22222222-0000-0000-0000-000000000002'),
  ARRAY['Artist276', 'Helper276'], 'remap: after D1 -> Helper bob holds Helper, not Mod');

-- owner_untouched -------------------------------------------------------------------------------------
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2760000-0000-0000-0000-0000000000c4', 'f2760000-0000-0000-0000-0000000000a1');
SET LOCAL role service_role;
INSERT INTO out VALUES ('ow1', public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '11111111-0000-0000-0000-000000000001', '{"present": true, "role_ids": ["700000000000000002"]}'));
INSERT INTO out VALUES ('ow2', public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '11111111-0000-0000-0000-000000000001', '{"present": true, "role_ids": []}'));
RESET role;
SELECT is((SELECT array_agg(sr.name ORDER BY sr.name) FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id AND sr.name LIKE '%276'
            WHERE ur.server_id = 'f2760000-0000-0000-0000-0000000000a1' AND ur.user_id = '11111111-0000-0000-0000-000000000001'),
  ARRAY['Helper276'], 'owner_untouched: the owner gains nothing and keeps the hand-granted mapped role');

-- admin_grant_notifies_owner --------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": true, "role_ids": ["700000000000000002"]}');
RESET role;
SELECT ok(EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = '22222222-0000-0000-0000-000000000002'
                     AND role_id = 'f2760000-0000-0000-0000-0000000000c2'), 'admin: bob gets Admins');
SELECT results_eq($q$SELECT n.data #>> '{role,name}', n.data ->> 'change', n.data #>> '{user,username}', n.data #>> '{server,name}'
                       FROM public.notifications n
                      WHERE n.user_id = '11111111-0000-0000-0000-000000000001' AND n.type = 'discord_migration_admin_change'
                        AND n.data #>> '{server,id}' = 'f2760000-0000-0000-0000-0000000000a1'$q$,
  $q$VALUES ('Admins276'::text, 'granted'::text, 'bob'::text, 'S1 276'::text)$q$,
  'admin: one granted notification for the owner');
SELECT ok((SELECT details ->> 'administrator' = 'true' FROM public.server_audit_log
            WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND action = 'member.role_add'
              AND target_id = '22222222-0000-0000-0000-000000000002' AND details ->> 'role_name' = 'Admins276'),
  'admin: the audit row is flagged administrator');
SET LOCAL role service_role;
SELECT public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": true, "role_ids": []}');
RESET role;
SELECT ok(NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = '22222222-0000-0000-0000-000000000002'
                         AND role_id = 'f2760000-0000-0000-0000-0000000000c2'), 'admin: and loses Admins');
SELECT is((SELECT array_agg(n.data ->> 'change' ORDER BY n.created_at, n.data ->> 'change') FROM public.notifications n
            WHERE n.user_id = '11111111-0000-0000-0000-000000000001' AND n.type = 'discord_migration_admin_change'
              AND n.data #>> '{server,id}' = 'f2760000-0000-0000-0000-0000000000a1'),
  ARRAY['granted', 'removed'], 'admin: a second notification says removed');
SELECT ok(EXISTS (SELECT 1 FROM public.user_servers WHERE user_id = '22222222-0000-0000-0000-000000000002'
                     AND server_id = 'f2760000-0000-0000-0000-0000000000a1' AND status = 'accepted'), 'admin: bob stays a member');

-- profile_opt_in ---------------------------------------------------------------------------------------
CREATE TEMP TABLE before_profile ON COMMIT DROP AS
  SELECT display_name, avatar_url, color FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002';
SET LOCAL role service_role;
SELECT public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', $j${"present": true, "profile": {"display_name": "Disc Bob", "avatar_url": "https://m.example/a.png",
  "accent_color": 16711680, "server_nickname": "Bobby"}}$j$);
RESET role;
SELECT results_eq($q$SELECT display_name, avatar_url, color FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'$q$,
  $q$SELECT display_name, avatar_url, color FROM before_profile$q$, 'profile: empty sync_fields changes no profile column');
SELECT ok((SELECT nickname IS NULL FROM public.user_servers WHERE user_id = '22222222-0000-0000-0000-000000000002'
              AND server_id = 'f2760000-0000-0000-0000-0000000000a1'), 'profile: nor the server nickname');
UPDATE public.discord_migration_links SET sync_fields = ARRAY['display_name', 'accent_color', 'server_nickname']
 WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002';
SET LOCAL role service_role;
SELECT public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', $j${"present": true, "profile": {"display_name": "Disc Bob", "avatar_url": "https://m.example/a.png",
  "accent_color": 16711680, "server_nickname": "Bobby"}}$j$);
RESET role;
SELECT is((SELECT display_name FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'), 'Disc Bob',
  'profile: the opted-in display name updates');
SELECT is((SELECT color FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'), '#ff0000',
  'profile: the accent colour becomes #rrggbb');
SELECT is((SELECT nickname FROM public.user_servers WHERE user_id = '22222222-0000-0000-0000-000000000002'
              AND server_id = 'f2760000-0000-0000-0000-0000000000a1'), 'Bobby', 'profile: the server nickname updates');
SELECT is((SELECT avatar_url FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'),
  (SELECT avatar_url FROM before_profile), 'profile: the avatar, not opted in, does not');
SET LOCAL role service_role;
SELECT public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": true, "profile": {"display_name": "Disc Bob 2"}}');
RESET role;
SELECT is((SELECT nickname FROM public.user_servers WHERE user_id = '22222222-0000-0000-0000-000000000002'
              AND server_id = 'f2760000-0000-0000-0000-0000000000a1'), 'Bobby',
  'profile: a profile without the server_nickname key leaves the nickname');
SET LOCAL role service_role;
SELECT public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": true, "profile": {"server_nickname": null}}');
RESET role;
SELECT ok((SELECT nickname IS NULL FROM public.user_servers WHERE user_id = '22222222-0000-0000-0000-000000000002'
              AND server_id = 'f2760000-0000-0000-0000-0000000000a1'), 'profile: a Discord null clears the nickname');

SET LOCAL role service_role;
SELECT public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": true, "profile": {"accent_color": 1.5}}');
SELECT public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": true, "profile": {"accent_color": 99999999999}}');
RESET role;
SELECT is((SELECT color FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'), '#ff0000',
  'profile: a non-integer or out-of-range accent colour is ignored, not an error');

-- a profile write that fails does not undo the member's role sync ------------------------------------------
-- (a non-string server banner makes service_set_member_server_profile raise after the display name was written)
UPDATE public.discord_migration_links SET sync_fields = sync_fields || ARRAY['server_banner']
 WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002';
SET LOCAL role service_role;
INSERT INTO out VALUES ('pe', public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002',
  jsonb_build_object('present', true, 'role_ids', jsonb_build_array('700000000000000001'),
                     'profile', jsonb_build_object('display_name', 'Half Written', 'server_banner_url', 5))));
RESET role;
UPDATE public.discord_migration_links SET sync_fields = array_remove(sync_fields, 'server_banner')
 WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002';
SELECT is((SELECT v -> 'profile_error' FROM out WHERE k = 'pe'), 'true'::jsonb, 'profile failure: the result says profile_error');
SELECT ok(EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = '22222222-0000-0000-0000-000000000002'
                     AND role_id = 'f2760000-0000-0000-0000-0000000000c4'), 'profile failure: the roles were still applied');
SELECT is((SELECT display_name FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'), 'Disc Bob 2',
  'profile failure: the profile writes were rolled back together');
SELECT ok((SELECT last_synced_at > now() - interval '1 minute' FROM public.discord_migration_links
            WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002'),
  'profile failure: and the link is marked synced');
SET LOCAL role service_role;
SELECT public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": true, "role_ids": []}');
RESET role;

-- timeouts_respect_harmony -----------------------------------------------------------------------------
INSERT INTO out VALUES ('tuntil', to_jsonb((now() + interval '1 hour')::text));
SET LOCAL role service_role;
INSERT INTO out VALUES ('to1', public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', format('{"present": true, "timed_out_until": "%s"}', (SELECT v #>> '{}' FROM out WHERE k = 'tuntil'))::jsonb));
RESET role;
SELECT is((SELECT v ->> 'timeout_changed' FROM out WHERE k = 'to1'), 'true', 'timeout_changed: true when a Discord timeout is applied');
SELECT results_eq($q$SELECT source, reason, until > now() FROM public.server_member_timeouts
                      WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002'$q$,
  $q$VALUES ('discord_migration'::text, 'Timed out on Discord'::text, true)$q$, 'timeout: a Discord timeout creates a discord_migration row');
SELECT is((SELECT count(*)::int FROM public.server_audit_log WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1'
              AND action = 'member.timeout' AND target_id = '22222222-0000-0000-0000-000000000002'
              AND source = 'system' AND details ->> 'via' = 'discord_migration' AND details ? 'until'),
  1, 'timeout: audited once, as the migration');
SET LOCAL role service_role;
INSERT INTO out VALUES ('to2', public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', format('{"present": true, "timed_out_until": "%s"}', (SELECT v #>> '{}' FROM out WHERE k = 'tuntil'))::jsonb));
INSERT INTO out VALUES ('to3', public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": true, "timed_out_until": null}'));
RESET role;
SELECT is((SELECT v ->> 'timeout_changed' FROM out WHERE k = 'to2'), 'false', 'timeout_changed: false when the same until is already stored');
SELECT is((SELECT v ->> 'timeout_changed' FROM out WHERE k = 'to3'), 'true', 'timeout_changed: true when a Discord timeout is lifted');
SELECT is((SELECT count(*)::int FROM public.server_member_timeouts
            WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002'),
  0, 'timeout: a later null removes it');
SELECT is((SELECT count(*)::int FROM public.server_audit_log WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1'
              AND action = 'member.timeout_remove' AND target_id = '22222222-0000-0000-0000-000000000002'
              AND source = 'system' AND details ->> 'via' = 'discord_migration'),
  1, 'timeout: and audits the removal');
INSERT INTO public.server_member_timeouts (server_id, user_id, until, reason, source, created_by) VALUES
  ('f2760000-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-000000000002', now() + interval '2 hours', 'mod says', 'moderator',
   '11111111-0000-0000-0000-000000000001');
CREATE TEMP TABLE mod_timeout ON COMMIT DROP AS
  SELECT * FROM public.server_member_timeouts
   WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002';
SET LOCAL role service_role;
INSERT INTO out VALUES ('to4', public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', format('{"present": true, "timed_out_until": "%s"}', (now() + interval '1 hour')::text)::jsonb));
RESET role;
SELECT is((SELECT v ->> 'timeout_changed' FROM out WHERE k = 'to4'), 'false', 'timeout_changed: false when a moderator timeout is running');
SELECT results_eq($q$SELECT * FROM public.server_member_timeouts
                      WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002'$q$,
  $q$SELECT * FROM mod_timeout$q$, 'timeout: a running moderator timeout is unchanged by a Discord timeout');
SET LOCAL role service_role;
SELECT public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": true, "timed_out_until": null}');
RESET role;
SELECT results_eq($q$SELECT * FROM public.server_member_timeouts
                      WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND user_id = '22222222-0000-0000-0000-000000000002'$q$,
  $q$SELECT * FROM mod_timeout$q$, 'timeout: and by a Discord null');

-- not present -------------------------------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('np1', public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": false, "banned": false}'));
INSERT INTO out VALUES ('np2', public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a1',
  '22222222-0000-0000-0000-000000000002', '{"present": false, "banned": true}'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'np1'), '{"candidate": "left"}'::jsonb, 'absent: a member who left is a left candidate');
SELECT is((SELECT v FROM out WHERE k = 'np2'), '{"candidate": "banned"}'::jsonb, 'absent: a banned one is a banned candidate');
SELECT ok(EXISTS (SELECT 1 FROM public.user_servers WHERE user_id = '22222222-0000-0000-0000-000000000002'
                     AND server_id = 'f2760000-0000-0000-0000-0000000000a1'), 'absent: nothing is removed by sync_member');

-- never_removes_owner_or_admin (s2: 11 active links) ---------------------------------------------------
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f2760000-0000-0000-0000-000000001001', 'f2760000-0000-0000-0000-0000000000c5', 'f2760000-0000-0000-0000-0000000000a2');
SET LOCAL role service_role;
INSERT INTO out VALUES ('rm1', public.discord_migration_apply_removals('f2760000-0000-0000-0000-0000000000a2',
  '[{"user_id": "11111111-0000-0000-0000-000000000001", "kind": "left"}, {"user_id": "f2760000-0000-0000-0000-000000001001", "kind": "banned"}]'));
RESET role;
SELECT is((SELECT count(*)::int FROM public.user_servers WHERE server_id = 'f2760000-0000-0000-0000-0000000000a2'
              AND user_id IN ('11111111-0000-0000-0000-000000000001', 'f2760000-0000-0000-0000-000000001001')),
  2, 'protected: the owner and the Administrator holder are both still members');
SELECT is((SELECT v -> 'skipped' FROM out WHERE k = 'rm1'),
  '[{"user_id": "11111111-0000-0000-0000-000000000001", "reason": "owner"}, {"user_id": "f2760000-0000-0000-0000-000000001001", "reason": "administrator"}]'::jsonb,
  'protected: both are reported skipped');
SELECT is((SELECT count(*)::int FROM public.server_bans WHERE server_id = 'f2760000-0000-0000-0000-0000000000a2'), 0,
  'protected: nobody was banned');

-- removal_kinds (and the brake not firing below the minimum) -------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('rm2', public.discord_migration_apply_removals('f2760000-0000-0000-0000-0000000000a2',
  '[{"user_id": "f2760000-0000-0000-0000-000000001002", "kind": "left"}, {"user_id": "f2760000-0000-0000-0000-000000001003", "kind": "banned"}]'));
RESET role;
SELECT is((SELECT v ->> 'applied' FROM out WHERE k = 'rm2'), '2', 'removals: two candidates apply below the minimum of 3');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.user_servers WHERE server_id = 'f2760000-0000-0000-0000-0000000000a2'
                         AND user_id IN ('f2760000-0000-0000-0000-000000001002', 'f2760000-0000-0000-0000-000000001003')),
  'removals: both are gone from the server');
SELECT is((SELECT status FROM public.discord_migration_links WHERE server_id = 'f2760000-0000-0000-0000-0000000000a2'
              AND user_id = 'f2760000-0000-0000-0000-000000001002'), 'left',
  'removal_kinds: a left candidate ends with the link left, not kicked_on_harmony');
SELECT is((SELECT status FROM public.discord_migration_links WHERE server_id = 'f2760000-0000-0000-0000-0000000000a2'
              AND user_id = 'f2760000-0000-0000-0000-000000001003'), 'banned', 'removal_kinds: a banned candidate ends banned');
SELECT is((SELECT count(*)::int FROM public.server_bans WHERE server_id = 'f2760000-0000-0000-0000-0000000000a2'
              AND user_id = 'f2760000-0000-0000-0000-000000001003' AND reason = 'Banned on the Discord server'), 1,
  'removal_kinds: the banned candidate has a server_bans row');
SELECT is((SELECT count(*)::int FROM public.server_membership_events WHERE server_id = 'f2760000-0000-0000-0000-0000000000a2'
              AND user_id = 'f2760000-0000-0000-0000-000000001002' AND event_type = 'kick' AND payload ->> 'reason' = 'Left the Discord server'), 1,
  'removal_kinds: the left candidate has a kick event with the reason');
SELECT is((SELECT array_agg(action ORDER BY action) FROM public.server_audit_log
            WHERE server_id = 'f2760000-0000-0000-0000-0000000000a2' AND action IN ('member.kick', 'member.ban')
              AND source = 'system' AND details ->> 'via' = 'discord_migration'),
  ARRAY['member.ban', 'member.kick'], 'removal_kinds: one system audit row each, naming the migration');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE server_id = 'f2760000-0000-0000-0000-0000000000a2' AND action IN ('member.kick', 'member.ban')), 2,
  'removal_kinds: and the generic trigger wrote no extra row');

-- brake_and_pause (s3: 30 active links) ---------------------------------------------------------------
-- bob manages s3 through a MANAGE_SERVER role; mallory is a plain member; the owner is alice.
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f2760000-0000-0000-0000-0000000000a3', 'accepted'),
  ('33333333-0000-0000-0000-000000000003', 'f2760000-0000-0000-0000-0000000000a3', 'accepted');
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f2760000-0000-0000-0000-0000000000c6', 'f2760000-0000-0000-0000-0000000000a3', 'Mgr276', 2, 128);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f2760000-0000-0000-0000-0000000000c6', 'f2760000-0000-0000-0000-0000000000a3');
UPDATE public.discord_migrations SET sync_requested_at = now() WHERE server_id = 'f2760000-0000-0000-0000-0000000000a3';
SELECT ok(EXISTS (SELECT 1 FROM public.discord_migration_due(100) d WHERE d ->> 'server_id' = 'f2760000-0000-0000-0000-0000000000a3'),
  'brake: s3 is due before it is paused');
SET LOCAL role service_role;
INSERT INTO out VALUES ('br', public.discord_migration_apply_removals('f2760000-0000-0000-0000-0000000000a3',
  '[{"user_id": "f2760000-0000-0000-0000-000000001011", "kind": "left"}, {"user_id": "f2760000-0000-0000-0000-000000001012", "kind": "left"},
    {"user_id": "f2760000-0000-0000-0000-000000001013", "kind": "banned"}, {"user_id": "f2760000-0000-0000-0000-000000001014", "kind": "left"}]'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'br'), '{"paused": true}'::jsonb, 'brake: 4 of 30 links (13%) pauses');
SELECT is((SELECT sync_paused_reason FROM public.discord_migrations WHERE server_id = 'f2760000-0000-0000-0000-0000000000a3'),
  'removal_brake', 'brake: the reason is recorded');
SELECT is((SELECT count(*)::int FROM public.user_servers WHERE server_id = 'f2760000-0000-0000-0000-0000000000a3'
              AND user_id IN ('f2760000-0000-0000-0000-000000001011', 'f2760000-0000-0000-0000-000000001012',
                              'f2760000-0000-0000-0000-000000001013', 'f2760000-0000-0000-0000-000000001014')),
  4, 'brake: all 4 are still members');
SELECT is((SELECT count(*)::int FROM public.server_audit_log WHERE server_id = 'f2760000-0000-0000-0000-0000000000a3'
              AND action = 'discord_migration.paused' AND source = 'system' AND details ->> 'reason' = 'removal_brake'),
  1, 'brake: the pause is audited');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.discord_migration_due(100) d WHERE d ->> 'server_id' = 'f2760000-0000-0000-0000-0000000000a3'),
  'brake: a paused migration is no longer due');
-- the pause tells the people who can resume it
SELECT is((SELECT array_agg(n.user_id ORDER BY n.user_id) FROM public.notifications n
            WHERE n.type = 'discord_migration_paused' AND n.data #>> '{server,id}' = 'f2760000-0000-0000-0000-0000000000a3'),
  ARRAY['11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002']::uuid[],
  'pause: the owner (once) and the MANAGE_SERVER holder are notified, a plain member is not');
SELECT is((SELECT n.data FROM public.notifications n
            WHERE n.type = 'discord_migration_paused' AND n.user_id = '11111111-0000-0000-0000-000000000001'
              AND n.data #>> '{server,id}' = 'f2760000-0000-0000-0000-0000000000a3'),
  '{"server": {"id": "f2760000-0000-0000-0000-0000000000a3", "name": "S3 276"}, "reason": "removal_brake"}'::jsonb,
  'pause: the notification names the server and the reason');

-- due_ordering + record_sync --------------------------------------------------------------------------
UPDATE public.discord_migrations SET state = 'finished', sync_requested_at = now() WHERE server_id = 'f2760000-0000-0000-0000-0000000000a2';
UPDATE public.discord_migrations SET sync_requested_at = now(), last_sync_at = now() WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1';
SELECT ok(EXISTS (SELECT 1 FROM public.discord_migration_due(100) d WHERE d ->> 'server_id' = 'f2760000-0000-0000-0000-0000000000a1'),
  'due: a migration with sync_requested_at set is returned');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.discord_migration_due(100) d WHERE d ->> 'server_id' = 'f2760000-0000-0000-0000-0000000000a2'),
  'due: a finished one is not');
SET LOCAL role service_role;
SELECT public.discord_migration_record_sync('f2760000-0000-0000-0000-0000000000a1', '{"members": 1}', NULL, now() - interval '1 minute');
RESET role;
SELECT ok((SELECT sync_requested_at IS NOT NULL FROM public.discord_migrations WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1'),
  'record_sync: a Sync now asked for after the pass started stays pending');
SET LOCAL role service_role;
SELECT public.discord_migration_record_sync('f2760000-0000-0000-0000-0000000000a1', '{"members": 2}', '2026-11-01 00:00:00+00');
RESET role;
SELECT results_eq($q$SELECT sync_requested_at IS NULL, last_sync_at > now() - interval '1 minute', last_sync_result, sync_cursor
                       FROM public.discord_migrations WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1'$q$,
  $q$VALUES (true, true, '{"members": 2}'::jsonb, '2026-11-01 00:00:00+00'::timestamptz)$q$, 'record_sync stores the pass and clears the request');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.discord_migration_due(100) d WHERE d ->> 'server_id' = 'f2760000-0000-0000-0000-0000000000a1'),
  'due: a fresh sync is not due again');
-- a pass stopped on its budget (p_complete = false) stays due and does not advance last_sync_at
UPDATE public.discord_migrations SET last_sync_at = now() - interval '1 hour' WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1';
SET LOCAL role service_role;
SELECT public.discord_migration_record_sync('f2760000-0000-0000-0000-0000000000a1', '{"partial": 1}', NULL, now(), false);
RESET role;
SELECT results_eq($q$SELECT sync_requested_at IS NOT NULL, last_sync_result
                       FROM public.discord_migrations WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1'$q$,
  $q$VALUES (true, '{"partial": 1}'::jsonb)$q$, 'record_sync partial: result stored and a request kept pending');
SELECT ok(EXISTS (SELECT 1 FROM public.discord_migration_due(100) d WHERE d ->> 'server_id' = 'f2760000-0000-0000-0000-0000000000a1'),
  'due: a partial pass is still returned');
SELECT ok((SELECT last_sync_at = now() - interval '1 hour' FROM public.discord_migrations WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1'),
  'record_sync partial: last_sync_at did not advance');
SET LOCAL role service_role;
SELECT public.discord_migration_record_sync('f2760000-0000-0000-0000-0000000000a1', '{"members": 3}', NULL, now(), true);
RESET role;
SELECT ok(NOT EXISTS (SELECT 1 FROM public.discord_migration_due(100) d WHERE d ->> 'server_id' = 'f2760000-0000-0000-0000-0000000000a1'),
  'record_sync complete: no longer due');
UPDATE public.discord_migrations SET last_sync_at = now() - interval '7 hours' WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1';
SELECT ok(EXISTS (SELECT 1 FROM public.discord_migration_due(100) d WHERE d ->> 'server_id' = 'f2760000-0000-0000-0000-0000000000a1'),
  'due: a sync older than the interval is due');
UPDATE public.discord_migration_links SET last_synced_at = NULL
 WHERE server_id = 'f2760000-0000-0000-0000-0000000000a1' AND user_id = '11111111-0000-0000-0000-000000000001';
SELECT is((SELECT d ->> 'user_id' FROM public.discord_migration_links_batch('f2760000-0000-0000-0000-0000000000a1', 1) d),
  '11111111-0000-0000-0000-000000000001', 'links_batch: never-synced links come first');
SELECT is((SELECT count(*)::int FROM public.discord_migration_links_batch('f2760000-0000-0000-0000-0000000000a3', 100)), 30,
  'links_batch: returns the active links');

-- paused migrations apply nothing; already banned; per-candidate isolation (s3 stays paused, s2 reopened) ---
SET LOCAL role service_role;
INSERT INTO out VALUES ('pz', public.discord_migration_apply_removals('f2760000-0000-0000-0000-0000000000a3',
  '[{"user_id": "f2760000-0000-0000-0000-000000001021", "kind": "left"}]'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'pz'), '{"paused": true}'::jsonb, 'paused: a paused migration refuses removals');
SELECT ok(EXISTS (SELECT 1 FROM public.user_servers WHERE server_id = 'f2760000-0000-0000-0000-0000000000a3'
                     AND user_id = 'f2760000-0000-0000-0000-000000001021'), 'paused: and the candidate is still a member');

UPDATE public.discord_migrations SET state = 'open', removal_brake_pct = 100 WHERE server_id = 'f2760000-0000-0000-0000-0000000000a2';
INSERT INTO public.server_bans (server_id, user_id, reason) VALUES
  ('f2760000-0000-0000-0000-0000000000a2', 'f2760000-0000-0000-0000-000000001004', 'banned earlier');
SET LOCAL role service_role;
INSERT INTO out VALUES ('ab', public.discord_migration_apply_removals('f2760000-0000-0000-0000-0000000000a2',
  '[{"user_id": "not-a-uuid", "kind": "left"}, {"user_id": "f2760000-0000-0000-0000-000000001004", "kind": "banned"},
    {"user_id": "f2760000-0000-0000-0000-000000001005", "kind": "left"}]'));
RESET role;
SELECT ok(NOT EXISTS (SELECT 1 FROM public.user_servers WHERE server_id = 'f2760000-0000-0000-0000-0000000000a2'
                         AND user_id = 'f2760000-0000-0000-0000-000000001004'), 'already banned: the user is no longer a member');
SELECT results_eq($q$SELECT l.status, (SELECT count(*)::int FROM public.server_bans b WHERE b.server_id = l.server_id AND b.user_id = l.user_id)
                       FROM public.discord_migration_links l WHERE l.server_id = 'f2760000-0000-0000-0000-0000000000a2'
                        AND l.user_id = 'f2760000-0000-0000-0000-000000001004'$q$,
  $q$VALUES ('banned'::text, 1)$q$, 'already banned: the link is banned and there is still one ban row');
SELECT is((SELECT v -> 'skipped' -> 0 ->> 'reason' FROM out WHERE k = 'ab'), 'error', 'isolation: a bad candidate is reported as an error');
SELECT is((SELECT v ->> 'applied' FROM out WHERE k = 'ab'), '2', 'isolation: the others still apply');
SELECT is((SELECT status FROM public.discord_migration_links WHERE server_id = 'f2760000-0000-0000-0000-0000000000a2'
              AND user_id = 'f2760000-0000-0000-0000-000000001005'), 'left', 'isolation: the later candidate was removed');

-- brake_override: resuming a removal_brake pause approves those removals, once (s3: paused above) ---------
SELECT is((SELECT brake_override FROM public.discord_migrations WHERE server_id = 'f2760000-0000-0000-0000-0000000000a3'), false,
  'override: off while the brake is tripped');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_migration_set_state('f2760000-0000-0000-0000-0000000000a3', 'open');
SELECT tests.clear_authentication();
SELECT results_eq($q$SELECT sync_paused_reason IS NULL, brake_override, sync_requested_at IS NOT NULL
                       FROM public.discord_migrations WHERE server_id = 'f2760000-0000-0000-0000-0000000000a3'$q$,
  $q$VALUES (true, true, true)$q$, 'override: resuming a removal_brake pause clears it, sets the override and asks for a sync');
SET LOCAL role service_role;
INSERT INTO out VALUES ('ov', public.discord_migration_apply_removals('f2760000-0000-0000-0000-0000000000a3',
  '[{"user_id": "f2760000-0000-0000-0000-000000001011", "kind": "left"}, {"user_id": "f2760000-0000-0000-0000-000000001012", "kind": "left"},
    {"user_id": "f2760000-0000-0000-0000-000000001013", "kind": "banned"}, {"user_id": "f2760000-0000-0000-0000-000000001014", "kind": "left"}]'));
RESET role;
SELECT is((SELECT v ->> 'applied' FROM out WHERE k = 'ov'), '4', 'override: the same four removals now apply');
SELECT is((SELECT count(*)::int FROM public.user_servers WHERE server_id = 'f2760000-0000-0000-0000-0000000000a3'
              AND user_id IN ('f2760000-0000-0000-0000-000000001011', 'f2760000-0000-0000-0000-000000001012',
                              'f2760000-0000-0000-0000-000000001013', 'f2760000-0000-0000-0000-000000001014')),
  0, 'override: and the four are gone');
SELECT is((SELECT brake_override FROM public.discord_migrations WHERE server_id = 'f2760000-0000-0000-0000-0000000000a3'), false,
  'override: cleared after the pass that used it');
SET LOCAL role service_role;
INSERT INTO out VALUES ('ov2', public.discord_migration_apply_removals('f2760000-0000-0000-0000-0000000000a3',
  '[{"user_id": "f2760000-0000-0000-0000-000000001021", "kind": "left"}, {"user_id": "f2760000-0000-0000-0000-000000001022", "kind": "left"},
    {"user_id": "f2760000-0000-0000-0000-000000001023", "kind": "left"}]'));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'ov2'), '{"paused": true}'::jsonb, 'override: a later big batch trips the brake again');
SELECT is((SELECT sync_paused_reason FROM public.discord_migrations WHERE server_id = 'f2760000-0000-0000-0000-0000000000a3'),
  'removal_brake', 'override: and the pause is recorded');
-- a pause for another reason leaves the override off; a pass that finds nothing to remove also spends it
SET LOCAL role service_role;
SELECT public.discord_migration_pause('f2760000-0000-0000-0000-0000000000a3', 'token_invalid');
RESET role;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_migration_set_state('f2760000-0000-0000-0000-0000000000a3', 'open');
SELECT tests.clear_authentication();
SELECT is((SELECT brake_override FROM public.discord_migrations WHERE server_id = 'f2760000-0000-0000-0000-0000000000a3'), false,
  'override: resuming any other pause reason does not set it');
SET LOCAL role service_role;
SELECT public.discord_migration_pause('f2760000-0000-0000-0000-0000000000a3', 'removal_brake');
RESET role;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.discord_migration_set_state('f2760000-0000-0000-0000-0000000000a3', 'open');
SELECT tests.clear_authentication();
SET LOCAL role service_role;
SELECT public.discord_migration_record_sync('f2760000-0000-0000-0000-0000000000a3', '{"checked": 1}', NULL, NULL, true);
RESET role;
SELECT is((SELECT brake_override FROM public.discord_migrations WHERE server_id = 'f2760000-0000-0000-0000-0000000000a3'), false,
  'override: a completed pass with nothing to remove spends it too');

-- a claim records what it granted, so a remap takes it back (s4) -------------------------------------------
INSERT INTO public.servers (id, name, owner) VALUES
  ('f2760000-0000-0000-0000-0000000000a4', 'S4 276', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2760000-0000-0000-0000-0000000000a4', 'accepted');
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f2760000-0000-0000-0000-0000000000d1', 'f2760000-0000-0000-0000-0000000000a4', 'ModC276', 2, 8),
  ('f2760000-0000-0000-0000-0000000000d2', 'f2760000-0000-0000-0000-0000000000a4', 'HelperC276', 1, 0);
INSERT INTO public.discord_migrations (server_id, discord_guild_id, credential_source, state, opened_at) VALUES
  ('f2760000-0000-0000-0000-0000000000a4', '900000000000000279', 'instance_bot', 'open', now());
INSERT INTO public.discord_migration_discord_roles (server_id, discord_role_id, name, position, harmony_permissions) VALUES
  ('f2760000-0000-0000-0000-0000000000a4', '700000000000000011', 'D1c', 2, 0);
INSERT INTO public.discord_migration_role_map (server_id, discord_role_id, harmony_role_id) VALUES
  ('f2760000-0000-0000-0000-0000000000a4', '700000000000000011', 'f2760000-0000-0000-0000-0000000000d1');
SET LOCAL role service_role;
INSERT INTO out VALUES ('t4', public.discord_migration_create_claim('f2760000-0000-0000-0000-0000000000a4',
  '{"id":"600000000000000099","username":"malloryd"}'::jsonb, ARRAY['700000000000000011'], NULL));
RESET role;
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.discord_migration_claim(v ->> 'ticket') FROM out WHERE k = 't4';
SELECT tests.clear_authentication();
SELECT is((SELECT array_agg(sr.name) FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id AND sr.name LIKE '%C276'
            WHERE ur.server_id = 'f2760000-0000-0000-0000-0000000000a4' AND ur.user_id = '33333333-0000-0000-0000-000000000003'),
  ARRAY['ModC276'], 'claim remap: the claim grants Mod');
UPDATE public.discord_migration_role_map SET harmony_role_id = 'f2760000-0000-0000-0000-0000000000d2'
 WHERE server_id = 'f2760000-0000-0000-0000-0000000000a4';
SET LOCAL role service_role;
SELECT public.discord_migration_sync_member('f2760000-0000-0000-0000-0000000000a4',
  '33333333-0000-0000-0000-000000000003', '{"present": true, "role_ids": ["700000000000000011"]}');
RESET role;
SELECT is((SELECT array_agg(sr.name) FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id AND sr.name LIKE '%C276'
            WHERE ur.server_id = 'f2760000-0000-0000-0000-0000000000a4' AND ur.user_id = '33333333-0000-0000-0000-000000000003'),
  ARRAY['HelperC276'], 'claim remap: after D1 -> Helper the member holds Helper and Mod is gone');

SELECT * FROM finish();
ROLLBACK;
