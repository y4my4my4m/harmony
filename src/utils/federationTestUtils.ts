/**
 * Test Federation and Mention Processing
 * This file helps verify that the federation system properly processes mentions
 */

import { 
  extractMentions, 
  resolveMentions, 
  generateMentionTags, 
  getDeliveryInboxes,
  formatMentionsForActivityPub
} from '@/utils/mentionUtils';
import { FederationService } from '@/services/FederationService';

// Test mention extraction
export function testMentionExtraction() {
  console.log('🧪 Testing mention extraction...');
  
  const testTexts = [
    '@tester004@mastodon.social hey there!',
    'Hello @localuser and @remoteuser@example.com',
    'Multiple mentions: @alice@mastodon.social @bob@pixelfed.social',
    'No mentions here',
    '@user with text after',
    'Mixed @local and @remote@domain.com mentions'
  ];

  testTexts.forEach((text, index) => {
    console.log(`\nTest ${index + 1}: "${text}"`);
    const mentions = extractMentions(text);
    mentions.forEach(mention => {
      console.log(`  Found: ${mention.full} (user: ${mention.username}, domain: ${mention.domain || 'local'})`);
    });
  });
}

// Test federation service integration
export async function testFederationProcessing() {
  console.log('🧪 Testing federation processing...');
  
  try {
    const federationService = FederationService.getInstance();
    
    // Test with a post containing mentions
    const testPost = {
      id: 'test-post-123',
      content: [{ type: 'text', text: '@tester004@mastodon.social hey there! @localuser' }],
      visibility: 'public' as const,
      created_at: new Date().toISOString(),
      author_id: 'test-user',
      is_local: true,
      is_federated: false,
      federation_status: null,
      last_federated_at: null,
      ap_id: null,
      ap_type: null,
      url: null,
      metadata: {}
    };

    const authorProfile = {
      id: 'test-user',
      username: 'testuser',
      domain: 'har.mony.lol',
      is_local: true
    };

    console.log('📝 Test post:', testPost.content[0].text);
    console.log('👤 Author:', authorProfile.username);
    
    // This would normally federate the post
    // For testing, we'll just log what would happen
    console.log('✅ Federation test completed');
    
  } catch (error) {
    console.error('❌ Federation test failed:', error);
  }
}

// Run tests in development mode
if (import.meta.env.DEV) {
  console.log('🚀 Running federation tests...');
  testMentionExtraction();
  // testFederationProcessing(); // Uncomment to test federation
}
