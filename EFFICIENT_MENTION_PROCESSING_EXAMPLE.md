/**
 * Example usage of the efficient mention processing system
 * 
 * This demonstrates how to use the new batch approach for maximum performance
 */

import { parseContentToMessageParts, resolveMentionsUserData } from '@/utils/unifiedContentProcessing';

// Example 1: Basic usage with automatic batch resolution
async function processPostContent(content: string) {
  console.log('Processing content:', content);
  
  // Step 1: Efficiently resolve ALL mentions in one batch
  const userDataMap = await resolveMentionsUserData(content);
  console.log('Resolved user data:', userDataMap);
  
  // Step 2: Parse content with resolved data (no database queries)
  const messageParts = await parseContentToMessageParts(content, userDataMap);
  console.log('Message parts:', messageParts);
  
  return messageParts;
}

// Example 2: Performance comparison
async function performanceExample() {
  const content = "Hey @alice, check this out @bob@mastodon.social! What do you think @charlie?";
  
  console.log('=== EFFICIENT APPROACH ===');
  console.time('Batch processing');
  
  // ONE batch lookup for all 3 mentions
  const userDataMap = await resolveMentionsUserData(content);
  const messageParts = await parseContentToMessageParts(content, userDataMap);
  
  console.timeEnd('Batch processing');
  console.log('Database queries made: 1-2 total');
  
  console.log('=== OLD INEFFICIENT APPROACH (DON'T DO THIS) ===');
  console.log('Would make 3 separate database queries (one per mention)');
  console.log('Performance scales poorly with mention count');
  
  return messageParts;
}

// Example 3: Usage in different contexts
export const examples = {
  // Chat messages
  async processChatMessage(content: string) {
    const userDataMap = await resolveMentionsUserData(content);
    return parseContentToMessageParts(content, userDataMap);
  },
  
  // ActivityPub posts
  async processActivityPubPost(content: string) {
    const userDataMap = await resolveMentionsUserData(content);
    return parseContentToMessageParts(content, userDataMap);
  },
  
  // DM messages
  async processDMContent(content: string) {
    const userDataMap = await resolveMentionsUserData(content);
    return parseContentToMessageParts(content, userDataMap);
  },
  
  // Fallback: If you can't use batch resolution
  async processWithFallback(content: string) {
    // Still efficient - falls back to domain-based logic
    return parseContentToMessageParts(content); // No userDataMap provided
  }
};

// Example 4: What the is_local column gives us
async function demonstrateIsLocalBenefit() {
  const content = "@alice @bob@mastodon.social";
  const userDataMap = await resolveMentionsUserData(content);
  
  console.log('User data from database:');
  console.log(userDataMap);
  // Example output:
  // {
  //   "alice": { userId: "123", isLocal: true, displayName: "Alice Smith" },
  //   "bob@mastodon.social": { userId: "456", isLocal: false, displayName: "Bob Jones" }
  // }
  
  const messageParts = await parseContentToMessageParts(content, userDataMap);
  
  console.log('Mention parts with accurate is_local:');
  messageParts
    .filter(part => part.type === 'mention')
    .forEach(part => {
      console.log(`@${part.username}: isLocal = ${part.isLocal} (from database)`);
    });
}
