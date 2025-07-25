-- Fix the unique constraint for post_interactions to allow multiple different emoji reactions per user per post
-- Current constraint prevents multiple emoji reactions from same user on same post
-- New constraint allows multiple emojis but prevents duplicate reactions to same emoji

-- Drop the existing constraint
DROP INDEX IF EXISTS idx_post_interactions_unique;

-- Create a new constraint that allows multiple emoji reactions but prevents duplicate emoji reactions
CREATE UNIQUE INDEX idx_post_interactions_emoji_unique ON public.post_interactions 
USING btree (user_id, post_id, interaction_type, emoji_id, custom_emoji_content) 
WHERE interaction_type = 'emoji_reaction';

-- Keep the original constraint for non-emoji interactions (likes, reblogs, bookmarks)
CREATE UNIQUE INDEX idx_post_interactions_non_emoji_unique ON public.post_interactions 
USING btree (user_id, post_id, interaction_type) 
WHERE interaction_type != 'emoji_reaction';

COMMENT ON INDEX idx_post_interactions_emoji_unique IS 'Prevents duplicate emoji reactions but allows multiple different emojis per user per post';
COMMENT ON INDEX idx_post_interactions_non_emoji_unique IS 'Maintains uniqueness for non-emoji interactions (likes, reblogs, bookmarks)';
