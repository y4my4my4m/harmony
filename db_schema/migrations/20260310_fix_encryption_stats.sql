-- Fix get_server_encryption_stats: user_key_pairs has no is_active column
-- The existence of a row is sufficient to indicate the user has set up encryption.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_server_encryption_stats(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_total int;
  v_with_keys int;
BEGIN
  SELECT count(*) INTO v_total
  FROM user_servers WHERE server_id = p_server_id;

  SELECT count(DISTINCT us.user_id) INTO v_with_keys
  FROM user_servers us
  JOIN user_key_pairs ukp ON ukp.user_id = us.user_id
  WHERE us.server_id = p_server_id;

  RETURN jsonb_build_object(
    'total', v_total,
    'with_keys', v_with_keys,
    'percentage', CASE WHEN v_total > 0
      THEN round((v_with_keys::numeric / v_total) * 100)
      ELSE 0 END
  );
END;
$$;

COMMIT;
