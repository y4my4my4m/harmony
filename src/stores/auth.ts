import { defineStore } from 'pinia';
import { supabase } from '../supabase';
import type { Session } from '@supabase/supabase-js';

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
    async login(email, password) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      this.session = data.session;
    },
    async register(email, password) {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      this.session = data.session;
    },
    async logout() {
      await supabase.auth.signOut();
      this.session = null;
    },
  },
});
