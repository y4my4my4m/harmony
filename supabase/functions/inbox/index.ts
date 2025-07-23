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

interface ActivityClassification {
  type: 'public_post' | 'private_mention'
  recipients: string[]
  isDirectMessage: boolean
  confidence: number
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, signature, date, digest',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/**
 * Classify ActivityPub activity according to specification
 * Compatible with Mastodon, Misskey, Pleroma standards
 */
function classifyActivityPubActivity(activity: ActivityPubActivity, ourDomain: string): ActivityClassification {
  const object = typeof activity.object === 'string' ? { to: [], cc: [] } : activity.object
  const to = object.to || []
  const cc = object.cc || []
  const allRecipients = [...to, ...cc]
  
  // Rule 1: Contains 'Public' in 'to' → Public Post
  if (to.includes('https://www.w3.org/ns/activitystreams#Public')) {
    return { type: 'public_post', recipients: allRecipients, isDirectMessage: false, confidence: 1.0 }
  }
  
  // Rule 2: Contains 'Public' in 'cc' → Unlisted Post (still public)
  if (cc.includes('https://www.w3.org/ns/activitystreams#Public')) {
    return { type: 'public_post', recipients: allRecipients, isDirectMessage: false, confidence: 1.0 }
  }
  
  // Rule 3: Contains followers collection URL → Followers-only Post
  const hasFollowersUrl = allRecipients.some(addr => 
    typeof addr === 'string' && addr.includes('/followers')
  )
  if (hasFollowersUrl) {
    return { type: 'public_post', recipients: allRecipients, isDirectMessage: false, confidence: 1.0 }
  }
  
  // Rule 4: Only specific actor URLs → Direct Message
  // Per ActivityPub spec: no Public, no followers collection = direct message
  const hasLocalRecipients = allRecipients.some(addr => 
    typeof addr === 'string' && addr.includes(ourDomain)
  )
  
  if (hasLocalRecipients) {
    return { type: 'private_mention', recipients: allRecipients, isDirectMessage: true, confidence: 1.0 }
  }
  
  // Rule 5: No local recipients → Not our concern
  return { type: 'public_post', recipients: allRecipients, isDirectMessage: false, confidence: 0.1 }
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

    // ✅ Store the activity using database function (idempotent)
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

    // ✅ Process the activity based on type and classification
    let isValid = false
    try {
      switch (activity.type) {
        case 'Follow':
          isValid = await processFollowActivity(supabase, activity, ourDomain)
          break
        case 'Accept':
        case 'Reject':
        case 'Undo':
        case 'Update':
        case 'Delete':
        case 'Like':
        case 'Announce':
          isValid = true // Basic validation passed, let database handle business logic
          break
        case 'Create':
          // ✅ NEW: Route based on ActivityPub classification
          isValid = await processCreateActivity(supabase, activity, ourDomain)
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

// ✅ Enhanced Create activity processing with proper routing
async function processCreateActivity(supabase: any, activity: ActivityPubActivity, ourDomain: string): Promise<boolean> {
  try {
    // Classify the activity according to ActivityPub spec
    const classification = classifyActivityPubActivity(activity, ourDomain)
    
    console.log(`📋 Activity classification: ${classification.type} (confidence: ${classification.confidence})`)
    
    if (classification.isDirectMessage) {
      // Route to private message system (DM)
      console.log('📨 Routing to private message system')
      
      // Get the stored activity ID
      const { data: storedActivity, error: activityError } = await supabase
        .from('ap_activities')
        .select('id, actor_id')
        .eq('ap_id', activity.id)
        .single()
      
      if (activityError || !storedActivity) {
        console.error('❌ Failed to get stored activity:', activityError)
        return false
      }
      
      // Call the database function to process the private message
      const { error: processError } = await supabase.rpc('process_incoming_private_message', {
        p_activity_id: storedActivity.id,
        p_activity_data: activity,
        p_actor_profile_id: storedActivity.actor_id,
        p_instance_domain: ourDomain
      })
      
      if (processError) {
        console.error('❌ Failed to process private message:', processError)
        return false
      }
      
      console.log('✅ Private message processed successfully')
      return true
      
    } else {
      // Route to public post system
      console.log('📢 Routing to public post system')
      
      // Standard public post processing (existing logic)
      return true
    }
    
  } catch (error) {
    console.error('❌ Failed to process Create activity:', error)
    return false
  }
}

// ✅ Minimal validation functions (preserved from original)
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