/**
 * The ActivityStreams form of a channel message: one builder for live delivery
 * (listeners/ChannelMessageHandler.ts) and for the pages other instances read
 * (GroupService.ts: a channel's message collection, the server outbox).
 *
 * `audience` is the instance the document is for: file parts and attachments carry
 * capability URLs naming it (utils/privateMedia.ts federateContentParts,
 * fileAttachmentsToAp); PUBLIC_AUDIENCE for a reader of public channels only.
 * Stored content keeps storage paths; absolute URLs exist only in what is sent.
 */

import config from '../config/index.js';
import { convertContentToHTML, extractActivityPubTags, extractAttachments } from '../utils/contentUtils.js';
import { harmonyVoiceMessageExtension } from '../utils/voiceMessageFederation.js';
import { federateContentParts, fileAttachmentsToAp } from '../utils/privateMedia.js';
import { withoutPollParts } from '../utils/polls.js';
import { HARMONY_NS } from './harmonyContext.js';

export function channelMessageActivity(
  message: any,
  server: { id: string; name?: string | null },
  channelId: string,
  channelName: string | null | undefined,
  activityType: 'Create' | 'Update',
  audience: string,
): any {
  const hostDomain = config.INSTANCE_DOMAIN;
  const serverUrl = `https://${hostDomain}/servers/${server.id}`;
  const channelUrl = `${serverUrl}/channels/${channelId}`;
  const messageUrl = `https://${hostDomain}/messages/${message.id}`;
  const activityId = `${serverUrl}/activities/${message.id}`;

  if (!message.author?.username) {
    throw new Error(`Cannot create activity: message ${message.id} has no valid author`);
  }
  const authorApId = message.author.federated_id || 
    `https://${hostDomain}/users/${message.author.username}`;

  const contentHtml = convertContentToHTML(message.content);
  const tags = extractActivityPubTags(message.content);
  const attachments = [
    ...extractAttachments(message.content),
    ...fileAttachmentsToAp(message.content, audience),
  ];

  // Emoji URLs become absolute; attachments carry the audience's capability URLs.
  const federatedContent = Array.isArray(message.content)
    ? federateContentParts(withoutPollParts(message.content), audience).map((item: any) => {
        if (item.type === 'emoji' && item.emoji?.url) {
          let emojiUrl = item.emoji.url;
          if (!emojiUrl.startsWith('http://') && !emojiUrl.startsWith('https://')) {
            const baseUrl = config.PUBLIC_SUPABASE_URL || config.SUPABASE_URL;
            emojiUrl = emojiUrl.startsWith('/') ? `${baseUrl}${emojiUrl}` : `${baseUrl}/${emojiUrl}`;
          }
          return {
            ...item,
            emoji: {
              ...item.emoji,
              url: emojiUrl
            }
          };
        }
        return item;
      })
    : message.content;

  let inReplyTo: string | undefined;
  if (message.reply_to) {
    inReplyTo = `https://${hostDomain}/messages/${message.reply_to}`;
  }

  // Thread context - if this message belongs to a thread, include the thread AP ID
  let threadApId: string | undefined;
  let parentMessageApId: string | undefined;
  if (message.thread_id) {
    threadApId = `https://${hostDomain}/threads/${message.thread_id}`;
    // Include thread's parent message so remote instances can create correct stub threads
    if (message.thread_parent_message_id) {
      parentMessageApId = `https://${hostDomain}/messages/${message.thread_parent_message_id}`;
    }
  }

  const voiceHarmony = harmonyVoiceMessageExtension(message.metadata);

  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        harmony: HARMONY_NS,
        'rawContent': 'harmony:rawContent',
        'channelName': 'harmony:channelName',
        'channelType': 'harmony:channelType',
        'serverId': 'harmony:serverId',
        'serverName': 'harmony:serverName',
        'encrypted': 'harmony:encrypted',
        'threadId': 'harmony:threadId',
        'parentMessageId': 'harmony:parentMessageId',
        'voiceMessage': 'harmony:voiceMessage',
      },
    ],
    id: activityType === 'Update' ? `${activityId}/updates/${Date.now()}` : activityId,
    type: activityType,
    actor: authorApId,
    published: message.created_at,
    updated: activityType === 'Update' ? message.updated_at : undefined,

    object: {
      type: 'Note',
      id: messageUrl,
      attributedTo: authorApId,
      content: contentHtml,
      'harmony:rawContent': federatedContent, // Send transformed content with absolute emoji URLs
      
      // Channel context
      context: channelUrl,
      'harmony:channelName': channelName,
      'harmony:channelType': 'text',
      'harmony:serverId': server.id,
      'harmony:serverName': server.name,

      // Timestamps
      published: message.created_at,
      updated: message.updated_at !== message.created_at ? message.updated_at : undefined,

      // Threading
      inReplyTo,
      'harmony:threadId': threadApId,
      'harmony:parentMessageId': parentMessageApId,

      // Tags and attachments
      tag: tags.length > 0 ? tags : undefined,
      attachment: attachments.length > 0 ? attachments : undefined,

      // E2EE indicator - remote instances can't decrypt but should show the lock glyph
      'harmony:encrypted': message.encrypted === true ? true : undefined,

      // Voice message UI (waveform player) - metadata is not inside harmony:rawContent
      ...(voiceHarmony ? { 'harmony:voiceMessage': voiceHarmony } : {}),
    },

    // Addressing - to server members
    to: [`${serverUrl}/members`],
    cc: [],
  };
}
