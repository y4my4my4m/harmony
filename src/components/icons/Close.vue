<template>
    <svg class="closeIcon" aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" fill="transparent"></circle>
        <path fill="currentColor" fill-rule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm4.7-15.7a1 1 0 0 0-1.4 0L12 10.58l-3.3-3.3a1 1 0 0 0-1.4 1.42L10.58 12l-3.3 3.3a1 1 0 1 0 1.42 1.4L12 13.42l3.3 3.3a1 1 0 0 0 1.4-1.42L13.42 12l3.3-3.3a1 1 0 0 0 0-1.4Z" clip-rule="evenodd" class="">
        </path>
    </svg>
</template>

<script lang="ts">import { defineComponent} from 'vue';

export default defineComponent({
    name: 'CloseIcon',
});
</script>
<style scoped>
    .closeIcon path {
        fill: #aaa;
        transition: fill .2s;
        cursor:pointer;
    }
    .closeIcon:hover path {
        fill: #fff;
    }
</style>