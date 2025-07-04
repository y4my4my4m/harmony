import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Session } from '@supabase/supabase-js';
import { updateUserStatus } from '@/services/profileService';
import { UserStatus } from '@/types';
import router from '@/router';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    session: null as Session | null,
  }),
  getters: {
    isLoggedIn: (state) => !!state.session
  },
  actions: {
    async initializeAuth() {
      const { data: getSessionData } = await supabase.auth.getSession();
      this.session = getSessionData.session;

      // Initialize notification system for existing session
      if (this.session?.user?.id) {
        await this.setUserOnline(this.session.user.id);
        this.setupOfflineHandlers(this.session.user.id);
        await this.initializeNotificationSystem(this.session.user.id);
      }

      supabase.auth.onAuthStateChange(async (_, session) => {
        const wasLoggedIn = !!this.session;
        const previousUserId = this.session?.user?.id;
        
        this.session = session;
        
        if (session?.user?.id) {
          // User logged in
          await this.setUserOnline(session.user.id);
          this.setupOfflineHandlers(session.user.id);
          await this.initializeNotificationSystem(session.user.id);
        } else if (wasLoggedIn && previousUserId) {
          // User logged out
          await this.setUserOffline(previousUserId);
          this.cleanupNotificationSystem();
        }
      });
    },

    async setUserOnline(userId: string) {
      try {
        await updateUserStatus(userId, UserStatus.Online);
        console.log('User set to online:', userId);
      } catch (error) {
        console.error('Error setting user online:', error);
      }
    },

    async setUserOffline(userId: string) {
      try {
        await updateUserStatus(userId, UserStatus.Offline);
        console.log('User set to offline:', userId);
      } catch (error) {
        console.error('Error setting user offline:', error);
      }
    },

    setupOfflineHandlers(userId: string) {
      // Clean up any existing handlers first
      this.cleanupOfflineHandlers();
      
      // Handle browser/tab close - immediate cleanup and status update
      const handleBeforeUnload = (event: BeforeUnloadEvent) => {
        // Immediately cleanup presence (this should trigger presence leave event)
        if ((window as any).__harmonyPresenceCleanup) {
          (window as any).__harmonyPresenceCleanup();
        }

        // For beforeunload, we rely primarily on the presence system cleanup
        // The presence "leave" event should automatically handle offline status for other users
        // We can't reliably do async Supabase calls here due to timing constraints
      };

      // Handle page visibility for away status
      const handleVisibilityChange = async () => {
        if (document.hidden) {
          // Set as away after 5 minutes of tab being hidden
          setTimeout(async () => {
            if (document.hidden && this.session?.user?.id) {
              await updateUserStatus(this.session.user.id, UserStatus.Away);
            }
          }, 5 * 60 * 1000);
        } else {
          // User returned to tab - set as online
          if (this.session?.user?.id) {
            await updateUserStatus(this.session.user.id, UserStatus.Online);
          }
        }
      };

      // Add event listeners
      window.addEventListener('beforeunload', handleBeforeUnload);
      window.addEventListener('unload', handleBeforeUnload);
      window.addEventListener('pagehide', handleBeforeUnload); // Additional event for mobile
      document.addEventListener('visibilitychange', handleVisibilityChange);

      // Store references for cleanup
      (window as any).__harmonyOfflineHandlers = {
        beforeunload: handleBeforeUnload,
        unload: handleBeforeUnload,
        pagehide: handleBeforeUnload,
        visibilitychange: handleVisibilityChange
      };
    },

    cleanupOfflineHandlers() {
      const handlers = (window as any).__harmonyOfflineHandlers;
      if (handlers) {
        window.removeEventListener('beforeunload', handlers.beforeunload);
        window.removeEventListener('unload', handlers.unload);
        window.removeEventListener('pagehide', handlers.pagehide);
        document.removeEventListener('visibilitychange', handlers.visibilitychange);
        delete (window as any).__harmonyOfflineHandlers;
      }
    },

    async login(email: string, password: string) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      this.session = data.session;
    },

    async register(email: string, password: string) {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      this.session = data.session;
    },

    async logout() {
      // Set user offline before logging out
      if (this.session?.user?.id) {
        await this.setUserOffline(this.session.user.id);
      }
      
      this.cleanupOfflineHandlers();
      await supabase.auth.signOut();
      this.session = null;
      
      // Redirect to login page
      router.push('/login');
    },

    /**
     * Initialize the Discord-like notification system
     */
    async initializeNotificationSystem(userId: string) {
      try {
        console.log('🔔 Initializing notification system for user:', userId);
        
        // Dynamic import to avoid circular dependencies
        const { useNotificationStore } = await import('@/stores/useNotification');
        const notificationStore = useNotificationStore();
        
        // Initialize the notification store
        await notificationStore.initialize(userId);
        
        console.log('✅ Notification system initialized successfully');
      } catch (error) {
        console.error('❌ Failed to initialize notification system:', error);
      }
    },

    /**
     * Cleanup notification system on logout
     */
    cleanupNotificationSystem() {
      try {
        console.log('🔔 Cleaning up notification system');
        
        // Dynamic import to avoid issues during cleanup
        import('@/stores/useNotification').then(({ useNotificationStore }) => {
          const notificationStore = useNotificationStore();
          
          // Clean up real-time subscriptions
          if (notificationStore.realtimeSubscription) {
            supabase.removeChannel(notificationStore.realtimeSubscription);
            notificationStore.realtimeSubscription = null;
          }
          
          // Reset state
          notificationStore.$reset();
          notificationStore.isInitialized = false;
          
          console.log('✅ Notification system cleaned up');
        }).catch(error => {
          console.error('❌ Error during notification cleanup:', error);
        });
        
        // Reset view context
        import('@/services/ViewContextTracker').then(({ viewContextTracker }) => {
          viewContextTracker.reset();
        }).catch(error => {
          console.error('❌ Error resetting view context:', error);
        });
        
      } catch (error) {
        console.error('❌ Error cleaning up notification system:', error);
      }
    },
  },
});
