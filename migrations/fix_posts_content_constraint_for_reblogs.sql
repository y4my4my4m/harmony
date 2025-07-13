-- Fix posts_content_not_empty constraint to allow empty content for reblogs
-- This allows pure reblogs (without quotes) to have empty content when reblog field is present

-- Drop the existing constraint
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_content_not_empty;

-- Add the updated constraint that allows empty content when reblog is present
ALTER TABLE posts ADD CONSTRAINT posts_content_not_empty 
CHECK (
    (jsonb_array_length(content) > 0) OR 
    (reblog IS NOT NULL)
);

-- Add a comment explaining the constraint
COMMENT ON CONSTRAINT posts_content_not_empty ON posts IS 
'Ensures posts have content OR are reblogs. Pure reblogs can have empty content if reblog field is present.';
