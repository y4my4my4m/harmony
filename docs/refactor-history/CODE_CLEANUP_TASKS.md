# Code Cleanup Tasks (Post-Refactor)

## High Priority (Do Soon)

### 1. Replace `federated_id` with `ap_id` in Code ⏳

**Database Migration**: ✅ Created (`db_schema/migrations/rename_federated_id_to_ap_id.sql`)

**Code Updates Needed**:

Find and replace in these files:
```bash
# Search for all uses of federated_id
grep -r "federated_id" src/ --include="*.ts" --include="*.vue"

# Common locations:
- src/services/*.ts
- src/stores/*.ts
- src/components/**/*.vue
- src/utils/*.ts
```

**Example changes**:
```typescript
// BEFORE:
profile.federated_id
post.federated_id
{ federated_id: actorUrl }

// AFTER:
profile.ap_id
post.ap_id
{ ap_id: actorUrl }
```

**Steps**:
1. Apply database migration
2. Search/replace in code
3. Test thoroughly
4. Commit changes

---

### 2. Remove Hardcoded Domain (`har.mony.lol`) ⏳

**Found in**: ~71 files (see grep results)

**Replace with**:
```typescript
// Get domain from instance config
const getInstanceDomain = async () => {
  const { data } = await supabase
    .from('instance_config')
    .select('config_value')
    .eq('config_key', 'domain')
    .single()
  
  return data?.config_value || 'localhost'
}

// Or use environment variable:
const domain = import.meta.env.VITE_INSTANCE_DOMAIN || 'localhost'
```

**Files to Update**:
- `src/services/activityPubService.ts` (primary)
- `src/components/activitypub/*.vue`
- `src/services/TrendingService.ts`
- `src/utils/unifiedContentProcessing.ts`
- And ~67 others

**Recommendation**: Create a centralized config utility:
```typescript
// src/config/instance.ts
export const instanceConfig = {
  domain: import.meta.env.VITE_INSTANCE_DOMAIN || 'localhost',
  name: import.meta.env.VITE_INSTANCE_NAME || 'Harmony',
  url: `https://${import.meta.env.VITE_INSTANCE_DOMAIN || 'localhost'}`
}
```

---

## Medium Priority (This Month)

### 3. Apply PostgreSQL Function Cleanup 🗂️

**Status**: Scripts created, not applied

**Steps**:
```bash
# 1. BACKUP FIRST!
pg_dump > backup.sql

# 2. Apply cleanup
psql < db_schema/drop_unnecessary_functions.sql
psql < db_schema/essential_functions.sql

# 3. Test everything
# 4. Celebrate 88% reduction!
```

**Impact**:
- 124 → 15 functions
- Easier to understand
- Easier to maintain

---

### 4. Test Federation End-to-End 🧪

**Not tested yet**:
- Federation backend listens to database
- Activities sent to remote instances
- Incoming activities processed
- Real federation with Mastodon/Misskey

**Testing Plan**:
1. Start federation backend
2. Create post
3. Check backend logs
4. Verify delivery queue
5. Test with real Mastodon instance

---

### 5. Performance Optimization ⚡

**Areas to optimize**:
- Database queries (add indexes)
- Frontend bundle size (code splitting)
- Image optimization
- Lazy loading

**Measurements needed**:
- Query performance
- Page load time
- First contentful paint
- Time to interactive

---

## Low Priority (Nice to Have)

### 6. Add Comprehensive Tests 🧪

**Backend Tests**:
```typescript
// federation-backend/src/__tests__/ActivityProcessor.test.ts
describe('ActivityProcessor', () => {
  it('should process incoming Follow activity', async () => {
    // Test implementation
  })
})
```

**Frontend Tests**:
```typescript
// src/services/__tests__/MessageService.test.ts
describe('MessageService', () => {
  it('should send channel message', async () => {
    // Test implementation
  })
})
```

---

### 7. Mobile Responsiveness 📱

**Test on**:
- iOS Safari
- Android Chrome
- Various screen sizes

**Issues to fix**:
- Touch gestures
- Viewport sizing
- Keyboard handling

---

### 8. Accessibility ♿

**Add**:
- ARIA labels
- Keyboard navigation
- Screen reader support
- Focus management
- Contrast ratios

---

### 9. Error Boundary Components 🛡️

**Create**:
```vue
<template>
  <div v-if="error" class="error-boundary">
    <h2>Something went wrong</h2>
    <button @click="reset">Try again</button>
  </div>
  <slot v-else />
</template>
```

**Use in**:
- Main routes
- Complex components
- API call wrappers

---

### 10. PWA Enhancements 📲

**Improve**:
- Offline support
- Push notifications
- App manifest
- Service worker
- Install prompts

---

## Code Quality Improvements

### Remove Console.logs

**Production build should not have**:
```typescript
console.log('🚀 Doing something...')
```

**Replace with**:
```typescript
if (import.meta.env.DEV) {
  console.log('🚀 Doing something...')
}
```

---

### TypeScript Strict Mode

**Enable**:
```json
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

**Fix**:
- Any types
- Implicit any
- Unused variables

---

### ESLint/Prettier

**Run**:
```bash
npm run lint
npm run format
```

**Fix**:
- Unused imports
- Formatting issues
- Best practice violations

---

## Documentation Improvements

### API Documentation

**Create**:
- Federation backend API docs
- WebFinger examples
- ActivityPub flow diagrams

### User Guides

**Write**:
- Admin guide
- Moderation guide
- Federation guide
- Troubleshooting guide

---

## Future Enhancements

### Features
- [ ] End-to-end encryption for DMs
- [ ] Rich media previews
- [ ] Custom emoji management improvements
- [ ] Advanced moderation tools
- [ ] Analytics dashboard

### Federation
- [ ] Better Misskey compatibility
- [ ] Instance blocking/muting
- [ ] Content filters
- [ ] Relay support

### Performance
- [ ] GraphQL option
- [ ] WebSocket for real-time
- [ ] CDN integration
- [ ] Database sharding

---

## Summary

**Critical** (Do now):
1. Rename federated_id → ap_id
2. Remove hardcoded domains
3. Test federation

**Important** (Do soon):
1. Apply function cleanup
2. Add tests
3. Performance optimization

**Nice to have** (Do later):
1. Mobile polish
2. Accessibility
3. PWA improvements

---

**Most of the heavy lifting is done! These are refinements.** ✨

