-- =============================================================================
-- Migration: Align reports table with service expectations + donation history
-- =============================================================================
-- 1. Adds missing columns to reports (report_type, metadata, etc.)
-- 2. Updates status constraint to match ReportService values
-- 3. Creates get_pending_reports_count and get_reports_with_details RPCs
-- 4. Adds instance_donation_history table
-- 5. Adds funding visibility columns to instance_funding
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- REPORTS TABLE: add missing columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS report_type text NOT NULL DEFAULT 'user';
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS source_instance text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS ap_id text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS federation_status text DEFAULT 'pending';
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reported_server_id uuid REFERENCES public.servers(id) ON DELETE SET NULL;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS resolution_note text;
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS comment text;

-- Ensure reported_message_id exists (in init but may be missing in dev)
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reported_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL;

-- Make reported_user_id nullable (server/post reports may not have a user target)
ALTER TABLE public.reports ALTER COLUMN reported_user_id DROP NOT NULL;

-- Update status constraint to match service expectations
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_status_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_status_check
    CHECK (status IN ('pending', 'investigating', 'resolved', 'dismissed'));

-- Add report_type constraint
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_report_type_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_report_type_check
    CHECK (report_type IN ('user', 'post', 'message', 'server'));

-- Add source constraint
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_source_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_source_check
    CHECK (source IN ('local', 'federation'));

-- Add federation_status constraint
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_federation_status_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_federation_status_check
    CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_reports_report_type ON public.reports(report_type);
CREATE INDEX IF NOT EXISTS idx_reports_reported_message ON public.reports(reported_message_id);

-- ---------------------------------------------------------------------------
-- RLS POLICIES for reports
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can create reports" ON public.reports;
CREATE POLICY "Users can create reports" ON public.reports
    FOR INSERT TO authenticated
    WITH CHECK (reporter_id = auth.uid());

DROP POLICY IF EXISTS "Users can view own reports" ON public.reports;
CREATE POLICY "Users can view own reports" ON public.reports
    FOR SELECT TO authenticated
    USING (reporter_id = auth.uid());

DROP POLICY IF EXISTS "Admins can view all reports" ON public.reports;
CREATE POLICY "Admins can view all reports" ON public.reports
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true));

DROP POLICY IF EXISTS "Admins can update reports" ON public.reports;
CREATE POLICY "Admins can update reports" ON public.reports
    FOR UPDATE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true));

-- ---------------------------------------------------------------------------
-- RPC: get_pending_reports_count
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_pending_reports_count()
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
    SELECT COUNT(*)::integer FROM public.reports WHERE status = 'pending';
$$;

COMMENT ON FUNCTION public.get_pending_reports_count()
    IS 'Returns count of pending reports for admin badge display';

-- ---------------------------------------------------------------------------
-- RPC: get_reports_with_details
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_reports_with_details(text, integer, integer);
CREATE OR REPLACE FUNCTION public.get_reports_with_details(
    p_status text DEFAULT NULL,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0
)
RETURNS TABLE(
    id uuid,
    reported_user_id uuid,
    reported_message_id uuid,
    reported_post_id uuid,
    reporter_username text,
    reporter_display_name text,
    reporter_avatar_url text,
    reported_user_username text,
    reported_user_display_name text,
    reported_user_avatar_url text,
    reported_post_preview text,
    reported_message_preview text,
    reason text,
    comment text,
    report_type text,
    source text,
    source_instance text,
    status text,
    resolution_note text,
    created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        r.id,
        r.reported_user_id,
        r.reported_message_id,
        r.reported_post_id,
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
        CASE
            WHEN r.reported_message_id IS NOT NULL THEN
                LEFT(
                    COALESCE(
                        (SELECT string_agg(
                            CASE
                                WHEN part->>'type' = 'text' THEN COALESCE(part->>'text', '')
                                WHEN part->>'type' = 'file' THEN '[' || COALESCE(part->>'fileType', 'file') || ': ' || COALESCE(part->>'filename', part->>'url', 'attachment') || ']'
                                WHEN part->>'type' = 'url' THEN COALESCE(part->>'url', '[link]')
                                WHEN part->>'type' = 'emoji' THEN COALESCE(part->'emoji'->>'name', ':emoji:')
                                WHEN part->>'type' = 'mention' THEN COALESCE(part->>'mention', '@user')
                                ELSE '[' || COALESCE(part->>'type', 'unknown') || ']'
                            END, ' '
                        )
                        FROM public.messages m, jsonb_array_elements(m.content) AS part
                        WHERE m.id = r.reported_message_id),
                        '[Message content unavailable]'
                    ),
                    300
                )
            ELSE NULL
        END::text,
        r.reason,
        r.comment,
        r.report_type,
        r.source,
        r.source_instance,
        r.status,
        r.resolution_note,
        r.created_at
    FROM public.reports r
    LEFT JOIN public.profiles reporter ON reporter.id = r.reporter_id
    LEFT JOIN public.profiles reported_user ON reported_user.id = r.reported_user_id
    WHERE (p_status IS NULL OR r.status = p_status)
    ORDER BY r.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

COMMENT ON FUNCTION public.get_reports_with_details(text, integer, integer)
    IS 'Returns reports with full user details for admin moderation panel';

-- ---------------------------------------------------------------------------
-- TABLE: instance_donation_history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instance_donation_history (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    supporter_id uuid NOT NULL REFERENCES public.instance_supporters(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    amount numeric(10,2) NOT NULL,
    currency text DEFAULT 'USD',
    platform text,
    external_reference text,
    note text,
    donated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_donation_history_user ON public.instance_donation_history(user_id);
CREATE INDEX IF NOT EXISTS idx_donation_history_supporter ON public.instance_donation_history(supporter_id);
CREATE INDEX IF NOT EXISTS idx_donation_history_date ON public.instance_donation_history(donated_at);

ALTER TABLE public.instance_donation_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "donation_history_select_admin" ON public.instance_donation_history;
CREATE POLICY "donation_history_select_admin" ON public.instance_donation_history
    FOR SELECT TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
        OR user_id = auth.uid()
    );

DROP POLICY IF EXISTS "donation_history_modify_admin" ON public.instance_donation_history;
CREATE POLICY "donation_history_modify_admin" ON public.instance_donation_history
    FOR ALL TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    );

-- ---------------------------------------------------------------------------
-- INSTANCE_FUNDING: add visibility columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.instance_funding ADD COLUMN IF NOT EXISTS show_in_context_bar boolean DEFAULT false;
ALTER TABLE public.instance_funding ADD COLUMN IF NOT EXISTS context_bar_style text DEFAULT 'mini-progress';

-- Table grants for PostgREST access
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_funding TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_supporter_tiers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_supporters TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_donation_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reports TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
