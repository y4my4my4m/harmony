import type { MessagePart, MentionContent } from '@/types';
import { userDataService } from '@/services/userDataService';

export function migrateLegacyMentions(content: MessagePart[]): MessagePart[] {
  return content.map(part => {
    if (part.type === 'mention') {
      if ('username' in part && 'domain' in part && 'isLocal' in part) {
        return part; // Already migrated
      }

      // Legacy format has 'mention' property with @uuid@domain format
      const legacyPart = part as any;
      if (legacyPart.mention && legacyPart.userId) {
        const userId = legacyPart.userId;
        const userProfile = userDataService.getUserProfile(userId);
        
        if (userProfile) {
          const newMention: MentionContent = {
            type: 'mention',
            userId,
            username: userProfile.username,
            domain: userProfile.domain || import.meta.env.VITE_DOMAIN as string,
            isLocal: userProfile.isLocal || false
          };
          return newMention;
        }
      }
    }
    return part;
  });
}

export function validateMentionStructure(mention: MentionContent): boolean {
  return !!(
    mention.type === 'mention' &&
    mention.userId &&
    mention.username &&
    mention.domain &&
    typeof mention.isLocal === 'boolean'
  );
}

export function createMentionFromUser(userId: string, userProfile?: any): MentionContent | null {
  const profile = userProfile || userDataService.getUserProfile(userId);
  
  if (!profile) {
    return null;
  }

  return {
    type: 'mention',
    userId,
    username: profile.username,
    domain: profile.domain || import.meta.env.VITE_DOMAIN as string,
    isLocal: profile.isLocal || false
  };
}

export function formatMentionForDisplay(mention: MentionContent): string {
  if (mention.isLocal) {
    return `@${mention.username}`;
  } else {
    return `@${mention.username}@${mention.domain}`;
  }
}

export function parseDisplayMention(displayMention: string): MentionContent | null {
  const cleanMention = displayMention.startsWith('@') ? displayMention.slice(1) : displayMention;

  const parts = cleanMention.split('@');
  const username = parts[0];
  const domain = parts[1]; // undefined if local user
  
  if (!username) {
    return null;
  }
  
  const userId = userDataService.findUserIdByUsername(username, domain);
  if (!userId) {
    return null;
  }
  
  return createMentionFromUser(userId);
}
