-- =============================================================================
-- Migration: Enforce admin-configured message / post length at the DB level
-- =============================================================================
-- Previously the DB enforced a fixed character ceiling (5000 → 10000) via
-- a CHECK constraint. That created two problems:
--
--   1. The DB-side number didn't track the admin's `max_message_length`
--      in `instance_config` (default 2000). A direct PostgREST POST that
--      bypassed the application could send messages well above the
--      admin's stated limit, up to the static ceiling.
--   2. CHECK constraints can't reference dynamic config rows (they must
--      be IMMUTABLE), so there's no way to make a CHECK track an
--      admin-configurable value.
--
-- This migration introduces a BEFORE INSERT/UPDATE trigger that reads
-- the live `instance_config.max_message_length` / `max_post_length` and
-- enforces it at the storage boundary. The CHECK constraint stays as
-- an absolute safety net (50000 chars) - purely a sanity bound that
-- catches a misconfigured admin value or a disabled trigger.
--
-- Encrypted messages are exempt from the plaintext char-length cap (the
-- plaintext isn't visible at the DB layer), but the trigger imposes a
-- byte-size cap on the ciphertext so flipping `encrypted=true` from a
-- direct POST can't bypass enforcement.
--
-- System messages (`is_system = true`) are exempt because their content
-- is tightly bounded server-generated text.
--
-- The CHECK ceiling is mirrored by `MESSAGE_TEXT_HARD_CEILING` in
-- `src/utils/messageContentUtils.ts`. Keep them in sync.
-- =============================================================================

BEGIN;

-- Clean up trigger from a very early draft of this migration.
DROP TRIGGER IF EXISTS trg_validate_message_content_length ON public.messages;
DROP FUNCTION IF EXISTS public.validate_message_content_length();

-- ------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------

-- IMMUTABLE walker that sums the length of every `text` part in a
-- MessagePart-shape jsonb array.
CREATE OR REPLACE FUNCTION public.jsonb_text_content_length(content jsonb)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
DECLARE
    total integer := 0;
    n integer;
    i integer;
    part jsonb;
BEGIN
    IF content IS NULL OR jsonb_typeof(content) <> 'array' THEN
        RETURN 0;
    END IF;

    n := jsonb_array_length(content);
    IF n = 0 THEN
        RETURN 0;
    END IF;

    FOR i IN 0..(n - 1) LOOP
        part := content -> i;
        IF jsonb_typeof(part) = 'object' AND (part ->> 'type') = 'text' THEN
            total := total + COALESCE(char_length(part ->> 'text'), 0);
        END IF;
    END LOOP;

    RETURN total;
END;
$$;

-- STABLE reader for `instance_config` numeric values with default + clamp.
CREATE OR REPLACE FUNCTION public.get_instance_config_int(
    p_key text,
    p_default integer,
    p_max_ceiling integer
)
RETURNS integer
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    raw_value jsonb;
    parsed integer;
BEGIN
    SELECT config_value INTO raw_value
    FROM public.instance_config
    WHERE config_key = p_key;

    IF raw_value IS NULL THEN
        RETURN LEAST(p_default, p_max_ceiling);
    END IF;

    BEGIN
        IF jsonb_typeof(raw_value) = 'number' THEN
            parsed := (raw_value::text)::integer;
        ELSIF jsonb_typeof(raw_value) = 'string' THEN
            parsed := (raw_value #>> '{}')::integer;
        ELSE
            parsed := NULL;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        parsed := NULL;
    END;

    IF parsed IS NULL OR parsed < 1 THEN
        RETURN LEAST(p_default, p_max_ceiling);
    END IF;

    RETURN LEAST(parsed, p_max_ceiling);
END;
$$;

COMMENT ON FUNCTION public.get_instance_config_int(text, integer, integer) IS
'Read a numeric value out of `instance_config`, with a fallback default and a hard ceiling.';

-- ------------------------------------------------------------
-- Trigger functions
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_message_length()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    soft_limit integer;
    text_len integer;
    encrypted_byte_limit constant integer := 50000;
BEGIN
    IF NEW.is_system IS TRUE THEN
        RETURN NEW;
    END IF;

    IF NEW.encrypted IS TRUE THEN
        IF octet_length(NEW.content::text) > encrypted_byte_limit THEN
            RAISE EXCEPTION 'Encrypted message payload exceeds maximum size of % bytes', encrypted_byte_limit
                USING ERRCODE = 'check_violation',
                      HINT = 'Send shorter messages - the plaintext limit is enforced by the client before encryption.';
        END IF;
        RETURN NEW;
    END IF;

    soft_limit := public.get_instance_config_int('max_message_length', 2000, 50000);

    text_len := public.jsonb_text_content_length(NEW.content);
    IF text_len > soft_limit THEN
        RAISE EXCEPTION 'Message text exceeds the instance limit of % characters (got %)', soft_limit, text_len
            USING ERRCODE = 'check_violation',
                  HINT = 'Trim the message or ask an instance admin to raise max_message_length in Chat Settings.';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_post_length()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    soft_limit integer;
    text_len integer;
BEGIN
    soft_limit := public.get_instance_config_int('max_post_length', 500, 50000);

    text_len := public.jsonb_text_content_length(NEW.content);
    IF text_len > soft_limit THEN
        RAISE EXCEPTION 'Post text exceeds the instance limit of % characters (got %)', soft_limit, text_len
            USING ERRCODE = 'check_violation',
                  HINT = 'Trim the post or ask an instance admin to raise max_post_length.';
    END IF;

    RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- Replace existing CHECK constraints (5000 / 10000 ceilings) with the
-- new 50000-char safety net, and install the trigger.
-- ------------------------------------------------------------

DO $$
BEGIN
    -- Drop the older CHECK constraints (with 5000 or 10000 ceilings)
    -- so we can recreate at the new 50000 absolute safety net.
    IF EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        WHERE c.conname = 'messages_text_length_check'
          AND r.relname = 'messages'
          AND regexp_replace(pg_get_constraintdef(c.oid), '\s+', '', 'g') ~ '<=\s*(?:5000|10000)\)'
    ) THEN
        ALTER TABLE public.messages DROP CONSTRAINT messages_text_length_check;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        WHERE c.conname = 'posts_text_length_check'
          AND r.relname = 'posts'
          AND regexp_replace(pg_get_constraintdef(c.oid), '\s+', '', 'g') ~ '<=\s*(?:5000|10000)\)'
    ) THEN
        ALTER TABLE public.posts DROP CONSTRAINT posts_text_length_check;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'messages_text_length_check' AND conrelid = 'public.messages'::regclass
    ) THEN
        ALTER TABLE public.messages
            ADD CONSTRAINT messages_text_length_check
            CHECK (
                encrypted IS TRUE
                OR is_system IS TRUE
                OR public.jsonb_text_content_length(content) <= 50000
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'posts_text_length_check' AND conrelid = 'public.posts'::regclass
    ) THEN
        ALTER TABLE public.posts
            ADD CONSTRAINT posts_text_length_check
            CHECK (public.jsonb_text_content_length(content) <= 50000);
    END IF;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_message_length ON public.messages;
CREATE TRIGGER trg_enforce_message_length
    BEFORE INSERT OR UPDATE OF content, encrypted, is_system ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_message_length();

DROP TRIGGER IF EXISTS trg_enforce_post_length ON public.posts;
CREATE TRIGGER trg_enforce_post_length
    BEFORE INSERT OR UPDATE OF content ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_post_length();

NOTIFY pgrst, 'reload schema';

COMMIT;
