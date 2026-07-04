-- Follow-request responses (Accept/Reject) must federate through the BullMQ
-- pipeline. The existing trigger_federate_follow only fires on INSERT/DELETE,
-- so a local user's approval (pending -> accepted/rejected UPDATE) never
-- reached the queue and the remote follower stayed on "requested" forever.
--
-- Fires only for: remote follower + local target + pending -> accepted/rejected.
-- The worker handles job type 'respond' in queue/handlers/followHandler.ts.
--
-- BEFORE UPDATE so it can stamp federation_status = 'pending' on the row:
-- that makes the response durable - if the pg_notify is lost (worker down),
-- the 60s BullMQ sweep re-enqueues it from the marker.
--
-- Note: intentionally NOT added to the enable/disable trigger lists in
-- toggle_federation(); if federation is off, the notify just goes unheard.

CREATE OR REPLACE FUNCTION public.trigger_queue_follow_response_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_follower_is_local BOOLEAN;
    v_following_is_local BOOLEAN;
BEGIN
    IF OLD.status = 'pending' AND NEW.status IN ('accepted', 'rejected') THEN
        SELECT is_local INTO v_follower_is_local FROM public.profiles WHERE id = NEW.follower_id;
        SELECT is_local INTO v_following_is_local FROM public.profiles WHERE id = NEW.following_id;

        IF COALESCE(v_follower_is_local, true) = false AND v_following_is_local = true THEN
            NEW.federation_status := 'pending';
            -- follows has no auto-updated_at trigger; stamp it so the sweep's
            -- 2-second notify-race guard applies to this transition.
            NEW.updated_at := now();
            PERFORM public.queue_federation_job(
                'federate-follow',
                jsonb_build_object(
                    'type', 'respond',
                    'follow_id', NEW.id,
                    'follower_id', NEW.follower_id,
                    'following_id', NEW.following_id,
                    'status', NEW.status,
                    'ap_id', NEW.ap_id
                ), 5, 5, 3600
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_federate_follow_response ON public.follows;
CREATE TRIGGER trigger_federate_follow_response
    BEFORE UPDATE ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_follow_response_federation();
