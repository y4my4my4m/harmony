-- 20261125800001_override_keeps_target.sql: a channel override stays with its role or member, so
-- an UPDATE cannot carry another target's allowed bits to the caller.
--
--   server_1 (55555555-...05)  owner alice, member bob; general 6666
--   @everyone   VIEW_CHANNEL | SEND_MESSAGES
--   mgr  (5)    MANAGE_CHANNELS | MANAGE_ROLES, held by bob
--   mods (8)    no server permission; o1 on general allows it MANAGE_MESSAGES (bit 21), made by the owner
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(15);

UPDATE public.server_roles SET permissions = 4098, position = 0
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('39600000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'mgr', 5, 12),
  ('39600000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'mods', 8, 0);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('22222222-0000-0000-0000-000000000002', '39600000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.channel_permission_overrides (id, channel_id, target_type, role_id, allow_permissions, deny_permissions) VALUES
  ('39610000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', 'role',
   '39600000-0000-0000-0000-000000000002', 2097152, 0);

CREATE FUNCTION pg_temp.bob_has(p_permission text) RETURNS text LANGUAGE sql AS $$
  SELECT public.get_user_permissions('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005',
                                     '66666666-0000-0000-0000-000000000006')->>p_permission
$$;
CREATE FUNCTION pg_temp.o1() RETURNS text LANGUAGE sql AS $$
  SELECT concat_ws(' ', target_type, role_id, user_id, allow_permissions, deny_permissions)
    FROM public.channel_permission_overrides WHERE id = '39610000-0000-0000-0000-000000000001'
$$;

-- A channel manager -------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');

SELECT throws_ok(
    $q$INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
       VALUES ('66666666-0000-0000-0000-000000000006', 'role',
               (SELECT id FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), 1, 0)$q$,
    '42501', 'Cannot grant ADMINISTRATOR without holding it',
    'a new override allows no bit the caller lacks: ADMINISTRATOR on @everyone');
SELECT throws_ok(
    $q$INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
       VALUES ('66666666-0000-0000-0000-000000000006', 'role', '39600000-0000-0000-0000-000000000001', 2097152, 0)$q$,
    '42501', 'Cannot grant MANAGE_MESSAGES without holding it',
    'nor MANAGE_MESSAGES on their own role');
SELECT throws_ok(
    $q$UPDATE public.channel_permission_overrides SET allow_permissions = allow_permissions | 1024
        WHERE id = '39610000-0000-0000-0000-000000000001'$q$,
    '42501', 'Cannot grant BAN_MEMBERS without holding it',
    'an edit adds no bit the caller lacks');

SELECT throws_ok(
    $q$UPDATE public.channel_permission_overrides SET role_id = '39600000-0000-0000-0000-000000000001'
        WHERE id = '39610000-0000-0000-0000-000000000001'$q$,
    '42501', 'an override stays with its target',
    'a row allowing MANAGE_MESSAGES to mods is not moved onto the caller''s role');
SELECT throws_ok(
    $q$UPDATE public.channel_permission_overrides
          SET target_type = 'user', role_id = NULL, user_id = '22222222-0000-0000-0000-000000000002'
        WHERE id = '39610000-0000-0000-0000-000000000001'$q$,
    '42501', 'an override stays with its target',
    'nor onto the caller as a member override');
SELECT throws_ok(
    $q$UPDATE public.channel_permission_overrides SET role_id = '39600000-0000-0000-0000-000000000001', allow_permissions = 0
        WHERE id = '39610000-0000-0000-0000-000000000001'$q$,
    '42501', 'an override stays with its target',
    'nor with no allowed bit');
SELECT is(pg_temp.o1(), 'role 39600000-0000-0000-0000-000000000002 2097152 0', 'the mods row is unchanged');
SELECT is(pg_temp.bob_has('MANAGE_MESSAGES'), 'false', 'the caller still lacks MANAGE_MESSAGES in general');

SELECT lives_ok(
    $q$UPDATE public.channel_permission_overrides SET deny_permissions = 4096, updated_at = now()
        WHERE id = '39610000-0000-0000-0000-000000000001'$q$,
    'edits the same target keeping a bit they lack');
SELECT is(pg_temp.o1(), 'role 39600000-0000-0000-0000-000000000002 2097152 4096', 'the edit is stored');
SELECT lives_ok(
    $q$INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
       VALUES ('66666666-0000-0000-0000-000000000006', 'role', '39600000-0000-0000-0000-000000000001', 4096, 0)$q$,
    'adds an override allowing a bit they hold');
SELECT lives_ok(
    $q$DELETE FROM public.channel_permission_overrides WHERE id = '39610000-0000-0000-0000-000000000001'$q$,
    'removes an override');
SELECT is(pg_temp.o1(), NULL, 'the removed override is gone');

-- The owner ---------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$UPDATE public.channel_permission_overrides SET role_id = '39600000-0000-0000-0000-000000000002'
        WHERE channel_id = '66666666-0000-0000-0000-000000000006' AND role_id = '39600000-0000-0000-0000-000000000001'$q$,
    '42501', 'an override stays with its target',
    'the owner does not retarget either');
SELECT lives_ok(
    $q$INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
       VALUES ('66666666-0000-0000-0000-000000000006', 'role', '39600000-0000-0000-0000-000000000002', 2097152, 0)$q$,
    'the owner allows any bit');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
