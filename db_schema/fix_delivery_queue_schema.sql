-- ============================================
-- Fix federation_delivery_queue Schema
-- ============================================
-- Ensure the table has all columns that DeliveryQueue code expects
-- ============================================

-- Add missing columns that DeliveryQueue code expects
ALTER TABLE federation_delivery_queue 
ADD COLUMN IF NOT EXISTS last_attempt_at timestamp with time zone;

ALTER TABLE federation_delivery_queue 
ADD COLUMN IF NOT EXISTS next_retry_at timestamp with time zone;

ALTER TABLE federation_delivery_queue 
ADD COLUMN IF NOT EXISTS activity_data jsonb;

ALTER TABLE federation_delivery_queue 
ADD COLUMN IF NOT EXISTS sender_id uuid;

ALTER TABLE federation_delivery_queue 
ADD COLUMN IF NOT EXISTS target_inbox text;

-- Comment
COMMENT ON TABLE federation_delivery_queue IS 'Queue for federated activity delivery with retry logic';

-- Verify schema
DO $$
DECLARE
  col_record RECORD;
BEGIN
  RAISE NOTICE 'Federation delivery queue columns:';
  FOR col_record IN 
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns 
    WHERE table_name = 'federation_delivery_queue'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  - %: % (nullable: %, default: %)', 
      col_record.column_name, 
      col_record.data_type, 
      col_record.is_nullable,
      col_record.column_default;
  END LOOP;
END $$;

