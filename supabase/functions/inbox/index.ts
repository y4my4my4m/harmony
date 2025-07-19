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

    console.log(`📩 Received ${activity.type} activity from ${activity.actor}`)

    // Store activity with idempotent handling using our updated function
    const { data: insertResult, error: storeError } = await supabase
      .rpc('upsert_ap_activity', {
        p_ap_id: activity.id,
        p_ap_type: activity.type,
        p_actor_id: null, // Will be resolved during processing
        p_actor_ap_id: activity.actor,
        p_activity_data: activity,
        p_target_id: null,
        p_target_type: null,
        p_status: 'received',
        p_requires_federation: false,
        p_delivery_targets: null,
        p_is_local: false
      })

    if (storeError) {
      console.error('Failed to store activity:', storeError)
      return new Response(`Failed to store activity: ${storeError.message}`, { 
        status: 500, 
        headers: corsHeaders 
      })
    }

    const wasUpdated = insertResult?.[0]?.was_updated
    
    if (wasUpdated) {
      console.log('Updated existing activity for retry:', activity.id)
    } else {
      console.log('Successfully stored activity (new or idempotent):', activity.id)
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
          console.log(`⚠️ Unsupported activity type: ${activity.type}`)
          isValid = true // Accept but don't process
      }
    } catch (processError) {
      console.error(`Failed to process ${activity.type} activity:`, processError)
      isValid = false
    }

    if (!isValid) {
      console.warn(`❌ Invalid ${activity.type} activity rejected`)
      return new Response('Activity processing failed', { 
        status: 400, 
        headers: corsHeaders 
      })
    }

    console.log(`✅ ${activity.type} activity processed successfully`)
    return new Response('Activity accepted', { 
      status: 202, 
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

  const username = followingMatch[1]
  console.log(`Valid follow activity for user: ${username}`)

  // Auto-accept the follow using the new database function
  try {
    // Get our user's profile
    const { data: ourProfile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', username)
      .eq('is_local', true)
      .single()

    if (profileError || !ourProfile) {
      console.error(`Could not find local user ${username}:`, profileError)
      return true // Still valid follow, just can't auto-accept
    }

    // Get the stored Follow activity ID
    const { data: followActivity, error: followError } = await supabase
      .from('ap_activities')
      .select('id')
      .eq('ap_id', activity.id)
      .single()

    if (followError || !followActivity) {
      console.error('Could not find stored Follow activity:', followError)
      return true
    }

    // Use our unified notification system for follow notifications
    const { error: notifyError } = await supabase.rpc('create_notification_unified', {
      p_user_id: ourProfile.id,
      p_type: 'follow_request',
      p_title: 'New follower',
      p_message: `@${activity.actor} started following you`,
      p_data: {
        actor_id: activity.actor,
        activity_id: activity.id,
        follow_id: followActivity.id
      }
    })

    if (notifyError) {
      console.error('Failed to create follow notification:', notifyError)
    } else {
      console.log(`✅ Created follow notification for user ${username}`)
    }

  } catch (error) {
    console.error('Error auto-accepting follow:', error)
  }

  return true
}

async function processAcceptActivity(supabase: any, activity: ActivityPubActivity) {
  // Database triggers will handle the actual Accept processing
  console.log('Accept activity received, database will handle processing')
  return true
}

async function processRejectActivity(supabase: any, activity: ActivityPubActivity) {
  // Database triggers will handle the actual Reject processing
  console.log('Reject activity received, database will handle processing')
  return true
}

async function processUndoActivity(supabase: any, activity: ActivityPubActivity) {
  // Validate undo activity structure
  const object = activity.object
  if (!object || typeof object !== 'object') {
    console.error('Invalid Undo activity: missing object')
    return false
  }

  console.log(`Undo activity received for ${object.type}, database will handle processing`)
  return true
}

async function processCreateActivity(supabase: any, activity: ActivityPubActivity) {
  // Validate create activity has object
  const object = activity.object
  if (!object) {
    console.error('Invalid Create activity: missing object')
    return false
  }

  console.log('Create activity received, database will handle processing')
  return true
}

async function processUpdateActivity(supabase: any, activity: ActivityPubActivity) {
  // Database triggers will handle the actual Update processing
  console.log('Update activity received, database will handle processing')
  return true
}

async function processDeleteActivity(supabase: any, activity: ActivityPubActivity) {
  // Database triggers will handle the actual Delete processing
  console.log('Delete activity received, database will handle processing')
  return true
}

async function processLikeActivity(supabase: any, activity: ActivityPubActivity) {
  // Validate like activity
  if (!activity.object) {
    console.error('Invalid Like activity: missing object')
    return false
  }

  console.log('Like activity received, database will handle processing')
  return true
}

async function processAnnounceActivity(supabase: any, activity: ActivityPubActivity) {
  // Validate announce activity
  if (!activity.object) {
    console.error('Invalid Announce activity: missing object')
    return false
  }

  console.log('Announce activity received, database will handle processing')
  return true
}