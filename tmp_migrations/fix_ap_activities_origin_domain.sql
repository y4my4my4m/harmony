-- Fix ap_activities table to ensure origin_domain column exists
-- This is needed for the inbox function to work properly

-- First, ensure the ap_activities table exists
CREATE TABLE IF NOT EXISTS ap_activities (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- ActivityPub activity details
    ap_id TEXT NOT NULL UNIQUE,
    ap_type TEXT NOT NULL, -- 'Create', 'Update', 'Delete', 'Follow', 'Accept', 'Reject', etc.
    actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    target_id UUID, -- Can reference posts, profiles, etc.
    target_type TEXT, -- 'post', 'profile', etc.
    
    -- Activity data
    activity_data JSONB NOT NULL,
    
    -- Processing state
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    processed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    
    -- Delivery tracking
    is_local BOOLEAN DEFAULT false,
    origin_domain TEXT,
    
    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Add the origin_domain column if it doesn't exist
ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS origin_domain TEXT;

-- Update existing status values to match the new schema
UPDATE ap_activities SET status = 'pending' WHERE status = 'received';
UPDATE ap_activities SET status = 'completed' WHERE status = 'processed';

-- Update the constraint to match what the inbox function expects
ALTER TABLE ap_activities DROP CONSTRAINT IF EXISTS ap_activities_status_check;
ALTER TABLE ap_activities ADD CONSTRAINT ap_activities_status_check 
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'received', 'processed'));

-- Add indexes if they don't exist
CREATE INDEX IF NOT EXISTS idx_ap_activities_ap_id ON ap_activities(ap_id);
CREATE INDEX IF NOT EXISTS idx_ap_activities_actor_id ON ap_activities(actor_id);
CREATE INDEX IF NOT EXISTS idx_ap_activities_type ON ap_activities(ap_type);
CREATE INDEX IF NOT EXISTS idx_ap_activities_status ON ap_activities(status);
CREATE INDEX IF NOT EXISTS idx_ap_activities_created_at ON ap_activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ap_activities_origin_domain ON ap_activities(origin_domain);

-- Enable RLS if not already enabled
ALTER TABLE ap_activities ENABLE ROW LEVEL SECURITY;

-- Add RLS policy for system operations
DROP POLICY IF EXISTS "System can manage ActivityPub activities" ON ap_activities;
CREATE POLICY "System can manage ActivityPub activities" ON ap_activities
    FOR ALL USING (true);
