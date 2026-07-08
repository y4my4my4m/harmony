<template>
  <canvas ref="canvas"></canvas>
</template>

<script setup lang="ts">
import { onMounted, ref, watchEffect } from 'vue'
import type { Point } from '@/types'

interface Avatar extends Point {
  color: string
}

interface Props {
  width: number
  height: number
  avatars: Avatar[]
}

const props = defineProps<Props>()

const canvas = ref<HTMLCanvasElement | null>(null)

onMounted(() => {
  if (!canvas.value) return
  const ctx = canvas.value.getContext('2d')
  if (!ctx) return

  // Use props.width and props.height for setting the canvas size
  canvas.value.width = props.width
  canvas.value.height = props.height

  const deformationDistance = 200 // Radius of significant deformation effect
  const maxDeformation = 15 // Maximum deformation
  const gravityFade = .5 // Adjust this value to control the fade-away of gravity
  const strength = 300
  const baseGridColor = { r: 255, g: 255, b: 255 }

  const calculateDeformation = (x: number, y: number): { point: { x: number, y: number }, color: string, colorWeight: number } => {
    let deformationX = 0
    let deformationY = 0
    let colorWeightSum = 0
    let blendedColor = { r:0, g:0, b: 0 }

    props.avatars.forEach(avatar => {
      const avatarCenterX = avatar.x + 24
      const avatarCenterY = avatar.y + 24
      const distance = Math.sqrt((x - avatarCenterX) ** 2 + (y - avatarCenterY) ** 2)

      if (distance < deformationDistance) {
        let deformation = strength / distance
        deformation *= Math.max(0, 1 - (distance / deformationDistance) * gravityFade)
        deformation = Math.min(maxDeformation, deformation)

        deformationX += deformation * (avatarCenterX - x) / distance
        deformationY += deformation * (avatarCenterY - y) / distance

        const weight = 1 - distance / deformationDistance
        colorWeightSum += weight
        // Ensure avatar.color is defined and extract RGB values
        if (avatar.color) {
          const colorMatch = avatar.color.match(/\d+/g)
          if (colorMatch && colorMatch.length === 3) {
            const [r, g, b] = colorMatch.map(Number)
            blendedColor.r += r * weight
            blendedColor.g += g * weight
            blendedColor.b += b * weight
          }
        }
      }
    })

    // black to color
    if (colorWeightSum > 0) {
      let avatarColor = {
        r: blendedColor.r / colorWeightSum,
        g: blendedColor.g / colorWeightSum,
        b: blendedColor.b / colorWeightSum
      }

      // Blend actual avatar color and base grid color
      // blendedColor = blendColors(avatarColor, baseGridColor, colorWeightSum);
      blendedColor = blendColors(avatarColor, baseGridColor, 1)
      
    }
    const colorString = `rgb(${Math.round(blendedColor.r)}, ${Math.round(blendedColor.g)}, ${Math.round(blendedColor.b)})`
    return { point: { x: deformationX, y: deformationY }, color: colorString, colorWeight: colorWeightSum }
   }

  // Blend two RGB colors based on a ratio
  const blendColors = (colorA: { r: number, g: number, b: number }, colorB: { r: number, g: number, b: number }, ratio: number) => {
    return {
      r: colorA.r * ratio + colorB.r * (1 - ratio),
      g: colorA.g * ratio + colorB.g * (1 - ratio),
      b: colorA.b * ratio + colorB.b * (1 - ratio)
    }
  }

  const calculateColor = (deformation: number, maxDeformation: number, baseColor: string, colorWeight: number): string => {
    const baseOpacity = Math.min(deformation / maxDeformation, 1)
    const opacity = baseOpacity + colorWeight * (1 - baseOpacity) // Blend the base opacity with the color weight
    return baseColor.replace('rgb', 'rgba').replace(')', `, ${opacity})`)
  }

  const drawGrid = () => {
    ctx.clearRect(0, 0, canvas.value!.width, canvas.value!.height)
    const gridSize = 20

    const drawLineSegment = (x1: number, y1: number, x2: number, y2: number, color: string) => {
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.strokeStyle = color
      ctx.stroke()
    }

    for (let y = 0; y <= canvas.value!.height; y += gridSize) {
      let lastX = 0
      let lastY = y
      for (let x = 0; x <= canvas.value!.width; x += gridSize) {
        const { point: deformation, color: baseColor, colorWeight } = calculateDeformation(x, y)
        const color = calculateColor(Math.sqrt(deformation.x ** 2 + deformation.y ** 2), maxDeformation, baseColor, colorWeight)
        drawLineSegment(lastX, lastY, x + deformation.x, y + deformation.y, color)
        lastX = x + deformation.x
        lastY = y + deformation.y
      }
    }

    for (let x = 0; x <= canvas.value!.width; x += gridSize) {
      let lastX = x
      let lastY = 0
      for (let y = 0; y <= canvas.value!.height; y += gridSize) {
        const { point: deformation, color: baseColor, colorWeight: colorWeight } = calculateDeformation(x, y)
        const color = calculateColor(Math.sqrt(deformation.x ** 2 + deformation.y ** 2), maxDeformation, baseColor, colorWeight)
        drawLineSegment(lastX, lastY, x + deformation.x, y + deformation.y, color)
        lastX = x + deformation.x
        lastY = y + deformation.y
      }
    }
  }

  const animate = () => {
    drawGrid()
    requestAnimationFrame(animate)
  }

  animate()
})

watchEffect(() => {
  if (canvas.value) {
    canvas.value.width = props.width
    canvas.value.height = props.height
  }
})
</script>

<style scoped>
  canvas {
    position: absolute;
    height: calc(100% + 10px);
    width: calc(100% + 10px);
    top:0;
    left:0;
    z-index: 30;
  }
</style>
