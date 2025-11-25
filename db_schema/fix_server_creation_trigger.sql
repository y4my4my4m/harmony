-- Fix: Create default channels and categories when a new server is created
-- This migration creates/updates the trigger function and adds a trigger on servers table

-- Drop existing function if it exists (to recreate with correct table names)
DROP FUNCTION IF EXISTS public.create_default_server_structure(uuid);

-- Create the function to set up default server structure
-- Uses correct table names: channel_categories (not categories) and channels
-- Uses correct column names: "order" (not position), category (not category_id)
CREATE OR REPLACE FUNCTION public.create_default_server_structure(p_server_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_text_category_id uuid;
  v_voice_category_id uuid;
BEGIN
  -- Create default TEXT CHANNELS category
  INSERT INTO public.channel_categories (server_id, name, "order")
  VALUES (p_server_id, 'Text Channels', 0)
  RETURNING id INTO v_text_category_id;

  -- Create default general text channel under the text category
  INSERT INTO public.channels (server_id, name, type, category, "order")
  VALUES (p_server_id, 'general', 0, v_text_category_id, 0);

  -- Create default VOICE CHANNELS category
  INSERT INTO public.channel_categories (server_id, name, "order")
  VALUES (p_server_id, 'Voice Channels', 1)
  RETURNING id INTO v_voice_category_id;

  -- Create default General voice channel under the voice category
  INSERT INTO public.channels (server_id, name, type, category, "order")
  VALUES (p_server_id, 'General', 2, v_voice_category_id, 0);

  RAISE NOTICE 'Created default structure for server %: text category %, voice category %', 
    p_server_id, v_text_category_id, v_voice_category_id;
END;
$$;

COMMENT ON FUNCTION public.create_default_server_structure(p_server_id uuid) 
IS 'Create default channels and categories when a server is created. Creates Text Channels category with #general, and Voice Channels category with General voice channel.';

-- Create trigger function to call create_default_server_structure on server insert
CREATE OR REPLACE FUNCTION public.trigger_create_default_server_structure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Create default channels and categories for the new server
  PERFORM public.create_default_server_structure(NEW.id);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trigger_create_default_server_structure()
IS 'Trigger function that automatically creates default channels and categories when a new server is created.';

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS auto_create_default_server_structure ON public.servers;

-- Create trigger on servers table
CREATE TRIGGER auto_create_default_server_structure
  AFTER INSERT ON public.servers
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_create_default_server_structure();

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.create_default_server_structure(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_create_default_server_structure() TO authenticated;

