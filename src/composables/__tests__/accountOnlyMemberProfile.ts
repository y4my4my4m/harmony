/**
 * Test double for '@/composables/useMemberProfile' in suites that already mock useUserData:
 * resolves every member from the mocked account getters, so the server id is ignored.
 * Use: vi.mock('@/composables/useMemberProfile', () => import('@/composables/__tests__/accountOnlyMemberProfile'))
 */
import { ref } from 'vue'
import { useUserData } from '@/composables/useUserData'

type Getter = (userId: string) => { value: unknown }
const account = (name: string, empty: unknown) => (userId: string) => {
  const getter = (useUserData() as unknown as Record<string, Getter | undefined>)[name]
  return getter ? getter(userId) : ref(empty)
}

export const getMemberDisplayName = account('getUserDisplayName', '')
export const getMemberAvatarUrl = account('getUserAvatarUrl', '')
export const getMemberBannerUrl = account('getUserBannerUrl', null)
export const getMemberBio = account('getUserBio', null)
export const getMemberPronouns = account('getUserPronouns', null)
export const getMemberServerProfile = () => ref(null)
