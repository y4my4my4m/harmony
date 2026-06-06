-- Emoji scopes + AI-generated emoji as first-class custom emoji.
--
-- Replaces the awkward gif_favorites.is_generated coupling. AI-generated emoji
-- now live in public.emojis like any other custom emoji, so they render through
-- the normal :shortcode: pipeline and show up as a picker category.
--
-- New scope model on public.emojis:
--   'server'   -> per-server emoji (server_id set) — the existing behaviour
--   'instance' -> instance-wide emoji (server_id NULL) — e.g. remote imports
--   'user'     -> personal emoji owned by a profile (uploader set), incl. AI ones
--
-- This also lays the foundation for user/instance manual emoji uploads.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Scope + AI flag on emojis
-- ---------------------------------------------------------------------------
ALTER TABLE public.emojis
    ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'server',
    ADD COLUMN IF NOT EXISTS is_ai_generated boolean NOT NULL DEFAULT false;

DO $$ BEGIN
    ALTER TABLE public.emojis
        ADD CONSTRAINT emojis_scope_check CHECK (scope IN ('server', 'instance', 'user'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Existing server_id-less rows are the instance-wide imports.
UPDATE public.emojis SET scope = 'instance' WHERE server_id IS NULL AND scope = 'server';

CREATE INDEX IF NOT EXISTS idx_emojis_user ON public.emojis(uploader) WHERE scope = 'user';
CREATE INDEX IF NOT EXISTS idx_emojis_scope ON public.emojis(scope);
-- Counts today's AI generations per uploader for daily-cap enforcement.
CREATE INDEX IF NOT EXISTS idx_emojis_ai_generated
    ON public.emojis(uploader, created_at) WHERE is_ai_generated;

COMMENT ON COLUMN public.emojis.scope IS 'server | instance | user — emoji ownership scope';
COMMENT ON COLUMN public.emojis.is_ai_generated IS 'True for emoji created via the Klipy AI generation API';

-- ---------------------------------------------------------------------------
-- 2. RLS: users manage their own user-scoped emoji; admins manage instance ones.
--    (Existing server-owner policies are left untouched.)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "emojis_insert_user_scope" ON public.emojis;
CREATE POLICY "emojis_insert_user_scope" ON public.emojis
    FOR INSERT WITH CHECK (
        scope = 'user' AND uploader = public.get_current_profile_id()
    );

DROP POLICY IF EXISTS "emojis_update_user_scope" ON public.emojis;
CREATE POLICY "emojis_update_user_scope" ON public.emojis
    FOR UPDATE USING (
        scope = 'user' AND uploader = public.get_current_profile_id()
    );

DROP POLICY IF EXISTS "emojis_delete_user_scope" ON public.emojis;
CREATE POLICY "emojis_delete_user_scope" ON public.emojis
    FOR DELETE USING (
        scope = 'user' AND uploader = public.get_current_profile_id()
    );

DROP POLICY IF EXISTS "emojis_insert_instance_admin" ON public.emojis;
CREATE POLICY "emojis_insert_instance_admin" ON public.emojis
    FOR INSERT WITH CHECK (
        scope = 'instance'
        AND (SELECT is_admin FROM public.profiles WHERE auth_user_id = auth.uid())
    );

DROP POLICY IF EXISTS "emojis_update_instance_admin" ON public.emojis;
CREATE POLICY "emojis_update_instance_admin" ON public.emojis
    FOR UPDATE USING (
        scope = 'instance'
        AND (SELECT is_admin FROM public.profiles WHERE auth_user_id = auth.uid())
    );

DROP POLICY IF EXISTS "emojis_delete_instance_admin" ON public.emojis;
CREATE POLICY "emojis_delete_instance_admin" ON public.emojis
    FOR DELETE USING (
        scope = 'instance'
        AND (SELECT is_admin FROM public.profiles WHERE auth_user_id = auth.uid())
    );

-- ---------------------------------------------------------------------------
-- 3. Remote import now tags scope so imported emoji land in the right bucket.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_remote_emoji(p_remote_emoji_id uuid, p_new_name text DEFAULT NULL::text, p_server_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
  v_remote remote_emojis_cache%ROWTYPE;
  v_new_id uuid;
  v_name text;
BEGIN
  SELECT * INTO v_remote FROM public.remote_emojis_cache WHERE id = p_remote_emoji_id;

  IF v_remote.id IS NULL THEN
    RAISE EXCEPTION 'Remote emoji not found';
  END IF;

  IF v_remote.imported_as IS NOT NULL THEN
    RAISE EXCEPTION 'Emoji already imported';
  END IF;

  v_name := COALESCE(p_new_name, v_remote.shortcode);

  IF EXISTS (SELECT 1 FROM public.emojis WHERE name = v_name AND domain IS NULL) THEN
    RAISE EXCEPTION 'Emoji name already exists locally: %', v_name;
  END IF;

  INSERT INTO public.emojis (
    name,
    url,
    server_id,
    scope,
    domain  -- NULL means it's now a local emoji
  ) VALUES (
    v_name,
    v_remote.url,
    p_server_id,
    CASE WHEN p_server_id IS NULL THEN 'instance' ELSE 'server' END,
    NULL
  ) RETURNING id INTO v_new_id;

  UPDATE public.remote_emojis_cache
  SET imported_as = v_new_id, imported_at = now()
  WHERE id = p_remote_emoji_id;

  RETURN v_new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.import_remote_emoji(uuid, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Tear down the old gif_favorites.is_generated path + ai-emojis bucket.
--    These were never meaningfully used; AI emoji now live in public.emojis.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_gif_favorites_generated;
ALTER TABLE public.gif_favorites DROP COLUMN IF EXISTS is_generated;
COMMENT ON TABLE public.gif_favorites IS 'User favorite GIFs and stickers';

-- Drop the now-unused read policy for the old 'ai-emojis' bucket.
DROP POLICY IF EXISTS "Public read access for ai-emojis" ON storage.objects;

-- NOTE: We intentionally do NOT delete the 'ai-emojis' bucket or its objects
-- here. Supabase forbids direct DELETE on storage.objects / storage.buckets
-- (storage.protect_delete() raises 42501) to avoid orphaning files. If the
-- bucket was created on this instance, leave it dormant — nothing writes to it
-- anymore — or remove it via the Storage API / dashboard ("Empty bucket" then
-- "Delete bucket"). Fresh deploys never create it.

COMMIT;

NOTIFY pgrst, 'reload schema';
