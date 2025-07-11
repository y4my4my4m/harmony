# ActivityPub Race Condition Fixes & Architectural Improvements

## Overview

This document outlines the comprehensive fixes applied to the ActivityPub implementation to eliminate race conditions, double-toggling issues, and improve the overall reliability and user experience of post interactions (favorites, reblogs, bookmarks).

## Issues Identified

### 1. Race Conditions in Post Interactions
- **Problem**: Post interactions were being toggled twice due to overlapping updates from local state, database triggers, and realtime subscriptions
- **Symptoms**: Users clicking "favorite" would see the action toggle on, then immediately toggle off (or vice versa)
- **Root Cause**: Multiple asynchronous update paths without proper coordination

### 2. Lack of Optimistic Updates
- **Problem**: UI didn't provide immediate feedback, requiring users to wait for database response
- **Impact**: Poor user experience with laggy interactions

### 3. No Debouncing Protection
- **Problem**: Rapid clicks could trigger multiple simultaneous requests
- **Risk**: Database constraint violations and inconsistent state

### 4. Inconsistent State Management
- **Problem**: Different feeds were updated separately without proper synchronization
- **Impact**: Posts could show different interaction states in different contexts

### 5. Federation Timing Issues
- **Problem**: ActivityPub federation happened after database updates, causing potential timing conflicts
- **Risk**: Federation activities being sent with stale data

## Solutions Implemented

### 1. New InteractionService (`src/services/InteractionService.ts`)

**Purpose**: Centralized service for managing post interactions with race condition prevention

**Key Features**:
- **Optimistic Updates**: Immediate UI feedback with rollback on failure
- **Debouncing**: 300ms debounce to prevent rapid-fire requests
- **Race Condition Prevention**: Tracks pending interactions and prevents concurrent operations
- **State Caching**: Caches interaction states to reduce database calls
- **Event System**: Custom events for reactive UI updates

**Architecture**:
```typescript
interface InteractionState {
  is_favorited: boolean;
  is_reblogged: boolean; 
  is_bookmarked: boolean;
  favorites_count: number;
  reblogs_count: number;
}

class InteractionService {
  private pendingInteractions: Map<string, PendingInteraction>;
  private interactionStates: Map<string, InteractionState>;
  private debounceTimers: Map<string, NodeJS.Timeout>;
}
```

**Flow**:
1. User clicks interaction button
2. Service checks for pending operations
3. Applies optimistic update immediately
4. Debounces database operation (300ms)
5. Performs database update with proper error handling
6. Handles federation asynchronously
7. Rollback on failure, confirm on success

### 2. Enhanced usePostInteractions Composable (`src/composables/usePostInteractions.ts`)

**Purpose**: Vue composable providing reactive interaction state management for components

**Features**:
- **Reactive State**: Automatically updates UI when interaction state changes
- **Loading States**: Shows loading indicators during operations
- **Error Handling**: Displays user-friendly error messages
- **Auto-subscription**: Automatically subscribes to state changes for specific posts

**Usage**:
```vue
<script setup lang="ts">
const { state, toggleFavorite, toggleReblog, toggleBookmark } = usePostInteractions(post);
</script>

<template>
  <button 
    :class="{ active: state.is_favorited, loading: state.loading.favorite }"
    @click="toggleFavorite"
    :disabled="state.loading.favorite"
  >
    ❤️ {{ state.favorites_count }}
  </button>
</template>
```

### 3. Updated ActivityPub Store Integration

**Changes**:
- Removed direct database interaction methods from store
- Added InteractionService integration
- Implemented proper realtime event filtering
- Added synchronization between service and store state

**Realtime Handling**:
```typescript
// Old approach - direct updates causing race conditions
handleRealtimeInteractionChange(payload) {
  this.updatePostInteraction(postId, type, isActive); // Could conflict with pending operations
}

// New approach - deferred to InteractionService
handleRealtimeInteractionChange(payload) {
  interactionService.updateFromRealtime(postId, type, delta); // Respects pending operations
}
```

### 4. Component-Level Improvements

**MonyPost.vue Updates**:
- Integrated `usePostInteractions` composable
- Removed emit-based interaction handling  
- Added loading states and disabled states
- Improved accessibility with proper ARIA states

**Benefits**:
- Immediate visual feedback
- Proper loading indicators
- Error state handling
- Accessibility improvements

### 5. Federation Service Enhancements

**Added `federateAnnounce` Method**:
```typescript
async federateAnnounce(postId: string, userId: string, isAnnounce: boolean): Promise<string | null> {
  // Handles reblog/boost federation to ActivityPub networks
}
```

**Improved Federation Flow**:
- Federation now happens asynchronously after local updates
- Failures don't affect local interactions
- Proper ActivityPub Announce/Undo activities

## Technical Benefits

### 1. Race Condition Elimination
- **Pending Interaction Tracking**: Prevents concurrent operations on the same post/interaction type
- **Debouncing**: Reduces redundant database calls
- **Realtime Filtering**: Ignores realtime updates for pending local operations

### 2. Improved Performance
- **State Caching**: Reduces database queries for frequently accessed interaction states
- **Optimistic Updates**: Immediate UI feedback without waiting for network
- **Debounced Operations**: Batches rapid actions into single operations

### 3. Better Error Handling
- **Rollback Mechanism**: Automatically reverts optimistic updates on failure
- **Graceful Degradation**: Federation failures don't break local functionality
- **User Feedback**: Clear error messages for failed operations

### 4. Enhanced User Experience
- **Instant Feedback**: Users see immediate response to their actions
- **Loading States**: Clear indication when operations are in progress
- **Consistent State**: Same interaction state across all UI contexts

## Database Schema Considerations

The existing database schema with triggers for updating interaction counts works well with the new system:

```sql
-- Existing triggers handle count updates automatically
CREATE TRIGGER update_post_counts_trigger
    AFTER INSERT OR DELETE ON post_interactions
    FOR EACH ROW EXECUTE FUNCTION update_post_counts();
```

**Benefits**:
- Automatic count maintenance
- Atomic operations
- Consistent state across the application

## Migration Path

### For Existing Components:
1. Replace direct store interaction calls with composable:
   ```typescript
   // Before
   await activityPubStore.toggleFavorite(postId);
   
   // After  
   const { toggleFavorite } = usePostInteractions(post);
   await toggleFavorite();
   ```

2. Update templates to use reactive state:
   ```vue
   <!-- Before -->
   <button :class="{ active: post.is_favorited }">
   
   <!-- After -->
   <button :class="{ active: state.is_favorited, loading: state.loading.favorite }">
   ```

### For New Features:
- Use `usePostInteractions` composable for all interaction handling
- Follow the established patterns for optimistic updates
- Implement proper loading and error states

## Testing Recommendations

### 1. Race Condition Testing
- Rapid clicking on interaction buttons
- Simultaneous interactions from multiple tabs
- Network interruption during operations

### 2. Performance Testing  
- Large numbers of posts with interactions
- Rapid scrolling through feeds
- Memory usage during extended sessions

### 3. Federation Testing
- Interactions with federated posts
- Federation failure scenarios
- ActivityPub compliance verification

## Future Enhancements

### 1. Offline Support
- Queue interactions for when connectivity is restored
- Local storage for interaction state persistence

### 2. Advanced Optimizations
- Virtual scrolling for large feeds
- Intersection observer for lazy loading interaction states
- Service worker integration for background sync

### 3. Enhanced Federation
- Real-time ActivityPub updates via WebSockets
- Improved signature verification
- Enhanced discovery mechanisms

## Conclusion

These improvements provide a robust, scalable foundation for ActivityPub interactions that eliminates race conditions while providing an excellent user experience. The modular architecture makes it easy to extend and maintain while ensuring consistency across the application.

The new system is:
- **Race Condition Free**: Proper coordination prevents conflicting updates
- **User-Friendly**: Immediate feedback with graceful error handling  
- **Scalable**: Efficient caching and debouncing mechanisms
- **Maintainable**: Clean separation of concerns and modular design
- **Federation-Ready**: Proper ActivityPub compliance with async operations