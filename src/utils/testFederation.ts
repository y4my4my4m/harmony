/**
 * Test Federation Hybrid Delivery System
 * 
 * This script demonstrates the new hybrid federation delivery system
 * that attempts immediate delivery with cron fallback.
 */

import { federationService } from '@/services/FederationService';

export async function testHybridFederation() {
  console.log('🧪 Testing Hybrid Federation Delivery System');
  console.log('=' .repeat(50));

  try {
    // 1. Check current delivery queue status
    console.log('\n1. Current Federation Status:');
    const status = await federationService.getDeliveryStatus();
    console.log(`   📊 Queue Status:
   - Pending: ${status.pending}
   - Processing: ${status.processing}  
   - Delivered: ${status.delivered}
   - Failed: ${status.failed}
   - Total: ${status.total}`);

    if (status.oldestPending) {
      const age = Math.round((Date.now() - new Date(status.oldestPending).getTime()) / 1000);
      console.log(`   - Oldest pending: ${age}s ago`);
    }

    // 2. Trigger immediate delivery of pending items
    console.log('\n2. Triggering Immediate Delivery:');
    const deliveryResult = await federationService.triggerImmediateDelivery(10);
    console.log(`   📤 Delivery Results:
   - Processed: ${deliveryResult.processed}
   - Successful: ${deliveryResult.successful}
   - Failed: ${deliveryResult.failed}`);

    // 3. Manual delivery queue processing
    console.log('\n3. Manual Queue Processing:');
    const queueResult = await federationService.manualTriggerDelivery();
    console.log('   📋 Queue Processing Result:', queueResult);

    // 4. Check status after processing
    console.log('\n4. Status After Processing:');
    const newStatus = await federationService.getDeliveryStatus();
    console.log(`   📊 Updated Queue Status:
   - Pending: ${newStatus.pending}
   - Processing: ${newStatus.processing}
   - Delivered: ${newStatus.delivered}
   - Failed: ${newStatus.failed}
   - Total: ${newStatus.total}`);

    console.log('\n✅ Hybrid Federation Test Complete!');
    console.log('\n📋 How the new system works:');
    console.log('   1. Activities are queued for reliable delivery');
    console.log('   2. Immediate delivery is attempted for better UX');
    console.log('   3. Failed immediate deliveries fall back to cron processing');
    console.log('   4. Cron jobs run every 2 minutes as backup');
    console.log('   5. Exponential backoff ensures eventual delivery');

    return {
      before: status,
      delivery: deliveryResult,
      queue: queueResult,
      after: newStatus
    };

  } catch (error) {
    console.error('❌ Federation test failed:', error);
    return null;
  }
}

export async function testSpecificFederation() {
  console.log('\n🎯 Testing Specific Federation Actions');
  console.log('=' .repeat(50));

  try {
    // Note: These would need actual post IDs and user IDs to work
    console.log('\n📝 To test specific actions, use:');
    console.log('   • federationService.federateLike(postId, userId, true)');
    console.log('   • federationService.federateFollow(followerId, followingId, true)');
    console.log('   • federationService.federateAnnounce(postId, userId, true)');
    console.log('\n💡 Each action now attempts immediate delivery!');
    console.log('   Look for "🚀 Immediately delivering..." logs in console');

  } catch (error) {
    console.error('❌ Specific federation test failed:', error);
  }
}

// Export for easy browser console testing
if (typeof window !== 'undefined') {
  (window as any).testHybridFederation = testHybridFederation;
  (window as any).testSpecificFederation = testSpecificFederation;
  (window as any).federationService = federationService;
}
