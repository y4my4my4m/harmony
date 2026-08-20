-- ---------------------------------------------------------------------------
-- Prevent profile self-escalation to admin / moderator / suspended-bypass.
--
-- Why:
-- `profiles_update_own` is `FOR UPDATE USING (auth_user_id = auth.uid())`
-- with NO column allowlist. The profile row contains moderation flags
-- (is_admin, is_moderator, is_suspended, is_silenced, force_sensitive)
-- that the application reads back to gate admin RPCs and RLS via
-- `is_current_user_admin()` / `is_current_user_moderator()`. Without a
-- column-level guard, any authenticated user can call
--   UPDATE profiles SET is_admin = true WHERE auth_user_id = auth.uid()
-- and become an instance admin in a single request.
--
-- Fix: a BEFORE UPDATE trigger that rejects changes to these protected
-- columns unless the actor is the service role OR is already an admin.
-- This preserves legitimate flows:
--   - First-bootstrap admin is set by a `service_role` SQL or RPC.
--   - Admins can promote/demote other users via existing admin RPCs.
--   - Self-suspend / self-silence is never possible (no UI path requires it).
--
-- Idempotency: function is `CREATE OR REPLACE`; trigger uses DROP IF EXISTS.
-- ---------------------------------------------------------------------------
BEGIN;

-- Some deployed schemas predate the addition of `is_moderator`,
-- `is_silenced`, and `force_sensitive` (those columns come from
-- `archives/add_moderator_and_message_perms.sql` and
-- `20260328_admin_content_moderation.sql`, which may not yet be applied in
-- every environment). The trigger below references them in BEFORE UPDATE OF,
-- which fails at creation time if any column is missing. Add them defensively
-- so this migration is safe to run regardless of how far behind the target DB
-- is.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_moderator boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_suspended boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_silenced boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS force_sensitive boolean DEFAULT false;

CREATE OR REPLACE FUNCTION public.prevent_profile_moderation_self_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role text;
    v_is_admin boolean;
BEGIN
    -- Detect privileged roles. `service_role` is what privileged server-side
    -- code (Edge Functions, admin scripts) uses; it must always be allowed.
    v_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
    IF v_role = 'service_role' OR session_user = 'postgres' THEN
        RETURN NEW;
    END IF;

    -- Check whether ANY of the protected columns is being changed.
    IF NEW.is_admin IS DISTINCT FROM OLD.is_admin
       OR NEW.is_moderator IS DISTINCT FROM OLD.is_moderator
       OR NEW.is_suspended IS DISTINCT FROM OLD.is_suspended
       OR NEW.is_silenced IS DISTINCT FROM OLD.is_silenced
       OR NEW.force_sensitive IS DISTINCT FROM OLD.force_sensitive
    THEN
        -- Allowed only if the caller is already an admin. We do the check
        -- inline (rather than calling `public.is_current_user_admin()`) so
        -- this trigger can be installed on schemas that haven't yet applied
        -- `31_rls_policies_extended.sql` which defines that helper.
        SELECT EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.auth_user_id = auth.uid()
              AND p.is_admin = true
              AND COALESCE(p.is_suspended, false) = false
        ) INTO v_is_admin;

        IF v_is_admin IS NOT TRUE THEN
            RAISE EXCEPTION
                'Permission denied: cannot modify moderation flags (is_admin, is_moderator, is_suspended, is_silenced, force_sensitive) on profile'
                USING ERRCODE = '42501'; -- insufficient_privilege
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.prevent_profile_moderation_self_update() IS
    'BEFORE UPDATE trigger that blocks non-admin clients from setting moderation flags on profiles. Protects against client-side self-escalation through Supabase REST.';

DROP TRIGGER IF EXISTS prevent_profile_moderation_self_update_trigger ON public.profiles;
CREATE TRIGGER prevent_profile_moderation_self_update_trigger
    BEFORE UPDATE OF is_admin, is_moderator, is_suspended, is_silenced, force_sensitive
    ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_profile_moderation_self_update();

NOTIFY pgrst, 'reload schema';

COMMIT;
