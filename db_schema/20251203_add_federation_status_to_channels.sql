-- Migration: Add federation_status to channels and channel_categories
-- This enables pg-boss sweep-based federation for channel/category CRUD

-- Add federation_status to channels table
ALTER TABLE channels 
ADD COLUMN IF NOT EXISTS federation_status TEXT 
DEFAULT 'pending' 
CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'));

-- Add federation_status to channel_categories table
ALTER TABLE channel_categories 
ADD COLUMN IF NOT EXISTS federation_status TEXT 
DEFAULT 'pending' 
CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'));

-- For existing channels/categories, mark as completed (they don't need federation)
UPDATE channels SET federation_status = 'completed' WHERE federation_status = 'pending';
UPDATE channel_categories SET federation_status = 'completed' WHERE federation_status = 'pending';

-- Create index for efficient sweep queries
CREATE INDEX IF NOT EXISTS idx_channels_federation_status ON channels(federation_status) WHERE federation_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_channel_categories_federation_status ON channel_categories(federation_status) WHERE federation_status = 'pending';

