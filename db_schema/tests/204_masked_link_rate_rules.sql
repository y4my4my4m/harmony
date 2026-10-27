-- Masked links (20261030900001) under AutoMod's rate rules. The cross-channel duplicate rule
-- fingerprints text and link labels; the new-account link limit sees the url part of a masked
-- link, so a label never hides a link from it.
--
-- Fixture bob (new, local, not staff). Added here:
--   AutoMod 204   a server alice owns, bob a member; channels dup204a, dup204b, dup204c

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(6);

INSERT INTO public.servers (id, name, owner) VALUES
  ('a2040000-0000-0000-0000-0000000000c1', 'AutoMod 204', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('a2040000-0000-0000-0000-0000000000d1', 'a2040000-0000-0000-0000-0000000000c1', 'dup204a', 0),
  ('a2040000-0000-0000-0000-0000000000d2', 'a2040000-0000-0000-0000-0000000000c1', 'dup204b', 0),
  ('a2040000-0000-0000-0000-0000000000d3', 'a2040000-0000-0000-0000-0000000000c1', 'dup204c', 0);
UPDATE public.server_automod_settings
   SET raid_settings = raid_settings || '{"enabled": false}'::jsonb
 WHERE server_id = 'a2040000-0000-0000-0000-0000000000c1';
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'a2040000-0000-0000-0000-0000000000c1', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'a2040000-0000-0000-0000-0000000000c1', 'accepted');

CREATE FUNCTION pg_temp.post(p_channel text, p_content jsonb)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  INSERT INTO public.messages (channel_id, user_id, content)
  VALUES (('a2040000-0000-0000-0000-0000000000d' || p_channel)::uuid, '22222222-0000-0000-0000-000000000002', p_content);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('a2040000-0000-0000-0000-0000000000c1',
                   '{"name": "Cross-channel", "rule_type": "duplicate_spam",
                     "config": {"max_channels": 2, "window_seconds": 300, "min_length": 10},
                     "actions": {"block": true}}'::jsonb)$q$,
                'the owner adds a cross-channel duplicate rule');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.post('1', '[{"type":"url","url":"https://a.example/1","preview":true,"label":"watch my brand new stream"}]')
          + pg_temp.post('2', '[{"type":"url","url":"https://a.example/2","preview":true,"label":"Watch my BRAND new stream"}]'),
          2, 'one label behind two links passes in two channels');
SELECT is(pg_temp.post('3', '[{"type":"url","url":"https://b.example/3","preview":true,"label":"watch my brand new stream"}]'),
          0, 'the same label in a third channel is blocked, whatever the link');
SELECT is(pg_temp.post('3', '[{"type":"text","text":"something "},{"type":"url","url":"https://b.example/4","preview":true,"label":"else entirely"}]'),
          1, 'a different label in the third channel passes');

SELECT tests.clear_authentication();
INSERT INTO public.instance_config (config_key, config_value)
VALUES ('antispam', '{"new_account_block_links": true, "new_account_hours": 24}'::jsonb)
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;
SELECT throws_like($q$SELECT public.antispam_check_local_author('22222222-0000-0000-0000-000000000002', 'message',
                       '[{"type":"url","url":"https://evil.example/x","preview":true,"label":"harmless words"}]'::jsonb, 'INSERT')$q$,
                   'ANTISPAM_LINKS_BLOCKED%', 'a new account cannot post a masked link');
SELECT lives_ok($q$SELECT public.antispam_check_local_author('22222222-0000-0000-0000-000000000002', 'message',
                     '[{"type":"text","text":"no links here"}]'::jsonb, 'INSERT')$q$,
                'text without a link passes the new-account link limit (control)');

SELECT * FROM finish();
ROLLBACK;
