# Component Structure

Harmony uses Vue 3 with both Composition API and Options API. Components are organized by feature domain under `src/components/`.

## Directory Layout

```
src/components/
├── activitypub/       # Timeline, posts, composer, explore
├── admin/             # Instance admin (emoji import, bots, performance)
├── chat/              # Chat header
├── common/            # Shared UI (Avatar, Modal, Icon, Toggle, ServerCard, etc.)
├── dm/                # DM-specific (group invite, call modal, header)
├── debug/             # Debug panels
├── demo/              # Showcases (RichTextDemo, AudioThemeShowcase)
├── easteregg/         # ConfettiEffect
├── embeds/            # Link embeds, server invite cards
├── encryption/        # Key setup wizard, encryption indicator
├── error/             # NotFound404
├── icons/             # SVG icon components
├── layouts/           # Base layout
├── publicservers/     # Public server browsing
├── search/            # Message search modal
├── settings/          # User and server settings
│   ├── user/          # Account, privacy, appearance, keybinds, etc.
│   └── server/        # Invite management
├── shared/            # UnifiedButton, UnifiedInput, UnifiedModal
├── threads/           # Thread sidebar, indicator, context menu
└── voice/             # Voice overlay, participants, device selector, spatial audio
```

Root-level components in `src/components/` include major features like `MessageDisplay.vue`, `ChatComponent.vue`, `ServerSidebar.vue`, `ChannelSidebar.vue`, `RichTextEditor.vue`, and `AuthComponent.vue`.

## Component Categories

### Layout Components

- **Layouts** (`src/layouts/`): `BaseLayout`, `AuthLayout`, `ChatLayout`, `SocialLayout` - control the overall page structure depending on the route
- **Navigation**: `MainNavigation`, `ServerSidebar`, `ChannelSidebar`, `DMSidebar` - persistent navigation elements

### View Components

Views in `src/views/` correspond to routes:

| View | Route | Purpose |
|------|-------|---------|
| `ChatView` | `/chat/:serverId/:channelId` | Server channel messaging |
| `DMView` | `/dm/:conversationId` | Direct messages |
| `TimelineView` | `/social/timeline` | ActivityPub home/public feed |
| `ExploreView` | `/social/explore` | Discover users and instances |
| `UserProfileView` | `/social/profile/:handle` | User profile with posts |
| `AdminPanel` | `/admin` | Instance administration |
| `UserSettings` | `/settings` | User preferences |
| `ServerSettings` | `/server/:id/settings` | Server configuration |

### Feature Components

**Chat & Messaging**:
- `MessageDisplay` - Main message list with virtual scrolling
- `MessageInput` - Message composer with rich text, file upload, emoji
- `MessageContent` / `UnifiedMessageContent` - Message rendering with markdown
- `MessageReactions` - Emoji reactions on messages
- `MessageContextMenu` - Right-click actions
- `RichTextEditor` - Rich text editing with formatting toolbar

**ActivityPub / Social**:
- `MonyPost` - Single post display with reactions and interactions
- `MonyFeed` - Post list/timeline feed
- `Composer` - Post/reply/quote composer (modal and inline modes)
- `ExploreContent` - Trending, tags, suggested users, instances
- `MonyMediaGallery` / `MonyMediaUpload` - Media handling

**Voice & Video**:
- `UnifiedVoiceOverlay` - Main voice channel UI
- `UnifiedVoiceDock` - Compact docked voice indicator
- `VoiceChannelParticipants` - Participant grid
- `SpatialAudioPanel` - 2D spatial audio controls
- `DeviceSelector` - Audio/video device picker

**Encryption**:
- `RecoveryKeySetupWizard` - Guided E2EE key setup
- `EncryptionIndicator` - Lock icon showing encryption status
- `EncryptionSettings` - Server encryption mode configuration

### Shared UI Components

The `common/` and `shared/` directories contain reusable primitives:

- `Avatar` - User/server avatar with presence indicator
- `BaseModal` / `UnifiedModal` - Modal dialog system
- `ModernButton` / `UnifiedButton` - Styled buttons
- `ModernInput` / `UnifiedInput` - Styled inputs
- `ToggleSwitch` - Toggle control
- `ServerCard` - Server preview card
- `ProfileCard` / `UnifiedProfileCard` - User info popover
- `CodeBlock` - Syntax-highlighted code display
- `SearchInput` - Search bar with debounce

## Naming Conventions

- **PascalCase** for component files and registration
- Feature-specific prefix where useful (e.g., `Mony*` for ActivityPub social components)
- `Unified*` prefix for components that work across multiple contexts (chat, DM, social)
- Icon components live in `icons/` and wrap inline SVGs

## Component Communication

- **Props down, events up** for parent-child
- **Pinia stores** for cross-component state
- **CustomEvent** for decoupled coordination (e.g., `megolm-key-received` for encryption key sharing)
- **Provide/inject** for layout-level context

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/architecture/components.md` and run `npm run docs:generate-guide` to update.
