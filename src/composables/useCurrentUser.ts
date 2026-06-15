import { computed, type ComputedRef } from 'vue';
import { useProfileStore } from '@/stores/useProfile';
import { useAuthStore } from '@/stores/auth';

/**
 * Canonical accessor for the current user's identity.
 *
 * The single most important rule in this codebase: application data
 * (messages, reactions, server/channel memberships, emoji usage, ...) is keyed
 * on `profiles.id`, NOT the Supabase auth user id. `messages.user_id`,
 * `reactions.user_id`, `emoji_usage.user_id` etc. are all FKs to
 * `public.profiles(id)`.
 *
 * Always use `profileId` to match or write that data. Reach for `authUserId`
 * only for genuine auth/session concerns (e.g. calling Supabase Auth).
 *
 * Mixing the two is the recurring Harmony footgun - it has caused reaction
 * highlights to flicker off after reconciliation and emoji-usage inserts to
 * silently fail the profiles FK. Routing every call site through here makes the
 * correct id the path of least resistance.
 */
export interface CurrentUser {
  /** `profiles.id` - the identity used for all app data. Undefined until loaded. */
  profileId: ComputedRef<string | undefined>;
  /** Supabase auth user id - for auth/session only, never for app data. */
  authUserId: ComputedRef<string | undefined>;
}

export function useCurrentUser(): CurrentUser {
  const profileStore = useProfileStore();
  const authStore = useAuthStore();

  return {
    profileId: computed(() => profileStore.profile?.id),
    authUserId: computed(() => authStore.session?.user?.id),
  };
}

/**
 * Non-reactive current profile id, for use inside Pinia stores / services where
 * a computed ref isn't ergonomic. Returns undefined if the profile isn't loaded.
 */
export function getCurrentProfileId(): string | undefined {
  return useProfileStore().profile?.id;
}
