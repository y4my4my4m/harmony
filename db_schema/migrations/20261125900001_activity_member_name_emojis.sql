-- An activity member carries the custom emojis of their display name.
--
-- activity_session_admit (20261117500001) answers member {id, username, display_name, avatar_url};
-- the relay hands that member to every client of the session, and the client draws the activity's
-- player names from it. A display name holds custom emojis as :shortcodes:, resolved by
-- derive_display_name_emojis into federation_metadata.display_name_emojis [{name, url, id}]. The
-- member now carries them as display_name_emojis [{name, url}], at most 16, entries without a name
-- or url left out; a legacy string-encoded federation_metadata or none gives [].
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.activity_session_admit(p_session uuid, p_profile uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.activity_sessions;
    v_app public.activity_apps;
    v_refusal text;
    v_member jsonb;
BEGIN
    SELECT * INTO v_row FROM public.activity_sessions WHERE id = p_session;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('refusal', 'NOT_FOUND');
    END IF;
    IF v_row.status <> 'active' THEN
        RETURN jsonb_build_object('refusal', 'ENDED');
    END IF;
    IF v_row.last_active_at < now() - interval '3 minutes' THEN
        PERFORM public.activity_session_finish(p_session, 'idle');
        RETURN jsonb_build_object('refusal', 'ENDED');
    END IF;
    SELECT * INTO v_app FROM public.activity_apps WHERE id = v_row.app_id;
    IF NOT v_app.enabled THEN
        RETURN jsonb_build_object('refusal', 'ACTIVITY_APP_UNAVAILABLE');
    END IF;
    v_refusal := public.activity_join_refusal(p_profile, v_row.conversation_id, v_row.channel_id, false);
    IF v_refusal IS NOT NULL THEN
        RETURN jsonb_build_object('refusal', v_refusal);
    END IF;

    SELECT jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name,
                              'avatar_url', p.avatar_url,
                              'display_name_emojis', COALESCE((
                                  SELECT jsonb_agg(jsonb_build_object('name', e.value ->> 'name', 'url', e.value ->> 'url')
                                                   ORDER BY e.ord)
                                    FROM jsonb_array_elements(
                                             CASE WHEN jsonb_typeof(p.federation_metadata -> 'display_name_emojis') = 'array'
                                                  THEN p.federation_metadata -> 'display_name_emojis'
                                                  ELSE '[]'::jsonb END) WITH ORDINALITY AS e(value, ord)
                                   WHERE e.ord <= 16
                                     AND jsonb_typeof(e.value) = 'object'
                                     AND COALESCE(e.value ->> 'name', '') <> ''
                                     AND COALESCE(e.value ->> 'url', '') <> ''), '[]'::jsonb))
      INTO v_member FROM public.profiles p WHERE p.id = p_profile;

    RETURN jsonb_build_object(
        'session', public.activity_session_json(v_row),
        'member', v_member,
        'can_end', p_profile = v_row.started_by
                   OR (v_row.channel_id IS NOT NULL
                       AND public.has_permission(p_profile, v_row.server_id, 'MANAGE_MESSAGES', v_row.channel_id)));
END;
$$;
REVOKE ALL ON FUNCTION public.activity_session_admit(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activity_session_admit(uuid, uuid) TO service_role;

COMMIT;
