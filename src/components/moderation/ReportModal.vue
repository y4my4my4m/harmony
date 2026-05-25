<template>
  <Teleport to="body">
    <div class="report-overlay" @click.self="$emit('close')">
      <div class="report-modal">
        <div class="modal-header">
          <h2>Report {{ reportTypeLabel }}</h2>
          <button @click="$emit('close')" class="close-btn">
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <!-- Target info -->
          <div v-if="targetUser" class="target-info">
            <Avatar :src="targetUser.avatar_url" :alt="targetUser.username" size="sm" class="target-avatar" />
            <div>
              <span class="target-name">
                <DisplayName
                  v-if="targetUserId"
                  :user-id="targetUserId"
                  :fallback="targetUser.display_name || targetUser.username"
                />
                <template v-else>{{ targetUser.display_name || targetUser.username }}</template>
              </span>
              <span class="target-handle">@{{ targetUser.username }}</span>
            </div>
          </div>

          <!-- Proof: message preview -->
          <div v-if="reportType === 'message' && targetMessagePreview" class="proof-section">
            <label>Reported message</label>
            <blockquote class="proof-quote">{{ targetMessagePreview }}</blockquote>
          </div>

          <!-- Proof: post preview -->
          <div v-if="reportType === 'post' && targetPostPreview" class="proof-section">
            <label>Reported post</label>
            <blockquote class="proof-quote">{{ targetPostPreview }}</blockquote>
          </div>

          <!-- Reason selection -->
          <div class="form-group">
            <label>Why are you reporting this?</label>
            <div class="reason-options">
              <label
                v-for="reason in reportReasons"
                :key="reason.value"
                class="reason-option"
                :class="{ selected: selectedReason === reason.value }"
              >
                <input
                  type="radio"
                  :value="reason.value"
                  v-model="selectedReason"
                />
                <span>{{ reason.label }}</span>
              </label>
            </div>
          </div>

          <!-- Additional comment -->
          <div class="form-group">
            <label>Additional details (optional)</label>
            <textarea
              v-model="comment"
              placeholder="Provide any additional context..."
              rows="3"
              maxlength="1000"
            ></textarea>
            <span class="char-count">{{ comment.length }}/1000</span>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-cancel" @click="$emit('close')">Cancel</button>
          <button
            class="btn-submit"
            @click="submitReport"
            :disabled="!selectedReason || isSubmitting"
          >
            {{ isSubmitting ? 'Submitting...' : 'Submit Report' }}
          </button>
        </div>

        <!-- Success state -->
        <div v-if="submitted" class="success-overlay">
          <div class="success-content">
            <span class="success-icon">✓</span>
            <h3>Report Submitted</h3>
            <p>Thank you for helping keep the community safe. We'll review your report shortly.</p>
            <div v-if="reportType === 'message' || reportType === 'post'" class="hide-prompt">
              <button class="btn-hide" @click="hideAndClose">
                Hide this {{ reportType }}
              </button>
              <span class="hide-hint">Remove it from your view</span>
            </div>
            <button class="btn-done" @click="$emit('close')">{{ (reportType === 'message' || reportType === 'post') ? 'Keep visible' : 'Done' }}</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { reportService, REPORT_REASONS, type ReportReason } from '@/services/ReportService'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'

interface Props {
  reportType: 'user' | 'post' | 'message' | 'server'
  targetUserId?: string
  targetPostId?: string
  targetMessageId?: string
  targetServerId?: string
  targetMessagePreview?: string
  targetPostPreview?: string
  targetUser?: {
    username: string
    display_name?: string
    avatar_url?: string
  }
}

const props = defineProps<Props>()

const emit = defineEmits<{
  close: []
  hide: [type: 'message' | 'post', id: string]
}>()

const selectedReason = ref<ReportReason | ''>('')
const comment = ref('')
const isSubmitting = ref(false)
const submitted = ref(false)
const reportReasons = REPORT_REASONS

const reportTypeLabel = computed(() => {
  switch (props.reportType) {
    case 'user': return 'User'
    case 'post': return 'Post'
    case 'message': return 'Message'
    case 'server': return 'Server'
    default: return 'Content'
  }
})

const submitReport = async () => {
  if (!selectedReason.value || isSubmitting.value) return

  isSubmitting.value = true
  try {
    const report = await reportService.createReport({
      reported_user_id: props.targetUserId,
      reported_post_id: props.targetPostId,
      reported_message_id: props.targetMessageId,
      reported_server_id: props.targetServerId,
      report_type: props.reportType,
      reason: selectedReason.value,
      comment: comment.value || undefined
    })

    if (report) {
      submitted.value = true
    }
  } catch {
    // error handled by service
  } finally {
    isSubmitting.value = false
  }
}

const hideAndClose = () => {
  const id = props.reportType === 'message' ? props.targetMessageId : props.targetPostId
  if (id) {
    emit('hide', props.reportType as 'message' | 'post', id)
  }
  emit('close')
}
</script>

<style scoped>
.report-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(4px);
}

.report-modal {
  position: relative;
  background: var(--background-primary, #1e1f22);
  border: 1px solid var(--border-color, #2b2d31);
  border-radius: 12px;
  width: 90vw;
  max-width: 480px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary, #f2f3f5);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}

.close-btn:hover {
  background: var(--background-hover);
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.target-info {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--background-secondary, #2b2d31);
  border-radius: 8px;
  margin-bottom: 20px;
}

.target-avatar {
  flex-shrink: 0;
}

.target-name {
  display: block;
  font-weight: 600;
  color: var(--text-primary);
  font-size: 14px;
}

.target-handle {
  display: block;
  font-size: 13px;
  color: var(--text-secondary);
}

.proof-section {
  margin-bottom: 20px;
}

.proof-section label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.proof-quote {
  margin: 0;
  padding: 10px 14px;
  border-left: 3px solid var(--harmony-primary, #0EA5E9);
  background: var(--background-secondary, #2b2d31);
  border-radius: 0 6px 6px 0;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
}

.reason-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.reason-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px 10px 16px;
  border: 1px solid var(--border-color, #3f4147);
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-secondary);
  transition: all 0.15s;
}

.reason-option:hover {
  background: var(--background-hover);
}

.reason-option.selected {
  border-color: var(--harmony-primary, #0EA5E9);
  background: rgba(14, 165, 233, 0.1);
  color: var(--text-primary);
}

.reason-option input[type="radio"] {
  flex-shrink: 0;
  margin: 0;
  width: 18px;
  height: 18px;
  accent-color: var(--harmony-primary, #0EA5E9);
  vertical-align: middle;
  margin-right: 8px;
}

.reason-option span {
  flex: 1;
  padding-right: 8px;
  vertical-align: middle;
}

textarea {
  width: 100%;
  padding: 10px 12px;
  background: var(--background-secondary, #2b2d31);
  border: 1px solid var(--border-color, #3f4147);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
  resize: vertical;
  font-family: inherit;
}

textarea:focus {
  outline: none;
  border-color: var(--harmony-primary, #0EA5E9);
}

.char-count {
  display: block;
  text-align: right;
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid var(--border-color);
}

.btn-cancel, .btn-submit, .btn-done {
  padding: 10px 20px;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  font-size: 14px;
}

.btn-cancel {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
}

.btn-cancel:hover {
  background: var(--background-hover);
}

.btn-submit {
  background: #ed4245;
  border: none;
  color: var(--text-primary);
}

.btn-submit:hover:not(:disabled) {
  background: #c03537;
}

.btn-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.success-overlay {
  position: absolute;
  inset: 0;
  background: var(--background-primary, #1e1f22);
  display: flex;
  align-items: center;
  justify-content: center;
}

.success-content {
  text-align: center;
  padding: 40px;
}

.success-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  background: #57f287;
  color: var(--text-primary);
  border-radius: 50%;
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 16px;
}

.success-content h3 {
  margin: 0 0 8px;
  color: var(--text-primary);
  font-size: 20px;
}

.success-content p {
  color: var(--text-secondary);
  font-size: 14px;
  margin: 0 0 24px;
}

.hide-prompt {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin-bottom: 12px;
}

.btn-hide {
  padding: 10px 24px;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  font-size: 14px;
  background: #ed4245;
  border: none;
  color: var(--text-primary);
}

.btn-hide:hover {
  background: #c03537;
}

.hide-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.btn-done {
  background: var(--harmony-primary, #0EA5E9);
  border: none;
  color: var(--text-primary);
}

.btn-done:hover {
  opacity: 0.9;
}
</style>
