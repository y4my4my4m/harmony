-- Track endpoint health to avoid retrying dead endpoints indefinitely
-- Based on ActivityPub best practices: mark endpoints as dead after 24-48 hours of consistent failures
-- This migration is IDEMPOTENT - safe to run multiple times

-- Drop existing trigger if exists (for re-running migration)
DROP TRIGGER IF EXISTS "federation_endpoint_health_cleanup_trigger" ON "public"."federation_endpoint_health";

-- Drop existing policies if they exist (for re-running migration)
DROP POLICY IF EXISTS "Service role can manage endpoint health" ON "public"."federation_endpoint_health";
DROP POLICY IF EXISTS "Authenticated users can read endpoint health" ON "public"."federation_endpoint_health";

CREATE TABLE IF NOT EXISTS "public"."federation_endpoint_health" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "endpoint_url" "text" NOT NULL,
    "domain" "text" NOT NULL,
    "is_dead" boolean DEFAULT false,
    "first_failure_at" timestamp with time zone,
    "last_success_at" timestamp with time zone,
    "last_failure_at" timestamp with time zone,
    "consecutive_failures" integer DEFAULT 0,
    "total_failures" integer DEFAULT 0,
    "total_successes" integer DEFAULT 0,
    "last_http_status" integer,
    "last_error_message" "text",
    CONSTRAINT "federation_endpoint_health_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "federation_endpoint_health_endpoint_url_key" UNIQUE ("endpoint_url")
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS "federation_endpoint_health_endpoint_url_idx" 
    ON "public"."federation_endpoint_health" ("endpoint_url");
CREATE INDEX IF NOT EXISTS "federation_endpoint_health_domain_idx" 
    ON "public"."federation_endpoint_health" ("domain");
CREATE INDEX IF NOT EXISTS "federation_endpoint_health_is_dead_idx" 
    ON "public"."federation_endpoint_health" ("is_dead");

-- Function to update endpoint health on delivery success/failure
CREATE OR REPLACE FUNCTION "public"."update_endpoint_health"(
    "p_endpoint_url" "text",
    "p_domain" "text",
    "p_success" boolean,
    "p_http_status" integer DEFAULT NULL,
    "p_error_message" "text" DEFAULT NULL
) RETURNS void
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_health_record RECORD;
    v_is_permanent_error boolean;
    v_dead_after_hours integer := 48; -- Mark as dead after 48 hours of consistent failures
BEGIN
    -- Determine if error is permanent (404, 410) vs temporary (500, 503, etc.)
    v_is_permanent_error := p_http_status IN (404, 410);
    
    -- Get or create health record
    SELECT * INTO v_health_record
    FROM federation_endpoint_health
    WHERE endpoint_url = p_endpoint_url
    FOR UPDATE;
    
    IF NOT FOUND THEN
        -- Create new health record
        INSERT INTO federation_endpoint_health (
            endpoint_url,
            domain,
            is_dead,
            first_failure_at,
            last_success_at,
            last_failure_at,
            consecutive_failures,
            total_failures,
            total_successes,
            last_http_status,
            last_error_message,
            created_at,
            updated_at
        ) VALUES (
            p_endpoint_url,
            p_domain,
            false,
            CASE WHEN NOT p_success THEN NOW() ELSE NULL END,
            CASE WHEN p_success THEN NOW() ELSE NULL END,
            CASE WHEN NOT p_success THEN NOW() ELSE NULL END,
            CASE WHEN NOT p_success THEN 1 ELSE 0 END,
            CASE WHEN NOT p_success THEN 1 ELSE 0 END,
            CASE WHEN p_success THEN 1 ELSE 0 END,
            p_http_status,
            p_error_message,
            NOW(),
            NOW()
        );
        RETURN;
    END IF;
    
    -- Update existing health record
    IF p_success THEN
        -- Success: reset failure tracking, mark as alive
        UPDATE federation_endpoint_health
        SET 
            is_dead = false,
            last_success_at = NOW(),
            consecutive_failures = 0,
            total_successes = total_successes + 1,
            last_http_status = p_http_status,
            last_error_message = NULL,
            first_failure_at = NULL,
            updated_at = NOW()
        WHERE endpoint_url = p_endpoint_url;
    ELSE
        -- Failure: increment counters and check if should mark as dead
        UPDATE federation_endpoint_health
        SET 
            last_failure_at = NOW(),
            consecutive_failures = consecutive_failures + 1,
            total_failures = total_failures + 1,
            last_http_status = p_http_status,
            last_error_message = p_error_message,
            first_failure_at = COALESCE(first_failure_at, NOW()),
            updated_at = NOW()
        WHERE endpoint_url = p_endpoint_url
        RETURNING * INTO v_health_record;
        
        -- Check if should mark as dead:
        -- 1. Permanent error (404, 410) with failures for >= 24 hours, OR
        -- 2. Any error with failures for >= 48 hours
        IF v_health_record.first_failure_at IS NOT NULL THEN
            IF (
                (v_is_permanent_error AND NOW() - v_health_record.first_failure_at >= INTERVAL '24 hours')
                OR (NOW() - v_health_record.first_failure_at >= INTERVAL '48 hours')
            ) THEN
                UPDATE federation_endpoint_health
                SET 
                    is_dead = true,
                    updated_at = NOW()
                WHERE endpoint_url = p_endpoint_url;
            END IF;
        END IF;
    END IF;
END;
$$;

ALTER FUNCTION "public"."update_endpoint_health"("p_endpoint_url" "text", "p_domain" "text", "p_success" boolean, "p_http_status" integer, "p_error_message" "text") OWNER TO "supabase_admin";

COMMENT ON TABLE "public"."federation_endpoint_health" IS 'Tracks health status of federation endpoints (inboxes) to avoid retrying dead endpoints indefinitely. Endpoints are marked as dead after 24-48 hours of consistent failures.';
COMMENT ON FUNCTION "public"."update_endpoint_health"("p_endpoint_url" "text", "p_domain" "text", "p_success" boolean, "p_http_status" integer, "p_error_message" "text") IS 'Updates endpoint health tracking. Marks endpoints as dead after 24 hours for permanent errors (404, 410) or 48 hours for any error.';

-- Function to clean up dead users (remove from follows, mark as inactive)
CREATE OR REPLACE FUNCTION "public"."cleanup_dead_endpoint_users"("p_endpoint_url" "text") RETURNS void
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_dead_profiles RECORD;
    v_follows_removed integer := 0;
BEGIN
    -- Find all profiles that use this dead endpoint (either inbox_url or shared_inbox_url)
    FOR v_dead_profiles IN
        SELECT id, username, domain, inbox_url, shared_inbox_url
        FROM profiles
        WHERE (
            inbox_url = p_endpoint_url 
            OR shared_inbox_url = p_endpoint_url
        )
        AND is_local = false
    LOOP
        -- Remove all follow relationships where this dead user is being followed
        -- (i.e., remove follows where following_id = dead user)
        DELETE FROM follows
        WHERE following_id = v_dead_profiles.id;
        
        GET DIAGNOSTICS v_follows_removed = ROW_COUNT;
        
        -- Also remove follows where this dead user is following others
        -- (i.e., remove follows where follower_id = dead user)
        DELETE FROM follows
        WHERE follower_id = v_dead_profiles.id;
        
        -- Clear inbox URLs to prevent future delivery attempts
        UPDATE profiles
        SET 
            inbox_url = NULL,
            shared_inbox_url = NULL,
            updated_at = NOW()
        WHERE id = v_dead_profiles.id;
        
        RAISE NOTICE 'Cleaned up dead user: %@% (removed % follows)', 
            v_dead_profiles.username, 
            v_dead_profiles.domain,
            v_follows_removed;
    END LOOP;
END;
$$;

ALTER FUNCTION "public"."cleanup_dead_endpoint_users"("p_endpoint_url" "text") OWNER TO "supabase_admin";

COMMENT ON FUNCTION "public"."cleanup_dead_endpoint_users"("p_endpoint_url" "text") IS 'Cleans up users with dead endpoints: removes them from all follow relationships and clears their inbox URLs.';

-- Trigger to automatically cleanup when endpoint is marked as dead
CREATE OR REPLACE FUNCTION "public"."trigger_cleanup_dead_endpoint"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    -- When an endpoint is marked as dead (is_dead changes from false to true)
    IF NEW.is_dead = true AND (OLD.is_dead IS NULL OR OLD.is_dead = false) THEN
        PERFORM cleanup_dead_endpoint_users(NEW.endpoint_url);
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."trigger_cleanup_dead_endpoint"() OWNER TO "supabase_admin";

CREATE TRIGGER "federation_endpoint_health_cleanup_trigger"
    AFTER UPDATE OF "is_dead" ON "public"."federation_endpoint_health"
    FOR EACH ROW
    WHEN (NEW.is_dead = true AND (OLD.is_dead IS NULL OR OLD.is_dead = false))
    EXECUTE FUNCTION "public"."trigger_cleanup_dead_endpoint"();

-- RLS policies
ALTER TABLE "public"."federation_endpoint_health" ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write (policies for RLS)
CREATE POLICY "Service role can manage endpoint health"
    ON "public"."federation_endpoint_health"
    FOR ALL
    USING (auth.role() = 'service_role');

-- Allow authenticated users to read (for debugging/admin)
CREATE POLICY "Authenticated users can read endpoint health"
    ON "public"."federation_endpoint_health"
    FOR SELECT
    USING (auth.role() = 'authenticated');

-- CRITICAL: Grant table access to service_role, authenticated, and anon roles
-- RLS policies alone don't grant access - we need explicit GRANTs for the table
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."federation_endpoint_health" TO service_role;
GRANT SELECT ON "public"."federation_endpoint_health" TO authenticated;

-- Grant EXECUTE on the RPC functions to allow calling them
GRANT EXECUTE ON FUNCTION "public"."update_endpoint_health"("text", "text", boolean, integer, "text") TO service_role;
GRANT EXECUTE ON FUNCTION "public"."update_endpoint_health"("text", "text", boolean, integer, "text") TO authenticated;
GRANT EXECUTE ON FUNCTION "public"."cleanup_dead_endpoint_users"("text") TO service_role;
