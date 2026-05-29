-- =============================================================================
-- Migration: Profile text hardening (anti-spoofing + length guards)
-- =============================================================================
-- Background: profiles.username already has an ASCII charset CHECK
-- (`^[a-zA-Z0-9_]+$`) enforced at the DB layer, so non-ASCII usernames such as
-- "@امتحان@domain" cannot be stored. However display_name / bio / profile_fields
-- / custom_status accepted ARBITRARY unicode with NO length cap, and RLS lets a
-- user PATCH their own row directly via REST. That is the real abuse surface:
--   * multi-megabyte bio / display_name (storage / DoS / render abuse)
--   * RTL-override / zero-width / homoglyph display names (impersonation)
--
-- This migration adds the authoritative server-side guards:
--   1. sanitize_profile_string() helper (NFC + strip bidi/zero-width/control + clamp)
--   2. sanitize_profile_text() BEFORE INSERT/UPDATE trigger on profiles
--      (covers local signup, REST edits, AND federated actor upserts)
--   3. cleans existing rows so the length CHECK backstops can attach
--   4. length CHECK backstops on username / display_name / bio
--   5. hardens set_custom_status() to sanitize through the same helper
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Shared sanitizer
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
                        -- keep TAB (U+0009) and LF (U+000A); strip the rest
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
-- 2. Sanitize trigger (authoritative; runs on every write path)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sanitize_profile_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.display_name IS NOT NULL THEN
        NEW.display_name := NULLIF(public.sanitize_profile_string(NEW.display_name, 80, false), '');
    END IF;

    IF NEW.bio IS NOT NULL THEN
        NEW.bio := NULLIF(public.sanitize_profile_string(NEW.bio, 500, true), '');
    END IF;

    IF NEW.profile_fields IS NOT NULL AND jsonb_typeof(NEW.profile_fields) = 'array' THEN
        NEW.profile_fields := COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'name',  COALESCE(public.sanitize_profile_string(elem->>'name', 255, false), ''),
                'value', COALESCE(public.sanitize_profile_string(elem->>'value', 255, false), '')
            ))
            FROM (
                SELECT elem
                FROM jsonb_array_elements(NEW.profile_fields) WITH ORDINALITY AS t(elem, ord)
                WHERE ord <= 4
            ) s
        ), '[]'::jsonb);
    END IF;

    IF NEW.custom_status IS NOT NULL AND jsonb_typeof(NEW.custom_status) = 'object' THEN
        NEW.custom_status := NEW.custom_status || jsonb_strip_nulls(jsonb_build_object(
            'text',    public.sanitize_profile_string(NEW.custom_status->>'text', 128, false),
            'emoji',   public.sanitize_profile_string(NEW.custom_status->>'emoji', 64, false),
            'details', public.sanitize_profile_string(NEW.custom_status->>'details', 128, false),
            'state',   public.sanitize_profile_string(NEW.custom_status->>'state', 128, false)
        ));
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sanitize_profile_text_trigger ON public.profiles;
CREATE TRIGGER sanitize_profile_text_trigger
    BEFORE INSERT OR UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.sanitize_profile_text();

-- ---------------------------------------------------------------------------
-- 3. Clean existing rows so the length backstops can attach.
--    Only rows that actually change are touched (keeps federation/realtime
--    broadcast triggers from firing across the whole table).
-- ---------------------------------------------------------------------------
UPDATE public.profiles
SET display_name = NULLIF(public.sanitize_profile_string(display_name, 80, false), '')
WHERE display_name IS NOT NULL
  AND NULLIF(public.sanitize_profile_string(display_name, 80, false), '') IS DISTINCT FROM display_name;

UPDATE public.profiles
SET bio = NULLIF(public.sanitize_profile_string(bio, 500, true), '')
WHERE bio IS NOT NULL
  AND NULLIF(public.sanitize_profile_string(bio, 500, true), '') IS DISTINCT FROM bio;

-- ---------------------------------------------------------------------------
-- 4. Length CHECK backstops (idempotent)
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_display_name_length_check;
ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_display_name_length_check
    CHECK (display_name IS NULL OR char_length(display_name) <= 80);

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_bio_length_check;
ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_bio_length_check
    CHECK (bio IS NULL OR char_length(bio) <= 500);

-- Usernames are identity (can't be silently truncated). Only add the cap when
-- no existing row would violate it -- realistic usernames are <= 24 chars.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_username_length_check;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE username IS NOT NULL AND char_length(username) > 64
    ) THEN
        ALTER TABLE public.profiles
            ADD CONSTRAINT profiles_username_length_check
            CHECK (username IS NULL OR char_length(username) <= 64);
    ELSE
        RAISE NOTICE 'Skipping profiles_username_length_check: % row(s) exceed 64 chars; investigate before enforcing.',
            (SELECT count(*) FROM public.profiles WHERE char_length(username) > 64);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Harden set_custom_status() to sanitize through the shared helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_custom_status(
    p_user_id uuid,
    p_type text DEFAULT 'custom',
    p_text text DEFAULT NULL,
    p_emoji text DEFAULT NULL,
    p_emoji_url text DEFAULT NULL,
    p_details text DEFAULT NULL,
    p_state text DEFAULT NULL,
    p_duration_minutes integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_status jsonb;
    v_expires_at timestamptz;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot modify another user''s status';
    END IF;

    IF p_type NOT IN ('custom', 'playing', 'listening', 'watching', 'competing', 'streaming') THEN
        RAISE EXCEPTION 'Invalid activity type';
    END IF;

    IF p_duration_minutes IS NOT NULL AND p_duration_minutes > 0 THEN
        v_expires_at := NOW() + (p_duration_minutes || ' minutes')::interval;
    END IF;

    v_status := jsonb_build_object(
        'type', p_type,
        'text', public.sanitize_profile_string(p_text, 128, false),
        'emoji', public.sanitize_profile_string(p_emoji, 64, false),
        'emoji_url', p_emoji_url,
        'details', public.sanitize_profile_string(p_details, 128, false),
        'state', public.sanitize_profile_string(p_state, 128, false),
        'set_at', NOW(),
        'expires_at', v_expires_at
    );

    v_status := (
        SELECT jsonb_object_agg(key, value)
        FROM jsonb_each(v_status)
        WHERE value IS NOT NULL AND value != 'null'::jsonb
    );

    UPDATE profiles
    SET custom_status = v_status, last_status_update = NOW()
    WHERE id = p_user_id;

    RETURN v_status;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
