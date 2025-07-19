# **Core/Federation Architecture Refactoring Plan**

## **🎯 Objective**
Migrate from monolithic services to professional **core/federation separation** while maintaining **100% functionality** and **zero breaking changes** to existing stores and components.

---

## **🏗️ Target Architecture**

### **Current (Monolithic)**
```
src/services/
├── MessageService.ts     # Local + federation mixed
├── PostService.ts        # Local + federation mixed
├── ProfileService.ts     # Local + federation mixed
└── InteractionService.ts # Local + federation mixed
```

### **Target (Separated)**
```
src/services/
├── core/
│   ├── CoreMessageService.ts    # Pure local operations
│   ├── CorePostService.ts       # Pure local operations
│   ├── CoreProfileService.ts    # Pure local operations
│   ├── CoreInteractionService.ts # Pure local operations
│   └── index.ts                 # Core exports
├── federation/
│   ├── ActivityPubService.ts    # AP protocol handling
│   ├── FederationService.ts     # Federation coordination
│   ├── OutboxService.ts         # Outgoing activities
│   ├── InboxService.ts          # Incoming activities
│   └── index.ts                 # Federation exports
├── MessageService.ts            # Orchestrator (same API)
├── PostService.ts              # Orchestrator (same API)
├── ProfileService.ts           # Orchestrator (same API)
├── InteractionService.ts       # Orchestrator (same API)
└── index.ts                    # Same exports as before
```

---

## **📋 Migration Phases**

### **Phase 1: Core Services Foundation** 🏗️

**Priority**: High (Foundation for everything else)

**Scope**: Extract pure local operations from existing services

#### **Phase 1A: Core Message Service** ✅ **COMPLETED**
- [x] **CREATED**: `src/services/core/CoreMessageService.ts` ✅
  - [x] Extracted `sendChannelMessage()` - pure local database insertion ✅
  - [x] Extracted `sendDMMessage()` - local database, no federation logic ✅
  - [x] Extracted `editMessage()` - pure local updates ✅
  - [x] Extracted `deleteMessage()` - local soft delete ✅
  - [x] Extracted `toggleReaction()` - pure local reaction CRUD ✅
  - [x] Extracted `getMessageReactions()` - pure database query ✅
  - [x] Extracted `loadChannelMessages()` - pure local pagination ✅
  - [x] Extracted `loadConversationMessages()` - pure local queries ✅
  - [x] Extracted `loadMessage()` - single message loading ✅
  - [x] **REMOVED**: All `ap_activities` insertions ✅
  - [x] **REMOVED**: All federation condition checks ✅
  - [x] **KEPT**: All Supabase operations, validation, error handling ✅
  - [x] **CREATED**: `src/services/core/index.ts` for exports ✅

#### **Phase 1B: Core Post Service**
- [ ] **CREATE**: `src/services/core/CorePostService.ts`
  - [ ] Extract `createPost()` - pure local post creation
  - [ ] Extract `updatePost()` - local post editing
  - [ ] Extract `deletePost()` - local soft delete
  - [ ] Extract `toggleLike()` - pure local like CRUD
  - [ ] Extract `toggleShare()` - local reblog operations
  - [ ] Extract `toggleBookmark()` - pure local bookmarks
  - [ ] Extract `toggleReaction()` - pure local post reactions
  - [ ] Extract `loadTimelinePosts()` - pure local queries
  - [ ] Extract `loadPost()` - single post loading
  - [ ] **REMOVE**: All federation logic
  - [ ] **KEEP**: All validation, caching, pagination

#### **Phase 1C: Core Profile Service**
- [ ] **CREATE**: `src/services/core/CoreProfileService.ts`
  - [ ] Extract `updateProfile()` - pure local profile updates
  - [ ] Extract `loadProfile()` - local profile loading
  - [ ] Extract `searchProfiles()` - local search operations
  - [ ] Extract `getUserStats()` - local statistics
  - [ ] **REMOVE**: ActivityPub key generation
  - [ ] **REMOVE**: Federation metadata updates
  - [ ] **KEEP**: All profile validation and caching

#### **Phase 1D: Core Interaction Service**
- [ ] **CREATE**: `src/services/core/CoreInteractionService.ts`
  - [ ] Extract `toggleFollow()` - pure local follow operations
  - [ ] Extract `toggleBlock()` - local blocking operations
  - [ ] Extract `toggleMute()` - local muting operations
  - [ ] Extract `acceptFollowRequest()` - local approval
  - [ ] Extract `rejectFollowRequest()` - local rejection
  - [ ] Extract `getFollowers()` - pure local queries
  - [ ] Extract `getFollowing()` - pure local queries
  - [ ] Extract `getUserRelationships()` - batch local queries
  - [ ] **REMOVE**: All ActivityPub activity creation
  - [ ] **KEEP**: All relationship validation and caching

#### **Phase 1E: Core Service Testing**
- [ ] **TEST**: All core services work independently
- [ ] **VERIFY**: No federation dependencies in core services
- [ ] **CONFIRM**: All database operations preserved
- [ ] **VALIDATE**: Error handling works correctly

---

### **Phase 2: Federation Services Foundation** 🌐

**Priority**: High (Complementary to core services)

**Scope**: Extract pure federation operations from existing services

#### **Phase 2A: ActivityPub Service**
- [ ] **CREATE**: `src/services/federation/ActivityPubService.ts`
  - [ ] Extract AP JSON generation from all services
  - [ ] Extract AP content conversion logic
  - [ ] Extract AP actor handling
  - [ ] Extract AP object creation
  - [ ] Extract AP activity formatting
  - [ ] **NO DATABASE OPERATIONS**: Pure protocol handling only

#### **Phase 2B: Federation Service** 
- [ ] **CREATE**: `src/services/federation/FederationService.ts`
  - [ ] Extract federation condition checks (`shouldFederate()`)
  - [ ] Extract instance domain logic
  - [ ] Extract user federation settings
  - [ ] Extract delivery coordination
  - [ ] Extract federation health checking
  - [ ] **COORDINATE**: Between AP service and outbox/inbox

#### **Phase 2C: Outbox Service**
- [ ] **CREATE**: `src/services/federation/OutboxService.ts`
  - [ ] Extract all `ap_activities` insertion logic
  - [ ] Extract delivery queue management
  - [ ] Extract retry logic
  - [ ] Extract activity signing
  - [ ] Extract outgoing federation for:
    - [ ] Posts/messages
    - [ ] Reactions
    - [ ] Follows
    - [ ] Profile updates
  - [ ] **PURE OUTGOING**: No local database operations

#### **Phase 2D: Inbox Service**
- [ ] **CREATE**: `src/services/federation/InboxService.ts`
  - [ ] Extract incoming activity processing
  - [ ] Extract activity validation
  - [ ] Extract actor verification
  - [ ] Extract signature verification
  - [ ] Extract incoming federation for:
    - [ ] Posts/messages
    - [ ] Reactions  
    - [ ] Follows
    - [ ] Profile updates
  - [ ] **COORDINATE**: With core services for local storage

#### **Phase 2E: Federation Service Testing**
- [ ] **TEST**: All federation services work independently
- [ ] **VERIFY**: No local database operations in federation services
- [ ] **CONFIRM**: All ActivityPub logic preserved
- [ ] **VALIDATE**: Federation protocols work correctly

---

### **Phase 3: Unified Service Orchestration** 🎭

**Priority**: Critical (Maintains existing APIs)

**Scope**: Refactor existing services to orchestrate core + federation

#### **Phase 3A: Message Service Orchestration**
- [ ] **REFACTOR**: `src/services/MessageService.ts` to use core + federation
  - [ ] Import `CoreMessageService` and `FederationService`
  - [ ] Implement orchestration pattern:
    ```typescript
    async toggleReaction(messageId: string, emojiId: string) {
      // 1. Core operation (always)
      const result = await this.core.toggleReaction(messageId, emojiId)
      
      // 2. Federation (conditional)
      if (await this.federation.shouldFederate(messageId)) {
        await this.federation.federateReaction(messageId, emojiId, result)
      }
      
      return result // Same return format as before
    }
    ```
  - [ ] **PRESERVE**: Exact same method signatures
  - [ ] **PRESERVE**: Same return types and error formats
  - [ ] **PRESERVE**: Same TypeScript interfaces

#### **Phase 3B: Post Service Orchestration**
- [ ] **REFACTOR**: `src/services/PostService.ts` to use core + federation
  - [ ] Implement same orchestration pattern
  - [ ] Preserve all existing APIs
  - [ ] Maintain same error handling
  - [ ] Keep same performance characteristics

#### **Phase 3C: Profile Service Orchestration**
- [ ] **REFACTOR**: `src/services/ProfileService.ts` to use core + federation
  - [ ] Implement orchestration for profile updates
  - [ ] Handle federation of profile changes
  - [ ] Preserve existing method signatures

#### **Phase 3D: Interaction Service Orchestration**
- [ ] **REFACTOR**: `src/services/InteractionService.ts` to use core + federation
  - [ ] Orchestrate follow/block operations
  - [ ] Handle ActivityPub follow federation
  - [ ] Preserve all relationship APIs

#### **Phase 3E: Service Integration Testing**
- [ ] **TEST**: All orchestrated services maintain exact same behavior
- [ ] **VERIFY**: All store calls work identically
- [ ] **CONFIRM**: Same TypeScript types and interfaces
- [ ] **VALIDATE**: Same performance characteristics

---

### **Phase 4: Migration Verification & Cleanup** ✅

**Priority**: Critical (Ensure no regressions)

**Scope**: Comprehensive testing and cleanup

#### **Phase 4A: Functionality Verification**
- [ ] **TEST**: All existing store operations work identically
- [ ] **TEST**: All component interactions preserved
- [ ] **TEST**: All federation scenarios work (local-only, DM, posts)
- [ ] **TEST**: All real-time subscriptions work
- [ ] **TEST**: All caching mechanisms preserved
- [ ] **TEST**: All error handling scenarios
- [ ] **TEST**: All optimistic updates work
- [ ] **TEST**: All loading states preserved

#### **Phase 4B: Performance Verification**
- [ ] **BENCHMARK**: Core operations vs original performance
- [ ] **BENCHMARK**: Federation operations vs original performance
- [ ] **BENCHMARK**: Combined operations vs original performance
- [ ] **VERIFY**: No performance degradation
- [ ] **OPTIMIZE**: Any performance issues identified

#### **Phase 4C: Type Safety Verification**
- [ ] **COMPILE**: Full TypeScript compilation without errors
- [ ] **VERIFY**: All type interfaces preserved
- [ ] **CONFIRM**: All component type checking works
- [ ] **VALIDATE**: All service method signatures match

#### **Phase 4D: Code Cleanup**
- [ ] **REMOVE**: Old implementation code from orchestrator services
- [ ] **CLEAN**: Unused imports and dependencies
- [ ] **DOCUMENT**: New architecture patterns
- [ ] **UPDATE**: Service documentation

---

## **🔐 Zero-Risk Migration Principles**

### **1. Incremental Migration**
- Create new alongside old (no replacement until verified)
- Test each phase independently
- Rollback capability at each step

### **2. API Preservation**
- **NEVER CHANGE**: External method signatures
- **NEVER CHANGE**: Return types or error formats
- **NEVER CHANGE**: TypeScript interfaces
- **PRESERVE**: All existing functionality

### **3. Verification Strategy**
- Unit tests for core services (local operations only)
- Unit tests for federation services (protocol only)
- Integration tests for orchestrated services
- End-to-end tests for full functionality

### **4. Rollback Plan**
- Each phase can be independently rolled back
- Old implementation preserved until cleanup phase
- Clear rollback procedures documented

---

## **📊 Success Criteria**

### **Functional Success**
- [ ] **Zero Regressions**: All existing functionality works identically
- [ ] **Same APIs**: All service method calls work exactly as before
- [ ] **Same Performance**: No degradation in operation speed
- [ ] **Same Behavior**: Identical error handling and edge cases

### **Architectural Success**
- [ ] **Clean Separation**: Core services have no federation logic
- [ ] **Federation Isolation**: Federation services have no local database operations
- [ ] **Professional Structure**: Clear separation of concerns
- [ ] **Maintainability**: Easy to modify core or federation independently

### **Quality Success**
- [ ] **Type Safety**: Full TypeScript compliance maintained
- [ ] **Testing**: Comprehensive test coverage for all layers
- [ ] **Documentation**: Clear architecture documentation
- [ ] **Performance**: Same or better performance characteristics

---

## **⚠️ Risk Mitigation**

### **Technical Risks**
- **API Changes**: Mitigated by preserving exact method signatures
- **Performance Degradation**: Mitigated by benchmarking each phase
- **Federation Breakage**: Mitigated by isolated federation testing
- **Type Errors**: Mitigated by continuous TypeScript checking

### **Process Risks**
- **Scope Creep**: Mitigated by strict phase boundaries
- **Integration Issues**: Mitigated by incremental integration
- **Rollback Complexity**: Mitigated by clear rollback procedures
- **Testing Gaps**: Mitigated by comprehensive test strategy

---

## **🚀 Expected Benefits**

### **Immediate Benefits**
- **Professional Architecture**: Industry-standard separation of concerns
- **Better Testing**: Test local and federation logic independently
- **Clearer Code**: Obvious separation between local and federation operations
- **Easier Debugging**: Clear boundaries for issue isolation

### **Long-term Benefits**
- **Scalability**: Easy to add new federation protocols or local features
- **Maintainability**: Changes to federation don't affect local operations
- **Performance**: Optimize local and federation independently
- **Team Development**: Clear ownership boundaries for different concerns

---

## **📅 Estimated Timeline**

### **Week 1: Foundation**
- Days 1-2: Phase 1A-1B (Core Message/Post Services)
- Days 3-4: Phase 1C-1D (Core Profile/Interaction Services)  
- Day 5: Phase 1E (Core Service Testing)

### **Week 2: Federation**
- Days 1-2: Phase 2A-2B (ActivityPub/Federation Services)
- Days 3-4: Phase 2C-2D (Outbox/Inbox Services)
- Day 5: Phase 2E (Federation Service Testing)

### **Week 3: Integration** 
- Days 1-2: Phase 3A-3B (Message/Post Orchestration)
- Days 3-4: Phase 3C-3D (Profile/Interaction Orchestration)
- Day 5: Phase 3E (Integration Testing)

### **Week 4: Verification**
- Days 1-2: Phase 4A-4B (Functionality/Performance Verification)
- Days 3-4: Phase 4C-4D (Type Safety/Cleanup)
- Day 5: Final documentation and sign-off

**Total**: 4 weeks for complete migration with zero functionality loss.