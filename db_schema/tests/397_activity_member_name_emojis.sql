-- 20261125900001_activity_member_name_emojis.sql: the relay's member carries the custom emojis of
-- the display name.
--
--   DM 77...07   alice + bob; alice starts DrawinPhone there
--   alice        display name "Alice :cat: :dog:", display_name_emojis cat and dog plus two broken entries
--   bob          federation_metadata a JSON string (legacy rows)
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(4);

UPDATE public.profiles
   SET display_name = 'Alice :cat: :dog:',
       federation_metadata = jsonb_build_object('display_name_emojis', jsonb_build_array(
         jsonb_build_object('name', 'cat', 'url', 'https://emoji.test/cat.png', 'id', gen_random_uuid()),
         jsonb_build_object('name', '', 'url', 'https://emoji.test/x.png'),
         jsonb_build_object('name', 'nourl'),
         '"cow"'::jsonb,
         jsonb_build_object('name', 'dog', 'url', 'https://emoji.test/dog.png')))
 WHERE id = '11111111-0000-0000-0000-000000000001';
UPDATE public.profiles
   SET federation_metadata = to_jsonb('{"display_name_emojis": [{"name": "cat", "url": "https://emoji.test/cat.png"}]}'::text)
 WHERE id = '22222222-0000-0000-0000-000000000002';

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
CREATE TEMP TABLE started ON COMMIT DROP AS
  SELECT public.start_activity_session('drawinphone', '77777777-0000-0000-0000-000000000007', NULL) AS r;
SELECT tests.clear_authentication();

CREATE FUNCTION pg_temp.member(p_profile uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.activity_session_admit((SELECT (r -> 'session' ->> 'id')::uuid FROM started), p_profile) -> 'member'
$$;

SELECT is(pg_temp.member('11111111-0000-0000-0000-000000000001') ->> 'display_name', 'Alice :cat: :dog:',
  'the display name keeps its shortcodes');
SELECT is(pg_temp.member('11111111-0000-0000-0000-000000000001') -> 'display_name_emojis',
  '[{"name": "cat", "url": "https://emoji.test/cat.png"}, {"name": "dog", "url": "https://emoji.test/dog.png"}]'::jsonb,
  'alice carries cat and dog in order, without ids, the broken entries left out');
SELECT is(pg_temp.member('22222222-0000-0000-0000-000000000002') -> 'display_name_emojis', '[]'::jsonb,
  'a string-encoded federation_metadata gives none');

UPDATE public.profiles
   SET federation_metadata = jsonb_build_object('display_name_emojis', (
         SELECT jsonb_agg(jsonb_build_object('name', 'e' || i, 'url', 'https://emoji.test/' || i)) FROM generate_series(1, 20) i))
 WHERE id = '22222222-0000-0000-0000-000000000002';
SELECT is(jsonb_array_length(pg_temp.member('22222222-0000-0000-0000-000000000002') -> 'display_name_emojis'), 16,
  'at most 16');

SELECT * FROM finish();
ROLLBACK;
