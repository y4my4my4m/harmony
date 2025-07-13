// NodeInfo endpoint for instance metadata discovery
// /.well-known/nodeinfo and /nodeinfo/2.1

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface NodeInfoWellKnown {
  links: Array<{
    rel: string
    href: string
  }>
}

interface NodeInfo {
  version: string
  software: {
    name: string
    version: string
    repository?: string
  }
  protocols: string[]
  services: {
    outbound: string[]
    inbound: string[]
  }
  usage: {
    users: {
      total: number
      activeMonth: number
      activeHalfyear: number
    }
    localPosts: number
    localComments: number
  }
  openRegistrations: boolean
  metadata: {
    nodeName: string
    nodeDescription: string
    maintainer?: {
      name: string
      email: string
    }
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

serve(async (req: Request) => {
  // Handle CORS preflight
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
    const url = new URL(req.url)
    const ourDomain = Deno.env.get('DOMAIN') || 'har.mony.lol'
    const baseUrl = `https://${ourDomain}`

    // Handle /.well-known/nodeinfo
    if (url.pathname === '/.well-known/nodeinfo') {
      const wellKnown: NodeInfoWellKnown = {
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
          'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
        }
      })
    }

    // Handle /nodeinfo/2.1
    if (url.pathname === '/nodeinfo/2.1') {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      const supabase = createClient(supabaseUrl, supabaseKey)

      // Get user count
      // const { count: userCount } = await supabase
      //   .from('profiles')
      //   .select('*', { count: 'exact', head: true })
      //   .eq('is_local', true)

      // // Get post count  
      // const { count: postCount } = await supabase
      //   .from('posts')
      //   .select('*', { count: 'exact', head: true })
      //   .eq('is_local', true)

      // // Get active users (simplified - users with posts in last month)
      // const lastMonth = new Date()
      // lastMonth.setMonth(lastMonth.getMonth() - 1)
      
      // const { count: activeMonth } = await supabase
      //   .from('posts')
      //   .select('author', { count: 'exact', head: true })
      //   .eq('is_local', true)
      //   .gte('created_at', lastMonth.toISOString())

      // const lastSixMonths = new Date()
      // lastSixMonths.setMonth(lastSixMonths.getMonth() - 6)
      
      // const { count: activeHalfyear } = await supabase
      //   .from('posts')
      //   .select('author', { count: 'exact', head: true })
      //   .eq('is_local', true)
      //   .gte('created_at', lastSixMonths.toISOString())

      const userCount = 1000; // Placeholder for user count
      const postCount = 5000; // Placeholder for post count
      const activeMonth = 200; // Placeholder for active users in last month
      const activeHalfyear = 600; // Placeholder for active users in last 6 months

      const nodeInfo: NodeInfo = {
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
        openRegistrations: true, // Set based on your instance policy
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
          'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
        }
      })
    }

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