<template>
  <main class="mg-wrap" data-testid="migrate-view">
    <div class="mg-card">
      <div v-if="state === 'loading'" class="mg-muted" role="status">{{ t('discordMigration.migrate.loading') }}</div>

      <template v-else>
        <header v-if="server" class="mg-server">
          <img v-if="server.iconUrl" :src="server.iconUrl" alt="" class="mg-icon" />
          <span v-else class="mg-icon mg-icon-fallback" aria-hidden="true">{{ server.serverName.slice(0, 1).toUpperCase() }}</span>
          <h1 class="mg-title">{{ server.serverName }}</h1>
        </header>
        <h1 v-else class="mg-title">{{ t('discordMigration.migrate.title') }}</h1>

        <!-- Error -->
        <section v-if="state === 'error'" class="mg-section">
          <p class="mg-error" role="alert" data-testid="migrate-error">{{ errorMessage(errorCode) }}</p>
          <button v-if="canRestart" class="mg-btn mg-btn-primary" data-testid="migrate-restart" @click="restart">
            {{ t('discordMigration.migrate.startAgain') }}
          </button>
        </section>

        <!-- A session from another instance cannot be linked here -->
        <section v-else-if="state === 'federated'" class="mg-section" data-testid="migrate-federated">
          <p>{{ t('discordMigration.migrate.federated') }}</p>
          <button class="mg-btn" @click="signOutHere">{{ t('discordMigration.migrate.signOut') }}</button>
        </section>

        <!-- Landing -->
        <section v-else-if="state === 'landing'" class="mg-section">
          <p>{{ t('discordMigration.migrate.lead') }}</p>
          <template v-if="signedIn">
            <p>
              {{ t('discordMigration.migrate.linkTo', { username: myUsername }) }}
              <button class="mg-link" @click="signOutHere">{{ t('discordMigration.migrate.notYou') }}</button>
            </p>
            <button class="mg-btn mg-btn-primary" data-testid="migrate-signin-discord" @click="startDiscordSignIn(token)">
              {{ t('discordMigration.migrate.signInWithDiscord') }}
            </button>
          </template>
          <template v-else>
            <RouterLink class="mg-btn mg-btn-primary" data-testid="migrate-have-account" :to="loginTarget">
              {{ t('discordMigration.migrate.haveAccount') }}
            </RouterLink>
            <button class="mg-btn" data-testid="migrate-new-account" @click="startDiscordSignIn(token)">
              {{ t('discordMigration.migrate.newHere') }}
            </button>
          </template>
        </section>

        <!-- Claiming -->
        <section v-else-if="state === 'claiming'" class="mg-section" role="status">
          <p>{{ t('discordMigration.migrate.claiming') }}</p>
        </section>

        <!-- Result -->
        <section v-else-if="state === 'done'" class="mg-section" data-testid="migrate-done">
          <h2 class="mg-sub">{{ t('discordMigration.migrate.doneTitle') }}</h2>
          <div data-testid="migrate-roles">
            <template v-if="rolesGranted.length > 0">
              <p>{{ t('discordMigration.migrate.rolesReceived') }}</p>
              <ul class="mg-roles">
                <li v-for="name in rolesGranted" :key="name">{{ name }}</li>
              </ul>
            </template>
            <p v-else class="mg-muted">{{ t('discordMigration.migrate.noRoles') }}</p>
            <p v-if="isOwner" class="mg-muted" data-testid="migrate-owner-roles">{{ t('discordMigration.migrate.ownerRoles') }}</p>
          </div>
          <h2 class="mg-sub">{{ t('discordMigration.sync.title') }}</h2>
          <DiscordSyncFields v-model="syncFields" :disabled="syncing" />
          <p v-if="syncError" class="mg-muted" role="alert" data-testid="migrate-sync-error">{{ syncError }}</p>
          <p v-else-if="synced" class="mg-muted" role="status" data-testid="migrate-sync-done">{{ t('discordMigration.sync.done') }}</p>
          <div v-if="claimedServerId" class="mg-actions" data-testid="migrate-actions">
            <button class="mg-btn" :disabled="syncing" data-testid="migrate-sync" @click="runSync">
              {{ syncing ? t('discordMigration.sync.syncing') : t('discordMigration.sync.syncButton') }}
            </button>
            <button class="mg-btn mg-btn-primary" :disabled="syncing" data-testid="migrate-continue" @click="continueToServer">
              {{ t('discordMigration.migrate.continue') }}
            </button>
          </div>
        </section>

        <section v-else-if="state === 'login-failed'" class="mg-section" data-testid="migrate-login-failed" role="alert">
          <p>{{ t('discordMigration.migrate.accountCreatedSignIn') }}</p>
          <RouterLink class="mg-btn mg-btn-primary" data-testid="migrate-login-link" :to="loginTarget">
            {{ t('discordMigration.migrate.signIn') }}
          </RouterLink>
        </section>

        <!-- New account -->
        <section v-else-if="state === 'confirm-email'" class="mg-section" data-testid="migrate-confirm-email" role="status">
          <p>{{ t('discordMigration.migrate.confirmEmail') }}</p>
        </section>

        <form
          v-else-if="state === 'form'"
          class="mg-section"
          data-testid="migrate-form"
          novalidate
          @submit.prevent="submitAccount"
        >
          <p>{{ t('discordMigration.migrate.formLead') }}</p>
          <label class="mg-field">
            <span>{{ t('discordMigration.migrate.username') }}</span>
            <input
              v-model="username"
              data-testid="migrate-username"
              autocomplete="username"
              autocapitalize="none"
              spellcheck="false"
              required
            />
          </label>
          <label class="mg-field">
            <span>{{ t('discordMigration.migrate.email') }}</span>
            <input v-model="email" type="email" data-testid="migrate-email" autocomplete="email" required />
          </label>
          <label class="mg-field">
            <span>{{ t('discordMigration.migrate.password') }}</span>
            <input v-model="password" type="password" data-testid="migrate-password" autocomplete="new-password" required />
          </label>
          <p v-if="formError" class="mg-error" role="alert" data-testid="migrate-field-error">{{ errorMessage(formError) }}</p>
          <p v-if="formError === 'email_exists'" class="mg-muted" data-testid="migrate-signin-hint">
            <RouterLink class="mg-link" data-testid="migrate-signin-instead" :to="loginTarget">
              {{ t('discordMigration.migrate.signInInstead') }}
            </RouterLink>
            {{ t('discordMigration.migrate.signInInsteadHint') }}
          </p>
          <h2 class="mg-sub">{{ t('discordMigration.sync.title') }}</h2>
          <DiscordSyncFields v-model="syncFields" />
          <button class="mg-btn mg-btn-primary" type="submit" data-testid="migrate-submit" :disabled="submitting">
            {{ t('discordMigration.migrate.createAccount') }}
          </button>
        </form>
      </template>
    </div>
  </main>
</template>

<script setup lang="ts">
/**
 * /migrate/<token>, public. The gateway returns here from Discord with ?ticket= or ?error=.
 *   no ticket, no error   landing
 *   ?error=               a message (and "start again" where trying again can help)
 *   ?ticket=, signed in   claim, then the roles received and the sync toggles
 *   ?ticket=, signed out  new-account form
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import DiscordSyncFields from '@/components/settings/user/DiscordSyncFields.vue'
import { ALL_SYNC_FIELDS, initialSyncFields } from '@/components/settings/user/discordSyncFieldList'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import {
  DiscordMigrationError,
  claim,
  createAccount,
  myLink,
  preview,
  requestMySync,
  saveSyncChoice,
  setMySync,
  startDiscordSignIn,
  type MigrationPreview,
  type SyncField,
} from '@/services/discordMigrationService'
import { useAuthStore } from '@/stores/auth'
import { useProfileStore } from '@/stores/useProfile'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { normalizeUsernameInput } from '@/utils/usernameRules'

type ViewState = 'loading' | 'landing' | 'error' | 'claiming' | 'done' | 'form' | 'confirm-email' | 'federated' | 'login-failed'

const KNOWN_ERRORS = new Set([
  'closed', 'migration_closed', 'not_member', 'harmony_banned', 'kicked_on_harmony', 'discord_banned_here',
  'discord_account_taken', 'already_linked_other_discord', 'already_linked_elsewhere', 'ticket_expired',
  'account_creation_disabled', 'denied', 'exchange_failed', 'unavailable', 'username_taken', 'email_exists',
  'username_invalid', 'invalid_request', 'invalid_ticket', 'network',
])
const RESTARTABLE = new Set(['ticket_expired', 'invalid_ticket', 'denied', 'exchange_failed', 'unavailable'])

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const profileStore = useProfileStore()
const { confirm } = useConfirmDialog()

const token = String(route.params.token ?? '')
const queryValue = (key: string) => {
  const raw = route.query[key]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : ''
}
const ticket = queryValue('ticket')
const errorParam = queryValue('error').toLowerCase()
const usernameParam = queryValue('username')

const state = ref<ViewState>('loading')
const server = ref<MigrationPreview | null>(null)
const errorCode = ref('')
const rolesGranted = ref<string[]>([])
const isOwner = ref(false)
const claimedServerId = ref<string | null>(null)
const syncFields = ref<SyncField[]>([...ALL_SYNC_FIELDS])
const syncing = ref(false)
const synced = ref(false)
const syncError = ref('')

// The gateway adds the Discord username to the return address.
const username = ref(normalizeUsernameInput(usernameParam))
const email = ref('')
const password = ref('')
const formError = ref('')
const submitting = ref(false)

const signedIn = computed(() => authStore.isLoggedIn)
const myUsername = computed(() => profileStore.profile?.username ?? '')
const isFederatedSession = computed(() => signedIn.value && profileStore.profile?.is_local === false)
const canRestart = computed(() => RESTARTABLE.has(errorCode.value))
const loginTarget = computed(() => `/login?redirect=${encodeURIComponent(`/migrate/${token}`)}`)

function errorMessage(code: string): string {
  return t(`discordMigration.migrate.errors.${KNOWN_ERRORS.has(code) ? code : 'unknown'}`)
}

function showError(code: string) {
  errorCode.value = code
  state.value = 'error'
}

function restart() {
  startDiscordSignIn(token)
}

async function signOutHere() {
  await authStore.logout()
  await router.replace(route.fullPath)
  // Start over as a signed-out visitor: federated, result and claiming states do not carry over.
  state.value = 'loading'
  await init()
}

/** Saves the chosen fields and copies them now. */
async function runSync() {
  const serverId = claimedServerId.value
  if (!serverId || syncing.value) return
  syncing.value = true
  syncError.value = ''
  try {
    await setMySync(serverId, syncFields.value)
    synced.value = true
  } catch {
    synced.value = false
    syncError.value = t('discordMigration.sync.saveFailed')
  } finally {
    syncing.value = false
  }
}

async function continueToServer() {
  if (!synced.value) {
    const ok = await confirm({
      title: t('discordMigration.migrate.skipSyncTitle'),
      message: t('discordMigration.migrate.skipSyncMessage'),
      confirmButtonText: t('discordMigration.migrate.continue'),
    })
    if (!ok) return
  }
  await openServer()
}

async function openServer() {
  const serverId = claimedServerId.value
  if (!serverId) return
  const serverStore = useServerChannelStore()
  try {
    // The claim just added this account to the server: reload the list, as joining by invite does.
    const { authContextService } = await import('@/services/AuthContextService')
    const profileId = await authContextService.getCurrentProfileId()
    if (profileId) await serverStore.fetchServersForUser(profileId, true)
  } catch {
    // Chat loads the list itself when it is empty; open the server anyway.
  }
  // Same as picking the server in the sidebar; the chat route lands on its first channel.
  serverStore.setCurrentServer(serverId)
  void router.push({ name: 'Chat' })
}

async function runClaim() {
  state.value = 'claiming'
  try {
    const result = await claim(ticket)
    rolesGranted.value = result.rolesGranted
    isOwner.value = result.isOwner
    claimedServerId.value = result.serverId || null
    if (result.serverId) {
      // The roles on the ticket may be old: have the gateway read Discord now (best effort).
      void requestMySync(result.serverId)
      const link = await myLink(result.serverId).catch(() => null)
      syncFields.value = initialSyncFields(link)
    }
    state.value = 'done'
  } catch (err) {
    const code = err instanceof DiscordMigrationError ? err.code : 'unknown'
    // NewProfile may have claimed this very ticket before the member came back here.
    if (code === 'ticket_expired' && (await showAlreadyLinked())) return
    showError(code)
  }
}

/** True when the member already holds an active link to this migration's server. */
async function showAlreadyLinked(): Promise<boolean> {
  const serverId = server.value?.serverId
  if (!serverId) return false
  const link = await myLink(serverId).catch(() => null)
  if (link?.status !== 'active') return false
  rolesGranted.value = []
  isOwner.value = false
  claimedServerId.value = serverId
  syncFields.value = initialSyncFields(link)
  state.value = 'done'
  return true
}

async function submitAccount() {
  if (submitting.value) return
  formError.value = ''
  const name = normalizeUsernameInput(username.value)
  if (!name || !email.value.trim() || !password.value) {
    formError.value = 'invalid_request'
    return
  }
  submitting.value = true
  try {
    const { needsConfirmation } = await createAccount({
      ticket,
      username: name,
      email: email.value.trim(),
      password: password.value,
    })
    saveSyncChoice(ticket, syncFields.value)
    if (needsConfirmation) {
      state.value = 'confirm-email'
      return
    }
    try {
      await authStore.login(email.value.trim(), password.value)
    } catch {
      // The account exists and its ticket is bound; only the sign-in failed.
      state.value = 'login-failed'
      return
    }
    await router.replace({ path: '/new-profile', query: { username: name } })
  } catch (err) {
    formError.value = err instanceof DiscordMigrationError ? err.code : 'unknown'
  } finally {
    submitting.value = false
  }
}

async function init() {
  errorCode.value = ''
  formError.value = ''
  rolesGranted.value = []
  isOwner.value = false
  claimedServerId.value = null
  if (errorParam) {
    server.value = await preview(token).catch(() => null)
    showError(errorParam)
    return
  }
  if (isFederatedSession.value) {
    state.value = 'federated'
    return
  }
  if (ticket && signedIn.value) {
    server.value = await preview(token).catch(() => null)
    await runClaim()
    return
  }
  try {
    server.value = await preview(token)
  } catch {
    server.value = null
  }
  if (!server.value && !ticket) {
    showError('closed')
    return
  }
  state.value = ticket ? 'form' : 'landing'
}

/** The ticket is a bearer secret: keep it out of the address bar, history and referrers. It stays in this component. */
function hideTicketFromAddress() {
  if (!ticket && !usernameParam) return
  const { ticket: _ticket, username: _username, ...rest } = route.query
  void router.replace({ path: `/migrate/${token}`, query: rest })
}

onMounted(() => {
  hideTicketFromAddress()
  void init()
})
</script>

<style scoped>
.mg-wrap {
  min-height: calc(100 * var(--app-vh));
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--background-senary);
}
.mg-card {
  width: 100%;
  max-width: 440px;
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-xl);
  padding: 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--text-primary);
}
.mg-server { display: flex; align-items: center; gap: 12px; }
.mg-icon { width: 48px; height: 48px; border-radius: 12px; object-fit: cover; flex: none; }
.mg-icon-fallback { display: flex; align-items: center; justify-content: center; background: var(--harmony-primary); color: #fff; font-weight: 700; }
.mg-title { margin: 0; font-size: 1.5rem; font-weight: 600; }
.mg-sub { margin: 8px 0 0; font-size: 1rem; font-weight: 600; }
.mg-section { display: flex; flex-direction: column; gap: 12px; }
.mg-section p { margin: 0; }
.mg-muted { color: var(--text-muted); }
.mg-error { color: var(--error); }
.mg-roles { margin: 0; padding-left: 20px; }
.mg-field { display: flex; flex-direction: column; gap: 4px; font-size: 0.875rem; }
.mg-field input {
  padding: 8px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-primary);
  background: var(--background-primary);
  color: var(--text-primary);
  font: inherit;
}
.mg-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 16px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-primary);
  background: var(--background-tertiary);
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
  text-decoration: none;
}
.mg-actions { display: flex; gap: 12px; flex-wrap: nowrap; }
.mg-btn-primary { background: var(--harmony-primary); border-color: transparent; color: #fff; }
.mg-btn:disabled { opacity: 0.6; cursor: default; }
.mg-link { background: none; border: 0; padding: 0; color: var(--text-link); cursor: pointer; font: inherit; text-decoration: underline; }
</style>
