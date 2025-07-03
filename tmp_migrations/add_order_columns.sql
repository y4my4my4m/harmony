-- Add order column to channels table
ALTER TABLE channels 
ADD COLUMN IF NOT EXISTS "order" INTEGER DEFAULT 0;

-- Add order column to channel_categories table (if it doesn't exist)
ALTER TABLE channel_categories 
ADD COLUMN IF NOT EXISTS "order" INTEGER DEFAULT 0;

-- Update existing channels with proper order values
-- Set order based on creation time for existing channels
WITH ordered_channels AS (
  SELECT 
    id,
    ROW_NUMBER() OVER (PARTITION BY server_id, category ORDER BY created_at) - 1 as new_order
  FROM channels
)
UPDATE channels 
SET "order" = ordered_channels.new_order
FROM ordered_channels
WHERE channels.id = ordered_channels.id;

-- Update existing categories with proper order values
-- Set order based on creation time for existing categories
WITH ordered_categories AS (
  SELECT 
    id,
    ROW_NUMBER() OVER (PARTITION BY server_id ORDER BY created_at) - 1 as new_order
  FROM channel_categories
)
UPDATE channel_categories 
SET "order" = ordered_categories.new_order
FROM ordered_categories
WHERE channel_categories.id = ordered_categories.id;

-- Add indexes for better performance on ordering queries
CREATE INDEX IF NOT EXISTS idx_channels_server_order ON channels(server_id, "order");
CREATE INDEX IF NOT EXISTS idx_channels_category_order ON channels(category, "order");
CREATE INDEX IF NOT EXISTS idx_categories_server_order ON channel_categories(server_id, "order");
