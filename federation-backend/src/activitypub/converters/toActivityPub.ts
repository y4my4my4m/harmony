import config from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { getFullAvatarUrl, getFullBannerUrl } from '../../utils/urlUtils.js';
import { getSupabaseClient } from '../../config/supabase.js';
import { FOCAL_POINT_CONTEXT, storedFocalPoint } from '../../utils/focalPoint.js';

/**
 * Insert zero-width spaces around :shortcode: patterns so parsers like
 * Misskey MFM can detect word boundaries (e.g. `:fire:y4my4m:fire:` →
 * `\u200b:fire:\u200by4my4m\u200b:fire:\u200b`).
 */
function normalizeShortcodeBoundaries(text: string): string {
  if (!text || !text.includes(':')) return text;
  return text.replace(/:([a-zA-Z0-9_+-]+):/g, '\u200b:$1:\u200b');
}

/**
 * Media type from a URL's file extension. Storage may serve uploads as
 * application/octet-stream, so remotes need this hint on icon/image.
 */
function imageMediaTypeFromUrl(url: string): string | undefined {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'avif': return 'image/avif';
    case 'svg': return 'image/svg+xml';
    default: return undefined;
  }
}

/**
 * Actor URL of a mention part. `mentionActorUrls` maps profile id to the
 * stored actor id; without an entry the URL is guessed as
 * `https://<domain>/users/<username>`, which is wrong for Misskey
 * (`/users/<id>`) and Lemmy (`/u/<name>`).
 */
function mentionHref(item: any, mentionActorUrls?: Map<string, string>): string {
  const known = item.userId ? mentionActorUrls?.get(item.userId) : undefined;
  if (known) return known;
  const domain = item.domain || config.INSTANCE_DOMAIN;
  return `https://${domain}/users/${item.username || 'unknown'}`;
}

/** Visible handle: `@user` on this instance's host, `@user@host` otherwise. */
function mentionLabel(item: any): string {
  const username = item.username || 'unknown';
  const domain = String(item.domain || config.INSTANCE_DOMAIN).toLowerCase();
  return domain === String(config.INSTANCE_DOMAIN).toLowerCase() ? `@${username}` : `@${username}@${domain}`;
}

/**
 * Convert internal post format to ActivityPub Note
 * Supports quote posts via quoteUrl (Fediverse) and _misskey_quote (Misskey)
 *
 * Addressing follows Mastodon: public is to Public, cc followers; unlisted
 * is to followers, cc Public; followers-only is to followers; direct is to
 * the mentioned actors. Mentioned actors are cc'd on the first three.
 */
export function postToNote(
  post: any,
  author: any,
  quoteUrl?: string,
  mentionActorUrls?: Map<string, string>,
): any {
  const domain = config.INSTANCE_DOMAIN;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const postUrl = post.ap_id || `https://${domain}/posts/${post.id}`;

  let toAddresses = getToAddresses(post.visibility, authorUrl);
  let ccAddresses = getCcAddresses(post.visibility, authorUrl);

  if (Array.isArray(post.content)) {
    const mentionUrls: string[] = Array.from(new Set<string>(
      post.content
        .filter((part: any) => part?.type === 'mention')
        .map((m: any) => mentionHref(m, mentionActorUrls)),
    ));
    if (post.visibility === 'direct' || post.visibility === 'private') {
      toAddresses = [...toAddresses, ...mentionUrls];
    } else {
      ccAddresses = [...ccAddresses, ...mentionUrls.filter((u) => !toAddresses.includes(u) && !ccAddresses.includes(u))];
    }
  }

  const note: any = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        'quoteUrl': 'as:quoteUrl',
        'misskey': 'https://misskey-hub.net/ns#',
        '_misskey_quote': 'misskey:_misskey_quote',
      }
    ],
    id: postUrl,
    type: 'Note',
    attributedTo: authorUrl,
    published: post.created_at,
    content: extractContentAsHtml(post.content, mentionActorUrls),
    to: toAddresses,
    cc: ccAddresses,
    likes: `${postUrl}/likes`,
    replies: `${postUrl}/replies`,
  };

  // Add content warning (ActivityPub uses 'summary' for CW)
  if (post.content_warning) {
    note.summary = post.content_warning;
  }

  if (post.is_sensitive) {
    note.sensitive = true;
  }

  const attachments = extractAttachments(post.content);
  const seenAttachmentUrls = new Set(attachments.map((a) => a.url));
  for (const media of mediaAttachmentsToAp(post.media_attachments)) {
    if (!seenAttachmentUrls.has(media.url)) {
      seenAttachmentUrls.add(media.url);
      attachments.push(media);
    }
  }
  if (attachments.length > 0) {
    note.attachment = attachments;
    if (attachments.some((a) => a.focalPoint)) Object.assign(note['@context'][1], FOCAL_POINT_CONTEXT);
  }

  const tags = extractTags(post.content, mentionActorUrls);
  if (tags.length > 0) {
    note.tag = tags;
  }

  if (post.in_reply_to) {
    // in_reply_to is a UUID - need to get the ap_id of the parent post
    // For federated posts, this is their original ActivityPub URL
    // For local posts, this is our generated URL
    note.inReplyTo = post.in_reply_to; // Will be resolved in createPostActivity
  }

  if (quoteUrl) {
    note.quoteUrl = quoteUrl;
    note._misskey_quote = quoteUrl; // Misskey compatibility
  }

  return note;
}

/**
 * Convert internal message format to ActivityPub Note (for DMs)
 */
export function messageToNote(message: any, author: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const messageUrl = `https://${domain}/messages/${message.id}`;

  const note: any = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: messageUrl,
    type: 'Note',
    attributedTo: authorUrl,
    published: message.created_at,
    content: extractContentAsHtml(message.content),
    to: [], // Will be filled with conversation participants
    cc: [],
  };

  return note;
}

/** JSON-LD terms of an actor's alsoKnownAs and movedTo, as Mastodon's actor context defines them. */
export const ACCOUNT_MIGRATION_CONTEXT = {
  alsoKnownAs: { '@id': 'as:alsoKnownAs', '@type': '@id' },
  movedTo: { '@id': 'as:movedTo', '@type': '@id' },
};

/**
 * Convert user profile to ActivityPub Actor
 */
export function profileToActor(profile: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${profile.username}`;

  let customStatusData = null;
  if (profile.custom_status) {
    try {
      customStatusData = typeof profile.custom_status === 'string' 
        ? JSON.parse(profile.custom_status) 
        : profile.custom_status;
    } catch (e) {
      // Ignore parse errors
    }
  }

  const actor: any = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
      ACCOUNT_MIGRATION_CONTEXT,
    ],
    id: userUrl,
    type: 'Person',
    preferredUsername: profile.username,
    name: normalizeShortcodeBoundaries(profile.display_name || profile.username),
    summary: profile.bio || '',
    inbox: `${userUrl}/inbox`,
    outbox: `${userUrl}/outbox`,
    followers: `${userUrl}/followers`,
    following: `${userUrl}/following`,
    url: userUrl,
    published: profile.created_at,
    endpoints: {
      sharedInbox: `https://${domain}/inbox`,
    },
  };

  const avatarUrl = getFullAvatarUrl(profile.avatar_url);
  if (avatarUrl) {
    actor.icon = {
      type: 'Image',
      mediaType: imageMediaTypeFromUrl(avatarUrl),
      url: avatarUrl,
    };
  }

  const bannerUrl = getFullBannerUrl(profile.banner_url);
  if (bannerUrl) {
    actor.image = {
      type: 'Image',
      mediaType: imageMediaTypeFromUrl(bannerUrl),
      url: bannerUrl,
    };
  }

  if (profile.public_key) {
    actor.publicKey = {
      id: `${userUrl}#main-key`,
      owner: userUrl,
      publicKeyPem: profile.public_key,
    };
  }

  actor.featured = `${userUrl}/featured`;

  if (profile.profile_fields && Array.isArray(profile.profile_fields)) {
    actor.attachment = profile.profile_fields.map((field: any) => ({
      type: 'PropertyValue',
      name: field.name,
      value: field.value,
    }));
  }

  // Mastodon emits false for an unlocked account.
  actor.manuallyApprovesFollowers = profile.manually_approves_followers === true;

  const aliases = Array.isArray(profile.also_known_as)
    ? profile.also_known_as.filter((uri: unknown) => typeof uri === 'string' && uri && uri !== userUrl)
    : [];
  if (aliases.length > 0) {
    actor.alsoKnownAs = aliases;
  }
  if (typeof profile.moved_to_uri === 'string' && profile.moved_to_uri) {
    actor.movedTo = profile.moved_to_uri;
  }

  if (profile.federation_discoverable !== undefined) {
    actor.discoverable = profile.federation_discoverable;
  }

  // Custom emojis in display name and bio (AP Emoji tags + Misskey-style emojis object)
  const emojiTags: any[] = [];
  const misskeyEmojis: Record<string, string> = {};

  const addProfileEmojis = (emojis: Array<{ name: string; url: string; id?: string }>) => {
    for (const emoji of emojis) {
      if (!emoji.name || !emoji.url) continue;
      const shortcode = emoji.name.includes(':') ? emoji.name : `:${emoji.name}:`;
      const emojiUrl = emoji.url.startsWith('http') ? emoji.url : `https://${domain}${emoji.url}`;
      const ext = emojiUrl.split('.').pop()?.toLowerCase().split('?')[0] || '';
      const mediaType = ext === 'gif' ? 'image/gif'
        : ext === 'webp' ? 'image/webp'
        : ext === 'svg' ? 'image/svg+xml'
        : 'image/png';
      emojiTags.push({
        type: 'Emoji',
        id: emoji.id ? `https://${domain}/emojis/${emoji.id}` : emojiUrl,
        name: shortcode,
        icon: {
          type: 'Image',
          mediaType,
          url: emojiUrl,
        },
      });
      misskeyEmojis[emoji.name.replace(/:/g, '')] = emojiUrl;
    }
  };

  // Read pre-resolved emojis from federation_metadata
  if (profile.federation_metadata) {
    const meta = typeof profile.federation_metadata === 'string'
      ? JSON.parse(profile.federation_metadata)
      : profile.federation_metadata;
    if (meta.display_name_emojis && Array.isArray(meta.display_name_emojis)) {
      addProfileEmojis(meta.display_name_emojis);
    }
    if (meta.bio_emojis && Array.isArray(meta.bio_emojis)) {
      addProfileEmojis(meta.bio_emojis);
    }
  }

  if (emojiTags.length > 0) {
    actor.tag = [...(actor.tag || []), ...emojiTags];
    actor.emojis = misskeyEmojis;
  }

  // Harmony extension: profile color
  if (profile.color) {
    actor['harmony:profileColor'] = profile.color;
  }

  // Harmony extension: custom status (Discord-style status)
  if (customStatusData) {
    // Ensure emoji_url is absolute for federation
    if (customStatusData.emoji_url && typeof customStatusData.emoji_url === 'string') {
      // If it's already absolute, keep it; otherwise convert to absolute
      if (!customStatusData.emoji_url.startsWith('http://') && !customStatusData.emoji_url.startsWith('https://')) {
        // Relative path - convert to full Supabase URL
        const supabase = getSupabaseClient();
        const { data } = supabase.storage
          .from('emojis')
          .getPublicUrl(customStatusData.emoji_url);
        customStatusData.emoji_url = data.publicUrl;
      }
    }
    actor['harmony:customStatus'] = customStatusData;
  }

  return actor;
}

/**
 * Create a Follow activity
 */
export function createFollowActivity(follower: any, following: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const followerUrl = `https://${domain}/users/${follower.username}`;
  const activityId = `${followerUrl}/follows/${following.id}`;

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Follow',
    actor: followerUrl,
    object: following.federated_id || following.id,
  };
}

/**
 * Create an Accept activity (for follow requests)
 */
export function createAcceptActivity(actor: any, followActivity: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const actorUrl = `https://${domain}/users/${actor.username}`;
  const activityId = `${actorUrl}/accepts/${Date.now()}`;

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Accept',
    actor: actorUrl,
    object: followActivity,
  };
}

/**
 * Create a Reject activity (for follow requests)
 */
export function createRejectActivity(actor: any, followActivity: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const actorUrl = `https://${domain}/users/${actor.username}`;
  const activityId = `${actorUrl}/rejects/${Date.now()}`;

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Reject',
    actor: actorUrl,
    object: followActivity,
  };
}

/**
 * Id of the Like or EmojiReact federated for a post_interactions row. An Undo names the same
 * id: Pleroma and Akkoma resolve the undone activity by id, Mastodon, GoToSocial and Misskey
 * by actor and object.
 */
export function likeActivityId(user: { username: string }, interactionId: string): string {
  return `https://${config.INSTANCE_DOMAIN}/users/${user.username}/likes/${interactionId}`;
}

/**
 * `:name@domain:` -> `:name:` when an Emoji tag carries the image. Misskey's
 * isCustomEmojiRegexp /^:([\w+-]+)(?:@\.)?:$/ matches only `:name:` or `:name@.:` and
 * infers the origin from the actor's host; Pleroma and Akkoma match the tag name against
 * the content with colons trimmed.
 */
function reactionContent(emojiContent: string, emojiData?: { name: string; url: string }): string {
  return emojiData ? emojiContent.replace(/@[\w.-]+(?=:$)/, '') : emojiContent;
}

/** Emoji tag for a custom emoji reaction, named `:name:` without a domain. */
function emojiReactionTag(emojiData: { name: string; url: string }): any {
  const ext = emojiData.url.split('.').pop()?.toLowerCase().split('?')[0] || '';
  const mediaType = ext === 'gif' ? 'image/gif'
    : ext === 'webp' ? 'image/webp'
    : ext === 'svg' ? 'image/svg+xml'
    : 'image/png';
  return {
    type: 'Emoji',
    id: emojiData.url,
    name: `:${emojiData.name}:`,
    icon: {
      type: 'Image',
      mediaType,
      url: emojiData.url,
    },
  };
}

/**
 * Create a Like activity: a favourite when `emojiContent` is absent, otherwise a Misskey
 * reaction.
 *
 * A favourite carries no `content` or `_misskey_reaction`. Mastodon reads every Like as a
 * favourite; Misskey maps a bare Like to the instance's like reaction.
 *
 * A reaction carries the emoji in `content` and `_misskey_reaction`, and a custom emoji
 * adds an Emoji tag. Misskey and its forks read `_misskey_reaction`; Pleroma and Akkoma
 * rewrite such a Like into an EmojiReact.
 *
 * @param recipientUrls - ActivityPub actor URLs to address the activity to.
 *   For post reactions pass the post author URL; for DM reactions pass all
 *   remote conversation participants. Omit for backwards-compat (no `to`).
 * @param activityId - Stable id, from likeActivityId for a post interaction.
 */
export function createLikeActivity(
  user: any, 
  objectUrl: string, 
  emojiContent?: string,
  emojiData?: { name: string; url: string },
  recipientUrls?: string[],
  activityId?: string,
): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;

  const activity: any = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        'toot': 'http://joinmastodon.org/ns#',
        'Emoji': 'toot:Emoji',
        'misskey': 'https://misskey-hub.net/ns#',
        '_misskey_reaction': 'misskey:_misskey_reaction',
      }
    ],
    id: activityId || `${userUrl}/likes/${Date.now()}`,
    type: 'Like',
    actor: userUrl,
    object: objectUrl,
  };

  if (emojiContent) {
    const reactionValue = reactionContent(emojiContent, emojiData);
    activity.content = reactionValue;
    activity._misskey_reaction = reactionValue;
  }

  if (recipientUrls && recipientUrls.length > 0) {
    activity.to = recipientUrls;
  }

  if (emojiContent && emojiData?.url) {
    activity.tag = [emojiReactionTag(emojiData)];
  }

  return activity;
}

/**
 * Create an EmojiReact activity (FEP-c0e0; Pleroma and Akkoma's native reaction). The emoji
 * is in `content`; a custom emoji adds an Emoji tag whose name, colons trimmed, equals the
 * content's (Pleroma EmojiReactValidator.maybe_validate_tag_presence).
 */
export function createEmojiReactActivity(
  user: any,
  objectUrl: string,
  emojiContent: string,
  emojiData: { name: string; url: string } | undefined,
  recipientUrls: string[] | undefined,
  activityId: string,
): any {
  const userUrl = `https://${config.INSTANCE_DOMAIN}/users/${user.username}`;
  const activity: any = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        'toot': 'http://joinmastodon.org/ns#',
        'Emoji': 'toot:Emoji',
        'litepub': 'http://litepub.social/ns#',
        'EmojiReact': 'litepub:EmojiReact',
      }
    ],
    id: activityId,
    type: 'EmojiReact',
    actor: userUrl,
    object: objectUrl,
    content: reactionContent(emojiContent, emojiData),
  };

  if (recipientUrls && recipientUrls.length > 0) {
    activity.to = recipientUrls;
  }

  if (emojiData?.url) {
    activity.tag = [emojiReactionTag(emojiData)];
  }

  return activity;
}

/**
 * Undo of `activity`, embedded under `${activity.id}/undo`. The embedded copy keeps no
 * @context and no per-delivery audience; the Undo takes the inner @context.
 */
export function createUndoActivity(user: { username: string }, activity: any): any {
  const { '@context': context, to: _to, ...embedded } = activity;
  return {
    '@context': context,
    id: `${activity.id}/undo`,
    type: 'Undo',
    actor: `https://${config.INSTANCE_DOMAIN}/users/${user.username}`,
    object: embedded,
  };
}

/**
 * Create an Announce activity (for reblogs/boosts)
 */
export function createAnnounceActivity(user: any, objectUrl: string): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;
  const activityId = `${userUrl}/announces/${Date.now()}`;

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Announce',
    actor: userUrl,
    object: objectUrl,
    published: new Date().toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${userUrl}/followers`],
  };
}

/**
 * Create a Delete activity
 */
export function createDeleteActivity(user: any, objectUrl: string): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;
  const activityId = `${userUrl}/deletes/${Date.now()}`;

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Delete',
    actor: userUrl,
    object: objectUrl,
  };
}

/**
 * Create an Update activity (for profile updates)
 */
export function createUpdateActivity(profile: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${profile.username}`;
  const activityId = `${userUrl}/updates/${Date.now()}`;

  const actor = profileToActor(profile);

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Update',
    actor: userUrl,
    published: new Date().toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${userUrl}/followers`],
    object: actor,
  };
}

/**
 * Helper: Extract HTML content from JSONB content (MessagePart[])
 * Converts to ActivityPub-compatible HTML with mentions, hashtags, and emojis
 */
/**
 * Full HTML attribute / text escape. Covers the five characters that
 * have special meaning in HTML (`& < > " '`). Anything we splice into
 * outbound ActivityPub `content` HTML - including mention `href`,
 * displayed labels, hashtag names, and URL anchors - runs through this.
 */
function escapeHtmlAttr(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Safe-scheme URL allowlist for outbound federation. Same list as the
 * frontend `sanitizeUrl` in `src/utils/sanitize.ts`. `javascript:`,
 * `data:`, `vbscript:`, etc. all reject.
 */
const SAFE_URL_SCHEMES_OUTBOUND = new Set(['http:', 'https:', 'mailto:', 'tel:']);

function safeAttrUrlOutbound(url: string | null | undefined): string {
  if (url == null) return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = String(url).replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned) return '';
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!schemeMatch) return cleaned;
  const scheme = schemeMatch[1].toLowerCase() + ':';
  if (!SAFE_URL_SCHEMES_OUTBOUND.has(scheme)) return '';
  return cleaned;
}

function extractContentAsHtml(content: any, mentionActorUrls?: Map<string, string>): string {
  // Defensive: the DB constraint `posts_content_is_array` /
  // `messages_content_is_array` makes this path unreachable, but if a
  // raw string ever slipped through (an early migration, an unconverted
  // federation import, ...) we'd be shipping it straight to Mastodon /
  // Misskey / etc. as our outbound HTML. Receiving servers run their
  // own sanitizers but we shouldn't rely on theirs - escape so user
  // content can never go out as live HTML markup.
  if (typeof content === 'string') {
    return escapeHtmlAttr(content);
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (item.type === 'text') {
        // Escape HTML entities for safety (match SQL logic)
        let text = item.text || '';
        text = text.replace(/&/g, '&amp;');
        text = text.replace(/</g, '&lt;');
        text = text.replace(/>/g, '&gt;');
        return text;
      }
      else if (item.type === 'mention') {
        // `username` / `domain` originate in a (possibly federated)
        // MessagePart, so escape both before splicing them into the URL
        // and the visible label. Receiving servers do further sanitisation,
        // but we shouldn't emit broken HTML in the first place.
        const href = safeAttrUrlOutbound(mentionHref(item, mentionActorUrls));
        const displayName = mentionLabel(item);
        return `<a href="${escapeHtmlAttr(href)}" class="mention">${escapeHtmlAttr(displayName)}</a>`;
      }
      else if (item.type === 'hashtag') {
        const name = item.name || '';
        const href = safeAttrUrlOutbound(`https://${config.INSTANCE_DOMAIN}/tags/${name}`);
        return `<a href="${escapeHtmlAttr(href)}" class="mention hashtag" rel="tag">#${escapeHtmlAttr(name)}</a>`;
      }
      else if (item.type === 'emoji') {
        // Custom emoji - use :name: syntax, actual emoji data in tags.
        // The name is plain text here (no HTML context), but receiving
        // parsers might still treat it as inline content, so escape.
        return escapeHtmlAttr(`:${item.emoji?.name || 'emoji'}:`);
      }
      else if (item.type === 'url') {
        // Scheme-validate first; only http(s)/mailto/tel get a live
        // anchor. Anything else (`javascript:`, `data:`, ...) renders as
        // escaped text so a malicious payload can't propagate through
        // federation as a clickable XSS link.
        const safeUrl = safeAttrUrlOutbound(item.url || '');
        if (!safeUrl) {
          return escapeHtmlAttr(item.url || '');
        }
        return `<a href="${escapeHtmlAttr(safeUrl)}" rel="noopener noreferrer" target="_blank">${escapeHtmlAttr(safeUrl)}</a>`;
      }
      return '';
    })
    .join('');
}

/**
 * Helper: Extract attachments from JSONB content
 */
function extractAttachments(content: any): any[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter((item) => item.type === 'file')
    .map((item) => {
      const mediaType = getMediaType(item.fileType, item.mimeType, item.url);
      
      const attachment: any = {
        type: 'Document',
        mediaType,
        url: item.url,
        name: firstText(item.altText, item.description), // Alt text; never the file name
      };

      // Add dimensions if available (important for image layout)
      if (item.width) attachment.width = item.width;
      if (item.height) attachment.height = item.height;
      
      if (item.blurhash) attachment.blurhash = item.blurhash;
      
      const focalPoint = storedFocalPoint(item);
      if (focalPoint) attachment.focalPoint = focalPoint;
      
      return attachment;
    });
}

/** First non-empty trimmed string among the arguments, else null. */
function firstText(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * `posts.media_attachments` → AP attachments. Composer rows are
 * `{ type, url, mediaType, name, description, meta?: { focus } }` where `name`
 * is the upload's file name and `description` the alt text; `name` is never
 * sent as alt text. Imported rows may follow the Mastodon API shape (`meta`,
 * `description`).
 */
function mediaAttachmentsToAp(media: any): any[] {
  if (!Array.isArray(media)) return [];

  return media
    .filter((m) => m && typeof m.url === 'string' && /^https?:\/\//i.test(m.url))
    .map((m) => {
      const attachment: any = {
        type: 'Document',
        mediaType: getMediaType(undefined, m.mediaType || m.mimeType || m.mime_type, m.url),
        url: m.url,
        name: firstText(m.description, m.altText, m.alt),
      };
      const width = m.width ?? m.meta?.width ?? m.meta?.original?.width;
      const height = m.height ?? m.meta?.height ?? m.meta?.original?.height;
      if (width) attachment.width = width;
      if (height) attachment.height = height;
      if (m.blurhash) attachment.blurhash = m.blurhash;
      const focalPoint = storedFocalPoint(m);
      if (focalPoint) attachment.focalPoint = focalPoint;
      return attachment;
    });
}

/**
 * Helper: Get proper MIME type from fileType or URL
 */
function getMediaType(fileType?: string, mimeType?: string, url?: string): string {
  // If we already have a proper MIME type, use it
  if (mimeType && mimeType.includes('/')) {
    return mimeType;
  }
  
  // If fileType is already a MIME type, use it
  if (fileType && fileType.includes('/')) {
    return fileType;
  }
  
  // Try to infer from URL extension
  if (url) {
    const extension = url.split('.').pop()?.toLowerCase().split('?')[0];
    const extensionMap: Record<string, string> = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'svg': 'image/svg+xml',
      'mp4': 'video/mp4',
      'webm': 'video/webm',
      'mov': 'video/quicktime',
      'mp3': 'audio/mpeg',
      'ogg': 'audio/ogg',
      'wav': 'audio/wav',
      'pdf': 'application/pdf',
    };
    if (extension && extensionMap[extension]) {
      return extensionMap[extension];
    }
  }
  
  // Fallback based on simple fileType
  if (fileType) {
    const typeMap: Record<string, string> = {
      'image': 'image/jpeg', // Default image type
      'video': 'video/mp4',  // Default video type
      'audio': 'audio/mpeg', // Default audio type
    };
    if (typeMap[fileType]) {
      return typeMap[fileType];
    }
  }
  
  return 'application/octet-stream';
}

/**
 * Helper: Extract tags (mentions, hashtags) from JSONB content
 */
function extractTags(content: any, mentionActorUrls?: Map<string, string>): any[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const tags: any[] = [];

  content.forEach((item) => {
    if (item.type === 'mention') {
      // Debug logging
      logger.info('Processing mention tag: ' + JSON.stringify({
        username: item.username,
        domain: item.domain,
        isLocal: item.isLocal,
        userId: item.userId,
        fullItem: item
      }));
      
      // MessagePart format uses username and domain, not mention string
      const href = mentionHref(item, mentionActorUrls);
      const name = mentionLabel(item);
      
      tags.push({
        type: 'Mention',
        href: href,
        name: name,
      });
    }
    
    if (item.type === 'hashtag') {
      const href = `https://${config.INSTANCE_DOMAIN}/tags/${item.name}`;
      tags.push({
        type: 'Hashtag',
        href: href,
        name: `#${item.name}`,
      });
    }
    
    if (item.type === 'emoji' && item.emoji?.url) {
      // Custom emoji tag for Misskey/Mastodon compatibility. `emoji.id` is a
      // local row UUID, not an IRI; the image URL stands in as the tag id.
      const emojiId = typeof item.emoji.id === 'string' && /^https?:\/\//i.test(item.emoji.id)
        ? item.emoji.id
        : item.emoji.url;
      tags.push({
        type: 'Emoji',
        id: emojiId,
        name: `:${item.emoji.name}:`,
        icon: {
          type: 'Image',
          mediaType: imageMediaTypeFromUrl(item.emoji.url) || 'image/png',
          url: item.emoji.url
        }
      });
    }
  });

  return tags;
}

/**
 * Helper: Get 'to' addresses based on visibility
 */
function getToAddresses(visibility: string, authorUrl: string): string[] {
  switch (visibility) {
    case 'public':
      return ['https://www.w3.org/ns/activitystreams#Public'];
    case 'unlisted':
      return [`${authorUrl}/followers`];
    case 'followers':
      return [`${authorUrl}/followers`];
    case 'direct':
    case 'private':
      return [];
    default:
      return ['https://www.w3.org/ns/activitystreams#Public'];
  }
}

/**
 * Helper: Get 'cc' addresses based on visibility
 */
function getCcAddresses(visibility: string, authorUrl: string): string[] {
  switch (visibility) {
    case 'public':
      return [`${authorUrl}/followers`];
    case 'unlisted':
      // Public in cc is what distinguishes unlisted from followers-only.
      return ['https://www.w3.org/ns/activitystreams#Public'];
    case 'followers':
    case 'direct':
    case 'private':
      return [];
    default:
      return [];
  }
}

