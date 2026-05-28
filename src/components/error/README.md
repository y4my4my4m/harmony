# 404 Page Implementation

## Overview

The 404 page system has been redesigned to be professional, DRY (Don't Repeat Yourself), and scalable while maintaining the existing layout structure that shows sidebars for logged-in users and a clean layout for logged-out users.

## Architecture

### Components

1. **`NotFound404.vue`** - Core reusable 404 component
   - Handles random image selection from `/backgrounds/404/1.webp` and `/backgrounds/404/2.webp`
   - Provides different content for authenticated vs unauthenticated users
   - Context-aware navigation suggestions
   - Professional styling with accessibility features

2. **`NotFoundView.vue`** - Simple wrapper view
   - Uses the `NotFound404` component
   - Minimal code following DRY principles

### Router Configuration

The router already has a professional setup with two different 404 routes:

- **`/404`** (`NotFound`) - For authenticated users, uses `BaseLayout.vue` which provides:
  - Left sidebar (ServerSidebar)
  - Right sidebar when appropriate
  - Full app layout structure

- **`/404-public`** (`NotFoundPublic`) - For unauthenticated users
  - Clean layout without sidebars
  - Direct rendering of NotFoundView

### Features

#### For Authenticated Users

- **Left Sidebar**: Shows server list, DM button, and Monyverse button
- **Right Sidebar**: Context-dependent (chat/social features)
- **Quick Navigation**: Direct links to Chat, Social, DM, and Notifications
- **Smart Home Button**: Context-aware routing based on current path

#### For Unauthenticated Users

- **Clean Layout**: No sidebars, focused on the error content
- **Authentication Prompts**: Sign In and Create Account buttons
- **Welcome Message**: Encouraging users to join the community

#### Technical Features

- **Random Image Selection**: Chooses between `backgrounds/404/1.webp` and `backgrounds/404/2.webp`
- **Error Handling**: Fallback to alternate image if one fails to load
- **Context Awareness**: Different messages based on route (social, chat, settings)
- **Mobile Responsive**: Optimized layouts for all screen sizes
- **Accessibility**: High contrast support, reduced motion respect, proper ARIA labels
- **Performance**: Lazy loading and efficient image handling

## Usage

### Basic Usage

```vue
<template>
  <NotFound404 />
</template>
```

### Advanced Usage with Custom Props

```vue
<template>
  <NotFound404 
    title="Custom Title"
    description="Custom description for this specific error"
    home-button-text="Back to Dashboard"
    suggested-route="/custom-route"
  />
</template>
```

## Scalability

The solution is designed to be easily extensible:

1. **New Error Types**: Create new components that wrap `NotFound404` with specific props
2. **Custom Styling**: Override CSS variables or extend the base styles
3. **Additional Images**: Simply add new images to the `images` array
4. **Context Integration**: Leverages existing `notFoundUtils.ts` for smart routing

## File Structure

```text
src/
├── components/
│   └── error/
│       └── NotFound404.vue       # Core 404 component
├── views/
│   └── NotFoundView.vue          # Simple wrapper view
└── utils/
    └── notFoundUtils.ts          # Existing utility functions
```

## Benefits

1. **Professional**: Clean, modern design with proper error handling
2. **DRY**: Single source of truth for 404 logic, reusable component
3. **Scalable**: Easy to extend and customize for different error scenarios
4. **Accessible**: Meets WCAG guidelines for accessibility
5. **Responsive**: Works perfectly on all devices
6. **Integrated**: Uses existing layout system and utilities
7. **User-Friendly**: Context-aware navigation and clear call-to-actions

Existing 404 callers still work unchanged.
