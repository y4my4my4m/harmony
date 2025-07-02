import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Session } from '@supabase/supabase-js';
import { updateUserStatus } from '@/services/profileService';
import { UserStatus } from '@/types';

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

      // Set user as online when they initialize auth
      if (this.session?.user?.id) {
        await this.setUserOnline(this.session.user.id);
        this.setupOfflineHandlers(this.session.user.id);
      }

      supabase.auth.onAuthStateChange(async (_, session) => {
        const wasLoggedIn = !!this.session;
        const previousUserId = this.session?.user?.id;
        
        this.session = session;
        
        if (session?.user?.id) {
          // User logged in
          await this.setUserOnline(session.user.id);
          this.setupOfflineHandlers(session.user.id);
        } else if (wasLoggedIn && previousUserId) {
          // User logged out
          await this.setUserOffline(previousUserId);
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
      // Handle browser/tab close - keep this for immediate offline status
      const handleBeforeUnload = () => {
        // Use sendBeacon for reliable offline status update
        if (navigator.sendBeacon) {
          const url = `${supabase.supabaseUrl}/rest/v1/profiles`;
          const headers = new Headers({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabase.supabaseKey}`,
            'apikey': supabase.supabaseKey
          });
          
          // Create a proper PATCH request payload for sendBeacon
          const body = JSON.stringify({ status: UserStatus.Offline });
          const blob = new Blob([body], { type: 'application/json' });
          
          // This is a fallback - Presence will handle most cases
          try {
            navigator.sendBeacon(`${url}?id=eq.${userId}`, blob);
          } catch (error) {
            console.log('SendBeacon failed, presence will handle offline status');
          }
        }
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
      document.addEventListener('visibilitychange', handleVisibilityChange);

      // Store references for cleanup
      (window as any).__harmonyOfflineHandlers = {
        beforeunload: handleBeforeUnload,
        unload: handleBeforeUnload,
        visibilitychange: handleVisibilityChange
      };
    },

    cleanupOfflineHandlers() {
      const handlers = (window as any).__harmonyOfflineHandlers;
      if (handlers) {
        window.removeEventListener('beforeunload', handlers.beforeunload);
        window.removeEventListener('unload', handlers.unload);
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
    },
  },
});
