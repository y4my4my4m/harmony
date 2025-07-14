/**
 * Federation Testing Utilities
 * Professional testing suite for ActivityPub federation functionality
 */

import { supabase } from '@/supabase';
import { federationService } from '@/services/FederationService';

export interface FederationTestResult {
  success: boolean;
  message: string;
  details?: any;
  timestamp: string;
}

export class FederationTester {
  /**
   * Test the complete federation pipeline for favorites
   */
  static async testFavoriteInteractionFederation(postId: string): Promise<FederationTestResult> {
    try {
      console.log('🧪 Testing favorite interaction federation...');
      
      // Get current user
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        return {
          success: false,
          message: 'User not authenticated',
          timestamp: new Date().toISOString()
        };
      }

      // Check if post exists and is federated
      const { data: post } = await supabase
        .from('posts')
        .select('id, is_federated, author:profiles(username, domain, is_local)')
        .eq('id', postId)
        .single();

      if (!post) {
        return {
          success: false,
          message: 'Post not found',
          timestamp: new Date().toISOString()
        };
      }

      // Test federation for remote post
      if (!post.author.is_local) {
        // Queue a like activity
        const activityId = await federationService.federateLike(postId, user.id, true);
        
        if (!activityId) {
          return {
            success: false,
            message: 'Failed to queue Like activity',
            timestamp: new Date().toISOString()
          };
        }

        // Check if activity was queued
        const { data: queuedActivity } = await supabase
          .from('ap_activities')
          .select('*')
          .eq('id', activityId)
          .single();

        // Check if delivery was queued
        const { data: queuedDeliveries } = await supabase
          .from('federation_delivery_queue')
          .select('*')
          .eq('activity_id', activityId);

        return {
          success: true,
          message: 'Federation test completed successfully',
          details: {
            activityId,
            activityQueued: !!queuedActivity,
            deliveriesQueued: queuedDeliveries?.length || 0,
            targetDomains: queuedDeliveries?.map(d => d.target_domain) || []
          },
          timestamp: new Date().toISOString()
        };
      } else {
        return {
          success: true,
          message: 'Local post - no federation needed',
          details: { isLocal: true },
          timestamp: new Date().toISOString()
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `Federation test failed: ${error.message}`,
        details: { error: error.message },
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Test the delivery worker manually using database function
   */
  static async testDeliveryWorker(): Promise<FederationTestResult> {
    try {
      console.log('🧪 Testing delivery worker...');
      
      const result = await federationService.manualTriggerDelivery();
      
      return {
        success: true,
        message: 'Delivery worker processed successfully',
        details: result,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Delivery worker test failed: ${errorMessage}`,
        details: { error: errorMessage },
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Check federation queue status
   */
  static async checkFederationQueueStatus(): Promise<FederationTestResult> {
    try {
      console.log('🧪 Checking federation queue status...');
      
      // Get queue statistics
      const { data: queueStats } = await supabase
        .rpc('get_federation_queue_stats');

      // Get recent activities
      const { data: recentActivities } = await supabase
        .from('ap_activities')
        .select('id, ap_type, status, created_at')
        .order('created_at', { ascending: false })
        .limit(10);

      // Get recent deliveries
      const { data: recentDeliveries } = await supabase
        .from('federation_delivery_queue')
        .select('id, target_domain, status, attempt_count, created_at')
        .order('created_at', { ascending: false })
        .limit(10);

      return {
        success: true,
        message: 'Federation queue status retrieved',
        details: {
          queueStats,
          recentActivities: recentActivities || [],
          recentDeliveries: recentDeliveries || []
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Queue status check failed: ${errorMessage}`,
        details: { error: errorMessage },
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Run comprehensive federation test suite
   */
  static async runFullFederationTest(): Promise<FederationTestResult[]> {
    console.log('🧪 Running comprehensive federation test suite...');
    
    const results: FederationTestResult[] = [];
    
    // Test 1: Check queue status
    results.push(await this.checkFederationQueueStatus());
    
    // Test 2: Test delivery worker
    results.push(await this.testDeliveryWorker());
    
    // Test 3: Find a federated post to test with
    const { data: federatedPost } = await supabase
      .from('posts')
      .select('id')
      .eq('is_federated', true)
      .limit(1)
      .single();
    
    if (federatedPost) {
      results.push(await this.testFavoriteInteractionFederation(federatedPost.id));
    } else {
      results.push({
        success: false,
        message: 'No federated posts found for testing',
        timestamp: new Date().toISOString()
      });
    }
    
    console.log('🧪 Federation test suite complete:', results);
    return results;
  }
}

// Export for use in development/debugging
export const testFederation = FederationTester.runFullFederationTest;
export const testFavorite = FederationTester.testFavoriteInteractionFederation;
export const testDelivery = FederationTester.testDeliveryWorker;
export const checkQueue = FederationTester.checkFederationQueueStatus;
