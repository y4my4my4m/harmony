BEGIN;

-- Add missing GRANTs for federation tables so PostgREST (Supabase API)
-- can expose them to service_role and authenticated clients.

GRANT SELECT ON public.federated_instances TO authenticated;
GRANT ALL ON public.federated_instances TO service_role;

GRANT SELECT ON public.blocked_instances TO authenticated;
GRANT ALL ON public.blocked_instances TO service_role;

GRANT SELECT ON public.ap_activities TO authenticated;
GRANT ALL ON public.ap_activities TO service_role;

GRANT SELECT ON public.ap_actor_cache TO authenticated;
GRANT ALL ON public.ap_actor_cache TO service_role;

GRANT SELECT ON public.ap_object_cache TO authenticated;
GRANT ALL ON public.ap_object_cache TO service_role;

GRANT SELECT ON public.server_federation_events TO authenticated;
GRANT ALL ON public.server_federation_events TO service_role;

GRANT SELECT ON public.server_membership_events TO authenticated;
GRANT ALL ON public.server_membership_events TO service_role;

GRANT SELECT ON public.voice_federation_events TO authenticated;
GRANT ALL ON public.voice_federation_events TO service_role;

GRANT SELECT ON public.federated_voice_calls TO authenticated;
GRANT ALL ON public.federated_voice_calls TO service_role;

GRANT SELECT ON public.activity_processing_logs TO authenticated;
GRANT ALL ON public.activity_processing_logs TO service_role;

GRANT SELECT ON public.activitypub_processing_stats TO authenticated;
GRANT ALL ON public.activitypub_processing_stats TO service_role;

GRANT SELECT ON public.federation_delivery_stats TO authenticated;
GRANT ALL ON public.federation_delivery_stats TO service_role;

-- Tell PostgREST to reload its schema cache so it picks up the new tables/grants
NOTIFY pgrst, 'reload schema';

COMMIT;
