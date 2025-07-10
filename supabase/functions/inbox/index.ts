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

    console.log('Received activity:', JSON.stringify(activity, null, 2))

    // Basic validation
    if (!activity.id || !activity.type || !activity.actor) {
      return new Response('Invalid activity', { 
        status: 400, 
        headers: corsHeaders 
      })
    }

    // TODO: Verify HTTP signature for security
    // For now, we'll accept all activities (development only)
    
    // Store the activity
    const { error: storeError } = await supabase
      .from('ap_activities')
      .insert({
        ap_id: activity.id,
        ap_type: activity.type,
        activity_data: activity,
        origin_domain: new URL(activity.actor).hostname,
        status: 'received',
        received_at: new Date().toISOString()
      })

    if (storeError) {
      console.error('Failed to store activity:', storeError)
    }

    // Process the activity based on type
    try {
      switch (activity.type) {
        case 'Follow':
          await processFollowActivity(supabase, activity, ourDomain)
          break
        case 'Accept':
          await processAcceptActivity(supabase, activity)
          break
        case 'Reject':
          await processRejectActivity(supabase, activity)
          break
        case 'Undo':
          await processUndoActivity(supabase, activity)
          break
        case 'Create':
          await processCreateActivity(supabase, activity)
          break
        case 'Update':
          await processUpdateActivity(supabase, activity)
          break
        case 'Delete':
          await processDeleteActivity(supabase, activity)
          break
        case 'Like':
          await processLikeActivity(supabase, activity)
          break
        case 'Announce':
          await processAnnounceActivity(supabase, activity)
          break
        default:
          console.log(`Unhandled activity type: ${activity.type}`)
      }

      // Mark as processed
      await supabase
        .from('ap_activities')
        .update({ 
          status: 'processed', 
          processed_at: new Date().toISOString() 
        })
        .eq('ap_id', activity.id)

    } catch (processingError) {
      console.error('Activity processing error:', processingError)
      
      // Mark as failed
      await supabase
        .from('ap_activities')
        .update({ 
          status: 'failed', 
          error_message: processingError instanceof Error ? processingError.message : 'Unknown error',
          processed_at: new Date().toISOString() 
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

// Activity processing functions
async function processFollowActivity(supabase: any, activity: ActivityPubActivity, ourDomain: string) {
  const followerActor = activity.actor
  const followingActor = typeof activity.object === 'string' ? activity.object : (activity.object as any).id

  // Extract username from our actor URL
  const followingMatch = followingActor.match(`https://${ourDomain}/users/([^/]+)`)
  if (!followingMatch) {
    console.log('Follow activity not for our domain')
    return
  }

  const followingUsername = followingMatch[1]

  // Get or create the follower profile
  const follower = await getOrCreateRemoteProfile(supabase, followerActor)
  if (!follower) {
    console.error('Failed to resolve follower')
    return
  }

  // Get the local user being followed
  const { data: following } = await supabase
    .from('profiles')
    .select('*')
    .eq('username', followingUsername)
    .eq('domain', ourDomain)
    .eq('is_local', true)
    .single()

  if (!following) {
    console.error('Local user not found:', followingUsername)
    return
  }

  // Store follow relationship
  const { error } = await supabase
    .from('follows')
    .upsert({
      follower_id: follower.id,
      following_id: following.id,
      ap_id: activity.id,
      status: 'accepted', // Auto-accept for now
      accepted_at: new Date().toISOString(),
      is_local: false
    }, {
      onConflict: 'follower_id,following_id'
    })

  if (error) {
    console.error('Failed to store follow:', error)
    return
  }

  // TODO: Send Accept activity back to follower
  console.log(`User ${followerActor} is now following ${followingUsername}`)
}

async function processAcceptActivity(supabase: any, activity: ActivityPubActivity) {
  // Handle Accept activities (usually in response to our Follow)
  console.log('Processing Accept activity:', activity.id)
}

async function processRejectActivity(supabase: any, activity: ActivityPubActivity) {
  // Handle Reject activities
  console.log('Processing Reject activity:', activity.id)
}

async function processUndoActivity(supabase: any, activity: ActivityPubActivity) {
  // Handle Undo activities (unfollow, unlike, etc.)
  console.log('Processing Undo activity:', activity.id)
}

async function processCreateActivity(supabase: any, activity: ActivityPubActivity) {
  // Handle Create activities (new posts)
  console.log('Processing Create activity:', activity.id)
}

async function processUpdateActivity(supabase: any, activity: ActivityPubActivity) {
  // Handle Update activities (edit posts/profiles)
  console.log('Processing Update activity:', activity.id)
}

async function processDeleteActivity(supabase: any, activity: ActivityPubActivity) {
  // Handle Delete activities
  console.log('Processing Delete activity:', activity.id)
}

async function processLikeActivity(supabase: any, activity: ActivityPubActivity) {
  // Handle Like activities (favorites)
  console.log('Processing Like activity:', activity.id)
}

async function processAnnounceActivity(supabase: any, activity: ActivityPubActivity) {
  // Handle Announce activities (boosts/reblogs)
  console.log('Processing Announce activity:', activity.id)
}

async function getOrCreateRemoteProfile(supabase: any, actorUrl: string) {
  // Check if profile already exists
  const { data: existing } = await supabase
    .from('profiles')
    .select('*')
    .eq('federated_id', actorUrl)
    .single()

  if (existing) {
    return existing
  }

  // Fetch actor data from remote instance
  try {
    const response = await fetch(actorUrl, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
      }
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch actor: ${response.status}`)
    }

    const actor = await response.json()
    const domain = new URL(actorUrl).hostname

    // Create remote profile
    const { data: newProfile, error } = await supabase
      .from('profiles')
      .insert({
        username: actor.preferredUsername,
        display_name: actor.name || actor.preferredUsername,
        domain,
        avatar_url: actor.icon?.url,
        bio: actor.summary || '',
        federated_id: actorUrl,
        inbox_url: actor.inbox,
        outbox_url: actor.outbox,
        followers_url: actor.followers,
        following_url: actor.following,
        public_key: actor.publicKey?.publicKeyPem,
        is_local: false,
        last_synced_at: new Date().toISOString()
      })
      .select()
      .single()

    if (error) {
      console.error('Failed to create remote profile:', error)
      return null
    }

    return newProfile
  } catch (error) {
    console.error('Failed to fetch/create remote profile:', error)
    return null
  }
} 