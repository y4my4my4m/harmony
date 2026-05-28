-- =============================================================================
-- Migration: Add allow_custom_emojis_in_display_names instance config
-- =============================================================================
-- Allows instance owners to disable custom emojis in display names.
-- When off: emojis don't display, users can't add them to display names.
-- When on: current behavior (emojis display and can be added).
-- =============================================================================

BEGIN;

INSERT INTO instance_config (config_key, config_value, description, updated_at)
VALUES ('allow_custom_emojis_in_display_names', 'true', 'Whether users can use custom emojis in their display names (e.g. :emoji:). When off, emojis are hidden and cannot be added.', now())
ON CONFLICT (config_key) DO NOTHING;

COMMIT;
