-- check_reaction_emoji from 20261107800001_reaction_emoji_check.sql: a reaction a client writes
-- names a unicode emoji, a shortcode or Discord form, an emoji that is not removed, or one
-- already on the message; never a bare word.
--
--   alice  (aaaaaaaa / 11111111) owner of server_1, reacts
--   bob    (bbbbbbbb / 22222222) member; bridged pills are written in his name
-- Message 88888888 sits in server_1's general channel.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(20);

INSERT INTO public.emojis (id, name, url, server_id, uploader, scope) VALUES
  ('e2430000-0000-0000-0000-000000000001', 'srv', 'https://x.test/storage/v1/object/public/emojis/s/srv.png',
   '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 'server'),
  ('e2430000-0000-0000-0000-000000000002', 'gone', 'https://x.test/storage/v1/object/public/emojis/s/gone.png',
   '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 'server'),
  ('e2430000-0000-0000-0000-000000000003', 'bobs', 'https://x.test/storage/v1/object/public/emojis/u/bobs.png',
   NULL, '22222222-0000-0000-0000-000000000002', 'user'),
  ('e2430000-0000-0000-0000-000000000004', 'imported_wave', 'https://x.test/storage/v1/object/public/emojis/s/wave.png',
   '55555555-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 'server');
UPDATE public.emojis SET deleted_at = now() WHERE id = 'e2430000-0000-0000-0000-000000000002';

-- Bridged pills the Discord bridge left on the message (service role).
INSERT INTO public.reactions (message_id, user_id, custom_emoji_content, metadata) VALUES
  ('88888888-0000-0000-0000-000000000008', '22222222-0000-0000-0000-000000000002', 'discord:pepe:123456789012345678',
   '{"remote_emoji_name": "pepe", "remote_emoji_url": "https://cdn.discordapp.com/emojis/123456789012345678.gif"}'),
  ('88888888-0000-0000-0000-000000000008', '22222222-0000-0000-0000-000000000002', 'discord:kek:223456789012345678',
   '{"remote_emoji_name": "kek", "remote_emoji_url": "https://cdn.discordapp.com/emojis/223456789012345678.png"}');

-- A channel whose @everyone is denied USE_EXTERNAL_EMOJIS (1 << 19), with a bridged pill.
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('e2430000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'noexternal', 0);
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT 'e2430000-0000-0000-0000-0000000000c1', 'role', r.id, 0, 524288
  FROM public.server_roles r WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES ('e2430000-0000-0000-0000-0000000000d1', 'e2430000-0000-0000-0000-0000000000c1',
        '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"no external emoji here"}]');
INSERT INTO public.reactions (message_id, user_id, custom_emoji_content, metadata)
VALUES ('e2430000-0000-0000-0000-0000000000d1', '11111111-0000-0000-0000-000000000001', 'discord:lol:323456789012345678',
        '{"remote_emoji_name": "lol"}');

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
SELECT lives_ok($$ SELECT tests.react243(NULL, 'kek') $$, 'a bare name naming a pill on the message is accepted');
SELECT is((SELECT custom_emoji_content FROM public.reactions
            WHERE message_id = '88888888-0000-0000-0000-000000000008' AND user_id = '11111111-0000-0000-0000-000000000001'
              AND custom_emoji_content LIKE 'discord:kek:%'), 'discord:kek:223456789012345678',
          'and stored as that pill''s identifier');
SELECT is((SELECT metadata ->> 'remote_emoji_url' FROM public.reactions
            WHERE message_id = '88888888-0000-0000-0000-000000000008' AND user_id = '11111111-0000-0000-0000-000000000001'
              AND custom_emoji_content LIKE 'discord:kek:%'), 'https://cdn.discordapp.com/emojis/223456789012345678.png',
          'with the pill''s image');
SELECT throws_ok($$ SELECT tests.react243(NULL, 'nosuchpill') $$, '22023', NULL, 'a bare name naming no pill or emoji is refused');
SELECT lives_ok($$ SELECT tests.react243(NULL, 'imported_wave') $$, 'a bare name naming an emoji of the server is accepted');
SELECT is((SELECT emoji_id FROM public.reactions
            WHERE message_id = '88888888-0000-0000-0000-000000000008' AND user_id = '11111111-0000-0000-0000-000000000001'
              AND emoji_id = 'e2430000-0000-0000-0000-000000000004'), 'e2430000-0000-0000-0000-000000000004'::uuid,
          'and stored as that emoji');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($$ INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
                    VALUES ('e2430000-0000-0000-0000-0000000000d1', '22222222-0000-0000-0000-000000000002', 'lol') $$,
                 '42501', 'Missing permission: USE_EXTERNAL_EMOJIS',
                 'the rewritten pill passes USE_EXTERNAL_EMOJIS, which the bare name skipped');
SELECT tests.clear_authentication();

SET LOCAL ROLE service_role;
INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
VALUES ('88888888-0000-0000-0000-000000000008', '22222222-0000-0000-0000-000000000002', 'RIP');
RESET ROLE;
SELECT ok(EXISTS (SELECT 1 FROM public.reactions WHERE message_id = '88888888-0000-0000-0000-000000000008'
                    AND user_id = '22222222-0000-0000-0000-000000000002' AND custom_emoji_content = 'RIP'),
          'service-role writes (federation, bridge, bots) are not checked');

SELECT is((SELECT count(*)::int FROM public.reactions WHERE message_id = '88888888-0000-0000-0000-000000000008'
             AND user_id = '11111111-0000-0000-0000-000000000001'), 5, 'the member holds the five accepted reactions');

SELECT * FROM finish();
ROLLBACK;
