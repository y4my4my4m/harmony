BEGIN;

-- =============================================================================
-- Fix: messages UPDATE and DELETE RLS policies
-- =============================================================================
-- The init script 30_rls_policies.sql references is_current_user_moderator()
-- and can_current_user_manage_messages_in_channel() which are defined in
-- 31_rls_policies_extended.sql (loaded AFTER 30). This causes silent policy
-- creation failures on fresh installs, blocking all message edits/deletes.
-- =============================================================================

-- Ensure the helper functions exist (idempotent)
CREATE OR REPLACE FUNCTION public.is_current_user_moderator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT COALESCE(
        (SELECT is_moderator FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

CREATE OR REPLACE FUNCTION public.is_current_user_admin_or_mod()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT COALESCE(
        (SELECT (is_admin OR is_moderator) FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

CREATE OR REPLACE FUNCTION public.can_current_user_manage_messages_in_channel(p_channel_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_profile_id uuid;
    v_server_id uuid;
    v_is_owner boolean;
    v_has_perm boolean;
BEGIN
    v_profile_id := public.get_current_profile_id();
    IF v_profile_id IS NULL THEN RETURN false; END IF;

    SELECT server_id INTO v_server_id FROM public.channels WHERE id = p_channel_id;
    IF v_server_id IS NULL THEN RETURN false; END IF;

    SELECT (owner = v_profile_id) INTO v_is_owner FROM public.servers WHERE id = v_server_id;
    IF v_is_owner THEN RETURN true; END IF;

    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.server_roles sr ON sr.id = ur.role_id
        WHERE ur.user_id = v_profile_id
          AND sr.server_id = v_server_id
          AND (
              sr.is_admin = true
              OR (sr.permissions & (1::bigint << 0)) != 0
              OR (sr.permissions & (1::bigint << 21)) != 0
          )
    ) INTO v_has_perm;

    RETURN v_has_perm;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_current_user_moderator() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_current_user_admin_or_mod() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_current_user_manage_messages_in_channel(uuid) TO authenticated;

-- Recreate the messages UPDATE policy
DROP POLICY IF EXISTS "messages_update_authorized" ON public.messages;
DROP POLICY IF EXISTS "Message owner or server owner can update" ON public.messages;
DROP POLICY IF EXISTS "messages_update_own" ON public.messages;

CREATE POLICY "messages_update_authorized" ON public.messages
    FOR UPDATE USING (
        user_id = public.get_current_profile_id()
        OR public.is_current_user_admin()
        OR public.is_current_user_moderator()
        OR public.can_current_user_manage_messages_in_channel(channel_id)
    );

-- Recreate the messages DELETE policy
DROP POLICY IF EXISTS "messages_delete_authorized" ON public.messages;
DROP POLICY IF EXISTS "messages_delete_policy" ON public.messages;
DROP POLICY IF EXISTS "Message authors can delete" ON public.messages;

CREATE POLICY "messages_delete_authorized" ON public.messages
    FOR DELETE USING (
        user_id = public.get_current_profile_id()
        OR public.is_current_user_admin()
        OR public.is_current_user_moderator()
        OR public.can_current_user_manage_messages_in_channel(channel_id)
    );

NOTIFY pgrst, 'reload schema';

COMMIT;
