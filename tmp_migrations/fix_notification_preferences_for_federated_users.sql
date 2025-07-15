-- Fix notification preferences creation to only apply to local users
-- Remote federated users should not have notification preferences created

-- Drop the existing function and recreate it with proper logic
DROP FUNCTION IF EXISTS public.create_notification_preferences() CASCADE;

CREATE OR REPLACE FUNCTION public.create_notification_preferences() 
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Only create notification preferences for local users
    -- Remote federated users manage their notifications on their own instances
    IF NEW.is_local = true OR NEW.is_local IS NULL THEN
        INSERT INTO notification_preferences (user_id)
        VALUES (NEW.id);
    END IF;
    
    RETURN NEW;
END;
$$;

-- Recreate the trigger
CREATE TRIGGER create_notification_preferences_trigger 
    AFTER INSERT ON public.profiles 
    FOR EACH ROW 
    EXECUTE FUNCTION public.create_notification_preferences();

-- Comment explaining the logic
COMMENT ON FUNCTION public.create_notification_preferences() IS 
'Creates notification preferences only for local users. Remote federated users manage notifications on their own instances.';
