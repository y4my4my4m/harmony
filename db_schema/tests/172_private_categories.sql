-- 20261026200001_private_categories.sql: category permission templates, synced channels, and
-- category rows for those who see a channel in them.
--
-- Fixture server_1: alice owns it, bob is a member without permissions, mallory is no member,
-- banned holds a banned row. Added:
--   carol172   role mods172 (MANAGE_CHANNELS)
--   dave172    role staff172 (no bit)
--   rm172      remote member (remote.test) holding staff172
--   rb172      remote member (blind.test) without it
--   kE         empty category 'Empty 172'
--   kS         category 'Staff 172' with channel s1 (s172-a) and s2 (s172-b)
--   kO         category 'Open 172' with channel o1 (o172)

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(62);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1720000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol172@test.local'),
  ('f1720000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave172@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f1720000-0000-0000-0000-0000000000c1', 'f1720000-0000-0000-0000-0000000000a1', 'carol172', 'Carol', true),
  ('f1720000-0000-0000-0000-0000000000c2', 'f1720000-0000-0000-0000-0000000000a2', 'dave172', 'Dave', true);
INSERT INTO public.profiles (id, username, display_name, domain, federated_id, shared_inbox_url, is_local) VALUES
  ('f1720000-0000-0000-0000-0000000000c3', 'rm172', 'rm172', 'remote.test',
   'https://remote.test/users/rm172', 'https://remote.test/inbox', false),
  ('f1720000-0000-0000-0000-0000000000c4', 'rb172', 'rb172', 'blind.test',
   'https://blind.test/users/rb172', 'https://blind.test/inbox', false);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1720000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1720000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1720000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('f1720000-0000-0000-0000-0000000000c4', '55555555-0000-0000-0000-000000000005', 'accepted');
UPDATE public.servers SET federation_enabled = true WHERE id = '55555555-0000-0000-0000-000000000005';

-- Bit 2 is MANAGE_CHANNELS.
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1721000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'mods172', 3, 4),
  ('f1721000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'staff172', 2, 0),
  ('f1721000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'extra172', 1, 0);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f1720000-0000-0000-0000-0000000000c1', 'f1721000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  ('f1720000-0000-0000-0000-0000000000c2', 'f1721000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005'),
  ('f1720000-0000-0000-0000-0000000000c3', 'f1721000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005');

SELECT set_config('tests.everyone172',
                  (SELECT id::text FROM public.server_roles
                    WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), true);

INSERT INTO public.channel_categories (id, server_id, name, "order") VALUES
  ('f1722000-0000-0000-0000-0000000000e1', '55555555-0000-0000-0000-000000000005', 'Empty 172', 10),
  ('f1722000-0000-0000-0000-0000000000e2', '55555555-0000-0000-0000-000000000005', 'Staff 172', 11),
  ('f1722000-0000-0000-0000-0000000000e3', '55555555-0000-0000-0000-000000000005', 'Open 172', 12);
INSERT INTO public.channels (id, server_id, name, type, category) VALUES
  ('f1723000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 's172-a', 0, 'f1722000-0000-0000-0000-0000000000e2'),
  ('f1723000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 's172-b', 0, 'f1722000-0000-0000-0000-0000000000e2'),
  ('f1723000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'o172', 0, 'f1722000-0000-0000-0000-0000000000e3');

CREATE TEMP TABLE made (k text PRIMARY KEY, id uuid);
GRANT ALL ON made TO authenticated;

CREATE FUNCTION pg_temp.cats(p_auth uuid) RETURNS text[] LANGUAGE plpgsql AS $fn$
DECLARE
    v text[];
BEGIN
    PERFORM tests.authenticate_as(p_auth);
    SELECT COALESCE(array_agg(name ORDER BY name), '{}') INTO v
      FROM public.channel_categories WHERE name LIKE '% 172';
    PERFORM tests.clear_authentication();
    RETURN v;
END;
$fn$;

-- The channel's overrides as role:allow/deny, @everyone first.
CREATE FUNCTION pg_temp.ovr(p_channel uuid) RETURNS text LANGUAGE sql AS $fn$
    SELECT string_agg(CASE WHEN r.is_default THEN 'everyone' ELSE r.name END
                      || ':' || o.allow_permissions || '/' || o.deny_permissions, ' '
                      ORDER BY r.is_default DESC, r.name)
      FROM public.channel_permission_overrides o JOIN public.server_roles r ON r.id = o.role_id
     WHERE o.channel_id = p_channel;
$fn$;

CREATE FUNCTION pg_temp.private_staff() RETURNS jsonb LANGUAGE sql AS $fn$
    SELECT jsonb_build_array(
        jsonb_build_object('target_type', 'role', 'role_id', current_setting('tests.everyone172'),
                           'allow_permissions', 0, 'deny_permissions', 2),
        jsonb_build_object('target_type', 'role', 'role_id', 'f1721000-0000-0000-0000-000000000002',
                           'allow_permissions', '2', 'deny_permissions', 0));
$fn$;

-- Header visibility ---------------------------------------------------------------------------

INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT c.id, 'role', current_setting('tests.everyone172')::uuid, 0, 2
  FROM public.channels c WHERE c.category = 'f1722000-0000-0000-0000-0000000000e2';
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT c.id, 'role', 'f1721000-0000-0000-0000-000000000002', 2, 0
  FROM public.channels c WHERE c.category = 'f1722000-0000-0000-0000-0000000000e2';

SELECT is(pg_temp.cats('bbbbbbbb-0000-0000-0000-000000000002'), ARRAY['Open 172'],
    'a member reads only the category holding a channel they view: not the empty one, not one of hidden channels');
SELECT is(pg_temp.cats('f1720000-0000-0000-0000-0000000000a2'), ARRAY['Open 172', 'Staff 172'],
    'a member allowed into the hidden channels reads their category');
SELECT is(pg_temp.cats('f1720000-0000-0000-0000-0000000000a1'), ARRAY['Empty 172', 'Open 172', 'Staff 172'],
    'a member with MANAGE_CHANNELS reads every category, empty ones included');
SELECT is(pg_temp.cats('aaaaaaaa-0000-0000-0000-000000000001'), ARRAY['Empty 172', 'Open 172', 'Staff 172'],
    'the owner reads every category');
SELECT is(pg_temp.cats('cccccccc-0000-0000-0000-000000000003'), '{}'::text[], 'a non-member reads none');
SELECT is(pg_temp.cats('dddddddd-0000-0000-0000-000000000004'), '{}'::text[], 'a banned member reads none');

SELECT tests.authenticate_as('f1720000-0000-0000-0000-0000000000a1');
WITH x AS (
    INSERT INTO public.channel_categories (server_id, name, "order")
    VALUES ('55555555-0000-0000-0000-000000000005', 'Fresh 172', 13) RETURNING id)
INSERT INTO made SELECT 'carol-cat', id FROM x;
SELECT tests.clear_authentication();
SELECT isnt((SELECT id FROM made WHERE k = 'carol-cat'), NULL,
    'a manager inserts a category and reads it back in the same statement');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.current_user_channel_manager_server_ids()),
    'the manager set is empty for a member without MANAGE_CHANNELS');
SELECT tests.authenticate_as('f1720000-0000-0000-0000-0000000000a1');
SELECT is(ARRAY(SELECT public.current_user_channel_manager_server_ids()),
          ARRAY['55555555-0000-0000-0000-000000000005'::uuid],
    'the manager set holds the server for a MANAGE_CHANNELS holder');
SELECT tests.clear_authentication();
SELECT ok(public.has_permission('f1720000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'MANAGE_CHANNELS')
          AND NOT public.has_permission('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'MANAGE_CHANNELS'),
    'and agrees with has_permission');

-- Sync state ----------------------------------------------------------------------------------

SELECT is(public.channel_permissions_synced('f1723000-0000-0000-0000-000000000003'), true,
    'a channel without overrides in a category without a template is synced');
SELECT is(public.channel_permissions_synced('f1723000-0000-0000-0000-000000000001'), false,
    'a channel carrying overrides its category lacks is not synced');
SELECT is(public.channel_permissions_synced('66666666-0000-0000-0000-000000000006'), NULL::boolean,
    'a channel in no category has no sync state');

-- set_category_permissions ---------------------------------------------------------------------

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(format('SELECT public.set_category_permissions(%L, %L)',
                        'f1722000-0000-0000-0000-0000000000e3', pg_temp.private_staff()),
    '42501', NULL, 'a member without MANAGE_CHANNELS or MANAGE_ROLES cannot set a template');
SELECT tests.authenticate_as('f1720000-0000-0000-0000-0000000000a1');
SELECT throws_ok(format('SELECT public.set_category_permissions(%L, %L)', 'f1722000-0000-0000-0000-0000000000e3',
                        jsonb_build_array(jsonb_build_object('target_type', 'role', 'role_id', 'f1721000-0000-0000-0000-000000000002',
                                                             'allow_permissions', 2097152))),
    '42501', 'Cannot grant MANAGE_MESSAGES without holding it',
    'a manager cannot allow a bit they do not hold');
SELECT throws_ok(format('SELECT public.set_category_permissions(%L, %L)', 'f1722000-0000-0000-0000-0000000000e3',
                        jsonb_build_array(jsonb_build_object('target_type', 'role', 'role_id', 'f1030000-0000-0000-0000-0000000000df',
                                                             'allow_permissions', 2))),
    '22023', NULL, 'a role of another server is refused');
SELECT throws_ok(format('SELECT public.set_category_permissions(%L, %L)', 'f1722000-0000-0000-0000-0000000000e3',
                        jsonb_build_array(jsonb_build_object('target_type', 'role', 'role_id', 'f1721000-0000-0000-0000-000000000002',
                                                             'allow_permissions', 2, 'deny_permissions', 2))),
    '22023', NULL, 'a bit both allowed and denied is refused');
SELECT throws_ok(format('SELECT public.set_category_permissions(%L, %L)', 'f1722000-0000-0000-0000-0000000000e3',
                        pg_temp.private_staff() || jsonb_build_array(jsonb_build_object(
                            'target_type', 'role', 'role_id', 'f1721000-0000-0000-0000-000000000002', 'allow_permissions', 4096))),
    '22023', NULL, 'two overrides for one role are refused');
SELECT throws_ok(format('SELECT public.set_category_permissions(%L, %L)', 'f1722000-0000-0000-0000-0000000000e3',
                        jsonb_build_array(jsonb_build_object('target_type', 'user', 'user_id', '33333333-0000-0000-0000-000000000003',
                                                             'allow_permissions', 2))),
    '22023', NULL, 'a member override for a non-member is refused');

SELECT is(public.set_category_permissions('f1722000-0000-0000-0000-0000000000e3', pg_temp.private_staff())
              -> 'synced_channel_ids',
          jsonb_build_array('f1723000-0000-0000-0000-000000000003'),
    'a manager makes a category private; its synced channel is reported');
SELECT tests.clear_authentication();

SELECT is(pg_temp.ovr('f1723000-0000-0000-0000-000000000003'), 'everyone:0/2 staff172:2/0',
    'the synced channel carries the template');
SELECT is(public.channel_permissions_synced('f1723000-0000-0000-0000-000000000003'), true, 'and stays synced');
SELECT is(pg_temp.cats('bbbbbbbb-0000-0000-0000-000000000002'), '{}'::text[],
    'the private category and its channels leave a member outside the allowed role');
SELECT is(pg_temp.cats('f1720000-0000-0000-0000-0000000000a2'), ARRAY['Open 172', 'Staff 172'],
    'the allowed role keeps them');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.channel_category_permission_overrides), 0,
    'a member who does not see a category reads none of its template');
SELECT tests.authenticate_as('f1720000-0000-0000-0000-0000000000a2');
SELECT is((SELECT count(*)::int FROM public.channel_category_permission_overrides
            WHERE category_id = 'f1722000-0000-0000-0000-0000000000e3'), 2,
    'a member who sees the category reads its template');
SELECT tests.clear_authentication();

-- Inheritance ----------------------------------------------------------------------------------

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO made SELECT 'inherit', (public.create_channel('55555555-0000-0000-0000-000000000005',
    'inherit-172', 0, 'f1722000-0000-0000-0000-0000000000e3')).id;
INSERT INTO made SELECT 'inherit-private', (public.create_channel('55555555-0000-0000-0000-000000000005',
    'inherit-private-172', 0, 'f1722000-0000-0000-0000-0000000000e3', true,
    ARRAY['f1721000-0000-0000-0000-000000000003']::uuid[])).id;
INSERT INTO made SELECT 'plain-private', (public.create_channel('55555555-0000-0000-0000-000000000005',
    'plain-private-172', 0, NULL, true, ARRAY['f1721000-0000-0000-0000-000000000003']::uuid[])).id;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT tests.clear_authentication();

SELECT is(pg_temp.ovr((SELECT id FROM made WHERE k = 'inherit')), 'everyone:0/2 staff172:2/0',
    'a channel created in a category receives its template');
SELECT is(public.channel_permissions_synced((SELECT id FROM made WHERE k = 'inherit')), true,
    'and is synced');
SELECT is(pg_temp.ovr((SELECT id FROM made WHERE k = 'inherit-private')), 'everyone:0/2 extra172:2/0 staff172:2/0',
    'p_private merges into the template: one @everyone deny, the template role and the listed role');
SELECT is(public.channel_permissions_synced((SELECT id FROM made WHERE k = 'inherit-private')), false,
    'a listed role the template lacks leaves the channel unsynced');
SELECT is(pg_temp.ovr((SELECT id FROM made WHERE k = 'plain-private')), 'everyone:0/2 extra172:2/0',
    'p_private without a category is unchanged');
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE payload->>'type' = 'channel:insert'
                     AND payload->'new'->>'id' = (SELECT id::text FROM made WHERE k = 'inherit')
                     AND (payload->>'restricted')::boolean IS TRUE
                     AND NOT (payload->'new' ? 'name')),
    'the inheriting channel''s insert broadcast is restricted and carries no name');

SELECT tests.authenticate_as('f1720000-0000-0000-0000-0000000000a1');
INSERT INTO made SELECT 'carol-made', (public.create_channel('55555555-0000-0000-0000-000000000005',
    'carol-172', 0, 'f1722000-0000-0000-0000-0000000000e3')).id;
SELECT tests.clear_authentication();
SELECT is(pg_temp.ovr((SELECT id FROM made WHERE k = 'carol-made')), 'everyone:0/2 staff172:2/0',
    'a manager outside the allowed role creates a channel there; it inherits the template');

-- A channel edited apart ------------------------------------------------------------------------

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
VALUES ('f1723000-0000-0000-0000-000000000003', 'role', 'f1721000-0000-0000-0000-000000000003', 2, 0);
SELECT tests.clear_authentication();
SELECT is(public.channel_permissions_synced('f1723000-0000-0000-0000-000000000003'), false,
    'an override written apart from the category unsyncs the channel');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT array_agg(x::uuid ORDER BY x::uuid)
             FROM jsonb_array_elements_text(public.set_category_permissions('f1722000-0000-0000-0000-0000000000e3',
                      pg_temp.private_staff() || jsonb_build_array(jsonb_build_object(
                          'target_type', 'user', 'user_id', '22222222-0000-0000-0000-000000000002', 'allow_permissions', 2)))
                  -> 'synced_channel_ids') x),
          (SELECT array_agg(id ORDER BY id) FROM made WHERE k IN ('inherit', 'carol-made')),
    'a template change reaches the synced channels only');
SELECT tests.clear_authentication();
SELECT is(pg_temp.ovr('f1723000-0000-0000-0000-000000000003'), 'everyone:0/2 extra172:2/0 staff172:2/0',
    'the unsynced channel keeps its own overrides');
SELECT ok((SELECT count(*) = 1 FROM public.channel_permission_overrides
            WHERE channel_id = (SELECT id FROM made WHERE k = 'inherit')
              AND user_id = '22222222-0000-0000-0000-000000000002' AND allow_permissions = 2),
    'a synced channel receives the member override');
SELECT is(pg_temp.cats('bbbbbbbb-0000-0000-0000-000000000002'), ARRAY['Open 172'],
    'the member allowed by a member override sees the category again');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.sync_channel_permissions('f1723000-0000-0000-0000-000000000003')$q$,
    '42501', NULL, 'a member without MANAGE_CHANNELS cannot sync a channel');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.sync_channel_permissions('f1723000-0000-0000-0000-000000000003'), true, 'the owner syncs it');
SELECT tests.clear_authentication();
SELECT is(public.channel_permissions_synced('f1723000-0000-0000-0000-000000000003'), true,
    'Sync restores the category''s permissions');
SELECT is((SELECT count(*)::int FROM public.channel_permission_overrides
            WHERE channel_id = 'f1723000-0000-0000-0000-000000000003'
              AND role_id = 'f1721000-0000-0000-0000-000000000003'), 0,
    'the override written apart is gone');

SELECT tests.authenticate_as('f1720000-0000-0000-0000-0000000000a1');
SELECT throws_ok($q$SELECT public.sync_channel_permissions('f1723000-0000-0000-0000-000000000003')$q$,
    '42501', NULL, 'a manager who cannot view the channel cannot sync it');
SELECT throws_ok(format('SELECT public.set_category_permissions(%L, %L)',
                        'f1722000-0000-0000-0000-0000000000e3', pg_temp.private_staff()),
    '42501', NULL, 'nor change a template synced onto channels they cannot view');
SELECT tests.clear_authentication();

-- Moves ------------------------------------------------------------------------------------------

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.channels SET category = 'f1722000-0000-0000-0000-0000000000e3'
 WHERE id = 'f1723000-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();
SELECT is(pg_temp.ovr('f1723000-0000-0000-0000-000000000001'), 'everyone:0/2 staff172:2/0',
    'moving a channel into a category writes no override');
SELECT is(public.channel_permissions_synced('f1723000-0000-0000-0000-000000000001'), false,
    'and leaves it unsynced when it differs');

-- Broadcasts -------------------------------------------------------------------------------------

SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE payload->>'type' = 'category:insert'
                     AND payload->'new'->>'id' = 'f1722000-0000-0000-0000-0000000000e1'
                     AND (payload->>'restricted')::boolean IS TRUE
                     AND NOT (payload->'new' ? 'name')),
    'an empty category''s insert broadcast carries no name');
UPDATE public.channel_categories SET name = 'Hidden renamed 172' WHERE id = 'f1722000-0000-0000-0000-0000000000e3';
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE payload->>'type' = 'category:update'
                     AND payload->'new'->>'id' = 'f1722000-0000-0000-0000-0000000000e3'
                     AND (payload->>'restricted')::boolean IS TRUE)
          AND NOT EXISTS (SELECT 1 FROM realtime.messages WHERE payload::text LIKE '%Hidden renamed 172%'),
    'renaming a category of hidden channels broadcasts no name');
UPDATE public.channel_categories SET name = 'Text Channels 172'
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND name = 'Text Channels';
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE payload->>'type' = 'category:update'
                     AND payload->'new'->>'name' = 'Text Channels 172'),
    'a category holding a channel every member sees broadcasts its row');
UPDATE public.channel_categories SET name = 'Text Channels'
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND name = 'Text Channels 172';
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE payload->>'type' = 'category_permission_override:insert'
                     AND payload->>'category_id' = 'f1722000-0000-0000-0000-0000000000e3'
                     AND payload::text NOT LIKE '%allow%'),
    'a template change broadcasts the category id alone');

-- Notification settings --------------------------------------------------------------------------

SELECT ok(NOT (public.notification_settings_state('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005')
               -> 'categories')::text LIKE '%Empty 172%',
    'notification settings name no category a member does not see');
SELECT ok((public.notification_settings_state('f1720000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005')
           -> 'categories')::text LIKE '%Empty 172%',
    'a manager''s notification settings list every category');

-- Federation -------------------------------------------------------------------------------------

SELECT is(ARRAY(SELECT instance FROM public.federation_category_recipients('f1722000-0000-0000-0000-0000000000e3')),
          ARRAY['remote.test'], 'a private category reaches only instances whose members view a channel in it');
SELECT is((SELECT count(*)::int FROM public.federation_category_recipients('f1722000-0000-0000-0000-0000000000e1')),
          0, 'an empty category reaches no instance');
-- A second remote.test member without staff172: that instance's copy of the server is shown to
-- both, so it no longer receives a channel of the category, nor the category.
INSERT INTO public.profiles (id, username, display_name, domain, federated_id, shared_inbox_url, is_local) VALUES
  ('f1720000-0000-0000-0000-0000000000c5', 'rn172', 'rn172', 'remote.test',
   'https://remote.test/users/rn172', 'https://remote.test/inbox', false);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1720000-0000-0000-0000-0000000000c5', '55555555-0000-0000-0000-000000000005', 'accepted');
SELECT is((SELECT count(*)::int FROM public.federation_category_recipients('f1722000-0000-0000-0000-0000000000e3')),
          0, 'a private category reaches no instance hosting a member who views none of its channels');
DELETE FROM public.user_servers WHERE user_id = 'f1720000-0000-0000-0000-0000000000c5';
UPDATE public.servers SET federation_enabled = false WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT is((SELECT count(*)::int FROM public.federation_category_recipients('f1722000-0000-0000-0000-0000000000e3')),
          0, 'federation off: no instance');
UPDATE public.servers SET federation_enabled = true WHERE id = '55555555-0000-0000-0000-000000000005';

-- Lifecycle and grants ----------------------------------------------------------------------------

DELETE FROM public.channel_categories WHERE id = 'f1722000-0000-0000-0000-0000000000e3';
SELECT is((SELECT count(*)::int FROM public.channel_category_permission_overrides
            WHERE category_id = 'f1722000-0000-0000-0000-0000000000e3'), 0,
    'deleting a category deletes its template');
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE payload->>'type' = 'category:delete'
                     AND payload->'old'->>'id' = 'f1722000-0000-0000-0000-0000000000e3'
                     AND NOT (payload->'old' ? 'name')),
    'a category delete broadcasts ids alone');

SELECT ok(NOT has_function_privilege('anon', 'public.set_category_permissions(uuid, jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.sync_channel_permissions(uuid)', 'EXECUTE'),
    'anon cannot call set_category_permissions or sync_channel_permissions');
SELECT ok(NOT has_function_privilege('authenticated', 'public.apply_category_permissions(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.assert_category_template_writable(uuid, uuid, jsonb)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.federation_category_recipients(uuid)', 'EXECUTE'),
    'the internal helpers and the federation recipients are not client endpoints');
SELECT ok(NOT has_table_privilege('authenticated', 'public.channel_category_permission_overrides', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.channel_category_permission_overrides', 'UPDATE')
          AND NOT has_table_privilege('authenticated', 'public.channel_category_permission_overrides', 'DELETE')
          AND has_table_privilege('authenticated', 'public.channel_category_permission_overrides', 'SELECT'),
    'clients read templates and write them through the functions alone');
SELECT is(prosecdef, false, 'create_channel stays SECURITY INVOKER')
  FROM pg_proc WHERE oid = 'public.create_channel(uuid, text, integer, uuid, boolean, uuid[], text, integer, boolean, boolean, text)'::regprocedure;

SELECT * FROM finish();
ROLLBACK;
