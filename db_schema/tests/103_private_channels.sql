-- 20261010000001_private_channels.sql: create_channel makes a private channel in one
-- transaction, and its insert broadcast carries no name.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(11);

-- alice owns the server; bob is a member; a "Mods" role.
INSERT INTO public.server_roles (id, server_id, name, permissions, position)
VALUES ('f1030000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'Mods', 0, 5);
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'accepted')
ON CONFLICT DO NOTHING;

CREATE TEMP TABLE made (k text PRIMARY KEY, id uuid);
GRANT ALL ON made TO authenticated;

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO made SELECT 'private', (public.create_channel('55555555-0000-0000-0000-000000000005',
    'mods-only', 0, NULL, true, ARRAY['f1030000-0000-0000-0000-0000000000d1']::uuid[])).id;
INSERT INTO made SELECT 'public', (public.create_channel('55555555-0000-0000-0000-000000000005',
    'open-103')).id;
SELECT throws_ok($q$SELECT public.create_channel('55555555-0000-0000-0000-000000000005', 'x', 0, NULL, true,
                     ARRAY['f1030000-0000-0000-0000-0000000000df']::uuid[])$q$,
                 '22023', NULL, 'a role of another server is refused');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT tests.clear_authentication();

SELECT results_eq(
    $q$SELECT r.is_default, o.allow_permissions, o.deny_permissions
         FROM public.channel_permission_overrides o JOIN public.server_roles r ON r.id = o.role_id
        WHERE o.channel_id = (SELECT id FROM made WHERE k = 'private') ORDER BY r.is_default DESC$q$,
    $q$VALUES (true, 0::bigint, 2::bigint), (false, 2::bigint, 0::bigint)$q$,
    'a private channel denies VIEW_CHANNEL to @everyone and allows the listed role');
SELECT is_empty(
    $q$SELECT 1 FROM public.channel_permission_overrides WHERE channel_id = (SELECT id FROM made WHERE k = 'public')$q$,
    'a public channel has no overrides');

SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE topic = 'server-structure:55555555-0000-0000-0000-000000000005'
                     AND payload->>'type' = 'channel:insert'
                     AND payload->'new'->>'id' = (SELECT id::text FROM made WHERE k = 'private')
                     AND (payload->>'restricted')::boolean IS TRUE
                     AND NOT (payload->'new' ? 'name')),
          'the private channel''s insert broadcast is restricted and carries no name');
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE payload->>'type' = 'channel:insert'
                     AND payload->'new'->>'id' = (SELECT id::text FROM made WHERE k = 'public')
                     AND payload->'new'->>'name' = 'open-103'),
          'a public channel''s insert broadcast carries the row');

SELECT ok((SELECT tgdeferrable AND tginitdeferred FROM pg_trigger
            WHERE tgname = 'trg_broadcast_channel_insert'
              AND tgrelid = 'public.channels'::regclass),
          'the insert broadcast is deferred to commit');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.channels WHERE id = (SELECT id FROM made WHERE k = 'private')),
          0, 'a member without the role does not see the private channel');
SELECT is((SELECT count(*)::int FROM public.channels WHERE id = (SELECT id FROM made WHERE k = 'public')),
          1, 'a member sees the public channel');
SELECT throws_ok($q$SELECT public.create_channel('55555555-0000-0000-0000-000000000005', 'bobs')$q$,
                 '42501', NULL, 'a member cannot create channels (channels RLS applies)');
SELECT tests.clear_authentication();

INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('22222222-0000-0000-0000-000000000002', 'f1030000-0000-0000-0000-0000000000d1',
        '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.channels WHERE id = (SELECT id FROM made WHERE k = 'private')),
          1, 'the role grants the private channel');
SELECT tests.clear_authentication();

SELECT ok(NOT has_function_privilege('anon', 'public.create_channel(uuid, text, integer, uuid, boolean, uuid[])', 'EXECUTE'),
          'anon cannot call create_channel');

SELECT * FROM finish();
ROLLBACK;
