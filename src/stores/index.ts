import { defineStore } from 'pinia';

export const useStore = defineStore('main', {
  state: () => ({
    user: null,
    isLoggedIn: false
  }),
  actions: {
    loginUser(user: any) {
      this.user = user;
      this.isLoggedIn = true;
    },
    logoutUser() {
      this.user = null;
      this.isLoggedIn = false;
    }
  },
});
