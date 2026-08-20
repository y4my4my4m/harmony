-- =============================================================================
-- Migration: Global Announcements System
-- =============================================================================
-- Adds instance_announcements and announcement_reads tables for admin-created
-- announcements with per-user read tracking (Misskey-style).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- TABLE: instance_announcements
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instance_announcements (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    title text NOT NULL,
    content text NOT NULL,
    image_url text,
    icon text DEFAULT 'info',
    is_active boolean DEFAULT true,
    starts_at timestamptz DEFAULT now(),
    ends_at timestamptz,
    is_pinned boolean DEFAULT false,
    show_popup boolean DEFAULT true,
    silence boolean DEFAULT false,
    author_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    display_order integer DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_announcements_active
    ON public.instance_announcements(is_active, starts_at, ends_at);

-- ---------------------------------------------------------------------------
-- TABLE: announcement_reads
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.announcement_reads (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    announcement_id uuid NOT NULL REFERENCES public.instance_announcements(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    read_at timestamptz DEFAULT now(),
    CONSTRAINT unique_announcement_read UNIQUE (announcement_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_reads_user
    ON public.announcement_reads(user_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.instance_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "announcements_select_all" ON public.instance_announcements;
CREATE POLICY "announcements_select_all" ON public.instance_announcements
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "announcements_insert_admin" ON public.instance_announcements;
CREATE POLICY "announcements_insert_admin" ON public.instance_announcements
    FOR INSERT TO authenticated WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    );

DROP POLICY IF EXISTS "announcements_update_admin" ON public.instance_announcements;
CREATE POLICY "announcements_update_admin" ON public.instance_announcements
    FOR UPDATE TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    );

DROP POLICY IF EXISTS "announcements_delete_admin" ON public.instance_announcements;
CREATE POLICY "announcements_delete_admin" ON public.instance_announcements
    FOR DELETE TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    );

DROP POLICY IF EXISTS "announcement_reads_select_own" ON public.announcement_reads;
CREATE POLICY "announcement_reads_select_own" ON public.announcement_reads
    FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "announcement_reads_insert_own" ON public.announcement_reads;
CREATE POLICY "announcement_reads_insert_own" ON public.announcement_reads
    FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- RPC: get_unread_announcements
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_unread_announcements(p_user_id uuid)
RETURNS TABLE(
    id uuid,
    title text,
    content text,
    image_url text,
    icon text,
    is_pinned boolean,
    show_popup boolean,
    silence boolean,
    created_at timestamptz,
    author_id uuid,
    author_username text,
    author_display_name text,
    author_avatar_url text
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
    SELECT
        a.id, a.title, a.content, a.image_url, a.icon,
        a.is_pinned, a.show_popup, a.silence, a.created_at,
        a.author_id, p.username AS author_username,
        p.display_name AS author_display_name,
        p.avatar_url AS author_avatar_url
    FROM public.instance_announcements a
    LEFT JOIN public.profiles p ON p.id = a.author_id
    LEFT JOIN public.announcement_reads ar ON ar.announcement_id = a.id AND ar.user_id = p_user_id
    WHERE a.is_active = true
      AND a.starts_at <= NOW()
      AND (a.ends_at IS NULL OR a.ends_at > NOW())
      AND ar.id IS NULL
    ORDER BY a.is_pinned DESC, a.display_order ASC, a.created_at DESC;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
