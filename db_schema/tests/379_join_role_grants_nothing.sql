-- 20261116400001_self_assignable_roles.sql, join role: open_role_refusal decides. A stored
-- server_settings.default_role_id that grants or outranks is not given, set_server_join_role refuses
-- one as ROLE_NOT_OPEN with the code in DETAIL, and values stored before the migration are cleared.
--
--   server_1 (55555555-...05)  owner alice, @everyone 4098 (VIEW_CHANNEL, SEND_MESSAGES)
--   cosmetic (1)               no bits, not self-assignable
--   power    (3)               MANAGE_MESSAGES
--   above    (6)               no bits, above power
--   leaky    (2)               override allows MUTE_MEMBERS
--   adm      (900)             administrator
--   joiner_1..5                local accounts outside the server
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(18);

UPDATE public.server_roles SET permissions = 4098, position = 0
 WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default;
INSERT INTO public.server_roles (id, server_id, name, position, permissions, is_admin) VALUES
  ('37900000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'cosmetic', 1, 0, false),
  ('37900000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'power', 3, 2097152, false),
  ('37900000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'above', 6, 0, false),
  ('37900000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005', 'leaky', 2, 0, false),
  ('37900000-0000-0000-0000-000000000005', '55555555-0000-0000-0000-000000000005', 'adm', 900, 1, true);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
VALUES ('66666666-0000-0000-0000-000000000006', 'role', '37900000-0000-0000-0000-000000000004', 1::bigint << 27, 0);
INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT format('c3790000-0000-0000-0000-00000000000%s', n)::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', format('u%s@c379.test', n)
  FROM generate_series(1, 5) n;
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
SELECT format('c3791000-0000-0000-0000-00000000000%s', n)::uuid, format('c3790000-0000-0000-0000-00000000000%s', n)::uuid,
       format('c379u%s', n), format('U%s', n), true
  FROM generate_series(1, 5) n;

-- A joiner accepted while p_role is the stored join role; whether they hold it.
CREATE FUNCTION pg_temp.join_with(p_role uuid, p_joiner int) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
    v_user uuid := format('c3791000-0000-0000-0000-00000000000%s', p_joiner)::uuid;
BEGIN
    INSERT INTO public.server_settings (server_id, default_role_id)
    VALUES ('55555555-0000-0000-0000-000000000005', p_role)
    ON CONFLICT (server_id) DO UPDATE SET default_role_id = EXCLUDED.default_role_id;
    INSERT INTO public.user_servers (user_id, server_id, status)
    VALUES (v_user, '55555555-0000-0000-0000-000000000005', 'accepted');
    RETURN EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_user AND role_id = p_role);
END;
$$;

-- Applying ------------------------------------------------------------------------------------------
SELECT ok(pg_temp.join_with('37900000-0000-0000-0000-000000000001', 1), 'a role without powers is given');
SELECT ok(NOT pg_temp.join_with('37900000-0000-0000-0000-000000000002', 2), 'one with permissions beyond @everyone''s is not');
SELECT ok(NOT pg_temp.join_with('37900000-0000-0000-0000-000000000003', 3), 'nor one above a role that has them');
SELECT ok(NOT pg_temp.join_with('37900000-0000-0000-0000-000000000004', 4), 'nor one an override gives a moderation bit');
SELECT ok(NOT pg_temp.join_with('37900000-0000-0000-0000-000000000005', 5), 'nor an administrator role');
SELECT is((SELECT count(*)::int FROM public.user_servers
            WHERE server_id = '55555555-0000-0000-0000-000000000005' AND user_id::text LIKE 'c3791000-%'
              AND status = 'accepted'), 5, 'everyone joined all the same');
SELECT is((SELECT count(*)::int FROM public.user_roles ur JOIN public.server_roles sr ON sr.id = ur.role_id
            WHERE sr.is_default AND ur.user_id::text LIKE 'c3791000-%'), 5, 'with @everyone');

-- A role that gains a power stops being given.
DELETE FROM public.user_servers WHERE user_id = 'c3791000-0000-0000-0000-000000000001';
DELETE FROM public.user_roles WHERE user_id = 'c3791000-0000-0000-0000-000000000001';
UPDATE public.server_roles SET permissions = 2097152 WHERE id = '37900000-0000-0000-0000-000000000001';
SELECT ok(NOT pg_temp.join_with('37900000-0000-0000-0000-000000000001', 1), 'a role given powers later is not given to new members');
UPDATE public.server_roles SET permissions = 0 WHERE id = '37900000-0000-0000-0000-000000000001';

-- Choosing ------------------------------------------------------------------------------------------
CREATE TEMP TABLE refusal (role text, message text, details text);
GRANT ALL ON refusal TO authenticated;
CREATE FUNCTION pg_temp.choose(p_name text, p_role uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d text;
BEGIN
    PERFORM public.set_server_join_role('55555555-0000-0000-0000-000000000005', p_role);
    INSERT INTO refusal VALUES (p_name, NULL, NULL);
EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
    INSERT INTO refusal VALUES (p_name, SQLERRM, d);
END;
$$;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT pg_temp.choose('cosmetic', '37900000-0000-0000-0000-000000000001');
SELECT pg_temp.choose('power', '37900000-0000-0000-0000-000000000002');
SELECT pg_temp.choose('above', '37900000-0000-0000-0000-000000000003');
SELECT pg_temp.choose('leaky', '37900000-0000-0000-0000-000000000004');
SELECT pg_temp.choose('adm', '37900000-0000-0000-0000-000000000005');
SELECT tests.clear_authentication();
SELECT is((SELECT message FROM refusal WHERE role = 'cosmetic'), NULL, 'the owner chooses a role without powers');
SELECT results_eq($$SELECT message, details FROM refusal WHERE role = 'power'$$,
                  $$VALUES ('ROLE_NOT_OPEN', 'ROLE_GRANTS_PERMISSIONS')$$, 'not one with permissions');
SELECT results_eq($$SELECT message, details FROM refusal WHERE role = 'above'$$,
                  $$VALUES ('ROLE_NOT_OPEN', 'ROLE_RANKS_TOO_HIGH')$$, 'not one above it');
SELECT results_eq($$SELECT message, details FROM refusal WHERE role = 'leaky'$$,
                  $$VALUES ('ROLE_NOT_OPEN', 'ROLE_OVERRIDE_GRANTS')$$, 'not one with a granting override');
SELECT results_eq($$SELECT message FROM refusal WHERE role = 'adm'$$, $$VALUES ('ROLE_RESERVED')$$, 'an administrator role as before');
SELECT is((SELECT default_role_id FROM public.server_settings WHERE server_id = '55555555-0000-0000-0000-000000000005'),
          '37900000-0000-0000-0000-000000000001'::uuid, 'the refused choices leave the chosen role');

-- Values stored before the migration ----------------------------------------------------------------
-- The UPDATE of 20261116400001_self_assignable_roles.sql.
CREATE FUNCTION pg_temp.clear_stored() RETURNS void LANGUAGE sql AS $$
    UPDATE public.server_settings ss
       SET default_role_id = NULL
      FROM public.servers s
     WHERE s.id = ss.server_id
       AND s.is_local_server
       AND ss.default_role_id IS NOT NULL
       AND public.open_role_refusal(ss.default_role_id) IS NOT NULL
$$;
INSERT INTO public.servers (id, name, owner, is_local_server) VALUES
  ('37920000-0000-0000-0000-000000000001', 'Powers', '11111111-0000-0000-0000-000000000001', true),
  ('37920000-0000-0000-0000-000000000002', 'Copy', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('37900000-0000-0000-0000-000000000006', '37920000-0000-0000-0000-000000000001', 'mod', 1, 2097152),
  ('37900000-0000-0000-0000-000000000007', '37920000-0000-0000-0000-000000000002', 'remote', 1, 0);
INSERT INTO public.server_settings (server_id, default_role_id) VALUES
  ('37920000-0000-0000-0000-000000000001', '37900000-0000-0000-0000-000000000006'),
  ('37920000-0000-0000-0000-000000000002', '37900000-0000-0000-0000-000000000007')
ON CONFLICT (server_id) DO UPDATE SET default_role_id = EXCLUDED.default_role_id;
SELECT pg_temp.clear_stored();
SELECT is((SELECT default_role_id FROM public.server_settings WHERE server_id = '37920000-0000-0000-0000-000000000001'),
          NULL, 'a stored role with powers is cleared');
SELECT is((SELECT changes -> 'default_role' ->> 'old' FROM public.server_audit_log
            WHERE server_id = '37920000-0000-0000-0000-000000000001' AND action = 'settings.update'
              AND source = 'system' AND changes ? 'default_role'
            ORDER BY created_at DESC LIMIT 1),
          'mod', 'the audit log names it');
SELECT is((SELECT default_role_id FROM public.server_settings WHERE server_id = '55555555-0000-0000-0000-000000000005'),
          '37900000-0000-0000-0000-000000000001'::uuid, 'one without powers is kept');
SELECT is((SELECT default_role_id FROM public.server_settings WHERE server_id = '37920000-0000-0000-0000-000000000002'),
          '37900000-0000-0000-0000-000000000007'::uuid, 'a copy''s is left alone');

SELECT * FROM finish();
ROLLBACK;
