-- Migration 030: Fix Trigger Field Reference
-- 
-- ISSUE: handle_unified_content_federation() tries to access NEW.author_id on messages table
-- CAUSE: Messages table uses 'user_id' field, but posts table uses 'author_id' field
-- SOLUTION: Update trigger function to use correct field names for each table
--
-- ERROR FIXED: "record \"new\" has no field \"author_id\""

BEGIN;

-- Fix the unified content federation function to use correct field names
CREATE OR REPLACE FUNCTION handle_unified_content_federation() 
RETURNS TRIGGER AS $$
DECLARE
  user_id_value uuid;
  should_federate boolean := false;
  federation_enabled boolean := false;
BEGIN
  -- Determine the user_id based on the table
  IF TG_TABLE_NAME = 'posts' THEN
    user_id_value := NEW.author_id;  -- Posts use author_id
  ELSIF TG_TABLE_NAME = 'messages' THEN
    user_id_value := NEW.user_id;    -- Messages use user_id
  ELSE
    -- Skip federation for other tables
    RETURN NEW;
  END IF;

  -- Check if federation is enabled for this instance
  SELECT COALESCE(enable_federation, false) INTO federation_enabled
  FROM instance_settings
  LIMIT 1;

  -- Skip if federation is disabled
  IF NOT federation_enabled THEN
    RETURN NEW;
  END IF;

  -- Check if user has federation enabled (if applicable)
  IF user_id_value IS NOT NULL THEN
    SELECT COALESCE(enable_federation, true) INTO should_federate
    FROM profiles 
    WHERE id = user_id_value;

    -- Skip if user has federation disabled
    IF NOT should_federate THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Create federation activity (simplified logic)
  INSERT INTO ap_activities (
    activity_type,
    actor_id,
    object_type,
    object_id,
    target_audience,
    activity_data,
    status
  ) VALUES (
    'Create',
    user_id_value,
    TG_TABLE_NAME,  -- 'posts' or 'messages'
    NEW.id,
    CASE 
      WHEN TG_TABLE_NAME = 'posts' THEN NEW.visibility::text
      WHEN TG_TABLE_NAME = 'messages' THEN 'direct'  -- DMs are direct
      ELSE 'public'
    END,
    jsonb_build_object(
      'content', NEW.content,
      'created_at', NEW.created_at
    ),
    'pending'
  );

  RETURN NEW;
EXCEPTION 
  WHEN OTHERS THEN
    -- Log error but don't block the operation
    RAISE WARNING 'Federation trigger failed for % %: %', TG_TABLE_NAME, NEW.id, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Ensure triggers are properly set up for both tables
DROP TRIGGER IF EXISTS unified_content_federation_trigger ON posts;
DROP TRIGGER IF EXISTS unified_content_federation_trigger ON messages;

-- Create triggers for both tables
CREATE TRIGGER unified_content_federation_trigger
  AFTER INSERT ON posts
  FOR EACH ROW
  EXECUTE FUNCTION handle_unified_content_federation();

CREATE TRIGGER unified_content_federation_trigger
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION handle_unified_content_federation();

COMMIT;