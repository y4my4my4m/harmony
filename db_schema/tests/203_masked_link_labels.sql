-- 20261030900001_masked_link_labels.sql: a url part's label is message text. Previews and
-- search read it (extract_message_text, index_message_row); AutoMod keyword rules see it
-- (automod_message_text).
--
-- Fixture server_1 and its channel 66666666-...-06. Added here:
--   AutoMod 203    a server alice owns, bob a member; channel chat203; keyword rule "badword"

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(9);

SELECT is(public.extract_message_text(
            '[{"type":"text","text":"read "},
              {"type":"url","url":"https://example.com/docs","preview":true,"label":"the docs"},
              {"type":"text","text":" now"}]'::jsonb),
          'read the docs now',
          'a preview reads the label in place');
SELECT is(public.extract_message_text(
            '[{"type":"text","text":"see "},{"type":"url","url":"https://example.com","preview":true}]'::jsonb),
          'see',
          'a url part without a label adds nothing, as before');
SELECT is(public.extract_message_text(
            '[{"type":"url","url":"https://example.com","label":{"x":1}}]'::jsonb),
          '',
          'a label that is not a string is ignored');
SELECT is(public.automod_message_text(
            '[{"type":"text","text":"one"},
              {"type":"url","url":"https://example.com","label":"two"},
              {"type":"text","text":"three"}]'::jsonb),
          E'one\ntwo\nthree',
          'AutoMod reads text and labels in order, a line each');

INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES ('a2030000-0000-0000-0000-00000000000a', '66666666-0000-0000-0000-000000000006',
        '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"read "},{"type":"url","url":"https://example.com/x","preview":true,"label":"walrus handbook"}]');
SELECT ok(EXISTS (SELECT 1 FROM public.message_search_index
                  WHERE message_id = 'a2030000-0000-0000-0000-00000000000a'
                    AND content_tsvector @@ plainto_tsquery('english', 'walrus handbook')),
          'search finds a message by its link label');

-- AutoMod ---------------------------------------------------------------------------------
INSERT INTO public.servers (id, name, owner) VALUES
  ('a2030000-0000-0000-0000-0000000000c1', 'AutoMod 203', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('a2030000-0000-0000-0000-0000000000d1', 'a2030000-0000-0000-0000-0000000000c1', 'chat203', 0);
UPDATE public.server_automod_settings
   SET raid_settings = raid_settings || '{"enabled": false}'::jsonb
 WHERE server_id = 'a2030000-0000-0000-0000-0000000000c1';
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'a2030000-0000-0000-0000-0000000000c1', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'a2030000-0000-0000-0000-0000000000c1', 'accepted');

CREATE FUNCTION pg_temp.post(p_content jsonb)
RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE n integer;
BEGIN
  INSERT INTO public.messages (channel_id, user_id, content)
  VALUES ('a2030000-0000-0000-0000-0000000000d1', '22222222-0000-0000-0000-000000000002', p_content);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.upsert_server_automod_rule('a2030000-0000-0000-0000-0000000000c1',
                   '{"name": "Words", "rule_type": "keyword", "config": {"keywords": ["badword"]},
                     "actions": {"block": true}}'::jsonb)$q$,
                'the owner adds a keyword rule');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.post('[{"type":"text","text":"say "},{"type":"url","url":"https://example.com","preview":true,"label":"BADWORD here"}]'),
          0, 'a keyword in a link label is blocked');
SELECT is(pg_temp.post('[{"type":"text","text":"say badword"}]'),
          0, 'the same keyword in text is blocked (control)');
SELECT is(pg_temp.post('[{"type":"text","text":"say "},{"type":"url","url":"https://example.com","preview":true,"label":"good words"}]'),
          1, 'a clean label is written');

SELECT * FROM finish();
ROLLBACK;
