-- Inbox idempotency: atomically claim an ap_activities row before processing so
-- redelivered activities (retries, relays, duplicate federation paths) run their
-- side effects exactly once. Companion code: InboxHandler.ts / GroupService.ts.
--
-- claim_ap_activity: returns true when the caller wins the right to process the
-- activity. Rows already completed stay untouched. Rows stuck in 'processing'
-- for over 10 minutes (crashed worker) can be reclaimed.

CREATE OR REPLACE FUNCTION public.claim_ap_activity(p_ap_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_claimed boolean;
BEGIN
    UPDATE ap_activities
    SET status = 'processing',
        attempts = attempts + 1,
        last_attempt_at = NOW(),
        updated_at = NOW()
    WHERE ap_id = p_ap_id
      AND (
        status IN ('pending', 'received', 'failed')
        OR (status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes')
      )
    RETURNING true INTO v_claimed;

    RETURN COALESCE(v_claimed, false);
END;
$$;

COMMENT ON FUNCTION public.claim_ap_activity IS
'Atomically claim an ActivityPub activity for processing. Returns false when the activity was already processed or is being processed (idempotency guard).';

CREATE OR REPLACE FUNCTION public.complete_ap_activity(
    p_ap_id text,
    p_success boolean,
    p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE ap_activities
    SET status = CASE WHEN p_success THEN 'completed' ELSE 'failed' END,
        error_message = p_error,
        updated_at = NOW()
    WHERE ap_id = p_ap_id;
END;
$$;

COMMENT ON FUNCTION public.complete_ap_activity IS
'Mark a claimed ActivityPub activity as completed or failed. Failed activities become claimable again via claim_ap_activity.';

REVOKE ALL ON FUNCTION public.claim_ap_activity(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_ap_activity(text, boolean, text) FROM anon, authenticated;
