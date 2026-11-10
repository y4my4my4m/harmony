-- 20261109900001_channel_host_flags.sql: a copy's host flags, encrypted voice closed to other
-- instances, and the signals a change of either sends.
--
--   alice   owns server S (local, federated)   bob  accepted member
--   rita    remote profile, accepted member    tom  remote profile, not a member
--
--   S: general (text), lounge, annex, vault (voice), plans (category)
--   vault: @everyone Deny VIEW_CHANNEL
--   X: local, not federated, with x-voice      R: a remote server's copy, with r-voice
--
-- queue_federation_job is replaced for the transaction by a stub that records its calls.
--
-- Bits: VIEW_CHANNEL 1 << 1, CONNECT 1 << 24, SPEAK 1 << 25, STREAM 1 << 26.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(45);

CREATE TEMP TABLE queued (name text, data jsonb);
GRANT ALL ON queued TO authenticated, service_role;
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE sql AS $fn$
  INSERT INTO pg_temp.queued (name, data) VALUES (p_job_name, p_job_data);
  SELECT gen_random_uuid();
$fn$;

INSERT INTO public.profiles (id, username, display_name, is_local, federated_id, domain) VALUES
  ('f2530000-0000-0000-0000-000000000001', 'rita253', 'Rita', false, 'https://remote253.test/users/rita', 'remote253.test'),
  ('f2530000-0000-0000-0000-000000000002', 'tom253', 'Tom', false, 'https://remote253.test/users/tom', 'remote253.test');

INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, ap_id) VALUES
  ('f2531000-0000-0000-0000-000000000001', 'Flags', '11111111-0000-0000-0000-000000000001', true, true, NULL),
  ('f2531000-0000-0000-0000-000000000002', 'Closed', '11111111-0000-0000-0000-000000000001', true, false, NULL),
  ('f2531000-0000-0000-0000-000000000003', 'Copy', 'f2530000-0000-0000-0000-000000000001', false, true,
   'https://remote253.test/servers/f2531000-0000-0000-0000-000000000003');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2531000-0000-0000-0000-000000000001', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f2531000-0000-0000-0000-000000000001', 'accepted'),
  ('f2530000-0000-0000-0000-000000000001', 'f2531000-0000-0000-0000-000000000001', 'accepted')
ON CONFLICT DO NOTHING;
INSERT INTO public.server_roles (server_id, name, position, permissions, is_default)
SELECT 'f2531000-0000-0000-0000-000000000001', '@everyone', 0, 2 | 16777216 | 33554432 | 67108864, true
 WHERE NOT EXISTS (SELECT 1 FROM public.server_roles
                    WHERE server_id = 'f2531000-0000-0000-0000-000000000001' AND is_default);
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f2532000-0000-0000-0000-000000000001', 'f2531000-0000-0000-0000-000000000001', 'staff', 1, 0);

INSERT INTO public.channel_categories (id, server_id, name, "order") VALUES
  ('f2534000-0000-0000-0000-000000000001', 'f2531000-0000-0000-0000-000000000001', 'plans', 0);
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f2533000-0000-0000-0000-000000000001', 'f2531000-0000-0000-0000-000000000001', 'general', 0),
  ('f2533000-0000-0000-0000-000000000002', 'f2531000-0000-0000-0000-000000000001', 'lounge', 1),
  ('f2533000-0000-0000-0000-000000000003', 'f2531000-0000-0000-0000-000000000001', 'annex', 1),
  ('f2533000-0000-0000-0000-000000000004', 'f2531000-0000-0000-0000-000000000001', 'vault', 1),
  ('f2533000-0000-0000-0000-000000000005', 'f2531000-0000-0000-0000-000000000002', 'x-voice', 1);
INSERT INTO public.channels (id, server_id, name, type, is_remote) VALUES
  ('f2533000-0000-0000-0000-000000000006', 'f2531000-0000-0000-0000-000000000003', 'r-voice', 1, true);

CREATE FUNCTION pg_temp.everyone() RETURNS uuid LANGUAGE sql AS $fn$
  SELECT id FROM public.server_roles WHERE server_id = 'f2531000-0000-0000-0000-000000000001' AND is_default;
$fn$;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
VALUES ('f2533000-0000-0000-0000-000000000004', 'role', pg_temp.everyone(), 0, 2);

CREATE FUNCTION pg_temp.flags(p_channel uuid) RETURNS text LANGUAGE sql AS $fn$
  SELECT CASE WHEN f.messages THEN 'M' ELSE '-' END || CASE WHEN f.voice THEN 'V' ELSE '-' END
      || CASE WHEN f.is_private THEN 'P' ELSE '-' END
    FROM public.channel_host_flags(ARRAY[p_channel]) f;
$fn$;
CREATE FUNCTION pg_temp.grant_reason(p_channel uuid, p_user uuid) RETURNS text LANGUAGE sql AS $fn$
  SELECT COALESCE(g.reason, 'admitted') FROM public.voice_participant_grants(ARRAY[p_channel], ARRAY[p_user]) g;
$fn$;
CREATE FUNCTION pg_temp.resyncs() RETURNS text LANGUAGE sql AS $fn$
  SELECT COALESCE(string_agg(COALESCE(right(channel_id::text, 1), '*') || '/' || COALESCE(left(user_id::text, 8), '*'), ','
                             ORDER BY channel_id NULLS FIRST), '')
    FROM public.voice_grant_resyncs WHERE server_id = 'f2531000-0000-0000-0000-000000000001';
$fn$;
CREATE FUNCTION pg_temp.jobs() RETURNS text LANGUAGE sql AS $fn$
  SELECT COALESCE(string_agg(DISTINCT name || ':' || (data ->> 'type') || ':'
                             || right(COALESCE(data ->> 'channel_id', data ->> 'category_id'), 1), ','), '')
    FROM pg_temp.queued;
$fn$;

-- Columns and the client write guard. ---------------------------------------------------------
SELECT col_not_null('public', 'channels', 'host_flags', 'channels.host_flags is not null');
SELECT col_not_null('public', 'channel_categories', 'host_flags', 'channel_categories.host_flags is not null');
SELECT is((SELECT host_flags FROM public.channels WHERE id = 'f2533000-0000-0000-0000-000000000006'),
          '{}'::jsonb, 'a new row holds no flag');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.channels SET host_flags = '{"voice": true}', description = 'edited'
 WHERE id = 'f2533000-0000-0000-0000-000000000001';
SELECT is((SELECT host_flags FROM public.channels WHERE id = 'f2533000-0000-0000-0000-000000000001'),
          '{}'::jsonb, 'a client update of a channel leaves host_flags');
SELECT is((SELECT description FROM public.channels WHERE id = 'f2533000-0000-0000-0000-000000000001'),
          'edited', 'and writes the rest');
INSERT INTO public.channels (id, server_id, name, type, host_flags) VALUES
  ('f2533000-0000-0000-0000-000000000007', 'f2531000-0000-0000-0000-000000000001', 'forged', 0, '{"private": true}');
SELECT is((SELECT host_flags FROM public.channels WHERE id = 'f2533000-0000-0000-0000-000000000007'),
          '{}'::jsonb, 'a client insert of a channel holds no flag');
UPDATE public.channel_categories SET host_flags = '{"private": true}', name = 'renamed'
 WHERE id = 'f2534000-0000-0000-0000-000000000001';
SELECT is((SELECT host_flags FROM public.channel_categories WHERE id = 'f2534000-0000-0000-0000-000000000001'),
          '{}'::jsonb, 'a client update of a category leaves host_flags');
SELECT is((SELECT name FROM public.channel_categories WHERE id = 'f2534000-0000-0000-0000-000000000001'),
          'renamed', 'and writes the rest');
INSERT INTO public.channel_categories (id, server_id, name, "order", host_flags) VALUES
  ('f2534000-0000-0000-0000-000000000002', 'f2531000-0000-0000-0000-000000000001', 'forged', 1, '{"private": true}');
SELECT is((SELECT host_flags FROM public.channel_categories WHERE id = 'f2534000-0000-0000-0000-000000000002'),
          '{}'::jsonb, 'a client insert of a category holds no flag');

SELECT throws_ok($q$SELECT public.channel_voice_encrypted('f2533000-0000-0000-0000-000000000002')$q$,
                 '42501', NULL, 'channel_voice_encrypted is internal');
SELECT throws_ok($q$SELECT * FROM public.channel_host_flags(ARRAY['f2533000-0000-0000-0000-000000000002']::uuid[])$q$,
                 '42501', NULL, 'as is channel_host_flags');
SELECT throws_ok($q$SELECT * FROM public.category_host_flags(ARRAY['f2534000-0000-0000-0000-000000000001']::uuid[])$q$,
                 '42501', NULL, 'and category_host_flags');
SELECT tests.clear_authentication();

UPDATE public.channels SET host_flags = '{"voice": true}' WHERE id = 'f2533000-0000-0000-0000-000000000006';
SELECT is((SELECT host_flags FROM public.channels WHERE id = 'f2533000-0000-0000-0000-000000000006'),
          '{"voice": true}'::jsonb, 'a server-side write stores host_flags');

-- The values a document carries. --------------------------------------------------------------
SELECT is(pg_temp.flags('f2533000-0000-0000-0000-000000000002'), '---', 'no setting, no flag');
SELECT is(pg_temp.flags('f2533000-0000-0000-0000-000000000004'), '--P', 'an @everyone VIEW_CHANNEL deny is private');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions) VALUES
  ('f2533000-0000-0000-0000-000000000002', 'role', pg_temp.everyone(), 0, 16777216),
  ('f2533000-0000-0000-0000-000000000003', 'role', 'f2532000-0000-0000-0000-000000000001', 0, 2);
SELECT is(pg_temp.flags('f2533000-0000-0000-0000-000000000002'), '---', 'an @everyone deny of CONNECT alone is not');
SELECT is(pg_temp.flags('f2533000-0000-0000-0000-000000000003'), '---', 'nor a deny on another role');
DELETE FROM public.channel_permission_overrides
 WHERE channel_id IN ('f2533000-0000-0000-0000-000000000002', 'f2533000-0000-0000-0000-000000000003');

UPDATE public.channel_encryption_settings SET voice_encrypted = true WHERE channel_id = 'f2533000-0000-0000-0000-000000000002';
SELECT ok(public.channel_voice_encrypted('f2533000-0000-0000-0000-000000000002'), 'a channel''s voice_encrypted resolves on');
SELECT is(pg_temp.flags('f2533000-0000-0000-0000-000000000002'), '-V-', 'and carries the voice flag');
SELECT ok(NOT public.channel_voice_encrypted('f2533000-0000-0000-0000-000000000003'), 'its neighbour stays off');

INSERT INTO public.server_encryption_settings (server_id, encryption_mode, voice_encryption_mode)
VALUES ('f2531000-0000-0000-0000-000000000001', 'optional', 'disabled')
ON CONFLICT (server_id) DO UPDATE SET encryption_mode = 'optional', voice_encryption_mode = 'disabled';
UPDATE public.channel_encryption_settings SET messages_encrypted = true WHERE channel_id = 'f2533000-0000-0000-0000-000000000001';
SELECT is(pg_temp.flags('f2533000-0000-0000-0000-000000000001'), 'M--', 'under optional the row decides messages');
UPDATE public.channel_encryption_settings SET voice_encrypted = true WHERE channel_id = 'f2533000-0000-0000-0000-000000000001';
SELECT is(pg_temp.flags('f2533000-0000-0000-0000-000000000001'), 'M--', 'voice is carried for a voice channel alone');

SELECT is((SELECT is_private FROM public.category_host_flags(ARRAY['f2534000-0000-0000-0000-000000000001']::uuid[])),
          false, 'a category with no override is not private');
INSERT INTO public.channel_category_permission_overrides (category_id, target_type, role_id, allow_permissions, deny_permissions)
VALUES ('f2534000-0000-0000-0000-000000000001', 'role', pg_temp.everyone(), 0, 2);
SELECT is((SELECT is_private FROM public.category_host_flags(ARRAY['f2534000-0000-0000-0000-000000000001']::uuid[])),
          true, 'an @everyone VIEW_CHANNEL deny makes it private');

-- voice_participant_grants, as authorizeVoiceChannel decides. ---------------------------------
SELECT is(pg_temp.grant_reason('f2533000-0000-0000-0000-000000000002', 'f2530000-0000-0000-0000-000000000001'),
          'voice is end-to-end encrypted', 'a remote member of an encrypted voice channel is refused');
SELECT is(pg_temp.grant_reason('f2533000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002'),
          'admitted', 'a local member is admitted');
SELECT is(pg_temp.grant_reason('f2533000-0000-0000-0000-000000000003', 'f2530000-0000-0000-0000-000000000001'),
          'admitted', 'the remote member is admitted to a plain voice channel');
SELECT is(pg_temp.grant_reason('f2533000-0000-0000-0000-000000000002', 'f2530000-0000-0000-0000-000000000002'),
          'not an accepted member', 'a remote stranger learns nothing of the channel''s state');
UPDATE public.channel_encryption_settings SET voice_encrypted = true WHERE channel_id = 'f2533000-0000-0000-0000-000000000004';
SELECT is(pg_temp.grant_reason('f2533000-0000-0000-0000-000000000004', 'f2530000-0000-0000-0000-000000000001'),
          'missing VIEW_CHANNEL', 'nor does a member who cannot view it');
UPDATE public.channel_encryption_settings SET voice_encrypted = false WHERE channel_id = 'f2533000-0000-0000-0000-000000000004';

-- Encryption turning on queues grant resyncs. -------------------------------------------------
UPDATE public.channel_encryption_settings SET voice_encrypted = false WHERE channel_id = 'f2533000-0000-0000-0000-000000000002';
INSERT INTO public.voice_channel_participants (channel_id, server_id, user_id) VALUES
  ('f2533000-0000-0000-0000-000000000002', 'f2531000-0000-0000-0000-000000000001', 'f2530000-0000-0000-0000-000000000001');
DELETE FROM public.voice_grant_resyncs;
UPDATE public.channel_encryption_settings SET history_visibility = 'all' WHERE channel_id = 'f2533000-0000-0000-0000-000000000002';
SELECT is(pg_temp.resyncs(), '', 'a row change that leaves voice encryption queues nothing');
UPDATE public.channel_encryption_settings SET voice_encrypted = true WHERE channel_id = 'f2533000-0000-0000-0000-000000000003';
SELECT is(pg_temp.resyncs(), '', 'encryption on in a channel nobody is in queues nothing');
UPDATE public.channel_encryption_settings SET voice_encrypted = true WHERE channel_id = 'f2533000-0000-0000-0000-000000000002';
SELECT is(pg_temp.resyncs(), '2/*', 'encryption on where a participant sits queues that channel');
SELECT is(pg_temp.grant_reason('f2533000-0000-0000-0000-000000000002', 'f2530000-0000-0000-0000-000000000001'),
          'voice is end-to-end encrypted', 'and the resync refuses that participant');
DELETE FROM public.voice_grant_resyncs;
UPDATE public.channel_encryption_settings SET voice_encrypted = false WHERE channel_id = 'f2533000-0000-0000-0000-000000000002';
SELECT is(pg_temp.resyncs(), '', 'encryption off queues nothing');
UPDATE public.server_encryption_settings SET voice_encryption_mode = 'required'
 WHERE server_id = 'f2531000-0000-0000-0000-000000000001';
SELECT ok(pg_temp.resyncs() LIKE '*/*%', 'a server requiring voice encryption queues the server');
SELECT is(pg_temp.grant_reason('f2533000-0000-0000-0000-000000000002', 'f2530000-0000-0000-0000-000000000001'),
          'voice is end-to-end encrypted', 'and refuses the remote member in every voice channel');
UPDATE public.server_encryption_settings SET voice_encryption_mode = 'disabled'
 WHERE server_id = 'f2531000-0000-0000-0000-000000000001';
UPDATE public.channel_encryption_settings SET voice_encrypted = false
 WHERE channel_id IN ('f2533000-0000-0000-0000-000000000001', 'f2533000-0000-0000-0000-000000000002', 'f2533000-0000-0000-0000-000000000003', 'f2533000-0000-0000-0000-000000000004');
DELETE FROM public.voice_channel_participants WHERE server_id = 'f2531000-0000-0000-0000-000000000001';

-- A change of a flag queues the channel's Update. ----------------------------------------------
TRUNCATE pg_temp.queued;
UPDATE public.channel_encryption_settings SET history_visibility = 'none' WHERE channel_id = 'f2533000-0000-0000-0000-000000000002';
SELECT is(pg_temp.jobs(), '', 'a settings change that leaves the flags queues nothing');
UPDATE public.channel_encryption_settings SET voice_encrypted = true WHERE channel_id = 'f2533000-0000-0000-0000-000000000002';
SELECT is(pg_temp.jobs(), 'federate-channel-crud:update:2', 'voice encryption queues the channel''s update');
TRUNCATE pg_temp.queued;
UPDATE public.channel_encryption_settings SET voice_encrypted = true WHERE channel_id = 'f2533000-0000-0000-0000-000000000005';
SELECT is(pg_temp.jobs(), '', 'a server that does not federate queues nothing');
UPDATE public.channel_encryption_settings SET voice_encrypted = true WHERE channel_id = 'f2533000-0000-0000-0000-000000000006';
SELECT is(pg_temp.jobs(), '', 'nor does a copy');

TRUNCATE pg_temp.queued;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions) VALUES
  ('f2533000-0000-0000-0000-000000000003', 'role', 'f2532000-0000-0000-0000-000000000001', 0, 2),
  ('f2533000-0000-0000-0000-000000000002', 'role', pg_temp.everyone(), 0, 16777216);
SELECT is(pg_temp.jobs(), '', 'an override that does not change @everyone''s view queues nothing');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
VALUES ('f2533000-0000-0000-0000-000000000003', 'role', pg_temp.everyone(), 0, 2);
SELECT is(pg_temp.jobs(), 'federate-channel-crud:update:3', 'hiding a channel from @everyone queues its update');
TRUNCATE pg_temp.queued;
DELETE FROM public.channel_permission_overrides
 WHERE channel_id = 'f2533000-0000-0000-0000-000000000003' AND role_id = pg_temp.everyone();
SELECT is(pg_temp.jobs(), 'federate-channel-crud:update:3', 'showing it again does too');

TRUNCATE pg_temp.queued;
DELETE FROM public.channel_category_permission_overrides
 WHERE category_id = 'f2534000-0000-0000-0000-000000000001';
SELECT is(pg_temp.jobs(), 'federate-category-crud:update:1', 'a category''s view changing queues its update');

TRUNCATE pg_temp.queued;
UPDATE public.server_encryption_settings SET encryption_mode = 'disabled'
 WHERE server_id = 'f2531000-0000-0000-0000-000000000001';
SELECT is((SELECT count(DISTINCT data ->> 'channel_id')::int FROM pg_temp.queued
            WHERE name = 'federate-channel-crud' AND data ->> 'server_id' = 'f2531000-0000-0000-0000-000000000001'),
          (SELECT count(*)::int FROM public.channels WHERE server_id = 'f2531000-0000-0000-0000-000000000001'),
          'a server''s mode changing queues each of its channels');

SELECT * FROM finish();
ROLLBACK;
