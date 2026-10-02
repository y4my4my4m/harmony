-- Per-channel encryption after 20261001000001_channel_encryption_settings.sql.
--
-- Local roles (profile e391..., auth e390...):
--   a1 owner    owns s_opt (optional), s_req (required), s_dis (no policy row)
--   a2 mod      member of s_opt holding a MANAGE_CHANNELS role, denied it on c_opt2
--   a3 member   member of s_opt and s_req
--   a4 outsider member of nothing
--   a5 target   member of s_opt, the mention target
-- alice (fixture) is instance admin and belongs to none of these servers.
--
-- queue_federation_job is replaced for the transaction with a recorder into tests.fed_jobs:
-- pg_notify delivers only at commit and every file rolls back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(71);

CREATE OR REPLACE FUNCTION pg_temp.sig(p_name text) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT pg_get_function_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = p_name;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.granted_execute(p_name text, p_role text)
RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    WHERE n.nspname = 'public' AND p.proname = p_name
      AND a.grantee = p_role::regrole
      AND a.privilege_type = 'EXECUTE'
  );
$fn$;

-- 40 bytes of base64, one ciphertext part, then the given plaintext parts.
CREATE OR REPLACE FUNCTION pg_temp.enc(p_extra jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT jsonb_build_array(jsonb_build_object(
           'type', 'text', 'text', 'Q2lwaGVydGV4dENpcGhlcnRleHRDaXBoZXJ0ZXh0Q2lwaGVydGV4dA=='))
         || p_extra;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.meta() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT '{"algorithm":"megolm_v3","session_id":"s-1","message_index":0}'::jsonb;
$fn$;

-- Setup, as postgres. -------------------------------------------------------------------
CREATE TABLE tests.fed_jobs (name text, data jsonb);
GRANT INSERT, SELECT ON tests.fed_jobs TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.fed_jobs VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT ('e3900000-0000-0000-0000-0000000000' || k)::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'enc39-' || k || '@test.local'
  FROM unnest(ARRAY['a1','a2','a3','a4','a5']) k;

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
SELECT ('e3910000-0000-0000-0000-0000000000' || k)::uuid,
       ('e3900000-0000-0000-0000-0000000000' || k)::uuid, n, n, true
  FROM (VALUES ('a1', 'enc_owner'), ('a2', 'enc_mod'), ('a3', 'enc_member'),
               ('a4', 'enc_outsider'), ('a5', 'enc_target')) v(k, n);

INSERT INTO public.servers (id, name, owner, federation_enabled) VALUES
  ('e3920000-0000-0000-0000-000000000001', 'Optional', 'e3910000-0000-0000-0000-0000000000a1', true),
  ('e3920000-0000-0000-0000-000000000002', 'Required', 'e3910000-0000-0000-0000-0000000000a1', true),
  ('e3920000-0000-0000-0000-000000000003', 'Disabled', 'e3910000-0000-0000-0000-0000000000a1', true);

INSERT INTO public.server_encryption_settings (server_id, encryption_mode) VALUES
  ('e3920000-0000-0000-0000-000000000001', 'optional'),
  ('e3920000-0000-0000-0000-000000000002', 'required');

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('e3930000-0000-0000-0000-000000000001', 'e3920000-0000-0000-0000-000000000001', 'c-opt', 0),
  ('e3930000-0000-0000-0000-000000000002', 'e3920000-0000-0000-0000-000000000001', 'c-opt2', 0),
  ('e3930000-0000-0000-0000-000000000003', 'e3920000-0000-0000-0000-000000000001', 'c-bf', 0),
  ('e3930000-0000-0000-0000-000000000004', 'e3920000-0000-0000-0000-000000000001', 'c-bf2', 0),
  ('e3930000-0000-0000-0000-000000000005', 'e3920000-0000-0000-0000-000000000002', 'c-req', 1),
  ('e3930000-0000-0000-0000-000000000006', 'e3920000-0000-0000-0000-000000000003', 'c-dis', 0);

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('e3910000-0000-0000-0000-0000000000a1', 'e3920000-0000-0000-0000-000000000001', 'accepted'),
  ('e3910000-0000-0000-0000-0000000000a2', 'e3920000-0000-0000-0000-000000000001', 'accepted'),
  ('e3910000-0000-0000-0000-0000000000a3', 'e3920000-0000-0000-0000-000000000001', 'accepted'),
  ('e3910000-0000-0000-0000-0000000000a5', 'e3920000-0000-0000-0000-000000000001', 'accepted'),
  ('e3910000-0000-0000-0000-0000000000a1', 'e3920000-0000-0000-0000-000000000002', 'accepted'),
  ('e3910000-0000-0000-0000-0000000000a3', 'e3920000-0000-0000-0000-000000000002', 'accepted'),
  ('e3910000-0000-0000-0000-0000000000a1', 'e3920000-0000-0000-0000-000000000003', 'accepted');

-- MANAGE_CHANNELS is bit 2.
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('e3940000-0000-0000-0000-000000000001', 'e3920000-0000-0000-0000-000000000001', 'Channel managers', 10, 4);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('e3910000-0000-0000-0000-0000000000a2', 'e3940000-0000-0000-0000-000000000001', 'e3920000-0000-0000-0000-000000000001');
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, deny_permissions) VALUES
  ('e3930000-0000-0000-0000-000000000002', 'role', 'e3940000-0000-0000-0000-000000000001', 4);

-- Plaintext written before c_opt is encrypted.
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('e3950000-0000-0000-0000-000000000001', 'e3930000-0000-0000-0000-000000000001',
   'e3910000-0000-0000-0000-0000000000a3', '[{"type":"text","text":"legacy plaintext"}]');

-- Contracts --------------------------------------------------------------------------
SELECT is(pg_temp.sig('set_channel_encryption'),
          'p_channel_id uuid, p_messages_encrypted boolean DEFAULT NULL::boolean, '
          || 'p_voice_encrypted boolean DEFAULT NULL::boolean, p_history_visibility text DEFAULT NULL::text -> jsonb',
          'set_channel_encryption takes the channel and three optional settings');
SELECT is(pg_temp.sig('effective_channel_encryption'), 'p_channel_id uuid -> jsonb',
          'effective_channel_encryption takes a channel id and returns jsonb');
SELECT ok(pg_temp.granted_execute('set_channel_encryption', 'authenticated')
          AND NOT pg_temp.granted_execute('set_channel_encryption', 'anon')
          AND pg_temp.granted_execute('effective_channel_encryption', 'authenticated')
          AND NOT pg_temp.granted_execute('effective_channel_encryption', 'anon'),
          'the two RPCs are executable by authenticated and not by anon');
SELECT ok(NOT has_function_privilege('authenticated', 'public.seed_channel_encryption_settings(uuid[])', 'EXECUTE'),
          'seed_channel_encryption_settings is not executable by clients');

-- Default row on channel creation ------------------------------------------------------
SELECT results_eq(
    $q$SELECT messages_encrypted, voice_encrypted, history_visibility
         FROM public.channel_encryption_settings
        WHERE channel_id = 'e3930000-0000-0000-0000-000000000001'$q$,
    $q$VALUES (false, false, 'joined'::text)$q$,
    'a channel created under an optional server starts off with joined history visibility');
SELECT is((SELECT messages_encrypted FROM public.channel_encryption_settings
            WHERE channel_id = 'e3930000-0000-0000-0000-000000000005'), true,
          'a channel created under a required server starts on');
SELECT is((SELECT messages_encrypted FROM public.channel_encryption_settings
            WHERE channel_id = 'e3930000-0000-0000-0000-000000000006'), false,
          'a channel created under a server with no policy starts off');
SELECT is((SELECT count(*)::int FROM public.channels c
            WHERE c.server_id = 'e3920000-0000-0000-0000-000000000002'
              AND NOT EXISTS (SELECT 1 FROM public.channel_encryption_settings ces
                               WHERE ces.channel_id = c.id AND ces.messages_encrypted)), 0,
          'the required floor covers the channels created with the server before its policy row');

-- Permission matrix --------------------------------------------------------------------
SELECT tests.authenticate_as('e3900000-0000-0000-0000-0000000000a3');
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('e3930000-0000-0000-0000-000000000001', true)$q$,
    '42501', NULL, 'a plain member cannot turn encryption on');

SELECT tests.authenticate_as('e3900000-0000-0000-0000-0000000000a4');
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('e3930000-0000-0000-0000-000000000001', true)$q$,
    '42501', NULL, 'a non-member cannot turn encryption on');
SELECT is(public.effective_channel_encryption('e3930000-0000-0000-0000-000000000001'), NULL,
          'effective_channel_encryption answers NULL to a non-member');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('e3930000-0000-0000-0000-000000000001', true)$q$,
    '42501', NULL, 'anon cannot call set_channel_encryption');

SELECT tests.clear_authentication();
SELECT set_config('tests.epoch_before',
                  public.get_room_epoch('e3930000-0000-0000-0000-000000000001')::text, true);

SELECT tests.authenticate_as('e3900000-0000-0000-0000-0000000000a1');
SELECT is(public.set_channel_encryption('e3930000-0000-0000-0000-000000000001', true)->>'messages_encrypted',
          'true', 'the owner turns encryption on and receives the effective state');
SELECT tests.clear_authentication();

SELECT results_eq(
    $q$SELECT user_id, content->0->>'text'
         FROM public.messages
        WHERE channel_id = 'e3930000-0000-0000-0000-000000000001'
          AND is_system AND metadata->>'type' = 'channel_encryption_enabled'$q$,
    $q$VALUES ('e3910000-0000-0000-0000-0000000000a1'::uuid, 'turned on end-to-end encryption'::text)$q$,
    'turning encryption on posts one system message attributed to the owner');
SELECT is((SELECT enabled_by FROM public.channel_encryption_settings
            WHERE channel_id = 'e3930000-0000-0000-0000-000000000001'),
          'e3910000-0000-0000-0000-0000000000a1'::uuid, 'enabled_by records the owner');
SELECT results_eq(
    $q$SELECT current_epoch, reason FROM public.room_epoch_state
        WHERE room_id = 'e3930000-0000-0000-0000-000000000001'$q$,
    $q$VALUES (current_setting('tests.epoch_before')::int + 1, 'encryption_enabled'::text)$q$,
    'turning encryption on bumps the room epoch once');

SELECT tests.authenticate_as('e3900000-0000-0000-0000-0000000000a2');
SELECT is(public.set_channel_encryption('e3930000-0000-0000-0000-000000000001', false)->>'messages_encrypted',
          'false', 'a MANAGE_CHANNELS role holder turns encryption off');
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('e3930000-0000-0000-0000-000000000002', true)$q$,
    '42501', NULL, 'a channel override denying MANAGE_CHANNELS refuses the same role holder');
SELECT tests.clear_authentication();

SELECT is((SELECT user_id FROM public.messages
            WHERE channel_id = 'e3930000-0000-0000-0000-000000000001'
              AND is_system AND metadata->>'type' = 'channel_encryption_disabled'),
          'e3910000-0000-0000-0000-0000000000a2'::uuid,
          'turning encryption off posts a system message attributed to the role holder');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_channel_encryption('e3930000-0000-0000-0000-000000000001', true)->>'messages_encrypted',
          'true', 'an instance admin outside the server turns encryption on');
SELECT tests.clear_authentication();

-- Floor --------------------------------------------------------------------------------
SELECT tests.authenticate_as('e3900000-0000-0000-0000-0000000000a1');
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('e3930000-0000-0000-0000-000000000006', true)$q$,
    '22023', NULL, 'a disabled server refuses to turn a channel on');
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('e3930000-0000-0000-0000-000000000006', NULL, true)$q$,
    '22023', NULL, 'a disabled server refuses to turn channel voice on');
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('e3930000-0000-0000-0000-000000000005', false)$q$,
    '22023', NULL, 'a required server refuses to turn a channel off');
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('e3930000-0000-0000-0000-000000000001', NULL, NULL, 'everyone')$q$,
    '22023', NULL, 'an unknown history visibility is refused');
SELECT is(public.set_channel_encryption('e3930000-0000-0000-0000-000000000001', NULL, NULL, 'shared')->>'history_visibility',
          'shared', 'history visibility changes without touching the other settings');
SELECT is(public.set_channel_encryption('e3930000-0000-0000-0000-000000000004', NULL, true)->>'voice_encrypted',
          'true', 'an optional server lets the owner turn channel voice on');
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM public.messages
            WHERE channel_id = 'e3930000-0000-0000-0000-000000000004'
              AND is_system AND metadata->>'type' = 'channel_voice_encryption_enabled'), 1,
          'turning voice on posts its own system message');

UPDATE public.server_encryption_settings SET voice_encryption_mode = 'required'
 WHERE server_id = 'e3920000-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('e3900000-0000-0000-0000-0000000000a1');
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('e3930000-0000-0000-0000-000000000005', NULL, false)$q$,
    '22023', NULL, 'a server requiring encrypted voice refuses to turn channel voice off');
SELECT tests.clear_authentication();

UPDATE public.channel_encryption_settings SET messages_encrypted = true
 WHERE channel_id = 'e3930000-0000-0000-0000-000000000006';
SELECT is(public.channel_messages_encrypted('e3930000-0000-0000-0000-000000000006'), false,
          'a disabled server resolves a channel off whatever its row says');

-- Effective state and RLS ----------------------------------------------------------------
SELECT tests.authenticate_as('e3900000-0000-0000-0000-0000000000a3');
SELECT results_eq(
    $q$SELECT e->>'messages_encrypted', e->>'server_mode', e->>'messages_locked', e->>'history_visibility'
         FROM (SELECT public.effective_channel_encryption('e3930000-0000-0000-0000-000000000001') e) x$q$,
    $q$VALUES ('true'::text, 'optional'::text, 'false'::text, 'shared'::text)$q$,
    'a member reads the effective state of an encrypted channel');
SELECT is((SELECT count(*)::int FROM public.channel_encryption_settings
            WHERE channel_id = 'e3930000-0000-0000-0000-000000000001'), 1,
          'a member reads the channel row');
SELECT throws_ok(
    $q$INSERT INTO public.channel_encryption_settings (channel_id) VALUES ('e3930000-0000-0000-0000-000000000003')$q$,
    '42501', NULL, 'a member cannot insert a settings row');
SELECT throws_ok(
    $q$UPDATE public.channel_encryption_settings SET messages_encrypted = false
        WHERE channel_id = 'e3930000-0000-0000-0000-000000000001'$q$,
    '42501', NULL, 'a member cannot update a settings row');
SELECT tests.authenticate_as('e3900000-0000-0000-0000-0000000000a4');
SELECT is((SELECT count(*)::int FROM public.channel_encryption_settings
            WHERE channel_id = 'e3930000-0000-0000-0000-000000000001'), 0,
          'a non-member reads no channel row');
SELECT tests.clear_authentication();

-- Plaintext rejection ------------------------------------------------------------------
SELECT tests.authenticate_as('e3900000-0000-0000-0000-0000000000a3');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('e3930000-0000-0000-0000-000000000001', 'e3910000-0000-0000-0000-0000000000a3',
               '[{"type":"text","text":"hello"}]')$q$,
    '23514', NULL, 'a plaintext message in an encrypted channel is rejected');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, encrypted, encryption_metadata)
       VALUES ('e3930000-0000-0000-0000-000000000001', 'e3910000-0000-0000-0000-0000000000a3',
               pg_temp.enc('[{"type":"text","text":"leak"}]'), true, pg_temp.meta())$q$,
    '23514', NULL, 'a second text part beside the ciphertext is rejected');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, encrypted, encryption_metadata)
       VALUES ('e3930000-0000-0000-0000-000000000001', 'e3910000-0000-0000-0000-0000000000a3',
               pg_temp.enc('[{"type":"mention","username":"enc_target","text":"leak"}]'), true, pg_temp.meta())$q$,
    '23514', NULL, 'a mention part carrying an unknown key is rejected');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, encrypted, encryption_metadata)
       VALUES ('e3930000-0000-0000-0000-000000000001', 'e3910000-0000-0000-0000-0000000000a3',
               '[{"type":"text","text":"this is not base64 ciphertext at all, it has spaces"}]', true, pg_temp.meta())$q$,
    '23514', NULL, 'a ciphertext part that is not base64 is rejected');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, encrypted)
       VALUES ('e3930000-0000-0000-0000-000000000001', 'e3910000-0000-0000-0000-0000000000a3',
               pg_temp.enc(), true)$q$,
    '23514', NULL, 'an encrypted message without encryption metadata is rejected');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
       VALUES ('e3930000-0000-0000-0000-000000000001', 'e3910000-0000-0000-0000-0000000000a3',
               '[{"type":"text","text":"not a real announcement"}]', true, '{"type":"member_join"}')$q$,
    '42501', NULL, 'a client-inserted system message is rejected');
SELECT lives_ok(
    $q$SELECT public.post_thread_created_notice(
           public.create_thread('e3950000-0000-0000-0000-000000000001', 'Encrypted thread'))$q$,
    'the thread announcement posts through post_thread_created_notice');
SELECT throws_ok(
    $q$UPDATE public.messages SET content = '[{"type":"text","text":"edited plaintext"}]'
        WHERE id = 'e3950000-0000-0000-0000-000000000001'$q$,
    '23514', NULL, 'editing a pre-encryption message into new plaintext is rejected');
SELECT lives_ok(
    $q$INSERT INTO public.messages (id, channel_id, user_id, content, encrypted, encryption_metadata)
       VALUES ('e3950000-0000-0000-0000-000000000002', 'e3930000-0000-0000-0000-000000000001',
               'e3910000-0000-0000-0000-0000000000a3',
               pg_temp.enc('[{"type":"mention","userId":"e3910000-0000-0000-0000-0000000000a5","username":"enc_target","domain":null,"isLocal":true}]'),
               true, pg_temp.meta())$q$,
    'ciphertext followed by a plaintext mention part passes');
SELECT lives_ok(
    $q$UPDATE public.messages SET content = '[{"type":"text","text":"[deleted]"}]', is_deleted = true
        WHERE id = 'e3950000-0000-0000-0000-000000000001'$q$,
    'a soft delete writes its tombstone');
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM public.messages
            WHERE channel_id = 'e3930000-0000-0000-0000-000000000001'
              AND is_system AND metadata->>'type' LIKE 'channel_encryption_%'), 3,
          'server-generated system messages pass in an encrypted channel');

INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by)
VALUES ('e3960000-0000-0000-0000-000000000001', 'e3930000-0000-0000-0000-000000000001',
        'e3950000-0000-0000-0000-000000000002', 'thread', 'e3910000-0000-0000-0000-0000000000a3');
SELECT throws_ok(
    $q$INSERT INTO public.messages (thread_id, user_id, content)
       VALUES ('e3960000-0000-0000-0000-000000000001', 'e3910000-0000-0000-0000-0000000000a3',
               '[{"type":"text","text":"thread plaintext"}]')$q$,
    '23514', NULL, 'a thread message inherits its channel encryption');

-- Federation ---------------------------------------------------------------------------
SELECT is((SELECT federation_status FROM public.messages WHERE id = 'e3950000-0000-0000-0000-000000000002'),
          'skipped', 'a message in an encrypted channel is stamped skipped');
SELECT is((SELECT count(*)::int FROM tests.fed_jobs
            WHERE data->>'message_id' = 'e3950000-0000-0000-0000-000000000002'), 0,
          'no federation job is queued for it');

INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('e3950000-0000-0000-0000-000000000003', 'e3930000-0000-0000-0000-000000000002',
   'e3910000-0000-0000-0000-0000000000a3', '[{"type":"text","text":"federated plaintext"}]');
SELECT is((SELECT count(*)::int FROM tests.fed_jobs
            WHERE name = 'federate-channel-message'
              AND data->>'message_id' = 'e3950000-0000-0000-0000-000000000003'), 1,
          'a message in an unencrypted channel still queues federation');

UPDATE public.messages
   SET content = '[{"type":"text","text":"RWRpdGVkQ2lwaGVydGV4dEVkaXRlZENpcGhlcnRleHRFZGl0ZWRDaQ=="}]'
 WHERE id = 'e3950000-0000-0000-0000-000000000002';
UPDATE public.messages SET content = '[{"type":"text","text":"edited federated plaintext"}]'
 WHERE id = 'e3950000-0000-0000-0000-000000000003';
SELECT results_eq(
    $q$SELECT data->>'message_id' FROM tests.fed_jobs
        WHERE name = 'federate-channel-message-edit'
          AND data->>'message_id' LIKE 'e3950000-%'$q$,
    $q$VALUES ('e3950000-0000-0000-0000-000000000003'::text)$q$,
    'an edit queues federation only outside the encrypted channel');

INSERT INTO public.reactions (message_id, user_id, custom_emoji_content) VALUES
  ('e3950000-0000-0000-0000-000000000002', 'e3910000-0000-0000-0000-0000000000a1', 'ok'),
  ('e3950000-0000-0000-0000-000000000003', 'e3910000-0000-0000-0000-0000000000a1', 'ok');
SELECT results_eq(
    $q$SELECT data->>'message_id' FROM tests.fed_jobs WHERE name = 'federate-channel-reaction'$q$,
    $q$VALUES ('e3950000-0000-0000-0000-000000000003'::text)$q$,
    'a reaction queues federation only outside the encrypted channel');
SELECT is((SELECT federation_status FROM public.reactions
            WHERE message_id = 'e3950000-0000-0000-0000-000000000002'),
          'skipped', 'a reaction on a withheld message is stamped skipped');

UPDATE public.messages SET is_deleted = true
 WHERE id IN ('e3950000-0000-0000-0000-000000000002', 'e3950000-0000-0000-0000-000000000003');
SELECT results_eq(
    $q$SELECT data->>'message_id' FROM tests.fed_jobs
        WHERE name = 'federate-channel-message-delete'
          AND data->>'message_id' IN ('e3950000-0000-0000-0000-000000000002',
                                      'e3950000-0000-0000-0000-000000000003')$q$,
    $q$VALUES ('e3950000-0000-0000-0000-000000000003'::text)$q$,
    'a delete queues federation only for a message that was federated');
SELECT is((SELECT count(*)::int FROM tests.fed_jobs
            WHERE name = 'federate-channel-message-delete'
              AND data->>'message_id' = 'e3950000-0000-0000-0000-000000000001'), 1,
          'deleting plaintext federated before the channel was encrypted still federates the delete');

-- Mentions and notification previews ---------------------------------------------------
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'e3910000-0000-0000-0000-0000000000a5' AND type = 'mention'
              AND data->>'message_id' = 'e3950000-0000-0000-0000-000000000002'), 1,
          'a plaintext mention part beside the ciphertext notifies the mentioned member');
SELECT results_eq(
    $q$SELECT data->>'preview', data->'message'->>'content_preview', data->>'encrypted'
         FROM public.notifications
        WHERE user_id = 'e3910000-0000-0000-0000-0000000000a5' AND type = 'mention'
          AND data->>'message_id' = 'e3950000-0000-0000-0000-000000000002'$q$,
    $q$VALUES ('Encrypted message'::text, 'Encrypted message'::text, 'true'::text)$q$,
    'the mention notification carries the generic preview and the encrypted flag');
SELECT is((SELECT unread_mentions FROM public.unread_counts
            WHERE user_id = 'e3910000-0000-0000-0000-0000000000a5'
              AND channel_id = 'e3930000-0000-0000-0000-000000000001'), 1,
          'the mentioned member gains an unread mention');

SELECT is((SELECT data->>'message_preview' FROM public.notifications
            WHERE user_id = 'e3910000-0000-0000-0000-0000000000a3' AND type = 'reaction'
              AND data->>'message_id' = 'e3950000-0000-0000-0000-000000000002'),
          'Encrypted message', 'a reaction notification on an encrypted message previews generically');

SELECT set_config('tests.everyone_role',
                  (SELECT id::text FROM public.server_roles
                    WHERE server_id = 'e3920000-0000-0000-0000-000000000001' AND is_default), true);
-- @everyone needs MENTION_EVERYONE (20261003400001); the owner holds it.
SELECT tests.authenticate_as('e3900000-0000-0000-0000-0000000000a1');
INSERT INTO public.messages (id, channel_id, user_id, content, encrypted, encryption_metadata)
VALUES ('e3950000-0000-0000-0000-000000000004', 'e3930000-0000-0000-0000-000000000001',
        'e3910000-0000-0000-0000-0000000000a1',
        pg_temp.enc(jsonb_build_array(jsonb_build_object(
            'type', 'role_mention', 'roleId', current_setting('tests.everyone_role')))),
        true, pg_temp.meta());
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT data->>'preview', data->>'is_everyone'
         FROM public.notifications
        WHERE user_id = 'e3910000-0000-0000-0000-0000000000a2' AND type = 'mention'
          AND data->>'message_id' = 'e3950000-0000-0000-0000-000000000004'$q$,
    $q$VALUES ('Encrypted message'::text, 'true'::text)$q$,
    'an @everyone role mention part notifies members with the generic preview');

INSERT INTO public.messages (id, conversation_id, user_id, content, encrypted, encryption_metadata) VALUES
  ('e3950000-0000-0000-0000-000000000005', '77777777-0000-0000-0000-000000000007',
   '11111111-0000-0000-0000-000000000001', pg_temp.enc(), true, pg_temp.meta());
SELECT is((SELECT data->'message'->>'content_preview' FROM public.notifications
            WHERE user_id = '22222222-0000-0000-0000-000000000002' AND type = 'dm'
              AND data->>'message_id' = 'e3950000-0000-0000-0000-000000000005'),
          'Encrypted message', 'an encrypted DM notification previews generically');
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE data::text LIKE '%Q2lwaGVydGV4dENpcGhlcnRleHRDaXBoZXJ0ZXh0Q2lwaGVydGV4dA==%'
               OR data::text LIKE '%RWRpdGVkQ2lwaGVydGV4dEVkaXRlZENpcGhlcnRleHRFZGl0ZWRDaQ==%'), 0,
          'no notification carries ciphertext');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT e->'last_message'->>'encrypted'
             FROM jsonb_array_elements(public.get_user_conversations()) e
            WHERE e->>'conversation_id' = '77777777-0000-0000-0000-000000000007'),
          'true', 'get_user_conversations flags an encrypted last message');
SELECT tests.clear_authentication();

-- Server floor transitions -------------------------------------------------------------
UPDATE public.server_encryption_settings SET encryption_mode = 'required'
 WHERE server_id = 'e3920000-0000-0000-0000-000000000001';
SELECT is((SELECT messages_encrypted FROM public.channel_encryption_settings
            WHERE channel_id = 'e3930000-0000-0000-0000-000000000002'), true,
          'a server entering required mode writes it into every channel row');
UPDATE public.server_encryption_settings SET encryption_mode = 'optional'
 WHERE server_id = 'e3920000-0000-0000-0000-000000000001';
SELECT is(public.channel_messages_encrypted('e3930000-0000-0000-0000-000000000002'), true,
          'relaxing the server back to optional leaves those channels on');
SELECT is((SELECT voice_encrypted FROM public.channel_encryption_settings
            WHERE channel_id = 'e3930000-0000-0000-0000-000000000005'), true,
          'a server requiring encrypted voice writes it into every channel row');

-- Backfill -----------------------------------------------------------------------------
DELETE FROM public.channel_encryption_settings
 WHERE channel_id IN ('e3930000-0000-0000-0000-000000000003', 'e3930000-0000-0000-0000-000000000004',
                      'e3930000-0000-0000-0000-000000000005', 'e3930000-0000-0000-0000-000000000006');
INSERT INTO public.messages (channel_id, user_id, content, encrypted, encryption_metadata) VALUES
  ('e3930000-0000-0000-0000-000000000003', 'e3910000-0000-0000-0000-0000000000a3', pg_temp.enc(), true, pg_temp.meta());
SELECT public.seed_channel_encryption_settings(ARRAY[
    'e3930000-0000-0000-0000-000000000003', 'e3930000-0000-0000-0000-000000000004',
    'e3930000-0000-0000-0000-000000000005', 'e3930000-0000-0000-0000-000000000006']::uuid[]);
SELECT results_eq(
    $q$SELECT channel_id, messages_encrypted FROM public.channel_encryption_settings
        WHERE channel_id IN ('e3930000-0000-0000-0000-000000000003', 'e3930000-0000-0000-0000-000000000004',
                             'e3930000-0000-0000-0000-000000000005', 'e3930000-0000-0000-0000-000000000006')
        ORDER BY channel_id$q$,
    $q$VALUES ('e3930000-0000-0000-0000-000000000003'::uuid, true),
              ('e3930000-0000-0000-0000-000000000004'::uuid, false),
              ('e3930000-0000-0000-0000-000000000005'::uuid, true),
              ('e3930000-0000-0000-0000-000000000006'::uuid, false)$q$,
    'backfill: optional with encrypted history on, optional without off, required on, no policy off');
SELECT is((SELECT voice_encrypted FROM public.channel_encryption_settings
            WHERE channel_id = 'e3930000-0000-0000-0000-000000000005'), true,
          'backfill: voice follows a required voice mode');

-- Catalog ------------------------------------------------------------------------------
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.channel_encryption_settings'::regclass),
          'channel_encryption_settings has RLS enabled');
SELECT ok(NOT has_table_privilege('authenticated', 'public.channel_encryption_settings', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.channel_encryption_settings', 'UPDATE')
          AND NOT has_table_privilege('authenticated', 'public.channel_encryption_settings', 'DELETE')
          AND NOT has_table_privilege('anon', 'public.channel_encryption_settings', 'SELECT'),
          'clients hold SELECT only, and anon holds nothing');
SELECT ok(NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.enforce_channel_message_encryption()'::regprocedure),
          'the plaintext trigger runs as the inserting role');
SELECT ok(public.is_encrypted_channel_content(
              pg_temp.enc('[{"type":"role_mention","roleId":"e3940000-0000-0000-0000-000000000001"}]'),
              pg_temp.meta())
          AND NOT public.is_encrypted_channel_content(
              pg_temp.enc('[{"type":"role_mention","roleId":"e3940000-0000-0000-0000-000000000001","roleName":"x"}]'),
              pg_temp.meta())
          AND NOT public.is_encrypted_channel_content(
              '[{"type":"text","text":"QUJD"}]'::jsonb, pg_temp.meta())
          AND NOT public.is_encrypted_channel_content(
              pg_temp.enc(), '{"algorithm":"megolm_v1","session_id":"s"}'::jsonb),
          'the content validator accepts bare role mentions and refuses extra keys, short ciphertext and megolm_v1');

SELECT * FROM finish();
ROLLBACK;
