import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  title: 'Harmony Documentation',
  description: 'Federated Social Platform with Chat - Complete Developer Guide',
  base: '/',
  
  // Fail build on broken internal links; allow localhost (e.g. example URLs in prose)
  ignoreDeadLinks: 'localhostLinks',
  
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/logo.png' }],
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
      { text: 'Bot API', link: '/bot-api' },
      { text: 'Plugins', link: '/plugins/' },
      { text: 'API Reference', link: '/api/' },
      { text: 'Components', link: '/components/' },
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
      
      '/bot-api': [
        {
          text: 'Bot API',
          items: [
            { text: 'API Reference', link: '/bot-api' },
            { text: 'Gateway Setup', link: '/BOT_GATEWAY_SETUP' }
          ]
        }
      ],

      '/plugins/': [
        {
          text: 'Plugins',
          items: [
            { text: 'Plugin System', link: '/plugins/' },
            { text: 'Discord Bridge', link: '/plugins/discord-bridge' }
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
          text: 'Vue Composables',
          collapsed: true,
          items: [
            { text: 'Useactivitypubusersearch', link: '/api/composables/useactivitypubusersearch' },
            { text: 'Useadaptivegrid', link: '/api/composables/useadaptivegrid' },
            { text: 'Useapplicationstate', link: '/api/composables/useapplicationstate' },
            { text: 'Useaudiothemecommon', link: '/api/composables/useaudiothemecommon' },
            { text: 'Useautosuggest', link: '/api/composables/useautosuggest' },
            { text: 'Usechannelpermissions', link: '/api/composables/usechannelpermissions' },
            { text: 'Usecleanuserstatus', link: '/api/composables/usecleanuserstatus' },
            { text: 'Usecommonui', link: '/api/composables/usecommonui' },
            { text: 'Usecomposeractions', link: '/api/composables/usecomposeractions' },
            { text: 'Usecomposerstate', link: '/api/composables/usecomposerstate' },
            { text: 'Usecontentrenderer', link: '/api/composables/usecontentrenderer' },
            { text: 'Usedebounce', link: '/api/composables/usedebounce' },
            { text: 'Useemojiloader', link: '/api/composables/useemojiloader' },
            { text: 'Usefloatingvideo', link: '/api/composables/usefloatingvideo' },
            { text: 'Usefrequentemojis', link: '/api/composables/usefrequentemojis' },
            { text: 'Usehapticsettings', link: '/api/composables/usehapticsettings' },
            { text: 'Usekeybinds', link: '/api/composables/usekeybinds' },
            { text: 'Usekonamicode', link: '/api/composables/usekonamicode' },
            { text: 'Uselayoutstate', link: '/api/composables/uselayoutstate' },
            { text: 'Useloadingstate', link: '/api/composables/useloadingstate' },
            { text: 'Uselocalmessagesearch', link: '/api/composables/uselocalmessagesearch' },
            { text: 'Usemessagereactions', link: '/api/composables/usemessagereactions' },
            { text: 'Usemessagesearch', link: '/api/composables/usemessagesearch' },
            { text: 'Usemobilegestures', link: '/api/composables/usemobilegestures' },
            { text: 'Usepopuppositioning', link: '/api/composables/usepopuppositioning' },
            { text: 'Usepostinteractions', link: '/api/composables/usepostinteractions' },
            { text: 'Usepostreactions', link: '/api/composables/usepostreactions' },
            { text: 'Useprofilepresence', link: '/api/composables/useprofilepresence' },
            { text: 'Usepushnotifications', link: '/api/composables/usepushnotifications' },
            { text: 'Usepushtotalk', link: '/api/composables/usepushtotalk' },
            { text: 'Useserverpermissions', link: '/api/composables/useserverpermissions' },
            { text: 'Usetypingindicator', link: '/api/composables/usetypingindicator' },
            { text: 'Useunreadcounts', link: '/api/composables/useunreadcounts' },
            { text: 'Useuserdata', link: '/api/composables/useuserdata' },
            { text: 'Useuserstate', link: '/api/composables/useuserstate' },
            { text: 'Useviewcontext', link: '/api/composables/useviewcontext' },
            { text: 'Usevisualtheme', link: '/api/composables/usevisualtheme' }
          ]
        },
        {
          text: 'Configuration',
          collapsed: true,
          items: [
            { text: 'Activitypub', link: '/api/config/activitypub' }
          ]
        },
        {
          text: 'Directives',
          collapsed: true,
          items: [
            { text: 'Clickoutsidedirective', link: '/api/directives/clickoutsidedirective' }
          ]
        },
        {
          text: 'Layouts',
          collapsed: true,
          items: [
            { text: 'Authlayout', link: '/api/layouts/authlayout' },
            { text: 'Baselayout', link: '/api/layouts/baselayout' },
            { text: 'Chatlayout', link: '/api/layouts/chatlayout' },
            { text: 'Sociallayout', link: '/api/layouts/sociallayout' }
          ]
        },
        {
          text: 'Services',
          collapsed: true,
          items: [
            { text: 'Activitypubservice', link: '/api/services/activitypubservice' },
            { text: 'Activitytracker', link: '/api/services/activitytracker' },
            { text: 'Adminservice', link: '/api/services/adminservice' },
            { text: 'Appinitservice', link: '/api/services/appinitservice' },
            { text: 'Audiothemeservice', link: '/api/services/audiothemeservice' },
            { text: 'Auth', link: '/api/services/auth' },
            { text: 'Authcontextservice', link: '/api/services/authcontextservice' },
            { text: 'Conversationservice', link: '/api/services/conversationservice' },
            { text: 'Dmcallpermissions', link: '/api/services/dmcallpermissions' },
            { text: 'Dmcallsignaling', link: '/api/services/dmcallsignaling' },
            { text: 'Eastereggservice', link: '/api/services/eastereggservice' },
            { text: 'Emojiindexeddbcache', link: '/api/services/emojiindexeddbcache' },
            { text: 'Emojipackservice', link: '/api/services/emojipackservice' },
            { text: 'Emojiservice', link: '/api/services/emojiservice' },
            { text: 'Fileservice', link: '/api/services/fileservice' },
            { text: 'Gifservice', link: '/api/services/gifservice' },
            { text: 'Globaldmcalllistener', link: '/api/services/globaldmcalllistener' },
            { text: 'Interactionservice', link: '/api/services/interactionservice' },
            { text: 'Inviteservice', link: '/api/services/inviteservice' },
            { text: 'Livekitwebrtc', link: '/api/services/livekitwebrtc' },
            { text: 'Loggingservice', link: '/api/services/loggingservice' },
            { text: 'Membershipservice', link: '/api/services/membershipservice' },
            { text: 'Messageservice', link: '/api/services/messageservice' },
            { text: 'Notificationformatter', link: '/api/services/notificationformatter' },
            { text: 'Notificationservice', link: '/api/services/notificationservice' },
            { text: 'Permissionsservice', link: '/api/services/permissionsservice' },
            { text: 'Postservice', link: '/api/services/postservice' },
            { text: 'Profileservice', link: '/api/services/profileservice' },
            { text: 'Pwamanager', link: '/api/services/pwamanager' },
            { text: 'Realtimeconnectionmanager', link: '/api/services/realtimeconnectionmanager' },
            { text: 'Roleservice', link: '/api/services/roleservice' },
            { text: 'Routeawareinitialization', link: '/api/services/routeawareinitialization' },
            { text: 'Searchservice', link: '/api/services/searchservice' },
            { text: 'Servermembershipservice', link: '/api/services/servermembershipservice' },
            { text: 'Serviceworkermanager', link: '/api/services/serviceworkermanager' },
            { text: 'Sessionheartbeat', link: '/api/services/sessionheartbeat' },
            { text: 'Spatialaudio', link: '/api/services/spatialaudio' },
            { text: 'Statepersistence', link: '/api/services/statepersistence' },
            { text: 'Statuslifecycledebugger', link: '/api/services/statuslifecycledebugger' },
            { text: 'Threadservice', link: '/api/services/threadservice' },
            { text: 'Trendingservice', link: '/api/services/trendingservice' },
            { text: 'Typingindicatorservice', link: '/api/services/typingindicatorservice' },
            { text: 'Unifiedemojiservice', link: '/api/services/unifiedemojiservice' },
            { text: 'Unifiedwebrtc', link: '/api/services/unifiedwebrtc' },
            { text: 'Userdataservice', link: '/api/services/userdataservice' },
            { text: 'Usersservice', link: '/api/services/usersservice' },
            { text: 'Viewcontexttracker', link: '/api/services/viewcontexttracker' },
            { text: 'Voicesettingsservice', link: '/api/services/voicesettingsservice' },
            { text: 'Webrtcmanager', link: '/api/services/webrtcmanager' },
            {
              text: 'Core Services',
              collapsed: true,
              items: [
                { text: 'Coreinteractionservice', link: '/api/services/core/coreinteractionservice' },
                { text: 'Coremessageservice', link: '/api/services/core/coremessageservice' },
                { text: 'Corepostservice', link: '/api/services/core/corepostservice' },
                { text: 'Coreprofileservice', link: '/api/services/core/coreprofileservice' }
              ]
            },
            {
              text: 'Encryption Services',
              collapsed: true,
              items: [
                { text: 'Encryptionkeystore', link: '/api/services/encryption/encryptionkeystore' },
                { text: 'Encryptionkeystorebrowser', link: '/api/services/encryption/encryptionkeystorebrowser' },
                { text: 'Megolmkeybackupservice', link: '/api/services/encryption/megolmkeybackupservice' },
                { text: 'Megolmmessageencryptionservice', link: '/api/services/encryption/megolmmessageencryptionservice' },
                { text: 'Megolmservice', link: '/api/services/encryption/megolmservice' },
                { text: 'Messageencryptionservice', link: '/api/services/encryption/messageencryptionservice' },
                { text: 'Recoverykeyservice', link: '/api/services/encryption/recoverykeyservice' },
                { text: 'Securesessionkeystore', link: '/api/services/encryption/securesessionkeystore' },
                { text: 'Signalprotocolservice', link: '/api/services/encryption/signalprotocolservice' },
                { text: 'Signalprotocolservicebrowser', link: '/api/services/encryption/signalprotocolservicebrowser' },
                { text: 'Webrtcencryptionservice', link: '/api/services/encryption/webrtcencryptionservice' }
              ]
            },
            {
              text: 'Federation Services',
              collapsed: true,
              items: [
                { text: 'Federationactivityservice', link: '/api/services/federation/federationactivityservice' },
                { text: 'Federationdecisionservice', link: '/api/services/federation/federationdecisionservice' },
                { text: 'Federationserverservice', link: '/api/services/federation/federationserverservice' }
              ]
            }
          ]
        },
        {
          text: 'Pinia Stores',
          collapsed: true,
          items: [
            { text: 'Auth', link: '/api/stores/auth' },
            { text: 'Postreactions', link: '/api/stores/postreactions' },
            { text: 'Server', link: '/api/stores/server' },
            { text: 'Spatialaudio', link: '/api/stores/spatialaudio' },
            { text: 'Unifiedvoicechannel', link: '/api/stores/unifiedvoicechannel' },
            { text: 'Useactivitypub', link: '/api/stores/useactivitypub' },
            { text: 'Usechat', link: '/api/stores/usechat' },
            { text: 'Usedm', link: '/api/stores/usedm' },
            { text: 'Useemojicache', link: '/api/stores/useemojicache' },
            { text: 'Useinstancesettings', link: '/api/stores/useinstancesettings' },
            { text: 'Usenotification', link: '/api/stores/usenotification' },
            { text: 'Useprofile', link: '/api/stores/useprofile' },
            { text: 'Usepublicservers', link: '/api/stores/usepublicservers' },
            { text: 'Usereactions', link: '/api/stores/usereactions' },
            { text: 'Useserverchannel', link: '/api/stores/useserverchannel' },
            { text: 'Useserverusers', link: '/api/stores/useserverusers' },
            { text: 'Usetheme', link: '/api/stores/usetheme' }
          ]
        },
        {
          text: 'Types & Interfaces',
          collapsed: true,
          items: [
            { text: 'Viewtypes', link: '/api/types/viewtypes' }
          ]
        },
        {
          text: 'Utilities',
          collapsed: true,
          items: [
            { text: 'Avatarutils', link: '/api/utils/avatarutils' },
            { text: 'Backgroundutils', link: '/api/utils/backgroundutils' },
            { text: 'Bannerutils', link: '/api/utils/bannerutils' },
            { text: 'Botutils', link: '/api/utils/botutils' },
            { text: 'Colorutils', link: '/api/utils/colorutils' },
            { text: 'Debug', link: '/api/utils/debug' },
            { text: 'Embeddetection', link: '/api/utils/embeddetection' },
            { text: 'Emojiconstants', link: '/api/utils/emojiconstants' },
            { text: 'Emojiutils', link: '/api/utils/emojiutils' },
            { text: 'Fileupload', link: '/api/utils/fileupload' },
            { text: 'Getfromuser', link: '/api/utils/getfromuser' },
            { text: 'Groupiconutils', link: '/api/utils/groupiconutils' },
            { text: 'Hapticfeedback', link: '/api/utils/hapticfeedback' },
            { text: 'Markdownparser', link: '/api/utils/markdownparser' },
            { text: 'Markdownrenderer', link: '/api/utils/markdownrenderer' },
            { text: 'Mentionmigration', link: '/api/utils/mentionmigration' },
            { text: 'Mentionutils', link: '/api/utils/mentionutils' },
            { text: 'Messagecontentutils', link: '/api/utils/messagecontentutils' },
            { text: 'Messagedecryption', link: '/api/utils/messagedecryption' },
            { text: 'Messageembedutils', link: '/api/utils/messageembedutils' },
            { text: 'Messageparser', link: '/api/utils/messageparser' },
            { text: 'Notfoundutils', link: '/api/utils/notfoundutils' },
            { text: 'Reactioncachemanager', link: '/api/utils/reactioncachemanager' },
            { text: 'Requestdeduplicator', link: '/api/utils/requestdeduplicator' },
            { text: 'Serverutils', link: '/api/utils/serverutils' },
            { text: 'Settingsutils', link: '/api/utils/settingsutils' },
            { text: 'Syntaxhighlighter', link: '/api/utils/syntaxhighlighter' },
            { text: 'Unifiedcontentprocessing', link: '/api/utils/unifiedcontentprocessing' },
            { text: 'Urltrackerstripper', link: '/api/utils/urltrackerstripper' },
            { text: 'Userscopedstorage', link: '/api/utils/userscopedstorage' }
          ]
        },
        {
          text: 'Views',
          collapsed: true,
          items: [
            { text: 'Adminpanel', link: '/api/views/adminpanel' },
            { text: 'Authcallbackview', link: '/api/views/authcallbackview' },
            { text: 'Bookmarksview', link: '/api/views/bookmarksview' },
            { text: 'Chatview', link: '/api/views/chatview' },
            { text: 'Dmview', link: '/api/views/dmview' },
            { text: 'Exploreview', link: '/api/views/exploreview' },
            { text: 'Followersview', link: '/api/views/followersview' },
            { text: 'Hashtagview', link: '/api/views/hashtagview' },
            { text: 'Listsview', link: '/api/views/listsview' },
            { text: 'Loginview', link: '/api/views/loginview' },
            { text: 'Newprofile', link: '/api/views/newprofile' },
            { text: 'Notfoundview', link: '/api/views/notfoundview' },
            { text: 'Notificationsview', link: '/api/views/notificationsview' },
            { text: 'Postview', link: '/api/views/postview' },
            { text: 'Registerview', link: '/api/views/registerview' },
            { text: 'Resetpasswordview', link: '/api/views/resetpasswordview' },
            { text: 'Serversettings', link: '/api/views/serversettings' },
            { text: 'Threadfullview', link: '/api/views/threadfullview' },
            { text: 'Timelineview', link: '/api/views/timelineview' },
            { text: 'Userprofileview', link: '/api/views/userprofileview' },
            { text: 'Usersettings', link: '/api/views/usersettings' }
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
            { text: 'Dmheader', link: '/components/dm/dmheader' },
            { text: 'Dmsidebar', link: '/components/dmsidebar' },
            { text: 'Main Navigation', link: '/components/core/main-navigation' },
            { text: 'Maincontentareaheader', link: '/components/maincontentareaheader' },
            { text: 'Mainnavigation', link: '/components/mainnavigation' },
            { text: 'Sidebarcomponent', link: '/components/sidebarcomponent' },
            { text: 'Threadsidebar', link: '/components/threads/threadsidebar' },
            { text: 'Viewheader', link: '/components/common/viewheader' }
          ]
        },
        {
          text: 'Chat Components',
          collapsed: true,
          items: [
            { text: 'Chat Component', link: '/components/chat/chat-component' },
            { text: 'Chatbubble', link: '/components/icons/chatbubble' },
            { text: 'Chatcomponent', link: '/components/chatcomponent' },
            { text: 'Chatheader', link: '/components/chat/chatheader' },
            { text: 'Groupchatinvitemodal', link: '/components/dm/groupchatinvitemodal' },
            { text: 'Messagecontent', link: '/components/messagecontent' },
            { text: 'Messagecontextmenu', link: '/components/messagecontextmenu' },
            { text: 'Messagedisplay', link: '/components/messagedisplay' },
            { text: 'Messageinput', link: '/components/messageinput' },
            { text: 'Messagereactions', link: '/components/messagereactions' },
            { text: 'Messagereply', link: '/components/messagereply' },
            { text: 'Messagesearchmodal', link: '/components/search/messagesearchmodal' },
            { text: 'Pinnedmessagespopup', link: '/components/pinnedmessagespopup' },
            { text: 'Richtextdemo', link: '/components/demo/richtextdemo' },
            { text: 'Richtexteditor', link: '/components/richtexteditor' },
            { text: 'Unifiedmessagecontent', link: '/components/unifiedmessagecontent' }
          ]
        },
        {
          text: 'Server Management',
          collapsed: true,
          items: [
            { text: 'Adaptivechannelsidebar', link: '/components/common/adaptivechannelsidebar' },
            { text: 'Channelcontextmenu', link: '/components/channelcontextmenu' },
            { text: 'Channeleditmodal', link: '/components/channeleditmodal' },
            { text: 'Channelsidebar', link: '/components/channelsidebar' },
            { text: 'Createchannel', link: '/components/createchannel' },
            { text: 'Createserver', link: '/components/createserver' },
            { text: 'Joinfederatedserver', link: '/components/joinfederatedserver' },
            { text: 'Noserverssplash', link: '/components/noserverssplash' },
            { text: 'Publicservers', link: '/components/publicservers' },
            { text: 'Publicserverscontent', link: '/components/publicservers/publicserverscontent' },
            { text: 'Publicserversfooter', link: '/components/publicservers/publicserversfooter' },
            { text: 'Publicserversheader', link: '/components/publicservers/publicserversheader' },
            { text: 'Publicserverssearch', link: '/components/publicservers/publicserverssearch' },
            { text: 'Servercard', link: '/components/common/servercard' },
            { text: 'Servercardskeleton', link: '/components/common/servercardskeleton' },
            { text: 'Serverdropdown', link: '/components/serverdropdown' },
            { text: 'Serverfolder', link: '/components/serverfolder' },
            { text: 'Serverfoldercontextmenu', link: '/components/serverfoldercontextmenu' },
            { text: 'Serverfoldersettingsmodal', link: '/components/serverfoldersettingsmodal' },
            { text: 'Servericon', link: '/components/common/servericon' },
            { text: 'Serverinvitecard', link: '/components/embeds/serverinvitecard' },
            { text: 'Serverinviteicon', link: '/components/icons/serverinviteicon' },
            { text: 'Servernotfound', link: '/components/error/servernotfound' },
            { text: 'Serversidebar', link: '/components/serversidebar' }
          ]
        },
        {
          text: 'User Interface',
          collapsed: true,
          items: [
            { text: 'Authcomponent', link: '/components/authcomponent' },
            { text: 'Profilecard', link: '/components/common/profilecard' },
            { text: 'Unifiedprofilecard', link: '/components/common/unifiedprofilecard' },
            { text: 'User', link: '/components/icons/user' },
            { text: 'Userdatadebugpanel', link: '/components/debug/userdatadebugpanel' },
            { text: 'Userpreviewcomponent', link: '/components/userpreviewcomponent' },
            { text: 'Userprofilecomponent', link: '/components/userprofilecomponent' },
            { text: 'Userprofilemodal', link: '/components/userprofilemodal' },
            { text: 'Usersidebar', link: '/components/usersidebar' }
          ]
        },
        {
          text: 'Media & Content',
          collapsed: true,
          items: [
            { text: 'Emojiicon', link: '/components/icons/emojiicon' },
            { text: 'Emojiimporter', link: '/components/admin/emojiimporter' },
            { text: 'Emojipickercontent', link: '/components/emojipickercontent' },
            { text: 'Emojipopup', link: '/components/emojipopup' },
            { text: 'Emojiui', link: '/components/emojiui' },
            { text: 'Filepreview', link: '/components/filepreview' },
            { text: 'Fileuploadmenu', link: '/components/fileuploadmenu' },
            { text: 'Gif', link: '/components/icons/gif' },
            { text: 'Gifcomponent', link: '/components/gifcomponent' },
            { text: 'Gifpickercontent', link: '/components/gifpickercontent' },
            { text: 'Lazyemojisection', link: '/components/lazyemojisection' },
            { text: 'Markdowncontent', link: '/components/markdowncontent' },
            { text: 'Mediapickerpopup', link: '/components/mediapickerpopup' }
          ]
        },
        {
          text: 'Modals & Dialogs',
          collapsed: true,
          items: [
            { text: 'Allthreadsmodal', link: '/components/threads/allthreadsmodal' },
            { text: 'Basemodal', link: '/components/common/basemodal' },
            { text: 'Categorycontextmenu', link: '/components/categorycontextmenu' },
            { text: 'Categoryeditmodal', link: '/components/categoryeditmodal' },
            { text: 'Confirmationmodal', link: '/components/confirmationmodal' },
            { text: 'Groupsettingsmodal', link: '/components/dm/groupsettingsmodal' },
            { text: 'Incomingcallmodal', link: '/components/dm/incomingcallmodal' },
            { text: 'Inviteaccept', link: '/components/inviteaccept' },
            { text: 'Invitemodal', link: '/components/invitemodal' },
            { text: 'Keyrecoverymodal', link: '/components/encryption/keyrecoverymodal' },
            { text: 'Threadcontextmenu', link: '/components/threads/threadcontextmenu' },
            { text: 'Threadeditmodal', link: '/components/threadeditmodal' },
            { text: 'Unifiedconfirmationmodal', link: '/components/shared/unifiedconfirmationmodal' },
            { text: 'Unifiedcontextbar', link: '/components/common/unifiedcontextbar' },
            { text: 'Unifiedmodal', link: '/components/shared/unifiedmodal' }
          ]
        },
        {
          text: 'ActivityPub',
          collapsed: true,
          items: [
            { text: 'Composer', link: '/components/activitypub/composer' },
            { text: 'Emojipicker', link: '/components/activitypub/emojipicker' },
            { text: 'Explorecontent', link: '/components/activitypub/explorecontent' },
            { text: 'Inlinereplycomposer', link: '/components/activitypub/inlinereplycomposer' },
            { text: 'Instancedetailmodal', link: '/components/activitypub/instancedetailmodal' },
            { text: 'Monycomposer', link: '/components/activitypub/monycomposer' },
            { text: 'Monycomposerinline', link: '/components/activitypub/monycomposerinline' },
            { text: 'Monycontent', link: '/components/activitypub/monycontent' },
            { text: 'Monyfeed', link: '/components/activitypub/monyfeed' },
            { text: 'Monyheader', link: '/components/activitypub/monyheader' },
            { text: 'Monymediagallery', link: '/components/activitypub/monymediagallery' },
            { text: 'Monymediaupload', link: '/components/activitypub/monymediaupload' },
            { text: 'Monypost', link: '/components/activitypub/monypost' },
            { text: 'Postreactions', link: '/components/activitypub/postreactions' },
            { text: 'Threadedpost', link: '/components/activitypub/threadedpost' },
            { text: 'Usercard', link: '/components/activitypub/usercard' },
            { text: 'Usersearchmodal', link: '/components/activitypub/usersearchmodal' }
          ]
        },
        {
          text: 'Voice & Video',
          collapsed: true,
          items: [
            { text: 'Deviceselector', link: '/components/voice/deviceselector' },
            { text: 'Mobilevoicechannelpreview', link: '/components/voice/mobilevoicechannelpreview' },
            { text: 'Recentspeakers', link: '/components/voice/recentspeakers' },
            { text: 'Screensharepip', link: '/components/voice/screensharepip' },
            { text: 'Spatialaudiopanel', link: '/components/voice/spatialaudiopanel' },
            { text: 'Unifiedvoicedock', link: '/components/voice/unifiedvoicedock' },
            { text: 'Unifiedvoiceoverlay', link: '/components/voice/unifiedvoiceoverlay' },
            { text: 'Unifiedvoiceusercard', link: '/components/voice/unifiedvoiceusercard' },
            { text: 'Voicechannelparticipants', link: '/components/voice/voicechannelparticipants' },
            { text: 'Voicechanneluserlist', link: '/components/voice/voicechanneluserlist' },
            { text: 'Voicesettingspanel', link: '/components/voice/voicesettingspanel' },
            { text: 'Voiceusercontextmenu', link: '/components/voice/voiceusercontextmenu' }
          ]
        },
        {
          text: 'Settings',
          collapsed: true,
          items: [
            { text: 'Activitypubnotificationsettings', link: '/components/settings/user/activitypubnotificationsettings' },
            { text: 'Advancedsettings', link: '/components/settings/user/advancedsettings' },
            { text: 'Appearancesettings', link: '/components/settings/user/appearancesettings' },
            { text: 'Audiothememanager', link: '/components/settings/audiothememanager' },
            { text: 'Audiothemepicker', link: '/components/settings/audiothemepicker' },
            { text: 'Audiothemesettings', link: '/components/settings/user/audiothemesettings' },
            { text: 'Contentfiltersettings', link: '/components/settings/contentfiltersettings' },
            { text: 'Invitemanagement', link: '/components/settings/server/invitemanagement' },
            { text: 'Invitesettings', link: '/components/settings/server/invitesettings' },
            { text: 'Keybindsettings', link: '/components/settings/user/keybindsettings' },
            { text: 'Languagesettings', link: '/components/settings/user/languagesettings' },
            { text: 'Notificationsettings', link: '/components/settings/user/notificationsettings' },
            { text: 'Privacysettings', link: '/components/settings/user/privacysettings' },
            { text: 'Rolemanagement', link: '/components/settings/rolemanagement' },
            { text: 'Serveradvancedsettings', link: '/components/settings/serveradvancedsettings' },
            { text: 'Serverbasicinfo', link: '/components/settings/serverbasicinfo' },
            { text: 'Serverbotssettings', link: '/components/settings/serverbotssettings' },
            { text: 'Serveremojimanagement', link: '/components/settings/serveremojimanagement' },
            { text: 'Serverencryptionsettings', link: '/components/settings/serverencryptionsettings' },
            { text: 'Serverprivacysettings', link: '/components/settings/serverprivacysettings' },
            { text: 'Unifiednotificationsettings', link: '/components/settings/user/unifiednotificationsettings' },
            { text: 'Useraccountsettings', link: '/components/settings/user/useraccountsettings' },
            { text: 'Userbotsmanagement', link: '/components/settings/user/userbotsmanagement' },
            { text: 'Voicesettingsinline', link: '/components/settings/user/voicesettingsinline' },
            { text: 'Voicevideosettings', link: '/components/settings/user/voicevideosettings' }
          ]
        },
        {
          text: 'Other Components',
          collapsed: true,
          items: [
            { text: 'Accepticon', link: '/components/icons/accepticon' },
            { text: 'Arrowdown', link: '/components/icons/arrowdown' },
            { text: 'Audiothemeshowcase', link: '/components/demo/audiothemeshowcase' },
            { text: 'Autosuggest', link: '/components/autosuggest' },
            { text: 'Avatar', link: '/components/common/avatar' },
            { text: 'Base', link: '/components/layouts/base' },
            { text: 'Bell', link: '/components/icons/bell' },
            { text: 'Botmanagement', link: '/components/admin/botmanagement' },
            { text: 'Camera', link: '/components/icons/camera' },
            { text: 'Categorycreator', link: '/components/categorycreator' },
            { text: 'Check', link: '/components/icons/check' },
            { text: 'Chevrondown', link: '/components/icons/chevrondown' },
            { text: 'Close', link: '/components/icons/close' },
            { text: 'Codeblock', link: '/components/common/codeblock' },
            { text: 'Cog', link: '/components/icons/cog' },
            { text: 'Colorpicker', link: '/components/common/colorpicker' },
            { text: 'Confettieffect', link: '/components/easteregg/confettieffect' },
            { text: 'Copy', link: '/components/icons/copy' },
            { text: 'Declineicon', link: '/components/icons/declineicon' },
            { text: 'Delete', link: '/components/icons/delete' },
            { text: 'Dismissicon', link: '/components/icons/dismissicon' },
            { text: 'Dmicon', link: '/components/icons/dmicon' },
            { text: 'Edit', link: '/components/icons/edit' },
            { text: 'Encryptionindicator', link: '/components/encryption/encryptionindicator' },
            { text: 'Encryptionsettings', link: '/components/encryption/encryptionsettings' },
            { text: 'Eye', link: '/components/icons/eye' },
            { text: 'Eyeoff', link: '/components/icons/eyeoff' },
            { text: 'Followerslist', link: '/components/dm/followerslist' },
            { text: 'Globe', link: '/components/icons/globe' },
            { text: 'Groupicon', link: '/components/common/groupicon' },
            { text: 'Hashtag', link: '/components/icons/hashtag' },
            { text: 'Headphones', link: '/components/icons/headphones' },
            { text: 'Icon', link: '/components/common/icon' },
            { text: 'Jumpicon', link: '/components/icons/jumpicon' },
            { text: 'Keyboard', link: '/components/icons/keyboard' },
            { text: 'Keysetupwizard', link: '/components/encryption/keysetupwizard' },
            { text: 'Linkembedcard', link: '/components/embeds/linkembedcard' },
            { text: 'Lock', link: '/components/icons/lock' },
            { text: 'Logout', link: '/components/icons/logout' },
            { text: 'Markreadicon', link: '/components/icons/markreadicon' },
            { text: 'Mentionicon', link: '/components/icons/mentionicon' },
            { text: 'Mic', link: '/components/icons/mic' },
            { text: 'Micmuted', link: '/components/icons/micmuted' },
            { text: 'Modernbutton', link: '/components/common/modernbutton' },
            { text: 'Moderninput', link: '/components/common/moderninput' },
            { text: 'More', link: '/components/icons/more' },
            { text: 'Notfound404', link: '/components/error/notfound404' },
            { text: 'Notificationbell', link: '/components/notificationbell' },
            { text: 'Notificationitem', link: '/components/notificationitem' },
            { text: 'Notificationtoast', link: '/components/notificationtoast' },
            { text: 'Palette', link: '/components/icons/palette' },
            { text: 'Performancemonitoring', link: '/components/admin/performancemonitoring' },
            { text: 'Persistentvoiceconnection', link: '/components/persistentvoiceconnection' },
            { text: 'Plus', link: '/components/icons/plus' },
            { text: 'Postdetaildisplay', link: '/components/common/postdetaildisplay' },
            { text: 'Postscontainer', link: '/components/common/postscontainer' },
            { text: 'Providerembedswitch', link: '/components/embeds/providerembedswitch' },
            { text: 'Pushnotificationprompt', link: '/components/pushnotificationprompt' },
            { text: 'Pwainstallbanner', link: '/components/pwainstallbanner' },
            { text: 'Pwainstallprompt', link: '/components/pwainstallprompt' },
            { text: 'Pwaupdatenotification', link: '/components/pwaupdatenotification' },
            { text: 'Reaction', link: '/components/icons/reaction' },
            { text: 'Reactionicon', link: '/components/icons/reactionicon' },
            { text: 'Recoverykeysetupwizard', link: '/components/encryption/recoverykeysetupwizard' },
            { text: 'Reply', link: '/components/icons/reply' },
            { text: 'Robot', link: '/components/icons/robot' },
            { text: 'Searchinput', link: '/components/common/searchinput' },
            { text: 'Settings', link: '/components/icons/settings' },
            { text: 'Shield', link: '/components/icons/shield' },
            { text: 'Spacetimegrid', link: '/components/spacetimegrid' },
            { text: 'Speaker', link: '/components/icons/speaker' },
            { text: 'Statuspicker', link: '/components/statuspicker' },
            { text: 'Thread', link: '/components/icons/thread' },
            { text: 'Threadindicator', link: '/components/threads/threadindicator' },
            { text: 'Threadview', link: '/components/threads/threadview' },
            { text: 'Toggleswitch', link: '/components/common/toggleswitch' },
            { text: 'Trash', link: '/components/icons/trash' },
            { text: 'Typingindicator', link: '/components/typingindicator' },
            { text: 'Unifiedbutton', link: '/components/shared/unifiedbutton' },
            { text: 'Unifiedcontentarea', link: '/components/common/unifiedcontentarea' },
            { text: 'Unifiedcontentrenderer', link: '/components/unifiedcontentrenderer' },
            { text: 'Unifiedinput', link: '/components/shared/unifiedinput' },
            { text: 'Unreadicon', link: '/components/icons/unreadicon' },
            { text: 'Voiceicon', link: '/components/icons/voiceicon' }
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
      pattern: 'https://github.com/y4my4my4m/harmony/edit/master/docs/:path',
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
