-- Add metadata column to messages table for federation support
-- This column will store federation metadata like ActivityPub IDs, domains, etc.

ALTER TABLE messages 
ADD COLUMN metadata JSONB DEFAULT NULL;

-- Add index for efficient queries on federation metadata
CREATE INDEX IF NOT EXISTS idx_messages_metadata_federated 
ON messages USING GIN (metadata) 
WHERE metadata IS NOT NULL;

-- Add index for ActivityPub ID lookups
CREATE INDEX IF NOT EXISTS idx_messages_metadata_ap_id 
ON messages ((metadata->>'ap_id')) 
WHERE metadata->>'ap_id' IS NOT NULL;

-- Add index for federated domain queries
CREATE INDEX IF NOT EXISTS idx_messages_metadata_from_domain 
ON messages ((metadata->>'from_domain')) 
WHERE metadata->>'from_domain' IS NOT NULL;

-- Add comment to document the column
COMMENT ON COLUMN messages.metadata IS 'JSON metadata for federation info including ap_id, from_domain, original_url, etc.';
