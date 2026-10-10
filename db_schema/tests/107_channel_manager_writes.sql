-- Channel and category writes after 20261010400001_channel_manager_writes.sql.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not.
-- Added: carol, a member with a role holding ADMINISTRATOR.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(16);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1070000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol107@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f1070000-0000-0000-0000-0000000000c1', 'f1070000-0000-0000-0000-0000000000a1', 'carol107', 'Carol', true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1070000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted');

-- Bit 2 is MANAGE_CHANNELS, bit 0 ADMINISTRATOR.
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1071000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'channel managers', 2, 4),
  ('f1071000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'admins', 3, 1);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f1070000-0000-0000-0000-0000000000c1', 'f1071000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');

INSERT INTO public.channel_categories (id, server_id, name) VALUES
  ('f1072000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'stale'),
  ('f1072000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'old');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1073000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'stats-1', 1),
  ('f1073000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'stats-2', 1),
  ('f1073000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'stats-3', 1);

-- A member without MANAGE_CHANNELS -------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
DELETE FROM public.channels WHERE id = 'f1073000-0000-0000-0000-000000000001';
DELETE FROM public.channel_categories WHERE id = 'f1072000-0000-0000-0000-000000000001';
UPDATE public.channels SET name = 'renamed' WHERE id = 'f1073000-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();
SELECT ok(EXISTS (SELECT 1 FROM public.channels WHERE id = 'f1073000-0000-0000-0000-000000000001' AND name = 'stats-1'),
    'a member without MANAGE_CHANNELS deletes and renames no channel');
SELECT ok(EXISTS (SELECT 1 FROM public.channel_categories WHERE id = 'f1072000-0000-0000-0000-000000000001'),
    'a member without MANAGE_CHANNELS deletes no category');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$INSERT INTO public.channels (server_id, name, type) VALUES ('55555555-0000-0000-0000-000000000005', 'nope', 0)$q$,
    '42501', NULL, 'a member without MANAGE_CHANNELS creates no channel');
SELECT throws_ok(
    $q$INSERT INTO public.channel_categories (server_id, name) VALUES ('55555555-0000-0000-0000-000000000005', 'nope')$q$,
    '42501', NULL, 'a member without MANAGE_CHANNELS creates no category');
SELECT tests.clear_authentication();

-- MANAGE_CHANNELS through a role -----------------------------------------------------------
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', 'f1071000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$INSERT INTO public.channels (id, server_id, name, type)
       VALUES ('f1073000-0000-0000-0000-000000000009', '55555555-0000-0000-0000-000000000005', 'made-by-bob', 0)$q$,
    'a channel manager creates a channel');
SELECT lives_ok(
    $q$INSERT INTO public.channel_categories (id, server_id, name)
       VALUES ('f1072000-0000-0000-0000-000000000009', '55555555-0000-0000-0000-000000000005', 'bobs')$q$,
    'a channel manager creates a category');
UPDATE public.channels SET name = 'renamed' WHERE id = 'f1073000-0000-0000-0000-000000000001';
DELETE FROM public.channels WHERE id = 'f1073000-0000-0000-0000-000000000002';
DELETE FROM public.channel_categories WHERE id = 'f1072000-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();
SELECT is((SELECT name FROM public.channels WHERE id = 'f1073000-0000-0000-0000-000000000001'),
    'renamed', 'a channel manager renames a channel');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.channels WHERE id = 'f1073000-0000-0000-0000-000000000002'),
    'a channel manager deletes a channel');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.channel_categories WHERE id = 'f1072000-0000-0000-0000-000000000001'),
    'a channel manager deletes a category');

-- A channel override denying MANAGE_CHANNELS -----------------------------------------------
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
VALUES ('f1073000-0000-0000-0000-000000000003', 'role', 'f1071000-0000-0000-0000-000000000001', NULL, 0, 4);
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
DELETE FROM public.channels WHERE id = 'f1073000-0000-0000-0000-000000000003';
SELECT tests.clear_authentication();
SELECT ok(EXISTS (SELECT 1 FROM public.channels WHERE id = 'f1073000-0000-0000-0000-000000000003'),
    'an override denying MANAGE_CHANNELS on the channel keeps it');

-- ADMINISTRATOR ----------------------------------------------------------------------------
SELECT tests.authenticate_as('f1070000-0000-0000-0000-0000000000a1');
DELETE FROM public.channels WHERE id = 'f1073000-0000-0000-0000-000000000001';
DELETE FROM public.channel_categories WHERE id = 'f1072000-0000-0000-0000-000000000002';
SELECT tests.clear_authentication();
SELECT ok(NOT EXISTS (SELECT 1 FROM public.channels WHERE id = 'f1073000-0000-0000-0000-000000000001'),
    'an administrator deletes a channel');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.channel_categories WHERE id = 'f1072000-0000-0000-0000-000000000002'),
    'an administrator deletes a category');

-- Owner, non-member, anon ------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
DELETE FROM public.channels WHERE id = 'f1073000-0000-0000-0000-000000000009';
SELECT tests.clear_authentication();
SELECT ok(EXISTS (SELECT 1 FROM public.channels WHERE id = 'f1073000-0000-0000-0000-000000000009'),
    'a non-member deletes no channel');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$INSERT INTO public.channel_categories (server_id, name) VALUES ('55555555-0000-0000-0000-000000000005', 'anon')$q$,
    '42501', NULL, 'anon creates no category');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
DELETE FROM public.channels WHERE id = 'f1073000-0000-0000-0000-000000000009';
DELETE FROM public.channel_categories WHERE id = 'f1072000-0000-0000-0000-000000000009';
SELECT tests.clear_authentication();
SELECT ok(NOT EXISTS (SELECT 1 FROM public.channels WHERE id = 'f1073000-0000-0000-0000-000000000009'),
    'the owner deletes a channel');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.channel_categories WHERE id = 'f1072000-0000-0000-0000-000000000009'),
    'the owner deletes a category');

SELECT * FROM finish();
ROLLBACK;
