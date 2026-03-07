-- =====================================================
-- Enforce Channel and Category Limits per Server
-- Max 100 channels per server
-- Max 25 categories per server
-- =====================================================
-- Migration: 20251211_enforce_channel_category_limits
-- This adds database-level enforcement of limits that
-- cannot be bypassed by client-side code
-- =====================================================

-- Function to check channel limit before insert
CREATE OR REPLACE FUNCTION public.check_channel_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  channel_count INTEGER;
  max_channels CONSTANT INTEGER := 100;
BEGIN
  -- Count existing channels for this server
  SELECT COUNT(*) INTO channel_count
  FROM channels
  WHERE server_id = NEW.server_id;
  
  -- Check if limit would be exceeded
  IF channel_count >= max_channels THEN
    RAISE EXCEPTION 'Channel limit exceeded: Maximum % channels per server', max_channels
      USING ERRCODE = 'check_violation';
  END IF;
  
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_channel_limit() IS 
'Enforces maximum 100 channels per server';

-- Function to check category limit before insert
CREATE OR REPLACE FUNCTION public.check_category_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  category_count INTEGER;
  max_categories CONSTANT INTEGER := 25;
BEGIN
  -- Count existing categories for this server
  SELECT COUNT(*) INTO category_count
  FROM channel_categories
  WHERE server_id = NEW.server_id;
  
  -- Check if limit would be exceeded
  IF category_count >= max_categories THEN
    RAISE EXCEPTION 'Category limit exceeded: Maximum % categories per server', max_categories
      USING ERRCODE = 'check_violation';
  END IF;
  
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_category_limit() IS 
'Enforces maximum 25 categories per server';

-- Drop existing triggers if they exist (idempotent)
DROP TRIGGER IF EXISTS enforce_channel_limit ON public.channels;
DROP TRIGGER IF EXISTS enforce_category_limit ON public.channel_categories;

-- Create trigger for channels
CREATE TRIGGER enforce_channel_limit
  BEFORE INSERT ON public.channels
  FOR EACH ROW
  EXECUTE FUNCTION public.check_channel_limit();

-- Create trigger for categories
CREATE TRIGGER enforce_category_limit
  BEFORE INSERT ON public.channel_categories
  FOR EACH ROW
  EXECUTE FUNCTION public.check_category_limit();

DO $$
BEGIN
    RAISE NOTICE 'Channel and category limits enforced: max 100 channels, max 25 categories per server';
END $$;

