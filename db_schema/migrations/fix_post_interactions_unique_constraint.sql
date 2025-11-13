-- Fix the post_interactions unique constraint to allow multiple emoji reactions per user per post
-- but prevent duplicate reactions to the same emoji

-- Drop the existing constraint that prevents multiple emoji reactions
DROP INDEX IF EXISTS idx_post_interactions_unique;

-- Create separate unique constraints for different interaction types

-- For non-emoji interactions (like, reblog, bookmark), keep the original constraint
CREATE UNIQUE INDEX idx_post_interactions_unique_non_emoji 
ON public.post_interactions (user_id, post_id, interaction_type) 
WHERE interaction_type != 'emoji_reaction';

-- For emoji reactions, prevent duplicate reactions to the same emoji
-- Allow either emoji_id (custom server emojis) OR custom_emoji_content (unicode/text emojis) but not both
CREATE UNIQUE INDEX idx_post_interactions_unique_emoji_by_id 
ON public.post_interactions (user_id, post_id, interaction_type, emoji_id) 
WHERE interaction_type = 'emoji_reaction' AND emoji_id IS NOT NULL;

CREATE UNIQUE INDEX idx_post_interactions_unique_emoji_by_content 
ON public.post_interactions (user_id, post_id, interaction_type, custom_emoji_content) 
WHERE interaction_type = 'emoji_reaction' AND custom_emoji_content IS NOT NULL;

COMMENT ON INDEX idx_post_interactions_unique_non_emoji IS 'Ensures unique interactions per user per post for non-emoji interactions (like, reblog, bookmark, etc.)';
COMMENT ON INDEX idx_post_interactions_unique_emoji_by_id IS 'Prevents duplicate emoji reactions using emoji_id (custom server emojis)';
COMMENT ON INDEX idx_post_interactions_unique_emoji_by_content IS 'Prevents duplicate emoji reactions using custom_emoji_content (unicode/text emojis)';
