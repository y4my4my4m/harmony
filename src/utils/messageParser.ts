import type { Emoji } from '@/types';
import { getEmoji } from '@/services/emojiService';

type MessagePart = 
  string | 
  { url: string } | 
  { mention: string; userId: string } | 
  { emoji: Emoji };

const urlRegex = /(\bhttps?:\/\/\S+)/gi;
const mentionRegex = /(@\w+@\w+\S+)/g;
const emojiRegex = /:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/g;

export async function parseMessageContent(
  message: string,
  usernameToUserIdMap: any,
): Promise<MessagePart[]> {
    const parts: MessagePart[] = [];
    let remainingText = message;
  
    // Process URLs and Mentions first
    let textMatch;
    const combinedRegex = new RegExp(`${urlRegex.source}|${mentionRegex.source}`, 'gi');
    while ((textMatch = combinedRegex.exec(message)) !== null) {
      const matchIndex = textMatch.index;
      if (matchIndex > 0) {
        parts.push(...await parseRemainingTextForEmoji(remainingText.substring(0, matchIndex)));
      }
      if (textMatch[0].startsWith('http')) {
        parts.push({ url: textMatch[0] });
      } else {
        // console.log(textMatch[0]);
        const userId = usernameToUserIdMap[textMatch[0].toLowerCase()];
        parts.push(userId ? { mention: textMatch[0], userId } : textMatch[0]);
      }
      remainingText = remainingText.substring(matchIndex + textMatch[0].length);
    }
  
    // Process remaining text for emojis
    parts.push(...await parseRemainingTextForEmoji(remainingText));
  
    return parts;
  };
  
  const parseRemainingTextForEmoji = async (text: string): Promise<MessagePart[]> => {
    const remainingParts: MessagePart[] = [];
    let lastIndex = 0;
  
    let emojiMatch;
    while ((emojiMatch = emojiRegex.exec(text)) !== null) {
      const emojiIndex = emojiMatch.index;
      if (emojiIndex > lastIndex) {
        remainingParts.push(text.substring(lastIndex, emojiIndex));
      }
      const emojiId = emojiMatch[1];
      const emojiData = emojiId ? await getEmoji(emojiId) : undefined;
      remainingParts.push(emojiData ? { emoji: emojiData } : emojiMatch[0]);
      lastIndex = emojiIndex + emojiMatch[0].length;
    }
  
    if (lastIndex < text.length) {
      remainingParts.push(text.substring(lastIndex));
    }
  
    return remainingParts;
  };
