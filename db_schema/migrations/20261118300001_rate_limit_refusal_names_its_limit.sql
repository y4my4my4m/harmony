-- ANTISPAM_RATE_LIMITED from antispam_rate_check names the limit it reached, in DETAIL:
--   {"kind": "<automod_recent_activity.kind>", "limit": <n>, "window_seconds": <s>}
-- PostgREST returns DETAIL as the error's details. The message is unchanged:
-- ANTISPAM_RATE_LIMITED:<seconds until the oldest counted write leaves the window>. A refusal raised
-- outside antispam_rate_check (20261005100001 automod_check_message) carries no DETAIL.
--
-- Body, volatility, owner and grants as 20261109200001_instance_write_limits.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.antispam_rate_check(
    p_user uuid, p_kind text, p_limit integer, p_window_seconds integer, p_hint text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_window interval := make_interval(secs => p_window_seconds);
    v_count integer;
    v_oldest timestamptz;
BEGIN
    SELECT count(*), min(x.created_at) INTO v_count, v_oldest
      FROM (SELECT ra.created_at FROM public.automod_recent_activity ra
             WHERE ra.user_id = p_user AND ra.created_at > now() - v_window AND ra.kind = p_kind
             ORDER BY ra.created_at DESC LIMIT p_limit) x;
    IF v_count >= p_limit THEN
        RAISE EXCEPTION 'ANTISPAM_RATE_LIMITED:%',
            GREATEST(1, ceil(extract(epoch FROM (v_oldest + v_window - now()))))::integer
            USING ERRCODE = 'P0001', HINT = p_hint,
                  DETAIL = json_build_object('kind', p_kind, 'limit', p_limit,
                                             'window_seconds', p_window_seconds)::text;
    END IF;
END;
$$;

COMMIT;
