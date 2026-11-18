-- 20261117600001_activity_packages.sql: installed activity packages.
--
--   alice is an instance admin here; files are a one-byte script 'a' and a tiny SVG.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(16);

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';

CREATE TEMP TABLE pkg ON COMMIT DROP AS SELECT
  encode(sha256('a'::bytea), 'hex') AS js_sha,
  encode(sha256('b'::bytea), 'hex') AS js2_sha,
  encode(sha256(convert_to('<svg/>', 'UTF8')), 'hex') AS svg_sha,
  repeat('c', 64) AS zip_sha;

CREATE TEMP TABLE pkg_args ON COMMIT DROP AS SELECT
  jsonb_build_object('id', 'tictac', 'name', 'Tic Tac', 'version', '1.0.0', 'description', 'Noughts',
    'i18n', '{}'::jsonb, 'accent', '#112233', 'min_players', 2, 'max_players', 2,
    'contexts', '["direct","channel"]'::jsonb, 'entry_sha', p.js_sha, 'icon_sha', p.svg_sha,
    'icon_ext', 'svg', 'package_url', 'https://example.com/tictac.zip', 'package_sha', p.zip_sha) AS app,
  jsonb_build_array(
    jsonb_build_object('sha256', p.js_sha, 'content_type', 'text/javascript; charset=utf-8', 'base64', encode('a'::bytea, 'base64')),
    jsonb_build_object('sha256', p.svg_sha, 'content_type', 'image/svg+xml', 'base64', encode(convert_to('<svg/>', 'UTF8'), 'base64'))) AS files
FROM pkg p;

SELECT is(public.install_activity_package('11111111-0000-0000-0000-000000000001', (SELECT app FROM pkg_args), (SELECT files FROM pkg_args)) ->> 'enabled',
  'false', 'a new package starts switched off');
SELECT is((SELECT builtin FROM public.activity_apps WHERE id = 'tictac'), false, 'it is not a built-in');
SELECT is((SELECT count(*)::int FROM public.activity_app_files WHERE app_id = 'tictac'), 2, 'its script and icon are stored');
SELECT is((SELECT count(*)::int FROM public.admin_audit_log WHERE action_type = 'activity_package_install' AND target_id = 'tictac'), 1,
  'the install is logged');

UPDATE public.activity_apps SET enabled = true WHERE id = 'tictac';
SELECT is(public.install_activity_package('11111111-0000-0000-0000-000000000001',
    (SELECT app || jsonb_build_object('version', '1.1.0', 'entry_sha', (SELECT js2_sha FROM pkg)) FROM pkg_args),
    jsonb_build_array(
      jsonb_build_object('sha256', (SELECT js2_sha FROM pkg), 'content_type', 'text/javascript; charset=utf-8', 'base64', encode('b'::bytea, 'base64')),
      (SELECT files -> 1 FROM pkg_args))) ->> 'enabled',
  'true', 'an update keeps the switch');
SELECT is((SELECT array_agg(sha256 ORDER BY sha256) FROM public.activity_app_files WHERE app_id = 'tictac'),
  (SELECT array_agg(s ORDER BY s) FROM (SELECT js2_sha AS s FROM pkg UNION ALL SELECT svg_sha FROM pkg) x),
  'the old script is gone');
SELECT is((SELECT version FROM public.activity_apps WHERE id = 'tictac'), '1.1.0', 'the row carries the new version');

SELECT throws_ok($$SELECT public.install_activity_package('11111111-0000-0000-0000-000000000001',
    (SELECT app || '{"id":"drawinphone"}'::jsonb FROM pkg_args), (SELECT files FROM pkg_args))$$,
  'P0001', 'BUILTIN_ID', 'a package cannot take a built-in''s id');
SELECT throws_ok($$SELECT public.install_activity_package('11111111-0000-0000-0000-000000000001',
    (SELECT app || '{"id":"liar"}'::jsonb FROM pkg_args),
    jsonb_build_array(jsonb_build_object('sha256', (SELECT js_sha FROM pkg), 'content_type', 'text/javascript; charset=utf-8', 'base64', encode('x'::bytea, 'base64')),
                      (SELECT files -> 1 FROM pkg_args)))$$,
  '22023', 'file bytes do not match their SHA-256', 'bytes must match their hash');
SELECT throws_ok($$INSERT INTO public.activity_apps (id, name, builtin) VALUES ('bare', 'Bare', false)$$,
  '23514', NULL, 'a package row names its files');

-- Accounts read the catalog row but never the files. -----------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT entry_sha FROM public.activity_apps WHERE id = 'tictac'), encode(sha256('b'::bytea), 'hex'), 'members read the package row');
SELECT throws_ok($$SELECT * FROM public.activity_app_files$$, '42501', NULL, 'members cannot read package files');
SELECT throws_ok($$SELECT public.remove_activity_package('22222222-0000-0000-0000-000000000002', 'tictac')$$,
  '42501', NULL, 'members cannot remove packages');
SELECT tests.clear_authentication();

-- Removal ends sessions. ---------------------------------------------------------------------------
INSERT INTO public.activity_sessions (app_id, context, conversation_id, started_by, host_id)
VALUES ('tictac', 'direct', '77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001');
SELECT is(public.remove_activity_package('11111111-0000-0000-0000-000000000001', 'tictac'), true, 'an admin removes the package');
SELECT is((SELECT count(*)::int FROM public.activity_apps WHERE id = 'tictac') + (SELECT count(*)::int FROM public.activity_app_files WHERE app_id = 'tictac'),
  0, 'its row and files are gone');
SELECT throws_ok($$SELECT public.remove_activity_package('11111111-0000-0000-0000-000000000001', 'drawinphone')$$,
  'P0001', 'BUILTIN_ID', 'a built-in cannot be removed');

SELECT * FROM finish();
ROLLBACK;
