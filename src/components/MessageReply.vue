<template>
    <div class="attachedBars">
        <div class="container">
            <div class="replyBar">
                <div role="button" tabindex="0">
                    <div class="text-sm-normal">Replying to <span class="user_display_name">{{ replyUserDisplayName }}</span>
                    </div>
                </div>
                <div class="actions">
                    <div class="closeButton" role="button" tabindex="0" @click="dontReply">
                        <CloseIcon />
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import CloseIcon from '@/components/icons/Close.vue';

interface Props {
  replyMessageId: string
  replyUserDisplayName?: string
}

withDefaults(defineProps<Props>(), {
  replyUserDisplayName: 'Deleted User'
})

const emit = defineEmits<{
  'update:replyMessageId': []
}>()

const dontReply = () => {
  emit('update:replyMessageId')
}
</script>

<style scoped>
    .attachedBars {
        background-color: var(--h-sidebar);
        border-top-left-radius: 8px;
        border-top-right-radius: 8px;
    }

    .container {
        display:flex;
        flex-direction: column;
        padding: 4px 8px;
    }

    .replyBar {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .user_display_name {
        font-weight: bold;
        color: #ddd;
    }

    .text-sm-normal {
        font-size: 14px;
        color: #aaa; /* Dark grey text */
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
