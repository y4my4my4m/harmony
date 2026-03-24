import type { MessagePart, MentionContent } from '@/types';
import { userDataService } from '@/services/userDataService';

/**
 * Utility functions for migrating and validating mention data structures
 */

/**
 * Migrates legacy mention format to new structured format
 * @param content MessagePart array that might contain legacy mentions
 * @returns Updated MessagePart array with structured mentions
 */
export function migrateLegacyMentions(content: MessagePart[]): MessagePart[] {
  return content.map(part => {
    if (part.type === 'mention') {
      // Check if it's already in new format
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

/**
 * Validates that a mention object has all required fields
 * @param mention MentionContent object to validate
 * @returns boolean indicating if the mention is valid
 */
export function validateMentionStructure(mention: MentionContent): boolean {
  return !!(
    mention.type === 'mention' &&
    mention.userId &&
    mention.username &&
    mention.domain &&
    typeof mention.isLocal === 'boolean'
  );
}

/**
 * Creates a properly structured mention object from user data
 * @param userId User ID
 * @param userProfile User profile data (optional, will be fetched if not provided)
 * @returns MentionContent object or null if user not found
 */
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

/**
 * Formats mention for display based on local/remote status
 * @param mention MentionContent object
 * @returns Display string (@username or @username@domain)
 */
export function formatMentionForDisplay(mention: MentionContent): string {
  if (mention.isLocal) {
    return `@${mention.username}`;
  } else {
    return `@${mention.username}@${mention.domain}`;
  }
}

/**
 * Converts display format mention (@username or @username@domain) to structured mention
 * @param displayMention Display format mention string
 * @returns MentionContent object or null if user not found
 */
export function parseDisplayMention(displayMention: string): MentionContent | null {
  // Remove @ prefix if present
  const cleanMention = displayMention.startsWith('@') ? displayMention.slice(1) : displayMention;
  
  // Split by @ to get username and domain
  const parts = cleanMention.split('@');
  const username = parts[0];
  const domain = parts[1]; // undefined if local user
  
  if (!username) {
    return null;
  }
  
  // Look up user by username and domain
  const userId = userDataService.findUserIdByUsername(username, domain);
  if (!userId) {
    return null;
  }
  
  return createMentionFromUser(userId);
}
