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
      onConflict: ['follower_id', 'following_id']
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
  
  const object = typeof activity.object === 'string' ? null : activity.object as any
  if (!object || object.type !== 'Note') {
    console.log('Create activity does not contain a Note object')
    return
  }

  const ourDomain = Deno.env.get('DOMAIN') || 'har.mony.lol'
  
  // Check if this post mentions any of our local users
  const mentionTags = object.tag?.filter((tag: any) => tag.type === 'Mention') || []
  const localMentions = mentionTags.filter((tag: any) => 
    tag.href && tag.href.includes(`https://${ourDomain}/users/`)
  )

  if (localMentions.length === 0) {
    console.log('Create activity does not mention any local users, ignoring')
    return
  }

  console.log(`📬 Incoming post mentions ${localMentions.length} local users:`, 
    localMentions.map((tag: any) => tag.name)
  )

  try {
    // Get or create the author profile
    const author = await getOrCreateRemoteProfile(supabase, activity.actor)
    if (!author) {
      console.error('Failed to resolve post author')
      return
    }

    // Store the federated post
    const postData = {
      author_id: author.id,
      content: [{ type: 'text', text: object.content || '' }],
      visibility: 'public', // Assume public for federated posts
      ap_id: object.id,
      ap_type: 'Note',
      url: object.url || object.id,
      is_local: false,
      is_federated: true,
      federation_status: 'received',
      created_at: object.published || new Date().toISOString(),
      metadata: {
        mentions: mentionTags,
        federated_from: new URL(activity.actor).hostname
      }
    }

    const { data: savedPost, error: postError } = await supabase
      .from('posts')
      .insert(postData)
      .select()
      .single()

    if (postError) {
      console.error('Failed to save federated post:', postError)
      return
    }

    console.log(`✅ Saved federated post ${savedPost.id} from ${activity.actor}`)

    // Create notifications for mentioned users
    for (const mention of localMentions) {
      const userMatch = mention.href.match(`https://${ourDomain}/users/([^/]+)`)
      if (!userMatch) continue

      const mentionedUsername = userMatch[1]
      
      // Get the mentioned user
      const { data: mentionedUser } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', mentionedUsername)
        .eq('domain', ourDomain)
        .eq('is_local', true)
        .single()

      if (mentionedUser) {
        // Create mention notification matching the actual notifications table schema
        const notificationData = {
          actor: {
            user_id: author.id,
            username: author.username,
            display_name: author.display_name,
            avatar_url: author.avatar_url,
            domain: author.domain
          },
          post: {
            id: savedPost.id,
            content_preview: typeof savedPost.content === 'string' 
              ? savedPost.content.substring(0, 100)
              : Array.isArray(savedPost.content) 
                ? savedPost.content.map(item => item.text || '').join('').substring(0, 100)
                : '',
            ap_id: savedPost.ap_id
          },
          mention: {
            mentioned_user: mentionedUsername,
            post_type: 'federated_post'
          }
        }

        const { error: notificationError } = await supabase
          .from('notifications')
          .insert({
            user_id: mentionedUser.id,
            type: 'activitypub_mention',
            data: notificationData,
            is_read: false
          })

        if (notificationError) {
          console.error('Failed to create mention notification:', notificationError)
        } else {
          console.log(`📩 Created mention notification for @${mentionedUsername}`)
        }
      }
    }

  } catch (error) {
    console.error('Error processing Create activity:', error)
    throw error
  }
}

async function processUpdateActivity(supabase: any, activity: ActivityPubActivity) {
  // Handle Update activities (edit posts/profiles)
  console.log('Processing Update activity:', activity.id)
}

async function processDeleteActivity(supabase: any, activity: ActivityPubActivity) {
  // Handle Delete activities
  console.log('Processing Delete activity:', activity.id)
  
  // For Delete activities, the object being deleted could be a post, profile, etc.
  const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id
  
  if (!objectId) {
    console.log('Delete activity has no object to delete')
    return
  }
  
  // Check if it's a post deletion
  const { data: post } = await supabase
    .from('posts')
    .select('id, author_id')
    .eq('ap_id', objectId)
    .single()
    
  if (post) {
    // Mark post as deleted (soft delete)
    await supabase
      .from('posts')
      .update({ 
        content: null,
        visibility: 'deleted',
        deleted_at: new Date().toISOString()
      })
      .eq('id', post.id)
      
    console.log('Marked post as deleted:', objectId)
    return
  }
  
  // Could also handle profile deletions, etc.
  console.log('Delete activity processed for unknown object:', objectId)
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

    // Use the new function to create federated profile
    const { data: profileId, error } = await supabase
      .rpc('create_federated_profile', {
        p_username: actor.preferredUsername || 'unknown',
        p_display_name: actor.name || actor.preferredUsername,
        p_domain: domain,
        p_avatar_url: actor.icon?.url,
        p_bio: actor.summary || '',
        p_federated_id: actorUrl,
        p_inbox_url: actor.inbox,
        p_outbox_url: actor.outbox,
        p_followers_url: actor.followers,
        p_following_url: actor.following,
        p_public_key: actor.publicKey?.publicKeyPem
      })

    if (error) {
      console.error('Failed to create remote profile:', error)
      return null
    }

    // Fetch the created profile
    const { data: newProfile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', profileId)
      .single()

    return newProfile
  } catch (error) {
    console.error('Failed to fetch/create remote profile:', error)
    return null
  }
} 