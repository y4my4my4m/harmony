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
    const url = new URL(req.url)
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
    // Check if the actor's instance is blocked
    let actorDomain: string | null = null
    try {
      if (typeof activity.actor === 'string') {
      actorDomain = new URL(activity.actor).hostname
      } else if (typeof activity.actor === 'object' && activity.actor.id) {
      actorDomain = new URL(activity.actor.id).hostname
      }
    } catch (e) {
      console.error('Failed to parse actor domain:', e)
      actorDomain = null
    }

    if (actorDomain) {
      const { data: blocked, error: blockError } = await supabase
      .from('federated_instances')
      .select('is_blocked')
      .eq('domain', actorDomain)
      .maybeSingle()
      if (blocked?.is_blocked) {
        console.log(`Blocked instance attempted to send activity: ${activity.id} from ${actorDomain}`)
        return new Response('Blocked instance', { 
          status: 403, 
          headers: corsHeaders 
        })
      }
    }

    console.log('Received activity:', JSON.stringify(activity, null, 2))

    // TODO: Verify HTTP signature for security
    // For now, we'll accept all activities (development only)
    
    // Store the activity
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id || ''
    const { error: storeError } = await supabase
      .from('ap_activities')
      .insert({
        ap_id: activity.id,
        ap_type: activity.type,
        actor_ap_id: actorUrl,
        activity_data: activity,
        origin_domain: actorUrl ? new URL(actorUrl).hostname : null,
        status: 'received',
        is_local: false,
        to_addresses: activity.to || [],
        cc_addresses: activity.cc || []
      })

    if (storeError) {
      console.error('Failed to store activity:', storeError)
      return new Response(`Failed to store activity: ${storeError.message}`, { 
        status: 500, 
        headers: corsHeaders 
      })
    } else {
      console.log('Successfully stored activity:', activity.id)
    }

    // Process the activity based on type - VALIDATION ONLY
    // Database triggers will handle the actual business logic
    let isValid = false
    try {
      switch (activity.type) {
        case 'Follow':
          isValid = await processFollowActivity(supabase, activity, ourDomain)
          break
        case 'Accept':
          isValid = await processAcceptActivity(supabase, activity)
          break
        case 'Reject':
          isValid = await processRejectActivity(supabase, activity)
          break
        case 'Undo':
          isValid = await processUndoActivity(supabase, activity)
          break
        case 'Create':
          isValid = await processCreateActivity(supabase, activity)
          break
        case 'Update':
          isValid = await processUpdateActivity(supabase, activity)
          break
        case 'Delete':
          isValid = await processDeleteActivity(supabase, activity)
          break
        case 'Like':
          isValid = await processLikeActivity(supabase, activity)
          break
        case 'Announce':
          isValid = await processAnnounceActivity(supabase, activity)
          break
        default:
          console.log(`Unhandled activity type: ${activity.type}. Marking as invalid.`)
          isValid = false // Reject unrecognized activity types
      }

      if (isValid) {
        // Mark as processing - database triggers will handle business logic
        await supabase
          .from('ap_activities')
          .update({ 
            status: 'processing'
          })
          .eq('ap_id', activity.id)

        console.log(`✅ Activity passed validation and marked for processing: ${activity.id}`)
      } else {
        // Mark as failed with validation error
        await supabase
          .from('ap_activities')
          .update({ 
            status: 'failed', 
            error_message: 'Failed validation'
          })
          .eq('ap_id', activity.id)
      }

    } catch (processingError) {
      console.error('Activity validation error:', processingError)
      
      // For validation failures, mark as failed immediately (no retry)
      await supabase
        .from('ap_activities')
        .update({ 
          status: 'failed', 
          error_message: processingError instanceof Error ? processingError.message : 'Unknown error',
          attempts: 1,
          last_attempt_at: new Date().toISOString()
        })
        .eq('ap_id', activity.id)
    }

    return new Response('', { 
      status: 202, // Accepted
      headers: corsHeaders 
    })

  } catch (error) {
    console.error('Inbox error:', error)
    return new Response('Internal server error', { 
      status: 500, 
      headers: corsHeaders 
    })
  }
})

// Activity processing functions - SIMPLIFIED TO ONLY HANDLE BASIC VALIDATION
// Business logic moved to database triggers for better performance and consistency

async function processFollowActivity(supabase: any, activity: ActivityPubActivity, ourDomain: string) {
  // Only validate that this is a follow for our domain
  const followingActor = typeof activity.object === 'string' ? activity.object : (activity.object as any).id
  const followingMatch = followingActor.match(`https://${ourDomain}/users/([^/]+)`)
  
  if (!followingMatch) {
    console.log('Follow activity not for our domain, ignoring')
    return false
  }

  console.log(`Valid follow activity for user: ${followingMatch[1]}`)
  return true
}

async function processAcceptActivity(supabase: any, activity: ActivityPubActivity) {
  console.log('Accept activity stored, will be processed by database trigger:', activity.id)
  return true
}

async function processRejectActivity(supabase: any, activity: ActivityPubActivity) {
  console.log('Reject activity stored, will be processed by database trigger:', activity.id)
  return true
}

async function processUndoActivity(supabase: any, activity: ActivityPubActivity) {
  console.log('Undo activity stored, will be processed by database trigger:', activity.id)
  return true
}

async function processCreateActivity(supabase: any, activity: ActivityPubActivity) {
  console.log('Create activity stored, will be processed by database trigger:', activity.id)
  
  // Basic validation only - triggers handle all business logic
  const object = typeof activity.object === 'string' ? null : activity.object as any
  if (!object || object.type !== 'Note') {
    console.log('Create activity does not contain a Note object')
    return false
  }

  console.log('✅ Create activity validated for Note object')
  return true
}

async function processUpdateActivity(supabase: any, activity: ActivityPubActivity) {
  console.log('Update activity stored, will be processed by database trigger:', activity.id)
  return true
}

async function processDeleteActivity(supabase: any, activity: ActivityPubActivity) {
  console.log('Delete activity stored, will be processed by database trigger:', activity.id)
  return true
}

async function processLikeActivity(supabase: any, activity: ActivityPubActivity) {
  console.log('Like activity stored, will be processed by database trigger:', activity.id)
  return true
}

async function processAnnounceActivity(supabase: any, activity: ActivityPubActivity) {
  console.log('Announce activity stored, will be processed by database trigger:', activity.id)
  return true
}

// Remote profile fetching is now handled by database triggers
// This function is deprecated - triggers will automatically fetch/create profiles

// ==============================================================================
// DEPRECATED FUNCTIONS - MOVED TO DATABASE TRIGGERS
// ==============================================================================
// The following functions have been moved to database triggers for better
// performance, consistency, and separation of concerns:
// 
// - Remote profile fetching/creation -> Handled automatically by triggers
// - ActivityPub content parsing -> Uses parse_activitypub_content_to_jsonb() in DB
// - Direct message detection -> Uses is_activitypub_direct_message() in trigger
// - Direct message processing -> Uses process_activitypub_direct_message() in trigger
// - Public post processing -> Uses process_activitypub_public_post() in trigger
// - Mention notifications -> Created automatically by trigger functions
// - All detailed business logic -> Handled by ap_activities triggers
//
// The inbox is now minimal: validate, store, let triggers do the work.
// ==============================================================================