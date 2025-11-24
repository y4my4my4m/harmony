-- =====================================================
-- REPAIR: SERVER ENCRYPTION SETTINGS TABLE
-- Recreates the table with ORIGINAL structure from e2ee_schema.sql
-- =====================================================

-- Drop the broken table if it exists
DROP TABLE IF EXISTS public.server_encryption_settings CASCADE;

-- Recreate with ORIGINAL structure from e2ee_schema.sql
CREATE TABLE public.server_encryption_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id UUID NOT NULL UNIQUE REFERENCES public.servers(id) ON DELETE CASCADE,
    
    -- Encryption policy
    encryption_mode TEXT DEFAULT 'optional' CHECK (encryption_mode IN ('disabled', 'optional', 'required', 'required_local_only')),
    
    -- Policy details (ORIGINAL columns)
    allow_federation BOOLEAN DEFAULT true, -- If false and encryption_mode='required', blocks federation
    require_verified_devices BOOLEAN DEFAULT false, -- Future: require device verification
    
    -- NEW columns for UI
    force_key_setup BOOLEAN DEFAULT false NOT NULL,
    encrypt_attachments BOOLEAN DEFAULT true NOT NULL,
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by UUID REFERENCES public.profiles(id),
    
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Create indexes
CREATE INDEX idx_server_encryption_server_id ON public.server_encryption_settings(server_id);

-- Comments
COMMENT ON TABLE public.server_encryption_settings IS 'Per-server E2EE enforcement policies. Server owners control encryption requirements.';
COMMENT ON COLUMN public.server_encryption_settings.encryption_mode IS 'disabled: No E2EE. optional: User choice. required: All messages encrypted. required_local_only: E2EE required, federation disabled.';
COMMENT ON COLUMN public.server_encryption_settings.allow_federation IS 'If false and encryption_mode=required, blocks federation';
COMMENT ON COLUMN public.server_encryption_settings.require_verified_devices IS 'Future: require device verification';
COMMENT ON COLUMN public.server_encryption_settings.force_key_setup IS 'If true, prompt users without keys to set up encryption';
COMMENT ON COLUMN public.server_encryption_settings.encrypt_attachments IS 'If true, apply encryption to file attachments';

-- =====================================================
-- ENABLE ROW LEVEL SECURITY
-- =====================================================

ALTER TABLE public.server_encryption_settings ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- RLS POLICIES (from e2ee_schema.sql)
-- =====================================================

DROP POLICY IF EXISTS "Everyone can view server encryption settings" ON public.server_encryption_settings;
CREATE POLICY "Everyone can view server encryption settings"
    ON public.server_encryption_settings FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "Server owners can manage encryption settings" ON public.server_encryption_settings;
CREATE POLICY "Server owners can manage encryption settings"
    ON public.server_encryption_settings FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.servers
            JOIN public.profiles ON profiles.id = servers.owner
            WHERE servers.id = server_encryption_settings.server_id
            AND profiles.auth_user_id = auth.uid()
        )
    );

-- =====================================================
-- TRIGGER (from e2ee_schema.sql)
-- =====================================================

-- The update_encryption_timestamp() function should already exist from e2ee_schema.sql
-- Just create the trigger

DROP TRIGGER IF EXISTS update_server_encryption_settings_timestamp ON public.server_encryption_settings;
CREATE TRIGGER update_server_encryption_settings_timestamp
    BEFORE UPDATE ON public.server_encryption_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.update_encryption_timestamp();

-- =====================================================
-- GRANTS (from e2ee_schema.sql)
-- =====================================================

GRANT SELECT ON public.server_encryption_settings TO authenticated;
GRANT INSERT, UPDATE ON public.server_encryption_settings TO authenticated;

-- =====================================================
-- VERIFY REPAIR
-- =====================================================

DO $$
DECLARE
  v_column_count INTEGER;
BEGIN
  -- Check if table was created with all columns
  SELECT COUNT(*) INTO v_column_count
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
  AND table_name = 'server_encryption_settings';
  
  IF v_column_count >= 10 THEN
    RAISE NOTICE '✅ Table repaired successfully with % columns', v_column_count;
    RAISE NOTICE '   Original columns: id, server_id, encryption_mode, allow_federation, require_verified_devices';
    RAISE NOTICE '   New columns: force_key_setup, encrypt_attachments';
    RAISE NOTICE '   Metadata: created_at, updated_at, updated_by, metadata';
  ELSE
    RAISE EXCEPTION '❌ Repair failed: Only % columns found', v_column_count;
  END IF;
END
$$;

-- =====================================================
-- REPAIR COMPLETE
-- =====================================================
-- Table recreated with:
-- ✅ All original columns from e2ee_schema.sql
-- ✅ Two new columns (force_key_setup, encrypt_attachments)
-- ✅ Original indexes, policies, triggers
-- ✅ Original grants
-- 
-- Next step: Run server_encryption_policy.sql to add the helper function
-- =====================================================

