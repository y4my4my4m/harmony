// Outbox post handler
// Handles federation of Create activities for posts

export interface PostActivity {
  '@context': (string | Record<string, string>)[]
  id: string
  type: 'Create'
  actor: string
  object: {
    id: string
    type: 'Note'
    attributedTo: string
    content: string
    published: string
    to: string[]
    cc: string[]
    tag?: any[]
    attachment?: any[]
    summary?: string
    inReplyTo?: string
  }
  published: string
  to: string[]
  cc: string[]
}

/**
 * Create ActivityPub Create activity for a post
 */
export async function createPostActivity(
  supabase: any,
  post: any,
  username: string,
  baseUrl: string
): Promise<PostActivity> {
  // Get properly formatted content and tags from unified database functions
  const { data: htmlContent, error: htmlContentError } = await supabase.rpc(
    'convert_unified_content_to_activitypub_html', 
    { content: post.content }
  );
  if (htmlContentError) {
    console.error('Failed to convert content to ActivityPub HTML:', htmlContentError);
  }

  const { data: allTags, error: allTagsError } = await supabase.rpc(
    'extract_all_activitypub_tags',
    { content: post.content }
  );
  if (allTagsError) {
    console.error('Failed to extract ActivityPub tags:', allTagsError);
  }

  const { data: attachments, error: attachmentsError } = await supabase.rpc(
    'extract_activitypub_attachments',
    { content: post.content }
  );
  if (attachmentsError) {
    console.error('Failed to extract ActivityPub attachments:', attachmentsError);
  }
  
  const activityObject = {
    id: post.ap_id || `${baseUrl}/posts/${post.id}`,
    type: 'Note' as const,
    attributedTo: `${baseUrl}/users/${username}`,
    content: htmlContent || '',
    published: post.created_at,
    to: post.visibility === 'public' ? ['https://www.w3.org/ns/activitystreams#Public'] : [],
    cc: [],
    ...(allTags && allTags.length > 0 && { tag: allTags }),
    ...(attachments && attachments.length > 0 && { attachment: attachments }),
    ...(post.content_warning && { summary: post.content_warning }),
    ...(post.in_reply_to && { inReplyTo: post.in_reply_to })
  };
  
  // Build @context dynamically based on what's actually in the content
  const context: (string | Record<string, string>)[] = [
    'https://www.w3.org/ns/activitystreams',
    'https://w3id.org/security/v1'
  ];
  
  const extensions: Record<string, string> = {};
  
  // Check if we have hashtags
  const hasHashtags = allTags && allTags.some((tag: any) => tag.type === 'Hashtag');
  if (hasHashtags) {
    extensions['Hashtag'] = 'as:Hashtag';
  }
  
  // Check if we have emojis - use standard ActivityStreams, not toot:Emoji
  const hasEmojis = allTags && allTags.some((tag: any) => tag.type === 'Emoji');
  if (hasEmojis) {
    extensions['Emoji'] = 'as:Emoji';
  }
  
  // Always include sensitive for content warnings
  extensions['sensitive'] = 'as:sensitive';
  
  // Only add extensions if we have any
  if (Object.keys(extensions).length > 0) {
    context.push(extensions);
  }
  
  return {
    '@context': context,
    id: `${baseUrl}/users/${username}/activities/create/${post.id}`,
    type: 'Create',
    actor: `${baseUrl}/users/${username}`,
    published: post.created_at,
    object: activityObject,
    to: activityObject.to,
    cc: activityObject.cc
  };
}

/**
 * Handle post federation for outbox
 */
export async function handlePostFederation(
  supabase: any,
  postId: string,
  username: string,
  baseUrl: string
): Promise<{ success: boolean; activity?: PostActivity; error?: string }> {
  try {
    // Get the post
    const { data: post, error: postError } = await supabase
      .from('posts')
      .select(`
        id, content, visibility, created_at, ap_id, ap_type,
        content_warning, in_reply_to, author_id
      `)
      .eq('id', postId)
      .eq('is_local', true)
      .single()

    if (postError || !post) {
      return { success: false, error: 'Post not found' }
    }

    // Only federate public and unlisted posts
    if (!['public', 'unlisted'].includes(post.visibility)) {
      return { success: false, error: 'Post visibility not federatable' }
    }

    // Create the ActivityPub activity
    const activity = await createPostActivity(supabase, post, username, baseUrl)

    return { success: true, activity }

  } catch (error) {
    console.error('Failed to handle post federation:', error)
    return { success: false, error: error.message }
  }
}
