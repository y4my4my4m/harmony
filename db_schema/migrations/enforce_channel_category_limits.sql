-- =====================================================
-- Enforce Channel and Category Limits per Server
-- Max 100 channels per server
-- Max 25 categories per server
-- =====================================================

-- Function to check channel limit before insert
CREATE OR REPLACE FUNCTION check_channel_limit()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql;

-- Function to check category limit before insert
CREATE OR REPLACE FUNCTION check_category_limit()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql;

-- Drop existing triggers if they exist (idempotent)
DROP TRIGGER IF EXISTS enforce_channel_limit ON channels;
DROP TRIGGER IF EXISTS enforce_category_limit ON channel_categories;

-- Create trigger for channels
CREATE TRIGGER enforce_channel_limit
  BEFORE INSERT ON channels
  FOR EACH ROW
  EXECUTE FUNCTION check_channel_limit();

-- Create trigger for categories
CREATE TRIGGER enforce_category_limit
  BEFORE INSERT ON channel_categories
  FOR EACH ROW
  EXECUTE FUNCTION check_category_limit();

-- Add comments for documentation
COMMENT ON FUNCTION check_channel_limit() IS 'Enforces maximum 100 channels per server';
COMMENT ON FUNCTION check_category_limit() IS 'Enforces maximum 25 categories per server';

