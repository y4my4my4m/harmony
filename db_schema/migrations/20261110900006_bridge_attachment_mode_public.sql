-- Bridge settings show "Imported files are copied into this instance's storage." to the server
-- managers who start a history import, when bridge_attachment_mode is 'mirror'. Managers are not
-- instance admins, so the key joins public_instance_config_keys() (the instance_config public
-- SELECT policy). It holds one of link / refresh / mirror and no secret.
--
-- The function is redefined from its current value, as earlier migrations do.
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
BEGIN
    IF NOT ('bridge_attachment_mode' = ANY (v_keys)) THEN
        EXECUTE format(
            'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
            'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
            format('SELECT %L::text[]', v_keys || 'bridge_attachment_mode'::text));
    END IF;
END;
$do$;

COMMIT;

NOTIFY pgrst, 'reload schema';
