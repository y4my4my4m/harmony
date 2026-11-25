-- Activity packages: activities an instance admin installs from a zip (federation-backend
-- src/activities/packages.ts), beside the built-ins of 20261117500001_play_together.sql.
--
-- activity_apps gains the package's catalog fields, null on built-ins (the web build's
-- /activities/index.json describes those):
--   version, description, i18n, accent   from the package manifest
--   entry_sha, icon_sha, icon_ext        SHA-256 (hex) of the stored script and icon; the files are
--                                        served at /activities/pkg/<id>/<sha>.<ext>
--   package_url, package_sha             where the zip came from (null for an upload) and its SHA-256
--   installed_by, installed_at
-- A row is a package exactly when builtin is false; a package row names both files.
--
-- activity_app_files holds the bytes, keyed by app and SHA-256. The federation backend writes and
-- serves them with the service role; accounts never read them through PostgREST.
--
-- install_activity_package(admin, app, files), service_role: one transaction. A new package starts
-- switched off; an update keeps the switch. Refuses (P0001) BUILTIN_ID when the id is a built-in's
-- and TOO_MANY_PACKAGES past 50. Files the new version no longer names are deleted. Logged as
-- activity_package_install.
-- remove_activity_package(admin, app), service_role: ends its sessions, deletes the row and files.
-- Refuses BUILTIN_ID for a built-in. Logged as activity_package_remove.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.activity_apps
    ADD COLUMN IF NOT EXISTS version text,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS i18n jsonb,
    ADD COLUMN IF NOT EXISTS accent text,
    ADD COLUMN IF NOT EXISTS entry_sha text,
    ADD COLUMN IF NOT EXISTS icon_sha text,
    ADD COLUMN IF NOT EXISTS icon_ext text,
    ADD COLUMN IF NOT EXISTS package_url text,
    ADD COLUMN IF NOT EXISTS package_sha text,
    ADD COLUMN IF NOT EXISTS installed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS installed_at timestamp with time zone;

ALTER TABLE public.activity_apps DROP CONSTRAINT IF EXISTS activity_apps_package_fields;
ALTER TABLE public.activity_apps ADD CONSTRAINT activity_apps_package_fields CHECK (
    builtin
    OR coalesce(version ~ '^\d{1,4}\.\d{1,4}\.\d{1,6}$'
        AND char_length(coalesce(description, '')) <= 300
        AND (i18n IS NULL OR jsonb_typeof(i18n) = 'object')
        AND accent ~ '^#[0-9a-fA-F]{6}$'
        AND entry_sha ~ '^[0-9a-f]{64}$'
        AND icon_sha ~ '^[0-9a-f]{64}$'
        AND icon_ext IN ('svg', 'png', 'webp')
        AND package_sha ~ '^[0-9a-f]{64}$'
        AND (package_url IS NULL OR (package_url ~ '^https://' AND char_length(package_url) <= 2000)), false));

CREATE TABLE IF NOT EXISTS public.activity_app_files (
    app_id text NOT NULL REFERENCES public.activity_apps(id) ON DELETE CASCADE,
    sha256 text NOT NULL,
    content_type text NOT NULL,
    bytes bytea NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, sha256),
    CONSTRAINT activity_app_files_sha CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT activity_app_files_type CHECK (content_type IN (
        'text/javascript; charset=utf-8', 'image/svg+xml', 'image/png', 'image/webp')),
    CONSTRAINT activity_app_files_size CHECK (octet_length(bytes) BETWEEN 1 AND 5242880)
);

ALTER TABLE public.activity_app_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS activity_app_files_service ON public.activity_app_files;
CREATE POLICY activity_app_files_service ON public.activity_app_files
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.activity_app_files FROM anon, authenticated;
GRANT ALL ON public.activity_app_files TO service_role;

-- p_app: id, name, version, description, i18n, accent, min_players, max_players, contexts,
-- entry_sha, icon_sha, icon_ext, package_url, package_sha. p_files: [{sha256, content_type, base64}].
CREATE OR REPLACE FUNCTION public.install_activity_package(p_admin uuid, p_app jsonb, p_files jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id text := p_app ->> 'id';
    v_existing public.activity_apps;
    v_file jsonb;
    v_shas text[];
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('activity-packages', 0));
    SELECT * INTO v_existing FROM public.activity_apps WHERE id = v_id FOR UPDATE;
    IF FOUND AND v_existing.builtin THEN
        RAISE EXCEPTION 'BUILTIN_ID' USING ERRCODE = 'P0001';
    END IF;
    IF NOT FOUND AND (SELECT count(*) FROM public.activity_apps WHERE NOT builtin) >= 50 THEN
        RAISE EXCEPTION 'TOO_MANY_PACKAGES' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.activity_apps (id, name, min_players, max_players, contexts, enabled, builtin,
                                      version, description, i18n, accent, entry_sha, icon_sha, icon_ext,
                                      package_url, package_sha, installed_by, installed_at, updated_at, updated_by)
    VALUES (v_id, p_app ->> 'name', (p_app ->> 'min_players')::smallint, (p_app ->> 'max_players')::smallint,
            ARRAY(SELECT jsonb_array_elements_text(p_app -> 'contexts')), false, false,
            p_app ->> 'version', p_app ->> 'description', p_app -> 'i18n', p_app ->> 'accent',
            p_app ->> 'entry_sha', p_app ->> 'icon_sha', p_app ->> 'icon_ext',
            p_app ->> 'package_url', p_app ->> 'package_sha', p_admin, now(), now(), p_admin)
    ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, min_players = EXCLUDED.min_players, max_players = EXCLUDED.max_players,
           contexts = EXCLUDED.contexts, version = EXCLUDED.version, description = EXCLUDED.description,
           i18n = EXCLUDED.i18n, accent = EXCLUDED.accent, entry_sha = EXCLUDED.entry_sha,
           icon_sha = EXCLUDED.icon_sha, icon_ext = EXCLUDED.icon_ext, package_url = EXCLUDED.package_url,
           package_sha = EXCLUDED.package_sha, installed_by = EXCLUDED.installed_by,
           installed_at = EXCLUDED.installed_at, updated_at = now(), updated_by = EXCLUDED.updated_by;

    FOR v_file IN SELECT * FROM jsonb_array_elements(p_files) LOOP
        INSERT INTO public.activity_app_files (app_id, sha256, content_type, bytes)
        VALUES (v_id, v_file ->> 'sha256', v_file ->> 'content_type', decode(v_file ->> 'base64', 'base64'))
        ON CONFLICT (app_id, sha256) DO NOTHING;
        v_shas := array_append(v_shas, v_file ->> 'sha256');
    END LOOP;
    IF NOT (p_app ->> 'entry_sha') = ANY (v_shas) OR NOT (p_app ->> 'icon_sha') = ANY (v_shas) THEN
        RAISE EXCEPTION 'files do not match the app' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.activity_app_files f
                WHERE f.app_id = v_id AND f.sha256 = ANY (v_shas)
                  AND encode(sha256(f.bytes), 'hex') <> f.sha256) THEN
        RAISE EXCEPTION 'file bytes do not match their SHA-256' USING ERRCODE = '22023';
    END IF;
    DELETE FROM public.activity_app_files f WHERE f.app_id = v_id AND NOT f.sha256 = ANY (v_shas);

    PERFORM public.log_admin_action(p_admin, 'activity_package_install', 'activity_app', v_id,
        jsonb_build_object('version', p_app ->> 'version', 'package_sha', p_app ->> 'package_sha',
                           'package_url', p_app ->> 'package_url',
                           'previous_version', v_existing.version));

    RETURN jsonb_build_object('id', v_id, 'enabled', coalesce(v_existing.enabled, false),
                              'updated', v_existing.id IS NOT NULL);
END;
$$;
REVOKE ALL ON FUNCTION public.install_activity_package(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.install_activity_package(uuid, jsonb, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.remove_activity_package(p_admin uuid, p_app text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.activity_apps;
    v_session uuid;
BEGIN
    SELECT * INTO v_row FROM public.activity_apps WHERE id = p_app FOR UPDATE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    IF v_row.builtin THEN
        RAISE EXCEPTION 'BUILTIN_ID' USING ERRCODE = 'P0001';
    END IF;
    FOR v_session IN SELECT s.id FROM public.activity_sessions s WHERE s.app_id = p_app AND s.status = 'active' LOOP
        PERFORM public.activity_session_finish(v_session, 'disabled');
    END LOOP;
    DELETE FROM public.activity_apps WHERE id = p_app;
    PERFORM public.log_admin_action(p_admin, 'activity_package_remove', 'activity_app', p_app,
        jsonb_build_object('version', v_row.version, 'package_sha', v_row.package_sha));
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.remove_activity_package(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_activity_package(uuid, text) TO service_role;

COMMIT;
