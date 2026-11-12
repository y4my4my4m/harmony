-- "Migrate from Discord": claims, joining, Harmony moderation precedence and role application,
-- 20261112500001_discord_migration.sql.
--
--   alice   owner of s2 (and a member)
--   bob     not a member of s2 at first; Discord account U1
--   dave    not a member of s2 at first; Discord account U2; holds the ADMINISTRATOR mapping
--   mallory not a member of s2; the "carol" of the brief
--
--   s2 (open)  roles Mod (c1), Adm (c2, ADMINISTRATOR), Hand (c3, unmapped)
--              map D1 -> Mod, D2 -> Adm
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(88);

CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON out TO PUBLIC;
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2750000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave275@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f2750000-0000-0000-0000-0000000000d2', 'f2750000-0000-0000-0000-0000000000d1', 'dave275', 'Dave', true);

INSERT INTO public.servers (id, name, owner) VALUES
  ('f2750000-0000-0000-0000-0000000000a2', 'S2 275', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2750000-0000-0000-0000-0000000000a2', 'accepted');
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f2750000-0000-0000-0000-0000000000c1', 'f2750000-0000-0000-0000-0000000000a2', 'Mod275', 2, 8),
  ('f2750000-0000-0000-0000-0000000000c2', 'f2750000-0000-0000-0000-0000000000a2', 'Adm275', 3, 1),
  ('f2750000-0000-0000-0000-0000000000c3', 'f2750000-0000-0000-0000-0000000000a2', 'Hand275', 1, 0);
INSERT INTO public.discord_migrations (server_id, discord_guild_id, credential_source, state, opened_at) VALUES
  ('f2750000-0000-0000-0000-0000000000a2', '900000000000000275', 'instance_bot', 'open', now());
INSERT INTO public.discord_migration_discord_roles (server_id, discord_role_id, name, position, harmony_permissions) VALUES
  ('f2750000-0000-0000-0000-0000000000a2', '700000000000000001', 'D1', 2, 0),
  ('f2750000-0000-0000-0000-0000000000a2', '700000000000000002', 'D2', 3, 1);
INSERT INTO public.discord_migration_role_map (server_id, discord_role_id, harmony_role_id) VALUES
  ('f2750000-0000-0000-0000-0000000000a2', '700000000000000001', 'f2750000-0000-0000-0000-0000000000c1'),
  ('f2750000-0000-0000-0000-0000000000a2', '700000000000000002', 'f2750000-0000-0000-0000-0000000000c2');

-- Grants ------------------------------------------------------------------------------------------
CREATE TEMP TABLE client_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO client_fns VALUES
  ('public.discord_migration_claim(text)'), ('public.discord_migration_my_pending_claims()'),
  ('public.discord_migration_set_my_sync(uuid, text[])'), ('public.discord_migration_my_link(uuid)'),
  ('public.discord_migration_member_joined_at(uuid, uuid)'), ('public.discord_migration_allow_back(uuid, uuid)');
CREATE TEMP TABLE service_fns (fn regprocedure) ON COMMIT DROP;
INSERT INTO service_fns VALUES
  ('public.discord_migration_create_claim(uuid, jsonb, text[], timestamptz)'),
  ('public.discord_migration_bind_claim(text, uuid)'),
  ('public.discord_migration_apply_roles(uuid, uuid, text[])');
SELECT is_empty($q$SELECT fn FROM client_fns WHERE has_function_privilege('anon', fn, 'EXECUTE')
                                               OR NOT has_function_privilege('authenticated', fn, 'EXECUTE')$q$,
  'authenticated, not anon, executes the claim RPCs');
SELECT is_empty($q$SELECT fn FROM service_fns WHERE has_function_privilege('anon', fn, 'EXECUTE')
                                                OR has_function_privilege('authenticated', fn, 'EXECUTE')
                                                OR NOT has_function_privilege('service_role', fn, 'EXECUTE')$q$,
  'only service_role executes the gateway functions');

-- claim_happy_path ----------------------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('t1', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000001","username":"bobd","global_name":"Bob D","avatar_url":"https://cdn.example/a.png"}'::jsonb,
  ARRAY['700000000000000001', '700000000000000009'], '2020-01-02 03:04:05+00'));
RESET role;
SELECT is((SELECT length(v ->> 'ticket') FROM out WHERE k = 't1'), 64, 'create_claim returns a 64-hex ticket');
SELECT ok((SELECT expires_at > now() + interval '6 days 23 hours' AND expires_at < now() + interval '7 days 1 hour'
             FROM public.discord_migration_claims WHERE ticket = (SELECT v ->> 'ticket' FROM out WHERE k = 't1')),
  'the ticket lives seven days');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO out SELECT 'r1', public.discord_migration_claim(v ->> 'ticket') FROM out WHERE k = 't1';
SELECT tests.clear_authentication();
SELECT is((SELECT v ->> 'server_id' FROM out WHERE k = 'r1'), 'f2750000-0000-0000-0000-0000000000a2', 'claim returns the server');
SELECT is((SELECT v -> 'roles_granted' FROM out WHERE k = 'r1'), '["Mod275"]'::jsonb, 'claim reports the granted role names');
SELECT is((SELECT status FROM public.user_servers WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND user_id = '22222222-0000-0000-0000-000000000002'), 'accepted', 'bob joined as an accepted member');
SELECT is((SELECT count(*)::int FROM public.server_membership_events WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND user_id = '22222222-0000-0000-0000-000000000002' AND event_type = 'join'), 1, 'the join wrote a membership event');
SELECT is((SELECT array_agg(sr.name) FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id
            WHERE ur.server_id = 'f2750000-0000-0000-0000-0000000000a2' AND ur.user_id = '22222222-0000-0000-0000-000000000002'
              AND sr.name LIKE '%275'),
  ARRAY['Mod275'], 'bob holds the mapped role only');
SELECT results_eq($q$SELECT status, discord_user_id, discord_role_ids, discord_joined_at
                       FROM public.discord_migration_links
                      WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2' AND user_id = '22222222-0000-0000-0000-000000000002'$q$,
  $q$VALUES ('active'::text, '600000000000000001'::text, ARRAY['700000000000000001', '700000000000000009'], '2020-01-02 03:04:05+00'::timestamptz)$q$,
  'the link keeps all Discord role ids and the join date');
SELECT is((SELECT count(*)::int FROM public.discord_migration_claims WHERE ticket = (SELECT v ->> 'ticket' FROM out WHERE k = 't1')),
  0, 'the claim row is gone');
SELECT is((SELECT count(*)::int FROM public.server_audit_log WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND action = 'member.role_add' AND target_id = '22222222-0000-0000-0000-000000000002'
              AND source = 'system' AND details ->> 'via' = 'discord_migration' AND details ->> 'role_name' = 'Mod275'),
  1, 'one system audit row names the migration');
SELECT is((SELECT count(*)::int FROM public.server_audit_log WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND action = 'member.role_add' AND target_id = '22222222-0000-0000-0000-000000000002'),
  1, 'and the generic role trigger wrote no second one');
SELECT ok((SELECT NOT (details ? 'administrator') FROM public.server_audit_log
            WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2' AND action = 'member.role_add'
              AND target_id = '22222222-0000-0000-0000-000000000002'),
  'a non-administrator grant carries no administrator flag');

-- Idempotent re-claim by the same user with the same Discord id.
SET LOCAL role service_role;
INSERT INTO out VALUES ('t1b', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000001","username":"bobd"}'::jsonb, ARRAY['700000000000000001'], '2020-01-02 03:04:05+00'));
RESET role;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(format($q$SELECT public.discord_migration_claim(%L)$q$, (SELECT v ->> 'ticket' FROM out WHERE k = 't1b')),
  're-claiming as the same user with the same Discord id succeeds');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.discord_migration_links WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND user_id = '22222222-0000-0000-0000-000000000002'), 1, 'and keeps one link');
SELECT is((SELECT count(*)::int FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id WHERE sr.name LIKE '%275' AND ur.server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND user_id = '22222222-0000-0000-0000-000000000002'), 1, 'and one role');

-- A claim asks for a fresh Discord check: the link is marked unsynced, and a ticket older than 15 minutes also
-- asks for a sync now (its recorded roles may be stale).
UPDATE public.discord_migration_links SET last_synced_at = now()
 WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2' AND user_id = '22222222-0000-0000-0000-000000000002';
SET LOCAL role service_role;
INSERT INTO out VALUES ('t1c', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000001","username":"bobd"}'::jsonb, ARRAY['700000000000000001'], NULL));
RESET role;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.discord_migration_claim(v ->> 'ticket') FROM out WHERE k = 't1c';
SELECT tests.clear_authentication();
SELECT ok((SELECT last_synced_at IS NULL FROM public.discord_migration_links
            WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2' AND user_id = '22222222-0000-0000-0000-000000000002'),
  'a claim clears last_synced_at so the link is synced first');
SELECT ok((SELECT sync_requested_at IS NULL FROM public.discord_migrations WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'),
  'a fresh ticket does not ask for a sync');
SET LOCAL role service_role;
INSERT INTO out VALUES ('t1d', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000001","username":"bobd"}'::jsonb, ARRAY['700000000000000001'], NULL));
RESET role;
UPDATE public.discord_migration_claims SET created_at = now() - interval '16 minutes'
 WHERE ticket = (SELECT v ->> 'ticket' FROM out WHERE k = 't1d');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.discord_migration_claim(v ->> 'ticket') FROM out WHERE k = 't1d';
SELECT tests.clear_authentication();
SELECT ok((SELECT sync_requested_at > now() - interval '1 minute' FROM public.discord_migrations
            WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'), 'a ticket older than 15 minutes asks for a sync now');
SELECT ok((SELECT last_synced_at IS NULL FROM public.discord_migration_links
            WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2' AND user_id = '22222222-0000-0000-0000-000000000002'),
  'and the link stays unsynced');
UPDATE public.discord_migrations SET sync_requested_at = NULL WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2';

-- Administrator mapping notifies the owner ---------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('t2', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000002","username":"daved"}'::jsonb, ARRAY['700000000000000002'], NULL));
RESET role;
SELECT tests.authenticate_as('f2750000-0000-0000-0000-0000000000d1');
INSERT INTO out SELECT 'r2', public.discord_migration_claim(v ->> 'ticket') FROM out WHERE k = 't2';
SELECT tests.clear_authentication();
SELECT is((SELECT v -> 'roles_granted' FROM out WHERE k = 'r2'), '["Adm275"]'::jsonb, 'dave is granted the Administrator-bearing role');
SELECT results_eq($q$SELECT n.data #>> '{role,name}', n.data ->> 'change', n.data #>> '{user,username}', n.data #>> '{server,name}'
                       FROM public.notifications n
                      WHERE n.user_id = '11111111-0000-0000-0000-000000000001' AND n.type = 'discord_migration_admin_change'$q$,
  $q$VALUES ('Adm275'::text, 'granted'::text, 'dave275'::text, 'S2 275'::text)$q$,
  'the server owner is notified of the Administrator grant');
SELECT ok((SELECT details ->> 'administrator' = 'true' FROM public.server_audit_log
            WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2' AND action = 'member.role_add'
              AND target_id = 'f2750000-0000-0000-0000-0000000000d2' AND details ->> 'role_name' = 'Adm275'),
  'and the audit row is flagged administrator');

-- apply_roles: the role diff, hand-granted roles, unmapped roles and the owner ------------------------
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f2750000-0000-0000-0000-0000000000d2', 'f2750000-0000-0000-0000-0000000000c1', 'f2750000-0000-0000-0000-0000000000a2'),
  ('f2750000-0000-0000-0000-0000000000d2', 'f2750000-0000-0000-0000-0000000000c3', 'f2750000-0000-0000-0000-0000000000a2');
SET LOCAL role service_role;
INSERT INTO out VALUES ('ap1', public.discord_migration_apply_roles('f2750000-0000-0000-0000-0000000000a2',
  'f2750000-0000-0000-0000-0000000000d2', ARRAY['700000000000000002']));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'ap1'),
  jsonb_build_object('added', '[]'::jsonb, 'removed', jsonb_build_array('f2750000-0000-0000-0000-0000000000c1')),
  'apply_roles removes a hand-granted mapped role that is not in the target');
SELECT is((SELECT array_agg(sr.name ORDER BY sr.name) FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id
            WHERE ur.user_id = 'f2750000-0000-0000-0000-0000000000d2' AND sr.name LIKE '%275'),
  ARRAY['Adm275', 'Hand275'], 'the unmapped role stays');
SET LOCAL role service_role;
INSERT INTO out VALUES ('ap2', public.discord_migration_apply_roles('f2750000-0000-0000-0000-0000000000a2',
  'f2750000-0000-0000-0000-0000000000d2', ARRAY[]::text[]));
RESET role;
SELECT is((SELECT v -> 'removed' FROM out WHERE k = 'ap2'), jsonb_build_array('f2750000-0000-0000-0000-0000000000c2'),
  'an empty target removes the Administrator-bearing role');
SELECT results_eq($q$SELECT n.data ->> 'change' FROM public.notifications n
                      WHERE n.user_id = '11111111-0000-0000-0000-000000000001' AND n.type = 'discord_migration_admin_change'
                      ORDER BY n.created_at, n.data ->> 'change'$q$,
  $q$VALUES ('granted'::text), ('removed'::text)$q$, 'the removal notifies the owner too');
SELECT ok((SELECT details ->> 'administrator' = 'true' AND source = 'system' AND details ->> 'via' = 'discord_migration'
             FROM public.server_audit_log WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND action = 'member.role_remove' AND target_id = 'f2750000-0000-0000-0000-0000000000d2'
              AND details ->> 'role_name' = 'Adm275'),
  'the removal audit row is a flagged system row');
SET LOCAL role service_role;
INSERT INTO out VALUES ('ap3', public.discord_migration_apply_roles('f2750000-0000-0000-0000-0000000000a2',
  '11111111-0000-0000-0000-000000000001', ARRAY['700000000000000001', '700000000000000002']));
RESET role;
SELECT is((SELECT jsonb_array_length(v -> 'added') FROM out WHERE k = 'ap3'), 2, 'apply_roles adds the owner''s mapped roles');
SELECT is((SELECT v -> 'removed' FROM out WHERE k = 'ap3'), '[]'::jsonb, 'and removes nothing');
SELECT is((SELECT count(*)::int FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id WHERE sr.name LIKE '%275' AND ur.user_id = '11111111-0000-0000-0000-000000000001'
              AND ur.server_id = 'f2750000-0000-0000-0000-0000000000a2'), 2, 'the owner holds both');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.discord_migration_apply_roles('f2750000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002', '{}')$q$,
  '42501', NULL, 'a client cannot apply roles');
SELECT throws_ok($q$SELECT public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2', '{"id":"600000000000000003"}', '{}', NULL)$q$,
  '42501', NULL, 'a client cannot create claims');
SELECT throws_ok($q$SELECT public.discord_migration_bind_claim('00', 'bbbbbbbb-0000-0000-0000-000000000002')$q$,
  '42501', NULL, 'a client cannot bind claims');
SELECT tests.clear_authentication();

-- claim_respects_harmony_moderation -------------------------------------------------------------------
DELETE FROM public.user_servers WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
   AND user_id = '22222222-0000-0000-0000-000000000002';
INSERT INTO public.server_bans (server_id, user_id) VALUES
  ('f2750000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002');
SET LOCAL role service_role;
INSERT INTO out VALUES ('t3', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000001","username":"bobd"}'::jsonb, ARRAY['700000000000000001'], NULL));
RESET role;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format($q$SELECT public.discord_migration_claim(%L)$q$, (SELECT v ->> 'ticket' FROM out WHERE k = 't3')),
  'P0001', 'HARMONY_BANNED', 'a Harmony ban refuses the claim');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.user_servers WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND user_id = '22222222-0000-0000-0000-000000000002'), 0, 'and creates no membership');
SELECT is((SELECT count(*)::int FROM public.discord_migration_claims WHERE ticket = (SELECT v ->> 'ticket' FROM out WHERE k = 't3')),
  1, 'the refused ticket is kept');
DELETE FROM public.server_bans WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
   AND user_id = '22222222-0000-0000-0000-000000000002';

-- A banned membership row counts as a ban too (fixture user "banned").
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('44444444-0000-0000-0000-000000000004', 'f2750000-0000-0000-0000-0000000000a2', 'banned');
SET LOCAL role service_role;
INSERT INTO out VALUES ('t4', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000004","username":"bannedd"}'::jsonb, ARRAY['700000000000000001'], NULL));
RESET role;
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok(format($q$SELECT public.discord_migration_claim(%L)$q$, (SELECT v ->> 'ticket' FROM out WHERE k = 't4')),
  'P0001', 'HARMONY_BANNED', 'a banned membership row refuses the claim');
SELECT tests.clear_authentication();
SELECT is((SELECT status FROM public.user_servers WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND user_id = '44444444-0000-0000-0000-000000000004'), 'banned', 'and the ban stays');

-- Bob claims again (ban lifted), then alice kicks him.
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(format($q$SELECT public.discord_migration_claim(%L)$q$, (SELECT v ->> 'ticket' FROM out WHERE k = 't3')),
  'with the ban lifted the claim succeeds');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.kick_server_member('f2750000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002')$q$,
  'an admin kicks bob on Harmony');
SELECT tests.clear_authentication();
SELECT is((SELECT status FROM public.discord_migration_links WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND user_id = '22222222-0000-0000-0000-000000000002'), 'kicked_on_harmony', 'the kick marks the link kicked_on_harmony');

SET LOCAL role service_role;
INSERT INTO out VALUES ('t5', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000001","username":"bobd"}'::jsonb, ARRAY['700000000000000001'], NULL));
RESET role;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format($q$SELECT public.discord_migration_claim(%L)$q$, (SELECT v ->> 'ticket' FROM out WHERE k = 't5')),
  'P0001', 'KICKED_ON_HARMONY', 'a kicked member cannot claim back in');
SELECT throws_ok($q$SELECT public.discord_migration_allow_back('f2750000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002')$q$,
  '42501', NULL, 'a member cannot allow themselves back');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.user_servers WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND user_id = '22222222-0000-0000-0000-000000000002'), 0, 'and creates no membership');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.discord_migration_allow_back('f2750000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002')$q$,
  'a manager allows the member back');
SELECT tests.clear_authentication();
SELECT is((SELECT status FROM public.discord_migration_links WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND user_id = '22222222-0000-0000-0000-000000000002'), 'left', 'the link becomes left');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(format($q$SELECT public.discord_migration_claim(%L)$q$, (SELECT v ->> 'ticket' FROM out WHERE k = 't5')),
  'and the claim succeeds');
SELECT tests.clear_authentication();
SELECT ok((SELECT l.status = 'active' AND EXISTS (SELECT 1 FROM public.user_servers us WHERE us.server_id = l.server_id
                  AND us.user_id = l.user_id AND us.status = 'accepted')
             FROM public.discord_migration_links l WHERE l.server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND l.user_id = '22222222-0000-0000-0000-000000000002'),
  'bob is active and a member again');

-- A kick the migration itself makes leaves the link alone.
SELECT set_config('harmony.via', 'discord_migration', true);
INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
VALUES ('f2750000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002', 'kick', '{}'::jsonb);
SELECT set_config('harmony.via', '', true);
SELECT is((SELECT status FROM public.discord_migration_links WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND user_id = '22222222-0000-0000-0000-000000000002'), 'active', 'a kick written by the migration does not mark the link');

-- claim_conflicts ------------------------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('t6', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000001","username":"bobd"}'::jsonb, ARRAY['700000000000000002'], NULL));
INSERT INTO out VALUES ('t7', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000005","username":"otherd"}'::jsonb, ARRAY['700000000000000002'], NULL));
RESET role;
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(format($q$SELECT public.discord_migration_claim(%L)$q$, (SELECT v ->> 'ticket' FROM out WHERE k = 't6')),
  'P0001', 'DISCORD_ACCOUNT_TAKEN', 'another user cannot claim bob''s Discord id');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format($q$SELECT public.discord_migration_claim(%L)$q$, (SELECT v ->> 'ticket' FROM out WHERE k = 't7')),
  'P0001', 'ALREADY_LINKED_OTHER_DISCORD', 'bob cannot claim with a different Discord id');
SELECT tests.clear_authentication();
SELECT results_eq($q$SELECT discord_user_id, discord_role_ids, status FROM public.discord_migration_links
                      WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2' AND user_id = '22222222-0000-0000-0000-000000000002'$q$,
  $q$VALUES ('600000000000000001'::text, ARRAY['700000000000000001'], 'active'::text)$q$, 'bob''s link is unchanged');
SELECT is((SELECT count(*)::int FROM public.discord_migration_links WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND user_id = '33333333-0000-0000-0000-000000000003'), 0, 'and mallory has no link');

-- create_claim refusals --------------------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('e1', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  jsonb_build_object('id', '600000000000000001', 'harmony_user_id', '33333333-0000-0000-0000-000000000003'), '{}', NULL));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'e1'), '{"error":"ALREADY_LINKED_ELSEWHERE"}'::jsonb,
  'a Discord id linked to another signed-in account is refused up front');
INSERT INTO public.discord_migration_links (server_id, user_id, discord_user_id, status) VALUES
  ('f2750000-0000-0000-0000-0000000000a2', '44444444-0000-0000-0000-000000000004', '600000000000000008', 'banned');
SET LOCAL role service_role;
INSERT INTO out VALUES ('e2', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000008"}'::jsonb, '{}', NULL));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'e2'), '{"error":"DISCORD_BANNED_HERE"}'::jsonb, 'a Discord-banned account gets no ticket');
SET LOCAL role service_role;
SELECT throws_ok($q$SELECT public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2', '{"id":"abc"}', '{}', NULL)$q$,
  '22023', NULL, 'a Discord id that is not a snowflake is refused');
SELECT throws_ok($q$SELECT public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2', '{"id":"600000000000000006"}', '{x}', NULL)$q$,
  '22023', NULL, 'a role id that is not a snowflake is refused');
RESET role;

-- ticket_expiry_and_retry ------------------------------------------------------------------------------
SET LOCAL role service_role;
INSERT INTO out VALUES ('t8', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000006","username":"expd"}'::jsonb, '{}', NULL));
RESET role;
UPDATE public.discord_migration_claims SET expires_at = now() - interval '1 minute'
 WHERE ticket = (SELECT v ->> 'ticket' FROM out WHERE k = 't8');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(format($q$SELECT public.discord_migration_claim(%L)$q$, (SELECT v ->> 'ticket' FROM out WHERE k = 't8')),
  'P0001', 'TICKET_EXPIRED', 'an expired ticket is refused');
SELECT throws_ok($q$SELECT public.discord_migration_claim('nope')$q$, 'P0001', 'TICKET_EXPIRED', 'so is an unknown ticket');
SELECT tests.clear_authentication();
SET LOCAL role service_role;
INSERT INTO out VALUES ('t9', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000006","username":"expd"}'::jsonb, '{}', NULL));
RESET role;
SELECT ok((SELECT length(v ->> 'ticket') = 64 FROM out WHERE k = 't9'), 'a fresh create_claim for the same Discord id succeeds');
SELECT is((SELECT count(*)::int FROM public.discord_migration_claims WHERE ticket = (SELECT v ->> 'ticket' FROM out WHERE k = 't8')),
  0, 'and purged the expired claim');

-- Binding: a ticket bound to bob is for bob only; the pending list holds only his unexpired tickets.
SET LOCAL role service_role;
SELECT public.discord_migration_bind_claim((SELECT v ->> 'ticket' FROM out WHERE k = 't9'), 'bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format($q$SELECT public.discord_migration_bind_claim(%L, 'cccccccc-0000-0000-0000-000000000003')$q$,
  (SELECT v ->> 'ticket' FROM out WHERE k = 't9')), 'P0001', 'TICKET_EXPIRED', 'a bound ticket cannot be rebound');
INSERT INTO out VALUES ('t10', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000007"}'::jsonb, '{}', NULL));
INSERT INTO out VALUES ('t11', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000010"}'::jsonb, '{}', NULL));
SELECT public.discord_migration_bind_claim((SELECT v ->> 'ticket' FROM out WHERE k = 't10'), 'bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.discord_migration_bind_claim((SELECT v ->> 'ticket' FROM out WHERE k = 't11'), 'cccccccc-0000-0000-0000-000000000003');
RESET role;
UPDATE public.discord_migration_claims SET expires_at = now() - interval '1 minute'
 WHERE ticket = (SELECT v ->> 'ticket' FROM out WHERE k = 't10');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
INSERT INTO out SELECT 'pend', public.discord_migration_my_pending_claims();
SELECT tests.clear_authentication();
SELECT is((SELECT jsonb_array_length(v) FROM out WHERE k = 'pend'), 1, 'my_pending_claims lists one ticket');
SELECT is((SELECT v -> 0 ->> 'ticket' FROM out WHERE k = 'pend'), (SELECT v ->> 'ticket' FROM out WHERE k = 't9'),
  'the caller''s own unexpired one');
SELECT is((SELECT v -> 0 ->> 'server_name' FROM out WHERE k = 'pend'), 'S2 275', 'with the server name');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format($q$SELECT public.discord_migration_claim(%L)$q$, (SELECT v ->> 'ticket' FROM out WHERE k = 't11')),
  '42501', NULL, 'a ticket bound to another auth user is refused');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.discord_migration_claims WHERE ticket = (SELECT v ->> 'ticket' FROM out WHERE k = 't11')),
  1, 'and stays for its owner');

-- set_my_sync ---------------------------------------------------------------------------------------------
UPDATE public.discord_migration_links SET last_synced_at = now()
 WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2' AND user_id = '22222222-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT public.discord_migration_set_my_sync('f2750000-0000-0000-0000-0000000000a2', '{avatar,server_nickname}')$q$,
  'bob sets his sync fields');
SELECT throws_ok($q$SELECT public.discord_migration_set_my_sync('f2750000-0000-0000-0000-0000000000a2', '{nickname}')$q$,
  '22023', NULL, 'a field outside the seven raises');
INSERT INTO out SELECT 'mylink', public.discord_migration_my_link('f2750000-0000-0000-0000-0000000000a2');
SELECT tests.clear_authentication();
SELECT results_eq($q$SELECT sync_fields, last_synced_at IS NULL FROM public.discord_migration_links
                      WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2' AND user_id = '22222222-0000-0000-0000-000000000002'$q$,
  $q$VALUES (ARRAY['avatar', 'server_nickname'], true)$q$, 'the fields are stored and last_synced_at is cleared');
SELECT is((SELECT v ->> 'status' FROM out WHERE k = 'mylink'), 'active', 'my_link returns the status');
SELECT is((SELECT v -> 'sync_fields' FROM out WHERE k = 'mylink'), '["avatar","server_nickname"]'::jsonb, 'and the sync fields');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.discord_migration_set_my_sync('f2750000-0000-0000-0000-0000000000a2', '{banner}')$q$,
  'P0002', NULL, 'mallory has no link to set');
SELECT is(public.discord_migration_my_link('f2750000-0000-0000-0000-0000000000a2'), NULL, 'and my_link is null for her');
SELECT tests.clear_authentication();
SELECT is((SELECT sync_fields FROM public.discord_migration_links WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
              AND user_id = '22222222-0000-0000-0000-000000000002'), ARRAY['avatar', 'server_nickname'], 'bob''s link is untouched by her');

-- member_joined_at ----------------------------------------------------------------------------------------
SELECT tests.authenticate_as('f2750000-0000-0000-0000-0000000000d1');
SELECT is(public.discord_migration_member_joined_at('f2750000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002'),
  '2020-01-02 03:04:05+00'::timestamptz, 'a member reads bob''s Discord join date');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.discord_migration_member_joined_at('f2750000-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-000000000002'),
  NULL, 'a non-member gets null');
SELECT tests.clear_authentication();

-- The join still passes the join rate limit -------------------------------------------------------------------
DELETE FROM public.user_servers WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
   AND user_id = '22222222-0000-0000-0000-000000000002';
UPDATE public.discord_migration_links SET status = 'left' WHERE server_id = 'f2750000-0000-0000-0000-0000000000a2'
   AND user_id = '22222222-0000-0000-0000-000000000002';
UPDATE public.instance_config SET config_value = config_value || '{"account_joins_per_hour": 1}'::jsonb WHERE config_key = 'antispam';
SET LOCAL role service_role;
INSERT INTO out VALUES ('t12', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000001"}'::jsonb, '{}', NULL));
RESET role;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_like(format($q$SELECT public.discord_migration_claim(%L)$q$, (SELECT v ->> 'ticket' FROM out WHERE k = 't12')),
  'ANTISPAM_RATE_LIMITED:%', 'a claim counts toward the join rate limit');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = config_value || '{"account_joins_per_hour": 0}'::jsonb WHERE config_key = 'antispam';

-- claim_closed ------------------------------------------------------------------------------------------------
-- preview: the public landing page reads the server's name and icon by link token, only while open.
INSERT INTO out SELECT 'tok', to_jsonb(m.link_token) FROM public.discord_migrations m
 WHERE m.server_id = 'f2750000-0000-0000-0000-0000000000a2';
SET LOCAL role anon;
SELECT is(public.discord_migration_preview((SELECT v #>> '{}' FROM out WHERE k = 'tok')) ->> 'server_name',
  'S2 275', 'preview names the server of an open migration, for anon');
SELECT is(public.discord_migration_preview((SELECT v #>> '{}' FROM out WHERE k = 'tok')) ->> 'server_id',
  'f2750000-0000-0000-0000-0000000000a2', 'preview carries the server id');
SELECT is(public.discord_migration_preview('0000'), NULL, 'preview of an unknown token is null');
RESET role;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.discord_migration_set_state('f2750000-0000-0000-0000-0000000000a2', 'finished')$q$,
  'the owner finishes the migration');
SELECT tests.clear_authentication();
SET LOCAL role service_role;
INSERT INTO out VALUES ('c1', public.discord_migration_create_claim('f2750000-0000-0000-0000-0000000000a2',
  '{"id":"600000000000000011"}'::jsonb, '{}', NULL));
RESET role;
SELECT is((SELECT v FROM out WHERE k = 'c1'), '{"error":"MIGRATION_CLOSED"}'::jsonb, 'a finished migration takes no claims');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format($q$SELECT public.discord_migration_claim(%L)$q$, (SELECT v ->> 'ticket' FROM out WHERE k = 't12')),
  'P0001', 'MIGRATION_CLOSED', 'and a ticket issued earlier no longer claims');
SELECT tests.clear_authentication();
SELECT is((SELECT public.discord_migration_preview(m.link_token) FROM public.discord_migrations m
             WHERE m.server_id = 'f2750000-0000-0000-0000-0000000000a2'), NULL, 'preview is null for a finished migration');
SELECT is((SELECT public.discord_migration_preview(m.link_token) ->> 'server_name' FROM public.discord_migrations m
             WHERE m.server_id = 'f2750000-0000-0000-0000-0000000000a2'), NULL, 'and carries no server name');

SELECT * FROM finish();
ROLLBACK;
