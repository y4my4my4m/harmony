<template>
    <svg class="replyIcon" aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24">
        <path d="M2.3 7.3a1 1 0 0 0 0 1.4l5 5a1 1 0 0 0 1.4-1.4L5.42 9H11a7 7 0 0 1 7 7v4a1 1 0 1 0 2 0v-4a9 9 0 0 0-9-9H5.41l3.3-3.3a1 1 0 0 0-1.42-1.4l-5 5Z">
        </path>
    </svg>
</template>

<script lang="ts">import { defineComponent} from 'vue';

export default defineComponent({
    name: 'ReplyIcon',
});
</script>
<style scoped>
    .replyIcon{
        width: 20px;
        height: 20px;
    }
    .replyIcon path {
        fill: #aaa;
        transition: fill .2s;
        cursor:pointer;
    }
    .replyIcon:hover path {
        fill: #fff;
    }
</style>
