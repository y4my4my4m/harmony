<template>
    <svg class="editIcon" aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24">
        <path d="m13.96 5.46 4.58 4.58a1 1 0 0 0 1.42 0l1.38-1.38a2 2 0 0 0 0-2.82l-3.18-3.18a2 2 0 0 0-2.82 0l-1.38 1.38a1 1 0 0 0 0 1.42ZM2.11 20.16l.73-4.22a3 3 0 0 1 .83-1.61l7.87-7.87a1 1 0 0 1 1.42 0l4.58 4.58a1 1 0 0 1 0 1.42l-7.87 7.87a3 3 0 0 1-1.6.83l-4.23.73a1.5 1.5 0 0 1-1.73-1.73Z">
        </path>
    </svg>
</template>

<script lang="ts">import { defineComponent} from 'vue';

export default defineComponent({
    name: 'EditIcon',
});
</script>
<style scoped>

    .editIcon {
        width: 20px;
        height: 20px;
    }
    .editIcon path {
        fill: #aaa;
      transition: fill .2s;
        cursor:pointer;
    }
    .editIcon:hover path {
        fill: #fff;
    }
</style>