-- CREATE OR REPLACE FUNCTION resets attributes, so a redefinition omitting the clause
-- drops the pin. None of the three is SECURITY DEFINER, so this is hygiene rather than
-- an escalation path.
--
-- ALTER rather than CREATE OR REPLACE: the bodies already match init/ and must not be
-- rewritten here.

BEGIN;

ALTER FUNCTION public.get_batch_message_reactions(message_ids uuid[])
    SET search_path = public, extensions, pg_temp;

ALTER FUNCTION public.get_message_reactions(message_id uuid)
    SET search_path = public, extensions, pg_temp;

ALTER FUNCTION public.update_post_reply_count()
    SET search_path = public, extensions, pg_temp;

COMMIT;
