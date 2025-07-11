-- Fix RLS policy issue preventing post creation
-- The background job trigger needs proper permissions

-- Drop the restrictive RLS policy and replace with a better one
DROP POLICY IF EXISTS "Service role manages background jobs" ON pg_background_job;

-- Allow authenticated users to insert background jobs (but not read/update/delete others)
CREATE POLICY "Users can create background jobs" ON pg_background_job
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Allow service role to manage all background jobs  
CREATE POLICY "Service role manages all background jobs" ON pg_background_job
  FOR ALL USING (auth.role() = 'service_role');

-- Make the trigger function run with elevated privileges (SECURITY DEFINER)
CREATE OR REPLACE FUNCTION update_follower_timelines() 
RETURNS trigger 
LANGUAGE plpgsql
SECURITY DEFINER -- This makes it run with the privileges of the function owner (postgres)
AS $$
BEGIN
  -- Update home timelines for all followers
  INSERT INTO pg_background_job (
    job_type,
    payload
  ) VALUES (
    'update_follower_timelines',
    jsonb_build_object(
      'post_id', NEW.id,
      'author_id', NEW.author_id,
      'post_data', to_jsonb(NEW)
    )
  );
  
  RETURN NEW;
END;
$$;

-- Alternative: If we don't actually need the background job system yet, 
-- we can just disable the trigger temporarily
-- DROP TRIGGER IF EXISTS trigger_update_follower_timelines ON posts; 