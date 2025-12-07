-- =============================================
-- Custom Status / Rich Presence System
-- Discord-style custom status with activity types
-- Federation-ready for ActivityPub
-- =============================================

-- =============================================
-- 1. Add custom_status column to profiles table
-- =============================================
ALTER TABLE "public"."profiles"
ADD COLUMN IF NOT EXISTS "custom_status" "jsonb";

COMMENT ON COLUMN "public"."profiles"."custom_status" IS 'Custom status/rich presence data: { type, text, emoji, emoji_url, details, state, timestamps, expires_at }';

-- Create index for status expiration queries
CREATE INDEX IF NOT EXISTS "idx_profiles_status_expires" 
ON "public"."profiles"(("custom_status"->>'expires_at')) 
WHERE "custom_status" IS NOT NULL AND "custom_status"->>'expires_at' IS NOT NULL;

-- =============================================
-- 2. Function to set custom status
-- =============================================
CREATE OR REPLACE FUNCTION "public"."set_custom_status"(
    p_user_id uuid,
    p_type text DEFAULT 'custom',
    p_text text DEFAULT NULL,
    p_emoji text DEFAULT NULL,
    p_emoji_url text DEFAULT NULL,
    p_details text DEFAULT NULL,
    p_state text DEFAULT NULL,
    p_duration_minutes integer DEFAULT NULL -- null = forever
)
RETURNS jsonb AS $$
DECLARE
    v_status jsonb;
    v_expires_at timestamptz;
BEGIN
    -- Validate activity type
    IF p_type NOT IN ('custom', 'playing', 'listening', 'watching', 'competing', 'streaming') THEN
        RAISE EXCEPTION 'Invalid activity type: %. Must be one of: custom, playing, listening, watching, competing, streaming', p_type;
    END IF;
    
    -- Calculate expiration
    IF p_duration_minutes IS NOT NULL AND p_duration_minutes > 0 THEN
        v_expires_at := NOW() + (p_duration_minutes || ' minutes')::interval;
    ELSE
        v_expires_at := NULL;
    END IF;
    
    -- Build status object
    v_status := jsonb_build_object(
        'type', p_type,
        'text', p_text,
        'emoji', p_emoji,
        'emoji_url', p_emoji_url,
        'details', p_details,
        'state', p_state,
        'set_at', NOW(),
        'expires_at', v_expires_at
    );
    
    -- Remove null values for cleaner storage
    v_status := (
        SELECT jsonb_object_agg(key, value)
        FROM jsonb_each(v_status)
        WHERE value IS NOT NULL AND value != 'null'::jsonb
    );
    
    -- Update profile
    UPDATE "public"."profiles"
    SET custom_status = v_status
    WHERE id = p_user_id;
    
    RETURN v_status;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION "public"."set_custom_status" IS 'Set custom status with activity type and optional expiration';

-- =============================================
-- 3. Function to clear custom status
-- =============================================
CREATE OR REPLACE FUNCTION "public"."clear_custom_status"(
    p_user_id uuid
)
RETURNS boolean AS $$
BEGIN
    UPDATE "public"."profiles"
    SET custom_status = NULL
    WHERE id = p_user_id;
    
    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- 4. Function to get active custom status
-- =============================================
CREATE OR REPLACE FUNCTION "public"."get_custom_status"(
    p_user_id uuid
)
RETURNS jsonb AS $$
DECLARE
    v_status jsonb;
    v_expires_at timestamptz;
BEGIN
    SELECT custom_status INTO v_status
    FROM "public"."profiles"
    WHERE id = p_user_id;
    
    IF v_status IS NULL THEN
        RETURN NULL;
    END IF;
    
    -- Check if expired
    v_expires_at := (v_status->>'expires_at')::timestamptz;
    IF v_expires_at IS NOT NULL AND v_expires_at < NOW() THEN
        -- Clear expired status
        UPDATE "public"."profiles"
        SET custom_status = NULL
        WHERE id = p_user_id;
        
        RETURN NULL;
    END IF;
    
    RETURN v_status;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- =============================================
-- 5. Function to cleanup expired statuses (for cron)
-- =============================================
CREATE OR REPLACE FUNCTION "public"."cleanup_expired_statuses"()
RETURNS integer AS $$
DECLARE
    v_count integer;
BEGIN
    WITH updated AS (
        UPDATE "public"."profiles"
        SET custom_status = NULL
        WHERE custom_status IS NOT NULL
        AND (custom_status->>'expires_at')::timestamptz < NOW()
        RETURNING id
    )
    SELECT COUNT(*) INTO v_count FROM updated;
    
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION "public"."cleanup_expired_statuses"() IS 'Cleanup expired custom statuses - run via cron';

-- =============================================
-- 6. View for users with active custom status
-- =============================================
CREATE OR REPLACE VIEW "public"."active_statuses_view" AS
SELECT 
    p.id as user_id,
    p.username,
    p.display_name,
    p.avatar_url,
    p.domain,
    p.is_local,
    p.custom_status->>'type' as status_type,
    p.custom_status->>'text' as status_text,
    p.custom_status->>'emoji' as status_emoji,
    p.custom_status->>'emoji_url' as status_emoji_url,
    p.custom_status->>'details' as status_details,
    p.custom_status->>'state' as status_state,
    (p.custom_status->>'set_at')::timestamptz as status_set_at,
    (p.custom_status->>'expires_at')::timestamptz as status_expires_at
FROM "public"."profiles" p
WHERE p.custom_status IS NOT NULL
AND (
    (p.custom_status->>'expires_at') IS NULL 
    OR (p.custom_status->>'expires_at')::timestamptz > NOW()
);

GRANT SELECT ON "public"."active_statuses_view" TO "authenticated";
GRANT SELECT ON "public"."active_statuses_view" TO "service_role";

-- =============================================
-- 7. Add last_status_update column for sync tracking
-- =============================================
ALTER TABLE "public"."profiles"
ADD COLUMN IF NOT EXISTS "last_status_update" timestamp with time zone DEFAULT "now"();

COMMENT ON COLUMN "public"."profiles"."last_status_update" IS 'Timestamp of last status change for federation sync';

-- Trigger to update last_status_update when custom_status changes
CREATE OR REPLACE FUNCTION "public"."update_status_timestamp"()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.custom_status IS DISTINCT FROM NEW.custom_status THEN
        NEW.last_status_update = NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trigger_status_update_timestamp" ON "public"."profiles";
CREATE TRIGGER "trigger_status_update_timestamp"
    BEFORE UPDATE OF custom_status ON "public"."profiles"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."update_status_timestamp"();

-- =============================================
-- 8. Grant permissions
-- =============================================
GRANT EXECUTE ON FUNCTION "public"."set_custom_status"(uuid, text, text, text, text, text, text, integer) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."clear_custom_status"(uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_custom_status"(uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."cleanup_expired_statuses"() TO "service_role";

GRANT EXECUTE ON FUNCTION "public"."set_custom_status"(uuid, text, text, text, text, text, text, integer) TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."clear_custom_status"(uuid) TO "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_custom_status"(uuid) TO "service_role";

-- =============================================
-- 9. Update RLS to allow users to update their own status
-- =============================================
-- (Existing profiles RLS should already handle this - users can update their own profile)

