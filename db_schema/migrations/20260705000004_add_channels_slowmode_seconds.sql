BEGIN;

-- Existing DBs never got slowmode_seconds; trigger_queue_channel_federation
-- references OLD.slowmode_seconds and fails to plan on any channel write.
ALTER TABLE public.channels ADD COLUMN IF NOT EXISTS slowmode_seconds integer DEFAULT 0;

NOTIFY pgrst, 'reload schema';

COMMIT;
