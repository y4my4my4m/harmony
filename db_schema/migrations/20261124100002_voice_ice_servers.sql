-- ICE servers of peer-to-peer calls, set by the instance's admins.
--
-- Settings (instance_config, admins read them):
--   voice_stun_urls      An array: these stun: or stuns: URLs, [] for none. "default", or any other
--                        value: the app's list (DEFAULT_ICE_SERVERS, src/services/voice/iceServers.ts).
--   voice_turn_urls      turn: or turns: URLs; [] for no TURN server.
--   voice_turn_auth      "secret": voice_turn_secret is coturn's static-auth-secret (use-auth-secret,
--                        the TURN REST API); "password": voice_turn_username and voice_turn_secret
--                        are one long-term TURN account.
--   voice_turn_username  The account of "password".
--   voice_turn_secret    The shared secret or the password.
-- An instance that sets nothing uses the app's default STUN servers and no TURN server.
--
-- voice_ice_servers() answers {"stun": <URLs, or null for the app's list>, "turn": <server or null>}.
-- turn is {"urls", "username", "credential"} once voice_turn_urls holds a URL and its credentials
-- are set.
-- With "secret" each call mints credentials valid for 86400 s, as coturn checks them:
--   username    <expiry, unix seconds>:<caller's profile id>
--   credential  base64(HMAC-SHA1(secret, username))
-- URLs of another scheme are left out: RTCPeerConnection refuses a configuration holding one.

BEGIN;

INSERT INTO public.instance_config (config_key, config_value, description) VALUES
    ('voice_stun_urls', '"default"'::jsonb, 'STUN servers of peer-to-peer calls: "default" for the app''s list, [] for none'),
    ('voice_turn_urls', '[]'::jsonb, 'TURN servers of peer-to-peer calls (turn: or turns: URLs)'),
    ('voice_turn_auth', '"secret"'::jsonb, 'secret: voice_turn_secret is coturn''s static-auth-secret; password: voice_turn_username and voice_turn_secret are a TURN account'),
    ('voice_turn_username', '""'::jsonb, 'TURN account name when voice_turn_auth is password'),
    ('voice_turn_secret', '""'::jsonb, 'coturn static-auth-secret, or the TURN account password')
ON CONFLICT (config_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.voice_ice_servers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile  uuid := public.get_current_profile_id();
    v_stun     jsonb;
    v_turn     jsonb;
    v_auth     text;
    v_user     text;
    v_secret   text;
    v_username text;
    v_password text;
    v_server   jsonb;
BEGIN
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'voice_ice_servers: no profile for the caller' USING ERRCODE = '42501';
    END IF;

    SELECT max(CASE WHEN ic.config_key = 'voice_stun_urls' THEN ic.config_value::text END)::jsonb,
           max(CASE WHEN ic.config_key = 'voice_turn_urls' THEN ic.config_value::text END)::jsonb,
           max(CASE WHEN ic.config_key = 'voice_turn_auth' THEN ic.config_value #>> '{}' END),
           max(CASE WHEN ic.config_key = 'voice_turn_username' THEN btrim(ic.config_value #>> '{}') END),
           max(CASE WHEN ic.config_key = 'voice_turn_secret' THEN btrim(ic.config_value #>> '{}') END)
      INTO v_stun, v_turn, v_auth, v_user, v_secret
      FROM public.instance_config ic
     WHERE ic.config_key IN ('voice_stun_urls', 'voice_turn_urls', 'voice_turn_auth',
                             'voice_turn_username', 'voice_turn_secret');

    IF jsonb_typeof(v_stun) = 'array' THEN
        SELECT coalesce(jsonb_agg(u ORDER BY ord), '[]'::jsonb) INTO v_stun
          FROM jsonb_array_elements_text(v_stun) WITH ORDINALITY AS e(u, ord)
         WHERE u ~* '^stuns?:\S+$';
    ELSE
        v_stun := NULL;
    END IF;

    IF jsonb_typeof(v_turn) = 'array' THEN
        SELECT jsonb_agg(u ORDER BY ord) INTO v_turn
          FROM jsonb_array_elements_text(v_turn) WITH ORDINALITY AS e(u, ord)
         WHERE u ~* '^turns?:\S+$';
    ELSE
        v_turn := NULL;
    END IF;

    IF v_turn IS NOT NULL AND coalesce(v_secret, '') <> '' THEN
        IF v_auth = 'password' THEN
            IF coalesce(v_user, '') <> '' THEN
                v_username := v_user;
                v_password := v_secret;
            END IF;
        ELSE
            v_username := (floor(extract(epoch FROM now()))::bigint + 86400)::text || ':' || v_profile::text;
            v_password := encode(extensions.hmac(v_username, v_secret, 'sha1'), 'base64');
        END IF;
    END IF;

    IF v_password IS NOT NULL THEN
        v_server := jsonb_build_object('urls', v_turn, 'username', v_username, 'credential', v_password);
    END IF;

    RETURN jsonb_build_object('stun', v_stun, 'turn', v_server);
END;
$$;

REVOKE ALL ON FUNCTION public.voice_ice_servers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.voice_ice_servers() TO authenticated, service_role;

COMMIT;
