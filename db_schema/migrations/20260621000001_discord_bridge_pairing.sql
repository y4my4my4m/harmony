BEGIN;

-- Pairing codes link a Harmony server to a self-hosted bridge setup.
-- The code is safe to include in bridge config; it only resolves public metadata.

CREATE TABLE IF NOT EXISTS public.discord_bridge_pairings (
    server_id uuid PRIMARY KEY REFERENCES public.servers(id) ON DELETE CASCADE,
    pairing_code text NOT NULL,
    -- Audit field only; the pairing belongs to the server, not the creator. NULL
    -- when the creator's account is deleted so the bridge keeps working.
    -- Existing deployments are converted CASCADE -> SET NULL in 20260624.
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT discord_bridge_pairings_code_format CHECK (pairing_code ~ '^HRM-[A-Z0-9]{4}-[A-Z0-9]{4}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_bridge_pairings_code
    ON public.discord_bridge_pairings (pairing_code);

ALTER TABLE public.discord_bridge_pairings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Server owners manage discord bridge pairing" ON public.discord_bridge_pairings;
CREATE POLICY "Server owners manage discord bridge pairing"
    ON public.discord_bridge_pairings
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.servers s
            WHERE s.id = discord_bridge_pairings.server_id
              AND (
                  s.owner = public.get_current_profile_id()
                  OR public.has_permission(public.get_current_profile_id(), s.id, 'MANAGE_SERVER')
              )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.servers s
            WHERE s.id = discord_bridge_pairings.server_id
              AND (
                  s.owner = public.get_current_profile_id()
                  OR public.has_permission(public.get_current_profile_id(), s.id, 'MANAGE_SERVER')
              )
        )
    );

CREATE OR REPLACE FUNCTION public.generate_discord_bridge_pairing_code()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_code text;
BEGIN
    LOOP
        v_code := 'HRM-'
            || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4))
            || '-'
            || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4));
        EXIT WHEN NOT EXISTS (
            SELECT 1 FROM public.discord_bridge_pairings WHERE pairing_code = v_code
        );
    END LOOP;
    RETURN v_code;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.generate_discord_bridge_pairing_code() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.get_or_create_discord_bridge_pairing(p_server_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller uuid;
    v_code text;
BEGIN
    v_caller := public.get_current_profile_id();
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    IF NOT (
        EXISTS (SELECT 1 FROM public.servers WHERE id = p_server_id AND owner = v_caller)
        OR public.has_permission(v_caller, p_server_id, 'MANAGE_SERVER')
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Only server owners or managers can manage Discord bridge pairing';
    END IF;

    SELECT pairing_code INTO v_code
    FROM public.discord_bridge_pairings
    WHERE server_id = p_server_id;

    IF v_code IS NOT NULL THEN
        RETURN v_code;
    END IF;

    v_code := public.generate_discord_bridge_pairing_code();

    INSERT INTO public.discord_bridge_pairings (server_id, pairing_code, created_by)
    VALUES (p_server_id, v_code, v_caller)
    ON CONFLICT (server_id) DO NOTHING;

    SELECT pairing_code INTO v_code
    FROM public.discord_bridge_pairings
    WHERE server_id = p_server_id;

    RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.regenerate_discord_bridge_pairing(p_server_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller uuid;
    v_code text;
BEGIN
    v_caller := public.get_current_profile_id();
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    IF NOT (
        EXISTS (SELECT 1 FROM public.servers WHERE id = p_server_id AND owner = v_caller)
        OR public.has_permission(v_caller, p_server_id, 'MANAGE_SERVER')
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Only server owners or managers can manage Discord bridge pairing';
    END IF;

    v_code := public.generate_discord_bridge_pairing_code();

    INSERT INTO public.discord_bridge_pairings (server_id, pairing_code, created_by, updated_at)
    VALUES (p_server_id, v_code, v_caller, now())
    ON CONFLICT (server_id) DO UPDATE
        SET pairing_code = EXCLUDED.pairing_code,
            updated_at = now();

    RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.lookup_discord_bridge_pairing_public(p_pairing_code text)
RETURNS TABLE (server_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code text;
BEGIN
    v_code := upper(trim(p_pairing_code));
    IF v_code IS NULL OR v_code = '' OR v_code !~ '^HRM-[A-Z0-9]{4}-[A-Z0-9]{4}$' THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT dbp.server_id
    FROM public.discord_bridge_pairings dbp
    WHERE dbp.pairing_code = v_code;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_create_discord_bridge_pairing(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regenerate_discord_bridge_pairing(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_discord_bridge_pairing_public(text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
