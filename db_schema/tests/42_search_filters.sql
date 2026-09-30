-- Search filters (migration 20261002000001): the derived index columns, the trigger that
-- keeps them, search_messages' filters and visibility, and the backfill.
--
-- Fixture roles: alice owns server_1; bob is an accepted member with @everyone only; mallory
-- belongs to nothing. Local: dana, a member with a member override allowing VIEW_CHANNEL on
-- #hidden42.
--
-- Channels on server_1: #search42 (open), #hidden42 (@everyone denied VIEW_CHANNEL).
-- Conversations: dm42 (alice, bob); left42 (alice, bob; bob has left).
--
--   M1  #search42  alice  01-10  "walrus sighting at dawn", url
--   M2  #search42  bob    01-11  "narwhal photo", image file
--   M3  #search42  alice  01-12  "clip", file typed video/mp4
--   M4  #search42  bob    01-13  "listen", mention of alice, audio file
--   M5  #search42  alice  01-14  "notes", generic file
--   M6  #search42  alice  01-15  "walrus again", embed part
--   M7  #search42  bob    01-16  "link", url, link preview in metadata.embeds
--   M12 #search42  alice  01-17  CJK text
--   M13 #search42  bob    01-18  "later preview", url; preview added by an update
--   M8  #hidden42  alice  01-12  "walrus secret"
--   M9  dm42       alice  01-10  "walrus in dm", image file
--   M10 dm42       bob    01-11  encrypted; ciphertext part reads "walrus", image file part
--   M11 left42     alice  01-10  "walrus left behind"

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(47);

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES ('f4200000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'dana42@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
VALUES ('f4210000-0000-0000-0000-0000000000a1', 'f4200000-0000-0000-0000-0000000000a1', 'dana42', 'Dana', true);
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('f4210000-0000-0000-0000-0000000000a1', '55555555-0000-0000-0000-000000000005', 'accepted');

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f4220000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'hidden42', 0),
  ('f4220000-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005', 'search42', 0);

-- Bits: 1 VIEW_CHANNEL, 12 SEND_MESSAGES.
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f4220000-0000-0000-0000-000000000001', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
VALUES ('f4220000-0000-0000-0000-000000000001', 'user', NULL, 'f4210000-0000-0000-0000-0000000000a1', 4098, 0);

INSERT INTO public.conversations (id, type) VALUES
  ('f4230000-0000-0000-0000-000000000001', 'direct'),
  ('f4230000-0000-0000-0000-000000000002', 'direct');
INSERT INTO public.conversation_participants (conversation_id, user_id, left_at) VALUES
  ('f4230000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', NULL),
  ('f4230000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', NULL),
  ('f4230000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', NULL),
  ('f4230000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', now());

INSERT INTO public.messages (id, channel_id, conversation_id, user_id, content, created_at, encrypted, metadata) VALUES
  ('f4240000-0000-0000-0000-000000000001', 'f4220000-0000-0000-0000-000000000002', NULL,
   '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"walrus sighting at dawn "},{"type":"url","url":"https://example.com/w"}]',
   '2026-01-10 12:00+00', false, '{}'),
  ('f4240000-0000-0000-0000-000000000002', 'f4220000-0000-0000-0000-000000000002', NULL,
   '22222222-0000-0000-0000-000000000002',
   '[{"type":"text","text":"narwhal photo"},{"type":"file","url":"https://cdn/n.png","fileType":"image"}]',
   '2026-01-11 12:00+00', false, '{}'),
  ('f4240000-0000-0000-0000-000000000003', 'f4220000-0000-0000-0000-000000000002', NULL,
   '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"clip"},{"type":"file","url":"https://cdn/c.mp4","fileType":"video/mp4"}]',
   '2026-01-12 12:00+00', false, '{}'),
  ('f4240000-0000-0000-0000-000000000004', 'f4220000-0000-0000-0000-000000000002', NULL,
   '22222222-0000-0000-0000-000000000002',
   '[{"type":"text","text":"listen "},{"type":"mention","userId":"11111111-0000-0000-0000-000000000001","username":"alice","domain":"test.local","isLocal":true},{"type":"file","url":"https://cdn/a.ogg","fileType":"audio"}]',
   '2026-01-13 12:00+00', false, '{}'),
  ('f4240000-0000-0000-0000-000000000005', 'f4220000-0000-0000-0000-000000000002', NULL,
   '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"notes"},{"type":"file","url":"https://cdn/n.zip","fileType":"file"}]',
   '2026-01-14 12:00+00', false, '{}'),
  ('f4240000-0000-0000-0000-000000000006', 'f4220000-0000-0000-0000-000000000002', NULL,
   '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"walrus again"},{"type":"embed","url":"https://example.com/e","provider":"generic","previewId":"p1"}]',
   '2026-01-15 12:00+00', false, '{}'),
  ('f4240000-0000-0000-0000-000000000007', 'f4220000-0000-0000-0000-000000000002', NULL,
   '22222222-0000-0000-0000-000000000002',
   '[{"type":"text","text":"link "},{"type":"url","url":"https://example.com/l"}]',
   '2026-01-16 12:00+00', false, '{"embeds":{"https://example.com/l":{"title":"L"}}}'),
  ('f4240000-0000-0000-0000-000000000012', 'f4220000-0000-0000-0000-000000000002', NULL,
   '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"日本語のテキストです"}]',
   '2026-01-17 12:00+00', false, '{}'),
  ('f4240000-0000-0000-0000-000000000013', 'f4220000-0000-0000-0000-000000000002', NULL,
   '22222222-0000-0000-0000-000000000002',
   '[{"type":"text","text":"later preview "},{"type":"url","url":"https://example.com/p"}]',
   '2026-01-18 12:00+00', false, '{}'),
  ('f4240000-0000-0000-0000-000000000008', 'f4220000-0000-0000-0000-000000000001', NULL,
   '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"walrus secret"}]',
   '2026-01-12 12:00+00', false, '{}'),
  ('f4240000-0000-0000-0000-000000000009', NULL, 'f4230000-0000-0000-0000-000000000001',
   '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"walrus in dm"},{"type":"file","url":"https://cdn/d.png","fileType":"image"}]',
   '2026-01-10 12:00+00', false, '{}'),
  ('f4240000-0000-0000-0000-000000000010', NULL, 'f4230000-0000-0000-0000-000000000001',
   '22222222-0000-0000-0000-000000000002',
   '[{"type":"text","text":"walrus ciphertext"},{"type":"file","url":"https://cdn/x.png","fileType":"image"}]',
   '2026-01-11 12:00+00', true, '{}'),
  ('f4240000-0000-0000-0000-000000000011', NULL, 'f4230000-0000-0000-0000-000000000002',
   '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"walrus left behind"}]',
   '2026-01-10 12:00+00', false, '{}');

-- DERIVED COLUMNS ------------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT right(message_id::text, 2), has_media, has_url, has_image, has_video, has_audio,
              has_embed, mentioned_user_ids
         FROM public.message_search_index
        WHERE message_id::text LIKE 'f4240000-%'
          AND right(message_id::text, 2) IN ('01', '02', '03', '04', '05', '06', '07', '13')
        ORDER BY message_id$q$,
    $q$VALUES ('01', false, true,  false, false, false, false, '{}'::uuid[]),
              ('02', true,  false, true,  false, false, false, '{}'::uuid[]),
              ('03', true,  false, false, true,  false, false, '{}'::uuid[]),
              ('04', true,  false, false, false, true,  false, '{11111111-0000-0000-0000-000000000001}'::uuid[]),
              ('05', true,  false, false, false, false, false, '{}'::uuid[]),
              ('06', false, false, false, false, false, true,  '{}'::uuid[]),
              ('07', false, true,  false, false, false, true,  '{}'::uuid[]),
              ('13', false, true,  false, false, false, false, '{}'::uuid[])$q$,
    'filter columns derive from content parts and metadata.embeds');

SELECT results_eq(
    $q$SELECT content_text, has_media, has_image FROM public.message_search_index
        WHERE message_id = 'f4240000-0000-0000-0000-000000000010'$q$,
    $q$VALUES ('', false, false)$q$,
    'an encrypted message is indexed without text or content flags');

UPDATE public.messages SET is_pinned = true WHERE id = 'f4240000-0000-0000-0000-000000000002';
SELECT is((SELECT is_pinned FROM public.message_search_index
            WHERE message_id = 'f4240000-0000-0000-0000-000000000002'), true,
          'pinning a message marks its index row');

UPDATE public.messages SET is_pinned = true WHERE id = 'f4240000-0000-0000-0000-000000000005';
UPDATE public.messages SET is_pinned = false WHERE id = 'f4240000-0000-0000-0000-000000000005';
SELECT is((SELECT is_pinned FROM public.message_search_index
            WHERE message_id = 'f4240000-0000-0000-0000-000000000005'), false,
          'unpinning a message clears its index row');

-- update_message_embeds writes previews into metadata after the insert.
UPDATE public.messages
   SET metadata = metadata || '{"embeds":{"https://example.com/p":{"title":"P"}}}'
 WHERE id = 'f4240000-0000-0000-0000-000000000013';
SELECT is((SELECT has_embed FROM public.message_search_index
            WHERE message_id = 'f4240000-0000-0000-0000-000000000013'), true,
          'a link preview written later sets has_embed');

CREATE TEMP TABLE row_before42 AS
SELECT ctid AS tid FROM public.message_search_index WHERE message_id = 'f4240000-0000-0000-0000-000000000001';
UPDATE public.messages SET metadata = metadata || '{"note":1}' WHERE id = 'f4240000-0000-0000-0000-000000000001';
SELECT is((SELECT ctid FROM public.message_search_index WHERE message_id = 'f4240000-0000-0000-0000-000000000001'),
          (SELECT tid FROM row_before42),
          'a metadata change outside embeds leaves the index row alone');

UPDATE public.messages SET is_deleted = true WHERE id = 'f4240000-0000-0000-0000-000000000005';
UPDATE public.messages SET is_deleted = false WHERE id = 'f4240000-0000-0000-0000-000000000005';
SELECT is((SELECT has_media FROM public.message_search_index
            WHERE message_id = 'f4240000-0000-0000-0000-000000000005'), true,
          'an undeleted message is indexed again with its flags');

-- GRANTS ---------------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('anon',
    'public.search_messages(text, uuid, uuid[], uuid, uuid, uuid, boolean, boolean, timestamp with time zone, timestamp with time zone, integer, integer, uuid[], uuid[], boolean, boolean, boolean, boolean, boolean, text, boolean)',
    'EXECUTE'), 'anon cannot call search_messages');
SELECT ok(NOT has_function_privilege('authenticated', 'public.index_message_row(public.messages)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.message_search_flags(public.messages)', 'EXECUTE'),
          'clients cannot call the indexer helpers');

-- VISIBILITY -----------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_eq(
    $q$SELECT message_id FROM public.search_messages(p_query => 'walrus', p_server_id => '55555555-0000-0000-0000-000000000005')$q$,
    ARRAY['f4240000-0000-0000-0000-000000000001', 'f4240000-0000-0000-0000-000000000006']::uuid[],
    'a member finds nothing in a channel VIEW_CHANNEL hides');
SELECT is_empty(
    $q$SELECT 1 FROM public.search_messages(p_channel_ids => ARRAY['f4220000-0000-0000-0000-000000000001']::uuid[])$q$,
    'naming a hidden channel does not reveal it');
SELECT set_eq(
    $q$SELECT message_id FROM public.search_messages(p_query => 'walrus')$q$,
    ARRAY['f4240000-0000-0000-0000-000000000001', 'f4240000-0000-0000-0000-000000000006',
          'f4240000-0000-0000-0000-000000000009']::uuid[],
    'an unscoped search covers visible channels and current conversations only');
SELECT is_empty(
    $q$SELECT 1 FROM public.search_messages(p_conversation_id => 'f4230000-0000-0000-0000-000000000002')$q$,
    'a participant who left searches nothing in that conversation');
SELECT is_empty(
    $q$SELECT 1 FROM public.search_messages(p_conversation_id => 'f4230000-0000-0000-0000-000000000001',
                                            p_server_id => '55555555-0000-0000-0000-000000000005')$q$,
    'a conversation and a server scope together match nothing');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_eq(
    $q$SELECT message_id FROM public.search_messages(p_query => 'walrus', p_server_id => '55555555-0000-0000-0000-000000000005')$q$,
    ARRAY['f4240000-0000-0000-0000-000000000001', 'f4240000-0000-0000-0000-000000000006',
          'f4240000-0000-0000-0000-000000000008']::uuid[],
    'the server owner searches the hidden channel');

SELECT tests.authenticate_as('f4200000-0000-0000-0000-0000000000a1');
SELECT set_eq(
    $q$SELECT message_id FROM public.search_messages(p_query => 'walrus', p_server_id => '55555555-0000-0000-0000-000000000005')$q$,
    ARRAY['f4240000-0000-0000-0000-000000000001', 'f4240000-0000-0000-0000-000000000006',
          'f4240000-0000-0000-0000-000000000008']::uuid[],
    'a member override allowing VIEW_CHANNEL opens the hidden channel to search');
SELECT is_empty(
    $q$SELECT 1 FROM public.search_messages(p_conversation_id => 'f4230000-0000-0000-0000-000000000001')$q$,
    'a non-participant searches nothing in a conversation');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty($q$SELECT 1 FROM public.search_messages(p_query => 'walrus')$q$,
    'a user in no server and no conversation finds nothing');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT 1 FROM public.search_messages(p_query => 'walrus')$q$,
    '42501', NULL, 'anon is refused');

-- FILTERS, as bob, over #search42 --------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[],
          p_user_ids => ARRAY['22222222-0000-0000-0000-000000000002']::uuid[])$q$,
    ARRAY['02', '04', '07', '13'], 'from: matches the author');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[],
          p_user_id => '11111111-0000-0000-0000-000000000001',
          p_user_ids => ARRAY['22222222-0000-0000-0000-000000000002']::uuid[], p_has_media => true)$q$,
    ARRAY['02', '03', '04', '05'], 'p_user_id and p_user_ids combine as either author');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[],
          p_mentioned_user_ids => ARRAY['11111111-0000-0000-0000-000000000001']::uuid[])$q$,
    ARRAY['04'], 'mentions: matches a mention part');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[], p_has_image => true)$q$,
    ARRAY['02'], 'has:image');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[], p_has_video => true)$q$,
    ARRAY['03'], 'has:video matches a MIME-typed file');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[], p_has_audio => true)$q$,
    ARRAY['04'], 'has:sound');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[], p_has_media => true)$q$,
    ARRAY['02', '03', '04', '05'], 'has:file matches any file part');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[], p_has_embed => true)$q$,
    ARRAY['06', '07', '13'], 'has:embed matches embed parts and link previews');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[], p_has_url => true)$q$,
    ARRAY['01', '07', '13'], 'has:link');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[], p_pinned => true)$q$,
    ARRAY['02'], 'pinned:true');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[],
          p_from_date => '2026-01-11 00:00+00', p_to_date => '2026-01-13 23:59:59.999999+00')$q$,
    ARRAY['02', '03', '04'], 'a date range bounds created_at inclusively');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_query => 'walrus',
          p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[],
          p_user_ids => ARRAY['11111111-0000-0000-0000-000000000001']::uuid[], p_has_url => true)$q$,
    ARRAY['01'], 'text, author and has: combine');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_query => '"walrus sighting"', p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[])$q$,
    ARRAY['01'], 'a quoted phrase matches in order');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_query => 'walrus -sighting', p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[])$q$,
    ARRAY['06'], 'a minus excludes a word');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_query => 'テキスト', p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[])$q$,
    ARRAY['12'], 'CJK text matches as a substring');

-- PAGING AND ORDER -----------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT right(message_id::text, 2), total_count FROM public.search_messages(
          p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[], p_limit => 2, p_with_total => true)$q$,
    $q$VALUES ('13', 9::bigint), ('12', 9::bigint)$q$,
    'newest first by default without a query, with the full count on a short page');
SELECT results_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(
          p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[], p_sort => 'oldest', p_limit => 2, p_offset => 1)$q$,
    $q$VALUES ('02'), ('03')$q$,
    'oldest first, offset past the first row');
SELECT is((SELECT count(*)::int FROM public.search_messages(p_channel_ids => '{f4220000-0000-0000-0000-000000000002}'::uuid[], p_offset => 50)), 0,
    'an offset past the end returns no row');
SELECT is((SELECT max(total_count) FROM public.search_messages(p_query => 'walrus')), NULL,
    'total_count is NULL unless asked for');

-- DMs, as bob ----------------------------------------------------------------------------
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_conversation_id => 'f4230000-0000-0000-0000-000000000001')$q$,
    ARRAY['09', '10'], 'a participant searches the conversation by filters alone');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_query => 'walrus', p_conversation_id => 'f4230000-0000-0000-0000-000000000001')$q$,
    ARRAY['09'], 'an encrypted message is not matched by its ciphertext');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_conversation_id => 'f4230000-0000-0000-0000-000000000001',
          p_user_ids => ARRAY['22222222-0000-0000-0000-000000000002']::uuid[])$q$,
    ARRAY['10'], 'from: finds an encrypted message by its author');
SELECT set_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_conversation_id => 'f4230000-0000-0000-0000-000000000001', p_has_image => true)$q$,
    ARRAY['09'], 'has: ignores the file parts of an encrypted message');

-- The twelve-parameter call of the previous signature.
SELECT set_eq(
    $q$SELECT message_id FROM public.search_messages('walrus', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 50, 0)$q$,
    ARRAY['f4240000-0000-0000-0000-000000000001', 'f4240000-0000-0000-0000-000000000006',
          'f4240000-0000-0000-0000-000000000009']::uuid[],
    'the previous positional signature still resolves');

-- BACKFILL -------------------------------------------------------------------------------
SELECT tests.clear_authentication();

-- The rows as the previous indexer left them: new columns at their defaults.
UPDATE public.message_search_index
   SET has_image = false, has_video = false, has_audio = false, has_embed = false,
       is_pinned = false, mentioned_user_ids = '{}'
 WHERE message_id::text LIKE 'f4240000-%';

-- The migration's backfill: flags from message_search_flags, rows at their defaults skipped.
UPDATE public.message_search_index i
   SET has_media = f.has_media, has_url = f.has_url, has_image = f.has_image,
       has_video = f.has_video, has_audio = f.has_audio, has_embed = f.has_embed,
       is_pinned = f.is_pinned, mentioned_user_ids = f.mentioned_user_ids
  FROM public.messages m
 CROSS JOIN LATERAL public.message_search_flags(m) f
 WHERE m.id = i.message_id
   AND (i.has_media, i.has_url, i.has_image, i.has_video, i.has_audio, i.has_embed, i.is_pinned,
        i.mentioned_user_ids)
       IS DISTINCT FROM
       (f.has_media, f.has_url, f.has_image, f.has_video, f.has_audio, f.has_embed, f.is_pinned,
        f.mentioned_user_ids);

SELECT is_empty(
    $q$SELECT i.message_id
         FROM public.message_search_index i
         JOIN public.messages m ON m.id = i.message_id
        CROSS JOIN LATERAL public.message_search_flags(m) f
        WHERE (i.has_media, i.has_url, i.has_image, i.has_video, i.has_audio, i.has_embed,
               i.is_pinned, i.mentioned_user_ids)
              IS DISTINCT FROM
              (f.has_media, f.has_url, f.has_image, f.has_video, f.has_audio, f.has_embed,
               f.is_pinned, f.mentioned_user_ids)$q$,
    'after the backfill every index row equals what the trigger writes');
SELECT is((SELECT is_pinned FROM public.message_search_index WHERE message_id = 'f4240000-0000-0000-0000-000000000002'), true,
    'the backfill restores pinned state');

-- The migration's catch-up path rewrites a whole row.
UPDATE public.message_search_index
   SET has_image = false, content_text = 'stale', content_tsvector = to_tsvector('english', 'stale')
 WHERE message_id = 'f4240000-0000-0000-0000-000000000002';
SELECT public.index_message_row(m) FROM public.messages m WHERE m.id = 'f4240000-0000-0000-0000-000000000002';
SELECT results_eq(
    $q$SELECT has_image, content_text FROM public.message_search_index
        WHERE message_id = 'f4240000-0000-0000-0000-000000000002'$q$,
    $q$VALUES (true, 'narwhal photo')$q$,
    'index_message_row rewrites a stale row from its message');
SELECT is_empty(
    $q$SELECT m.id FROM public.messages m
        WHERE m.id::text LIKE 'f4240000-%'
          AND NOT EXISTS (SELECT 1 FROM public.message_search_index i WHERE i.message_id = m.id)$q$,
    'every test message is indexed');

SELECT * FROM finish();
ROLLBACK;
