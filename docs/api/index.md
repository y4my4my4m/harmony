# API Reference

Welcome to the Harmony API documentation. This documentation is automatically generated from the source code.

## Overview

```mermaid
graph TB
    subgraph "Frontend Architecture"
        COMPOSABLES[Composables]
        STORES[Pinia Stores]
        SERVICES[Services]
        UTILS[Utilities]
    end
    
    subgraph "UI Layer"
        VIEWS[Views]
        LAYOUTS[Layouts]
    end
    
    subgraph "Supporting"
        CONFIG[Configuration]
        TYPES[Types]
        DIRECTIVES[Directives]
        ROUTER[Router]
    end
    
    VIEWS --> COMPOSABLES
    VIEWS --> STORES
    COMPOSABLES --> SERVICES
    STORES --> SERVICES
    SERVICES --> UTILS
```

## Categories

### Services

56 files documented.

- [usersService](/api/services/usersservice)
- [userDataService](/api/services/userdataservice)
- [unifiedWebRTC](/api/services/unifiedwebrtc)
- [spatialAudio](/api/services/spatialaudio)
- [serverMembershipService](/api/services/servermembershipservice)
- [permissionsService](/api/services/permissionsservice)
- [membershipService](/api/services/membershipservice)
- [inviteService](/api/services/inviteservice)
- [index](/api/services/index)
- [fileService](/api/services/fileservice)
- [emojiService](/api/services/emojiservice)
- [activityPubService](/api/services/activitypubservice)
- [ViewContextTracker](/api/services/viewcontexttracker)
- [TrendingService](/api/services/trendingservice)
- [StatusLifecycleDebugger](/api/services/statuslifecycledebugger)
- [StatePersistence](/api/services/statepersistence)
- [SessionHeartbeat](/api/services/sessionheartbeat)
- [ServiceWorkerManager](/api/services/serviceworkermanager)
- [SearchService](/api/services/searchservice)
- [RouteAwareInitialization](/api/services/routeawareinitialization)
- [RealtimeConnectionManager](/api/services/realtimeconnectionmanager)
- [ProfileService](/api/services/profileservice)
- [PostService](/api/services/postservice)
- [PWAManager](/api/services/pwamanager)
- [NotificationService](/api/services/notificationservice)
- [NotificationFormatter](/api/services/notificationformatter)
- [MessageService](/api/services/messageservice)
- [InteractionService](/api/services/interactionservice)
- [GlobalDMCallListener](/api/services/globaldmcalllistener)
- [DMCallSignaling](/api/services/dmcallsignaling)
- [DMCallPermissions](/api/services/dmcallpermissions)
- [ConversationService](/api/services/conversationservice)
- [AuthContextService](/api/services/authcontextservice)
- [AudioThemeService](/api/services/audiothemeservice)
- [AppInitService](/api/services/appinitservice)
- [AdminService](/api/services/adminservice)
- [ActivityTracker](/api/services/activitytracker)
- [index](/api/services/federation/index)
- [FederationDecisionService](/api/services/federation/federationdecisionservice)
- [FederationActivityService](/api/services/federation/federationactivityservice)
- [index](/api/services/encryption/index)
- [WebRTCEncryptionService](/api/services/encryption/webrtcencryptionservice)
- [SignalProtocolServiceBrowser](/api/services/encryption/signalprotocolservicebrowser)
- [SignalProtocolService](/api/services/encryption/signalprotocolservice)
- [RecoveryKeyService](/api/services/encryption/recoverykeyservice)
- [MessageEncryptionService](/api/services/encryption/messageencryptionservice)
- [MegolmService](/api/services/encryption/megolmservice)
- [MegolmMessageEncryptionService](/api/services/encryption/megolmmessageencryptionservice)
- [MegolmKeyBackupService](/api/services/encryption/megolmkeybackupservice)
- [EncryptionKeyStoreBrowser](/api/services/encryption/encryptionkeystorebrowser)
- [EncryptionKeyStore](/api/services/encryption/encryptionkeystore)
- [index](/api/services/core/index)
- [CoreProfileService](/api/services/core/coreprofileservice)
- [CorePostService](/api/services/core/corepostservice)
- [CoreMessageService](/api/services/core/coremessageservice)
- [CoreInteractionService](/api/services/core/coreinteractionservice)

### Pinia Stores

16 files documented.

- [useTheme](/api/stores/usetheme)
- [useServerUsers](/api/stores/useserverusers)
- [useServerChannel](/api/stores/useserverchannel)
- [useReactions](/api/stores/usereactions)
- [usePublicServers](/api/stores/usepublicservers)
- [useProfile](/api/stores/useprofile)
- [useNotification](/api/stores/usenotification)
- [useEmojiCache](/api/stores/useemojicache)
- [useDM](/api/stores/usedm)
- [useChat](/api/stores/usechat)
- [useActivityPub](/api/stores/useactivitypub)
- [unifiedVoiceChannel](/api/stores/unifiedvoicechannel)
- [spatialAudio](/api/stores/spatialaudio)
- [server](/api/stores/server)
- [postReactions](/api/stores/postreactions)
- [auth](/api/stores/auth)

### Vue Composables

30 files documented.

- [useVisualTheme](/api/composables/usevisualtheme)
- [useViewContext](/api/composables/useviewcontext)
- [useUserState](/api/composables/useuserstate)
- [useUserData](/api/composables/useuserdata)
- [useUnreadCounts](/api/composables/useunreadcounts)
- [useServerPermissions](/api/composables/useserverpermissions)
- [usePushNotifications](/api/composables/usepushnotifications)
- [useProfilePresence](/api/composables/useprofilepresence)
- [usePostReactions](/api/composables/usepostreactions)
- [usePostInteractions](/api/composables/usepostinteractions)
- [usePopupPositioning](/api/composables/usepopuppositioning)
- [useMobileGestures](/api/composables/usemobilegestures)
- [useMessageSearch](/api/composables/usemessagesearch)
- [useMessageReactions](/api/composables/usemessagereactions)
- [useLocalMessageSearch](/api/composables/uselocalmessagesearch)
- [useLoadingState](/api/composables/useloadingstate)
- [useLayoutState](/api/composables/uselayoutstate)
- [useHapticSettings](/api/composables/usehapticsettings)
- [useFloatingVideo](/api/composables/usefloatingvideo)
- [useDebounce](/api/composables/usedebounce)
- [useContentRenderer](/api/composables/usecontentrenderer)
- [useComposerState](/api/composables/usecomposerstate)
- [useComposerActions](/api/composables/usecomposeractions)
- [useCommonUI](/api/composables/usecommonui)
- [useCleanUserStatus](/api/composables/usecleanuserstatus)
- [useChannelPermissions](/api/composables/usechannelpermissions)
- [useAutoSuggest](/api/composables/useautosuggest)
- [useAudioThemeCommon](/api/composables/useaudiothemecommon)
- [useApplicationState](/api/composables/useapplicationstate)
- [useActivityPubUserSearch](/api/composables/useactivitypubusersearch)

### Types & Interfaces

1 files documented.

- [viewTypes](/api/types/viewtypes)

### Utilities

25 files documented.

- [unifiedContentProcessing](/api/utils/unifiedcontentprocessing)
- [syntaxHighlighter](/api/utils/syntaxhighlighter)
- [settingsUtils](/api/utils/settingsutils)
- [serverUtils](/api/utils/serverutils)
- [requestDeduplicator](/api/utils/requestdeduplicator)
- [reactionCacheManager](/api/utils/reactioncachemanager)
- [notFoundUtils](/api/utils/notfoundutils)
- [messageEmbedUtils](/api/utils/messageembedutils)
- [messageDecryption](/api/utils/messagedecryption)
- [messageContentUtils](/api/utils/messagecontentutils)
- [mentionUtils](/api/utils/mentionutils)
- [mentionMigration](/api/utils/mentionmigration)
- [markdownRenderer](/api/utils/markdownrenderer)
- [markdownParser](/api/utils/markdownparser)
- [hapticFeedback](/api/utils/hapticfeedback)
- [groupIconUtils](/api/utils/groupiconutils)
- [getFromUser](/api/utils/getfromuser)
- [fileUpload](/api/utils/fileupload)
- [emojiUtils](/api/utils/emojiutils)
- [embedDetection](/api/utils/embeddetection)
- [debug](/api/utils/debug)
- [colorUtils](/api/utils/colorutils)
- [botUtils](/api/utils/botutils)
- [bannerUtils](/api/utils/bannerutils)
- [avatarUtils](/api/utils/avatarutils)

### Configuration

1 files documented.

- [activitypub](/api/config/activitypub)

### Directives

1 files documented.

- [ClickOutsideDirective](/api/directives/clickoutsidedirective)

### Layouts

4 files documented.

- [SocialLayout](/api/layouts/sociallayout)
- [ChatLayout](/api/layouts/chatlayout)
- [BaseLayout](/api/layouts/baselayout)
- [AuthLayout](/api/layouts/authlayout)

### Router

1 files documented.

- [index](/api/router/index)

### Views

19 files documented.

- [UserSettings](/api/views/usersettings)
- [UserProfileView](/api/views/userprofileview)
- [TimelineView](/api/views/timelineview)
- [ServerSettings](/api/views/serversettings)
- [ResetPasswordView](/api/views/resetpasswordview)
- [RegisterView](/api/views/registerview)
- [PostView](/api/views/postview)
- [NotificationsView](/api/views/notificationsview)
- [NotFoundView](/api/views/notfoundview)
- [NewProfile](/api/views/newprofile)
- [LoginView](/api/views/loginview)
- [ListsView](/api/views/listsview)
- [HashtagView](/api/views/hashtagview)
- [FollowersView](/api/views/followersview)
- [ExploreView](/api/views/exploreview)
- [DMView](/api/views/dmview)
- [ChatView](/api/views/chatview)
- [BookmarksView](/api/views/bookmarksview)
- [AdminPanel](/api/views/adminpanel)


---

*Last generated: 2025-11-30T08:44:43.054Z*
