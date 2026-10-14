-- 20261014100001_admin_role_rename.sql: the Admin role renames, @everyone does not, and
-- neither loses its protected flag.
--
--   server_141 (f1410000-...02)  owner bob; @everyone and Admin from the server trigger

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(5);

INSERT INTO public.servers (id, name, owner)
VALUES ('f1410000-0000-0000-0000-000000000002', 'Server 141', '22222222-0000-0000-0000-000000000002');

SELECT lives_ok(
    $$UPDATE public.server_roles SET name = 'the big sleaze'
       WHERE server_id = 'f1410000-0000-0000-0000-000000000002' AND is_admin$$,
    'the Admin role renames');

SELECT is(
    (SELECT name FROM public.server_roles
      WHERE server_id = 'f1410000-0000-0000-0000-000000000002' AND is_admin),
    'the big sleaze',
    'the new name is stored on the role that keeps is_admin');

SELECT throws_ok(
    $$UPDATE public.server_roles SET name = 'everybody'
       WHERE server_id = 'f1410000-0000-0000-0000-000000000002' AND is_default$$,
    'P0001', 'Cannot rename the everyone role.',
    '@everyone keeps its name');

SELECT throws_ok(
    $$UPDATE public.server_roles SET is_admin = false
       WHERE server_id = 'f1410000-0000-0000-0000-000000000002' AND is_admin$$,
    'P0001', 'Cannot remove admin status from the Admin role.',
    'the renamed Admin role keeps is_admin');

SELECT throws_ok(
    $$UPDATE public.server_roles SET is_default = false
       WHERE server_id = 'f1410000-0000-0000-0000-000000000002' AND is_default$$,
    'P0001', 'Cannot remove default status from the everyone role.',
    '@everyone keeps is_default');

SELECT * FROM finish();
ROLLBACK;
