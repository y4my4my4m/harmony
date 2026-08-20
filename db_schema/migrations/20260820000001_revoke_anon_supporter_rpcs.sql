-- Two SECURITY DEFINER functions are executable by anon, so RLS does not apply and no
-- authentication is required to reach them.
--
-- recompute_supporter_tier(p_user_id) takes the target from its argument and checks nothing
-- about the caller. It ends in
--     UPDATE public.instance_supporters SET tier_id = ..., amount = ..., expires_at = ...
--      WHERE user_id = p_user_id
-- so an unauthenticated request rewrites any user's supporter row. For a manually granted
-- supporter, which carries no rows in instance_donation_history, the recomputed total is 0
-- and the tier resolves to NULL, clearing the grant.
--
-- get_user_cycle_donation_total(p_user_id) returns any user's donation total.
-- instance_donation_history is otherwise readable only through donation_history_select_admin.
--
-- authenticated keeps EXECUTE on recompute_supporter_tier: the admin funding screen calls it
-- from the browser, and the Ko-fi webhook holds service_role. get_user_cycle_donation_total
-- has no caller outside recompute_supporter_tier, which is SECURITY DEFINER and so runs it as
-- the owner regardless of the grant.
--
-- Supabase grants EXECUTE on public functions to PUBLIC by default, which is where anon
-- inherits it; revoking anon alone leaves the grant in place.

BEGIN;

REVOKE ALL ON FUNCTION public.recompute_supporter_tier(uuid) FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION public.get_user_cycle_donation_total(uuid) FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
