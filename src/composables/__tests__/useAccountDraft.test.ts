import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Session } from '@supabase/supabase-js'
import { useAuthStore } from '@/stores/auth'
import {
  accountDirty,
  accountDraftDirty,
  mergeStored,
  resetAccountDraft,
  useAccountDraft,
  type AccountSnapshot,
} from '@/composables/useAccountDraft'

const snapshot = (values: Partial<AccountSnapshot['values']> = {}, fields: AccountSnapshot['fields'] = []): AccountSnapshot => ({
  values: { display_name: 'Sam', bio: '', color: '', ...values },
  fields,
})

beforeEach(() => {
  setActivePinia(createPinia())
  resetAccountDraft()
})

describe('accountDirty', () => {
  it('a form equal to the stored profile is clean', () => {
    expect(accountDirty(snapshot(), snapshot())).toBe(false)
  })

  it('an edited value or field list is dirty', () => {
    expect(accountDirty(snapshot({ bio: 'hi' }), snapshot())).toBe(true)
    expect(accountDirty(snapshot({}, [{ name: '', value: '' }]), snapshot())).toBe(true)
  })

  it('nothing stored yet is clean', () => {
    expect(accountDirty(snapshot({ bio: 'hi' }), null)).toBe(false)
  })
})

describe('mergeStored', () => {
  it('unedited values follow the stored profile; edited ones keep the edit', () => {
    const previous = snapshot({ display_name: 'Sam', bio: 'old bio' })
    const draft = snapshot({ display_name: 'Typed', bio: 'old bio' })
    const next = snapshot({ display_name: 'Sam', bio: 'bio from elsewhere', color: '#112233' })
    expect(mergeStored(draft, previous, next).values).toEqual({
      display_name: 'Typed',
      bio: 'bio from elsewhere',
      color: '#112233',
    })
  })

  it('the field list follows the stored profile only while unedited', () => {
    const previous = snapshot({}, [{ name: 'Site', value: 'a' }])
    const next = snapshot({}, [{ name: 'Site', value: 'b' }])
    expect(mergeStored(snapshot({}, [{ name: 'Site', value: 'a' }]), previous, next).fields).toEqual([{ name: 'Site', value: 'b' }])
    expect(mergeStored(snapshot({}, [{ name: 'Mine', value: 'x' }]), previous, next).fields).toEqual([{ name: 'Mine', value: 'x' }])
  })
})

describe('useAccountDraft', () => {
  it('an upload that changes the stored profile keeps unsaved text (settings2)', () => {
    const draft = useAccountDraft()
    draft.sync('p1', snapshot())
    draft.values.value.display_name = 'Typed before avatar'
    draft.values.value.bio = 'bio before avatar'
    draft.sync('p1', snapshot())
    expect(draft.values.value).toMatchObject({ display_name: 'Typed before avatar', bio: 'bio before avatar' })
    expect(draft.dirty.value).toBe(true)
  })

  it('a missing bio is not an edit (settings3)', () => {
    const draft = useAccountDraft()
    draft.sync('p1', snapshot({ bio: '' }))
    expect(draft.dirty.value).toBe(false)
  })

  it('outlives a remount: the next sync of the same account keeps the edit', () => {
    const first = useAccountDraft()
    first.sync('p1', snapshot())
    first.values.value.display_name = 'Kept'
    const second = useAccountDraft()
    second.sync('p1', snapshot())
    expect(second.values.value.display_name).toBe('Kept')
  })

  it('a different account starts from its own stored profile', () => {
    const draft = useAccountDraft()
    draft.sync('p1', snapshot())
    draft.values.value.display_name = 'Not yours'
    draft.sync('p2', snapshot({ display_name: 'Pam' }))
    expect(draft.values.value.display_name).toBe('Pam')
    expect(draft.dirty.value).toBe(false)
  })

  it('discard returns to the stored profile; adopt takes a saved one', () => {
    const draft = useAccountDraft()
    draft.sync('p1', snapshot())
    draft.values.value.bio = 'typed'
    draft.discard()
    expect(draft.values.value.bio).toBe('')
    draft.values.value.bio = 'saved'
    draft.fields.value = [{ name: 'Site', value: 'a & b' }]
    draft.adopt(snapshot({ bio: 'saved' }, [{ name: 'Site', value: 'a &amp; b' }]))
    expect(draft.dirty.value).toBe(false)
    expect(draft.fields.value).toEqual([{ name: 'Site', value: 'a &amp; b' }])
  })

  it('a sign-out by any path forgets the draft; a token refresh keeps it', async () => {
    const auth = useAuthStore()
    auth.session = { user: { id: 'u1' } } as Session
    const draft = useAccountDraft()
    draft.sync('p1', snapshot())
    draft.values.value.bio = 'unsaved'

    auth.session = { user: { id: 'u1' } } as Session
    await nextTick()
    expect(accountDraftDirty.value).toBe(true)

    auth.session = null
    await nextTick()
    expect(accountDraftDirty.value).toBe(false)
    expect(draft.values.value.bio).toBe('')
  })
})
