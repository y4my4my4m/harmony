<template>
  <div v-if="isVisible" class="encryption-indicator" :class="indicatorClass" :title="tooltip">
    <span class="icon">{{ icon }}</span>
    <span v-if="showLabel" class="label">{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  encrypted?: boolean
  mode?: 'message' | 'voice' | 'server' | 'dm'
  showLabel?: boolean
  size?: 'small' | 'medium' | 'large'
  /**
   * Cryptographic sender-binding state for an encrypted message.
   *  - true      → signature verified
   *  - false     → message decoded but sender NOT cryptographically verified
   *                (legacy v1 message or sender has no signing key on file)
   *  - undefined → not applicable (plaintext, or this indicator isn't for a message)
   */
  senderVerified?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  encrypted: false,
  mode: 'message',
  showLabel: false,
  size: 'medium'
})

// "Unverified author" is only meaningful for an encrypted message whose
// sender signature failed/was missing. We surface it visually only in
// per-message mode.
const isUnverifiedAuthor = computed(() => {
  return (
    props.mode === 'message' && props.encrypted === true && props.senderVerified === false
  )
})

const isVisible = computed(() => {
  // Always show for server/dm mode, only show for message/voice if encrypted
  return props.mode === 'server' || props.mode === 'dm' || props.encrypted
})

const icon = computed(() => {
  if (isUnverifiedAuthor.value) return '⚠️'
  return props.encrypted ? '🔐' : '🔓'
})

const label = computed(() => {
  if (isUnverifiedAuthor.value) return 'Unverified author'
  if (props.encrypted) {
    switch (props.mode) {
      case 'message':
        return 'Encrypted'
      case 'voice':
        return 'E2EE Call'
      case 'server':
        return 'E2EE Enabled'
      case 'dm':
        return 'Encrypted'
      default:
        return 'Encrypted'
    }
  } else {
    switch (props.mode) {
      case 'message':
        return 'Plaintext'
      case 'voice':
        return 'Unencrypted Call'
      case 'server':
        return 'E2EE Disabled'
      case 'dm':
        return 'Plaintext'
      default:
        return 'Unencrypted'
    }
  }
})

const tooltip = computed(() => {
  if (isUnverifiedAuthor.value) {
    return 'This message was decrypted but the sender\'s identity could not be cryptographically verified. The sender may be running an older client, or the message may have been tampered with.'
  }
  if (props.encrypted) {
    switch (props.mode) {
      case 'message':
        return 'This message is end-to-end encrypted and the sender\'s identity has been cryptographically verified.'
      case 'voice':
        return 'This call is end-to-end encrypted using insertable streams.'
      case 'server':
        return 'This server requires end-to-end encryption for all messages.'
      case 'dm':
        return 'This conversation is encrypted end-to-end.'
      default:
        return 'End-to-end encrypted'
    }
  } else {
    switch (props.mode) {
      case 'message':
        return 'This message is not encrypted. Server operators can read it.'
      case 'voice':
        return 'This call is not encrypted. Consider enabling E2EE in settings.'
      case 'server':
        return 'This server does not require encryption.'
      case 'dm':
        return 'This conversation is not encrypted. Enable E2EE in settings.'
      default:
        return 'Not encrypted'
    }
  }
})

const indicatorClass = computed(() => {
  const variant = isUnverifiedAuthor.value
    ? 'unverified-author'
    : props.encrypted
      ? 'encrypted'
      : 'unencrypted'
  return [`size-${props.size}`, variant, `mode-${props.mode}`]
})
</script>

<style scoped>
.encryption-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: help;
  transition: all 0.2s;
}

.encryption-indicator.size-small {
  font-size: 10px;
  padding: 1px 4px;
  gap: 2px;
}

.encryption-indicator.size-small .icon {
  font-size: 10px;
}

.encryption-indicator.size-medium {
  font-size: 12px;
  padding: 2px 6px;
  gap: 4px;
}

.encryption-indicator.size-medium .icon {
  font-size: 12px;
}

.encryption-indicator.size-large {
  font-size: 14px;
  padding: 4px 8px;
  gap: 6px;
}

.encryption-indicator.size-large .icon {
  font-size: 16px;
}

.encryption-indicator.encrypted {
  background: rgba(var(--color-success-rgb), 0.1);
  color: var(--color-success);
  border: 1px solid rgba(var(--color-success-rgb), 0.3);
}

.encryption-indicator.encrypted:hover {
  background: rgba(var(--color-success-rgb), 0.2);
}

.encryption-indicator.unencrypted {
  background: rgba(var(--color-warning-rgb), 0.1);
  color: var(--color-warning);
  border: 1px solid rgba(var(--color-warning-rgb), 0.3);
}

.encryption-indicator.unencrypted:hover {
  background: rgba(var(--color-warning-rgb), 0.2);
}

.encryption-indicator.unverified-author {
  background: rgba(var(--color-warning-rgb), 0.15);
  color: var(--color-warning);
  border: 1px dashed rgba(var(--color-warning-rgb), 0.6);
}

.encryption-indicator.unverified-author:hover {
  background: rgba(var(--color-warning-rgb), 0.25);
}

.icon {
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.label {
  white-space: nowrap;
}

/* Mode-specific styles */
.encryption-indicator.mode-voice {
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

/* Dark mode adjustments */
:root[data-theme-type="dark"] .encryption-indicator.encrypted {
  background: rgba(var(--color-success-rgb), 0.15);
}

:root[data-theme-type="dark"] .encryption-indicator.unencrypted {
  background: rgba(var(--color-warning-rgb), 0.15);
}
</style>
