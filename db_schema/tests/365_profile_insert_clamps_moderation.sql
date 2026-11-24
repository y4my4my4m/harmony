-- An authenticated profile INSERT cannot assert moderation flags,
-- after 20260821000002_clamp_moderation_flags_on_insert.sql.
--
--   eeee...0365  a fresh auth user with no profile; the fixtures hold local profiles,
--                so promote_first_user_to_admin leaves is_admin alone.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(4);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('eeeeeeee-0000-0000-0000-000000000365', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'clamp365@test.local');

SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000365');
SELECT lives_ok($$
  INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local,
                               is_admin, is_moderator, is_suspended, is_silenced, force_sensitive)
  VALUES ('36500000-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000365',
          'clamp365', 'Clamp', true, true, true, true, true, true)
$$, 'an authenticated caller inserts its own profile');
SELECT tests.clear_authentication();

SELECT is((SELECT (is_admin, is_moderator)::text FROM public.profiles
            WHERE id = '36500000-0000-0000-0000-000000000001'),
          '(f,f)',
          'is_admin and is_moderator asserted at insert are stored false');
SELECT is((SELECT (is_suspended, is_silenced, force_sensitive)::text FROM public.profiles
            WHERE id = '36500000-0000-0000-0000-000000000001'),
          '(f,f,f)',
          'is_suspended, is_silenced and force_sensitive asserted at insert are stored false');

INSERT INTO public.profiles (id, username, display_name, domain, is_local, is_moderator)
VALUES ('36500000-0000-0000-0000-000000000002', 'mod365', 'Mod', 'remote365.test', false, true);
SELECT is((SELECT is_moderator FROM public.profiles WHERE id = '36500000-0000-0000-0000-000000000002'),
          true,
          'a privileged insert keeps the flag');

SELECT * FROM finish();
ROLLBACK;
