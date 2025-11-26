-- Fix: moderate_user function has two issues:
-- 1. Uses json_build_object but log_admin_action expects jsonb
-- 2. Admin check uses profiles.id but p_admin_id is auth.uid() (should use auth_user_id)
--
-- Note on ID types:
-- - p_admin_id = auth.uid() from the frontend session
-- - p_target_user_id = profiles.id from the user list query
-- - profiles.id = random UUID (profile's own ID)
-- - profiles.auth_user_id = auth.uid() (links profile to auth user)

CREATE OR REPLACE FUNCTION public.moderate_user(
    p_admin_id uuid, 
    p_target_user_id uuid, 
    p_action text, 
    p_reason text DEFAULT NULL::text
) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    target_username TEXT;
    admin_profile_id UUID;
BEGIN
    -- Check if admin has permission
    -- p_admin_id is auth.uid(), so we need to check via auth_user_id
    SELECT id INTO admin_profile_id 
    FROM profiles 
    WHERE auth_user_id = p_admin_id AND is_admin = TRUE;
    
    IF admin_profile_id IS NULL THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    
    -- Get target username for logging
    -- p_target_user_id is profiles.id, so we use id directly
    SELECT username INTO target_username FROM profiles WHERE id = p_target_user_id;
    
    IF target_username IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;
    
    IF p_action = 'suspend' THEN
        UPDATE profiles 
        SET 
            is_suspended = TRUE,
            suspended_at = NOW(),
            suspension_reason = p_reason
        WHERE id = p_target_user_id;
        
        -- Log the action using admin's profile ID for consistency
        -- Using jsonb_build_object instead of json_build_object
        PERFORM log_admin_action(
            admin_profile_id,
            'user_suspend',
            'user',
            p_target_user_id::TEXT,
            jsonb_build_object('reason', p_reason, 'username', target_username)
        );
        
    ELSIF p_action = 'unsuspend' THEN
        UPDATE profiles 
        SET 
            is_suspended = FALSE,
            suspended_at = NULL,
            suspension_reason = NULL
        WHERE id = p_target_user_id;
        
        -- Log the action using admin's profile ID for consistency
        -- Using jsonb_build_object instead of json_build_object
        PERFORM log_admin_action(
            admin_profile_id,
            'user_unsuspend',
            'user',
            p_target_user_id::TEXT,
            jsonb_build_object('username', target_username)
        );
    ELSE
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;
    
    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION public.moderate_user IS 'Admin function to suspend/unsuspend users. p_admin_id expects auth.uid(), p_target_user_id expects profiles.id';

