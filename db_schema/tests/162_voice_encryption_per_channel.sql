-- 20261021300001_voice_encryption_per_channel.sql: voice and video encryption is set per voice
-- channel whatever the server's message encryption mode; voice_encryption_mode 'required'
-- locks it on.
--
--   b1 owner     owns every server
--   b2 manager   member of s_dis and s_req, holding a MANAGE_CHANNELS role in each
--   b3 member    member of s_dis
--   b4 outsider  member of nothing
--
--   s_dis   no policy row (message encryption disabled)
--   s_off   encryption_mode 'disabled', voice_encryption_mode 'disabled'
--   s_req   encryption_mode 'disabled', voice_encryption_mode 'required'
--   s_opt   encryption_mode 'optional'
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(28);

CREATE OR REPLACE FUNCTION pg_temp.sig(p_name text) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT pg_get_function_arguments(p.oid) || ' -> ' || pg_get_function_result(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = p_name;
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.voice_messages(p_channel uuid, p_type text) RETURNS int
LANGUAGE sql STABLE AS $fn$
  SELECT count(*)::int FROM public.messages
   WHERE channel_id = p_channel AND is_system AND metadata->>'type' = p_type;
$fn$;

INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT ('f1620000-0000-0000-0000-0000000000' || k)::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'voice162-' || k || '@test.local'
  FROM unnest(ARRAY['b1','b2','b3','b4']) k;

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
SELECT ('f1621000-0000-0000-0000-0000000000' || k)::uuid,
       ('f1620000-0000-0000-0000-0000000000' || k)::uuid, n, n, true
  FROM (VALUES ('b1', 'voice162_owner'), ('b2', 'voice162_manager'),
               ('b3', 'voice162_member'), ('b4', 'voice162_outsider')) v(k, n);

INSERT INTO public.servers (id, name, owner) VALUES
  ('f1622000-0000-0000-0000-000000000001', 'No policy', 'f1621000-0000-0000-0000-0000000000b1'),
  ('f1622000-0000-0000-0000-000000000002', 'Disabled', 'f1621000-0000-0000-0000-0000000000b1'),
  ('f1622000-0000-0000-0000-000000000003', 'Voice required', 'f1621000-0000-0000-0000-0000000000b1'),
  ('f1622000-0000-0000-0000-000000000004', 'Optional', 'f1621000-0000-0000-0000-0000000000b1');

INSERT INTO public.server_encryption_settings (server_id, encryption_mode, voice_encryption_mode) VALUES
  ('f1622000-0000-0000-0000-000000000002', 'disabled', 'disabled'),
  ('f1622000-0000-0000-0000-000000000004', 'optional', 'disabled');

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1623000-0000-0000-0000-000000000001', 'f1622000-0000-0000-0000-000000000001', 'v-dis', 1),
  ('f1623000-0000-0000-0000-000000000002', 'f1622000-0000-0000-0000-000000000002', 'v-off', 1),
  ('f1623000-0000-0000-0000-000000000003', 'f1622000-0000-0000-0000-000000000003', 'v-req', 1),
  ('f1623000-0000-0000-0000-000000000004', 'f1622000-0000-0000-0000-000000000004', 't-opt', 0);

-- The required voice floor arrives after the channel exists and writes it into the row.
INSERT INTO public.server_encryption_settings (server_id, encryption_mode, voice_encryption_mode) VALUES
  ('f1622000-0000-0000-0000-000000000003', 'disabled', 'required');

INSERT INTO public.user_servers (user_id, server_id, status)
SELECT 'f1621000-0000-0000-0000-0000000000b1'::uuid, s.id, 'accepted'
  FROM public.servers s WHERE s.id::text LIKE 'f1622000-%';
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f1621000-0000-0000-0000-0000000000b2', 'f1622000-0000-0000-0000-000000000001', 'accepted'),
  ('f1621000-0000-0000-0000-0000000000b3', 'f1622000-0000-0000-0000-000000000001', 'accepted'),
  ('f1621000-0000-0000-0000-0000000000b2', 'f1622000-0000-0000-0000-000000000003', 'accepted');

-- MANAGE_CHANNELS is bit 2.
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('f1624000-0000-0000-0000-000000000001', 'f1622000-0000-0000-0000-000000000001', 'Channel managers', 10, 4),
  ('f1624000-0000-0000-0000-000000000003', 'f1622000-0000-0000-0000-000000000003', 'Channel managers', 10, 4);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('f1621000-0000-0000-0000-0000000000b2', 'f1624000-0000-0000-0000-000000000001', 'f1622000-0000-0000-0000-000000000001'),
  ('f1621000-0000-0000-0000-0000000000b2', 'f1624000-0000-0000-0000-000000000003', 'f1622000-0000-0000-0000-000000000003');

-- Contracts --------------------------------------------------------------------------
SELECT is(pg_temp.sig('set_channel_encryption'),
          'p_channel_id uuid, p_messages_encrypted boolean DEFAULT NULL::boolean, '
          || 'p_voice_encrypted boolean DEFAULT NULL::boolean, p_history_visibility text DEFAULT NULL::text -> jsonb',
          'set_channel_encryption keeps its signature');
SELECT is(pg_temp.sig('effective_channel_encryption'), 'p_channel_id uuid -> jsonb',
          'effective_channel_encryption keeps its signature');

-- Message encryption disabled: voice is per channel ---------------------------------------
SELECT tests.authenticate_as('f1620000-0000-0000-0000-0000000000b1');
SELECT results_eq(
    $q$SELECT (e->>'voice_encrypted')::boolean, (e->>'voice_locked')::boolean, (e->>'messages_locked')::boolean
         FROM public.effective_channel_encryption('f1623000-0000-0000-0000-000000000001') e$q$,
    $q$VALUES (false, false, true)$q$,
    'a server with no policy row leaves channel voice off and unlocked, messages locked off');
SELECT results_eq(
    $q$SELECT (e->>'voice_encrypted')::boolean, (e->>'messages_encrypted')::boolean
         FROM public.set_channel_encryption('f1623000-0000-0000-0000-000000000001', NULL, true) e$q$,
    $q$VALUES (true, false)$q$,
    'the owner turns channel voice on under a disabled message mode; messages stay off');
SELECT is(public.set_channel_encryption('f1623000-0000-0000-0000-000000000002', NULL, true)->>'voice_encrypted',
          'true', 'an explicit disabled message mode lets the owner turn channel voice on');
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('f1623000-0000-0000-0000-000000000001', true)$q$,
    '22023', NULL, 'a disabled message mode still refuses channel messages on');
SELECT tests.clear_authentication();

SELECT is((SELECT voice_encrypted FROM public.channel_encryption_settings
            WHERE channel_id = 'f1623000-0000-0000-0000-000000000001'), true,
          'the row records voice on');
SELECT is(public.channel_messages_encrypted('f1623000-0000-0000-0000-000000000001'), false,
          'channel messages resolve off');
SELECT is(pg_temp.voice_messages('f1623000-0000-0000-0000-000000000001', 'channel_voice_encryption_enabled'), 1,
          'turning voice on posts one system message');
SELECT is(pg_temp.voice_messages('f1623000-0000-0000-0000-000000000001', 'channel_encryption_enabled'), 0,
          'turning voice on posts no message encryption notice');

-- Permissions ------------------------------------------------------------------------
SELECT tests.authenticate_as('f1620000-0000-0000-0000-0000000000b3');
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('f1623000-0000-0000-0000-000000000001', NULL, false)$q$,
    '42501', NULL, 'a plain member cannot change channel voice');
SELECT results_eq(
    $q$SELECT (e->>'voice_encrypted')::boolean, (e->>'voice_locked')::boolean
         FROM public.effective_channel_encryption('f1623000-0000-0000-0000-000000000001') e$q$,
    $q$VALUES (true, false)$q$,
    'a member reads channel voice on and unlocked');

SELECT tests.authenticate_as('f1620000-0000-0000-0000-0000000000b4');
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('f1623000-0000-0000-0000-000000000001', NULL, false)$q$,
    '42501', NULL, 'a non-member cannot change channel voice');
SELECT is(public.effective_channel_encryption('f1623000-0000-0000-0000-000000000001'), NULL,
          'effective_channel_encryption answers NULL to a non-member');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('f1623000-0000-0000-0000-000000000001', NULL, false)$q$,
    '42501', NULL, 'anon cannot change channel voice');

SELECT tests.authenticate_as('f1620000-0000-0000-0000-0000000000b2');
SELECT is(public.set_channel_encryption('f1623000-0000-0000-0000-000000000001', NULL, false)->>'voice_encrypted',
          'false', 'a MANAGE_CHANNELS role holder turns channel voice off under a disabled message mode');
SELECT tests.clear_authentication();

SELECT is((SELECT metadata->>'actor_id' FROM public.messages
            WHERE channel_id = 'f1623000-0000-0000-0000-000000000001'
              AND is_system AND metadata->>'type' = 'channel_voice_encryption_disabled'),
          'f1621000-0000-0000-0000-0000000000b2',
          'turning voice off posts a system message naming the role holder');

-- Voice required ---------------------------------------------------------------------
SELECT is((SELECT voice_encrypted FROM public.channel_encryption_settings
            WHERE channel_id = 'f1623000-0000-0000-0000-000000000003'), true,
          'a server entering required voice writes it into the channel row');

SELECT tests.authenticate_as('f1620000-0000-0000-0000-0000000000b2');
SELECT results_eq(
    $q$SELECT (e->>'voice_encrypted')::boolean, (e->>'voice_locked')::boolean, (e->>'messages_encrypted')::boolean
         FROM public.effective_channel_encryption('f1623000-0000-0000-0000-000000000003') e$q$,
    $q$VALUES (true, true, false)$q$,
    'required voice resolves on and locked while messages stay off');
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('f1623000-0000-0000-0000-000000000003', NULL, false)$q$,
    '22023', NULL, 'required voice refuses channel voice off');
SELECT is(public.set_channel_encryption('f1623000-0000-0000-0000-000000000003', NULL, true)->>'voice_encrypted',
          'true', 'turning voice on under required voice is accepted');
SELECT tests.clear_authentication();
SELECT is(pg_temp.voice_messages('f1623000-0000-0000-0000-000000000003', 'channel_voice_encryption_enabled'), 0,
          'a change that leaves the effective voice state alone posts nothing');

UPDATE public.server_encryption_settings SET voice_encryption_mode = 'disabled'
 WHERE server_id = 'f1622000-0000-0000-0000-000000000003';
SELECT tests.authenticate_as('f1620000-0000-0000-0000-0000000000b2');
SELECT results_eq(
    $q$SELECT (e->>'voice_encrypted')::boolean, (e->>'voice_locked')::boolean
         FROM public.effective_channel_encryption('f1623000-0000-0000-0000-000000000003') e$q$,
    $q$VALUES (true, false)$q$,
    'relaxing required voice to per channel leaves the channel on and unlocks it');
SELECT is(public.set_channel_encryption('f1623000-0000-0000-0000-000000000003', NULL, false)->>'voice_encrypted',
          'false', 'the role holder then turns it off');
SELECT tests.clear_authentication();

-- New channels -----------------------------------------------------------------------
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1623000-0000-0000-0000-000000000005', 'f1622000-0000-0000-0000-000000000002', 'v-new', 1);
SELECT is((SELECT voice_encrypted FROM public.channel_encryption_settings
            WHERE channel_id = 'f1623000-0000-0000-0000-000000000005'), false,
          'a new voice channel under per-channel voice starts off');

-- Message rules unchanged ------------------------------------------------------------
SELECT tests.authenticate_as('f1620000-0000-0000-0000-0000000000b1');
SELECT results_eq(
    $q$SELECT (e->>'messages_encrypted')::boolean, (e->>'voice_encrypted')::boolean
         FROM public.set_channel_encryption('f1623000-0000-0000-0000-000000000004', true) e$q$,
    $q$VALUES (true, false)$q$,
    'an optional server turns channel messages on without touching voice');
SELECT is(public.effective_channel_encryption('f1623000-0000-0000-0000-000000000004')->>'messages_locked',
          'false', 'messages stay unlocked under optional');
SELECT tests.clear_authentication();
UPDATE public.server_encryption_settings SET encryption_mode = 'required'
 WHERE server_id = 'f1622000-0000-0000-0000-000000000004';
SELECT tests.authenticate_as('f1620000-0000-0000-0000-0000000000b1');
SELECT throws_ok(
    $q$SELECT public.set_channel_encryption('f1623000-0000-0000-0000-000000000004', false)$q$,
    '22023', NULL, 'a required message mode still refuses channel messages off');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
