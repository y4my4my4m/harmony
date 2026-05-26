-- =============================================================================
-- Migration: Announcements popup filtering + no-backlog-for-new-users
-- =============================================================================
-- The 20260309_announcements migration created `get_unread_announcements`
-- but it ignored two important fields on `instance_announcements`:
--
--   * `show_popup`  — admin opt-out for popup display (still surfaced in the
--     Settings archive, but not auto-popped on app load).
--   * `starts_at`  — relative to `profiles.created_at`, this lets us avoid
--     spamming brand-new users with the entire backlog of historical
--     announcements they have no context for.
--
-- We also cap the popup-only query at 10 rows so a user returning after a
-- long absence (or a freshly-created account on an instance that recently
-- backdated some `starts_at` values) doesn't get a wall of 50 modals.
--
-- Semantics:
--   - `get_unread_announcements(p_user_id)`                  → full unread set
--     (no change in behaviour for existing callers — used by the Settings
--     archive to compute the Unread tab and the sidebar badge).
--   - `get_unread_announcements(p_user_id, p_popup_only := true)` → strictly
--     what the AnnouncementPopup should auto-open with: show_popup = true
--     AND `starts_at >= profiles.created_at` AND capped to 10.
--
-- The two-arg signature is added as a separate overload of the function so
-- the original single-arg shape stays compatible (PostgREST resolves RPC
-- overloads by argument names).
-- =============================================================================

BEGIN;

-- Drop only the single-arg shape we're replacing. CREATE OR REPLACE FUNCTION
-- can't change a function's argument list in place, so we replace it. The
-- new definition keeps the exact same RETURNS TABLE shape as the original,
-- so every existing caller continues to work without any client changes.
DROP FUNCTION IF EXISTS public.get_unread_announcements(uuid);

CREATE OR REPLACE FUNCTION public.get_unread_announcements(
    p_user_id uuid,
    p_popup_only boolean DEFAULT false
)
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
SET search_path = public, pg_temp
AS $$
    WITH joined AS (
        -- Single lookup of the requesting user's signup timestamp so the
        -- main predicate doesn't have to subquery the profiles table per
        -- row. NULL-safe: if for some reason the profile is missing we
        -- fall back to epoch so the filter is a no-op rather than a hard
        -- exclusion.
        SELECT COALESCE(
            (SELECT created_at FROM public.profiles WHERE id = p_user_id),
            'epoch'::timestamptz
        ) AS user_created_at
    )
    SELECT
        a.id, a.title, a.content, a.image_url, a.icon,
        a.is_pinned, a.show_popup, a.silence, a.created_at,
        a.author_id, p.username AS author_username,
        p.display_name AS author_display_name,
        p.avatar_url AS author_avatar_url
    FROM public.instance_announcements a
    LEFT JOIN public.profiles p ON p.id = a.author_id
    LEFT JOIN public.announcement_reads ar
        ON ar.announcement_id = a.id AND ar.user_id = p_user_id
    CROSS JOIN joined j
    WHERE a.is_active = true
      AND a.starts_at <= NOW()
      AND (a.ends_at IS NULL OR a.ends_at > NOW())
      AND ar.id IS NULL
      AND (
          -- Default path (Settings archive, badge): no extra filtering,
          -- return everything the user hasn't read yet.
          NOT p_popup_only
          OR (
              -- Popup path: respect the admin's `show_popup` opt-out, and
              -- only surface announcements that started AFTER the user
              -- signed up. New users get a clean inbox; existing users
              -- still see anything that happened during their tenure.
              a.show_popup = true
              AND a.starts_at >= j.user_created_at
          )
      )
    ORDER BY a.is_pinned DESC, a.display_order ASC, a.created_at DESC
    LIMIT CASE WHEN p_popup_only THEN 10 ELSE 1000 END;
$$;

-- Re-grant EXECUTE — DROP FUNCTION above also drops any prior grants.
GRANT EXECUTE ON FUNCTION public.get_unread_announcements(uuid, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
