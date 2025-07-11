# Comprehensive ActivityPub Federation Implementation Plan

## 🎯 Overview

This document outlines the complete implementation plan for transforming Harmony into the world's first federated Discord-like system with comprehensive ActivityPub support. We're building beyond standard social media federation to include revolutionary chat and voice federation.

## 📋 Current Status Analysis

### ✅ What We Have
- **Basic Posts**: Create, read, display with JSONB content
- **Social Interactions**: Favorites, reblogs, bookmarks (local only)
- **Follows**: Local following system with status tracking
- **Real-time Subscriptions**: Live updates for posts and interactions
- **UI Components**: Complete social media interface
- **Database Schema**: Solid foundation with posts, profiles, servers, channels

### ❌ What We're Missing
- **Federation Activities**: Update, Delete, Accept, Reject, Undo
- **Voice Chat Federation**: VoiceJoin, VoiceLeave, VoiceUpdate events
- **Server Federation**: Join/Leave remote servers
- **ActivityPub Endpoints**: WebFinger, Actor, NodeInfo, Inbox
- **Delivery Queue**: Background federation processing
- **Actor/Object Caching**: Remote content caching
- **Reaction System**: Emoji reactions with federation
- **Edit History**: Post editing with federation
- **Voice State Management**: Federated voice channel states

## 🗂️ Implementation Phases

### Phase 1: Core Federation Infrastructure (Priority 1)

#### 1.1 Database Schema Enhancement
- **Status**: ✅ Complete (migration created)
- **Files**: `tmp_migrations/add_complete_activitypub_federation.sql`
- **What it adds**:
  - `ap_activities` table with all activity types
  - `federation_delivery_queue` for background processing
  - `federated_instances` for instance health tracking
  - `voice_federation_events` for voice chat federation
  - `server_federation_events` for server federation
  - Actor and object caching tables
  - Comprehensive indexes and RLS policies

#### 1.2 Enhanced ActivityPub Service
- **Status**: ✅ Complete (service extended)
- **Files**: `src/services/activityPubService.ts`
- **What it adds**:
  - `updatePost()` - Edit posts with federation
  - `deletePost()` - Delete posts with tombstone
  - `acceptFollowRequest()` / `rejectFollowRequest()` - Follow management
  - `undoActivity()` - Undo any previous activity
  - `joinVoiceChannel()` / `leaveVoiceChannel()` - Voice federation
  - `updateVoiceState()` - Voice state changes
  - `joinFederatedServer()` / `leaveFederatedServer()` - Server federation

#### 1.3 Type System Enhancement
- **Status**: ✅ Complete (types added)
- **Files**: `src/types.ts`
- **What it adds**:
  - Complete `ActivityPubActivityType` enum
  - `ActivityPubObjectType` enum
  - Enhanced federation interfaces
  - Voice and server federation types

### Phase 2: Supabase Edge Functions (Priority 2)

#### 2.1 Core Federation Endpoints
- **Status**: ⏳ Ready to deploy
- **Files**: 
  - `supabase/functions/webfinger/index.ts` - User discovery
  - `supabase/functions/actor/index.ts` - User profiles
  - `supabase/functions/nodeinfo/index.ts` - Instance metadata
  - `supabase/functions/inbox/index.ts` - Receiving activities

#### 2.2 Deployment Steps
```bash
# 1. Run the database migration
psql -h your-db-host -U postgres -d postgres -f tmp_migrations/add_complete_activitypub_federation.sql

# 2. Deploy Edge Functions
supabase functions deploy webfinger
supabase functions deploy actor  
supabase functions deploy nodeinfo
supabase functions deploy inbox

# 3. Set up environment variables
supabase secrets set INSTANCE_DOMAIN=your-domain.com
supabase secrets set INSTANCE_NAME="Your Instance Name"
```

### Phase 3: Advanced Federation Features (Priority 3)

#### 3.1 Reaction System
- **Status**: 🔄 Need to implement
- **Components**:
  - Emoji reaction picker component
  - Reaction federation (Like activities with custom emoji)
  - Reaction aggregation and display
  - Custom emoji federation

#### 3.2 Post Editing System
- **Status**: 🔄 Need to implement
- **Components**:
  - Edit post UI component
  - Edit history tracking
  - Update activity federation
  - Edit conflict resolution

#### 3.3 Voice Chat Federation
- **Status**: 🔄 Need to implement
- **Components**:
  - Voice state federation
  - Cross-instance voice channels
  - WebRTC signaling federation
  - Voice permission management

### Phase 4: Revolutionary Chat Federation (Priority 4)

#### 4.1 Server Discovery & Joining
- **Status**: 🔄 Need to implement
- **Components**:
  - Federated server browser
  - Join/leave activities
  - Permission synchronization
  - Server invitation system

#### 4.2 Cross-Instance Messaging
- **Status**: 🔄 Need to implement
- **Components**:
  - Federated message delivery
  - Message synchronization
  - Conflict resolution
  - Message history federation

## 🚀 Quick Start Implementation

### Step 1: Deploy Database Migration
```bash
# Connect to your Supabase database
psql "postgresql://postgres:[password]@[host]:5432/postgres"

# Run the migration
\i tmp_migrations/add_complete_activitypub_federation.sql
```

### Step 2: Deploy Edge Functions
```bash
# Make sure you're in the project root
cd /home/y4my4m/gits/hobby/harmony

# For localhost, you put the files in the supabase/functions directory of the docker and restart the docker container
# For remote, you can use the supabase functions new command to create the functions

# Deploy all functions
supabase functions deploy webfinger
supabase functions deploy actor
supabase functions deploy nodeinfo  
supabase functions deploy inbox

# Set environment variables
supabase secrets set INSTANCE_DOMAIN="har.mony.lol"
supabase secrets set INSTANCE_NAME="Harmony"
supabase secrets set INSTANCE_DESCRIPTION="The first federated Discord-like platform"
```

### Step 3: Test Federation
```bash
# Test WebFinger
curl "https://[your-project].supabase.co/functions/v1/webfinger?resource=acct:username@har.mony.lol"

# Test Actor endpoint
curl "https://[your-project].supabase.co/functions/v1/actor/username"

# Test NodeInfo
curl "https://[your-project].supabase.co/functions/v1/nodeinfo/2.0"
```

## 🎨 UI Components to Build

### 1. Reaction Picker
```typescript
// src/components/reactions/ReactionPicker.vue
// - Emoji grid with categories
// - Custom emoji support
// - Recent reactions
// - Skin tone variants
```

### 2. Post Editor
```typescript
// src/components/posts/PostEditor.vue
// - Rich text editing
// - Edit history viewer
// - Change tracking
// - Federation status indicator
```

### 3. Voice Channel Federation
```typescript
// src/components/voice/VoiceFederationManager.vue
// - Cross-instance voice channels
// - Federation status indicators
// - Permission management
// - Voice state synchronization
```

### 4. Server Federation Browser
```typescript
// src/components/servers/FederatedServerBrowser.vue
// - Discover remote servers
// - Join/leave interface
// - Permission preview
// - Server health indicators
```

## 🔧 Background Processing

### Federation Delivery Worker
```typescript
// src/workers/federationDeliveryWorker.ts
// - Process delivery queue
// - Retry failed deliveries
// - Update instance health
// - Handle rate limiting
```

### Activity Processing Worker
```typescript
// src/workers/activityProcessingWorker.ts
// - Process incoming activities
// - Validate signatures
// - Update local state
// - Handle conflicts
```

## 📊 Monitoring & Analytics

### Federation Dashboard
- **Activity Statistics**: Total activities, success rates
- **Instance Health**: Reachable instances, failure rates
- **Delivery Queue**: Pending deliveries, retry counts
- **Performance Metrics**: Response times, throughput

### Health Checks
```sql
-- Monitor federation health
SELECT * FROM federation_stats;
SELECT * FROM delivery_queue_stats;
SELECT * FROM instance_health WHERE health_status != 'healthy';
```

## 🔐 Security Considerations

### 1. Activity Signature Verification
- Implement HTTP signature verification
- Validate actor keys
- Prevent replay attacks

### 2. Rate Limiting
- Implement per-instance rate limits
- Prevent spam and abuse
- Graceful degradation

### 3. Content Moderation
- Instance-level blocking
- Content filtering
- User reporting system

## 🌟 Revolutionary Features

### 1. Federated Voice Chat
- **First of its kind**: No other platform federates voice
- **WebRTC + ActivityPub**: Hybrid approach for discovery and connection
- **Voice State Federation**: Mute, deafen, video states across instances

### 2. Federated Server Joining
- **Discord-like server discovery**: Browse and join remote servers
- **Permission Federation**: Synchronize roles and permissions
- **Data Sovereignty**: Messages stored on server's home instance

### 3. Hybrid Social + Chat
- **Unified Experience**: Posts and messages in one interface
- **Cross-Platform**: Bridge Discord, Matrix, and ActivityPub
- **Real-time Federation**: Live updates across instances

## 📅 Timeline

### Week 1: Core Infrastructure
- ✅ Database migration
- ✅ Enhanced service layer
- ⏳ Deploy Edge Functions
- ⏳ Test basic federation

### Week 2: Advanced Features
- 🔄 Reaction system
- 🔄 Post editing
- 🔄 Voice federation basics

### Week 3: Revolutionary Features
- 🔄 Server federation
- 🔄 Cross-instance messaging
- 🔄 Voice chat federation

### Week 4: Polish & Launch
- 🔄 UI refinements
- 🔄 Performance optimization
- 🔄 Documentation
- 🔄 Community announcement

## 🎯 Success Metrics

### Technical Metrics
- **Federation Success Rate**: >95% successful deliveries
- **Response Time**: <500ms for local activities
- **Instance Health**: >90% instances reachable
- **Voice Quality**: <100ms latency for federated voice

### User Experience Metrics
- **Cross-Instance Interactions**: Users actively federating
- **Server Joining**: Users joining remote servers
- **Voice Usage**: Users using federated voice channels
- **Content Creation**: Posts, messages, reactions across instances

## 🚀 Next Steps

1. **Deploy the database migration** - This gives us the foundation
2. **Deploy Edge Functions** - This enables basic federation
3. **Test with Mastodon** - Verify standard ActivityPub compatibility
4. **Build reaction system** - First advanced feature
5. **Implement voice federation** - Revolutionary feature
6. **Launch server federation** - Game-changing feature

## 📞 Voice Chat Federation Architecture

### WebRTC + ActivityPub Hybrid
```
┌─────────────────┐    ActivityPub     ┌─────────────────┐
│   Instance A    │ ◄──────────────► │   Instance B    │
│                 │                   │                 │
│ User joins      │ VoiceJoin Activity│ Receives join   │
│ voice channel   │ ──────────────────► │ Updates state   │
│                 │                   │                 │
│ WebRTC Direct   │ ◄──────────────► │ WebRTC Direct   │
│ P2P Connection  │                   │ P2P Connection  │
└─────────────────┘                   └─────────────────┘
```

### Voice State Federation
- **Join Events**: `VoiceJoin` activity announces user joining
- **State Updates**: `VoiceUpdate` for mute/deafen/video changes
- **Leave Events**: `VoiceLeave` activity announces user leaving
- **WebRTC Signaling**: Direct P2P for actual voice data

This creates the world's first federated voice chat system! 🎉

---

**Ready to revolutionize communication?** Let's build the future of federated social platforms! 🚀 