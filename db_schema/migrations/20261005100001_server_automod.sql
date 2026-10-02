-- Server AutoMod, member timeouts and instance anti-spam.
--
-- Enforcement point. BEFORE INSERT OR UPDATE OF content ON messages runs
-- automod_message_guard() (SECURITY INVOKER), which hands the row, the operation and
-- current_user to automod_check_message() (SECURITY DEFINER). current_user is the role
-- that executed the statement: 'authenticated' for a PostgREST or GraphQL client,
-- 'service_role' for bot-gateway and federation-backend, 'postgres'/'supabase_admin'
-- for rows written by definer functions (join/leave/kick/ban/encryption notices). A
-- definer trigger cannot see it; current_user there is the function owner.
-- automod_check_message refuses to run at pg_trigger_depth() = 0, so the EXECUTE grant
-- it needs for invoker callers does not make it an endpoint.
--
-- Verdicts.
--   allow     the row is written unchanged.
--   alert     the row is written; an automod_events row records the match and, when the
--             server has an alert channel, a system message is posted there.
--   block     the row is dropped: the trigger returns NULL, no later BEFORE or AFTER
--             trigger runs (no broadcast, federation, notification, unread count), the
--             statement succeeds with zero rows, and the event, alert and timeout commit.
--             A PostgREST request with Accept: application/vnd.pgrst.object+json
--             (supabase-js .single()/.maybeSingle()) is rolled back by PostgREST when it
--             returns zero rows (measured against postgrest v13.0.7: 406 PGRST116 and the
--             trigger's writes are gone), so such a request is answered with
--             AUTOMOD_BLOCKED raised instead; nothing persists for it.
--   timeout   server_member_timeouts row; while active, the member's channel messages
--             and content edits in that server raise MEMBER_TIMED_OUT:<epoch seconds>,
--             whether or not AutoMod is enabled.
--
-- A client row is checked against the messages_insert_member predicate (author is the
-- caller, channel viewable, SEND_MESSAGES / SEND_MESSAGES_IN_THREADS) before a block
-- persists anything. BEFORE triggers run ahead of RLS WITH CHECK, and a dropped row is
-- never checked, so without this an insert naming another user_id would record events
-- and timeouts against that user.
--
-- Scope. Local servers only. Encrypted rows skip text rules (keywords, presets, links,
-- invites, duplicates); mention, flood and new-member rules still apply. is_system rows
-- written by postgres/supabase_admin are not evaluated; is_system rows from clients are,
-- since messages_insert_member does not restrict is_system. Bots are exempt unless the
-- server clears exempt_bots; flood, duplicate and new-member rules never apply to bots.
-- Server owner, ADMINISTRATOR and MANAGE_SERVER holders are exempt from every rule, as
-- in Discord. Rate rules (flood, duplicates, mention window, new-account limits) count
-- automod_recent_activity rows, stamped at insert time and written for API writes only
-- (authenticated, service_role); messages.created_at is set by clients and peers and is
-- not used for counting.
--
-- Text matching. automod_normalize() folds NFKD compatibility forms (fullwidth,
-- mathematical, circled letters), strips combining marks and invisible format characters
-- (zero-width, bidi, variation selectors), lowercases, maps Cyrillic/Greek/small-caps
-- homoglyphs and leetspeak digits to Latin, removes punctuation inside words (f.u.c.k,
-- fu-ck) and joins runs of single characters (s l u r). Keywords are normalized the same
-- way and compiled to one regular expression per rule: each character becomes c+ (so
-- repeats match), i and l share [il]+, spaces match any run of non-alphanumerics, and
-- Discord wildcards apply (word = whole word, word* = prefix, *word = suffix,
-- *word* = substring). Patterns are compiled when a rule is saved and stored in
-- server_automod_settings.compiled; nothing is compiled per message.
--
-- Defaults. New local servers get AutoMod enabled with the recommended preset:
-- mention spam (more than 20 unique mentions in a message, or more than 50 in a minute),
-- message flood (more than 10 messages in 10 s), cross-channel duplicates (the same text of 10+
-- characters in more than 2 channels within 5 minutes), each block + alert. Server
-- invites, the word presets and new-member restrictions are present but off. Raid
-- detection (10 joins in 60 s) alerts only. Existing servers are left unconfigured;
-- enable_server_automod_preset() is their opt-in.
--
-- Instance anti-spam. instance_config 'antispam' holds limits for local accounts younger
-- than new_account_hours (messages per minute, posts per hour, stranger mentions in posts,
-- links). Every limit is 0/false by default. federation_* keys are read by
-- federation-backend. suspicious_activity is the admin review queue it writes to.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.server_automod_settings (
    server_id uuid PRIMARY KEY REFERENCES public.servers(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    alert_channel_id uuid REFERENCES public.channels(id) ON DELETE SET NULL,
    exempt_bots boolean NOT NULL DEFAULT true,
    raid_settings jsonb NOT NULL
        DEFAULT '{"enabled": true, "join_threshold": 10, "window_seconds": 60, "action": "alert", "slowmode_seconds": 30}'::jsonb,
    raid_state jsonb NOT NULL DEFAULT '{"active": false}'::jsonb,
    last_raid_at timestamptz,
    compiled jsonb NOT NULL DEFAULT '{"rules": []}'::jsonb,
    prompt_dismissed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    CONSTRAINT server_automod_settings_raid_shape CHECK (jsonb_typeof(raid_settings) = 'object'),
    CONSTRAINT server_automod_settings_compiled_shape CHECK (jsonb_typeof(compiled -> 'rules') = 'array')
);

COMMENT ON TABLE public.server_automod_settings IS
    'Per-server AutoMod switch, alert channel, raid detection. compiled is derived from server_automod_rules by automod_recompile_server().';

CREATE TABLE IF NOT EXISTS public.server_automod_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    name text NOT NULL,
    rule_type text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    actions jsonb NOT NULL DEFAULT '{"block": true, "alert": true, "timeout_seconds": 0}'::jsonb,
    exempt_role_ids uuid[] NOT NULL DEFAULT '{}',
    exempt_channel_ids uuid[] NOT NULL DEFAULT '{}',
    position integer NOT NULL DEFAULT 0,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT server_automod_rules_type_check CHECK (rule_type IN (
        'keyword', 'keyword_preset', 'mention_spam', 'message_flood',
        'duplicate_spam', 'invites', 'links', 'new_member')),
    CONSTRAINT server_automod_rules_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
    CONSTRAINT server_automod_rules_exempt_size CHECK (
        cardinality(exempt_role_ids) <= 50 AND cardinality(exempt_channel_ids) <= 100)
);

CREATE INDEX IF NOT EXISTS idx_server_automod_rules_server
    ON public.server_automod_rules (server_id, position);

COMMENT ON TABLE public.server_automod_rules IS
    'AutoMod rules. Written through upsert_server_automod_rule(), which validates config and actions.';

CREATE TABLE IF NOT EXISTS public.server_member_timeouts (
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    until timestamptz NOT NULL,
    reason text,
    source text NOT NULL DEFAULT 'moderator',
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, user_id),
    CONSTRAINT server_member_timeouts_source_check CHECK (source IN ('moderator', 'automod')),
    CONSTRAINT server_member_timeouts_reason_length CHECK (reason IS NULL OR char_length(reason) <= 512)
);

COMMENT ON TABLE public.server_member_timeouts IS
    'Active and expired member timeouts. A row with until > now() blocks the member''s channel messages in the server.';

CREATE TABLE IF NOT EXISTS public.automod_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    channel_id uuid REFERENCES public.channels(id) ON DELETE SET NULL,
    user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    bot_id uuid,
    message_id uuid,
    rule_id uuid REFERENCES public.server_automod_rules(id) ON DELETE SET NULL,
    rule_name text,
    rule_type text,
    event_type text NOT NULL,
    actions text[] NOT NULL DEFAULT '{}',
    matched text,
    content_excerpt text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    hits integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_hit_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT automod_events_type_check CHECK (event_type IN ('message', 'edit', 'raid')),
    CONSTRAINT automod_events_matched_length CHECK (matched IS NULL OR char_length(matched) <= 200),
    CONSTRAINT automod_events_excerpt_length CHECK (content_excerpt IS NULL OR char_length(content_excerpt) <= 1000)
);

CREATE INDEX IF NOT EXISTS idx_automod_events_server_created
    ON public.automod_events (server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automod_events_user_hit
    ON public.automod_events (user_id, last_hit_at DESC);

COMMENT ON TABLE public.automod_events IS
    'AutoMod log. Repeats of one rule by one author within 30 s are folded into a single row (hits, last_hit_at).';

-- One row per accepted write that a rate rule counts: flood, mention window and duplicates
-- for servers with such a rule, and every message and post of a new account while an
-- instance limit is on. created_at is the insert time; messages.created_at and
-- posts.created_at are writable by clients and federation peers and are not used for
-- counting. fp is the hash of the normalized text (duplicate rule). A cache: unlogged, no
-- foreign keys, rows older than an hour are purged by automod_purge().
CREATE UNLOGGED TABLE IF NOT EXISTS public.automod_recent_activity (
    user_id uuid NOT NULL,
    kind text NOT NULL,
    server_id uuid,
    channel_id uuid,
    fp bigint,
    mentions integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT automod_recent_activity_kind_check CHECK (kind IN ('message', 'post'))
);

CREATE INDEX IF NOT EXISTS idx_automod_recent_activity_user
    ON public.automod_recent_activity (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automod_recent_activity_created
    ON public.automod_recent_activity (created_at);

CREATE TABLE IF NOT EXISTS public.suspicious_activity (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    kind text NOT NULL,
    status text NOT NULL DEFAULT 'open',
    action text NOT NULL,
    actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    actor_uri text,
    actor_domain text,
    target_ids uuid[] NOT NULL DEFAULT '{}',
    reasons text[] NOT NULL DEFAULT '{}',
    activity_id text,
    activity jsonb,
    summary text,
    reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    reviewed_at timestamptz,
    review_note text,
    CONSTRAINT suspicious_activity_kind_check CHECK (kind IN ('federation_mention', 'federation_dm')),
    CONSTRAINT suspicious_activity_status_check CHECK (status IN ('open', 'released', 'dismissed', 'confirmed')),
    CONSTRAINT suspicious_activity_action_check CHECK (action IN ('flagged', 'held', 'rejected')),
    CONSTRAINT suspicious_activity_summary_length CHECK (summary IS NULL OR char_length(summary) <= 500),
    CONSTRAINT suspicious_activity_note_length CHECK (review_note IS NULL OR char_length(review_note) <= 500),
    CONSTRAINT suspicious_activity_size CHECK (activity IS NULL OR pg_column_size(activity) <= 262144)
);

-- Full, not partial: federation-backend upserts ON CONFLICT (activity_id); NULLs stay distinct.
CREATE UNIQUE INDEX IF NOT EXISTS idx_suspicious_activity_activity_id
    ON public.suspicious_activity (activity_id);
CREATE INDEX IF NOT EXISTS idx_suspicious_activity_status_created
    ON public.suspicious_activity (status, created_at DESC);

COMMENT ON TABLE public.suspicious_activity IS
    'Instance review queue for inbound federation heuristics. Written by federation-backend (service role); reviewed through review_suspicious_activity().';

ALTER TABLE public.server_automod_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_automod_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_member_timeouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automod_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suspicious_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automod_recent_activity ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['server_automod_settings', 'server_automod_rules', 'server_member_timeouts',
                             'automod_events', 'suspicious_activity', 'automod_recent_activity'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role', t);
        EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role', t);
    END LOOP;
END;
$$;

-- Clients reach these tables only through the RPCs below. Default privileges grant
-- anon and authenticated ALL on new tables; that is revoked here.
REVOKE ALL ON public.server_automod_settings, public.server_automod_rules,
              public.server_member_timeouts, public.automod_events, public.suspicious_activity,
              public.automod_recent_activity
    FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.server_automod_settings, public.server_automod_rules,
             public.server_member_timeouts, public.automod_events, public.suspicious_activity,
             public.automod_recent_activity
    TO service_role;

-- Raid detection counts a server's joins in a window.
CREATE INDEX IF NOT EXISTS idx_user_servers_server_created
    ON public.user_servers (server_id, created_at DESC);

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('antispam',
        '{"new_account_hours": 24, "new_account_messages_per_minute": 0, "new_account_posts_per_hour": 0,
          "new_account_max_stranger_mentions": 0, "new_account_block_links": false,
          "federation_spam_mode": "flag", "federation_max_mentions": 15, "federation_new_actor_days": 7}'::jsonb,
        'Instance anti-spam limits. 0/false disables a limit.')
ON CONFLICT (config_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Text normalization and pattern compilation
-- ---------------------------------------------------------------------------

-- translate() pairs: Cyrillic, Greek, Latin lookalikes and small capitals, then leetspeak.
-- Applied after lower(), so only lowercase sources are listed.
CREATE OR REPLACE FUNCTION public.automod_normalize(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT btrim(regexp_replace(
        regexp_replace(
            regexp_replace(
                translate(
                    lower(regexp_replace(
                        normalize(p_text, NFKD),
                        '[\u0300-\u036f\u0483-\u0489\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]',
                        '', 'g')),
                    'авгеёзкмнопрстухшщъьіїјѕԁһӏԛԝүҫαβγδεζηθικμνοπρσςτυχωϲϳıłøđħŧƀɑɡɩʀɴʏᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍᴏᴘꜱᴛᴜᴠᴡᴢ0134578@$!|€',
                    'abreeekmhonpctyxwwbbiijsdhlqwycabydeznoikuvonpoctuxwcjilodhtbagirnyabcdefghijklmopstuvwzoieastbasile'),
                '(?<=[[:alnum:]])[._*''"`~^-]+(?=[[:alnum:]])', '', 'g'),
            '(?<![[:alnum:]])([[:alnum:]])[^[:alnum:]]+(?=[[:alnum:]](?![[:alnum:]]))', '\1', 'g'),
        '[[:space:]]+', ' ', 'g'))
$$;

COMMENT ON FUNCTION public.automod_normalize(text) IS
    'Skeleton used for keyword matching: NFKD, marks and invisibles stripped, lowercase, homoglyphs and leetspeak mapped to Latin, intra-word punctuation removed, single-character runs joined.';

-- Text parts joined by newlines; a part boundary never joins two words.
CREATE OR REPLACE FUNCTION public.automod_message_text(p_content jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT string_agg(e ->> 'text', E'\n')
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_content) = 'array' THEN p_content ELSE '[]'::jsonb END) e
     WHERE e ->> 'type' = 'text' AND e ->> 'text' IS NOT NULL
$$;

-- One alternation per term list. NULL when no term survives normalization.
CREATE OR REPLACE FUNCTION public.automod_keyword_regex(p_terms text[])
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_parts text[] := '{}'::text[];
    v_term text;
    v_core text;
    v_any_before boolean;
    v_any_after boolean;
    v_pat text;
    v_ch text;
BEGIN
    FOREACH v_term IN ARRAY COALESCE(p_terms, '{}') LOOP
        v_term := btrim(COALESCE(v_term, ''));
        CONTINUE WHEN v_term = '' OR btrim(v_term, '*') = '';
        v_any_before := left(v_term, 1) = '*';
        v_any_after := right(v_term, 1) = '*';
        v_core := public.automod_normalize(btrim(v_term, '*'));
        CONTINUE WHEN v_core IS NULL OR v_core = '';
        v_pat := '';
        FOR i IN 1 .. char_length(v_core) LOOP
            v_ch := substr(v_core, i, 1);
            IF v_ch = ' ' THEN
                v_pat := v_pat || '[^[:alnum:]]*';
            ELSIF v_ch IN ('i', 'l') THEN
                v_pat := v_pat || '[il]+';
            ELSIF v_ch ~ '^[[:alnum:]]$' THEN
                v_pat := v_pat || v_ch || '+';
            ELSE
                -- ARE: a backslash before a non-alphanumeric is that character literally.
                v_pat := v_pat || '\' || v_ch || '+';
            END IF;
        END LOOP;
        IF NOT v_any_before AND left(v_core, 1) ~ '^[[:alnum:]]$' THEN
            v_pat := '\m' || v_pat;
        END IF;
        IF NOT v_any_after AND right(v_core, 1) ~ '^[[:alnum:]]$' THEN
            v_pat := v_pat || '\M';
        END IF;
        IF NOT v_pat = ANY (v_parts) THEN
            v_parts := v_parts || v_pat;
        END IF;
    END LOOP;

    IF cardinality(v_parts) = 0 THEN
        RETURN NULL;
    END IF;
    RETURN '(?:' || array_to_string(v_parts, '|') || ')';
END;
$$;

-- Word presets, Discord's three categories. Opt-in per server. Terms use the same
-- wildcard syntax as custom keywords; matching folds case, homoglyphs and repeats.
CREATE OR REPLACE FUNCTION public.automod_preset_terms(p_preset text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT CASE p_preset
        WHEN 'profanity' THEN ARRAY[
            'fuck*', '*fucker', '*fuckers', 'motherfuck*', 'shit', 'shits', 'shitty', 'shitting',
            'bullshit', 'shithead*', 'horseshit', 'bitch', 'bitches', 'bitching', 'bitchy',
            'son of a bitch', 'bastard', 'bastards', 'asshole*', 'arsehole*', 'dumbass', 'jackass',
            'dickhead*', 'cunt', 'cunts', 'wanker*', 'twat', 'twats', 'bollocks', 'piss off',
            'pissed off', 'goddamn*', 'stfu', 'gtfo', 'wtf']
        WHEN 'sexual' THEN ARRAY[
            'porn*', 'xxx', 'nudes', 'dick pic*', 'cock pic*', 'blowjob*', 'blow job*', 'handjob*',
            'cumshot*', 'creampie*', 'gangbang*', 'deepthroat*', 'anal sex', 'orgasm*', 'masturbat*',
            'jerk off', 'jerking off', 'jack off', 'cock', 'cocks', 'pussy', 'pussies', 'tits',
            'titties', 'boobs', 'hentai', 'rule34', 'rule 34', 'onlyfans', 'sexting', 'camgirl*',
            'dildo*', 'horny', 'milf', 'milfs', 'bdsm', 'cum', 'cumming', 'cumslut*', 'slut',
            'sluts', 'whore', 'whores', 'erotica', 'nsfw']
        WHEN 'slurs' THEN ARRAY[
            'nigger', 'niggers', 'nigga', 'niggas', 'niggaz', 'sandnigger*', 'faggot*', 'fag',
            'fags', 'dyke', 'dykes', 'tranny', 'trannies', 'shemale*', 'retard', 'retards',
            'retarded', 'spic', 'spics', 'chink', 'chinks', 'gook', 'gooks', 'kike', 'kikes',
            'wetback*', 'beaner', 'beaners', 'towelhead*', 'raghead*', 'porch monkey*',
            'jungle bunny', 'jungle bunnies', 'zipperhead*', 'paki', 'pakis', 'golliwog*',
            'chinaman', 'kaffir*', 'gypsies', 'pikey', 'pikeys']
        ELSE '{}'::text[]
    END
$$;

CREATE OR REPLACE FUNCTION public.automod_regex_compiles(p_pattern text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM 'automod' ~ p_pattern;
    RETURN true;
EXCEPTION WHEN invalid_regular_expression OR program_limit_exceeded THEN
    RETURN false;
END;
$$;

-- jsonb array of strings -> text[], NULL-safe.
CREATE OR REPLACE FUNCTION public.automod_text_array(p_value jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(array_agg(btrim(x)) FILTER (WHERE btrim(x) <> ''), '{}')
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_value) = 'array' THEN p_value ELSE '[]'::jsonb END) x
$$;

-- Integer setting: absent or null gives the default; out of range raises.
CREATE OR REPLACE FUNCTION public.automod_int(p_value jsonb, p_default integer, p_min integer, p_max integer)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v integer;
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
        RETURN p_default;
    END IF;
    IF jsonb_typeof(p_value) NOT IN ('number', 'string') THEN
        RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: expected a number' USING ERRCODE = '22023';
    END IF;
    v := round((p_value #>> '{}')::numeric)::integer;
    IF v < p_min OR v > p_max THEN
        RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: % is outside %..%', v, p_min, p_max USING ERRCODE = '22023';
    END IF;
    RETURN v;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: expected a number' USING ERRCODE = '22023';
END;
$$;

-- Validates a rule's config and returns its canonical form. Raises 22023 with an
-- AUTOMOD_INVALID_RULE prefix on bad input.
CREATE OR REPLACE FUNCTION public.automod_canonical_config(p_type text, p_config jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    c jsonb := COALESCE(p_config, '{}'::jsonb);
    v_terms text[];
    v_allow text[];
    v_regex text[];
    v_presets text[];
    v_domains text[];
    v_item text;
BEGIN
    IF jsonb_typeof(c) <> 'object' THEN
        RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: config must be an object' USING ERRCODE = '22023';
    END IF;

    CASE p_type
    WHEN 'keyword' THEN
        v_terms := public.automod_text_array(c -> 'keywords');
        v_allow := public.automod_text_array(c -> 'allow_list');
        v_regex := public.automod_text_array(c -> 'regex_patterns');
        IF cardinality(v_terms) > 1000 THEN
            RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: at most 1000 keywords per rule' USING ERRCODE = '22023';
        END IF;
        IF cardinality(v_allow) > 100 THEN
            RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: at most 100 allowed words per rule' USING ERRCODE = '22023';
        END IF;
        IF cardinality(v_regex) > 10 THEN
            RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: at most 10 regular expressions per rule' USING ERRCODE = '22023';
        END IF;
        FOREACH v_item IN ARRAY v_terms || v_allow LOOP
            IF char_length(v_item) > 60 THEN
                RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: keywords are at most 60 characters' USING ERRCODE = '22023';
            END IF;
        END LOOP;
        FOREACH v_item IN ARRAY v_regex LOOP
            IF char_length(v_item) > 260 THEN
                RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: regular expressions are at most 260 characters' USING ERRCODE = '22023';
            END IF;
            -- Back-references are the one construct that makes the engine backtrack.
            IF v_item ~ '\\[1-9]' THEN
                RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: back-references are not supported in regular expressions' USING ERRCODE = '22023';
            END IF;
            IF NOT public.automod_regex_compiles(v_item) THEN
                RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: invalid regular expression: %', v_item USING ERRCODE = '22023';
            END IF;
        END LOOP;
        RETURN jsonb_build_object('keywords', to_jsonb(v_terms), 'allow_list', to_jsonb(v_allow),
                                  'regex_patterns', to_jsonb(v_regex));

    WHEN 'keyword_preset' THEN
        v_presets := public.automod_text_array(c -> 'presets');
        v_allow := public.automod_text_array(c -> 'allow_list');
        IF EXISTS (SELECT 1 FROM unnest(v_presets) p WHERE p NOT IN ('profanity', 'sexual', 'slurs')) THEN
            RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: presets are profanity, sexual and slurs' USING ERRCODE = '22023';
        END IF;
        IF cardinality(v_allow) > 100 THEN
            RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: at most 100 allowed words per rule' USING ERRCODE = '22023';
        END IF;
        RETURN jsonb_build_object('presets', to_jsonb(ARRAY(SELECT DISTINCT p FROM unnest(v_presets) p ORDER BY 1)),
                                  'allow_list', to_jsonb(v_allow));

    WHEN 'mention_spam' THEN
        RETURN jsonb_build_object(
            'max_mentions', public.automod_int(c -> 'max_mentions', 20, 1, 50),
            'window_mentions', public.automod_int(c -> 'window_mentions', 50, 0, 1000),
            'window_seconds', public.automod_int(c -> 'window_seconds', 60, 10, 3600),
            'block_everyone_without_permission', COALESCE((c ->> 'block_everyone_without_permission')::boolean, false));

    WHEN 'message_flood' THEN
        RETURN jsonb_build_object(
            'max_messages', public.automod_int(c -> 'max_messages', 10, 2, 100),
            'window_seconds', public.automod_int(c -> 'window_seconds', 10, 2, 300));

    WHEN 'duplicate_spam' THEN
        RETURN jsonb_build_object(
            'max_channels', public.automod_int(c -> 'max_channels', 2, 1, 20),
            'window_seconds', public.automod_int(c -> 'window_seconds', 300, 10, 3600),
            'min_length', public.automod_int(c -> 'min_length', 10, 1, 500));

    WHEN 'invites' THEN
        RETURN '{}'::jsonb;

    WHEN 'links' THEN
        v_domains := ARRAY(SELECT DISTINCT lower(btrim(d, ' .'))
                             FROM unnest(public.automod_text_array(c -> 'domains')) d
                            WHERE btrim(d, ' .') <> '');
        IF cardinality(v_domains) > 200 THEN
            RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: at most 200 domains per rule' USING ERRCODE = '22023';
        END IF;
        FOREACH v_item IN ARRAY v_domains LOOP
            IF v_item !~ '^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*$' OR char_length(v_item) > 253 THEN
                RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: not a domain: %', v_item USING ERRCODE = '22023';
            END IF;
        END LOOP;
        IF COALESCE(c ->> 'mode', 'allow_list') NOT IN ('allow_list', 'block_list') THEN
            RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: links mode is allow_list or block_list' USING ERRCODE = '22023';
        END IF;
        RETURN jsonb_build_object('mode', COALESCE(c ->> 'mode', 'allow_list'), 'domains', to_jsonb(v_domains));

    WHEN 'new_member' THEN
        RETURN jsonb_build_object(
            'min_account_age_minutes', public.automod_int(c -> 'min_account_age_minutes', 1440, 0, 525600),
            'min_membership_minutes', public.automod_int(c -> 'min_membership_minutes', 10, 0, 43200),
            'restrict_links', COALESCE((c ->> 'restrict_links')::boolean, true),
            'restrict_attachments', COALESCE((c ->> 'restrict_attachments')::boolean, false),
            'restrict_mentions', COALESCE((c ->> 'restrict_mentions')::boolean, false));

    ELSE
        RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: unknown rule type %', p_type USING ERRCODE = '22023';
    END CASE;
EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: malformed value in config' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.automod_canonical_actions(p_actions jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    a jsonb := COALESCE(p_actions, '{}'::jsonb);
    v_block boolean;
    v_alert boolean;
    v_timeout integer;
    v_message text;
BEGIN
    IF jsonb_typeof(a) <> 'object' THEN
        RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: actions must be an object' USING ERRCODE = '22023';
    END IF;
    v_block := COALESCE((a ->> 'block')::boolean, true);
    v_alert := COALESCE((a ->> 'alert')::boolean, true);
    -- 28 days, Discord's timeout ceiling.
    v_timeout := public.automod_int(a -> 'timeout_seconds', 0, 0, 2419200);
    v_message := NULLIF(btrim(COALESCE(a ->> 'block_message', '')), '');
    IF v_message IS NOT NULL AND char_length(v_message) > 150 THEN
        RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: the block message is at most 150 characters' USING ERRCODE = '22023';
    END IF;
    IF NOT v_block AND NOT v_alert AND v_timeout = 0 THEN
        RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: a rule needs at least one action' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('block', v_block, 'alert', v_alert, 'timeout_seconds', v_timeout,
                              'block_message', v_message);
EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: malformed value in actions' USING ERRCODE = '22023';
END;
$$;

-- Runtime form of one rule. NULL when the rule can never match (empty keyword lists).
CREATE OR REPLACE FUNCTION public.automod_compile_rule(p_type text, p_config jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_pattern text;
    v_allow text;
    v_regex jsonb;
    v_terms text[] := '{}'::text[];
    v_preset text;
BEGIN
    IF p_type = 'keyword' THEN
        v_pattern := public.automod_keyword_regex(public.automod_text_array(p_config -> 'keywords'));
        v_regex := COALESCE(p_config -> 'regex_patterns', '[]'::jsonb);
        IF v_pattern IS NULL AND jsonb_array_length(v_regex) = 0 THEN
            RETURN NULL;
        END IF;
        v_allow := public.automod_keyword_regex(public.automod_text_array(p_config -> 'allow_list'));
        RETURN jsonb_strip_nulls(jsonb_build_object('pattern', v_pattern, 'allow', v_allow, 'regex', v_regex));
    ELSIF p_type = 'keyword_preset' THEN
        FOR v_preset IN SELECT jsonb_array_elements_text(COALESCE(p_config -> 'presets', '[]'::jsonb)) LOOP
            v_terms := v_terms || public.automod_preset_terms(v_preset);
        END LOOP;
        v_pattern := public.automod_keyword_regex(v_terms);
        IF v_pattern IS NULL THEN
            RETURN NULL;
        END IF;
        v_allow := public.automod_keyword_regex(public.automod_text_array(p_config -> 'allow_list'));
        RETURN jsonb_strip_nulls(jsonb_build_object('pattern', v_pattern, 'allow', v_allow));
    END IF;
    RETURN p_config;
END;
$$;

-- Rebuilds server_automod_settings.compiled from the enabled rules. Rules that count
-- recent writes (flood, then duplicates) sort last, so a message a content rule blocks
-- never pays for those lookups; otherwise position order holds.
CREATE OR REPLACE FUNCTION public.automod_recompile_server(p_server_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.server_automod_settings st
       SET compiled = jsonb_build_object(
               'exempt_bots', st.exempt_bots,
               -- Rules that count recent writes need automod_recent_activity rows.
               'track', EXISTS (
                   SELECT 1 FROM public.server_automod_rules tr
                    WHERE tr.server_id = p_server_id AND tr.enabled
                      AND (tr.rule_type IN ('message_flood', 'duplicate_spam')
                           OR (tr.rule_type = 'mention_spam'
                               AND COALESCE((tr.config ->> 'window_mentions')::integer, 0) > 0))),
               'rules', COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                              'id', r.id, 'name', r.name, 'type', r.rule_type,
                              'a', r.actions,
                              'xr', to_jsonb(r.exempt_role_ids),
                              'xc', to_jsonb(r.exempt_channel_ids),
                              'c', r.compiled)
                          ORDER BY CASE r.rule_type WHEN 'message_flood' THEN 1 WHEN 'duplicate_spam' THEN 2 ELSE 0 END,
                                   r.position, r.created_at)
                     FROM (SELECT sr.*, public.automod_compile_rule(sr.rule_type, sr.config) AS compiled
                             FROM public.server_automod_rules sr
                            WHERE sr.server_id = p_server_id AND sr.enabled) r
                    WHERE r.compiled IS NOT NULL), '[]'::jsonb))
     WHERE st.server_id = p_server_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.automod_rules_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        PERFORM public.automod_recompile_server(OLD.server_id);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT' OR NEW.server_id IS DISTINCT FROM OLD.server_id) THEN
        PERFORM public.automod_recompile_server(NEW.server_id);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_automod_rules_changed ON public.server_automod_rules;
CREATE TRIGGER trg_automod_rules_changed
    AFTER INSERT OR UPDATE OR DELETE ON public.server_automod_rules
    FOR EACH ROW EXECUTE FUNCTION public.automod_rules_changed();

CREATE OR REPLACE FUNCTION public.automod_settings_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.exempt_bots IS DISTINCT FROM OLD.exempt_bots THEN
        PERFORM public.automod_recompile_server(NEW.server_id);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_automod_settings_changed ON public.server_automod_settings;
CREATE TRIGGER trg_automod_settings_changed
    AFTER INSERT OR UPDATE OF exempt_bots ON public.server_automod_settings
    FOR EACH ROW EXECUTE FUNCTION public.automod_settings_changed();

-- ---------------------------------------------------------------------------
-- Recommended preset
-- ---------------------------------------------------------------------------

-- Creates the settings row and the recommended rules when the server has none.
-- p_enable sets the master switch either way.
CREATE OR REPLACE FUNCTION public.automod_install_preset(p_server_id uuid, p_enable boolean, p_actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.server_automod_settings (server_id, enabled, updated_by)
    VALUES (p_server_id, p_enable, p_actor)
    ON CONFLICT (server_id) DO UPDATE
       SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by;

    IF EXISTS (SELECT 1 FROM public.server_automod_rules WHERE server_id = p_server_id) THEN
        RETURN;
    END IF;

    INSERT INTO public.server_automod_rules (server_id, name, rule_type, enabled, config, actions, position, created_by)
    VALUES
        (p_server_id, 'Block mention spam', 'mention_spam', true,
         public.automod_canonical_config('mention_spam', '{}'::jsonb),
         public.automod_canonical_actions('{"block": true, "alert": true}'::jsonb), 0, p_actor),
        (p_server_id, 'Block message floods', 'message_flood', true,
         public.automod_canonical_config('message_flood', '{}'::jsonb),
         public.automod_canonical_actions('{"block": true, "alert": true}'::jsonb), 1, p_actor),
        (p_server_id, 'Block cross-channel spam', 'duplicate_spam', true,
         public.automod_canonical_config('duplicate_spam', '{}'::jsonb),
         public.automod_canonical_actions('{"block": true, "alert": true}'::jsonb), 2, p_actor),
        (p_server_id, 'Block invites to other servers', 'invites', false,
         public.automod_canonical_config('invites', '{}'::jsonb),
         public.automod_canonical_actions('{"block": true, "alert": true}'::jsonb), 3, p_actor),
        (p_server_id, 'Block slurs', 'keyword_preset', false,
         public.automod_canonical_config('keyword_preset', '{"presets": ["slurs"]}'::jsonb),
         public.automod_canonical_actions('{"block": true, "alert": true}'::jsonb), 4, p_actor),
        (p_server_id, 'Restrict new members', 'new_member', false,
         public.automod_canonical_config('new_member', '{}'::jsonb),
         public.automod_canonical_actions('{"block": true, "alert": false}'::jsonb), 5, p_actor);
END;
$$;

CREATE OR REPLACE FUNCTION public.automod_server_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_local_server IS TRUE THEN
        PERFORM public.automod_install_preset(NEW.id, true, NEW.owner);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_automod_server_created ON public.servers;
CREATE TRIGGER trg_automod_server_created
    AFTER INSERT ON public.servers
    FOR EACH ROW EXECUTE FUNCTION public.automod_server_created();

-- ---------------------------------------------------------------------------
-- Content features
-- ---------------------------------------------------------------------------

-- Lowercase hostnames of links in the text and in url/embed parts. Bare domains count
-- only with a common TLD, so "file.txt" or "e.g." is not a link.
CREATE OR REPLACE FUNCTION public.automod_link_hosts(p_text text, p_urls text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(array_agg(DISTINCT h) FILTER (WHERE h IS NOT NULL AND h <> ''), '{}')
      FROM (
          SELECT rtrim(regexp_replace(lower(m[1]), '^[^@]*@|:[0-9]*$', '', 'g'), '.') AS h
            FROM regexp_matches(COALESCE(p_text, ''),
                 '(?:https?://|\mwww\.)([^[:space:]/?#<>"''()\[\]{}|\\^`]+)', 'gi') AS m
          UNION ALL
          SELECT lower(m[1])
            FROM regexp_matches(COALESCE(p_text, ''),
                 '(?:^|[^[:alnum:]@./-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|gg|co|xyz|ru|me|info|biz|app|dev|link|ly|tk|ml|ga|cf|gq|top|site|online|club|shop|store|live|tv|us|uk|de|fr|cn|su|pw|cc|ws|fun|icu|vip|win|bid|click|lol|sbs|cfd))(?![[:alnum:].-]*@)(?=$|[^[:alnum:]-])', 'gi') AS m
          UNION ALL
          SELECT lower(substring(u FROM '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/?#]*@)?([^/?#:]+)'))
            FROM unnest(COALESCE(p_urls, '{}')) u
      ) hosts
$$;

-- First invite in the message that leads anywhere but p_server_id; NULL when none.
-- Discord invite hosts always count. A Harmony /invite/<code> link counts unless the
-- code is one of this server's invites rows; invite links are built from invites.code.
-- servers.invite_code exists on fresh installs only and is not read.
CREATE OR REPLACE FUNCTION public.automod_foreign_invite(p_text text, p_urls text[], p_server_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_all text := COALESCE(p_text, '') || E'\n' || array_to_string(COALESCE(p_urls, '{}'), E'\n');
    m text[];
BEGIN
    m := regexp_match(v_all, '(?:discord(?:app)?\.com/invite|discord\.gg|dsc\.gg)/[a-z0-9-]+', 'i');
    IF m IS NOT NULL THEN
        RETURN m[1];
    END IF;

    FOR m IN
        SELECT x FROM regexp_matches(v_all, '([a-z0-9.-]+(?::[0-9]+)?/invite/([A-Za-z0-9_-]{1,64}))', 'gi') AS x
    LOOP
        IF NOT EXISTS (SELECT 1 FROM public.invites i WHERE i.code = m[2] AND i.server_id = p_server_id) THEN
            RETURN m[1];
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Events, alerts, timeouts
-- ---------------------------------------------------------------------------

-- supabase-js .single()/.maybeSingle() send this Accept header; PostgREST rolls such a
-- mutation back when it affects zero rows.
CREATE OR REPLACE FUNCTION public.automod_singular_request()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN COALESCE(
        (NULLIF(current_setting('request.headers', true), '')::jsonb ->> 'accept')
            LIKE '%application/vnd.pgrst.object%',
        false);
EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.automod_post_alert(
    p_alert_channel uuid, p_event_id uuid, p_text text, p_details jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
    VALUES (p_alert_channel, NULL,
            jsonb_build_array(jsonb_build_object('type', 'text', 'text', left(p_text, 1900))),
            true,
            jsonb_build_object('type', 'automod_alert',
                               'automod', p_details || jsonb_build_object('event_id', p_event_id)));
END;
$$;

-- Records one rule match: folds repeats within 30 s into the latest event, posts an
-- alert for a new event, applies the rule's timeout.
CREATE OR REPLACE FUNCTION public.automod_record_match(
    p_server_id uuid, p_channel_id uuid, p_user_id uuid, p_bot_id uuid, p_message_id uuid,
    p_event_type text, p_rule jsonb, p_hit text, p_blocked boolean, p_content jsonb,
    p_alert_channel uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rule_id uuid := (p_rule ->> 'id')::uuid;
    v_timeout integer := COALESCE((p_rule -> 'a' ->> 'timeout_seconds')::integer, 0);
    v_alert boolean := COALESCE((p_rule -> 'a' ->> 'alert')::boolean, false);
    v_actions text[] := '{}'::text[];
    v_excerpt text := left(public.automod_message_text(p_content), 1000);
    v_event uuid;
    v_author text;
    v_channel_name text;
    v_verb text;
BEGIN
    IF p_blocked THEN v_actions := v_actions || 'block'::text; END IF;
    IF v_alert THEN v_actions := v_actions || 'alert'::text; END IF;
    IF v_timeout > 0 AND p_user_id IS NOT NULL THEN v_actions := v_actions || 'timeout'::text; END IF;

    IF p_user_id IS NOT NULL THEN
        SELECT e.id INTO v_event
          FROM public.automod_events e
         WHERE e.user_id = p_user_id
           AND e.last_hit_at > now() - interval '30 seconds'
           AND e.server_id = p_server_id
           AND e.rule_id = v_rule_id
           AND e.event_type = p_event_type
         ORDER BY e.last_hit_at DESC
         LIMIT 1
         FOR UPDATE;
    ELSE
        SELECT e.id INTO v_event
          FROM public.automod_events e
         WHERE e.server_id = p_server_id
           AND e.created_at > now() - interval '1 day'
           AND e.last_hit_at > now() - interval '30 seconds'
           AND e.user_id IS NULL
           AND e.bot_id IS NOT DISTINCT FROM p_bot_id
           AND e.rule_id = v_rule_id
           AND e.event_type = p_event_type
         ORDER BY e.last_hit_at DESC
         LIMIT 1
         FOR UPDATE;
    END IF;

    IF v_event IS NOT NULL THEN
        UPDATE public.automod_events e
           SET hits = e.hits + 1,
               last_hit_at = now(),
               channel_id = p_channel_id,
               message_id = p_message_id,
               matched = left(p_hit, 200),
               content_excerpt = v_excerpt,
               actions = ARRAY(SELECT DISTINCT x FROM unnest(e.actions || v_actions) x ORDER BY 1)
         WHERE e.id = v_event;
    ELSE
        INSERT INTO public.automod_events (
            server_id, channel_id, user_id, bot_id, message_id, rule_id, rule_name, rule_type,
            event_type, actions, matched, content_excerpt)
        VALUES (
            p_server_id, p_channel_id, p_user_id, p_bot_id, p_message_id, v_rule_id,
            p_rule ->> 'name', p_rule ->> 'type', p_event_type,
            ARRAY(SELECT x FROM unnest(v_actions) x ORDER BY 1), left(p_hit, 200), v_excerpt)
        RETURNING id INTO v_event;

        IF v_alert AND p_alert_channel IS NOT NULL THEN
            SELECT COALESCE(p.username, 'unknown') INTO v_author FROM public.profiles p WHERE p.id = p_user_id;
            IF p_user_id IS NULL THEN
                SELECT COALESCE(b.display_name, b.username, 'a bot') INTO v_author FROM public.bots b WHERE b.id = p_bot_id;
            END IF;
            SELECT c.name INTO v_channel_name FROM public.channels c WHERE c.id = p_channel_id;
            v_verb := CASE WHEN p_blocked THEN 'blocked' ELSE 'flagged' END;
            PERFORM public.automod_post_alert(
                p_alert_channel, v_event,
                format('AutoMod %s %s from @%s in #%s (%s)%s',
                       v_verb,
                       CASE WHEN p_event_type = 'edit' THEN 'an edit' ELSE 'a message' END,
                       COALESCE(v_author, 'unknown'), COALESCE(v_channel_name, 'unknown'),
                       p_rule ->> 'name',
                       CASE WHEN v_excerpt IS NOT NULL THEN E'\n> ' || left(replace(v_excerpt, E'\n', ' '), 300) ELSE '' END),
                jsonb_build_object(
                    'event_type', p_event_type, 'rule_id', v_rule_id, 'rule_name', p_rule ->> 'name',
                    'rule_type', p_rule ->> 'type', 'user_id', p_user_id, 'bot_id', p_bot_id,
                    'channel_id', p_channel_id, 'message_id', p_message_id, 'actions', to_jsonb(v_actions),
                    'matched', left(p_hit, 200), 'excerpt', left(v_excerpt, 300)));
        END IF;
    END IF;

    IF v_timeout > 0 AND p_user_id IS NOT NULL THEN
        INSERT INTO public.server_member_timeouts (server_id, user_id, until, reason, source)
        VALUES (p_server_id, p_user_id, now() + make_interval(secs => v_timeout),
                left('AutoMod: ' || (p_rule ->> 'name'), 512), 'automod')
        ON CONFLICT (server_id, user_id) DO UPDATE
           SET until = GREATEST(
                   CASE WHEN public.server_member_timeouts.until > now() THEN public.server_member_timeouts.until END,
                   EXCLUDED.until),
               reason = EXCLUDED.reason,
               source = EXCLUDED.source,
               created_by = NULL,
               created_at = now();
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Message evaluation
-- ---------------------------------------------------------------------------

-- p_invoker is current_user of the statement that wrote the row. Returns false to drop
-- the row; raises AUTOMOD_BLOCKED, MEMBER_TIMED_OUT or ANTISPAM_* to reject it.
CREATE OR REPLACE FUNCTION public.automod_check_message(p_msg public.messages, p_op text, p_invoker text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_internal boolean := p_invoker IN ('postgres', 'supabase_admin');
    v_client boolean := p_invoker IN ('authenticated', 'anon');
    v_author uuid := p_msg.user_id;
    v_channel_id uuid;
    v_server_id uuid;
    v_category uuid;
    v_owner uuid;
    v_is_local_server boolean;
    v_enabled boolean;
    v_compiled jsonb;
    v_alert_channel uuid;
    v_timeout_until timestamptz;
    v_mask bigint := 0;
    v_role_ids uuid[] := '{}'::uuid[];
    v_default_role uuid;
    v_encrypted boolean := p_msg.encrypted IS TRUE;
    v_content jsonb := CASE WHEN jsonb_typeof(p_msg.content) = 'array' THEN p_msg.content ELSE '[]'::jsonb END;
    v_raw text;
    v_urls text[];
    v_files integer;
    v_mention_users text[];
    v_mention_roles text[];
    v_norm text;
    v_subject text;
    v_hosts text[];
    v_hosts_done boolean := false;
    v_new_member boolean;
    v_account_created timestamptz;
    v_joined timestamptz;
    v_rule jsonb;
    v_cfg jsonb;
    v_type text;
    v_hit text;
    v_re text;
    v_count integer;
    v_matches jsonb := '[]'::jsonb;
    v_block jsonb;
    v_event_type text := CASE WHEN p_op = 'UPDATE' THEN 'edit' ELSE 'message' END;
    v_mentions integer;
    v_window integer;
    v_limit integer;
    v_host text;
    v_domain text;
    v_listed boolean;
    v_fp bigint;
    v_track_antispam boolean := false;
    v_track_server boolean := false;
    m jsonb;
BEGIN
    IF pg_trigger_depth() < 1 THEN
        RAISE EXCEPTION 'automod_check_message runs only from the messages trigger'
            USING ERRCODE = '42501';
    END IF;

    IF v_internal AND p_msg.is_system IS TRUE THEN
        RETURN true;
    END IF;
    IF v_author IS NULL AND p_msg.bot_id IS NULL THEN
        RETURN true;
    END IF;
    IF p_op = 'UPDATE' THEN
        IF p_msg.is_deleted IS TRUE
           OR current_setting('harmony.silent_content_update', true) = 'true' THEN
            RETURN true;
        END IF;
        -- Moderators editing someone else's row are not evaluated.
        IF v_client AND v_author IS DISTINCT FROM public.get_current_profile_id() THEN
            RETURN true;
        END IF;
    END IF;

    IF v_author IS NOT NULL AND NOT v_internal THEN
        v_track_antispam := public.antispam_check_local_author(v_author, 'message', v_content, p_op);
    END IF;

    -- EXIT evaluation allows the row; the recent-activity row is written after it.
    <<evaluation>>
    BEGIN
        v_channel_id := p_msg.channel_id;
        IF v_channel_id IS NULL AND p_msg.thread_id IS NOT NULL THEN
            SELECT t.channel_id INTO v_channel_id FROM public.threads t WHERE t.id = p_msg.thread_id;
        END IF;
        IF v_channel_id IS NULL THEN
            EXIT evaluation;
        END IF;

        SELECT c.server_id, c.category, s.owner, s.is_local_server,
               st.enabled, st.compiled, st.alert_channel_id, t.until
          INTO v_server_id, v_category, v_owner, v_is_local_server,
               v_enabled, v_compiled, v_alert_channel, v_timeout_until
          FROM public.channels c
          JOIN public.servers s ON s.id = c.server_id
          LEFT JOIN public.server_automod_settings st ON st.server_id = c.server_id
          LEFT JOIN public.server_member_timeouts t
                 ON t.server_id = c.server_id AND t.user_id = v_author AND t.until > now()
         WHERE c.id = v_channel_id;

        IF NOT FOUND OR v_is_local_server IS NOT TRUE THEN
            v_server_id := NULL;
            EXIT evaluation;
        END IF;

        IF v_timeout_until IS NOT NULL
           AND (NOT v_client OR v_author = public.get_current_profile_id()) THEN
            RAISE EXCEPTION 'MEMBER_TIMED_OUT:%', floor(extract(epoch FROM v_timeout_until))::bigint
                USING ERRCODE = 'P0001',
                      HINT = format('You are timed out in this server until %s.', v_timeout_until);
        END IF;

        IF v_enabled IS NOT TRUE OR jsonb_array_length(COALESCE(v_compiled -> 'rules', '[]'::jsonb)) = 0 THEN
            EXIT evaluation;
        END IF;

        IF v_author IS NULL THEN
            IF COALESCE((v_compiled ->> 'exempt_bots')::boolean, true) THEN
                EXIT evaluation;
            END IF;
        ELSE
            IF v_author = v_owner THEN
                EXIT evaluation;
            END IF;
            SELECT COALESCE(bit_or(sr.permissions), 0),
                   COALESCE(array_agg(sr.id), '{}'),
                   (array_agg(sr.id) FILTER (WHERE sr.is_default))[1]
              INTO v_mask, v_role_ids, v_default_role
              FROM public.server_roles sr
             WHERE sr.server_id = v_server_id
               AND (sr.is_default
                    OR sr.id IN (SELECT ur.role_id FROM public.user_roles ur
                                  WHERE ur.user_id = v_author AND ur.server_id = v_server_id));
            -- ADMINISTRATOR (bit 0) or MANAGE_SERVER (bit 7).
            IF (v_mask & 129) <> 0 THEN
                EXIT evaluation;
            END IF;
        END IF;

        v_track_server := p_op = 'INSERT' AND v_author IS NOT NULL AND NOT v_internal
                          AND COALESCE((v_compiled ->> 'track')::boolean, false);

        SELECT string_agg(e ->> 'text', E'\n') FILTER (WHERE e ->> 'type' = 'text' AND e ->> 'text' IS NOT NULL),
               array_agg(e ->> 'url') FILTER (WHERE e ->> 'type' IN ('url', 'embed') AND e ->> 'url' IS NOT NULL),
               count(*) FILTER (WHERE e ->> 'type' = 'file'),
               array_agg(DISTINCT COALESCE(e ->> 'userId', (e ->> 'username') || '@' || COALESCE(e ->> 'domain', '')))
                   FILTER (WHERE e ->> 'type' = 'mention'),
               array_agg(DISTINCT e ->> 'roleId') FILTER (WHERE e ->> 'type' = 'role_mention' AND e ->> 'roleId' IS NOT NULL)
          INTO v_raw, v_urls, v_files, v_mention_users, v_mention_roles
          FROM jsonb_array_elements(v_content) e;

        v_mentions := COALESCE(cardinality(v_mention_users), 0) + COALESCE(cardinality(v_mention_roles), 0);

        FOR v_rule IN SELECT r FROM jsonb_array_elements(v_compiled -> 'rules') r LOOP
            v_type := v_rule ->> 'type';
            v_cfg := v_rule -> 'c';
            v_hit := NULL;

            IF (v_rule -> 'xc') ? v_channel_id::text
               OR (v_category IS NOT NULL AND (v_rule -> 'xc') ? v_category::text) THEN
                CONTINUE;
            END IF;
            IF v_author IS NOT NULL AND jsonb_array_length(v_rule -> 'xr') > 0
               AND (v_rule -> 'xr') ?| v_role_ids::text[] THEN
                CONTINUE;
            END IF;
            IF v_author IS NULL AND v_type IN ('message_flood', 'duplicate_spam', 'new_member') THEN
                CONTINUE;
            END IF;

            IF v_type IN ('keyword', 'keyword_preset') THEN
                CONTINUE WHEN v_encrypted OR v_raw IS NULL;
                IF v_norm IS NULL THEN
                    v_norm := public.automod_normalize(v_raw);
                END IF;
                v_subject := v_norm;
                IF v_cfg ? 'allow' THEN
                    v_subject := regexp_replace(v_subject, v_cfg ->> 'allow', ' ', 'g');
                END IF;
                IF v_cfg ? 'pattern' AND v_subject ~ (v_cfg ->> 'pattern') THEN
                    v_hit := (regexp_match(v_subject, v_cfg ->> 'pattern'))[1];
                    v_hit := COALESCE(v_hit, 'keyword');
                END IF;
                IF v_hit IS NULL AND v_cfg ? 'regex' THEN
                    FOR v_re IN SELECT jsonb_array_elements_text(v_cfg -> 'regex') LOOP
                        IF v_raw ~* v_re THEN
                            v_hit := COALESCE((regexp_match(v_raw, v_re, 'i'))[1], 'regex');
                        ELSIF v_subject ~* v_re THEN
                            v_hit := COALESCE((regexp_match(v_subject, v_re, 'i'))[1], 'regex');
                        END IF;
                        EXIT WHEN v_hit IS NOT NULL;
                    END LOOP;
                END IF;

            ELSIF v_type = 'mention_spam' THEN
                CONTINUE WHEN v_mentions = 0;
                IF v_mentions > (v_cfg ->> 'max_mentions')::integer THEN
                    v_hit := v_mentions || ' mentions';
                ELSIF (v_cfg ->> 'block_everyone_without_permission')::boolean
                      AND v_default_role IS NOT NULL
                      AND v_default_role::text = ANY (COALESCE(v_mention_roles, '{}'))
                      AND v_author IS NOT NULL
                      AND NOT public.has_permission(v_author, v_server_id, 'MENTION_EVERYONE', v_channel_id) THEN
                    v_hit := '@everyone';
                ELSIF p_op = 'INSERT' AND v_author IS NOT NULL AND NOT v_internal
                      AND (v_cfg ->> 'window_mentions')::integer > 0 THEN
                    v_window := (v_cfg ->> 'window_seconds')::integer;
                    SELECT COALESCE(sum(ra.mentions), 0) INTO v_count
                      FROM public.automod_recent_activity ra
                     WHERE ra.user_id = v_author
                       AND ra.created_at > now() - make_interval(secs => v_window)
                       AND ra.server_id = v_server_id;
                    IF v_count + v_mentions > (v_cfg ->> 'window_mentions')::integer THEN
                        v_hit := (v_count + v_mentions) || ' mentions in ' || v_window || ' s';
                    END IF;
                END IF;

            ELSIF v_type = 'message_flood' THEN
                CONTINUE WHEN p_op <> 'INSERT' OR v_internal;
                v_limit := (v_cfg ->> 'max_messages')::integer;
                v_window := (v_cfg ->> 'window_seconds')::integer;
                SELECT count(*) INTO v_count
                  FROM (SELECT 1
                          FROM public.automod_recent_activity ra
                         WHERE ra.user_id = v_author
                           AND ra.created_at > now() - make_interval(secs => v_window)
                           AND ra.server_id = v_server_id
                         LIMIT v_limit) r;
                IF v_count >= v_limit THEN
                    v_hit := v_limit || ' messages in ' || v_window || ' s';
                END IF;

            ELSIF v_type = 'duplicate_spam' THEN
                CONTINUE WHEN p_op <> 'INSERT' OR v_internal OR v_encrypted OR v_raw IS NULL
                           OR char_length(btrim(v_raw)) < (v_cfg ->> 'min_length')::integer;
                IF v_norm IS NULL THEN
                    v_norm := public.automod_normalize(v_raw);
                END IF;
                v_fp := hashtextextended(v_norm, 0);
                SELECT count(DISTINCT f.channel_id) INTO v_count
                  FROM (SELECT ra.channel_id
                          FROM public.automod_recent_activity ra
                         WHERE ra.user_id = v_author
                           AND ra.created_at > now() - make_interval(secs => (v_cfg ->> 'window_seconds')::integer)
                           AND ra.server_id = v_server_id
                           AND ra.fp = v_fp
                           AND ra.channel_id <> v_channel_id
                         LIMIT 100) f;
                IF v_count >= (v_cfg ->> 'max_channels')::integer THEN
                    v_hit := 'same message in ' || (v_count + 1) || ' channels';
                END IF;

            ELSIF v_type = 'invites' THEN
                CONTINUE WHEN v_encrypted OR (v_raw IS NULL AND v_urls IS NULL);
                v_hit := public.automod_foreign_invite(v_raw, v_urls, v_server_id);

            ELSIF v_type = 'links' THEN
                CONTINUE WHEN v_encrypted OR (v_raw IS NULL AND v_urls IS NULL);
                IF NOT v_hosts_done THEN
                    v_hosts := public.automod_link_hosts(v_raw, v_urls);
                    v_hosts_done := true;
                END IF;
                FOREACH v_host IN ARRAY v_hosts LOOP
                    v_listed := false;
                    FOR v_domain IN SELECT jsonb_array_elements_text(v_cfg -> 'domains') LOOP
                        IF v_host = v_domain OR right(v_host, char_length(v_domain) + 1) = '.' || v_domain THEN
                            v_listed := true;
                            EXIT;
                        END IF;
                    END LOOP;
                    IF (v_cfg ->> 'mode' = 'allow_list' AND NOT v_listed)
                       OR (v_cfg ->> 'mode' = 'block_list' AND v_listed) THEN
                        v_hit := v_host;
                        EXIT;
                    END IF;
                END LOOP;

            ELSIF v_type = 'new_member' THEN
                IF v_new_member IS NULL THEN
                    SELECT p.created_at INTO v_account_created FROM public.profiles p WHERE p.id = v_author;
                    SELECT us.created_at INTO v_joined
                      FROM public.user_servers us
                     WHERE us.user_id = v_author AND us.server_id = v_server_id;
                    v_new_member :=
                        ((v_cfg ->> 'min_account_age_minutes')::integer > 0
                         AND v_account_created > now() - make_interval(mins => (v_cfg ->> 'min_account_age_minutes')::integer))
                        OR ((v_cfg ->> 'min_membership_minutes')::integer > 0
                            AND v_joined > now() - make_interval(mins => (v_cfg ->> 'min_membership_minutes')::integer));
                    v_new_member := COALESCE(v_new_member, false);
                END IF;
                CONTINUE WHEN NOT v_new_member;
                IF (v_cfg ->> 'restrict_attachments')::boolean AND v_files > 0 THEN
                    v_hit := 'attachment';
                ELSIF (v_cfg ->> 'restrict_mentions')::boolean AND v_mentions > 0 THEN
                    v_hit := 'mention';
                ELSIF (v_cfg ->> 'restrict_links')::boolean AND NOT v_encrypted
                      AND (v_raw IS NOT NULL OR v_urls IS NOT NULL) THEN
                    IF NOT v_hosts_done THEN
                        v_hosts := public.automod_link_hosts(v_raw, v_urls);
                        v_hosts_done := true;
                    END IF;
                    IF cardinality(v_hosts) > 0 THEN
                        v_hit := v_hosts[1];
                    END IF;
                END IF;
            END IF;

            CONTINUE WHEN v_hit IS NULL;

            v_matches := v_matches || jsonb_build_array(jsonb_build_object('rule', v_rule, 'hit', v_hit));
            IF COALESCE((v_rule -> 'a' ->> 'block')::boolean, false) THEN
                v_block := v_rule;
                EXIT;
            END IF;
        END LOOP;

        IF jsonb_array_length(v_matches) = 0 THEN
            EXIT evaluation;
        END IF;

        IF v_block IS NOT NULL THEN
            -- The row must pass messages_insert_member before anything persists for it.
            IF v_client THEN
                IF v_author IS NULL OR v_author IS DISTINCT FROM public.get_current_profile_id() THEN
                    RETURN true;
                END IF;
                IF p_op = 'INSERT' AND NOT (
                       p_msg.channel_id IS NOT NULL
                       AND v_channel_id IN (SELECT public.current_user_viewable_channel_ids())
                       AND public.has_permission(v_author, v_server_id,
                               CASE WHEN p_msg.thread_id IS NULL THEN 'SEND_MESSAGES' ELSE 'SEND_MESSAGES_IN_THREADS' END,
                               v_channel_id)) THEN
                    RETURN true;
                END IF;
            END IF;

            IF public.automod_singular_request() THEN
                RAISE EXCEPTION 'AUTOMOD_BLOCKED:%', v_block ->> 'type'
                    USING ERRCODE = 'P0001',
                          DETAIL = jsonb_build_object('rule_type', v_block ->> 'type',
                                                      'rule_name', v_block ->> 'name',
                                                      'message', v_block -> 'a' ->> 'block_message')::text,
                          HINT = COALESCE(v_block -> 'a' ->> 'block_message',
                                          'This message was blocked by the server''s AutoMod.');
            END IF;
        END IF;

        FOR m IN SELECT x FROM jsonb_array_elements(v_matches) x LOOP
            PERFORM public.automod_record_match(
                v_server_id, v_channel_id, v_author, p_msg.bot_id,
                CASE WHEN v_block IS NULL OR p_op = 'UPDATE' THEN p_msg.id END,
                v_event_type, m -> 'rule', m ->> 'hit',
                v_block IS NOT NULL AND (m -> 'rule' ->> 'id') = (v_block ->> 'id'),
                v_content, v_alert_channel);
        END LOOP;

        IF v_block IS NOT NULL THEN
            RETURN false;
        END IF;
    END evaluation;

    IF p_op = 'INSERT' AND (v_track_antispam OR v_track_server) THEN
        INSERT INTO public.automod_recent_activity (user_id, kind, server_id, channel_id, fp, mentions)
        VALUES (v_author, 'message', v_server_id, v_channel_id, v_fp, COALESCE(v_mentions, 0));
    END IF;
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.automod_message_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content THEN
        RETURN NEW;
    END IF;
    -- anon never passes messages_insert_member; RLS rejects the row.
    IF current_user = 'anon' THEN
        RETURN NEW;
    END IF;
    IF public.automod_check_message(NEW, TG_OP, current_user::text) THEN
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$;

-- Sorts after trg_enforce_message_length and ahead of trg_process_local_link_previews,
-- trigger_enforce_channel_slowmode and the federation queue triggers, so a dropped row
-- queues nothing.
DROP TRIGGER IF EXISTS trg_moderate_message ON public.messages;
CREATE TRIGGER trg_moderate_message
    BEFORE INSERT OR UPDATE OF content ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.automod_message_guard();

-- ---------------------------------------------------------------------------
-- Raid detection
-- ---------------------------------------------------------------------------

-- Lockdown sets slowmode on every text channel slower than the raid setting and records
-- the previous values; lifting restores channels still at the lockdown value.
CREATE OR REPLACE FUNCTION public.automod_apply_raid_lockdown(p_server_id uuid, p_active boolean, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_state jsonb;
    v_seconds integer;
    v_prev jsonb := '{}'::jsonb;
    v_ch record;
BEGIN
    SELECT st.raid_state, COALESCE((st.raid_settings ->> 'slowmode_seconds')::integer, 30)
      INTO v_state, v_seconds
      FROM public.server_automod_settings st
     WHERE st.server_id = p_server_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN '{"active": false}'::jsonb;
    END IF;

    IF p_active THEN
        IF COALESCE((v_state ->> 'active')::boolean, false) THEN
            RETURN v_state;
        END IF;
        FOR v_ch IN
            SELECT c.id, COALESCE(c.slowmode_seconds, 0) AS prev
              FROM public.channels c
             WHERE c.server_id = p_server_id AND c.type = 0 AND COALESCE(c.slowmode_seconds, 0) < v_seconds
        LOOP
            v_prev := v_prev || jsonb_build_object(v_ch.id::text, v_ch.prev);
            UPDATE public.channels SET slowmode_seconds = v_seconds WHERE id = v_ch.id;
        END LOOP;
        v_state := jsonb_build_object('active', true, 'since', now(), 'slowmode_seconds', v_seconds,
                                      'channels', v_prev, 'by', p_actor);
    ELSE
        IF NOT COALESCE((v_state ->> 'active')::boolean, false) THEN
            RETURN v_state;
        END IF;
        UPDATE public.channels c
           SET slowmode_seconds = (v_state -> 'channels' ->> c.id::text)::integer
         WHERE c.server_id = p_server_id
           AND v_state -> 'channels' ? c.id::text
           AND c.slowmode_seconds = (v_state ->> 'slowmode_seconds')::integer;
        v_state := jsonb_build_object('active', false, 'lifted_at', now(), 'by', p_actor);
    END IF;

    UPDATE public.server_automod_settings SET raid_state = v_state, updated_at = now()
     WHERE server_id = p_server_id;
    RETURN v_state;
END;
$$;

CREATE OR REPLACE FUNCTION public.automod_member_joined()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_settings jsonb;
    v_enabled boolean;
    v_last timestamptz;
    v_alert_channel uuid;
    v_threshold integer;
    v_window integer;
    v_joins integer;
    v_event uuid;
    v_state jsonb;
BEGIN
    SELECT st.enabled, st.raid_settings, st.last_raid_at, st.alert_channel_id
      INTO v_enabled, v_settings, v_last, v_alert_channel
      FROM public.server_automod_settings st
      JOIN public.servers s ON s.id = st.server_id AND s.is_local_server
     WHERE st.server_id = NEW.server_id;

    IF NOT FOUND OR v_enabled IS NOT TRUE OR NOT COALESCE((v_settings ->> 'enabled')::boolean, false) THEN
        RETURN NULL;
    END IF;
    v_threshold := COALESCE((v_settings ->> 'join_threshold')::integer, 10);
    v_window := COALESCE((v_settings ->> 'window_seconds')::integer, 60);
    -- One alert per window of quiet; a sustained raid does not re-alert on every join.
    IF v_last IS NOT NULL AND v_last > now() - make_interval(secs => GREATEST(v_window, 600)) THEN
        RETURN NULL;
    END IF;

    SELECT count(*) INTO v_joins
      FROM (SELECT 1 FROM public.user_servers us
             WHERE us.server_id = NEW.server_id
               AND us.created_at > now() - make_interval(secs => v_window)
               AND us.status = 'accepted'
             LIMIT v_threshold) j;
    IF v_joins < v_threshold THEN
        RETURN NULL;
    END IF;

    UPDATE public.server_automod_settings SET last_raid_at = now() WHERE server_id = NEW.server_id;

    IF v_settings ->> 'action' = 'slowmode' THEN
        v_state := public.automod_apply_raid_lockdown(NEW.server_id, true, NULL);
    END IF;

    INSERT INTO public.automod_events (server_id, rule_name, rule_type, event_type, actions, details)
    VALUES (NEW.server_id, 'Raid detection', 'raid', 'raid',
            CASE WHEN v_state IS NOT NULL THEN ARRAY['alert', 'slowmode'] ELSE ARRAY['alert'] END,
            jsonb_build_object('joins', v_joins, 'window_seconds', v_window,
                               'lockdown', COALESCE(v_state, '{}'::jsonb)))
    RETURNING id INTO v_event;

    IF v_alert_channel IS NOT NULL THEN
        PERFORM public.automod_post_alert(
            v_alert_channel, v_event,
            format('AutoMod detected a possible raid: %s members joined within %s seconds.%s',
                   v_joins, v_window,
                   CASE WHEN v_state IS NOT NULL
                        THEN format(' Slowmode is now %s s on text channels; lift it from Server Settings > AutoMod.',
                                    v_state ->> 'slowmode_seconds')
                        ELSE ' Consider enabling slowmode or pausing invites from Server Settings > AutoMod.' END),
            jsonb_build_object('event_type', 'raid', 'rule_type', 'raid', 'rule_name', 'Raid detection',
                               'joins', v_joins, 'window_seconds', v_window,
                               'actions', CASE WHEN v_state IS NOT NULL THEN '["alert", "slowmode"]'::jsonb
                                               ELSE '["alert"]'::jsonb END));
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_automod_member_joined ON public.user_servers;
CREATE TRIGGER trg_automod_member_joined
    AFTER INSERT ON public.user_servers
    FOR EACH ROW
    WHEN (NEW.status = 'accepted')
    EXECUTE FUNCTION public.automod_member_joined();

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------

-- Caller's profile id when they hold p_permission on a local server; raises otherwise.
CREATE OR REPLACE FUNCTION public.automod_require(p_server_id uuid, p_permissions text[])
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_perm text;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.is_local_server) THEN
        RAISE EXCEPTION 'AutoMod is configured on the server''s home instance' USING ERRCODE = '42501';
    END IF;
    FOREACH v_perm IN ARRAY p_permissions LOOP
        IF public.has_permission(v_me, p_server_id, v_perm) THEN
            RETURN v_me;
        END IF;
    END LOOP;
    RAISE EXCEPTION 'Missing permission: %', array_to_string(p_permissions, ' or ') USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE FUNCTION public.automod_state(p_server_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'status', CASE WHEN st.server_id IS NULL THEN 'unconfigured'
                       WHEN st.enabled THEN 'enabled' ELSE 'disabled' END,
        'settings', CASE WHEN st.server_id IS NULL THEN NULL ELSE jsonb_build_object(
            'enabled', st.enabled,
            'alert_channel_id', st.alert_channel_id,
            'exempt_bots', st.exempt_bots,
            'raid_settings', st.raid_settings,
            'raid_state', st.raid_state,
            'last_raid_at', st.last_raid_at,
            'prompt_dismissed_at', st.prompt_dismissed_at,
            'updated_at', st.updated_at) END,
        'rules', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', r.id, 'name', r.name, 'rule_type', r.rule_type, 'enabled', r.enabled,
                       'config', r.config, 'actions', r.actions,
                       'exempt_role_ids', to_jsonb(r.exempt_role_ids),
                       'exempt_channel_ids', to_jsonb(r.exempt_channel_ids),
                       'position', r.position, 'updated_at', r.updated_at)
                   ORDER BY r.position, r.created_at)
              FROM public.server_automod_rules r WHERE r.server_id = p_server_id), '[]'::jsonb))
      FROM (SELECT p_server_id AS id) srv
      LEFT JOIN public.server_automod_settings st ON st.server_id = srv.id
$$;

CREATE OR REPLACE FUNCTION public.get_server_automod(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.automod_require(p_server_id, ARRAY['MANAGE_SERVER']);
    RETURN public.automod_state(p_server_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.enable_server_automod_preset(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.automod_require(p_server_id, ARRAY['MANAGE_SERVER']);
BEGIN
    PERFORM public.automod_install_preset(p_server_id, true, v_me);
    RETURN public.automod_state(p_server_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dismiss_server_automod_prompt(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.automod_require(p_server_id, ARRAY['MANAGE_SERVER']);
BEGIN
    INSERT INTO public.server_automod_settings (server_id, enabled, prompt_dismissed_at, updated_by)
    VALUES (p_server_id, false, now(), v_me)
    ON CONFLICT (server_id) DO UPDATE SET prompt_dismissed_at = now();
    RETURN public.automod_state(p_server_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_server_automod_settings(p_server_id uuid, p_settings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.automod_require(p_server_id, ARRAY['MANAGE_SERVER']);
    s jsonb := COALESCE(p_settings, '{}'::jsonb);
    v_alert uuid;
    v_raid jsonb;
    r jsonb;
BEGIN
    IF jsonb_typeof(s) <> 'object' THEN
        RAISE EXCEPTION 'AUTOMOD_INVALID_SETTINGS: settings must be an object' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.server_automod_settings (server_id, enabled, updated_by)
    VALUES (p_server_id, false, v_me)
    ON CONFLICT (server_id) DO NOTHING;

    IF s ? 'alert_channel_id' THEN
        v_alert := NULLIF(s ->> 'alert_channel_id', '')::uuid;
        IF v_alert IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.channels c WHERE c.id = v_alert AND c.server_id = p_server_id AND c.type = 0) THEN
            RAISE EXCEPTION 'AUTOMOD_INVALID_SETTINGS: the alert channel must be a text channel of this server'
                USING ERRCODE = '22023';
        END IF;
        UPDATE public.server_automod_settings SET alert_channel_id = v_alert WHERE server_id = p_server_id;
    END IF;

    IF s ? 'raid_settings' THEN
        r := s -> 'raid_settings';
        IF jsonb_typeof(r) <> 'object' THEN
            RAISE EXCEPTION 'AUTOMOD_INVALID_SETTINGS: raid_settings must be an object' USING ERRCODE = '22023';
        END IF;
        IF COALESCE(r ->> 'action', 'alert') NOT IN ('alert', 'slowmode') THEN
            RAISE EXCEPTION 'AUTOMOD_INVALID_SETTINGS: raid action is alert or slowmode' USING ERRCODE = '22023';
        END IF;
        v_raid := jsonb_build_object(
            'enabled', COALESCE((r ->> 'enabled')::boolean, true),
            'join_threshold', public.automod_int(r -> 'join_threshold', 10, 3, 1000),
            'window_seconds', public.automod_int(r -> 'window_seconds', 60, 10, 3600),
            'action', COALESCE(r ->> 'action', 'alert'),
            'slowmode_seconds', public.automod_int(r -> 'slowmode_seconds', 30, 5, 21600));
        UPDATE public.server_automod_settings SET raid_settings = v_raid WHERE server_id = p_server_id;
    END IF;

    UPDATE public.server_automod_settings
       SET enabled = COALESCE((s ->> 'enabled')::boolean, enabled),
           exempt_bots = COALESCE((s ->> 'exempt_bots')::boolean, exempt_bots),
           updated_at = now(),
           updated_by = v_me
     WHERE server_id = p_server_id;

    RETURN public.automod_state(p_server_id);
EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'AUTOMOD_INVALID_SETTINGS: malformed value' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_server_automod_rule(p_server_id uuid, p_rule jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.automod_require(p_server_id, ARRAY['MANAGE_SERVER']);
    v_id uuid := NULLIF(p_rule ->> 'id', '')::uuid;
    v_type text := p_rule ->> 'rule_type';
    v_name text := btrim(COALESCE(p_rule ->> 'name', ''));
    v_config jsonb;
    v_actions jsonb;
    v_roles uuid[];
    v_channels uuid[];
    v_compiled jsonb;
    v_existing_type text;
BEGIN
    IF jsonb_typeof(p_rule) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: rule must be an object' USING ERRCODE = '22023';
    END IF;

    IF v_id IS NOT NULL THEN
        SELECT r.rule_type INTO v_existing_type
          FROM public.server_automod_rules r
         WHERE r.id = v_id AND r.server_id = p_server_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: no such rule in this server' USING ERRCODE = '22023';
        END IF;
        v_type := COALESCE(v_type, v_existing_type);
        IF v_type <> v_existing_type THEN
            RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: a rule''s type cannot change' USING ERRCODE = '22023';
        END IF;
    ELSE
        IF (SELECT count(*) FROM public.server_automod_rules WHERE server_id = p_server_id) >= 25 THEN
            RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: at most 25 rules per server' USING ERRCODE = '22023';
        END IF;
    END IF;

    IF char_length(v_name) NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: name must be 1 to 100 characters' USING ERRCODE = '22023';
    END IF;

    v_config := public.automod_canonical_config(v_type, p_rule -> 'config');
    v_actions := public.automod_canonical_actions(p_rule -> 'actions');
    v_compiled := public.automod_compile_rule(v_type, v_config);
    IF (v_compiled ? 'pattern' AND NOT public.automod_regex_compiles(v_compiled ->> 'pattern'))
       OR (v_compiled ? 'allow' AND NOT public.automod_regex_compiles(v_compiled ->> 'allow')) THEN
        RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: the keyword list is too large to compile' USING ERRCODE = '22023';
    END IF;

    v_roles := ARRAY(SELECT DISTINCT x::uuid FROM unnest(public.automod_text_array(p_rule -> 'exempt_role_ids')) x);
    v_channels := ARRAY(SELECT DISTINCT x::uuid FROM unnest(public.automod_text_array(p_rule -> 'exempt_channel_ids')) x);
    IF EXISTS (SELECT 1 FROM unnest(v_roles) x
                WHERE NOT EXISTS (SELECT 1 FROM public.server_roles sr WHERE sr.id = x AND sr.server_id = p_server_id)) THEN
        RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: exempt roles must belong to this server' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_channels) x
                WHERE NOT EXISTS (SELECT 1 FROM public.channels c WHERE c.id = x AND c.server_id = p_server_id)
                  AND NOT EXISTS (SELECT 1 FROM public.channel_categories cc WHERE cc.id = x AND cc.server_id = p_server_id)) THEN
        RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: exempt channels must belong to this server' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.server_automod_settings (server_id, enabled, updated_by)
    VALUES (p_server_id, false, v_me)
    ON CONFLICT (server_id) DO NOTHING;

    IF v_id IS NULL THEN
        INSERT INTO public.server_automod_rules (
            server_id, name, rule_type, enabled, config, actions, exempt_role_ids, exempt_channel_ids,
            position, created_by)
        VALUES (
            p_server_id, v_name, v_type, COALESCE((p_rule ->> 'enabled')::boolean, true), v_config, v_actions,
            v_roles, v_channels,
            COALESCE((p_rule ->> 'position')::integer,
                     (SELECT COALESCE(max(position), -1) + 1 FROM public.server_automod_rules WHERE server_id = p_server_id)),
            v_me)
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.server_automod_rules
           SET name = v_name,
               enabled = COALESCE((p_rule ->> 'enabled')::boolean, enabled),
               config = v_config,
               actions = v_actions,
               exempt_role_ids = v_roles,
               exempt_channel_ids = v_channels,
               position = COALESCE((p_rule ->> 'position')::integer, position),
               updated_at = now()
         WHERE id = v_id;
    END IF;

    UPDATE public.server_automod_settings SET updated_at = now(), updated_by = v_me WHERE server_id = p_server_id;
    RETURN public.automod_state(p_server_id);
EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: malformed value' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_server_automod_rule(p_rule_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
BEGIN
    SELECT r.server_id INTO v_server FROM public.server_automod_rules r WHERE r.id = p_rule_id;
    IF v_server IS NULL THEN
        RAISE EXCEPTION 'AUTOMOD_INVALID_RULE: no such rule' USING ERRCODE = '22023';
    END IF;
    PERFORM public.automod_require(v_server, ARRAY['MANAGE_SERVER']);
    DELETE FROM public.server_automod_rules WHERE id = p_rule_id;
    RETURN public.automod_state(v_server);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_server_automod_events(
    p_server_id uuid, p_limit integer DEFAULT 50, p_before timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.automod_require(p_server_id, ARRAY['MANAGE_SERVER', 'VIEW_AUDIT_LOG']);
    RETURN COALESCE((
        SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.last_hit_at DESC)
          FROM (SELECT e.id, e.event_type, e.rule_id, e.rule_name, e.rule_type, e.actions, e.matched,
                       e.content_excerpt, e.details, e.hits, e.created_at, e.last_hit_at,
                       e.channel_id, c.name AS channel_name,
                       e.user_id, p.username, p.display_name, p.avatar_url, p.domain, p.is_local,
                       e.bot_id, COALESCE(b.display_name, b.username) AS bot_name,
                       t.until AS timeout_until
                  FROM public.automod_events e
                  LEFT JOIN public.channels c ON c.id = e.channel_id
                  LEFT JOIN public.profiles p ON p.id = e.user_id
                  LEFT JOIN public.bots b ON b.id = e.bot_id
                  LEFT JOIN public.server_member_timeouts t
                         ON t.server_id = e.server_id AND t.user_id = e.user_id AND t.until > now()
                 WHERE e.server_id = p_server_id
                   AND (p_before IS NULL OR e.last_hit_at < p_before)
                 ORDER BY e.last_hit_at DESC
                 LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) x), '[]'::jsonb);
END;
$$;

-- The caller's most recent blocked message in a channel, for the composer's notice.
CREATE OR REPLACE FUNCTION public.get_automod_block_notice(p_channel_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
               'rule_type', e.rule_type,
               'rule_name', e.rule_name,
               'event_type', e.event_type,
               'message', r.actions ->> 'block_message',
               'timeout_until', (SELECT t.until FROM public.server_member_timeouts t
                                  WHERE t.server_id = e.server_id AND t.user_id = e.user_id AND t.until > now()),
               'at', e.last_hit_at)
      FROM public.automod_events e
      LEFT JOIN public.server_automod_rules r ON r.id = e.rule_id
     WHERE e.user_id = public.get_current_profile_id()
       AND e.last_hit_at > now() - interval '60 seconds'
       AND e.channel_id = p_channel_id
       AND 'block' = ANY (e.actions)
     ORDER BY e.last_hit_at DESC
     LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.set_server_member_timeout(
    p_server_id uuid, p_user_id uuid, p_seconds integer, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.automod_require(p_server_id, ARRAY['TIMEOUT_MEMBERS']);
    v_until timestamptz;
BEGIN
    IF p_user_id = v_me THEN
        RAISE EXCEPTION 'You cannot time yourself out' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = p_user_id)
       OR public.has_permission(p_user_id, p_server_id, 'ADMINISTRATOR') THEN
        RAISE EXCEPTION 'The server owner and administrators cannot be timed out' USING ERRCODE = '42501';
    END IF;
    IF p_seconds IS NULL OR p_seconds < 0 OR p_seconds > 2419200 THEN
        RAISE EXCEPTION 'Timeouts last from 0 seconds to 28 days' USING ERRCODE = '22023';
    END IF;

    IF p_seconds = 0 THEN
        DELETE FROM public.server_member_timeouts WHERE server_id = p_server_id AND user_id = p_user_id;
        RETURN jsonb_build_object('user_id', p_user_id, 'until', NULL);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = p_user_id AND us.status = 'accepted') THEN
        RAISE EXCEPTION 'Not a member of this server' USING ERRCODE = '22023';
    END IF;

    v_until := now() + make_interval(secs => p_seconds);
    INSERT INTO public.server_member_timeouts (server_id, user_id, until, reason, source, created_by)
    VALUES (p_server_id, p_user_id, v_until, left(NULLIF(btrim(p_reason), ''), 512), 'moderator', v_me)
    ON CONFLICT (server_id, user_id) DO UPDATE
       SET until = EXCLUDED.until, reason = EXCLUDED.reason, source = EXCLUDED.source,
           created_by = EXCLUDED.created_by, created_at = now();
    RETURN jsonb_build_object('user_id', p_user_id, 'until', v_until);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_server_member_timeouts(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.automod_require(p_server_id, ARRAY['TIMEOUT_MEMBERS', 'MANAGE_SERVER']);
    RETURN COALESCE((
        SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.until)
          FROM (SELECT t.user_id, t.until, t.reason, t.source, t.created_at, t.created_by,
                       p.username, p.display_name, p.avatar_url, p.domain, p.is_local
                  FROM public.server_member_timeouts t
                  JOIN public.profiles p ON p.id = t.user_id
                 WHERE t.server_id = p_server_id AND t.until > now()) x), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_server_raid_lockdown(p_server_id uuid, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.automod_require(p_server_id, ARRAY['MANAGE_SERVER']);
BEGIN
    INSERT INTO public.server_automod_settings (server_id, enabled, updated_by)
    VALUES (p_server_id, false, v_me)
    ON CONFLICT (server_id) DO NOTHING;
    PERFORM public.automod_apply_raid_lockdown(p_server_id, COALESCE(p_active, false), v_me);
    RETURN public.automod_state(p_server_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Instance anti-spam
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.antispam_settings()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT '{"new_account_hours": 24, "new_account_messages_per_minute": 0, "new_account_posts_per_hour": 0,
             "new_account_max_stranger_mentions": 0, "new_account_block_links": false,
             "federation_spam_mode": "flag", "federation_max_mentions": 15, "federation_new_actor_days": 7}'::jsonb
           || COALESCE((SELECT ic.config_value FROM public.instance_config ic
                         WHERE ic.config_key = 'antispam' AND jsonb_typeof(ic.config_value) = 'object'),
                       '{}'::jsonb)
$$;

-- Integer from a hand-edited config value; anything but a number reads as p_default.
CREATE OR REPLACE FUNCTION public.antispam_int(p_value jsonb, p_default integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN jsonb_typeof(p_value) = 'number'
                     AND (p_value::text)::numeric BETWEEN -2147483648 AND 2147483647
                THEN round((p_value::text)::numeric)::integer
                ELSE p_default END
$$;

-- Limits for local accounts younger than new_account_hours. Raises ANTISPAM_* on a
-- breach. Returns true when a rate limit applies to the author, so the caller records
-- the accepted write in automod_recent_activity; false when every limit is off or the
-- author is remote, established, or an instance admin or moderator.
DROP FUNCTION IF EXISTS public.antispam_check_local_author(uuid, text, jsonb, text);
CREATE FUNCTION public.antispam_check_local_author(
    p_author uuid, p_kind text, p_content jsonb, p_op text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cfg jsonb;
    v_rate integer;
    v_stranger integer;
    v_links boolean;
    v_hours integer;
    v_created timestamptz;
    v_local boolean;
    v_staff boolean;
    v_count integer;
    v_oldest timestamptz;
    v_text text;
    v_urls text[];
BEGIN
    SELECT ic.config_value INTO v_cfg FROM public.instance_config ic WHERE ic.config_key = 'antispam';
    IF v_cfg IS NULL OR jsonb_typeof(v_cfg) <> 'object' THEN
        RETURN false;
    END IF;

    v_rate := public.antispam_int(v_cfg -> CASE WHEN p_kind = 'post' THEN 'new_account_posts_per_hour'
                                                ELSE 'new_account_messages_per_minute' END, 0);
    v_stranger := CASE WHEN p_kind = 'post'
                       THEN public.antispam_int(v_cfg -> 'new_account_max_stranger_mentions', 0) ELSE 0 END;
    v_links := jsonb_typeof(v_cfg -> 'new_account_block_links') = 'boolean'
               AND (v_cfg ->> 'new_account_block_links')::boolean;
    IF v_rate <= 0 AND v_stranger <= 0 AND NOT v_links THEN
        RETURN false;
    END IF;

    v_hours := GREATEST(public.antispam_int(v_cfg -> 'new_account_hours', 24), 1);
    SELECT p.created_at, p.is_local, COALESCE(p.is_admin, false) OR COALESCE(p.is_moderator, false)
      INTO v_created, v_local, v_staff
      FROM public.profiles p WHERE p.id = p_author;
    IF v_local IS NOT TRUE OR v_staff OR v_created <= now() - make_interval(hours => v_hours) THEN
        RETURN false;
    END IF;

    IF p_op = 'INSERT' AND v_rate > 0 THEN
        IF p_kind = 'post' THEN
            SELECT count(*), min(x.created_at) INTO v_count, v_oldest
              FROM (SELECT ra.created_at FROM public.automod_recent_activity ra
                     WHERE ra.user_id = p_author AND ra.created_at > now() - interval '1 hour' AND ra.kind = 'post'
                     ORDER BY ra.created_at DESC LIMIT v_rate) x;
            IF v_count >= v_rate THEN
                RAISE EXCEPTION 'ANTISPAM_RATE_LIMITED:%',
                    GREATEST(1, ceil(extract(epoch FROM (v_oldest + interval '1 hour' - now()))))::integer
                    USING ERRCODE = 'P0001', HINT = 'New accounts can post a limited number of times per hour.';
            END IF;
        ELSE
            SELECT count(*), min(x.created_at) INTO v_count, v_oldest
              FROM (SELECT ra.created_at FROM public.automod_recent_activity ra
                     WHERE ra.user_id = p_author AND ra.created_at > now() - interval '1 minute' AND ra.kind = 'message'
                     ORDER BY ra.created_at DESC LIMIT v_rate) x;
            IF v_count >= v_rate THEN
                RAISE EXCEPTION 'ANTISPAM_RATE_LIMITED:%',
                    GREATEST(1, ceil(extract(epoch FROM (v_oldest + interval '1 minute' - now()))))::integer
                    USING ERRCODE = 'P0001', HINT = 'New accounts can send a limited number of messages per minute.';
            END IF;
        END IF;
    END IF;

    IF v_links THEN
        SELECT string_agg(e ->> 'text', E'\n') FILTER (WHERE e ->> 'type' = 'text'),
               array_agg(e ->> 'url') FILTER (WHERE e ->> 'type' IN ('url', 'embed') AND e ->> 'url' IS NOT NULL)
          INTO v_text, v_urls
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_content) = 'array' THEN p_content ELSE '[]'::jsonb END) e;
        IF (v_text IS NOT NULL OR v_urls IS NOT NULL)
           AND cardinality(public.automod_link_hosts(v_text, v_urls)) > 0 THEN
            RAISE EXCEPTION 'ANTISPAM_LINKS_BLOCKED'
                USING ERRCODE = 'P0001', HINT = format('Accounts younger than %s hours cannot post links.', v_hours);
        END IF;
    END IF;

    IF v_stranger > 0 THEN
        SELECT count(DISTINCT target.id) INTO v_count
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_content) = 'array' THEN p_content ELSE '[]'::jsonb END) e
          JOIN LATERAL (
              SELECT p.id FROM public.profiles p
               WHERE (e ->> 'userId' IS NOT NULL AND p.id::text = e ->> 'userId')
                  OR (e ->> 'userId' IS NULL AND p.username = e ->> 'username'
                      AND p.domain = COALESCE(NULLIF(e ->> 'domain', ''), p.domain))
               LIMIT 1) target ON true
         WHERE e ->> 'type' = 'mention'
           AND target.id <> p_author
           AND NOT EXISTS (SELECT 1 FROM public.follows f
                            WHERE f.follower_id = target.id AND f.following_id = p_author AND f.status = 'accepted');
        IF v_count > v_stranger THEN
            RAISE EXCEPTION 'ANTISPAM_STRANGER_MENTIONS:%', v_stranger
                USING ERRCODE = 'P0001',
                      HINT = format('New accounts can mention at most %s people who do not follow them.', v_stranger);
        END IF;
    END IF;
    RETURN v_rate > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.antispam_post_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content THEN
        RETURN NEW;
    END IF;
    IF NEW.reblog IS NULL
       AND public.antispam_check_local_author(NEW.author_id, 'post', NEW.content, TG_OP)
       AND TG_OP = 'INSERT' THEN
        INSERT INTO public.automod_recent_activity (user_id, kind) VALUES (NEW.author_id, 'post');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_antispam_post_guard ON public.posts;
CREATE TRIGGER trg_antispam_post_guard
    BEFORE INSERT OR UPDATE OF content ON public.posts
    FOR EACH ROW EXECUTE FUNCTION public.antispam_post_guard();

CREATE OR REPLACE FUNCTION public.get_instance_antispam_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Admin role required' USING ERRCODE = '42501';
    END IF;
    RETURN public.antispam_settings();
END;
$$;

CREATE OR REPLACE FUNCTION public.update_instance_antispam_settings(p_settings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    s jsonb := public.antispam_settings() || COALESCE(p_settings, '{}'::jsonb);
    v jsonb;
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Admin role required' USING ERRCODE = '42501';
    END IF;
    IF jsonb_typeof(COALESCE(p_settings, '{}'::jsonb)) <> 'object' THEN
        RAISE EXCEPTION 'ANTISPAM_INVALID_SETTINGS: settings must be an object' USING ERRCODE = '22023';
    END IF;
    IF s ->> 'federation_spam_mode' NOT IN ('off', 'flag', 'hold', 'reject') THEN
        RAISE EXCEPTION 'ANTISPAM_INVALID_SETTINGS: federation_spam_mode is off, flag, hold or reject' USING ERRCODE = '22023';
    END IF;

    v := jsonb_build_object(
        'new_account_hours', public.automod_int(s -> 'new_account_hours', 24, 1, 8760),
        'new_account_messages_per_minute', public.automod_int(s -> 'new_account_messages_per_minute', 0, 0, 600),
        'new_account_posts_per_hour', public.automod_int(s -> 'new_account_posts_per_hour', 0, 0, 1000),
        'new_account_max_stranger_mentions', public.automod_int(s -> 'new_account_max_stranger_mentions', 0, 0, 100),
        'new_account_block_links', COALESCE((s ->> 'new_account_block_links')::boolean, false),
        'federation_spam_mode', s ->> 'federation_spam_mode',
        'federation_max_mentions', public.automod_int(s -> 'federation_max_mentions', 15, 2, 500),
        'federation_new_actor_days', public.automod_int(s -> 'federation_new_actor_days', 7, 0, 365));

    INSERT INTO public.instance_config (config_key, config_value, description, updated_at, updated_by)
    VALUES ('antispam', v, 'Instance anti-spam limits. 0/false disables a limit.', now(), public.get_current_profile_id())
    ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value, updated_at = now(), updated_by = EXCLUDED.updated_by;

    PERFORM public.log_admin_action(public.get_current_profile_id(), 'update_antispam_settings',
                                    'instance_config', 'antispam', v, NULL, NULL);
    RETURN v;
EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'ANTISPAM_INVALID_SETTINGS: malformed value' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.get_suspicious_activity(
    p_status text DEFAULT 'open', p_limit integer DEFAULT 50, p_before timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT (public.is_current_user_admin() OR public.is_current_user_moderator()) THEN
        RAISE EXCEPTION 'Admin or moderator role required' USING ERRCODE = '42501';
    END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.created_at DESC)
          FROM (SELECT sa.id, sa.created_at, sa.kind, sa.status, sa.action, sa.actor_id, sa.actor_uri,
                       sa.actor_domain, sa.target_ids, sa.reasons, sa.activity_id, sa.summary,
                       sa.reviewed_by, sa.reviewed_at, sa.review_note,
                       sa.activity IS NOT NULL AS has_activity,
                       p.username AS actor_username, p.display_name AS actor_display_name,
                       p.avatar_url AS actor_avatar_url, p.is_suspended AS actor_suspended,
                       (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', tp.id, 'username', tp.username)), '[]'::jsonb)
                          FROM public.profiles tp WHERE tp.id = ANY (sa.target_ids)) AS targets
                  FROM public.suspicious_activity sa
                  LEFT JOIN public.profiles p ON p.id = sa.actor_id
                 WHERE (p_status IS NULL OR p_status = 'all' OR sa.status = p_status)
                   AND (p_before IS NULL OR sa.created_at < p_before)
                 ORDER BY sa.created_at DESC
                 LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) x), '[]'::jsonb);
END;
$$;

-- dismiss: no action. confirm: keep the verdict. release: deliver a held activity
-- (federation-backend job 'release-held-activity' reprocesses it without the spam check).
CREATE OR REPLACE FUNCTION public.review_suspicious_activity(p_id uuid, p_decision text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_row public.suspicious_activity%ROWTYPE;
BEGIN
    IF NOT (public.is_current_user_admin() OR public.is_current_user_moderator()) THEN
        RAISE EXCEPTION 'Admin or moderator role required' USING ERRCODE = '42501';
    END IF;
    IF p_decision NOT IN ('dismiss', 'confirm', 'release') THEN
        RAISE EXCEPTION 'Decision is dismiss, confirm or release' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_row FROM public.suspicious_activity WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No such entry' USING ERRCODE = '22023';
    END IF;
    IF p_decision = 'release' AND (v_row.action <> 'held' OR v_row.activity IS NULL OR v_row.status = 'released') THEN
        RAISE EXCEPTION 'Only held activities can be released, once' USING ERRCODE = '22023';
    END IF;

    UPDATE public.suspicious_activity
       SET status = CASE p_decision WHEN 'dismiss' THEN 'dismissed' WHEN 'confirm' THEN 'confirmed' ELSE 'released' END,
           reviewed_by = v_me,
           reviewed_at = now(),
           review_note = left(NULLIF(btrim(p_note), ''), 500)
     WHERE id = p_id
    RETURNING * INTO v_row;

    IF p_decision = 'release' THEN
        PERFORM public.queue_federation_job('release-held-activity',
                                            jsonb_build_object('type', 'create', 'suspicious_activity_id', p_id));
    END IF;

    PERFORM public.log_admin_action(v_me, 'review_suspicious_activity', 'suspicious_activity', p_id::text,
                                    jsonb_build_object('decision', p_decision), NULL, NULL);
    RETURN jsonb_build_object('id', v_row.id, 'status', v_row.status, 'reviewed_at', v_row.reviewed_at);
END;
$$;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------

-- Recent activity outlives the longest rule window (3600 s); events are kept 90 days;
-- reviewed suspicious activity 180 days; expired timeouts 7 days.
CREATE OR REPLACE FUNCTION public.automod_purge()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    DELETE FROM public.automod_recent_activity WHERE created_at < now() - interval '1 hour';
    DELETE FROM public.automod_events WHERE last_hit_at < now() - interval '90 days';
    DELETE FROM public.server_member_timeouts WHERE until < now() - interval '7 days';
    DELETE FROM public.suspicious_activity
     WHERE status <> 'open' AND reviewed_at < now() - interval '180 days';
END;
$$;

DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN PERFORM cron.unschedule('purge-automod'); EXCEPTION WHEN OTHERS THEN NULL; END;
        PERFORM cron.schedule('purge-automod', '*/10 * * * *', 'SELECT public.automod_purge()');
        RAISE NOTICE 'purge-automod scheduled';
    ELSE
        RAISE NOTICE 'pg_cron not available; automod_purge() is not scheduled';
    END IF;
END
$do$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    -- Internal: triggers, helpers and definer bodies. No client EXECUTE.
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('automod_normalize', 'automod_message_text', 'automod_keyword_regex',
                             'automod_preset_terms', 'automod_regex_compiles', 'automod_text_array',
                             'automod_int', 'automod_canonical_config', 'automod_canonical_actions',
                             'automod_compile_rule', 'automod_recompile_server', 'automod_rules_changed',
                             'automod_settings_changed', 'automod_install_preset', 'automod_server_created',
                             'automod_link_hosts', 'automod_foreign_invite', 'automod_purge',
                             'automod_singular_request', 'automod_post_alert', 'automod_record_match',
                             'automod_message_guard', 'automod_apply_raid_lockdown', 'automod_member_joined',
                             'automod_require', 'automod_state', 'antispam_settings', 'antispam_int',
                             'antispam_check_local_author', 'antispam_post_guard')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;

    -- Called by the invoker trigger as the writing role; refuses at trigger depth 0.
    -- Client RPCs: each checks the caller itself.
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('automod_check_message',
                             'get_server_automod', 'enable_server_automod_preset',
                             'dismiss_server_automod_prompt', 'update_server_automod_settings',
                             'upsert_server_automod_rule', 'delete_server_automod_rule',
                             'get_server_automod_events', 'get_automod_block_notice',
                             'set_server_member_timeout', 'get_server_member_timeouts',
                             'set_server_raid_lockdown', 'get_instance_antispam_settings',
                             'update_instance_antispam_settings', 'get_suspicious_activity',
                             'review_suspicious_activity')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['authenticated', 'postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
