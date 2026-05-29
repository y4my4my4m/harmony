-- =============================================================================
-- Migration: User-input text hardening (servers/channels/roles/threads/etc.)
-- =============================================================================
-- Extends the profile text hardening (20260530_profile_text_hardening.sql) to
-- ALL user-writable text fields. RLS lets any token-holder INSERT/UPDATE their
-- own rows via the REST API, and SECURITY DEFINER RPCs (create_thread,
-- update_group_name, ban/kick, emoji reactions) also write these tables.
--
-- BEFORE INSERT/UPDATE triggers fire on every write path, so they are the
-- authoritative guard against over-long, blank, or spoofing (bidi-override,
-- zero-width, control char) text submitted past the UI. CHECK constraints are
-- length backstops.
--
-- Depends on public.sanitize_profile_string() (created by the profile
-- hardening migration / 11_functions_triggers.sql). It is re-created here so
-- this migration is self-contained and order-independent.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Ensure the shared sanitizer exists (idempotent; matches profile migration)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sanitize_profile_string(
    p_input text,
    p_max integer,
    p_allow_newlines boolean DEFAULT false
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_input IS NULL THEN NULL
        ELSE left(
            btrim(
                regexp_replace(
                    normalize(p_input, NFC),
                    CASE WHEN p_allow_newlines
                        THEN U&'[\0001-\0008\000B-\001F\007F-\009F\200B-\200F\202A-\202E\2060-\206F\FEFF]'
                        ELSE U&'[\0001-\001F\007F-\009F\200B-\200F\202A-\202E\2060-\206F\FEFF]'
                    END,
                    '',
                    'g'
                )
            ),
            p_max
        )
    END;
$$;

-- ---------------------------------------------------------------------------
-- 1. Sanitize trigger functions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sanitize_entity_name()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_max int := COALESCE(NULLIF(TG_ARGV[0], '')::int, 100);
    v_required boolean := (TG_ARGV[1] = 'required');
    v_clean text;
BEGIN
    v_clean := public.sanitize_profile_string(NEW.name, v_max, false);
    IF COALESCE(v_clean, '') = '' THEN
        IF v_required THEN
            IF TG_OP = 'INSERT' OR COALESCE(OLD.name, '') <> '' THEN
                RAISE EXCEPTION '% name must not be blank', TG_TABLE_NAME
                    USING ERRCODE = 'check_violation';
            END IF;
            NEW.name := COALESCE(v_clean, '');
        ELSE
            NEW.name := NULLIF(v_clean, '');
        END IF;
    ELSE
        NEW.name := v_clean;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_server_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_name text := public.sanitize_profile_string(NEW.name, 100, false);
BEGIN
    IF COALESCE(v_name, '') = '' THEN
        IF TG_OP = 'INSERT' OR COALESCE(OLD.name, '') <> '' THEN
            RAISE EXCEPTION 'server name must not be blank' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    NEW.name := COALESCE(v_name, '');
    IF NEW.description IS NOT NULL THEN
        NEW.description := NULLIF(public.sanitize_profile_string(NEW.description, 500, true), '');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_channel_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_name text := public.sanitize_profile_string(NEW.name, 100, false);
BEGIN
    IF COALESCE(v_name, '') = '' THEN
        IF TG_OP = 'INSERT' OR COALESCE(OLD.name, '') <> '' THEN
            RAISE EXCEPTION 'channel name must not be blank' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    NEW.name := COALESCE(v_name, '');
    IF NEW.description IS NOT NULL THEN
        NEW.description := NULLIF(public.sanitize_profile_string(NEW.description, 1024, true), '');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_bot_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.display_name IS NOT NULL THEN
        NEW.display_name := NULLIF(public.sanitize_profile_string(NEW.display_name, 100, false), '');
    END IF;
    IF NEW.bio IS NOT NULL THEN
        NEW.bio := NULLIF(public.sanitize_profile_string(NEW.bio, 500, true), '');
    END IF;
    IF NEW.website_url IS NOT NULL THEN
        NEW.website_url := NULLIF(public.sanitize_profile_string(NEW.website_url, 512, false), '');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_report_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.reason IS NOT NULL THEN
        NEW.reason := public.sanitize_profile_string(NEW.reason, 200, false);
    END IF;
    IF NEW.comment IS NOT NULL THEN
        NEW.comment := NULLIF(public.sanitize_profile_string(NEW.comment, 1000, true), '');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_user_list_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_title text := public.sanitize_profile_string(NEW.title, 100, false);
BEGIN
    IF COALESCE(v_title, '') = '' THEN
        IF TG_OP = 'INSERT' OR COALESCE(OLD.title, '') <> '' THEN
            RAISE EXCEPTION 'list title must not be blank' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    NEW.title := COALESCE(v_title, '');
    IF NEW.description IS NOT NULL THEN
        NEW.description := NULLIF(public.sanitize_profile_string(NEW.description, 500, true), '');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_member_nickname()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.nickname IS NOT NULL THEN
        NEW.nickname := NULLIF(public.sanitize_profile_string(NEW.nickname, 64, false), '');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_post_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.content_warning IS NOT NULL THEN
        NEW.content_warning := NULLIF(public.sanitize_profile_string(NEW.content_warning, 200, false), '');
    END IF;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Triggers (cover direct REST writes AND SECURITY DEFINER RPC writes)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS sanitize_server_text_trigger ON public.servers;
CREATE TRIGGER sanitize_server_text_trigger
    BEFORE INSERT OR UPDATE ON public.servers
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_server_text();

DROP TRIGGER IF EXISTS sanitize_channel_text_trigger ON public.channels;
CREATE TRIGGER sanitize_channel_text_trigger
    BEFORE INSERT OR UPDATE ON public.channels
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_channel_text();

DROP TRIGGER IF EXISTS sanitize_category_name_trigger ON public.channel_categories;
CREATE TRIGGER sanitize_category_name_trigger
    BEFORE INSERT OR UPDATE ON public.channel_categories
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_entity_name('100', 'required');

DROP TRIGGER IF EXISTS sanitize_role_name_trigger ON public.server_roles;
CREATE TRIGGER sanitize_role_name_trigger
    BEFORE INSERT OR UPDATE ON public.server_roles
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_entity_name('100', 'required');

DROP TRIGGER IF EXISTS sanitize_thread_name_trigger ON public.threads;
CREATE TRIGGER sanitize_thread_name_trigger
    BEFORE INSERT OR UPDATE ON public.threads
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_entity_name('100', 'required');

DROP TRIGGER IF EXISTS sanitize_conversation_name_trigger ON public.conversations;
CREATE TRIGGER sanitize_conversation_name_trigger
    BEFORE INSERT OR UPDATE ON public.conversations
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_entity_name('100', 'optional');

DROP TRIGGER IF EXISTS sanitize_server_folder_name_trigger ON public.server_folders;
CREATE TRIGGER sanitize_server_folder_name_trigger
    BEFORE INSERT OR UPDATE ON public.server_folders
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_entity_name('64', 'optional');

DROP TRIGGER IF EXISTS sanitize_emoji_name_trigger ON public.emojis;
CREATE TRIGGER sanitize_emoji_name_trigger
    BEFORE INSERT OR UPDATE ON public.emojis
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_entity_name('64', 'optional');

DROP TRIGGER IF EXISTS sanitize_bot_text_trigger ON public.bots;
CREATE TRIGGER sanitize_bot_text_trigger
    BEFORE INSERT OR UPDATE ON public.bots
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_bot_text();

DROP TRIGGER IF EXISTS sanitize_report_text_trigger ON public.reports;
CREATE TRIGGER sanitize_report_text_trigger
    BEFORE INSERT OR UPDATE ON public.reports
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_report_text();

DROP TRIGGER IF EXISTS sanitize_user_list_text_trigger ON public.user_lists;
CREATE TRIGGER sanitize_user_list_text_trigger
    BEFORE INSERT OR UPDATE ON public.user_lists
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_user_list_text();

-- user_servers.nickname is a forward-looking column: it exists in db_schema/init
-- (fresh deploys / planned per-server nickname feature) but was never shipped to
-- existing deployments via migration, so it may be absent here. Guard the whole
-- nickname hardening (trigger + cleanup + constraint) on column existence so this
-- migration runs cleanly regardless of drift. PL/pgSQL defers planning of the
-- branch body until executed, so the nickname references don't error when absent.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'user_servers'
          AND column_name = 'nickname'
    ) THEN
        DROP TRIGGER IF EXISTS sanitize_member_nickname_trigger ON public.user_servers;
        CREATE TRIGGER sanitize_member_nickname_trigger
            BEFORE INSERT OR UPDATE ON public.user_servers
            FOR EACH ROW EXECUTE FUNCTION public.sanitize_member_nickname();

        UPDATE public.user_servers SET nickname = NULLIF(public.sanitize_profile_string(nickname, 64, false), '')
            WHERE nickname IS NOT NULL AND char_length(nickname) > 64;

        ALTER TABLE public.user_servers DROP CONSTRAINT IF EXISTS user_servers_nickname_length_check;
        ALTER TABLE public.user_servers ADD CONSTRAINT user_servers_nickname_length_check
            CHECK (nickname IS NULL OR char_length(nickname) <= 64);
    ELSE
        RAISE NOTICE 'Skipping user_servers.nickname hardening: column not present in this deployment.';
    END IF;
END $$;

DROP TRIGGER IF EXISTS sanitize_post_text_trigger ON public.posts;
CREATE TRIGGER sanitize_post_text_trigger
    BEFORE INSERT OR UPDATE ON public.posts
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_post_text();

-- ---------------------------------------------------------------------------
-- 3. Clean existing over-length rows so the length backstops can attach.
--    Only too-long rows are touched (char_length > cap), so blank required
--    names are left untouched and no table-wide rewrite occurs.
-- ---------------------------------------------------------------------------
UPDATE public.servers SET name = public.sanitize_profile_string(name, 100, false)
    WHERE char_length(name) > 100;
UPDATE public.servers SET description = public.sanitize_profile_string(description, 500, true)
    WHERE description IS NOT NULL AND char_length(description) > 500;

UPDATE public.channels SET name = public.sanitize_profile_string(name, 100, false)
    WHERE char_length(name) > 100;
UPDATE public.channels SET description = public.sanitize_profile_string(description, 1024, true)
    WHERE description IS NOT NULL AND char_length(description) > 1024;

UPDATE public.channel_categories SET name = public.sanitize_profile_string(name, 100, false)
    WHERE char_length(name) > 100;

UPDATE public.server_roles SET name = public.sanitize_profile_string(name, 100, false)
    WHERE char_length(name) > 100;

UPDATE public.threads SET name = public.sanitize_profile_string(name, 100, false)
    WHERE char_length(name) > 100;

UPDATE public.conversations SET name = public.sanitize_profile_string(name, 100, false)
    WHERE name IS NOT NULL AND char_length(name) > 100;

UPDATE public.server_folders SET name = public.sanitize_profile_string(name, 64, false)
    WHERE char_length(name) > 64;

UPDATE public.emojis SET name = public.sanitize_profile_string(name::text, 64, false)
    WHERE name IS NOT NULL AND char_length(name::text) > 64;

-- NOTE: user_servers.nickname cleanup is handled in the column-existence guard
-- above (section 2), since the column may not exist in this deployment.

UPDATE public.bots SET display_name = NULLIF(public.sanitize_profile_string(display_name, 100, false), '')
    WHERE display_name IS NOT NULL AND char_length(display_name) > 100;
UPDATE public.bots SET bio = NULLIF(public.sanitize_profile_string(bio, 500, true), '')
    WHERE bio IS NOT NULL AND char_length(bio) > 500;
UPDATE public.bots SET website_url = NULLIF(public.sanitize_profile_string(website_url, 512, false), '')
    WHERE website_url IS NOT NULL AND char_length(website_url) > 512;

UPDATE public.reports SET reason = public.sanitize_profile_string(reason, 200, false)
    WHERE char_length(reason) > 200;
UPDATE public.reports SET comment = NULLIF(public.sanitize_profile_string(comment, 1000, true), '')
    WHERE comment IS NOT NULL AND char_length(comment) > 1000;

UPDATE public.user_lists SET title = public.sanitize_profile_string(title, 100, false)
    WHERE char_length(title) > 100;
UPDATE public.user_lists SET description = NULLIF(public.sanitize_profile_string(description, 500, true), '')
    WHERE description IS NOT NULL AND char_length(description) > 500;

UPDATE public.posts SET content_warning = NULLIF(public.sanitize_profile_string(content_warning, 200, false), '')
    WHERE content_warning IS NOT NULL AND char_length(content_warning) > 200;

UPDATE public.reactions SET custom_emoji_content = left(custom_emoji_content, 256)
    WHERE custom_emoji_content IS NOT NULL AND char_length(custom_emoji_content) > 256;
UPDATE public.post_interactions SET custom_emoji_content = left(custom_emoji_content, 256)
    WHERE custom_emoji_content IS NOT NULL AND char_length(custom_emoji_content) > 256;

UPDATE public.server_bans SET reason = public.sanitize_profile_string(reason, 512, true)
    WHERE reason IS NOT NULL AND char_length(reason) > 512;

-- ---------------------------------------------------------------------------
-- 4. Length CHECK backstops (idempotent)
-- ---------------------------------------------------------------------------
ALTER TABLE public.servers DROP CONSTRAINT IF EXISTS servers_name_length_check;
ALTER TABLE public.servers ADD CONSTRAINT servers_name_length_check
    CHECK (char_length(name) <= 100);
ALTER TABLE public.servers DROP CONSTRAINT IF EXISTS servers_description_length_check;
ALTER TABLE public.servers ADD CONSTRAINT servers_description_length_check
    CHECK (description IS NULL OR char_length(description) <= 500);

ALTER TABLE public.channels DROP CONSTRAINT IF EXISTS channels_name_length_check;
ALTER TABLE public.channels ADD CONSTRAINT channels_name_length_check
    CHECK (char_length(name) <= 100);
ALTER TABLE public.channels DROP CONSTRAINT IF EXISTS channels_description_length_check;
ALTER TABLE public.channels ADD CONSTRAINT channels_description_length_check
    CHECK (description IS NULL OR char_length(description) <= 1024);

ALTER TABLE public.channel_categories DROP CONSTRAINT IF EXISTS channel_categories_name_length_check;
ALTER TABLE public.channel_categories ADD CONSTRAINT channel_categories_name_length_check
    CHECK (char_length(name) <= 100);

ALTER TABLE public.server_roles DROP CONSTRAINT IF EXISTS server_roles_name_length_check;
ALTER TABLE public.server_roles ADD CONSTRAINT server_roles_name_length_check
    CHECK (char_length(name) <= 100);

ALTER TABLE public.threads DROP CONSTRAINT IF EXISTS threads_name_length_check;
ALTER TABLE public.threads ADD CONSTRAINT threads_name_length_check
    CHECK (char_length(name) <= 100);

ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_name_length_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_name_length_check
    CHECK (name IS NULL OR char_length(name) <= 100);

ALTER TABLE public.server_folders DROP CONSTRAINT IF EXISTS server_folders_name_length_check;
ALTER TABLE public.server_folders ADD CONSTRAINT server_folders_name_length_check
    CHECK (char_length(name) <= 64);

ALTER TABLE public.emojis DROP CONSTRAINT IF EXISTS emojis_name_length_check;
ALTER TABLE public.emojis ADD CONSTRAINT emojis_name_length_check
    CHECK (name IS NULL OR char_length(name::text) <= 64);

-- NOTE: user_servers.nickname length constraint is handled in the
-- column-existence guard above (section 2).

ALTER TABLE public.bots DROP CONSTRAINT IF EXISTS bots_display_name_length_check;
ALTER TABLE public.bots ADD CONSTRAINT bots_display_name_length_check
    CHECK (display_name IS NULL OR char_length(display_name) <= 100);
ALTER TABLE public.bots DROP CONSTRAINT IF EXISTS bots_bio_length_check;
ALTER TABLE public.bots ADD CONSTRAINT bots_bio_length_check
    CHECK (bio IS NULL OR char_length(bio) <= 500);
ALTER TABLE public.bots DROP CONSTRAINT IF EXISTS bots_website_url_length_check;
ALTER TABLE public.bots ADD CONSTRAINT bots_website_url_length_check
    CHECK (website_url IS NULL OR char_length(website_url) <= 512);

ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_reason_length_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_reason_length_check
    CHECK (char_length(reason) <= 200);
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_comment_length_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_comment_length_check
    CHECK (comment IS NULL OR char_length(comment) <= 1000);

ALTER TABLE public.user_lists DROP CONSTRAINT IF EXISTS user_lists_title_length_check;
ALTER TABLE public.user_lists ADD CONSTRAINT user_lists_title_length_check
    CHECK (char_length(title) <= 100);
ALTER TABLE public.user_lists DROP CONSTRAINT IF EXISTS user_lists_description_length_check;
ALTER TABLE public.user_lists ADD CONSTRAINT user_lists_description_length_check
    CHECK (description IS NULL OR char_length(description) <= 500);

ALTER TABLE public.posts DROP CONSTRAINT IF EXISTS posts_content_warning_length_check;
ALTER TABLE public.posts ADD CONSTRAINT posts_content_warning_length_check
    CHECK (content_warning IS NULL OR char_length(content_warning) <= 200);

ALTER TABLE public.reactions DROP CONSTRAINT IF EXISTS reactions_custom_emoji_length_check;
ALTER TABLE public.reactions ADD CONSTRAINT reactions_custom_emoji_length_check
    CHECK (custom_emoji_content IS NULL OR char_length(custom_emoji_content) <= 256);

ALTER TABLE public.post_interactions DROP CONSTRAINT IF EXISTS post_interactions_custom_emoji_length_check;
ALTER TABLE public.post_interactions ADD CONSTRAINT post_interactions_custom_emoji_length_check
    CHECK (custom_emoji_content IS NULL OR char_length(custom_emoji_content) <= 256);

ALTER TABLE public.server_bans DROP CONSTRAINT IF EXISTS server_bans_reason_length_check;
ALTER TABLE public.server_bans ADD CONSTRAINT server_bans_reason_length_check
    CHECK (reason IS NULL OR char_length(reason) <= 512);

-- Invite codes are identity (can't be auto-rewritten). Only enforce the charset
-- + length format when no existing row would violate it.
ALTER TABLE public.invites DROP CONSTRAINT IF EXISTS invites_code_format_check;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.invites WHERE code !~ '^[A-Za-z0-9_-]{1,64}$'
    ) THEN
        ALTER TABLE public.invites
            ADD CONSTRAINT invites_code_format_check
            CHECK (code ~ '^[A-Za-z0-9_-]{1,64}$');
    ELSE
        RAISE NOTICE 'Skipping invites_code_format_check: % existing code(s) violate the format; investigate before enforcing.',
            (SELECT count(*) FROM public.invites WHERE code !~ '^[A-Za-z0-9_-]{1,64}$');
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
