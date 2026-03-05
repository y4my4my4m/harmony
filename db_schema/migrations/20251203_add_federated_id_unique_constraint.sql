-- Migration: Add unique constraint on profiles.federated_id
-- Required for ActivityPub federation upsert operations
-- Date: 2025-12-03

-- Add unique constraint on federated_id column
-- This allows ON CONFLICT (federated_id) upserts for remote user profiles
ALTER TABLE profiles 
ADD CONSTRAINT profiles_federated_id_unique 
UNIQUE (federated_id);

-- Note: If you have existing duplicate federated_id values, run this first:
-- SELECT federated_id, COUNT(*) 
-- FROM profiles 
-- WHERE federated_id IS NOT NULL 
-- GROUP BY federated_id 
-- HAVING COUNT(*) > 1;

