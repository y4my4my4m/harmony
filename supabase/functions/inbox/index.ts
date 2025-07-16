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
  console.log('🏁 Processing Create activity:', activity.id)
  
  const object = typeof activity.object === 'string' ? null : activity.object as any
  if (!object || object.type !== 'Note') {
    console.log('❌ Create activity does not contain a Note object')
    return
  }

  const ourDomain = Deno.env.get('DOMAIN') || 'har.mony.lol'
  console.log('🌐 Our domain:', ourDomain)
  
  // Check if this is a direct/private message FIRST
  console.log('🔍 Starting DM detection...')
  const isDirectMessage = isActivityPubDirectMessage(object, ourDomain)
  
  if (isDirectMessage) {
    console.log('✅ PROCESSING AS DIRECT MESSAGE')
    await processDirectMessage(supabase, activity, object, ourDomain)
    return // STOP HERE - do not process as public post
  }
  
  console.log('📢 PROCESSING AS PUBLIC POST')
  
  // SAFETY CHECK: If this looks like it could be a DM, log a warning
  const mentionTags = object.tag?.filter((tag: any) => tag.type === 'Mention') || []
  const localMentions = mentionTags.filter((tag: any) => 
    tag.href && tag.href.includes(`https://${ourDomain}/users/`)
  )
  
  // Safety: If it's ONLY mentioning local users and no external users, it might be a missed DM
  const externalMentions = mentionTags.filter((tag: any) => 
    tag.href && !tag.href.includes(`https://${ourDomain}/users/`)
  )
  
  if (localMentions.length > 0 && externalMentions.length === 0 && mentionTags.length <= 2) {
    console.log('⚠️ WARNING: This looks like it could be a DM but was not detected as one!')
    console.log('⚠️ Post details:', {
      to: object.to,
      cc: object.cc,
      visibility: object.visibility,
      mentionCount: mentionTags.length,
      localMentions: localMentions.length
    })
    // Continue processing as public for now, but this indicates a detection issue
  }

  if (localMentions.length === 0) {
    console.log('❌ Public post does not mention any local users, ignoring')
    return
  }

  console.log(`📬 PUBLIC post mentions ${localMentions.length} local users:`, 
    localMentions.map((tag: any) => tag.name)
  )

  try {
    // Get or create the author profile
    const author = await getOrCreateRemoteProfile(supabase, activity.actor)
    if (!author) {
      console.error('Failed to resolve post author')
      return
    }

    // Convert ActivityPub HTML content to our standard JSONB format
    const contentArray = parseActivityPubHTMLToJSONB(object.content || '', mentionTags);

    // Store the federated post with converted content in our standard JSONB array format
    const postData = {
      author_id: author.id,
      content: contentArray, // Store as our standard JSONB array format
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
        // Extract and clean up the HTML content for the notification preview
        let contentPreview = '';
        if (Array.isArray(savedPost.content) && savedPost.content.length > 0) {
          // Content is now stored as JSONB array, extract text from first element
          const textContent = savedPost.content[0]?.text || '';
          if (typeof textContent === 'string') {
            // Strip HTML tags and decode entities for notification preview
            contentPreview = textContent
              .replace(/<[^>]*>/g, '') // Remove HTML tags
              .replace(/&lt;/g, '<')   // Decode HTML entities
              .replace(/&gt;/g, '>')
              .replace(/&amp;/g, '&')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&nbsp;/g, ' ')  // Non-breaking space
              .replace(/&hellip;/g, '...') // Ellipsis
              .trim()
              .substring(0, 120);
          }
        }
        
        // Ensure avatar URL is absolute
        const avatarUrl = author.avatar_url 
          ? (author.avatar_url.startsWith('http') ? author.avatar_url : `https://${author.domain}${author.avatar_url}`)
          : null;

        const notificationData = {
          actor: {
            user_id: author.id,
            username: author.username,
            display_name: author.display_name,
            avatar_url: avatarUrl,
            domain: author.domain
          },
          post: {
            id: savedPost.id,
            content_preview: contentPreview,
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
  const objectId = typeof activity.object === 'string' ? activity.object : (activity.object as any)?.id
  
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

  // If profile exists, check if we should update it
  if (existing) {
    // Check if profile is stale (older than 6 hours) or missing critical data
    const lastUpdated = existing.updated_at ? new Date(existing.updated_at) : new Date(existing.created_at);
    const isStale = (Date.now() - lastUpdated.getTime()) > (6 * 60 * 60 * 1000); // 6 hours
    const missingAvatar = !existing.avatar_url;
    const missingDisplayName = !existing.display_name || existing.display_name === existing.username;
    
    const shouldUpdate = isStale || missingAvatar || missingDisplayName;
    
    if (shouldUpdate) {
      console.log(`🔄 Refreshing remote profile ${existing.username}@${existing.domain} (stale: ${isStale}, missing avatar: ${missingAvatar}, missing display name: ${missingDisplayName})`);
      return await updateRemoteProfile(supabase, existing, actorUrl);
    }
    
    console.log(`✅ Using cached profile ${existing.username}@${existing.domain}`);
    return existing;
  }

  // Create new profile if it doesn't exist
  return await createNewRemoteProfile(supabase, actorUrl);
}

async function updateRemoteProfile(supabase: any, existingProfile: any, actorUrl: string) {
  try {
    // Fetch fresh actor data from remote instance
    const response = await fetch(actorUrl, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
      }
    });

    if (!response.ok) {
      console.warn(`Failed to fetch updated actor data: ${response.status}`);
      return existingProfile; // Return existing profile if fetch fails
    }

    const actor = await response.json();
    const domain = new URL(actorUrl).hostname;

    // Ensure avatar URL is absolute
    let avatarUrl = actor.icon?.url;
    if (avatarUrl && !avatarUrl.startsWith('http')) {
      avatarUrl = new URL(avatarUrl, `https://${domain}`).toString();
    }

    // Update the profile with fresh data
    const updateData: any = {
      display_name: actor.name || actor.preferredUsername || existingProfile.display_name,
      bio: actor.summary || existingProfile.bio,
      updated_at: new Date().toISOString()
    };

    // Only update avatar if we have a new one
    if (avatarUrl) {
      updateData.avatar_url = avatarUrl;
    }

    // Update other federation-specific fields
    if (actor.inbox) updateData.inbox_url = actor.inbox;
    if (actor.outbox) updateData.outbox_url = actor.outbox;
    if (actor.followers) updateData.followers_url = actor.followers;
    if (actor.following) updateData.following_url = actor.following;
    if (actor.publicKey?.publicKeyPem) updateData.public_key = actor.publicKey.publicKeyPem;

    const { data: updatedProfile, error } = await supabase
      .from('profiles')
      .update(updateData)
      .eq('id', existingProfile.id)
      .select()
      .single();

    if (error) {
      console.error('Failed to update remote profile:', error);
      return existingProfile; // Return existing profile if update fails
    }

    console.log(`✅ Updated remote profile ${updatedProfile.username}@${updatedProfile.domain}`);
    return updatedProfile;

  } catch (error) {
    console.error('Error updating remote profile:', error);
    return existingProfile; // Return existing profile if update fails
  }
}

async function createNewRemoteProfile(supabase: any, actorUrl: string) {
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

    // Ensure avatar URL is absolute
    let avatarUrl = actor.icon?.url
    if (avatarUrl && !avatarUrl.startsWith('http')) {
      avatarUrl = new URL(avatarUrl, `https://${domain}`).toString()
    }

    console.log(`👤 Creating new remote profile for ${actor.preferredUsername}@${domain} with avatar: ${avatarUrl}`);

    // Use the new function to create federated profile
    const { data: profileId, error } = await supabase
      .rpc('create_federated_profile', {
        p_username: actor.preferredUsername || 'unknown',
        p_display_name: actor.name || actor.preferredUsername,
        p_domain: domain,
        p_avatar_url: avatarUrl,
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

    console.log(`✅ Created new remote profile ${newProfile.username}@${newProfile.domain}`);
    return newProfile
  } catch (error) {
    console.error('Failed to fetch/create remote profile:', error)
    return null
  }
}

// HTML to JSONB content parser for ActivityPub content
function parseActivityPubHTMLToJSONB(htmlContent: string, mentionTags: any[] = []): any[] {
  if (!htmlContent || typeof htmlContent !== 'string') {
    return [{ type: 'text', text: '' }];
  }

  const ourDomain = Deno.env.get('DOMAIN') || 'har.mony.lol';

  // Create a map of mention URLs to tag data for easy lookup
  const mentionMap = new Map();
  mentionTags.forEach((tag: any) => {
    if (tag.type === 'Mention' && tag.href && tag.name) {
      mentionMap.set(tag.href, tag);
    }
  });

  console.log('📋 Mention map created:', Array.from(mentionMap.entries()));

  // Clean up malformed HTML first and simplify the structure
  const cleanHtml = htmlContent
    // Remove p tags
    .replace(/<\/?p[^>]*>/gi, '')
    // Fix nested anchor tags
    .replace(/<a\s+href="<a\s+href="\s*([^"]+)"\s*[^>]*>\s*([^<]+)<\/a>/gi, '<a href="$1" class="mention">$2</a>')
    // Simplify h-card spans with nested structure 
    .replace(/<span[^>]*class="[^"]*h-card[^"]*"[^>]*>.*?<a[^>]*href="\s*([^"]+)"\s*[^>]*class="[^"]*mention[^"]*"[^>]*>@?<span>([^<]+)<\/span><\/a>.*?<\/span>/gi, '<a href="$1" class="mention">@$2</a>')
    // Handle simpler mention patterns
    .replace(/<a[^>]*href="\s*([^"]+)"\s*[^>]*class="[^"]*mention[^"]*"[^>]*>@?([^<]+)<\/a>/gi, '<a href="$1" class="mention">@$2</a>')
    // Remove stray closing tags
    .replace(/<\/a>\s*class="[^"]*"/gi, '')
    // Clean up whitespace
    .replace(/\s+/g, ' ').trim();

  console.log('🧹 Cleaned HTML:', cleanHtml);

  const result: any[] = [];
  
  // Use a more robust regex-based approach for the cleaned HTML
  const mentionRegex = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*mention[^"]*"[^>]*>@?([^<]+)<\/a>/gi;
  
  let lastIndex = 0;
  let match;
  
  while ((match = mentionRegex.exec(cleanHtml)) !== null) {
    const fullMatch = match[0];
    const href = match[1];
    const linkText = match[2];
    
    // Add any text before this mention
    const textBefore = cleanHtml.substring(lastIndex, match.index).trim();
    if (textBefore) {
      result.push({ type: 'text', text: textBefore });
    }
    
    // Get mention details from the map or parse from href
    const mentionTag = mentionMap.get(href);
    let username, domain;
    
    if (mentionTag && mentionTag.name) {
      // Parse from the name field: @username or @username@domain
      const nameParts = mentionTag.name.replace('@', '').split('@');
      username = nameParts[0];
      domain = nameParts[1] || (href ? new URL(href).hostname : ourDomain);
    } else {
      // Fallback: parse from link text and href
      username = linkText.replace('@', '').trim();
      domain = href ? new URL(href).hostname : ourDomain;
    }
    
    console.log(`🔍 Processing mention: href=${href}, linkText=${linkText}, username=${username}, domain=${domain}`);
    
    // Use unified mention format (same as chat system)
    result.push({
      type: 'mention',
      username: username,
      domain: domain,
      isLocal: domain === ourDomain,
      url: href
      // Note: userId will be resolved later if needed
    });
    
    lastIndex = match.index + fullMatch.length;
  }
  
  // Add any remaining text after the last mention
  const remainingText = cleanHtml.substring(lastIndex).trim();
  if (remainingText) {
    result.push({ type: 'text', text: remainingText });
  }
  
  // If no mentions were found, treat the whole thing as text
  if (result.length === 0) {
    // Strip all HTML tags for plain text
    const plainText = cleanHtml.replace(/<[^>]*>/g, '').trim();
    if (plainText) {
      result.push({ type: 'text', text: plainText });
    }
  }

  // Decode HTML entities in text parts
  const finalResult = result.map(item => {
    if (item.type === 'text') {
      item.text = item.text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&hellip;/g, '...')
        .replace(/<br\s*\/?>/gi, '\n')
        .trim();
    }
    return item;
  }).filter(item => 
    // Remove empty text items
    !(item.type === 'text' && !item.text.trim())
  );

  console.log('✅ Final parsed result:', finalResult);

  return finalResult.length > 0 ? finalResult : [{ type: 'text', text: '' }];
}

// Helper function to determine if an ActivityPub Note is a direct message
function isActivityPubDirectMessage(object: any, ourDomain: string): boolean {
  console.log('🔍 DM Detection Analysis:', {
    id: object.id,
    visibility: object.visibility,
    to: object.to,
    cc: object.cc,
    hasTag: !!object.tag,
    tagCount: object.tag?.length || 0
  })
  
  // Method 1: Check visibility property (Mastodon style)
  if (object.visibility === 'direct') {
    console.log('✅ DM detected via visibility=direct')
    return true
  }
  
  // Method 2: Check addressing - direct messages are typically sent only to specific recipients
  // without including public collections
  const to = Array.isArray(object.to) ? object.to : (object.to ? [object.to] : [])
  const cc = Array.isArray(object.cc) ? object.cc : (object.cc ? [object.cc] : [])
  
  console.log('🔍 Audience analysis:', {
    to: to,
    cc: cc,
    toLength: to.length,
    ccLength: cc.length
  })
  
  const publicIndicators = [...to, ...cc].filter(recipient => {
    const isPublic = recipient === 'https://www.w3.org/ns/activitystreams#Public' ||
                     recipient === 'as:Public' ||
                     recipient.includes('/followers')
    if (isPublic) {
      console.log('❌ Found public indicator:', recipient)
    }
    return isPublic
  })
  
  const hasPublicAudience = publicIndicators.length > 0
  
  if (hasPublicAudience) {
    console.log('❌ DM rejected - has public audience:', publicIndicators)
    return false
  }
  
  // Check for local recipients in addressing
  const localRecipients = [...to, ...cc].filter(recipient => 
    recipient.includes(`https://${ourDomain}/users/`) ||
    recipient.includes(`https://${ourDomain}/social/profile/`)
  )
  
  console.log('🔍 Local recipients in addressing:', localRecipients)
  
  if (localRecipients.length > 0) {
    console.log('✅ DM detected via direct addressing to local users')
    return true
  }
  
  // Method 3: Check mention tags - if only mentioned users are from our domain
  // and there's no public audience, treat as DM
  const mentionTags = object.tag?.filter((tag: any) => tag.type === 'Mention') || []
  const localMentions = mentionTags.filter((tag: any) => 
    tag.href && (
      tag.href.includes(`https://${ourDomain}/users/`) ||
      tag.href.includes(`https://${ourDomain}/social/profile/`)
    )
  )
  
  console.log('🔍 Mention analysis:', {
    totalMentions: mentionTags.length,
    localMentions: localMentions.length,
    localMentionHrefs: localMentions.map(tag => tag.href),
    hasPublicAudience: hasPublicAudience
  })
  
  // For mention-based DMs: no public audience + local mentions + reasonable mention count
  if (!hasPublicAudience && localMentions.length > 0 && mentionTags.length <= 3) {
    console.log('✅ DM detected via mention-only pattern')
    return true
  }
  
  console.log('❌ Not detected as DM - will process as public post')
  return false
}

// Process direct messages from ActivityPub
async function processDirectMessage(supabase: any, activity: ActivityPubActivity, object: any, ourDomain: string) {
  console.log('🔒 Processing direct message:', activity.id)
  
  try {
    // Get or create the author profile
    const author = await getOrCreateRemoteProfile(supabase, activity.actor)
    if (!author) {
      console.error('Failed to resolve DM author')
      return
    }

    console.log(`📧 Direct message from ${author.username}@${author.domain}`)

    // Extract mentioned local users
    const mentionTags = object.tag?.filter((tag: any) => tag.type === 'Mention') || []
    const localMentions = mentionTags.filter((tag: any) => 
      tag.href && tag.href.includes(`https://${ourDomain}/users/`)
    )

    // Also check direct addressing
    const to = Array.isArray(object.to) ? object.to : (object.to ? [object.to] : [])
    const cc = Array.isArray(object.cc) ? object.cc : (object.cc ? [object.cc] : [])
    
    const directlyAddressed = [...to, ...cc]
      .filter(recipient => 
        recipient.includes(`https://${ourDomain}/users/`) ||
        recipient.includes(`https://${ourDomain}/social/profile/`)
      )
      .map(recipient => {
        // Handle both /users/ and /social/profile/ patterns
        const userMatch = recipient.match(`https://${ourDomain}/users/([^/]+)`)
        const profileMatch = recipient.match(`https://${ourDomain}/social/profile/([^/]+)`)
        return userMatch ? userMatch[1] : (profileMatch ? profileMatch[1] : null)
      })
      .filter(Boolean)

    // Combine mentioned and directly addressed users
    const mentionedUsernames = new Set([
      ...localMentions.map((tag: any) => {
        // Handle both /users/ and /social/profile/ patterns
        const userMatch = tag.href.match(`https://${ourDomain}/users/([^/]+)`)
        const profileMatch = tag.href.match(`https://${ourDomain}/social/profile/([^/]+)`)
        return userMatch ? userMatch[1] : (profileMatch ? profileMatch[1] : null)
      }).filter(Boolean),
      ...directlyAddressed
    ])

    if (mentionedUsernames.size === 0) {
      console.log('Direct message has no local recipients')
      return
    }

    console.log(`📧 DM mentions ${mentionedUsernames.size} local users:`, Array.from(mentionedUsernames))

    // Convert ActivityPub HTML content to our standard JSONB format
    const contentArray = parseActivityPubHTMLToJSONB(object.content || '', mentionTags)

    // Process each mentioned user - create conversations and messages
    for (const username of mentionedUsernames) {
      // Get the local user
      const { data: localUser } = await supabase
        .from('profiles')
        .select('id, username')
        .eq('username', username)
        .eq('domain', ourDomain)
        .eq('is_local', true)
        .single()

      if (!localUser) {
        console.error(`Local user not found: ${username}`)
        continue
      }

      // Find or create conversation between the federated user and local user
      const conversationId = await findOrCreateDMConversation(supabase, author.id, localUser.id)
      
      if (!conversationId) {
        console.error(`Failed to create/find conversation between ${author.id} and ${localUser.id}`)
        continue
      }

      // Store the DM message
      const messageData = {
        conversation_id: conversationId,
        user_id: author.id,
        content: contentArray,
        created_at: object.published || new Date().toISOString(),
        is_system: false,
        // Add federation metadata
        metadata: {
          federated: true,
          ap_id: object.id,
          ap_type: 'Note',
          from_domain: author.domain,
          original_url: object.url || object.id
        }
      }

      const { data: savedMessage, error: messageError } = await supabase
        .from('messages')
        .insert(messageData)
        .select()
        .single()

      if (messageError) {
        console.error(`Failed to save federated DM for ${username}:`, messageError)
        continue
      }

      console.log(`✅ Saved federated DM ${savedMessage.id} from ${author.username}@${author.domain} to ${username}`)

      // Note: DM notifications are automatically created by database triggers
      // No need to manually create notifications here
    }

  } catch (error) {
    console.error('Error processing direct message:', error)
    throw error
  }
}

// Find or create a DM conversation between two users
async function findOrCreateDMConversation(supabase: any, user1Id: string, user2Id: string): Promise<string | null> {
  try {
    // Check if conversation already exists (regardless of user order)
    // Try a simpler approach first - search for both orderings
    let existingConversation: any = null;
    
    // Try first ordering
    const { data: conv1 } = await supabase
      .from('conversations')
      .select('id')
      .eq('user1', user1Id)
      .eq('user2', user2Id)
      .maybeSingle()
    
    if (conv1) {
      existingConversation = conv1;
    } else {
      // Try reverse ordering
      const { data: conv2 } = await supabase
        .from('conversations')
        .select('id')
        .eq('user1', user2Id)
        .eq('user2', user1Id)
        .maybeSingle()
      
      if (conv2) {
        existingConversation = conv2;
      }
    }

    if (existingConversation) {
      console.log(`📝 Found existing conversation: ${existingConversation.id}`)
      return existingConversation.id
    }

    // Create new conversation
    const { data: newConversation, error } = await supabase
      .from('conversations')
      .insert({
        user1: user1Id,
        user2: user2Id,
        created_at: new Date().toISOString()
      })
      .select('id')
      .single()

    if (error) {
      console.error('Failed to create conversation:', error)
      return null
    }

    console.log(`🆕 Created new conversation: ${newConversation.id}`)
    return newConversation.id

  } catch (error) {
    console.error('Error finding/creating conversation:', error)
    return null
  }
}