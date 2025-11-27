-- Migration: Fix reaction counts for local and remote posts
-- Issue: emoji_reaction interactions don't increment favorites_count on posts

-- Create function to update post reaction counts
CREATE OR REPLACE FUNCTION public.update_post_reaction_counts()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Increment count for new reactions
    IF NEW.interaction_type = 'emoji_reaction' OR NEW.interaction_type = 'favorite' THEN
      UPDATE posts
      SET favorites_count = favorites_count + 1
      WHERE id = NEW.post_id;
    ELSIF NEW.interaction_type = 'reblog' THEN
      UPDATE posts
      SET reblogs_count = reblogs_count + 1
      WHERE id = NEW.post_id;
    END IF;
    RETURN NEW;
    
  ELSIF TG_OP = 'DELETE' THEN
    -- Decrement count for removed reactions
    IF OLD.interaction_type = 'emoji_reaction' OR OLD.interaction_type = 'favorite' THEN
      UPDATE posts
      SET favorites_count = GREATEST(favorites_count - 1, 0)
      WHERE id = OLD.post_id;
    ELSIF OLD.interaction_type = 'reblog' THEN
      UPDATE posts
      SET reblogs_count = GREATEST(reblogs_count - 1, 0)
      WHERE id = OLD.post_id;
    END IF;
    RETURN OLD;
  END IF;
  
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS trigger_update_post_reaction_counts ON public.post_interactions;

-- Create trigger to automatically update counts
CREATE TRIGGER trigger_update_post_reaction_counts
  AFTER INSERT OR DELETE ON public.post_interactions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_post_reaction_counts();

-- Also fix existing posts that have reactions but zero counts
-- This is a one-time fix to sync counts with actual reaction data

-- Update favorites_count based on actual reactions
UPDATE posts p
SET favorites_count = (
  SELECT COUNT(*) 
  FROM post_interactions pi 
  WHERE pi.post_id = p.id 
    AND pi.interaction_type IN ('emoji_reaction', 'favorite')
)
WHERE favorites_count = 0
  AND EXISTS (
    SELECT 1 FROM post_interactions pi 
    WHERE pi.post_id = p.id 
      AND pi.interaction_type IN ('emoji_reaction', 'favorite')
  );

-- Update reblogs_count based on actual reblogs
UPDATE posts p
SET reblogs_count = (
  SELECT COUNT(*) 
  FROM post_interactions pi 
  WHERE pi.post_id = p.id 
    AND pi.interaction_type = 'reblog'
)
WHERE reblogs_count = 0
  AND EXISTS (
    SELECT 1 FROM post_interactions pi 
    WHERE pi.post_id = p.id 
      AND pi.interaction_type = 'reblog'
  );

COMMENT ON FUNCTION public.update_post_reaction_counts() IS 'Automatically updates post favorites_count and reblogs_count when reactions are added or removed';

