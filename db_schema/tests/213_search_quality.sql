-- Search quality (20261031800001, 20261031800002): prefix, accent folding, words the english
-- configuration drops, CJK substrings, typo fallback, ranking; visibility and history cutoffs
-- unchanged. Each matching case has a query that must not match beside it, and the cases the
-- english-only index missed assert that it missed them.
--
--   #sq213    open           Q01 alice  2026-01-01  "Harmony server notes"
--                            Q02 bob                "Café crème at the Straße"
--                            Q03 alice              "東京都庁へ行きます"
--                            Q04 bob                "会議の設定を変更しました"
--                            Q05 alice              "하모니는 좋아요"
--                            Q06 bob                "the who played live"
--                            Q07 alice              "who is the drummer"
--                            Q08 bob    yesterday   "Harmony server notes"
--                            Q09 alice              encrypted; ciphertext part reads "harmony"
--                            Q10 bob                "ｶﾞｲﾄﾞ ＡＢＣ" (half-width kana, full-width latin)
--                            Q11 alice              "Harmonica lessons"
--                            Q12 bob    2026-02-01  "running fast"
--                            Q13 alice  2026-02-01  "runs fast"
--                            Q14 bob                "party 🎉"
--                            Q15 bob                "this is the thing"
--                            Q16 alice              "service down"
--                            Q17 bob                "meet me"
--                            Q18 alice              "meeting at noon"
--                            Q19 bob    2026-01-15  "the deployment failed"
--                            Q20 alice  an hour ago "deploymant done"
--   #hid213   @everyone denied VIEW_CHANNEL
--                            H1  alice              "harmony secret 東京"
--   #hist213  @everyone denied READ_MESSAGE_HISTORY; mallory joined an hour ago
--                            R1  alice  yesterday   "harmony archive 東京"
--                            R2  mallory 3 days ago "harmonic mallory"

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(65);

UPDATE public.server_automod_settings SET enabled = false WHERE server_id = '55555555-0000-0000-0000-000000000005';
INSERT INTO public.user_servers (user_id, server_id, status, created_at)
VALUES ('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'accepted', now() - interval '1 hour')
ON CONFLICT (user_id, server_id) DO UPDATE SET status = 'accepted', created_at = EXCLUDED.created_at;

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f2130000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'sq213', 0),
  ('f2130000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'hid213', 0),
  ('f2130000-0000-0000-0000-0000000000c3', '55555555-0000-0000-0000-000000000005', 'hist213', 0);
-- Bits: VIEW_CHANNEL 1 << 1 = 2, READ_MESSAGE_HISTORY 1 << 22 = 4194304.
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, allow_permissions, deny_permissions)
SELECT ch, 'role', (SELECT id FROM public.server_roles WHERE server_id = '55555555-0000-0000-0000-000000000005' AND is_default), 0, bit
  FROM (VALUES ('f2130000-0000-0000-0000-0000000000c2'::uuid, 2::bigint),
               ('f2130000-0000-0000-0000-0000000000c3'::uuid, 4194304::bigint)) v(ch, bit);

CREATE FUNCTION pg_temp.txt(p text) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(jsonb_build_object('type', 'text', 'text', p));
$fn$;

INSERT INTO public.messages (id, channel_id, user_id, content, created_at, encrypted) VALUES
  ('f2131000-0000-0000-0000-000000000001', 'f2130000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', pg_temp.txt('Harmony server notes'), '2026-01-01 12:00+00', false),
  ('f2131000-0000-0000-0000-000000000002', 'f2130000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', pg_temp.txt('Café crème at the Straße'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-000000000003', 'f2130000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', pg_temp.txt('東京都庁へ行きます'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-000000000004', 'f2130000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', pg_temp.txt('会議の設定を変更しました'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-000000000005', 'f2130000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', pg_temp.txt('하모니는 좋아요'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-000000000006', 'f2130000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', pg_temp.txt('the who played live'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-000000000007', 'f2130000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', pg_temp.txt('who is the drummer'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-000000000008', 'f2130000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', pg_temp.txt('Harmony server notes'), now() - interval '1 day', false),
  ('f2131000-0000-0000-0000-000000000009', 'f2130000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', pg_temp.txt('harmony'), now() - interval '2 days', true),
  ('f2131000-0000-0000-0000-000000000010', 'f2130000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', pg_temp.txt('ｶﾞｲﾄﾞ ＡＢＣ'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-000000000011', 'f2130000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', pg_temp.txt('Harmonica lessons'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-000000000012', 'f2130000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', pg_temp.txt('running fast'), '2026-02-01 12:00+00', false),
  ('f2131000-0000-0000-0000-000000000013', 'f2130000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', pg_temp.txt('runs fast'), '2026-02-01 12:00+00', false),
  ('f2131000-0000-0000-0000-000000000014', 'f2130000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', pg_temp.txt('party 🎉'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-000000000015', 'f2130000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', pg_temp.txt('this is the thing'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-000000000016', 'f2130000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', pg_temp.txt('service down'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-000000000017', 'f2130000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', pg_temp.txt('meet me'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-000000000018', 'f2130000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', pg_temp.txt('meeting at noon'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-000000000019', 'f2130000-0000-0000-0000-0000000000c1', '22222222-0000-0000-0000-000000000002', pg_temp.txt('the deployment failed'), '2026-01-15 12:00+00', false),
  ('f2131000-0000-0000-0000-000000000020', 'f2130000-0000-0000-0000-0000000000c1', '11111111-0000-0000-0000-000000000001', pg_temp.txt('deploymant done'), now() - interval '1 hour', false),
  ('f2131000-0000-0000-0000-0000000000a1', 'f2130000-0000-0000-0000-0000000000c2', '11111111-0000-0000-0000-000000000001', pg_temp.txt('harmony secret 東京'), now() - interval '2 days', false),
  ('f2131000-0000-0000-0000-0000000000b1', 'f2130000-0000-0000-0000-0000000000c3', '11111111-0000-0000-0000-000000000001', pg_temp.txt('harmony archive 東京'), now() - interval '1 day', false),
  ('f2131000-0000-0000-0000-0000000000b2', 'f2130000-0000-0000-0000-0000000000c3', '33333333-0000-0000-0000-000000000003', pg_temp.txt('harmonic mallory'), now() - interval '3 days', false);

-- Matches in #sq213 as two-character ids, sorted; fuzzy rows suffixed with ~.
CREATE FUNCTION pg_temp.hits(p_query text, p_channel uuid DEFAULT 'f2130000-0000-0000-0000-0000000000c1')
RETURNS text[] LANGUAGE sql AS $fn$
  SELECT coalesce(array_agg(right(message_id::text, 2) || CASE WHEN fuzzy THEN '~' ELSE '' END
                            ORDER BY right(message_id::text, 2)), '{}')
    FROM public.search_messages(p_query => p_query, p_channel_ids => ARRAY[p_channel]);
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.hits(text, uuid) TO authenticated;

-- INDEX ----------------------------------------------------------------------------------
SELECT ok((SELECT content_tsvector = public.search_document(content_text)
             FROM public.message_search_index WHERE message_id = 'f2131000-0000-0000-0000-000000000003'),
          'the indexer writes search_document()');
SELECT ok((SELECT x.indisvalid FROM pg_index x WHERE x.indexrelid = 'public.idx_message_search_fold_trgm'::regclass),
          'the trigram index exists and is valid');
SELECT ok(NOT has_function_privilege('authenticated', 'public.search_tsquery(text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.search_document(text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.search_typo_distance(text[], text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.search_cjk_grams(text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.search_fold(text)', 'EXECUTE'),
          'clients cannot call the search helpers');
SELECT ok(NOT has_function_privilege('anon',
    'public.search_messages(text, uuid, uuid[], uuid, uuid, uuid, boolean, boolean, timestamp with time zone, timestamp with time zone, integer, integer, uuid[], uuid[], boolean, boolean, boolean, boolean, boolean, text, boolean)',
    'EXECUTE')
    AND has_function_privilege('authenticated',
    'public.search_messages(text, uuid, uuid[], uuid, uuid, uuid, boolean, boolean, timestamp with time zone, timestamp with time zone, integer, integer, uuid[], uuid[], boolean, boolean, boolean, boolean, boolean, text, boolean)',
    'EXECUTE'), 'search_messages: authenticated yes, anon no');

-- TYPO DISTANCE --------------------------------------------------------------------------
-- Prefix-sharing words pg_trgm scores as typos; the distance refuses them.
SELECT ok(extensions.word_similarity('thw', 'this is the thing') >= 0.45
          AND extensions.word_similarity('meetnig', 'meet me') >= 0.45
          AND extensions.word_similarity('serer', 'service down') >= 0.45
          AND extensions.strict_word_similarity('meetnig', 'meet me') > extensions.strict_word_similarity('meetnig', 'meeting at noon'),
          'trigram similarity takes a shared prefix for a typo');
SELECT is(public.search_typo_distance(ARRAY['meetnig'], 'meet me'), NULL, 'a row word the query word begins with is not near');
SELECT is(public.search_typo_distance(ARRAY['serer'], 'service down'), NULL, 'nor a word sharing its first letters');
SELECT is(public.search_typo_distance(ARRAY['meetnig'], 'meeting at noon'), 1, 'a transposition is one edit');
SELECT is(public.search_typo_distance(ARRAY['deploymnet'], 'deploymant done'), 2, 'two edits in a long word');
SELECT is(public.search_typo_distance(ARRAY['serer'], 'seven'), NULL, 'two edits in a five-letter word are too many');
SELECT is(public.search_typo_distance(ARRAY['harmo'], 'harmony'), 1, 'a row word beginning with the query word is one away');
SELECT is(public.search_typo_distance(ARRAY['harmony', 'notse'], 'harmony server notes'), 1, 'distances add up over the words');
SELECT is(public.search_typo_distance(ARRAY['harmony'], repeat('x', 300) || ' harmony'), 0,
          'a row word over levenshtein''s 255 characters is passed over');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');

-- PREFIX ---------------------------------------------------------------------------------
SELECT is(pg_temp.hits('harmo'), ARRAY['01', '08', '11'], 'the last word matches as a prefix');
SELECT ok(NOT (to_tsvector('english', 'Harmony server notes') @@ websearch_to_tsquery('english', 'harmo')),
          'the english-only index missed it');
SELECT is(pg_temp.hits('notes harmo'), ARRAY['01', '08'], 'a prefix after another word');
SELECT is(pg_temp.hits('harmo notes'), ARRAY['01~', '08~'],
          'an earlier word is not a prefix: no exact match, the typo fallback answers');
SELECT is(pg_temp.hits('"harmo"'), '{}'::text[], 'a quoted word is neither a prefix nor fuzzy');

-- ACCENTS AND WIDTH -----------------------------------------------------------------------
SELECT is(pg_temp.hits('cafe'), ARRAY['02'], 'cafe finds Café');
SELECT is(pg_temp.hits('CAFÉ creme'), ARRAY['02'], 'case and accents fold on both sides');
SELECT is(pg_temp.hits('strasse'), ARRAY['02'], 'ß folds to ss');
SELECT ok(NOT (to_tsvector('english', 'Café crème at the Straße') @@ websearch_to_tsquery('english', 'cafe')),
          'the english-only index missed cafe');
SELECT is(pg_temp.hits('ガイド'), ARRAY['10'], 'half-width katakana folds to full width');
SELECT is(pg_temp.hits('abc'), ARRAY['10'], 'full-width latin folds to ASCII');

-- WORDS THE ENGLISH CONFIGURATION DROPS -----------------------------------------------------
SELECT is(pg_temp.hits('"the who"'), ARRAY['06'], 'a phrase of english stop words matches in order');
SELECT is(numnode(websearch_to_tsquery('english', '"the who"')), 0,
          'the english-only query had no lexeme for it');
SELECT is(pg_temp.hits('"who the"'), '{}'::text[], 'the reversed phrase does not match');

-- CJK SUBSTRINGS -------------------------------------------------------------------------
SELECT is(pg_temp.hits('都'), ARRAY['03'], 'one kanji');
SELECT is(pg_temp.hits('す'), ARRAY['03'], 'the last character of a run');
SELECT is(pg_temp.hits('東京'), ARRAY['03'], 'two characters');
SELECT is(pg_temp.hits('東京都庁'), ARRAY['03'], 'four characters in order');
SELECT is(pg_temp.hits('設定を'), ARRAY['04'], 'kanji then kana');
SELECT is(pg_temp.hits('京東'), '{}'::text[], 'two characters out of order do not match');
SELECT is(pg_temp.hits('都庁会議'), '{}'::text[], 'characters from two messages do not match');
SELECT is(pg_temp.hits('하모니'), ARRAY['05'], 'a hangul word inside a longer word');
SELECT is(pg_temp.hits('모하'), '{}'::text[], 'hangul out of order does not match');

-- TYPO FALLBACK --------------------------------------------------------------------------
SELECT is(pg_temp.hits('harmoyn'), ARRAY['01~', '08~'], 'a swapped letter falls back to similar words');
SELECT is(pg_temp.hits('hamony'), ARRAY['01~', '08~'], 'a dropped letter');
SELECT is(pg_temp.hits('meetnig'), ARRAY['18~'], 'meetnig finds meeting, not meet');
SELECT is(pg_temp.hits('serer'), ARRAY['01~', '08~'], 'serer finds server, not service');
SELECT is(pg_temp.hits('server notse'), ARRAY['01~', '08~'], 'a transposition in a five-letter word');
SELECT is(pg_temp.hits('thw'), '{}'::text[], 'a three-letter word has no fallback');
SELECT results_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_query => 'deploymnet',
          p_channel_ids => ARRAY['f2130000-0000-0000-0000-0000000000c1'::uuid], p_sort => 'newest')$q$,
    $q$VALUES ('19'), ('20')$q$, 'similar rows sort nearest first, whatever the sort');
SELECT is(pg_temp.hits('harmony'), ARRAY['01', '08'], 'an exact match is not fuzzy');
SELECT is(pg_temp.hits('harmoyn -lessons'), '{}'::text[], 'a query with an exclusion has no fallback');
SELECT is(pg_temp.hits('qzxv'), '{}'::text[], 'a word like nothing finds nothing');
SELECT is(pg_temp.hits('zq'), '{}'::text[], 'two letters are too short for the fallback');
SELECT is((SELECT max(total_count) FROM public.search_messages(p_query => 'harmoyn',
              p_channel_ids => ARRAY['f2130000-0000-0000-0000-0000000000c1'::uuid], p_with_total => true)),
          2::bigint, 'total_count counts the fallback rows');
SELECT is(current_setting('pg_trgm.word_similarity_threshold'), '0.6',
          'the similarity threshold is restored after the fallback');

-- QUERIES WITH NO LEXEME ------------------------------------------------------------------
SELECT is(pg_temp.hits('🎉'), ARRAY['14'], 'an emoji matches as a substring');
SELECT is(pg_temp.hits('🎈'), '{}'::text[], 'another emoji does not');

-- ENCRYPTED --------------------------------------------------------------------------------
SELECT ok(NOT ('09' = ANY (pg_temp.hits('harmony')) OR '09~' = ANY (pg_temp.hits('harmoyn'))),
          'an encrypted message matches neither exactly nor by similarity');

-- RANKING --------------------------------------------------------------------------------
SELECT results_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_query => 'harmony server notes',
          p_channel_ids => ARRAY['f2130000-0000-0000-0000-0000000000c1'::uuid], p_sort => 'relevance')$q$,
    $q$VALUES ('08'), ('01')$q$, 'equal text ranks the newer message first');
SELECT results_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_query => 'running',
          p_channel_ids => ARRAY['f2130000-0000-0000-0000-0000000000c1'::uuid], p_sort => 'relevance')$q$,
    $q$VALUES ('12'), ('13')$q$, 'the word as written ranks above another form of its stem');
SELECT results_eq(
    $q$SELECT right(message_id::text, 2) FROM public.search_messages(p_query => 'harmony server notes',
          p_channel_ids => ARRAY['f2130000-0000-0000-0000-0000000000c1'::uuid], p_sort => 'oldest')$q$,
    $q$VALUES ('01'), ('08')$q$, 'oldest keeps date order');

-- VISIBILITY -----------------------------------------------------------------------------
SELECT ok(NOT EXISTS (SELECT 1 FROM public.search_messages(p_query => 'harmo') WHERE channel_id = 'f2130000-0000-0000-0000-0000000000c2'),
          'a prefix search does not reach a channel VIEW_CHANNEL hides');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.search_messages(p_query => 'secrte') WHERE channel_id = 'f2130000-0000-0000-0000-0000000000c2'),
          'nor does the typo fallback');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.search_messages(p_query => '東京') WHERE channel_id = 'f2130000-0000-0000-0000-0000000000c2'),
          'nor a CJK search');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(pg_temp.hits('secrte', 'f2130000-0000-0000-0000-0000000000c2'), ARRAY['a1~'],
          'the owner reaches it by the typo fallback');

-- HISTORY CUTOFF -------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(pg_temp.hits('harmo', 'f2130000-0000-0000-0000-0000000000c3'), ARRAY['b2'],
          'a prefix search before the cutoff finds only the member''s own message');
SELECT is(pg_temp.hits('archvie', 'f2130000-0000-0000-0000-0000000000c3'), '{}'::text[],
          'the typo fallback stops at the cutoff');
SELECT is(pg_temp.hits('東京', 'f2130000-0000-0000-0000-0000000000c3'), '{}'::text[],
          'a CJK search stops at the cutoff');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(pg_temp.hits('archvie', 'f2130000-0000-0000-0000-0000000000c3'), ARRAY['b1~'],
          'the same fallback finds it for a member who reads history');

-- NO VALID TRIGRAM INDEX -----------------------------------------------------------------
-- 20261031800002 builds the index after 20261031800001; a failed concurrent build leaves it
-- invalid. Without it every candidate row would be read.
SELECT tests.clear_authentication();
DROP INDEX public.idx_message_search_fold_trgm;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(pg_temp.hits('hamony'), '{}'::text[], 'without the trigram index there is no typo fallback');
SELECT is(pg_temp.hits('harmony'), ARRAY['01', '08'], 'exact matches do not use it');

SELECT * FROM finish();
ROLLBACK;
