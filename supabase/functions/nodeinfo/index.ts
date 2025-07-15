import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { 
      status: 405, 
      headers: corsHeaders 
    })
  }

  try {
    const ourDomain = Deno.env.get('DOMAIN') || 'har.mony.lol'
    const baseUrl = `https://${ourDomain}`

    // --- Use the custom header from nginx ---
    const endpoint = req.headers.get("x-nodeinfo-endpoint")

    if (endpoint === "wellknown") {
      // /.well-known/nodeinfo
      const wellKnown = {
        links: [
          {
            rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
            href: `${baseUrl}/nodeinfo/2.1`
          }
        ]
      }
      return new Response(JSON.stringify(wellKnown), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=3600'
        }
      })
    }

    if (endpoint === "schema2_1") {
      // /nodeinfo/2.1
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      const supabase = createClient(supabaseUrl, supabaseKey)

      const { count: userCount } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('is_local', true);

      const { count: postCount } = await supabase
        .from('posts')
        .select('*', { count: 'exact', head: true })
        .eq('is_local', true);

      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);

      const { count: activeMonth } = await supabase
        .from('posts')
        .select('author', { count: 'exact', head: true })
        .eq('is_local', true)
        .gte('created_at', lastMonth.toISOString());

      const lastSixMonths = new Date();
      lastSixMonths.setMonth(lastSixMonths.getMonth() - 6);

      const { count: activeHalfyear } = await supabase
        .from('posts')
        .select('author', { count: 'exact', head: true })
        .eq('is_local', true)
        .gte('created_at', lastSixMonths.toISOString());

      const nodeInfo = {
        version: '2.1',
        software: {
          name: 'harmony',
          version: '1.0.0',
          repository: 'https://github.com/harmony-social/harmony'
        },
        protocols: ['activitypub'],
        services: {
          outbound: [],
          inbound: []
        },
        usage: {
          users: {
            total: userCount || 0,
            activeMonth: activeMonth || 0,
            activeHalfyear: activeHalfyear || 0
          },
          localPosts: postCount || 0,
          localComments: 0 // TODO: Implement comment counting
        },
        openRegistrations: true,
        metadata: {
          nodeName: 'Harmony',
          nodeDescription: 'A federated social network built for meaningful connections',
          maintainer: {
            name: 'Harmony Team',
            email: 'admin@har.mony.lol'
          }
        }
      }

      return new Response(JSON.stringify(nodeInfo, null, 2), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=3600'
        }
      })
    }

    // Fallback if header is missing
    return new Response('Not found', { 
      status: 404, 
      headers: corsHeaders 
    })

  } catch (error) {
    console.error('NodeInfo error:', error)
    return new Response('Internal server error', { 
      status: 500, 
      headers: corsHeaders 
    })
  }
})
