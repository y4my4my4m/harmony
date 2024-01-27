<template>
    <canvas ref="canvas"></canvas>
</template>
  
<script lang="ts">
import { defineComponent, onMounted, watchEffect, ref } from 'vue';
import type { PropType } from 'vue';
import type { Point } from '@/types';

export default defineComponent({
  name: 'SpaceTimeGrid',
  props: {
    width: {
      type: Number,
      required: true
    },
    height: {
      type: Number,
      required: true
    },
    avatars: {
      type: Array as PropType<Point[]>,
      required: true
    }
  },
  setup(props) {
    const canvas = ref<HTMLCanvasElement | null>(null);

    onMounted(() => {
      if (!canvas.value) return;
      const ctx = canvas.value.getContext('2d');
      if (!ctx) return;

      // Use props.width and props.height for setting the canvas size
      canvas.value.width = props.width;
      canvas.value.height = props.height;

      const drawGrid = () => {
        ctx.clearRect(0, 0, canvas.value.width, canvas.value.height);
        const gridSize = 25;

        // Function to calculate deformation based on avatar positions
        const calculateDeformation = (x: number, y: number): Point => {
          let deformationX = 0;
          let deformationY = 0;
          const deformationDistance = 100; // Radius of significant deformation effect
          const maxDeformation = 25; // Maximum deformation
          const gravityFade = .5; // Adjust this value to control the fade-away of gravity
          const strength = 300;

          props.avatars.forEach(avatar => {
            // Adjust avatar position to center
            const avatarCenterX = avatar.x + 24;
            const avatarCenterY = avatar.y + 24;

            const distance = Math.sqrt((x - avatarCenterX) ** 2 + (y - avatarCenterY) ** 2);
            if (distance < deformationDistance) {
              let deformation = strength / distance;
              // Apply fade-away factor
              deformation *= Math.max(0, 1 - (distance / deformationDistance) * gravityFade);
              deformation = Math.min(maxDeformation, deformation);

              deformationX += deformation * (avatarCenterX - x) / distance;
              deformationY += deformation * (avatarCenterY - y) / distance;
            }
          });

          return { x: deformationX, y: deformationY };
        };


        ctx.strokeStyle = '#ccc'; // Set line color

        // Draw horizontal lines
        for (let y = 0; y <= canvas.value.height; y += gridSize) {
          ctx.beginPath();
          for (let x = 0; x <= canvas.value.width; x += gridSize) {
            const { x: dx, y: dy } = calculateDeformation(x, y);
            if (x === 0) ctx.moveTo(x + dx, y + dy);
            else ctx.lineTo(x + dx, y + dy);
          }
          ctx.stroke();
        }

        // Draw vertical lines
        for (let x = 0; x <= canvas.value.width; x += gridSize) {
          ctx.beginPath();
          for (let y = 0; y <= canvas.value.height; y += gridSize) {
            const { x: dx, y: dy } = calculateDeformation(x, y);
            if (y === 0) ctx.moveTo(x + dx, y + dy);
            else ctx.lineTo(x + dx, y + dy);
          }
          ctx.stroke();
        }
      };

      const animate = () => {
        drawGrid();
        requestAnimationFrame(animate);
      };

      animate();
    });

    watchEffect(() => {
      if (canvas.value) {
        canvas.value.width = props.width;
        canvas.value.height = props.height;
      }
    });

    return {
      canvas,
    };
  },
});
</script>


<style scoped>
  canvas {
    position:absolute;
    height:100%;
    width:100%;
  }
</style>