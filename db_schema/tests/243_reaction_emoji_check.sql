-- check_reaction_emoji from 20261107800001_reaction_emoji_check.sql: a reaction a client writes
-- names a unicode emoji, a shortcode or Discord form, an emoji that is not removed, or one
-- already on the message; never a bare word.
--
--   alice  (aaaaaaaa / 11111111) owner of server_1, reacts
--   bob    (bbbbbbbb / 22222222) left a bridged pill on the message
-- Message 88888888 sits in server_1's general channel.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(13);

INSERT INTO public.emojis (id, name, url, server_id, uploader, scope) VALUES
  ('e2430000-0000-0000-0000-000000000001', 'srv', 'https://x.test/storage/v1/object/public/emojis/s/srv.png',
   '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 'server'),
  ('e2430000-0000-0000-0000-000000000002', 'gone', 'https://x.test/storage/v1/object/public/emojis/s/gone.png',
   '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 'server'),
  ('e2430000-0000-0000-0000-000000000003', 'bobs', 'https://x.test/storage/v1/object/public/emojis/u/bobs.png',
   NULL, '22222222-0000-0000-0000-000000000002', 'user');
UPDATE public.emojis SET deleted_at = now() WHERE id = 'e2430000-0000-0000-0000-000000000002';

-- A bridged pill another writer left on the message.
INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
VALUES ('88888888-0000-0000-0000-000000000008', '22222222-0000-0000-0000-000000000002', 'discord:pepe:123456789012345678');

CREATE FUNCTION tests.react243(p_emoji_id uuid, p_content text) RETURNS void
LANGUAGE sql AS $fn$
  INSERT INTO public.reactions (message_id, user_id, emoji_id, custom_emoji_content)
  VALUES ('88888888-0000-0000-0000-000000000008', '11111111-0000-0000-0000-000000000001', p_emoji_id, p_content)
$fn$;
GRANT EXECUTE ON FUNCTION tests.react243(uuid, text) TO authenticated;

SELECT ok(public.reaction_content_well_formed('🎉'), 'one emoji is well formed');
SELECT ok(public.reaction_content_well_formed('👍🏽') AND public.reaction_content_well_formed('🤷‍♂️') AND public.reaction_content_well_formed('1️⃣'),
          'so are modifier, ZWJ and keycap sequences');
SELECT ok(public.reaction_content_well_formed(':blob:') AND public.reaction_content_well_formed(':blob@remote.example:')
          AND public.reaction_content_well_formed('discord:pepe:123456789012345678'),
          'and the shortcode and Discord forms');
SELECT ok(NOT public.reaction_content_well_formed('RIP') AND NOT public.reaction_content_well_formed('6303_monkaSTEER')
          AND NOT public.reaction_content_well_formed('123') AND NOT public.reaction_content_well_formed('a b'),
          'bare names, bare digits and text are not');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($$ SELECT tests.react243(NULL, '🎉') $$, 'a member reacts with a unicode emoji');
SELECT throws_ok($$ SELECT tests.react243(NULL, 'RIP') $$, '22023', NULL, 'a bare name is refused');
SELECT throws_ok($$ SELECT tests.react243(NULL, '6303_monkaSTEER') $$, '22023', NULL, 'so is a Discord-style name');
SELECT throws_ok($$ SELECT tests.react243(NULL, NULL) $$, '22023', NULL, 'a reaction naming nothing is refused');
SELECT lives_ok($$ SELECT tests.react243('e2430000-0000-0000-0000-000000000001', NULL) $$, 'a server emoji of the server');
SELECT throws_ok($$ SELECT tests.react243('e2430000-0000-0000-0000-000000000002', NULL) $$, '22023', NULL, 'a removed emoji is refused');
SELECT lives_ok($$ SELECT tests.react243(NULL, 'discord:pepe:123456789012345678') $$, 'joining a bridged pill already on the message');
SELECT tests.clear_authentication();

SET LOCAL ROLE service_role;
INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
VALUES ('88888888-0000-0000-0000-000000000008', '22222222-0000-0000-0000-000000000002', 'RIP');
RESET ROLE;
SELECT ok(EXISTS (SELECT 1 FROM public.reactions WHERE message_id = '88888888-0000-0000-0000-000000000008'
                    AND user_id = '22222222-0000-0000-0000-000000000002' AND custom_emoji_content = 'RIP'),
          'service-role writes (federation, bridge, bots) are not checked');

SELECT is((SELECT count(*)::int FROM public.reactions WHERE message_id = '88888888-0000-0000-0000-000000000008'
             AND user_id = '11111111-0000-0000-0000-000000000001'), 3, 'the member holds the three accepted reactions');

SELECT * FROM finish();
ROLLBACK;
