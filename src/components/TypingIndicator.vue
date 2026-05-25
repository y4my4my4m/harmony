<template>
  <div v-if="typingUsers.length > 0" class="typing-indicator">
    <div class="typing-dots">
      <span></span>
      <span></span>
      <span></span>
    </div>
    <span class="typing-text">
      <!-- Single user: name appears once via DisplayName, then static suffix -->
      <template v-if="typingUsers.length === 1">
        <span class="typing-username">
          <DisplayName :user-id="typingUsers[0].user_id" />
        </span>
        <span class="typing-suffix">{{ t('message.typing.single') }}</span>
      </template>
      <!-- Two users: first name via DisplayName, second in i18n (no duplicate first name) -->
      <template v-else-if="typingUsers.length === 2">
        <span class="typing-username">
          <DisplayName :user-id="typingUsers[0].user_id" />
        </span>
        <span class="typing-suffix">{{ t('message.typing.two', { name2: getUserDisplayName(typingUsers[1].user_id).value }) }}</span>
      </template>
      <!-- Three users: first name via DisplayName, rest in i18n -->
      <template v-else-if="typingUsers.length === 3">
        <span class="typing-username">
          <DisplayName :user-id="typingUsers[0].user_id" />
        </span>
        <span class="typing-suffix">{{ t('message.typing.three', { 
          name2: getUserDisplayName(typingUsers[1].user_id).value, 
          name3: getUserDisplayName(typingUsers[2].user_id).value 
        }) }}</span>
      </template>
      <!-- Many users (4+): "Many users are typing..." -->
      <template v-else>
        <span class="typing-suffix">{{ t('message.typing.many') }}</span>
      </template>
    </span>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { TypingUser } from '@/services/TypingIndicatorService'
import { useUserData } from '@/composables/useUserData'
import DisplayName from '@/components/DisplayName.vue'

interface Props {
  typingUsers: TypingUser[]
}

defineProps<Props>()

const { t } = useI18n()
const { getUserDisplayName } = useUserData()
</script>

<style scoped>
.typing-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  min-height: 20px;
  font-size: 13px;
  line-height: 1.375;
}

.typing-dots {
  display: flex;
  gap: 3px;
  align-items: center;
  padding-top: 2px;
  flex-shrink: 0;
}

.typing-dots span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background-color: var(--text-muted, rgba(255, 255, 255, 0.4));
  animation: typing-dot 1.4s infinite ease-in-out;
}

.typing-dots span:nth-child(1) {
  animation-delay: 0s;
}

.typing-dots span:nth-child(2) {
  animation-delay: 0.2s;
}

.typing-dots span:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes typing-dot {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-3px);
    opacity: 0.8;
  }
}

.typing-text {
  color: var(--text-muted, rgba(255, 255, 255, 0.6));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.typing-username {
  font-weight: 600;
}

.typing-suffix {
  font-weight: 400;
}
</style>
