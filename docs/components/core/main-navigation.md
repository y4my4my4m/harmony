# MainNavigation

The primary navigation component that provides access to direct messages, server selection, and main application features.

## Overview

`MainNavigation.vue` is positioned on the left side of the application and serves as the main navigation hub. It displays:
- Direct Messages button with unread count
- List of joined servers with icons
- Add server functionality
- User settings access
- Visual indicators for active selections

## Features

### Direct Messages Access
- Quick access to DM interface via router-link
- Unread message count badge
- Visual active state when on DM route

### Server Navigation
- Displays all servers the user has joined
- Server icons or generated acronyms
- Active server highlighting with pill indicator
- Click to switch between servers

### Server Management
- Add new server button
- Server creation modal integration
- Join server functionality

## Props

```typescript
// No props - uses global stores for data
```

## Structure

```vue
<template>
  <div class="main-navigation">
    <!-- DM Button -->
    <div class="nav-section">
      <router-link to="/dm" class="nav-item dm-button">
        <!-- DM icon and unread badge -->
      </router-link>
    </div>

    <!-- Server List -->
    <div class="nav-section servers-section">
      <div v-for="server in servers" class="nav-item server-item">
        <!-- Server icon/acronym and active indicator -->
      </div>
      
      <!-- Add Server Button -->
      <div class="nav-item add-server-button">
        <!-- Add server functionality -->
      </div>
    </div>

    <!-- User Section -->
    <div class="nav-section user-section">
      <!-- User avatar and settings -->
    </div>
  </div>
</template>
```

## State Management

### Computed Properties
```typescript
const isDMRoute = computed(() => route.path.startsWith('/dm'))
const servers = computed(() => serverStore.servers)
const currentServerId = computed(() => serverChannelStore.currentServerId)
```

### Store Dependencies
- `useServerStore` - Server list and management
- `useServerChannelStore` - Current server/channel context
- `useDMStore` - Direct message unread counts
- `useAuthStore` - User authentication state

## Methods

### Server Selection
```typescript
const selectServer = (serverId: string) => {
  router.push(`/server/${serverId}`)
  serverChannelStore.setCurrentServer(serverId)
}

const isServerActive = (serverId: string) => {
  return currentServerId.value === serverId
}
```

### Server Icon Handling
```typescript
const getServerAcronym = (serverName: string) => {
  return serverName
    .split(' ')
    .map(word => word.charAt(0).toUpperCase())
    .join('')
    .substring(0, 2)
}
```

## Styling

### Layout
- Fixed left sidebar positioning
- Vertical layout with sections
- Consistent spacing and sizing

### Server Icons
- 48px circular containers
- Image fallback to acronym
- Hover and active states
- Pill indicator for active server

### Responsive Design
- Mobile-friendly touch targets
- Collapsible on smaller screens
- Adaptive icon sizes

## Usage

The component is typically used in the main application layout:

```vue
<template>
  <div class="app-layout">
    <MainNavigation />
    <div class="main-content">
      <router-view />
    </div>
  </div>
</template>

<script setup lang="ts">
import MainNavigation from '@/components/MainNavigation.vue'
</script>
```

## Navigation Behavior

### Route Integration
- Uses Vue Router for navigation
- Programmatic navigation on server selection
- Active route detection for highlighting

### State Persistence
- Server selection persists across page reloads
- Unread counts update in real-time
- User preferences for collapsed state

## Accessibility

### Keyboard Navigation
- Tab-accessible navigation items
- Enter/Space key activation
- Proper focus indicators

### Screen Reader Support
- Descriptive aria-labels
- Role definitions for navigation
- Unread count announcements

### Visual Indicators
- High contrast active states
- Clear hover feedback
- Consistent iconography

## Integration Points

### With Router
- Route-based active state detection
- Programmatic navigation on selections
- Deep linking support for servers

### With Stores
- Real-time server list updates
- Unread count synchronization
- User authentication state

### With Modals
- Server creation modal trigger
- User settings modal access
- Context menu integration

## Performance

### Optimization Strategies
- Efficient server list rendering
- Minimal re-renders with computed properties
- Lazy loading of server icons

### Memory Management
- Proper cleanup of event listeners
- Efficient icon caching
- Optimized image loading

## Related Components

- [ServerSidebar](/components/serversidebar) - Server list rail
- [DMSidebar](/components/dmsidebar) - Direct message navigation
- [CreateServer](/components/createserver) - Server creation modal
- [UserSidebar](/components/usersidebar) - User list display

## CSS Classes

```css
.main-navigation {
  /* Main container styles */
}

.nav-section {
  /* Section grouping */
}

.nav-item {
  /* Individual navigation items */
}

.server-item.active {
  /* Active server styling */
}

.unread-badge {
  /* Unread count indicator */
}

.server-pill {
  /* Active server pill indicator */
}
```

The MainNavigation component serves as the primary entry point for users to navigate between different areas of the Harmony application, providing quick access to both direct messages and server-based conversations.
