BEGIN;

-- Used by RPCs in 13_functions_rpc_extended (e.g. storage policy helpers) and by group icon checks.
-- Must exist before those functions run; for fresh init, add to 12_functions_rpc.sql or ensure load order.
CREATE OR REPLACE FUNCTION public.can_manage_group_icon(conversation_uuid uuid, user_profile_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM conversation_participants cp
    WHERE cp.conversation_id = conversation_uuid
      AND cp.user_id = user_profile_id
      AND cp.left_at IS NULL
  );
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
