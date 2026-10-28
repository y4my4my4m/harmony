-- Message search matching: prefixes, accents, words in any language, CJK substrings, typos.
--
-- message_search_index.content_tsvector holds search_document(content_text), three parts over
-- search_fold(content_text) (NFKC, unaccent, lower):
--   english   to_tsvector('english') of the text outside CJK runs: stems, no stop words
--   simple    to_tsvector('simple') of the same text: each word as written
--   grams     each run of kana, kanji, hanzi or hangul as its overlapping character pairs and
--             its last character, at consecutive positions. Every character of a run starts
--             exactly one gram: 'X':* finds a character, 'XY' a pair, 'XY' <-> 'YZ' a longer
--             string.
-- search_tsquery(q) reads websearch syntax: words, "phrases", -exclusions, or. A term matches
-- its english form or its simple form, AND its CJK runs as gram chains. The last term, when
-- unquoted and not excluded, matches its simple form as a prefix (two characters or more).
-- Stop words match through the simple part; the ILIKE scan remains for queries with no
-- lexeme (emoji, symbols).
--
-- Typo fallback: when no row matches and the query is words only (no CJK, "phrase",
-- -exclusion or or), its words of 4 to 64 characters match by edit distance and fuzzy is
-- true. search_typo_distance(): each such word needs a word of the row within its bound, 1
-- for 4-5 characters and 2 for longer (Elasticsearch's AUTO fuzziness). Distance is 0 for
-- the same word, 1 for a row word that begins with it or one adjacent transposition away,
-- else Levenshtein (fuzzystrmatch). A row word that is a prefix of the query word or shares
-- only its first letters does not match. pg_trgm similarity, word or strict, scores those
-- above real typos:
--                       word_similarity   strict_word_similarity   distance
--   meetnig  meeting    0.50              0.33                     1
--   meetnig  meet me    0.50              0.44                     none
--   archvie  archive    0.50              0.33                     1
--   archvie  arch       0.50              0.44                     none
--   serer    service    0.50              0.27                     none
-- Candidates come through idx_message_search_fold_trgm: word_similarity of the fallback's
-- words above 0.45 (pg_trgm.word_similarity_threshold, set for the fallback's queries and
-- restored; a function-level SET of it fails CREATE FUNCTION for a non-superuser while pg_trgm
-- is not loaded). A swap in a 4-5 letter word keeps few trigrams (wierd/weird 0.20) and is
-- not found. The fallback runs only while that index exists and is valid; 20261031800002
-- builds it. Similar rows sort by total distance, then word similarity, then newest,
-- whatever the sort asked for, over the newest 1,000; total_count counts to 1,000.
-- 300,000 rows of src/locales strings (en, de, es, fr; 35 characters average), postgres 16:
-- the distance check adds 10-18 us per in-scope candidate to the trigram recheck's 7-17 us.
--
-- Relevance: ts_rank_cd(v, q, 1|32) * (0.7 + 0.3 / (1 + age / 30 days)) over the newest
-- 10,000 matches; total_count counts to 10,001.
--
-- search_messages gains the result column fuzzy and is recreated.
--
-- Measured on a 1M-message corpus (src/locales strings: en 55%, ja 25%, de/es/fr/ko/zh 4%
-- each, 42 characters average), supabase/postgres:15.8.1.060, en_US.UTF-8, default config:
--   content_tsvector GIN 22 -> 54 MB; trigram GIN 109 MB
--   index write per message 14 -> 56 us
--   count / newest 25, ms     音 (1 char)   設定 (2)    チャンネル (5)   server   harmo*
--     grams                   19 / 14       21 / 31     22 / 61          51/208   20/106
--     pg_trgm LIKE            6027 / 4158   2614 / 5080 71 / 196
--     PGroonga 3.2.5          24 / 31       20 / 22     39 / 87          40/244   19/74
-- pg_trgm extracts no trigram from a pattern under three characters and scans its whole
-- index. PGroonga is not installed on the live hosts, keeps 157 MB outside pg_relation_size,
-- and its index answers LIKE and ILIKE on its column: ILIKE '%mony%' returned 19 of 25,261
-- rows.
--
-- Rows indexed before this migration keep the english-only vector until
-- 20261031800002 rewrites them; the english arm of every term still matches them.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA extensions;

-- unaccent() is STABLE because its rules file can change, and normalize() follows the
-- server's Unicode tables; the index on search_fold() assumes neither changes. A changed rules
-- file or Unicode version needs REINDEX of idx_message_search_fold_trgm and a rerun of
-- 20261031800002.
CREATE OR REPLACE FUNCTION public.search_fold(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT lower(extensions.unaccent('extensions.unaccent'::regdictionary, normalize(p_text, NFKC)))
$$;

-- Runs: 々 〆, hiragana and katakana (U+3041-30FF), CJK extension A and unified ideographs,
-- compatibility ideographs, hangul syllables. Positions cap at 16383 (tsvector limit).
CREATE OR REPLACE FUNCTION public.search_cjk_grams(p_text text)
RETURNS tsvector
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_run text;
    v_base int := 0;
    v_len int;
    v_parts text[] := '{}';
BEGIN
    FOR v_run IN SELECT r[1] FROM regexp_matches(p_text, '[々〆ぁ-ヿ㐀-䶿一-鿿豈-﫿가-힯]+', 'g') r LOOP
        v_len := length(v_run);
        v_parts := v_parts || (
            SELECT string_agg('''' || substr(v_run, i, CASE WHEN i < v_len THEN 2 ELSE 1 END)
                              || ''':' || least(v_base + i, 16383), ' ' ORDER BY i)
              FROM generate_series(1, v_len) i);
        v_base := v_base + v_len;
    END LOOP;
    RETURN array_to_string(v_parts, ' ')::tsvector;
END;
$$;

CREATE OR REPLACE FUNCTION public.search_document(p_text text)
RETURNS tsvector
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_fold text := public.search_fold(p_text);
    v_words text := v_fold;
    v_grams tsvector := ''::tsvector;
BEGIN
    IF v_fold ~ '[々〆ぁ-ヿ㐀-䶿一-鿿豈-﫿가-힯]' THEN
        v_words := regexp_replace(v_fold, '[々〆ぁ-ヿ㐀-䶿一-鿿豈-﫿가-힯]+', ' ', 'g');
        v_grams := public.search_cjk_grams(v_fold);
    END IF;
    RETURN to_tsvector('english'::regconfig, v_words) || to_tsvector('simple'::regconfig, v_words) || v_grams;
END;
$$;

-- NULL when the query yields no lexeme. OR binds tighter than AND, as websearch_to_tsquery.
-- client_min_messages: phraseto_tsquery raises a NOTICE for each term without a lexeme in
-- its configuration (a CJK run, an english stop word).
CREATE OR REPLACE FUNCTION public.search_tsquery(p_query text)
RETURNS tsquery
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
SET client_min_messages = warning
AS $$
DECLARE
    v_count int;
    v_m text[];
    v_i bigint;
    v_quoted boolean;
    v_neg boolean;
    v_text text;
    v_fold text;
    v_words text;
    v_si tsquery;
    v_en tsquery;
    v_run text;
    v_gram tsquery;
    v_term tsquery;
    v_or boolean := false;
    v_group tsquery;
    v_result tsquery;
BEGIN
    IF p_query IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT count(*) INTO v_count FROM regexp_matches(p_query, '(-?)"([^"]*)"?|(\S+)', 'g');

    FOR v_m, v_i IN
        SELECT r.m, r.o FROM regexp_matches(p_query, '(-?)"([^"]*)"?|(\S+)', 'g') WITH ORDINALITY AS r(m, o)
    LOOP
        v_quoted := v_m[2] IS NOT NULL;
        IF v_quoted THEN
            v_neg := v_m[1] = '-';
            v_text := v_m[2];
        ELSE
            v_text := v_m[3];
            v_neg := v_text ~ '^-.';
            IF v_neg THEN
                v_text := substr(v_text, 2);
            ELSIF lower(v_text) = 'or' THEN
                v_or := v_group IS NOT NULL;
                CONTINUE;
            END IF;
        END IF;

        v_fold := public.search_fold(v_text);
        v_words := regexp_replace(v_fold, '[々〆ぁ-ヿ㐀-䶿一-鿿豈-﫿가-힯]+', ' ', 'g');
        v_term := NULL;

        v_si := phraseto_tsquery('simple'::regconfig, v_words);
        IF numnode(v_si) > 0 THEN
            v_en := phraseto_tsquery('english'::regconfig, v_words);
            IF v_en::text = v_si::text THEN
                v_en := NULL;
            END IF;
            IF v_i = v_count AND NOT v_quoted AND NOT v_neg AND v_si::text ~ '[^'']{2}''$' THEN
                v_si := (v_si::text || ':*')::tsquery;
            END IF;
            v_term := CASE WHEN numnode(v_en) > 0 THEN v_si || v_en ELSE v_si END;
        END IF;

        FOR v_run IN SELECT r[1] FROM regexp_matches(v_fold, '[々〆ぁ-ヿ㐀-䶿一-鿿豈-﫿가-힯]+', 'g') r LOOP
            IF length(v_run) = 1 THEN
                v_gram := ('''' || v_run || ''':*')::tsquery;
            ELSE
                SELECT string_agg('''' || substr(v_run, i, 2) || '''', ' <-> ' ORDER BY i)::tsquery
                  INTO v_gram
                  FROM generate_series(1, length(v_run) - 1) i;
            END IF;
            v_term := CASE WHEN v_term IS NULL THEN v_gram ELSE v_term && v_gram END;
        END LOOP;

        IF v_term IS NULL THEN
            CONTINUE;
        END IF;
        IF v_neg THEN
            v_term := !! v_term;
        END IF;

        IF v_or THEN
            v_group := v_group || v_term;
        ELSE
            IF v_group IS NOT NULL THEN
                v_result := CASE WHEN v_result IS NULL THEN v_group ELSE v_result && v_group END;
            END IF;
            v_group := v_term;
        END IF;
        v_or := false;
    END LOOP;

    IF v_group IS NOT NULL THEN
        v_result := CASE WHEN v_result IS NULL THEN v_group ELSE v_result && v_group END;
    END IF;
    RETURN v_result;
END;
$$;

-- Sum over p_words of the distance to the nearest word of p_fold; NULL when a word has none
-- within its bound. p_words: distinct, folded, 4-64 characters. A row word whose length
-- differs by more than the bound gets no levenshtein() call, which refuses strings over 255
-- characters.
CREATE OR REPLACE FUNCTION public.search_typo_distance(p_words text[], p_fold text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
COST 200
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_row text[] := regexp_split_to_array(p_fold, '\W+');
    v_q text;
    v_w text;
    v_len int;
    v_k int;
    v_best int;
    v_d int;
    v_total int := 0;
BEGIN
    FOREACH v_q IN ARRAY p_words LOOP
        v_len := length(v_q);
        v_k := CASE WHEN v_len <= 5 THEN 1 ELSE 2 END;
        v_best := v_k + 1;
        FOREACH v_w IN ARRAY v_row LOOP
            IF v_w = v_q THEN
                v_best := 0;
                EXIT;
            END IF;
            CONTINUE WHEN v_best = 1;
            IF starts_with(v_w, v_q) THEN
                v_best := 1;
                CONTINUE;
            END IF;
            CONTINUE WHEN abs(length(v_w) - v_len) > v_k;
            v_d := extensions.levenshtein_less_equal(v_q, v_w, 2);
            IF v_d = 2 AND length(v_w) = v_len THEN
                FOR i IN 1 .. v_len - 1 LOOP
                    IF v_w = overlay(v_q PLACING substr(v_q, i + 1, 1) || substr(v_q, i, 1) FROM i FOR 2) THEN
                        v_d := 1;
                        EXIT;
                    END IF;
                END LOOP;
            END IF;
            IF v_d < v_best THEN
                v_best := v_d;
            END IF;
        END LOOP;
        IF v_best > v_k THEN
            RETURN NULL;
        END IF;
        v_total := v_total + v_best;
    END LOOP;
    RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.search_fold(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_fold(text) TO service_role;
REVOKE ALL ON FUNCTION public.search_cjk_grams(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_cjk_grams(text) TO service_role;
REVOKE ALL ON FUNCTION public.search_document(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_document(text) TO service_role;
REVOKE ALL ON FUNCTION public.search_tsquery(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_tsquery(text) TO service_role;
REVOKE ALL ON FUNCTION public.search_typo_distance(text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_typo_distance(text[], text) TO service_role;

-- As 20261026100001 (index_message_row); the vector is search_document().
CREATE OR REPLACE FUNCTION public.index_message_row(p_message public.messages)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
    v_text text;
BEGIN
    -- A system notice is not searchable.
    IF p_message.is_deleted = true OR p_message.is_system IS TRUE THEN
        DELETE FROM message_search_index WHERE message_id = p_message.id;
        RETURN;
    END IF;

    IF p_message.encrypted = true THEN
        v_text := '';
    ELSE
        v_text := btrim(coalesce(extract_message_text(p_message.content), '') || ' '
                        || message_file_names(p_message.content));
    END IF;

    INSERT INTO message_search_index (
        message_id, content_text, content_tsvector, channel_id, conversation_id, user_id,
        server_id, has_media, has_url, has_image, has_video, has_audio, has_embed, is_pinned,
        mentioned_user_ids, created_at
    )
    SELECT p_message.id, v_text, public.search_document(v_text), p_message.channel_id,
           p_message.conversation_id, p_message.user_id,
           CASE WHEN p_message.channel_id IS NOT NULL
                THEN get_channel_server_id(p_message.channel_id) END,
           f.has_media, f.has_url, f.has_image, f.has_video, f.has_audio, f.has_embed,
           f.is_pinned, f.mentioned_user_ids, p_message.created_at
      FROM message_search_flags(p_message) f
    ON CONFLICT (message_id) DO UPDATE SET
        content_text = EXCLUDED.content_text,
        content_tsvector = EXCLUDED.content_tsvector,
        channel_id = EXCLUDED.channel_id,
        conversation_id = EXCLUDED.conversation_id,
        user_id = EXCLUDED.user_id,
        server_id = EXCLUDED.server_id,
        has_media = EXCLUDED.has_media,
        has_url = EXCLUDED.has_url,
        has_image = EXCLUDED.has_image,
        has_video = EXCLUDED.has_video,
        has_audio = EXCLUDED.has_audio,
        has_embed = EXCLUDED.has_embed,
        is_pinned = EXCLUDED.is_pinned,
        mentioned_user_ids = EXCLUDED.mentioned_user_ids,
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.index_message_row(public.messages) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.index_message_row(public.messages) TO postgres, service_role;

DROP FUNCTION IF EXISTS public.search_messages(text, uuid, uuid[], uuid, uuid, uuid, boolean, boolean,
    timestamp with time zone, timestamp with time zone, integer, integer, uuid[], uuid[], boolean,
    boolean, boolean, boolean, boolean, text, boolean);

-- As 20261017100001 (search_messages). Text goes through search_tsquery() with the typo
-- fallback; relevance ranks the newest 10,000 matches with ts_rank_cd and an age factor.
-- Parameters $16 (the fallback's words, joined), $17 (fuzzy) and $18 (the fallback's words)
-- are new.
CREATE FUNCTION public.search_messages(
    p_query text DEFAULT NULL::text,
    p_channel_id uuid DEFAULT NULL::uuid,
    p_channel_ids uuid[] DEFAULT NULL::uuid[],
    p_user_id uuid DEFAULT NULL::uuid,
    p_conversation_id uuid DEFAULT NULL::uuid,
    p_server_id uuid DEFAULT NULL::uuid,
    p_has_media boolean DEFAULT NULL::boolean,
    p_has_url boolean DEFAULT NULL::boolean,
    p_from_date timestamp with time zone DEFAULT NULL::timestamp with time zone,
    p_to_date timestamp with time zone DEFAULT NULL::timestamp with time zone,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0,
    p_user_ids uuid[] DEFAULT NULL::uuid[],
    p_mentioned_user_ids uuid[] DEFAULT NULL::uuid[],
    p_has_image boolean DEFAULT NULL::boolean,
    p_has_video boolean DEFAULT NULL::boolean,
    p_has_audio boolean DEFAULT NULL::boolean,
    p_has_embed boolean DEFAULT NULL::boolean,
    p_pinned boolean DEFAULT NULL::boolean,
    p_sort text DEFAULT NULL::text,
    p_with_total boolean DEFAULT false)
RETURNS TABLE(message_id uuid, relevance real, content_text text, channel_id uuid, conversation_id uuid,
              user_id uuid, created_at timestamp with time zone, server_id uuid, total_count bigint,
              fuzzy boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := get_current_user_profile_id();
    v_query text := left(nullif(btrim(p_query), ''), 512);
    v_tsq tsquery;
    v_pattern text;
    v_fuzzy_words text[];
    v_fuzzy_text text;
    v_fuzzy boolean := false;
    v_channels uuid[] := '{}';
    v_conversations uuid[] := '{}';
    v_cutoffs jsonb;
    v_users uuid[];
    v_sort text;
    v_where text;
    v_match text := '';
    v_rank text;
    v_total bigint;
    v_threshold text;
    -- 2592000 s = 30 days.
    v_age constant text := '(0.7 + 0.3 / (1 + extract(epoch FROM now() - COALESCE(i.created_at, now())) / 2592000))';
BEGIN
    IF v_me IS NULL THEN
        RETURN;
    END IF;

    -- Visible rows: the RLS rule of message_search_index, narrowed by the scope parameters.
    IF p_conversation_id IS NULL THEN
        v_channels := ARRAY(
            SELECT v.id
              FROM current_user_viewable_channel_ids() v(id)
             WHERE (p_channel_id IS NULL OR v.id = p_channel_id)
               AND (p_channel_ids IS NULL OR v.id = ANY (p_channel_ids))
               AND (p_server_id IS NULL
                    OR EXISTS (SELECT 1 FROM channels c WHERE c.id = v.id AND c.server_id = p_server_id)));
    END IF;
    IF p_server_id IS NULL AND p_channel_id IS NULL AND p_channel_ids IS NULL THEN
        v_conversations := ARRAY(
            SELECT cp.conversation_id
              FROM conversation_participants cp
             WHERE cp.user_id = v_me
               AND cp.left_at IS NULL
               AND (p_conversation_id IS NULL OR cp.conversation_id = p_conversation_id));
    END IF;

    IF cardinality(v_channels) = 0 AND cardinality(v_conversations) = 0 THEN
        RETURN;
    END IF;

    -- A single channel, server or conversation leads with its (…, created_at) index.
    IF cardinality(v_conversations) = 0 AND cardinality(v_channels) = 1
       AND (p_channel_id IS NOT NULL OR p_channel_ids IS NOT NULL) THEN
        v_where := 'i.channel_id = ($1)[1]';
    ELSIF cardinality(v_conversations) = 0 AND p_server_id IS NOT NULL THEN
        v_where := 'i.server_id = $3 AND i.channel_id = ANY ($1)';
    ELSIF cardinality(v_conversations) = 0 THEN
        v_where := 'i.channel_id = ANY ($1)';
    ELSIF cardinality(v_channels) = 0 AND p_conversation_id IS NOT NULL THEN
        v_where := 'i.conversation_id = $4';
    ELSIF cardinality(v_channels) = 0 THEN
        v_where := 'i.conversation_id = ANY ($2)';
    ELSE
        v_where := '(i.channel_id = ANY ($1) OR i.conversation_id = ANY ($2))';
    END IF;

    IF cardinality(v_channels) > 0 THEN
        v_cutoffs := public.current_user_history_cutoffs();
    END IF;
    IF v_cutoffs IS NOT NULL THEN
        v_where := v_where || ' AND (i.channel_id IS NULL OR i.user_id = $14'
                           || ' OR COALESCE(i.created_at, ''infinity'')'
                           || ' >= COALESCE(($15 ->> i.channel_id::text)::timestamptz, ''-infinity''))';
    END IF;

    v_users := CASE
        WHEN p_user_id IS NULL THEN p_user_ids
        ELSE array_append(coalesce(p_user_ids, '{}'), p_user_id)
    END;
    IF v_users IS NOT NULL THEN
        v_where := v_where || CASE WHEN cardinality(v_users) = 1
                                   THEN ' AND i.user_id = ($7)[1]'
                                   ELSE ' AND i.user_id = ANY ($7)' END;
    END IF;
    -- The second clause matches the partial GIN index's predicate.
    IF p_mentioned_user_ids IS NOT NULL THEN
        v_where := v_where || ' AND i.mentioned_user_ids && $8 AND i.mentioned_user_ids <> ''{}''';
    END IF;
    IF p_from_date IS NOT NULL THEN
        v_where := v_where || ' AND i.created_at >= $9';
    END IF;
    IF p_to_date IS NOT NULL THEN
        v_where := v_where || ' AND i.created_at <= $10';
    END IF;

    -- Flags are spelled as bare columns so the planner can match a partial index.
    v_where := v_where
        || CASE p_has_media WHEN true THEN ' AND i.has_media' WHEN false THEN ' AND NOT i.has_media' ELSE '' END
        || CASE p_has_url   WHEN true THEN ' AND i.has_url'   WHEN false THEN ' AND NOT i.has_url'   ELSE '' END
        || CASE p_has_image WHEN true THEN ' AND i.has_image' WHEN false THEN ' AND NOT i.has_image' ELSE '' END
        || CASE p_has_video WHEN true THEN ' AND i.has_video' WHEN false THEN ' AND NOT i.has_video' ELSE '' END
        || CASE p_has_audio WHEN true THEN ' AND i.has_audio' WHEN false THEN ' AND NOT i.has_audio' ELSE '' END
        || CASE p_has_embed WHEN true THEN ' AND i.has_embed' WHEN false THEN ' AND NOT i.has_embed' ELSE '' END
        || CASE p_pinned    WHEN true THEN ' AND i.is_pinned' WHEN false THEN ' AND NOT i.is_pinned' ELSE '' END;

    IF v_query IS NOT NULL THEN
        v_tsq := public.search_tsquery(v_query);
        IF v_tsq IS NOT NULL THEN
            v_match := ' AND i.content_tsvector @@ $5';
            v_rank := 'ts_rank_cd(i.content_tsvector, $5, 33)';
            IF v_query !~* '(^|\s)(-|or(\s|$))|"' AND v_query !~ '[々〆ぁ-ヿ㐀-䶿一-鿿豈-﫿가-힯]'
               AND EXISTS (SELECT 1 FROM pg_index x
                            WHERE x.indexrelid = to_regclass('public.idx_message_search_fold_trgm')
                              AND x.indisvalid) THEN
                v_fuzzy_words := ARRAY(
                    SELECT DISTINCT w
                      FROM regexp_split_to_table(public.search_fold(v_query), '\W+') w
                     WHERE length(w) BETWEEN 4 AND 64);
                IF cardinality(v_fuzzy_words) > 0 THEN
                    v_fuzzy_text := array_to_string(v_fuzzy_words, ' ');
                END IF;
            END IF;
        ELSE
            v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
            v_match := ' AND i.content_text ILIKE $6';
        END IF;
    END IF;

    IF p_with_total THEN
        EXECUTE 'SELECT count(*) FROM (SELECT 1 FROM message_search_index i WHERE ' || v_where || v_match
                || ' LIMIT 10001) s'
           INTO v_total
          USING v_channels, v_conversations, p_server_id, p_conversation_id, v_tsq, v_pattern,
                v_users, p_mentioned_user_ids, p_from_date, p_to_date, NULL::bigint, NULL::integer,
                NULL::integer, v_me, v_cutoffs;
    END IF;

    -- The count, when asked for, decides the fallback; otherwise one probe does.
    IF v_fuzzy_text IS NOT NULL THEN
        IF p_with_total THEN
            v_fuzzy := v_total = 0;
        ELSE
            EXECUTE 'SELECT NOT EXISTS (SELECT 1 FROM message_search_index i WHERE ' || v_where || v_match || ')'
               INTO v_fuzzy
              USING v_channels, v_conversations, p_server_id, p_conversation_id, v_tsq, NULL::text,
                    v_users, p_mentioned_user_ids, p_from_date, p_to_date, NULL::bigint, NULL::integer,
                    NULL::integer, v_me, v_cutoffs;
        END IF;
    END IF;

    IF v_fuzzy THEN
        -- Loads pg_trgm first: set before the load, the setting is a placeholder.
        PERFORM extensions.word_similarity('', '');
        v_threshold := current_setting('pg_trgm.word_similarity_threshold');
        PERFORM set_config('pg_trgm.word_similarity_threshold', '0.45', true);
        -- The %> recheck runs before the costlier distance; IS NOT NULL keeps the planner's
        -- row estimate of %> alone.
        v_match := ' AND public.search_fold(i.content_text) OPERATOR(extensions.%>) $16'
                || ' AND public.search_typo_distance($18, public.search_fold(i.content_text)) IS NOT NULL';
        IF p_with_total THEN
            EXECUTE 'SELECT count(*) FROM (SELECT 1 FROM message_search_index i WHERE ' || v_where || v_match
                    || ' LIMIT 1000) s'
               INTO v_total
              USING v_channels, v_conversations, p_server_id, p_conversation_id, v_tsq, v_pattern,
                    v_users, p_mentioned_user_ids, p_from_date, p_to_date, NULL::bigint, NULL::integer,
                    NULL::integer, v_me, v_cutoffs, v_fuzzy_text, NULL::boolean, v_fuzzy_words;
        END IF;
    END IF;

    v_where := v_where || v_match;
    v_sort := coalesce(p_sort, CASE WHEN v_rank IS NOT NULL THEN 'relevance' ELSE 'newest' END);

    IF v_fuzzy THEN
        RETURN QUERY EXECUTE
            'SELECT i.message_id, (1.0 / (1 + i.d))::real, i.content_text, i.channel_id,'
            || ' i.conversation_id, i.user_id, i.created_at, i.server_id, $11, $17'
            || ' FROM (SELECT i.*, public.search_typo_distance($18, public.search_fold(i.content_text)) AS d,'
            || ' extensions.word_similarity($16, public.search_fold(i.content_text)) AS s'
            || ' FROM (SELECT i.* FROM message_search_index i WHERE ' || v_where
            || ' ORDER BY i.created_at DESC LIMIT 1000) i) i'
            || ' ORDER BY i.d, i.s DESC, i.created_at DESC, i.message_id DESC'
            || ' LIMIT $12 OFFSET $13'
          USING v_channels, v_conversations, p_server_id, p_conversation_id, v_tsq, v_pattern,
                v_users, p_mentioned_user_ids, p_from_date, p_to_date, v_total,
                least(greatest(coalesce(p_limit, 50), 1), 201), greatest(coalesce(p_offset, 0), 0),
                v_me, v_cutoffs, v_fuzzy_text, v_fuzzy, v_fuzzy_words;
    ELSIF v_sort = 'relevance' AND v_rank IS NOT NULL THEN
        RETURN QUERY EXECUTE
            'SELECT i.message_id, (' || v_rank || ' * ' || v_age || ')::real, i.content_text, i.channel_id,'
            || ' i.conversation_id, i.user_id, i.created_at, i.server_id, $11, $17'
            || ' FROM (SELECT i.* FROM message_search_index i WHERE ' || v_where
            || ' ORDER BY i.created_at DESC LIMIT 10000) i'
            || ' ORDER BY 2 DESC, i.created_at DESC, i.message_id DESC'
            || ' LIMIT $12 OFFSET $13'
          USING v_channels, v_conversations, p_server_id, p_conversation_id, v_tsq, v_pattern,
                v_users, p_mentioned_user_ids, p_from_date, p_to_date, v_total,
                least(greatest(coalesce(p_limit, 50), 1), 201), greatest(coalesce(p_offset, 0), 0),
                v_me, v_cutoffs, v_fuzzy_text, v_fuzzy;
    ELSE
        -- Relevance of the page rows only.
        RETURN QUERY EXECUTE
            'SELECT i.message_id, (' || coalesce(v_rank, '1') || ')::real, i.content_text, i.channel_id,'
            || ' i.conversation_id, i.user_id, i.created_at, i.server_id, $11, $17'
            || ' FROM (SELECT i.* FROM message_search_index i WHERE ' || v_where
            || ' ORDER BY ' || CASE WHEN v_sort = 'oldest' THEN 'i.created_at, i.message_id'
                                    ELSE 'i.created_at DESC, i.message_id DESC' END
            || ' LIMIT $12 OFFSET $13) i'
            || ' ORDER BY ' || CASE WHEN v_sort = 'oldest' THEN 'i.created_at, i.message_id'
                                    ELSE 'i.created_at DESC, i.message_id DESC' END
          USING v_channels, v_conversations, p_server_id, p_conversation_id, v_tsq, v_pattern,
                v_users, p_mentioned_user_ids, p_from_date, p_to_date, v_total,
                least(greatest(coalesce(p_limit, 50), 1), 201), greatest(coalesce(p_offset, 0), 0),
                v_me, v_cutoffs, v_fuzzy_text, v_fuzzy;
    END IF;

    IF v_threshold IS NOT NULL THEN
        PERFORM set_config('pg_trgm.word_similarity_threshold', v_threshold, true);
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.search_messages(text, uuid, uuid[], uuid, uuid, uuid, boolean, boolean,
    timestamp with time zone, timestamp with time zone, integer, integer, uuid[], uuid[], boolean,
    boolean, boolean, boolean, boolean, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_messages(text, uuid, uuid[], uuid, uuid, uuid, boolean, boolean,
    timestamp with time zone, timestamp with time zone, integer, integer, uuid[], uuid[], boolean,
    boolean, boolean, boolean, boolean, text, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
