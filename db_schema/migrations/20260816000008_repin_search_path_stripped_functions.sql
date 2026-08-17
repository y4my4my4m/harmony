-- Restores the search_path pin on three functions that lost it.
--
-- 20260616_performance_advisor_fixes.sql pins search_path on every public
-- function lacking one. CREATE OR REPLACE FUNCTION resets a function's
-- attributes to exactly what the statement says, so a later migration that
-- redefines a function without restating the clause silently drops the pin:
--
--   get_batch_message_reactions   20260622_message_reactions_and_federation_fixes.sql
--   get_message_reactions         20260622_message_reactions_and_federation_fixes.sql
--   update_post_reply_count       20260706_reply_count_authoritative_local.sql
--
-- Scope of the problem, deliberately stated: none of the three is SECURITY
-- DEFINER. They run as the caller, so a mutable search_path here is a hygiene
-- defect and a Supabase advisor finding (function_search_path_mutable), not a
-- privilege-escalation path. The three are the only functions still differing
-- from a fresh init/ build on attributes.
--
-- Evidence this is safe rather than assumed:
--
--   - get_batch_message_reactions and get_message_reactions date from
--     20260318, so the 20260616 loop pinned them and 20260622 stripped them.
--     Production already ran both with this exact pin.
--   - update_post_reply_count dates from 20260705, after the hardening pass,
--     so it was never pinned. This is a new setting for that one function.
--   - All three are built with this pin in init/ and were executed against a
--     fresh build: both readers return rows and the trigger sets replies_count.
--
-- ALTER FUNCTION rather than CREATE OR REPLACE: the bodies already match a
-- fresh init/ build and must not be rewritten here. ALTER FUNCTION ... SET is
-- idempotent and takes no lock beyond the catalog row.

BEGIN;

ALTER FUNCTION public.get_batch_message_reactions(message_ids uuid[])
    SET search_path = public, extensions, pg_temp;

ALTER FUNCTION public.get_message_reactions(message_id uuid)
    SET search_path = public, extensions, pg_temp;

ALTER FUNCTION public.update_post_reply_count()
    SET search_path = public, extensions, pg_temp;

COMMIT;
