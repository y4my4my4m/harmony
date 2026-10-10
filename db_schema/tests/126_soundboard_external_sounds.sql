-- External sounds after 20261012300001_soundboard_external_sounds.sql.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not, banned is banned. Added:
--   carol   owns Echo (shares its sounds) and Hush (does not); bob is a member of both
--   dave    member of server_1 holding role dj
--   #voice1 server_1 voice channel; @everyone denies USE_EXTERNAL_SOUNDS, dj allows it
--   #voice2 server_1 voice channel; a member override denies it to bob
--   sounds  Ding (server_1), Clap and Boom (Echo), Shh (Hush)

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(41);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f1260000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol126@test.local'),
  ('f1260000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave126@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('f1260000-0000-0000-0000-0000000000c1', 'f1260000-0000-0000-0000-0000000000a1', 'carol126', 'Carol', true),
  ('f1260000-0000-0000-0000-0000000000c2', 'f1260000-0000-0000-0000-0000000000a2', 'dave126', 'Dave', true);
INSERT INTO public.servers (id, name, owner) VALUES
  ('f1263000-0000-0000-0000-000000000002', 'Echo126', 'f1260000-0000-0000-0000-0000000000c1'),
  ('f1263000-0000-0000-0000-000000000003', 'Hush126', 'f1260000-0000-0000-0000-0000000000c1');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1260000-0000-0000-0000-0000000000c1', 'f1263000-0000-0000-0000-000000000002', 'accepted'),
  ('f1260000-0000-0000-0000-0000000000c1', 'f1263000-0000-0000-0000-000000000003', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f1263000-0000-0000-0000-000000000002', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f1263000-0000-0000-0000-000000000003', 'accepted'),
  ('f1260000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'accepted')
ON CONFLICT DO NOTHING;
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1261000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'dj126', 3, 0);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f1260000-0000-0000-0000-0000000000c2', 'f1261000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1262000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'voice126a', 2),
  ('f1262000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'voice126b', 2);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions) VALUES
  ('f1262000-0000-0000-0000-000000000001', 'role',
   (SELECT id FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), NULL,
   0, 2147483648),
  ('f1262000-0000-0000-0000-000000000001', 'role', 'f1261000-0000-0000-0000-000000000001', NULL, 2147483648, 0),
  ('f1262000-0000-0000-0000-000000000002', 'user', NULL, '22222222-0000-0000-0000-000000000002', 0, 2147483648);

INSERT INTO public.server_sounds (id, server_id, name, emoji, volume, duration_ms, storage_path) VALUES
  ('b1260000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'Ding', NULL, 1, 600,
   '55555555-0000-0000-0000-000000000005/a1260000-0000-0000-0000-000000000001.mp3'),
  ('b1260000-0000-0000-0000-000000000002', 'f1263000-0000-0000-0000-000000000002', 'Clap', '👏', 0.6, 1500,
   'f1263000-0000-0000-0000-000000000002/a1260000-0000-0000-0000-000000000002.ogg'),
  ('b1260000-0000-0000-0000-000000000003', 'f1263000-0000-0000-0000-000000000003', 'Shh', NULL, 1, 900,
   'f1263000-0000-0000-0000-000000000003/a1260000-0000-0000-0000-000000000003.mp3'),
  ('b1260000-0000-0000-0000-000000000004', 'f1263000-0000-0000-0000-000000000002', 'Boom', NULL, 1, 2000,
   'f1263000-0000-0000-0000-000000000002/a1260000-0000-0000-0000-000000000004.wav');

CREATE TEMP TABLE audit_seen ON COMMIT DROP AS
SELECT id FROM public.server_audit_log;

-- Permission bit ------------------------------------------------------------------------------
SELECT is(array_length(public.permission_bit_names(), 1), 32, 'the bit map names 32 permissions');
SELECT is((public.permission_bit_names())[32], 'USE_EXTERNAL_SOUNDS', 'USE_EXTERNAL_SOUNDS is bit 31');

INSERT INTO public.servers (id, name, owner) VALUES
  ('f1263000-0000-0000-0000-000000000004', 'Fresh126', '22222222-0000-0000-0000-000000000002');
SELECT is((SELECT permissions FROM public.server_roles
            WHERE server_id = 'f1263000-0000-0000-0000-000000000004' AND is_default),
          3343872258::bigint, 'a new server''s @everyone holds the defaults, USE_SOUNDBOARD and USE_EXTERNAL_SOUNDS');
SELECT is((SELECT permissions FROM public.server_roles
            WHERE server_id = 'f1263000-0000-0000-0000-000000000004' AND is_default) & 1196388610,
          1196388610::bigint, 'the new default extends the 1.7.0 one');

SELECT ok(public.has_permission('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005',
                                'USE_EXTERNAL_SOUNDS'),
          'a member holds USE_EXTERNAL_SOUNDS through @everyone');
SELECT ok(NOT public.has_permission('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005',
                                    'USE_EXTERNAL_SOUNDS', 'f1262000-0000-0000-0000-000000000001'),
          'an @everyone channel deny removes it in that channel');
SELECT ok(public.has_permission('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005',
                                'USE_SOUNDBOARD', 'f1262000-0000-0000-0000-000000000001'),
          'and leaves USE_SOUNDBOARD alone');
SELECT ok(public.has_permission('f1260000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005',
                                'USE_EXTERNAL_SOUNDS', 'f1262000-0000-0000-0000-000000000001'),
          'a role channel allow restores it');
SELECT ok(NOT public.has_permission('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005',
                                    'USE_EXTERNAL_SOUNDS', 'f1262000-0000-0000-0000-000000000002'),
          'a member override denies it');
SELECT ok(public.has_permission('f1260000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005',
                                'USE_EXTERNAL_SOUNDS', 'f1262000-0000-0000-0000-000000000002'),
          'to that member only');
SELECT is(public.get_user_permissions('11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005',
                                      'f1262000-0000-0000-0000-000000000001') ->> 'USE_EXTERNAL_SOUNDS',
          'true', 'the owner holds it everywhere');
SELECT is(public.server_template_bits('"2147483648"'::jsonb, 'p'), 2147483648::bigint,
          'templates carry USE_EXTERNAL_SOUNDS');
SELECT throws_ok($$SELECT public.server_template_bits('"4294967296"'::jsonb, 'p')$$,
                 '22023', NULL, 'templates refuse the bit past it');

-- Convergence on an instance predating the bit ------------------------------------------------
INSERT INTO public.servers (id, name, owner, is_local_server) VALUES
  ('f1264000-0000-0000-0000-000000000001', 'Old126', '11111111-0000-0000-0000-000000000001', true),
  ('f1264000-0000-0000-0000-000000000002', 'Quiet126', '11111111-0000-0000-0000-000000000001', true),
  ('f1264000-0000-0000-0000-000000000003', 'Remote126', '11111111-0000-0000-0000-000000000001', false);
UPDATE public.server_roles SET permissions = 1196388610
 WHERE server_id IN ('f1264000-0000-0000-0000-000000000001', 'f1264000-0000-0000-0000-000000000003') AND is_default;
UPDATE public.server_roles SET permissions = 122646786
 WHERE server_id = 'f1264000-0000-0000-0000-000000000002' AND is_default;
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1261000-0000-0000-0000-000000000002', 'f1264000-0000-0000-0000-000000000001', 'sb126', 2, 1073741824);

-- The bit map as 20261011300001 left it.
CREATE OR REPLACE FUNCTION public.permission_bit_names()
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT ARRAY[
        'ADMINISTRATOR','VIEW_CHANNEL','MANAGE_CHANNELS','MANAGE_ROLES',
        'MANAGE_EMOJIS','VIEW_AUDIT_LOG','MANAGE_WEBHOOKS','MANAGE_SERVER',
        'CREATE_INVITE','KICK_MEMBERS','BAN_MEMBERS','TIMEOUT_MEMBERS',
        'SEND_MESSAGES','SEND_MESSAGES_IN_THREADS','CREATE_PUBLIC_THREADS','CREATE_PRIVATE_THREADS',
        'EMBED_LINKS','ATTACH_FILES','ADD_REACTIONS','USE_EXTERNAL_EMOJIS',
        'MENTION_EVERYONE','MANAGE_MESSAGES','READ_MESSAGE_HISTORY','PIN_MESSAGES',
        'CONNECT','SPEAK','STREAM','MUTE_MEMBERS','DEAFEN_MEMBERS','MOVE_MEMBERS',
        'USE_SOUNDBOARD']
$$;

-- The blocks are read from the migration file at /db_schema/migrations, where
-- scripts/run-db-tests.sh copies db_schema. Absent, the lines below print an ERROR the runner
-- reports.
\! sed -n '/^-- Existing @everyone roles$/,/^\$\$;$/p' /db_schema/migrations/20261012300001_soundboard_external_sounds.sql > /tmp/converge126.sql
\! test -s /tmp/converge126.sql || echo 'ERROR: /db_schema/migrations/20261012300001_soundboard_external_sounds.sql is not in the container; copy db_schema to /db_schema'
\! sed -n '/^CREATE OR REPLACE FUNCTION public.permission_bit_names()$/,/^\$\$;$/p' /db_schema/migrations/20261012300001_soundboard_external_sounds.sql > /tmp/bitnames126.sql
\! test -s /tmp/bitnames126.sql || echo 'ERROR: /db_schema/migrations/20261012300001_soundboard_external_sounds.sql is not in the container; copy db_schema to /db_schema'
\i /tmp/converge126.sql

SELECT is((SELECT permissions FROM public.server_roles
            WHERE server_id = 'f1264000-0000-0000-0000-000000000001' AND is_default),
          3343872258::bigint, 'an @everyone holding USE_SOUNDBOARD gains USE_EXTERNAL_SOUNDS');
SELECT is((SELECT permissions FROM public.server_roles
            WHERE server_id = 'f1264000-0000-0000-0000-000000000002' AND is_default),
          122646786::bigint, 'an @everyone without USE_SOUNDBOARD does not');
SELECT is((SELECT permissions FROM public.server_roles
            WHERE server_id = 'f1264000-0000-0000-0000-000000000003' AND is_default),
          1196388610::bigint, 'nor does a remote server copy''s');
SELECT is((SELECT permissions FROM public.server_roles WHERE id = 'f1261000-0000-0000-0000-000000000002'),
          1073741824::bigint, 'nor any other role');

\i /tmp/bitnames126.sql
UPDATE public.server_roles SET permissions = 1196388610
 WHERE server_id = 'f1264000-0000-0000-0000-000000000001' AND is_default;
\i /tmp/converge126.sql
SELECT is((SELECT permissions FROM public.server_roles
            WHERE server_id = 'f1264000-0000-0000-0000-000000000001' AND is_default),
          1196388610::bigint, 'a rerun leaves a removed bit removed');

-- Sharing setting -----------------------------------------------------------------------------
SELECT tests.authenticate_as('f1260000-0000-0000-0000-0000000000a1');
SELECT is(public.set_server_sound_sharing('f1263000-0000-0000-0000-000000000003', false), false,
          'a sound manager stops sharing the server''s sounds');
SELECT tests.clear_authentication();
SELECT is((SELECT allow_cross_server_sounds FROM public.server_settings
            WHERE server_id = 'f1263000-0000-0000-0000-000000000003'), false, 'the setting is stored');
SELECT is((SELECT changes -> 'allow_cross_server_sounds' FROM public.server_audit_log
            WHERE action = 'settings.update' AND server_id = 'f1263000-0000-0000-0000-000000000003'
              AND actor_id = 'f1260000-0000-0000-0000-0000000000c1'
              AND id NOT IN (SELECT id FROM audit_seen)),
          '{"new": false}'::jsonb, 'the change is audited');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$SELECT public.set_server_sound_sharing('f1263000-0000-0000-0000-000000000002', false)$$,
                 '42501', NULL, 'a plain member cannot change it');
SELECT tests.authenticate_as('f1260000-0000-0000-0000-0000000000a1');
SELECT throws_ok($$SELECT public.set_server_sound_sharing('f1263000-0000-0000-0000-000000000002', NULL)$$,
                 '22023', NULL, 'the setting is true or false');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($$SELECT public.set_server_sound_sharing('f1263000-0000-0000-0000-000000000002', false)$$,
                 '42501', NULL, 'anon cannot change it');

-- Library -------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT results_eq(
    $q$SELECT server_id, server_name, name FROM public.list_soundboard_library()$q$,
    $q$VALUES ('f1263000-0000-0000-0000-000000000002'::uuid, 'Echo126'::text, 'Clap'::text),
              ('f1263000-0000-0000-0000-000000000002'::uuid, 'Echo126'::text, 'Boom'::text),
              ('55555555-0000-0000-0000-000000000005'::uuid, 'Test Server'::text, 'Ding'::text)$q$,
    'a member''s library holds the sounds of every server they belong to that shares them');
SELECT results_eq(
    $q$SELECT emoji, volume, duration_ms, storage_path FROM public.list_soundboard_library()
        WHERE id = 'b1260000-0000-0000-0000-000000000002'$q$,
    $q$VALUES ('👏'::text, 0.60::numeric, 1500, 'f1263000-0000-0000-0000-000000000002/a1260000-0000-0000-0000-000000000002.ogg'::text)$q$,
    'with what playing needs');

SELECT tests.authenticate_as('f1260000-0000-0000-0000-0000000000a1');
SELECT is((SELECT array_agg(DISTINCT server_id) FROM public.list_soundboard_library()),
          ARRAY['f1263000-0000-0000-0000-000000000002'::uuid],
          'an owner''s library leaves out the server they stopped sharing');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty($q$SELECT id FROM public.list_soundboard_library()$q$, 'a member of no server has no library');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is_empty($q$SELECT id FROM public.list_soundboard_library()$q$, 'nor does a banned member');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($$SELECT * FROM public.list_soundboard_library()$$, '42501', NULL, 'anon has no library');

-- Resolver ------------------------------------------------------------------------------------
-- mallory is a member of no server.
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT results_eq(
    $q$SELECT id, server_id, name, emoji, volume, duration_ms, storage_path
         FROM public.resolve_soundboard_sound('b1260000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005')$q$,
    $q$VALUES ('b1260000-0000-0000-0000-000000000002'::uuid, 'f1263000-0000-0000-0000-000000000002'::uuid, 'Clap'::text,
               '👏'::text, 0.60::numeric, 1500,
               'f1263000-0000-0000-0000-000000000002/a1260000-0000-0000-0000-000000000002.ogg'::text)$q$,
    'a listener outside the sound''s server resolves a shared sound');
SELECT is_empty(
    $q$SELECT id FROM public.server_sounds WHERE id = 'b1260000-0000-0000-0000-000000000002'$q$,
    'which the table itself does not show them');
SELECT is_empty(
    $q$SELECT id FROM public.resolve_soundboard_sound('b1260000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005')$q$,
    'an unshared server''s sound does not resolve elsewhere');
SELECT is_empty(
    $q$SELECT id FROM public.resolve_soundboard_sound('b1260000-0000-0000-0000-000000000003', 'f1263000-0000-0000-0000-000000000003')$q$,
    'nor in its own server for a non-member');
SELECT is_empty(
    $q$SELECT id FROM public.resolve_soundboard_sound('b1260000-0000-0000-0000-0000000000ff', '55555555-0000-0000-0000-000000000005')$q$,
    'an unknown sound resolves to nothing');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT name FROM public.resolve_soundboard_sound('b1260000-0000-0000-0000-000000000003', 'f1263000-0000-0000-0000-000000000003')),
          'Shh', 'an unshared server''s sound resolves for its members in its own server');
SELECT is_empty(
    $q$SELECT id FROM public.resolve_soundboard_sound('b1260000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005')$q$,
    'but not for a play in another server, even to a member');
SELECT is((SELECT name FROM public.resolve_soundboard_sound('b1260000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005')),
          'Ding', 'a server''s own sound resolves in its own server');

SELECT tests.clear_authentication();
DELETE FROM public.server_sounds WHERE id = 'b1260000-0000-0000-0000-000000000004';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty(
    $q$SELECT id FROM public.resolve_soundboard_sound('b1260000-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005')$q$,
    'a deleted sound resolves to nothing');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $$SELECT * FROM public.resolve_soundboard_sound('b1260000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005')$$,
    '42501', NULL, 'anon resolves nothing');

SELECT tests.clear_authentication();
SELECT is((SELECT count(*) FROM jsonb_object_keys(
              public.get_user_permissions('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005'))),
          32::bigint, 'get_user_permissions answers every named bit');

SELECT * FROM finish();
ROLLBACK;
