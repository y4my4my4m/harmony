import type { MessagePart } from '@/types';
import { getEmoji } from '@/services/emojiService';
import { createMentionFromUser } from '@/utils/mentionMigration';

const urlRegex = /(\bhttps?:\/\/\S+)/gi;
// Updated mention regex to match both @username and @uuid@domain
// UUIDs contain hyphens, so we need to include them in the character class
const mentionRegex = /@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?/g;
const emojiRegex = /:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/g;

export async function parseMessageContent(
  message: string,
  usernameToUserIdMap: any,
): Promise<MessagePart[]> {
    const parts: MessagePart[] = [];
    let lastIndex = 0;
  
    // Reset regex lastIndex to ensure fresh search
    mentionRegex.lastIndex = 0;
    urlRegex.lastIndex = 0;
    
    // Find all mentions and URLs
    const matches: Array<{match: RegExpExecArray, type: 'mention' | 'url'}> = [];
    
    // Find all mentions
    let mentionMatch;
    while ((mentionMatch = mentionRegex.exec(message)) !== null) {
      matches.push({match: mentionMatch, type: 'mention'});
    }
    
    // Find all URLs
    let urlMatch;
    while ((urlMatch = urlRegex.exec(message)) !== null) {
      matches.push({match: urlMatch, type: 'url'});
    }
    
    // Sort by position
    matches.sort((a, b) => a.match.index - b.match.index);
    
    // Process matches in order
    for (const {match, type} of matches) {
      const matchIndex = match.index;
      
      // Add text before this match
      if (matchIndex > lastIndex) {
        const textBefore = message.substring(lastIndex, matchIndex);
        parts.push(...await parseRemainingTextForEmoji(textBefore));
      }
      
      if (type === 'url') {
        parts.push({ type: 'url', url: match[0], preview: true });
      } else {
        // Handle mention
        const fullMatch = match[0]; // Full mention like @uuid@domain
        
        // Check if this is already in @uuid@domain format
        if (fullMatch.includes('@') && fullMatch.split('@').length === 3) {
          // Already in @uuid@domain format, extract UUID and create proper mention
          const uuidPart = match[1]; // First capture group
          const mentionContent = createMentionFromUser(uuidPart);
          
          if (mentionContent) {
            parts.push(mentionContent);
          } else {
            // If user not found, push as plain text
            parts.push({ type: 'text', text: fullMatch });
          }
        } else {
          // Legacy @username format, look up user ID
          const username = match[1]; // First capture group: username
          const domain = match[2]; // Second capture group: domain (optional)
          
          // Create the mention key for lookup
          const mentionKey = domain ? `${username}@${domain}`.toLowerCase() : username.toLowerCase();
          
          // Look up user ID using the mention key
          const userId = usernameToUserIdMap[mentionKey];
          
          if (userId) {
            // Create proper MentionContent object
            const mentionContent = createMentionFromUser(userId);
            
            if (mentionContent) {
              parts.push(mentionContent);
            } else {
              // If user profile not found, push as plain text
              parts.push({ type: 'text', text: fullMatch });
            }
          } else {
            // If no user found, just push the text as-is
            parts.push({ type: 'text', text: fullMatch });
          }
        }
      }
      
      lastIndex = matchIndex + match[0].length;
    }
  
    // Process remaining text for emojis
    if (lastIndex < message.length) {
      const remainingText = message.substring(lastIndex);
      parts.push(...await parseRemainingTextForEmoji(remainingText));
    }
  
    return parts;
  };
  
  const parseRemainingTextForEmoji = async (text: string): Promise<MessagePart[]> => {
    const remainingParts: MessagePart[] = [];
    let lastIndex = 0;
  
    let emojiMatch;
    while ((emojiMatch = emojiRegex.exec(text)) !== null) {
      const emojiIndex = emojiMatch.index;
      if (emojiIndex > lastIndex) {
        remainingParts.push({ type: 'text', text: text.substring(lastIndex, emojiIndex) });
      }
      const emojiId = emojiMatch[1];
      const emojiData = emojiId ? await getEmoji(emojiId) : undefined;
      if (emojiData) {
        remainingParts.push({ type: 'emoji', emoji: emojiData });
      } else {
        remainingParts.push({ type: 'text', text: emojiMatch[0] });
      }
      lastIndex = emojiIndex + emojiMatch[0].length;
    }
  
    if (lastIndex < text.length) {
      remainingParts.push({ type: 'text', text: text.substring(lastIndex) });
    }
  
    return remainingParts;
  };
