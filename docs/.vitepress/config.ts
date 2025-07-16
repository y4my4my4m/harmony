import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  title: 'Harmony Documentation',
  description: 'Federated Social Platform with Chat - Complete Developer Guide',
  base: '/harmony/',
  
  head: [
    ['link', { rel: 'icon', href: '/harmony/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#646cff' }]
  ],
  
  // Mermaid configuration
  mermaid: {
    theme: 'default'
  },

  themeConfig: {
    logo: '/logo.png',
    
    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'API Reference', link: '/api/' },
      { text: 'Components', link: '/components/' },
      { text: 'Examples', link: '/examples/' },
      { text: 'System Flows', link: '/flows/' }
    ],
    
    sidebar: {
      '/guide/': [
        {
          text: 'Getting Started',
          collapsed: true,
          items: [
            { text: 'Introduction', link: '/guide/' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Environment Setup', link: '/guide/environment' }
          ]
        },
        {
          text: 'Architecture',
          collapsed: true,
          items: [
            { text: 'System Overview', link: '/guide/architecture/' },
            { text: 'Data Flow', link: '/guide/architecture/data-flow' },
            { text: 'Component Structure', link: '/guide/architecture/components' },
            { text: 'State Management', link: '/guide/architecture/state' },
            { text: 'Service Layer', link: '/guide/architecture/services' }
          ]
        },
        {
          text: 'Core Features',
          collapsed: true,
          items: [
            { text: 'Chat System', link: '/guide/features/chat' },
            { text: 'Social Features', link: '/guide/features/social' },
            { text: 'ActivityPub Federation', link: '/guide/features/federation' },
            { text: 'Voice & Video', link: '/guide/features/voice' },
            { text: 'User Management', link: '/guide/features/users' },
            { text: 'Administration', link: '/guide/features/admin' }
          ]
        },
        {
          text: 'Development',
          collapsed: true,
          items: [
            { text: 'Development Workflow', link: '/guide/development/' },
            { text: 'Testing', link: '/guide/development/testing' },
            { text: 'Debugging', link: '/guide/development/debugging' },
            { text: 'Performance', link: '/guide/development/performance' },
            { text: 'Contributing', link: '/guide/development/contributing' }
          ]
        },
        {
          text: 'Deployment',
          collapsed: true,
          items: [
            { text: 'Production Setup', link: '/guide/deployment/' },
            { text: 'Docker', link: '/guide/deployment/docker' },
            { text: 'Supabase', link: '/guide/deployment/supabase' },
            { text: 'Federation Setup', link: '/guide/deployment/federation' },
            { text: 'Monitoring', link: '/guide/deployment/monitoring' }
          ]
        }
      ],
      
      '/api/': [
        {
          text: 'Core Services',
          collapsed: true,
          items: [
            { text: 'Overview', link: '/api/' },
            { text: 'Authentication Service', link: '/api/services/auth' },
            { text: 'Chat Service', link: '/api/services/chat' },
            { text: 'ActivityPub Service', link: '/api/services/activitypub' },
            { text: 'User Data Service', link: '/api/services/userdata' },
            { text: 'Admin Service', link: '/api/services/admin' }
          ]
        },
        {
          text: 'Pinia Stores',
          collapsed: true,
          items: [
            { text: 'Auth Store', link: '/api/stores/auth' },
            { text: 'Chat Store', link: '/api/stores/chat' },
            { text: 'DM Store', link: '/api/stores/dm' },
            { text: 'ActivityPub Store', link: '/api/stores/activitypub' },
            { text: 'Server Channel Store', link: '/api/stores/serverchannel' },
            { text: 'Notification Store', link: '/api/stores/notification' }
          ]
        },
        {
          text: 'Vue Composables',
          collapsed: true,
          items: [
            { text: 'Layout State', link: '/api/composables/layout' },
            { text: 'User Data', link: '/api/composables/userdata' },
            { text: 'Presence', link: '/api/composables/presence' },
            { text: 'Voice Channel', link: '/api/composables/voice' }
          ]
        },
        {
          text: 'Types & Interfaces',
          collapsed: true,
          items: [
            { text: 'Core Types', link: '/api/types/core' },
            { text: 'Chat Types', link: '/api/types/chat' },
            { text: 'ActivityPub Types', link: '/api/types/activitypub' },
            { text: 'User Types', link: '/api/types/user' }
          ]
        }
      ],
      
      '/components/': [
        {
          text: 'Overview',
          items: [
            { text: 'Component Library', link: '/components/' }
          ]
        },
        {
          text: 'Core Components',
          collapsed: true,
          items: [
            { text: 'Main Navigation', link: '/components/core/main-navigation' },
            { text: 'Sidebar Component', link: '/components/core/sidebar' },
            { text: 'Content Header', link: '/components/core/content-header' }
          ]
        },
        {
          text: 'Chat Components',
          collapsed: true,
          items: [
            { text: 'Chat Component', link: '/components/chat/chat-component' },
            { text: 'Message Display', link: '/components/chat/message-display' },
            { text: 'Message Input', link: '/components/chat/message-input' },
            { text: 'Message Content', link: '/components/chat/message-content' },
            { text: 'Message Reactions', link: '/components/chat/message-reactions' },
            { text: 'Rich Text Editor', link: '/components/chat/rich-text-editor' }
          ]
        },
        {
          text: 'Server Management',
          collapsed: true,
          items: [
            { text: 'Server Sidebar', link: '/components/server/server-sidebar' },
            { text: 'Channel Sidebar', link: '/components/server/channel-sidebar' },
            { text: 'Create Server', link: '/components/server/create-server' },
            { text: 'Create Channel', link: '/components/server/create-channel' },
            { text: 'Server Dropdown', link: '/components/server/server-dropdown' }
          ]
        },
        {
          text: 'User Interface',
          collapsed: true,
          items: [
            { text: 'User Profile', link: '/components/user/user-profile' },
            { text: 'User Profile Modal', link: '/components/user/user-profile-modal' },
            { text: 'Auth Component', link: '/components/user/auth-component' },
            { text: 'User Sidebar', link: '/components/user/user-sidebar' }
          ]
        },
        {
          text: 'Media & Content',
          collapsed: true,
          items: [
            { text: 'Emoji UI', link: '/components/media/emoji-ui' },
            { text: 'File Preview', link: '/components/media/file-preview' },
            { text: 'GIF Component', link: '/components/media/gif-component' },
            { text: 'Markdown Content', link: '/components/media/markdown-content' }
          ]
        },
        {
          text: 'Modals & Dialogs',
          collapsed: true,
          items: [
            { text: 'Confirmation Modal', link: '/components/modals/confirmation-modal' },
            { text: 'Invite Modal', link: '/components/modals/invite-modal' },
            { text: 'Context Menus', link: '/components/modals/context-menus' }
          ]
        }
      ],
      
      '/flows/': [
        {
          text: 'System Flows',
          items: [
            { text: 'Architecture Overview', link: '/flows/' },
            { text: 'Authentication Flow', link: '/flows/auth' },
            { text: 'Chat Message Flow', link: '/flows/chat' },
            { text: 'Federation Flow', link: '/flows/federation' },
            { text: 'Real-time Updates', link: '/flows/realtime' }
          ]
        }
      ]
    },
    
    socialLinks: [
      { icon: 'github', link: 'https://github.com/your-org/harmony' }
    ],
    
    editLink: {
      pattern: 'https://github.com/your-org/harmony/edit/main/docs/:path',
      text: 'Edit this page on GitHub'
    },
    
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025 Harmony Team'
    },
    
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: {
                buttonText: 'Search',
                buttonAriaLabel: 'Search'
              },
              modal: {
                noResultsText: 'No results for',
                resetButtonTitle: 'Clear query',
                footer: {
                  selectText: 'select',
                  navigateText: 'navigate'
                }
              }
            }
          }
        }
      }
    }
  },
  
  markdown: {
    lineNumbers: true,
    theme: {
      light: 'github-light',
      dark: 'github-dark'
    }
  },
  
  vite: {
    server: {
      host: true,
      port: 3001
    }
  }
}))
