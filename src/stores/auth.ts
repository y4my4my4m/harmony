import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Session } from '@supabase/supabase-js';
import { useProfileStore } from 'useProfile';

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

      supabase.auth.onAuthStateChange((_, session) => {
        this.session = session;
      });
    },
    async login(email: string, password: string) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      this.session = data.session;

      // Check if the profile is complete after login
      await this.checkProfileCompletion();
    },
    async register(email: string, password: string) {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      this.session = data.session;
      // Check if the profile is complete after registration
      // await this.checkProfileCompletion();
    },
    async checkProfileCompletion() {
      if (this.session?.user) {
        const profileStore = useProfileStore();
        await profileStore.fetchProfile(this.session.user.id);
        if (!profileStore.isProfileComplete) {
          // Redirect to NewProfile page if profile is not complete
          const router = useRouter();
          router.push('/new-profile');
        }
      }
    },
    async logout() {
      await supabase.auth.signOut();
      this.session = null;
    },
  },
});
