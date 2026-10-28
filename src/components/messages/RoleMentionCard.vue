<template>
  <Teleport :to="portalTarget">
    <div
      ref="card"
      class="role-mention-card"
      role="dialog"
      :aria-label="t('mentionLabels.roleCard.label', { name: shownName })"
      tabindex="-1"
      :style="position"
      data-testid="role-mention-card"
      @keydown.esc.stop="emit('close')"
    >
      <div class="role-mention-card-head">
        <span class="role-mention-card-dot" :style="{ backgroundColor: shownColor }" aria-hidden="true"></span>
        <span class="role-mention-card-name" :style="{ color: shownColor }">@{{ shownName }}</span>
      </div>
      <div class="role-mention-card-kind">{{ t('mentionLabels.role') }}</div>
      <div class="role-mention-card-detail" data-testid="role-mention-card-detail">{{ detail }}</div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { supabase } from '@/supabase'
import { roleService } from '@/services/RoleService'
import { HERE_ROLE_ID } from '@/utils/hereMention'
import { usePortalTarget } from '@/composables/usePortalTarget'
import { roleMentionColor } from '@/utils/roleMentions'

const props = defineProps<{
  roleId: string
  roleName: string
  roleColor?: string | null
  /** Bounding box of the pill, viewport coordinates. */
  anchor: { left: number; top: number; bottom: number }
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()
const portalTarget = usePortalTarget()
const card = ref<HTMLElement | null>(null)
const stored = ref<{ name: string; color: string | null } | null>(null)
const memberCount = ref<number | null>(null)
const known = ref(true)

const shownName = computed(() => (stored.value?.name ?? props.roleName ?? '').replace(/^@/, ''))
const shownColor = computed(() => roleMentionColor(stored.value?.color || props.roleColor))
const detail = computed(() => {
  if (props.roleId === HERE_ROLE_ID) return t('mentionLabels.roleCard.here')
  if (!known.value) return t('mentionLabels.roleCard.unknown')
  if (memberCount.value === null) return ''
  return t('mentionLabels.roleCard.members', { count: memberCount.value }, memberCount.value)
})

// Below the pill, kept inside the viewport.
const position = computed(() => {
  const width = 240
  const left = Math.max(8, Math.min(props.anchor.left, window.innerWidth - width - 8))
  const below = props.anchor.bottom + 6
  const top = below + 120 > window.innerHeight ? Math.max(8, props.anchor.top - 126) : below
  return { position: 'fixed' as const, left: `${left}px`, top: `${top}px`, width: `${width}px` }
})

/**
 * The role's stored name and colour, and its member count: user_roles assignments for a role,
 * accepted members of the server for its default role (@everyone holds no assignment rows).
 */
async function load(): Promise<void> {
  if (props.roleId === HERE_ROLE_ID) return
  const { data: role } = await supabase
    .from('server_roles')
    .select('id, name, color, server_id, is_default')
    .eq('id', props.roleId)
    .maybeSingle()
  if (!role) {
    known.value = false
    return
  }
  stored.value = { name: role.name, color: role.color ?? null }
  if (role.is_default) {
    const { count } = await supabase
      .from('user_servers')
      .select('user_id', { count: 'exact', head: true })
      .eq('server_id', role.server_id)
      .eq('status', 'accepted')
    memberCount.value = count ?? 0
    return
  }
  const roles = await roleService.getRolesForServer(role.server_id)
  memberCount.value = roles.find((r) => r.id === role.id)?.member_count ?? 0
}

const onPointerDown = (event: PointerEvent) => {
  if (card.value && !card.value.contains(event.target as Node)) emit('close')
}

onMounted(() => {
  void load()
  nextTick(() => card.value?.focus())
  document.addEventListener('pointerdown', onPointerDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
})
</script>

<style scoped>
.role-mention-card {
  z-index: 10000;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--background-tertiary);
  border: 1px solid var(--background-quinary);
  color: var(--text-primary);
  box-shadow: var(--shadow-large);
  outline: none;
}

.role-mention-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.role-mention-card-dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.role-mention-card-kind {
  margin-top: 4px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.role-mention-card-detail {
  margin-top: 6px;
  font-size: 14px;
}
</style>
