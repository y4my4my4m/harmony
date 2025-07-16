import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Harmony Documentation',
  description: 'Federated Social Platform with Chat - Complete Developer Guide',
  base: '/harmony/',
  
  head: [
    ['link', { rel: 'icon', href: '/harmony/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#646cff' }]
  ],

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
          collapsible: true,
          items: [
            { text: 'Introduction', link: '/guide/' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Environment Setup', link: '/guide/environment' }
          ]
        },
        {
          text: 'Architecture',
          collapsible: true,
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
          collapsible: true,
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
          collapsible: true,
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
          collapsible: true,
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
          collapsible: true,
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
          collapsible: true,
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
          collapsible: true,
          items: [
            { text: 'Layout State', link: '/api/composables/layout' },
            { text: 'User Data', link: '/api/composables/userdata' },
            { text: 'Presence', link: '/api/composables/presence' },
            { text: 'Voice Channel', link: '/api/composables/voice' }
          ]
        },
        {
          text: 'Types & Interfaces',
          collapsible: true,
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
          text: 'Layout Components',
          collapsible: true,
          items: [
            { text: 'Base Layout', link: '/components/layouts/base' },
            { text: 'Chat Layout', link: '/components/layouts/chat' },
            { text: 'Social Layout', link: '/components/layouts/social' }
          ]
        },
        {
          text: 'Chat Components',
          collapsible: true,
          items: [
            { text: 'Message Display', link: '/components/chat/message' },
            { text: 'Message Input', link: '/components/chat/input' },
            { text: 'Channel Sidebar', link: '/components/chat/sidebar' },
            { text: 'Voice Panel', link: '/components/chat/voice' }
          ]
        },
        {
          text: 'Social Components',
          collapsible: true,
          items: [
            { text: 'Post Composer', link: '/components/social/composer' },
            { text: 'Timeline', link: '/components/social/timeline' },
            { text: 'User Card', link: '/components/social/usercard' },
            { text: 'Notification Bell', link: '/components/social/notifications' }
          ]
        },
        {
          text: 'Shared Components',
          collapsible: true,
          items: [
            { text: 'Avatar', link: '/components/shared/avatar' },
            { text: 'Modal', link: '/components/shared/modal' },
            { text: 'Button', link: '/components/shared/button' },
            { text: 'Form Controls', link: '/components/shared/forms' }
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
})
