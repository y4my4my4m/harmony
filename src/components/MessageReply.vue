<template>
    <div class="attachedBars">
        <div class="replyBar">
            <div role="button" tabindex="0">
                <div class="text-sm-normal">
                    Replying to
                    <MessageAuthorLabel
                        class="user_display_name"
                        :profile-user-id="profileUserId"
                        :display-name="authorLabel"
                        :bridge-source="bridgeSource"
                    />
                </div>
            </div>
            <div class="actions">
                <div class="closeButton" role="button" tabindex="0" @click="dontReply">
                    <CloseIcon />
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import CloseIcon from '@/components/icons/Close.vue'
import MessageAuthorLabel from '@/components/messages/MessageAuthorLabel.vue'
import { useReplyTarget } from '@/composables/useReplyTarget'

const props = defineProps<{
  replyMessageId: string
  channelId?: string
  conversationId?: string
  serverId?: string
}>()

const emit = defineEmits<{
  'update:replyMessageId': [value: string]
}>()

const {
  profileUserId,
  authorLabel,
  bridgeSource,
} = useReplyTarget(
  toRef(props, 'replyMessageId'),
  computed(() => ({
    channelId: props.channelId,
    conversationId: props.conversationId,
    serverId: props.serverId,
  })),
)

const dontReply = () => {
  emit('update:replyMessageId', '')
}
</script>

<style scoped>
    .attachedBars {
        background-color: var(--background-tertiary);
        border-top-left-radius: 8px;
        border-top-right-radius: 8px;
    }

    .replyBar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 8px;
    }

    .user_display_name {
        font-weight: bold;
        color: #ddd;
    }

    .text-sm-normal {
        font-size: 14px;
        color: #aaa;
    }

    .actions .closeButton {
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        width: 16px;
        height: 16px;
    }

    .actions .closeButton:hover path{
        background-color: #787c80;
    }

</style>
