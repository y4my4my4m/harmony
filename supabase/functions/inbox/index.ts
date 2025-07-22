// ActivityPub Inbox endpoint for receiving federation activities
// /users/{username}/inbox and /api/activitypub/inbox (shared inbox)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface ActivityPubActivity {
  '@context'?: string | string[]
  id: string
  type: string
  actor: string
  object: string | object
  published?: string
  to?: string[]
  cc?: string[]
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, signature, date, digest',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { 
      status: 405, 
      headers: corsHeaders 
    })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)
    const ourDomain = Deno.env.get('DOMAIN') || 'har.mony.lol'

    // Parse activity from request body
    const activity: ActivityPubActivity = await req.json()

    // Basic validation
    if (!activity.id || !activity.type || !activity.actor) {
      return new Response('Invalid activity', { 
        status: 400, 
        headers: corsHeaders 
      })
    }

    console.log('📥 Received activity:', JSON.stringify(activity, null, 2))

    // ✅ Store the activity using database function (idempotent - FIXES CONSTRAINT ERROR)
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : (activity.actor as any)?.id || ''
    const originDomain = actorUrl ? new URL(actorUrl).hostname : null
    
    const { data: insertResult, error: storeError } = await supabase
      .rpc('upsert_ap_activity', {
        p_ap_id: activity.id,
        p_ap_type: activity.type,
        p_actor_ap_id: actorUrl,
        p_activity_data: activity,
        p_origin_domain: originDomain,
        p_to_addresses: activity.to || [],
        p_cc_addresses: activity.cc || [],
        p_is_local: false
      })

    if (storeError) {
      console.error('❌ Failed to store activity:', storeError)
      return new Response(`Failed to store activity: ${storeError.message}`, { 
        status: 500, 
        headers: corsHeaders 
      })
    }

    const wasUpdated = insertResult?.[0]?.was_updated
    
    if (wasUpdated) {
      console.log('🔄 Updated existing activity for retry:', activity.id)
    } else {
      console.log('✅ Successfully stored activity (new or idempotent):', activity.id)
    }

    // ✅ Process the activity based on type - VALIDATION ONLY
    // Database triggers will handle the actual business logic
    let isValid = false
    try {
      switch (activity.type) {
        case 'Follow':
          isValid = await processFollowActivity(supabase, activity, ourDomain)
          break
        case 'Accept':
        case 'Reject':
        case 'Undo':
        case 'Create':
        case 'Update':
        case 'Delete':
        case 'Like':
        case 'Announce':
          isValid = true // Basic validation passed, let database handle business logic
          break
        default:
          console.log(`❌ Unhandled activity type: ${activity.type}`)
          isValid = false
      }

      if (isValid) {
        // ✅ Mark as processing - this UPDATE triggers database processing
        const { error: updateError } = await supabase
          .from('ap_activities')
          .update({ status: 'processing' })
          .eq('ap_id', activity.id)

        if (updateError) {
          console.error('❌ Failed to mark activity as processing:', updateError)
        } else {
          console.log(`✅ Activity marked for processing: ${activity.id}`)
        }
      } else {
        // Mark as failed with validation error
        await supabase
          .from('ap_activities')
          .update({ 
            status: 'failed', 
            error_message: 'Failed validation'
          })
          .eq('ap_id', activity.id)
        
        console.log(`❌ Activity failed validation: ${activity.id}`)
      }

    } catch (processingError) {
      console.error('❌ Activity validation error:', processingError)
      
      await supabase
        .from('ap_activities')
        .update({ 
          status: 'failed', 
          error_message: processingError instanceof Error ? processingError.message : 'Unknown error'
        })
        .eq('ap_id', activity.id)
    }

    return new Response('', { 
      status: 202, // Accepted
      headers: corsHeaders 
    })

  } catch (error) {
    console.error('❌ Inbox error:', error)
    return new Response('Internal server error', { 
      status: 500, 
      headers: corsHeaders 
    })
  }
})

// ✅ Minimal validation functions
async function processFollowActivity(supabase: any, activity: ActivityPubActivity, ourDomain: string) {
  const followingActor = typeof activity.object === 'string' ? activity.object : (activity.object as any).id
  
  if (!followingActor || typeof followingActor !== 'string') {
    console.log('❌ Follow activity missing or invalid object')
    return false
  }
  
  const followingMatch = followingActor.match(`https://${ourDomain}/users/([^/]+)`)
  
  if (!followingMatch) {
    console.log('❌ Follow activity not for our domain')
    return false
  }

  console.log(`✅ Valid follow activity for user: ${followingMatch[1]}`)
  return true
}