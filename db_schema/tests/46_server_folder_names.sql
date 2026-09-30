-- Server folder names after 20261003500001_server_folder_blank_name.sql.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(7);

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');

SELECT lives_ok(
    $q$INSERT INTO public.server_folders (id, user_id, name)
       VALUES ('f4600000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', '')$q$,
    'an unnamed folder is created');
SELECT is((SELECT name FROM public.server_folders WHERE id = 'f4600000-0000-0000-0000-000000000001'), '',
          'an unnamed folder stores the empty string');

INSERT INTO public.server_folders (id, user_id, name)
VALUES ('f4600000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', '  Games  ');
SELECT is((SELECT name FROM public.server_folders WHERE id = 'f4600000-0000-0000-0000-000000000002'), 'Games',
          'a named folder is trimmed');

UPDATE public.server_folders SET name = '   ' WHERE id = 'f4600000-0000-0000-0000-000000000002';
SELECT is((SELECT name FROM public.server_folders WHERE id = 'f4600000-0000-0000-0000-000000000002'), '',
          'renaming a folder to blanks clears its name');

SELECT tests.clear_authentication();

-- The other modes are unchanged.
SELECT throws_ok(
    $q$INSERT INTO public.server_roles (server_id, name) VALUES ('55555555-0000-0000-0000-000000000005', '  ')$q$,
    '23514', NULL, 'a required name still refuses blanks');
INSERT INTO public.conversations (id, type, name)
VALUES ('f4600000-0000-0000-0000-0000000000c1', 'group', '   ');
SELECT is((SELECT name FROM public.conversations WHERE id = 'f4600000-0000-0000-0000-0000000000c1'), NULL,
          'an optional name still stores NULL');

SELECT is((SELECT encode(tgargs, 'escape') FROM pg_trigger
            WHERE tgname = 'sanitize_server_folder_name_trigger'
              AND tgrelid = 'public.server_folders'::regclass),
          E'64\\000blank\\000', 'the folder trigger runs in blank mode');

SELECT * FROM finish();
ROLLBACK;
