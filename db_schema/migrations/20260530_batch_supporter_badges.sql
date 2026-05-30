-- Batched supporter badge lookup.
--
-- Chat views previously fired one get_supporter_badge(p_user_id) RPC per
-- distinct message author, producing an N+1 storm on channel load (visible in
-- network traces as ~7+ identical /rpc/get_supporter_badge POSTs). This adds a
-- single-round-trip variant keyed by user_id so the client can resolve every
-- visible author's badge in one call.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_supporter_badges(p_user_ids uuid[])
RETURNS TABLE(
    user_id uuid,
    tier_name text,
    badge_icon text,
    badge_color text,
    is_active boolean
)
LANGUAGE sql STABLE
AS $$
    SELECT DISTINCT ON (s.user_id)
        s.user_id,
        t.name AS tier_name,
        t.badge_icon,
        t.badge_color,
        s.is_active
    FROM public.instance_supporters s
    JOIN public.instance_supporter_tiers t ON t.id = s.tier_id
    WHERE s.user_id = ANY(p_user_ids)
      AND s.is_active = true
      AND s.tier_id IS NOT NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
    ORDER BY s.user_id, t.min_amount DESC NULLS LAST, s.started_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_supporter_badges(uuid[]) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
