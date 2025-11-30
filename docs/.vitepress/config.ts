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
          text: 'Overview',
          items: [
            { text: 'API Reference', link: '/api/' }
          ]
        },
        {
                'text': 'Vue Composables',
                'collapsed': true,
                'items': [
                        {
                                'text': 'Useactivitypubusersearch',
                                'link': '/api/composables/useactivitypubusersearch'
                        },
                        {
                                'text': 'Useapplicationstate',
                                'link': '/api/composables/useapplicationstate'
                        },
                        {
                                'text': 'Useaudiothemecommon',
                                'link': '/api/composables/useaudiothemecommon'
                        },
                        {
                                'text': 'Useautosuggest',
                                'link': '/api/composables/useautosuggest'
                        },
                        {
                                'text': 'Usechannelpermissions',
                                'link': '/api/composables/usechannelpermissions'
                        },
                        {
                                'text': 'Usecleanuserstatus',
                                'link': '/api/composables/usecleanuserstatus'
                        },
                        {
                                'text': 'Usecommonui',
                                'link': '/api/composables/usecommonui'
                        },
                        {
                                'text': 'Usedebounce',
                                'link': '/api/composables/usedebounce'
                        },
                        {
                                'text': 'Uselayoutstate',
                                'link': '/api/composables/uselayoutstate'
                        },
                        {
                                'text': 'Usemessagereactions',
                                'link': '/api/composables/usemessagereactions'
                        },
                        {
                                'text': 'Usemobilegestures',
                                'link': '/api/composables/usemobilegestures'
                        },
                        {
                                'text': 'Usepopuppositioning',
                                'link': '/api/composables/usepopuppositioning'
                        },
                        {
                                'text': 'Usepostinteractions',
                                'link': '/api/composables/usepostinteractions'
                        },
                        {
                                'text': 'Useprofilepresence',
                                'link': '/api/composables/useprofilepresence'
                        },
                        {
                                'text': 'Useserverpermissions',
                                'link': '/api/composables/useserverpermissions'
                        },
                        {
                                'text': 'Useuserdata',
                                'link': '/api/composables/useuserdata'
                        },
                        {
                                'text': 'Useuserstate',
                                'link': '/api/composables/useuserstate'
                        }
                ]
        },
        {
                'text': 'Configuration',
                'collapsed': true,
                'items': [
                        {
                                'text': 'Activitypub',
                                'link': '/api/config/activitypub'
                        }
                ]
        },
        {
                'text': 'Directives',
                'collapsed': true,
                'items': [
                        {
                                'text': 'Clickoutsidedirective',
                                'link': '/api/directives/clickoutsidedirective'
                        }
                ]
        },
        {
                'text': 'Router',
                'collapsed': true,
                'items': [
                        {
                                'text': 'Index',
                                'link': '/api/router/index'
                        }
                ]
        },
        {
                'text': 'Core Services',
                'collapsed': true,
                'items': [
                        {
                                'text': 'Activitypubservice',
                                'link': '/api/services/activitypubservice'
                        },
                        {
                                'text': 'Activitytracker',
                                'link': '/api/services/activitytracker'
                        },
                        {
                                'text': 'Adminservice',
                                'link': '/api/services/adminservice'
                        },
                        {
                                'text': 'Audiothemeservice',
                                'link': '/api/services/audiothemeservice'
                        },
                        {
                                'text': 'Auth',
                                'link': '/api/services/auth'
                        },
                        {
                                'text': 'Conversationservice',
                                'link': '/api/services/conversationservice'
                        },
                        {
                                'text': 'Emojiservice',
                                'link': '/api/services/emojiservice'
                        },
                        {
                                'text': 'Fileservice',
                                'link': '/api/services/fileservice'
                        },
                        {
                                'text': 'Inviteservice',
                                'link': '/api/services/inviteservice'
                        },
                        {
                                'text': 'Membershipservice',
                                'link': '/api/services/membershipservice'
                        },
                        {
                                'text': 'Notificationformatter',
                                'link': '/api/services/notificationformatter'
                        },
                        {
                                'text': 'Permissionsservice',
                                'link': '/api/services/permissionsservice'
                        },
                        {
                                'text': 'Profileservice',
                                'link': '/api/services/profileservice'
                        },
                        {
                                'text': 'Pwamanager',
                                'link': '/api/services/pwamanager'
                        },
                        {
                                'text': 'Servermembershipservice',
                                'link': '/api/services/servermembershipservice'
                        },
                        {
                                'text': 'Serviceworkermanager',
                                'link': '/api/services/serviceworkermanager'
                        },
                        {
                                'text': 'Spatialaudio',
                                'link': '/api/services/spatialaudio'
                        },
                        {
                                'text': 'Statepersistence',
                                'link': '/api/services/statepersistence'
                        },
                        {
                                'text': 'Statuslifecycledebugger',
                                'link': '/api/services/statuslifecycledebugger'
                        },
                        {
                                'text': 'Trendingservice',
                                'link': '/api/services/trendingservice'
                        },
                        {
                                'text': 'Unifiedwebrtc',
                                'link': '/api/services/unifiedwebrtc'
                        },
                        {
                                'text': 'Userdataservice',
                                'link': '/api/services/userdataservice'
                        },
                        {
                                'text': 'Usersservice',
                                'link': '/api/services/usersservice'
                        },
                        {
                                'text': 'Viewcontexttracker',
                                'link': '/api/services/viewcontexttracker'
                        }
                ]
        },
        {
                'text': 'Pinia Stores',
                'collapsed': true,
                'items': [
                        {
                                'text': 'Auth',
                                'link': '/api/stores/auth'
                        },
                        {
                                'text': 'Server',
                                'link': '/api/stores/server'
                        },
                        {
                                'text': 'Spatialaudio',
                                'link': '/api/stores/spatialaudio'
                        },
                        {
                                'text': 'Unifiedvoicechannel',
                                'link': '/api/stores/unifiedvoicechannel'
                        },
                        {
                                'text': 'Useactivitypub',
                                'link': '/api/stores/useactivitypub'
                        },
                        {
                                'text': 'Usechat',
                                'link': '/api/stores/usechat'
                        },
                        {
                                'text': 'Usedm',
                                'link': '/api/stores/usedm'
                        },
                        {
                                'text': 'Useemojicache',
                                'link': '/api/stores/useemojicache'
                        },
                        {
                                'text': 'Usenotification',
                                'link': '/api/stores/usenotification'
                        },
                        {
                                'text': 'Useprofile',
                                'link': '/api/stores/useprofile'
                        },
                        {
                                'text': 'Usepublicservers',
                                'link': '/api/stores/usepublicservers'
                        },
                        {
                                'text': 'Usereactions',
                                'link': '/api/stores/usereactions'
                        },
                        {
                                'text': 'Useserverchannel',
                                'link': '/api/stores/useserverchannel'
                        },
                        {
                                'text': 'Useserverusers',
                                'link': '/api/stores/useserverusers'
                        },
                        {
                                'text': 'Usetheme',
                                'link': '/api/stores/usetheme'
                        }
                ]
        },
        {
                'text': 'Types & Interfaces',
                'collapsed': true,
                'items': [
                        {
                                'text': 'Viewtypes',
                                'link': '/api/types/viewtypes'
                        }
                ]
        },
        {
                'text': 'Utilities',
                'collapsed': true,
                'items': [
                        {
                                'text': 'Avatarutils',
                                'link': '/api/utils/avatarutils'
                        },
                        {
                                'text': 'Emojiutils',
                                'link': '/api/utils/emojiutils'
                        },
                        {
                                'text': 'Fileupload',
                                'link': '/api/utils/fileupload'
                        },
                        {
                                'text': 'Getfromuser',
                                'link': '/api/utils/getfromuser'
                        },
                        {
                                'text': 'Hapticfeedback',
                                'link': '/api/utils/hapticfeedback'
                        },
                        {
                                'text': 'Markdownparser',
                                'link': '/api/utils/markdownparser'
                        },
                        {
                                'text': 'Markdownrenderer',
                                'link': '/api/utils/markdownrenderer'
                        },
                        {
                                'text': 'Mentionmigration',
                                'link': '/api/utils/mentionmigration'
                        },
                        {
                                'text': 'Mentionutils',
                                'link': '/api/utils/mentionutils'
                        },
                        {
                                'text': 'Messagecontentutils',
                                'link': '/api/utils/messagecontentutils'
                        },
                        {
                                'text': 'Messageparser',
                                'link': '/api/utils/messageparser'
                        },
                        {
                                'text': 'Reactioncachemanager',
                                'link': '/api/utils/reactioncachemanager'
                        },
                        {
                                'text': 'Serverutils',
                                'link': '/api/utils/serverutils'
                        },
                        {
                                'text': 'Settingsutils',
                                'link': '/api/utils/settingsutils'
                        },
                        {
                                'text': 'Syntaxhighlighter',
                                'link': '/api/utils/syntaxhighlighter'
                        },
                        {
                                'text': 'Unifiedcontentprocessing',
                                'link': '/api/utils/unifiedcontentprocessing'
                        }
                ]
        }

      ],
      
      '/components/': [
        {
          text: 'Overview',
          items: [
            { text: 'Component Library', link: '/components/' }
          ]
        }
,
        {
          text: 'Core Components',
          collapsed: true,
          items: [
            { text: 'Dmsidebar', link: '/components/dmsidebar' },
            { text: 'Maincontentareaheader', link: '/components/maincontentareaheader' },
            { text: 'Mainnavigation', link: '/components/mainnavigation' },
            { text: 'Sidebarcomponent', link: '/components/sidebarcomponent' }
          ]
        }
,
        {
          text: 'Chat Components',
          collapsed: true,
          items: [
            { text: 'Chatcomponent', link: '/components/chatcomponent' },
            { text: 'Messagecontent', link: '/components/messagecontent' },
            { text: 'Messagedisplay', link: '/components/messagedisplay' },
            { text: 'Messageinput', link: '/components/messageinput' },
            { text: 'Messagereactions', link: '/components/messagereactions' },
            { text: 'Messagereply', link: '/components/messagereply' },
            { text: 'Richtexteditor', link: '/components/richtexteditor' },
            { text: 'Unifiedmessagecontent', link: '/components/unifiedmessagecontent' }
          ]
        }
,
        {
          text: 'Server Management',
          collapsed: true,
          items: [
            { text: 'Channelcontextmenu', link: '/components/channelcontextmenu' },
            { text: 'Channeleditmodal', link: '/components/channeleditmodal' },
            { text: 'Channelsidebar', link: '/components/channelsidebar' },
            { text: 'Createchannel', link: '/components/createchannel' },
            { text: 'Createserver', link: '/components/createserver' },
            { text: 'Noserverssplash', link: '/components/noserverssplash' },
            { text: 'Publicservers', link: '/components/publicservers' },
            { text: 'Serverdropdown', link: '/components/serverdropdown' },
            { text: 'Serversidebar', link: '/components/serversidebar' }
          ]
        }
,
        {
          text: 'User Interface',
          collapsed: true,
          items: [
            { text: 'Authcomponent', link: '/components/authcomponent' },
            { text: 'Userpreviewcomponent', link: '/components/userpreviewcomponent' },
            { text: 'Userprofilecomponent', link: '/components/userprofilecomponent' },
            { text: 'Userprofilemodal', link: '/components/userprofilemodal' },
            { text: 'Usersidebar', link: '/components/usersidebar' }
          ]
        }
,
        {
          text: 'Media & Content',
          collapsed: true,
          items: [
            { text: 'Emojipopup', link: '/components/emojipopup' },
            { text: 'Emojiui', link: '/components/emojiui' },
            { text: 'Filepreview', link: '/components/filepreview' },
            { text: 'Fileuploadmenu', link: '/components/fileuploadmenu' },
            { text: 'Gifcomponent', link: '/components/gifcomponent' },
            { text: 'Markdowncontent', link: '/components/markdowncontent' }
          ]
        }
,
        {
          text: 'Modals & Dialogs',
          collapsed: true,
          items: [
            { text: 'Categorycontextmenu', link: '/components/categorycontextmenu' },
            { text: 'Categoryeditmodal', link: '/components/categoryeditmodal' },
            { text: 'Confirmationmodal', link: '/components/confirmationmodal' },
            { text: 'Inviteaccept', link: '/components/inviteaccept' },
            { text: 'Invitemodal', link: '/components/invitemodal' }
          ]
        }
,
        {
          text: 'Other Components',
          collapsed: true,
          items: [
            { text: 'Autosuggest', link: '/components/autosuggest' },
            { text: 'Categorycreator', link: '/components/categorycreator' },
            { text: 'Generated-index', link: '/components/generated-index' },
            { text: 'Notificationbell', link: '/components/notificationbell' },
            { text: 'Notificationitem', link: '/components/notificationitem' },
            { text: 'Notificationtoast', link: '/components/notificationtoast' },
            { text: 'Persistentvoiceconnection', link: '/components/persistentvoiceconnection' },
            { text: 'Pwainstallbanner', link: '/components/pwainstallbanner' },
            { text: 'Pwainstallprompt', link: '/components/pwainstallprompt' },
            { text: 'Pwaupdatenotification', link: '/components/pwaupdatenotification' },
            { text: 'Spacetimegrid', link: '/components/spacetimegrid' }
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
      { icon: 'github', link: 'https://github.com/y4my4my4m/harmony' }
    ],
    
    editLink: {
      pattern: 'https://github.com/y4my4my4m/harmony/edit/main/docs/:path',
      text: 'Edit this page on GitHub'
    },
    
    footer: {
      message: 'Released under the AGPL-3.0 License.',
      copyright: 'Copyright © 2025 y4my4my4m'
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
