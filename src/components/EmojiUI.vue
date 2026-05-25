<template>
    <div class="spriteContainer" @mouseenter="onHover" @mouseleave="onMouseLeave">
        <div class="sprite" :style="{
            '--sprite-row': spriteRow,
            '--sprite-col': spriteCol,
            '--grayscaleFactor': grayscaleFactor,
            '--scaleFactor': scaleFactor,
        }"></div>
    </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';

export default defineComponent({
    name: 'EmojiUI',
    setup() {
        const spriteRow = ref(0);
        const spriteCol = ref(10);
        const grayscaleFactor = ref(1);
        const scaleFactor = ref(1);

        const onHover = () => {
            spriteRow.value = Math.floor(Math.random() * 4) + 1; // Assuming 4 rows

            if (spriteRow.value === 3) {
                spriteCol.value = Math.floor(Math.random() * 17) + 1; // Assuming 17 columns for the fourth row
            } else {
                spriteCol.value = Math.floor(Math.random() * 20) + 1; // Assuming 20 columns for other rows
            }
            grayscaleFactor.value = 0;
            scaleFactor.value = 1.14;
        };

        const onMouseLeave = () => {
            grayscaleFactor.value = 1;
            scaleFactor.value = 1;
        };

        return { spriteRow, spriteCol, grayscaleFactor, scaleFactor, onHover, onMouseLeave };
    },
});
</script>

<style scoped>
.spriteContainer {
    position: relative;
    --custom-emoji-sprite-size: 24px;
    width: var(--custom-emoji-sprite-size);
    height: var(--custom-emoji-sprite-size);
    display: block;
    transition: fill .2s;
    cursor:pointer;
}

.sprite {
    position: absolute;
    top: 0;
    left: 0;
    width: var(--custom-emoji-sprite-size);
    height: var(--custom-emoji-sprite-size);
    display: block;
    transition: transform .2s, filter .2s;
    transform: scale(var(--scaleFactor));
    background-image: url('/assets/emoji_sheet.webp');
    background-position: calc(-1 * var(--sprite-col) * var(--custom-emoji-sprite-size)) calc(-1 * var(--sprite-row) * var(--custom-emoji-sprite-size));
    background-size: calc(20 * var(--custom-emoji-sprite-size)) calc(4 * var(--custom-emoji-sprite-size));
    filter: grayscale(var(--grayscaleFactor));
}
</style>
