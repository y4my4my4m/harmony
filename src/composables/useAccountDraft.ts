// My account form state. Module-level: it outlives the form, so a switch to another
// Settings section, or a Back out of Settings, keeps unsaved edits.
//
// `stored` is the profile as the form last saw it. When the stored profile changes (an
// avatar or banner upload, a save), each field the user has not edited follows it and each
// edited field keeps the edit. Values are normalised: a null bio or colour is ''.
// Any sign-out (Settings, another tab, a revoked session) forgets the draft.

import { computed, effectScope, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

export interface AccountValues {
  display_name: string
  bio: string
  color: string
}

export interface EditableField {
  name: string
  value: string
}

export interface AccountSnapshot {
  values: AccountValues
  fields: EditableField[]
}

const VALUE_KEYS = ['display_name', 'bio', 'color'] as const

function copy(snapshot: AccountSnapshot): AccountSnapshot {
  return {
    values: { ...snapshot.values },
    fields: snapshot.fields.map((f) => ({ name: f.name, value: f.value })),
  }
}

const fieldsJson = (fields: EditableField[]) => JSON.stringify(fields.map((f) => [f.name, f.value]))

/** Edits in `draft` against `stored`. */
export function accountDirty(draft: AccountSnapshot, stored: AccountSnapshot | null): boolean {
  if (!stored) return false
  return (
    VALUE_KEYS.some((key) => (draft.values[key] ?? '') !== (stored.values[key] ?? '')) ||
    fieldsJson(draft.fields) !== fieldsJson(stored.fields)
  )
}

/**
 * `draft` after the stored profile moved from `previous` to `next`: values and the field
 * list equal to `previous` (not edited) take `next`'s; edited ones are kept.
 */
export function mergeStored(draft: AccountSnapshot, previous: AccountSnapshot, next: AccountSnapshot): AccountSnapshot {
  const values = { ...draft.values }
  for (const key of VALUE_KEYS) {
    if ((draft.values[key] ?? '') === (previous.values[key] ?? '')) values[key] = next.values[key]
  }
  const fields = fieldsJson(draft.fields) === fieldsJson(previous.fields) ? copy(next).fields : copy(draft).fields
  return { values, fields }
}

const owner = ref<string | null>(null)
const stored = ref<AccountSnapshot | null>(null)
const values = ref<AccountValues>({ display_name: '', bio: '', color: '' })
const fields = ref<EditableField[]>([])

const dirty = computed(() => accountDirty({ values: values.value, fields: fields.value }, stored.value))

function apply(snapshot: AccountSnapshot) {
  const next = copy(snapshot)
  values.value = next.values
  fields.value = next.fields
}

/** Takes the stored profile of `ownerId`; a draft of another account is dropped. */
function sync(ownerId: string, next: AccountSnapshot) {
  if (owner.value !== ownerId || !stored.value) {
    owner.value = ownerId
    apply(next)
  } else {
    apply(mergeStored({ values: values.value, fields: fields.value }, stored.value, next))
  }
  stored.value = copy(next)
}

/** Drops every edit: the form shows the stored profile. */
function discard() {
  if (stored.value) apply(stored.value)
}

/** Takes `next` as stored and drops every edit (after a save). */
function adopt(next: AccountSnapshot) {
  stored.value = copy(next)
  apply(next)
}

let watchedAuth: ReturnType<typeof useAuthStore> | null = null

function forgetOnSignOut() {
  const auth = useAuthStore()
  if (watchedAuth === auth) return
  watchedAuth = auth
  // Detached: the watch outlives the component that first calls useAccountDraft().
  effectScope(true).run(() => {
    watch(
      () => auth.session?.user?.id ?? null,
      (id, previous) => {
        if (previous && id !== previous) resetAccountDraft()
      },
    )
  })
}

export function useAccountDraft() {
  forgetOnSignOut()
  return { values, fields, stored, dirty, sync, discard, adopt }
}

/** Unsaved My account edits exist. */
export const accountDraftDirty = dirty

export function discardAccountDraft(): void {
  discard()
}

/** Forgets the draft and its owner (sign-out, tests). */
export function resetAccountDraft(): void {
  owner.value = null
  stored.value = null
  values.value = { display_name: '', bio: '', color: '' }
  fields.value = []
}
