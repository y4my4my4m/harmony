BEGIN;

-- The federation_delivery_queue status constraint was missing 'delivered' and 'cancelled'
-- which are used by the federation backend (DeliveryQueue.ts).
-- This migration aligns the constraint with what the code actually uses.

ALTER TABLE public.federation_delivery_queue
  DROP CONSTRAINT IF EXISTS federation_delivery_queue_status_check;

ALTER TABLE public.federation_delivery_queue
  ADD CONSTRAINT federation_delivery_queue_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead', 'delivered', 'cancelled'));

NOTIFY pgrst, 'reload schema';

COMMIT;
