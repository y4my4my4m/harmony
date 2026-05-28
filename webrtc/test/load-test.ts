/**
 * LiveKit Load Testing Script
 * 
 * Tests the LiveKit server with simulated participants.
 * Useful for stress testing before production deployment.
 * 
 * Usage:
 *   npx tsx test/load-test.ts
 * 
 * Requirements:
 *   - LiveKit server running (docker-compose up)
 *   - Node.js 18+
 */

import { Room, RoomEvent, createLocalAudioTrack } from 'livekit-client';
import { AccessToken } from 'livekit-server-sdk';

// =============================================================================
// CONFIGURATION
// =============================================================================

const config = {
  // LiveKit server URL
  wsUrl: process.env.LIVEKIT_URL || 'ws://localhost:7880',
  
  // API credentials
  apiKey: process.env.LIVEKIT_API_KEY || 'devkey',
  apiSecret: process.env.LIVEKIT_API_SECRET || 'secret',
  
  // Test parameters
  roomName: process.env.ROOM_NAME || 'load-test-room',
  numPublishers: parseInt(process.env.NUM_PUBLISHERS || '5'),
  numSubscribers: parseInt(process.env.NUM_SUBSCRIBERS || '20'),
  testDurationMs: parseInt(process.env.TEST_DURATION_MS || '60000'),
  
  // Metrics
  metricsIntervalMs: 5000,
};

// =============================================================================
// TYPES
// =============================================================================

interface Metrics {
  connectedParticipants: number;
  publishingParticipants: number;
  subscribingParticipants: number;
  connectionErrors: number;
  publishErrors: number;
  avgConnectTimeMs: number;
  connectTimes: number[];
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Generate a room token
 */
async function generateToken(identity: string, canPublish: boolean): Promise<string> {
  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity,
    ttl: '1h',
  });
  
  at.addGrant({
    roomJoin: true,
    room: config.roomName,
    canPublish,
    canSubscribe: true,
  });
  
  return at.toJwt();
}

/**
 * Create a simulated participant
 */
async function createParticipant(
  identity: string,
  canPublish: boolean,
  metrics: Metrics
): Promise<Room> {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
  });
  
  const startTime = Date.now();
  
  return new Promise<Room>((resolve, reject) => {
    const connectAndPublish = async () => {
      try {
        const token = await generateToken(identity, canPublish);
        await room.connect(config.wsUrl, token);
      } catch (error) {
        metrics.connectionErrors++;
        console.error(`${identity} connection failed:`, error);
        reject(error);
      }
    };

    room.on(RoomEvent.Connected, async () => {
      const connectTime = Date.now() - startTime;
      metrics.connectTimes.push(connectTime);
      metrics.connectedParticipants++;
      
      console.log(`✅ ${identity} connected in ${connectTime}ms`);
      
      if (canPublish) {
        try {
          // Create a silent audio track (simulated)
          const audioTrack = await createLocalAudioTrack({
            noiseSuppression: true,
            echoCancellation: true,
          });
          
          await room.localParticipant.publishTrack(audioTrack, {
            dtx: true,
          });
          
          metrics.publishingParticipants++;
          console.log(`📤 ${identity} publishing audio`);
        } catch (error) {
          metrics.publishErrors++;
          console.error(`❌ ${identity} failed to publish:`, error);
        }
      } else {
        metrics.subscribingParticipants++;
      }
      
      resolve(room);
    });
    
    room.on(RoomEvent.Disconnected, () => {
      metrics.connectedParticipants--;
      console.log(`👋 ${identity} disconnected`);
    });
    
    room.on(RoomEvent.MediaDevicesError, (error) => {
      console.warn(`${identity} media device error:`, error);
    });

    void connectAndPublish();
  });
}

/**
 * Print current metrics
 */
function printMetrics(metrics: Metrics): void {
  const avgConnectTime = metrics.connectTimes.length > 0
    ? metrics.connectTimes.reduce((a, b) => a + b, 0) / metrics.connectTimes.length
    : 0;
  
  console.log('\n📊 Current Metrics:');
  console.log(`   Connected: ${metrics.connectedParticipants}`);
  console.log(`   Publishers: ${metrics.publishingParticipants}`);
  console.log(`   Subscribers: ${metrics.subscribingParticipants}`);
  console.log(`   Connection Errors: ${metrics.connectionErrors}`);
  console.log(`   Publish Errors: ${metrics.publishErrors}`);
  console.log(`   Avg Connect Time: ${avgConnectTime.toFixed(0)}ms`);
  console.log('');
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log('🚀 LiveKit Load Test');
  console.log('====================');
  console.log(`Server: ${config.wsUrl}`);
  console.log(`Room: ${config.roomName}`);
  console.log(`Publishers: ${config.numPublishers}`);
  console.log(`Subscribers: ${config.numSubscribers}`);
  console.log(`Duration: ${config.testDurationMs / 1000}s`);
  console.log('');
  
  const metrics: Metrics = {
    connectedParticipants: 0,
    publishingParticipants: 0,
    subscribingParticipants: 0,
    connectionErrors: 0,
    publishErrors: 0,
    avgConnectTimeMs: 0,
    connectTimes: [],
  };
  
  const rooms: Room[] = [];
  
  // Start metrics reporting
  const metricsInterval = setInterval(() => {
    printMetrics(metrics);
  }, config.metricsIntervalMs);
  
  try {
    // Create publishers
    console.log('📤 Creating publishers...');
    for (let i = 0; i < config.numPublishers; i++) {
      try {
        const room = await createParticipant(`publisher-${i}`, true, metrics);
        rooms.push(room);
        
        // Stagger connections slightly
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Failed to create publisher ${i}`);
      }
    }
    
    // Create subscribers
    console.log('📥 Creating subscribers...');
    for (let i = 0; i < config.numSubscribers; i++) {
      try {
        const room = await createParticipant(`subscriber-${i}`, false, metrics);
        rooms.push(room);
        
        // Stagger connections
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error) {
        console.error(`Failed to create subscriber ${i}`);
      }
    }
    
    console.log('\n✅ All participants connected. Running test...\n');
    
    // Wait for test duration
    await new Promise(resolve => setTimeout(resolve, config.testDurationMs));
    
  } finally {
    clearInterval(metricsInterval);
    
    // Disconnect all participants
    console.log('\n👋 Disconnecting participants...');
    for (const room of rooms) {
      await room.disconnect();
    }
    
    // Final metrics
    console.log('\n📊 Final Results:');
    console.log('=================');
    printMetrics(metrics);
    
    const successRate = ((config.numPublishers + config.numSubscribers - metrics.connectionErrors) / 
      (config.numPublishers + config.numSubscribers)) * 100;
    console.log(`Success Rate: ${successRate.toFixed(1)}%`);
    
    if (metrics.connectionErrors > 0 || metrics.publishErrors > 0) {
      process.exit(1);
    }
  }
}

main().catch(console.error);

