-- Migration: Federation Tables
-- Adds tables for reports and profile fields to support federation features

-- =====================================================
-- REPORTS TABLE
-- Stores both local and federated reports/flags
-- =====================================================

CREATE TABLE IF NOT EXISTS public.reports (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    reporter_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    reported_user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    reported_post_id uuid REFERENCES public.posts(id) ON DELETE SET NULL,
    reason text NOT NULL,
    report_type text NOT NULL CHECK (report_type IN ('user', 'post', 'message', 'server')),
    source text DEFAULT 'local' CHECK (source IN ('local', 'federation')),
    source_instance text, -- For federated reports, the instance that sent it
    status text DEFAULT 'pending' CHECK (status IN ('pending', 'investigating', 'resolved', 'dismissed')),
    resolution_note text,
    resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    resolved_at timestamp with time zone,
    ap_id text UNIQUE, -- ActivityPub ID for federated reports
    metadata jsonb DEFAULT '{}',
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON public.reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported_user ON public.reports(reported_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON public.reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_ap_id ON public.reports(ap_id);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON public.reports(created_at DESC);

-- Comments
COMMENT ON TABLE public.reports IS 'User/content reports for moderation, supporting both local and federated reports';
COMMENT ON COLUMN public.reports.source IS 'Whether this report was created locally or received via federation';
COMMENT ON COLUMN public.reports.source_instance IS 'The domain of the instance that sent a federated report';
COMMENT ON COLUMN public.reports.ap_id IS 'ActivityPub ID for federated Flag activities';


-- =====================================================
-- PROFILE FIELDS (Custom fields like Website, Location)
-- Added as JSONB column on profiles table
-- =====================================================

-- Add profile_fields column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'profiles' 
        AND column_name = 'profile_fields'
    ) THEN
        ALTER TABLE public.profiles 
        ADD COLUMN profile_fields jsonb DEFAULT '[]'::jsonb;
        
        COMMENT ON COLUMN public.profiles.profile_fields IS 
            'Custom profile fields (PropertyValue in ActivityPub). Array of {name, value} objects.';
    END IF;
END $$;


-- =====================================================
-- USER_BLOCKS TABLE UPDATES
-- Ensure user_blocks table supports federation
-- =====================================================

-- Add ap_id column for federated blocks if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'user_blocks' 
        AND column_name = 'ap_id'
    ) THEN
        ALTER TABLE public.user_blocks 
        ADD COLUMN ap_id text UNIQUE;
        
        COMMENT ON COLUMN public.user_blocks.ap_id IS 'ActivityPub ID for federated Block activities';
    END IF;
END $$;

-- Add is_federated column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'user_blocks' 
        AND column_name = 'is_federated'
    ) THEN
        ALTER TABLE public.user_blocks 
        ADD COLUMN is_federated boolean DEFAULT false;
        
        COMMENT ON COLUMN public.user_blocks.is_federated IS 'Whether this block was received via federation';
    END IF;
END $$;


-- =====================================================
-- MEDIA ATTACHMENTS METADATA
-- Add blurhash and dimensions columns to posts if needed
-- =====================================================

-- Note: media_attachments is already a JSONB column that should support these fields
-- The application code stores: url, type, mimeType, width, height, blurhash, altText
-- No schema changes needed for this, just documenting the expected structure


-- =====================================================
-- RLS POLICIES FOR REPORTS
-- =====================================================

-- Enable RLS
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (for idempotent migrations)
DROP POLICY IF EXISTS "Admins can view all reports" ON public.reports;
DROP POLICY IF EXISTS "Users can view own reports" ON public.reports;
DROP POLICY IF EXISTS "Users can create reports" ON public.reports;
DROP POLICY IF EXISTS "Admins can update reports" ON public.reports;

-- Admins can view all reports
CREATE POLICY "Admins can view all reports" 
    ON public.reports FOR SELECT 
    TO authenticated 
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE id = auth.uid() 
            AND is_admin = true
        )
    );

-- Users can view their own reports (that they created)
CREATE POLICY "Users can view own reports" 
    ON public.reports FOR SELECT 
    TO authenticated 
    USING (reporter_id = auth.uid());

-- Users can create reports
CREATE POLICY "Users can create reports" 
    ON public.reports FOR INSERT 
    TO authenticated 
    WITH CHECK (reporter_id = auth.uid());

-- Admins can update reports
CREATE POLICY "Admins can update reports" 
    ON public.reports FOR UPDATE 
    TO authenticated 
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE id = auth.uid() 
            AND is_admin = true
        )
    );


-- =====================================================
-- UTILITY FUNCTIONS
-- =====================================================

-- Function to get pending reports count (for admin dashboard)
CREATE OR REPLACE FUNCTION public.get_pending_reports_count()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT COUNT(*)::integer
    FROM public.reports
    WHERE status = 'pending';
$$;

COMMENT ON FUNCTION public.get_pending_reports_count() IS 
    'Returns count of pending reports for admin dashboard';


-- Function to get reports with user details
CREATE OR REPLACE FUNCTION public.get_reports_with_details(
    p_status text DEFAULT NULL,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0
)
RETURNS TABLE(
    id uuid,
    reporter_username text,
    reporter_display_name text,
    reporter_avatar_url text,
    reported_user_username text,
    reported_user_display_name text,
    reported_user_avatar_url text,
    reported_post_preview text,
    reason text,
    report_type text,
    source text,
    source_instance text,
    status text,
    resolution_note text,
    created_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r.id,
        reporter.username::text,
        reporter.display_name::text,
        reporter.avatar_url::text,
        reported_user.username::text,
        reported_user.display_name::text,
        reported_user.avatar_url::text,
        CASE 
            WHEN r.reported_post_id IS NOT NULL THEN
                LEFT(
                    COALESCE(
                        (SELECT p.content->0->>'text' FROM public.posts p WHERE p.id = r.reported_post_id),
                        '[Post content unavailable]'
                    ),
                    200
                )
            ELSE NULL
        END::text,
        r.reason,
        r.report_type,
        r.source,
        r.source_instance,
        r.status,
        r.resolution_note,
        r.created_at
    FROM public.reports r
    LEFT JOIN public.profiles reporter ON r.reporter_id = reporter.id
    LEFT JOIN public.profiles reported_user ON r.reported_user_id = reported_user.id
    WHERE (p_status IS NULL OR r.status = p_status)
    ORDER BY r.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

COMMENT ON FUNCTION public.get_reports_with_details(text, integer, integer) IS 
    'Returns reports with full user details for admin moderation panel';


-- =====================================================
-- GRANT PERMISSIONS
-- =====================================================

-- Grant permissions to authenticated users
GRANT SELECT ON public.reports TO authenticated;
GRANT INSERT ON public.reports TO authenticated;
GRANT UPDATE ON public.reports TO authenticated;

-- Grant execute on functions
GRANT EXECUTE ON FUNCTION public.get_pending_reports_count() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_reports_with_details(text, integer, integer) TO authenticated;

