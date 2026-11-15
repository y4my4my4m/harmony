-- 20261112300001_bridge_sticker_sync.sql: the Discord bridge bot of a server imports, updates,
-- restores and retires server stickers (bridge_import_server_sticker, bridge_retire_server_sticker);
-- a retired sticker leaves the cap, the name index, the upload folder count, client reads and new
-- messages, and still answers existing_sticker_ids.
--
--   server_1 (55555555-...05)  bridged by bot b1; alice owns it, bob is a member
--   bot b2                     bridge bot of no server
--   server f2700000-...02      another server, with one sticker 270e0000-...99
--
-- Objects in bucket stickers (server_1 folder, 270e0000-0000-4000-8000-0000000000NN.png):
--   01..07 png, 08 gif (10 and 11 are inserted by the folder test)
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(61);

INSERT INTO public.bots (id, username, display_name, owner_id, bot_type) VALUES
  ('27000000-0000-0000-0000-0000000000b1', 'discord-bridge-270', 'Discord Bridge', '11111111-0000-0000-0000-000000000001', 'bridge'),
  ('27000000-0000-0000-0000-0000000000b2', 'other-bot-270', 'Other', '11111111-0000-0000-0000-000000000001', 'bridge');
INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
VALUES ('55555555-0000-0000-0000-000000000005', '27000000-0000-0000-0000-0000000000b1', 'instance',
        '900000000000000270', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.servers (id, name, owner)
VALUES ('f2700000-0000-0000-0000-000000000002', 'Server 270', '22222222-0000-0000-0000-000000000002');

INSERT INTO storage.objects (bucket_id, name, metadata)
SELECT 'stickers', 'server/55555555-0000-0000-0000-000000000005/270e0000-0000-4000-8000-0000000000' || p.n || '.' || p.ext,
       jsonb_build_object('size', 1000, 'mimetype', p.mime)
  FROM (VALUES ('01', 'png', 'image/png'), ('02', 'png', 'image/png'), ('03', 'png', 'image/png'),
               ('04', 'png', 'image/png'), ('05', 'png', 'image/png'), ('06', 'png', 'image/png'),
               ('07', 'png', 'image/png'), ('08', 'gif', 'image/gif')) p(n, ext, mime);

INSERT INTO public.stickers (id, scope, server_id, name, description, path, url, mime_type, file_size, width, height,
                             discord_sticker_id)
VALUES ('270e0000-0000-0000-0000-000000000099', 'server', 'f2700000-0000-0000-0000-000000000002', 'foreign',
        'Another server''s', 'server/f2700000-0000-0000-0000-000000000002/270e0000-0000-4000-8000-000000000099.png',
        'https://db.test/storage/v1/object/public/stickers/server/f2700000-0000-0000-0000-000000000002/270e0000-0000-4000-8000-000000000099.png',
        'image/png', 1000, 64, 64, '7999');

INSERT INTO public.instance_config (config_key, config_value) VALUES ('storage_origin', '"https://db.test/"')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

CREATE FUNCTION pg_temp.url(p_path text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'https://db.test/storage/v1/object/public/stickers/' || p_path $$;
CREATE FUNCTION pg_temp.srv(p_n text, p_ext text DEFAULT 'png') RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT 'server/55555555-0000-0000-0000-000000000005/270e0000-0000-4000-8000-0000000000' || p_n || '.' || p_ext $$;
CREATE FUNCTION pg_temp.set_cap(p_value integer) RETURNS void LANGUAGE sql AS
  $$ UPDATE public.instance_config SET config_value = to_jsonb(p_value) WHERE config_key = 'max_stickers_per_server' $$;
CREATE FUNCTION pg_temp.active() RETURNS integer LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.stickers WHERE server_id = '55555555-0000-0000-0000-000000000005' AND removed_at IS NULL $$;
-- The id of the server_1 sticker linked to Discord sticker p_did.
CREATE FUNCTION pg_temp.sid(p_did text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.stickers WHERE server_id = '55555555-0000-0000-0000-000000000005' AND discord_sticker_id = p_did $$;
-- The bridge call; p_n names the uploaded file (NULL: no file).
CREATE FUNCTION pg_temp.imp(p_did text, p_name text, p_desc text DEFAULT 'A sticker', p_update boolean DEFAULT false,
                            p_n text DEFAULT NULL, p_bot uuid DEFAULT '27000000-0000-0000-0000-0000000000b1')
RETURNS TABLE(status text, id uuid, name text, description text, url text, discord_sticker_id text, removed boolean)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.bridge_import_server_sticker(p_bot, '55555555-0000-0000-0000-000000000005',
    p_did, p_name, p_desc, p_update,
    CASE WHEN p_n IS NOT NULL THEN pg_temp.srv(p_n) END,
    CASE WHEN p_n IS NOT NULL THEN pg_temp.url(pg_temp.srv(p_n)) END,
    CASE WHEN p_n IS NOT NULL THEN 128 END, CASE WHEN p_n IS NOT NULL THEN 96 END, NULL);
END;
$$;
CREATE FUNCTION pg_temp.retire(p_id uuid, p_bot uuid DEFAULT '27000000-0000-0000-0000-0000000000b1')
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.bridge_retire_server_sticker(p_bot, '55555555-0000-0000-0000-000000000005', p_id);
END;
$$;
-- A sticker part (and its image) naming sticker p_id, of file p_n.
CREATE FUNCTION pg_temp.part(p_id uuid, p_n text, p_name text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('type', 'sticker', 'id', p_id::text, 'url', pg_temp.url(pg_temp.srv(p_n)),
                       'name', p_name, 'description', 'A sticker'),
    jsonb_build_object('type', 'file', 'fileType', 'image', 'url', pg_temp.url(pg_temp.srv(p_n)),
                       'stickerId', p_id::text, 'altText', 'A sticker'))
$$;
CREATE FUNCTION pg_temp.msg(p_text text, p_parts jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.messages (channel_id, user_id, content)
  VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
          jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text)) || p_parts)
$$;
-- A manager's create_sticker, as alice.
CREATE FUNCTION pg_temp.create_as_owner(p_n text, p_name text) RETURNS text LANGUAGE sql AS $$
  SELECT name FROM public.create_sticker('server', '55555555-0000-0000-0000-000000000005', pg_temp.srv(p_n),
         pg_temp.url(pg_temp.srv(p_n)), p_name, 'A cat waving', 128, 128)
$$;

CREATE TEMP TABLE r (status text, id uuid, name text, description text, url text, discord_sticker_id text, removed boolean);
GRANT ALL ON r TO PUBLIC;

-- Grants. -----------------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated',
  'public.bridge_import_server_sticker(uuid, uuid, text, text, text, boolean, text, text, integer, integer, integer)', 'EXECUTE'),
  'authenticated cannot import');
SELECT ok(NOT has_function_privilege('anon',
  'public.bridge_import_server_sticker(uuid, uuid, text, text, text, boolean, text, text, integer, integer, integer)', 'EXECUTE'),
  'anon cannot import');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.bridge_retire_server_sticker(uuid, uuid, uuid)', 'EXECUTE'), 'authenticated cannot retire');
SELECT ok(NOT has_function_privilege('anon',
  'public.bridge_retire_server_sticker(uuid, uuid, uuid)', 'EXECUTE'), 'anon cannot retire');
SELECT ok(NOT has_column_privilege('authenticated', 'public.stickers', 'removed_at', 'SELECT')
          AND NOT has_column_privilege('anon', 'public.stickers', 'discord_sticker_id', 'SELECT'),
  'clients read neither new column');

-- Authority and input. ----------------------------------------------------------------------------
SELECT throws_ok($$SELECT * FROM pg_temp.imp('7001', 'Wave', 'Waves', false, '01',
  '27000000-0000-0000-0000-0000000000b2')$$, '42501', NULL, 'a bot that does not bridge the server cannot import');
SELECT throws_ok($$SELECT pg_temp.retire('270e0000-0000-0000-0000-000000000099',
  '27000000-0000-0000-0000-0000000000b2')$$, '42501', NULL, 'a bot that does not bridge the server cannot retire');
SELECT throws_ok($$SELECT * FROM pg_temp.imp('seven', 'Wave', 'Waves', false, '01')$$,
  '22023', 'invalid Discord sticker id', 'a Discord id that is not digits is refused');
SELECT throws_ok($$SELECT * FROM pg_temp.imp('7001', 'Wave', '', false, '01')$$,
  '22023', NULL, 'an empty description is refused');
SELECT throws_ok($$SELECT * FROM pg_temp.imp('7001', 'Wave', 'Waves')$$,
  '22023', 'invalid sticker file', 'creating without a file asks for one');

-- File checks. ------------------------------------------------------------------------------------
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_sticker('27000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '7001', 'Wave', 'Waves', false,
  'server/f2700000-0000-0000-0000-000000000002/270e0000-0000-4000-8000-000000000001.png',
  pg_temp.url('server/f2700000-0000-0000-0000-000000000002/270e0000-0000-4000-8000-000000000001.png'), 64, 64, NULL)$$,
  '22023', NULL, 'a file outside the server''s folder is refused');
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_sticker('27000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '7001', 'Wave', 'Waves', false,
  pg_temp.srv('01'), pg_temp.url(pg_temp.srv('02')), 64, 64, NULL)$$,
  '22023', NULL, 'a url of another object is refused');
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_sticker('27000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '7001', 'Wave', 'Waves', false,
  pg_temp.srv('01'), pg_temp.url(pg_temp.srv('01')), 321, 64, NULL)$$,
  '22023', NULL, 'a 321 px wide sticker is refused');
SELECT throws_ok($$SELECT * FROM public.bridge_import_server_sticker('27000000-0000-0000-0000-0000000000b1',
  '55555555-0000-0000-0000-000000000005', '7001', 'Wave', 'Waves', false,
  pg_temp.srv('09'), pg_temp.url(pg_temp.srv('09')), 64, 64, NULL)$$,
  '22023', NULL, 'a file missing from the bucket is refused');
SELECT is((SELECT count(*)::int FROM public.stickers WHERE server_id = '55555555-0000-0000-0000-000000000005'),
  0, 'refusals create nothing');

-- Create, existing, update. -----------------------------------------------------------------------
INSERT INTO r SELECT * FROM pg_temp.imp('7001', 'Wave', 'Waves', false, '01');
SELECT is((SELECT status FROM r), 'created', 'a Discord sticker with a file is created');
SELECT is((SELECT (s.discord_sticker_id, s.uploader, s.scope, s.name, s.description, s.mime_type, s.width, s.height,
                   s.removed_at)::text
             FROM public.stickers s WHERE s.id = (SELECT id FROM r)),
  '(7001,,server,Wave,Waves,image/png,128,96,)', 'it is linked, has no uploader, takes its type from the object and is active');
SELECT is((SELECT count(*)::int FROM r WHERE description = 'Waves' AND discord_sticker_id = '7001' AND NOT removed),
  1, 'the row is returned');

TRUNCATE r;
INSERT INTO r SELECT * FROM pg_temp.imp('7001', 'Other', 'Else', false, '01');
SELECT is((SELECT status FROM r), 'existing', 'the same Discord sticker again is existing, even with other text');
SELECT is((SELECT name FROM public.stickers WHERE discord_sticker_id = '7001' AND server_id = '55555555-0000-0000-0000-000000000005'),
  'Wave', 'and the row is untouched without p_update');

TRUNCATE r;
INSERT INTO r SELECT * FROM pg_temp.imp('7001', 'Wave', 'Waves hello', true);
SELECT is((SELECT status FROM r), 'updated', 'p_update with a new description updates');
SELECT is((SELECT description FROM public.stickers WHERE id = pg_temp.sid('7001')), 'Waves hello',
  'the new description is stored');
TRUNCATE r;
INSERT INTO r SELECT * FROM pg_temp.imp('7001', 'Wave', 'Waves hello', true);
SELECT is((SELECT status FROM r), 'existing', 'an identical p_update call is existing');

SELECT set_config('t270.wave', pg_temp.sid('7001')::text, true);

-- Retire. -----------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.stickers WHERE id = current_setting('t270.wave')::uuid), 1,
  'a member reads an active sticker');
SELECT tests.clear_authentication();

SELECT is(pg_temp.retire(current_setting('t270.wave')::uuid), 'removed', 'an active sticker is retired');
SELECT ok((SELECT removed_at IS NOT NULL FROM public.stickers WHERE id = current_setting('t270.wave')::uuid),
  'removed_at is set');
SELECT is(pg_temp.retire(current_setting('t270.wave')::uuid), 'existing', 'retiring again is existing');
SELECT throws_ok($$SELECT pg_temp.retire('270e0000-0000-0000-0000-000000000099')$$,
  'P0002', NULL, 'a sticker of another server is not found');

SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE action = 'sticker.delete' AND target_id = current_setting('t270.wave')),
  1, 'a retirement writes one sticker.delete');
INSERT INTO public.bot_audit_log (bot_id, action_type, success, metadata)
VALUES ('27000000-0000-0000-0000-0000000000b1', 'sticker_removed', true,
        jsonb_build_object('serverId', '55555555-0000-0000-0000-000000000005', 'stickerId', current_setting('t270.wave')));
SELECT is((SELECT source || ' ' || actor_bot_id::text FROM public.server_audit_log
            WHERE action = 'sticker.delete' AND target_id = current_setting('t270.wave')),
  'bot 27000000-0000-0000-0000-0000000000b1', 'a bridge retirement is attributed to the bot');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.stickers WHERE id = current_setting('t270.wave')::uuid), 0,
  'a member no longer reads the retired sticker');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.existing_sticker_ids(ARRAY[current_setting('t270.wave')::uuid])), 1,
  'existing_sticker_ids still answers it');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($$SELECT public.update_sticker(current_setting('t270.wave')::uuid, 'Renamed')$$,
  'P0002', 'Sticker not found', 'the owner cannot update a retired sticker');
SELECT tests.clear_authentication();

-- Cap counts active stickers only. ----------------------------------------------------------------
TRUNCATE r;
INSERT INTO r SELECT * FROM pg_temp.imp('7002', 'Second', 'Two', false, '02');
SELECT is((SELECT status FROM r), 'created', 'a second sticker is created beside the retired one');
SELECT set_config('t270.second', (SELECT id::text FROM r), true);
SELECT lives_ok($$SELECT pg_temp.msg('sticker 270', pg_temp.part(current_setting('t270.second')::uuid, '02', 'Second'))$$,
  'a message carries the active sticker');
SELECT pg_temp.set_cap(pg_temp.active() + 1);
TRUNCATE r;
INSERT INTO r SELECT * FROM pg_temp.imp('7003', 'Third', 'Three', false, '03');
SELECT is((SELECT status FROM r), 'created', 'with the cap one above the active count, the next create succeeds');
SELECT throws_ok($$SELECT * FROM pg_temp.imp('7004', 'Fourth', 'Four', false, '04')$$,
  '23514', NULL, 'creating at the cap is refused');
SELECT throws_ok($$SELECT * FROM pg_temp.imp('7001', 'Wave', 'Waves hello', true)$$,
  '23514', 'STICKER_LIMIT: at most ' || public.sticker_limit('server') || ' server stickers',
  'restoring at the cap is refused');
SELECT ok((SELECT removed_at IS NOT NULL FROM public.stickers WHERE id = current_setting('t270.wave')::uuid),
  'and the sticker stays retired');
SELECT pg_temp.set_cap(15);

-- Names. ------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(pg_temp.create_as_owner('05', 'WAVE'), 'WAVE', 'an owner creates a sticker with a retired sticker''s name');
SELECT tests.clear_authentication();

SELECT is(pg_temp.retire(current_setting('t270.second')::uuid), 'removed', 'a second sticker is retired');
TRUNCATE r;
INSERT INTO r SELECT * FROM pg_temp.imp('7006', 'second', 'Six', false, '06');
SELECT is((SELECT status FROM r), 'created', 'the bridge creates a sticker with a retired sticker''s name');

SELECT throws_ok($$SELECT * FROM pg_temp.imp('7001', 'Wave', 'Waves hello', true)$$,
  '23505', NULL, 'restoring is refused while another active sticker holds the name');
SELECT throws_ok($$SELECT * FROM pg_temp.imp('7006', 'WAVE', 'Six', true)$$,
  '23505', NULL, 'renaming onto an active sticker''s name is refused');

-- Messages. ---------------------------------------------------------------------------------------
SELECT throws_ok($$SELECT pg_temp.msg('new 270', pg_temp.part(current_setting('t270.second')::uuid, '02', 'Second'))$$,
  '22023', 'STICKER_UNKNOWN: a sticker part names a sticker of this instance by id and url',
  'a new message cannot carry a retired sticker');
SELECT lives_ok($$UPDATE public.messages SET content = jsonb_set(content, '{0,text}', '"edited 270"')
                   WHERE content @> '[{"text": "sticker 270"}]'$$,
  'a message whose unchanged sticker part names a retired sticker is still edited');
SELECT lives_ok($$UPDATE public.messages SET content = jsonb_set(content, '{1}', (content -> 1) - 'width' - 'height' - 'mimeType')
                   WHERE content @> '[{"text": "edited 270"}]'$$,
  'an edit may resend the unchanged sticker part without width, height and mimeType');
SELECT is((SELECT jsonb_build_array(content -> 1 -> 'width', content -> 1 -> 'height', content -> 1 -> 'mimeType')
             FROM public.messages WHERE content @> '[{"text": "edited 270"}]'),
  '[128, 96, "image/png"]'::jsonb, 'and the stored part keeps them');
SELECT throws_ok($$UPDATE public.messages
                      SET content = jsonb_set(content, '{1,name}', '"Renamed"')
                    WHERE content @> '[{"text": "edited 270"}]'$$,
  '22023', 'STICKER_UNKNOWN: a sticker part names a sticker of this instance by id and url',
  'an edit that changes the retired sticker''s part is refused');

-- Folder room. ------------------------------------------------------------------------------------
SELECT set_config('t270.retired', (SELECT count(*)::text FROM public.stickers
                                    WHERE removed_at IS NOT NULL
                                      AND starts_with(path, 'server/55555555-0000-0000-0000-000000000005/')), true);
SELECT is(current_setting('t270.retired')::int, 2, 'two server_1 stickers are retired');
-- The cap that makes the folder's object count equal cap + 2 + retired - 1.
SELECT pg_temp.set_cap((SELECT count(*)::int FROM storage.objects
                         WHERE bucket_id = 'stickers' AND starts_with(name, 'server/55555555-0000-0000-0000-000000000005/'))
                       - current_setting('t270.retired')::int - 1);
SELECT ok(public.sticker_folder_has_room(pg_temp.srv('10'), 'server'),
  'a folder at cap + 2 + retired - 1 objects takes one more upload');
INSERT INTO storage.objects (bucket_id, name, metadata)
VALUES ('stickers', pg_temp.srv('10'), '{"size": 1000, "mimetype": "image/png"}');
SELECT ok(NOT public.sticker_folder_has_room(pg_temp.srv('11'), 'server'),
  'and none at cap + 2 + retired');
SELECT pg_temp.set_cap(15);

-- Restore. ----------------------------------------------------------------------------------------
SELECT set_config('t270.updates_before', (SELECT count(*)::text FROM public.server_audit_log
                                           WHERE action = 'sticker.update' AND target_id = current_setting('t270.wave')), true);
TRUNCATE r;
INSERT INTO r SELECT * FROM pg_temp.imp('7001', 'Waved', 'Waves hello', true);
SELECT is((SELECT status FROM r), 'updated', 'p_update restores a retired sticker under a free name');
SELECT is((SELECT (s.removed_at IS NULL, s.name)::text FROM public.stickers s WHERE s.id = current_setting('t270.wave')::uuid),
  '(t,Waved)', 'removed_at is cleared and the new name is stored');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE action = 'sticker.create' AND target_id = current_setting('t270.wave')),
  2, 'a restore writes sticker.create');
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE action = 'sticker.update' AND target_id = current_setting('t270.wave')),
  current_setting('t270.updates_before')::int, 'and no sticker.update, even though the name changed with it');
INSERT INTO public.bot_audit_log (bot_id, action_type, success, metadata)
VALUES ('27000000-0000-0000-0000-0000000000b1', 'sticker_updated', true,
        jsonb_build_object('serverId', '55555555-0000-0000-0000-000000000005', 'stickerId', current_setting('t270.wave')));
SELECT is((SELECT count(*)::int FROM public.server_audit_log
            WHERE action IN ('sticker.update', 'sticker.create') AND target_id = current_setting('t270.wave')
              AND source = 'bot' AND actor_bot_id = '27000000-0000-0000-0000-0000000000b1'),
  (SELECT count(*)::int FROM public.server_audit_log
    WHERE action IN ('sticker.update', 'sticker.create') AND target_id = current_setting('t270.wave')),
  'sticker_updated attributes the update and create rows of the sticker to the bot');
INSERT INTO public.bot_audit_log (bot_id, action_type, success, metadata)
VALUES ('27000000-0000-0000-0000-0000000000b1', 'sticker_imported', true,
        jsonb_build_object('serverId', '55555555-0000-0000-0000-000000000005', 'stickerId', pg_temp.sid('7006')::text));
SELECT is((SELECT source || ' ' || actor_bot_id::text FROM public.server_audit_log
            WHERE action = 'sticker.create' AND target_id = pg_temp.sid('7006')::text),
  'bot 27000000-0000-0000-0000-0000000000b1', 'sticker_imported attributes the create row to the bot');

-- Retire and restore once more. ------------------------------------------------------------------
SELECT is(pg_temp.retire(current_setting('t270.wave')::uuid), 'removed', 'the restored sticker is retired again');
TRUNCATE r;
INSERT INTO r SELECT * FROM pg_temp.imp('7001', 'Waved', 'Waves hello', true);
SELECT is((SELECT status || ' ' || removed::text FROM r), 'updated false', 'restoring with unchanged text is updated');
TRUNCATE r;
INSERT INTO r SELECT * FROM pg_temp.imp('7001', 'Waved', 'Waves hello', true);
SELECT is((SELECT status FROM r), 'existing', 'and then existing');

SELECT * FROM finish();
ROLLBACK;
