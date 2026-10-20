-- ActivityPub conformance.
--
-- trigger_queue_profile_federation   the actor's Update also federates profile fields
--                                    (attachment), discoverability (discoverable,
--                                    indexable), the profile colour and the custom emoji of
--                                    the display name (federation_metadata). Before, a
--                                    change to only these stayed local.
-- update_endpoint_health             a failing endpoint is marked dead after 7 days of
--                                    continuous failure, 48 hours before: a delivery is now
--                                    retried for about 4.9 days (DeliveryQueue.ts), as
--                                    Mastodon's DeliveryFailureTracker marks a domain
--                                    unavailable after failures on 7 distinct days. 404 and
--                                    410 still mark it dead after 24 hours.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- As 20261011900001_follow_approval.sql, plus profile_fields, federation_discoverable,
-- color and federation_metadata.
CREATE OR REPLACE FUNCTION public.trigger_queue_profile_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_local != true OR NEW.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF (
            OLD.display_name IS NOT DISTINCT FROM NEW.display_name AND
            OLD.bio IS NOT DISTINCT FROM NEW.bio AND
            OLD.avatar_url IS NOT DISTINCT FROM NEW.avatar_url AND
            OLD.banner_url IS NOT DISTINCT FROM NEW.banner_url AND
            OLD.custom_status IS NOT DISTINCT FROM NEW.custom_status AND
            OLD.also_known_as IS NOT DISTINCT FROM NEW.also_known_as AND
            OLD.moved_to_uri IS NOT DISTINCT FROM NEW.moved_to_uri AND
            OLD.manually_approves_followers IS NOT DISTINCT FROM NEW.manually_approves_followers AND
            OLD.profile_fields IS NOT DISTINCT FROM NEW.profile_fields AND
            OLD.federation_discoverable IS NOT DISTINCT FROM NEW.federation_discoverable AND
            OLD.color IS NOT DISTINCT FROM NEW.color AND
            OLD.federation_metadata IS NOT DISTINCT FROM NEW.federation_metadata
        ) THEN
            RETURN NEW;
        END IF;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-profile',
        jsonb_build_object(
            'type', CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            'profile_id', NEW.id,
            'username', NEW.username,
            'display_name', NEW.display_name,
            'bio', NEW.bio,
            'avatar_url', NEW.avatar_url,
            'banner_url', NEW.banner_url,
            'custom_status', NEW.custom_status
        ),
        3, 5, 3600
    );

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_queue_profile_federation() FROM PUBLIC, anon, authenticated;

-- As 20260101000000_baseline.sql, with 7 days in place of 48 hours.
CREATE OR REPLACE FUNCTION public.update_endpoint_health(
    p_endpoint_url text,
    p_domain text,
    p_success boolean,
    p_http_status integer DEFAULT NULL,
    p_error_message text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_health_record RECORD;
    v_is_permanent_error boolean;
BEGIN
    v_is_permanent_error := p_http_status IN (404, 410);

    SELECT * INTO v_health_record
    FROM federation_endpoint_health WHERE endpoint_url = p_endpoint_url FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO federation_endpoint_health (
            endpoint_url, domain, is_dead, first_failure_at,
            last_success_at, last_failure_at, consecutive_failures,
            total_failures, total_successes, last_http_status, last_error_message
        ) VALUES (
            p_endpoint_url, p_domain, false,
            CASE WHEN NOT p_success THEN NOW() ELSE NULL END,
            CASE WHEN p_success THEN NOW() ELSE NULL END,
            CASE WHEN NOT p_success THEN NOW() ELSE NULL END,
            CASE WHEN NOT p_success THEN 1 ELSE 0 END,
            CASE WHEN NOT p_success THEN 1 ELSE 0 END,
            CASE WHEN p_success THEN 1 ELSE 0 END,
            p_http_status, p_error_message
        );
        RETURN;
    END IF;

    IF p_success THEN
        UPDATE federation_endpoint_health SET
            is_dead = false, last_success_at = NOW(), consecutive_failures = 0,
            total_successes = total_successes + 1, last_http_status = p_http_status,
            last_error_message = NULL, first_failure_at = NULL, updated_at = NOW()
        WHERE endpoint_url = p_endpoint_url;
    ELSE
        UPDATE federation_endpoint_health SET
            last_failure_at = NOW(), consecutive_failures = consecutive_failures + 1,
            total_failures = total_failures + 1, last_http_status = p_http_status,
            last_error_message = p_error_message,
            first_failure_at = COALESCE(first_failure_at, NOW()), updated_at = NOW()
        WHERE endpoint_url = p_endpoint_url
        RETURNING * INTO v_health_record;

        IF v_health_record.first_failure_at IS NOT NULL THEN
            IF (v_is_permanent_error AND NOW() - v_health_record.first_failure_at >= INTERVAL '24 hours')
                OR (NOW() - v_health_record.first_failure_at >= INTERVAL '7 days') THEN
                UPDATE federation_endpoint_health SET is_dead = true, updated_at = NOW()
                WHERE endpoint_url = p_endpoint_url;
            END IF;
        END IF;
    END IF;
END;
$$;

COMMENT ON FUNCTION public.update_endpoint_health IS
'Tracks endpoint delivery health. Marks endpoints dead after 24h (permanent errors) or 7 days (any error).';

COMMIT;
