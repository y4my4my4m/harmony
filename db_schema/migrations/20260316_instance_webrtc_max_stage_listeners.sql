-- Add max_stage_listeners to instance_webrtc_settings (used by AdminService)
BEGIN;

ALTER TABLE public.instance_webrtc_settings
  ADD COLUMN IF NOT EXISTS max_stage_listeners integer DEFAULT 100000 NOT NULL;

COMMENT ON COLUMN public.instance_webrtc_settings.max_stage_listeners IS 'Maximum number of listeners in a stage/voice channel';

COMMIT;
