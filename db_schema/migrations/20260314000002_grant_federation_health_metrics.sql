BEGIN;

-- Grant SELECT on federation_health_metrics view to authenticated users (admin dashboard)
-- The view was created in 70_views.sql but the GRANT was missing from init scripts.
GRANT SELECT ON public.federation_health_metrics TO authenticated;
GRANT SELECT ON public.federation_health_metrics TO service_role;

-- Grant permissions on federation_endpoint_health for admin purge operations
-- RLS policies already exist (30_rls_policies.sql) but TABLE-level GRANTs were missing.
GRANT SELECT, DELETE ON public.federation_endpoint_health TO authenticated;
GRANT ALL ON public.federation_endpoint_health TO service_role;

-- Grant DELETE on federation_delivery_queue for admin purge of dead/failed entries
-- RLS allows SELECT for authenticated but DELETE was missing at TABLE level.
GRANT SELECT, DELETE ON public.federation_delivery_queue TO authenticated;
GRANT ALL ON public.federation_delivery_queue TO service_role;

-- Add RLS policy so authenticated admins can DELETE from federation_delivery_queue
-- (existing policies only had SELECT for authenticated; service_role had full access)
DROP POLICY IF EXISTS "Admins can delete federation deliveries" ON public.federation_delivery_queue;
CREATE POLICY "Admins can delete federation deliveries" ON public.federation_delivery_queue
    FOR DELETE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = public.get_current_profile_id()
            AND is_admin = true
        )
    );

NOTIFY pgrst, 'reload schema';

COMMIT;
