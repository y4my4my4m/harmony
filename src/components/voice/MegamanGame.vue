<template>
  <div v-if="isActive" class="megaman-game-overlay">
    <canvas ref="canvasRef" class="megaman-canvas" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { debug } from '@/utils/debug'
import { supabase } from '@/supabase'

interface Props {
  isActive: boolean
  channelId: string
  userId: string
  participants: Array<{ userId: string; username?: string }>
}

const props = defineProps<Props>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let animationFrame: number | null = null
let lastFrameTime = 0

// Game state
interface Player {
  userId: string
  x: number
  y: number
  facing: 'left' | 'right'
  state: 'idle' | 'walking' | 'jumping' | 'falling' | 'landing' | 'shooting' | 'dashing' | 'wallCling'
  velocityX: number
  velocityY: number
  onGround: boolean
  onWall: boolean
  wallSide: 'left' | 'right' | null
  color: string
  isShooting: boolean
  isCharging: boolean
  chargeLevel: number // 0-3
  chargeStartTime: number
  lastShotTime: number
  dashCooldown: number
  canDash: boolean
}

interface Bullet {
  id: string
  userId: string
  x: number
  y: number
  velocityX: number
  velocityY: number
  chargeLevel: number // 0-3
  sprite: string | null
  color: string
}

const players = ref<Map<string, Player>>(new Map())
const bullets = ref<Map<string, Bullet>>(new Map())
const keys = ref<Set<string>>(new Set())
let bulletIdCounter = 0

// Sprite loading - individual images
interface AnimationFrame {
  name: string
  file: string
}

interface Animations {
  idle: AnimationFrame[]
  walk: AnimationFrame[]
  jump: AnimationFrame[]
  shoot: AnimationFrame[]
  fall: AnimationFrame[]
  land: AnimationFrame[]
  dash?: AnimationFrame[]
  wall?: AnimationFrame[]
}

const animations = ref<Animations | null>(null)
const spriteImages = ref<Map<string, HTMLImageElement>>(new Map())
const busterSprites = ref<Map<string, HTMLImageElement>>(new Map())
const busterData = ref<any>(null)
const currentFrame = ref<Map<string, number>>(new Map())
const frameTime = ref<Map<string, number>>(new Map()) // Use time instead of timer
const chargeFrame = ref<Map<string, number>>(new Map()) // For charge animation

// Constants
const GRAVITY = 0.8
const JUMP_STRENGTH = -15
const WALL_JUMP_X = 6
const WALL_JUMP_Y = -12
const WALL_SLIDE_SPEED = 2
const WALK_SPEED = 3
const DASH_SPEED = 10
const DASH_DURATION = 200 // ms
const DASH_COOLDOWN = 500 // ms
const FRAME_DURATION = 200 // ms per frame (slower animation)
const BULLET_SPEED = 8
const CHARGE_TIME_LV1 = 500 // ms
const CHARGE_TIME_LV2 = 1500 // ms
const CHARGE_TIME_LV3 = 3000 // ms

// Player colors for differentiation
const PLAYER_COLORS = [
  '#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', 
  '#f0932b', '#eb4d4b', '#6c5ce7', '#a29bfe'
]

// Sound effects - try multiple possible paths
const soundPaths = {
  jump: [
    '/assets/sounds/easteregg/jump.mp3',
    '/assets/sounds/easteregg/jump.wav',
    '/assets/sounds/unsorted/jump_1.mp3',
  ],
  shoot: [
    '/assets/sounds/easteregg/shoot.mp3',
    '/assets/sounds/easteregg/shoot.wav',
    '/assets/sounds/unsorted/beep_1.mp3',
  ],
  walk: [
    '/assets/sounds/easteregg/walk.mp3',
    '/assets/sounds/easteregg/walk.wav',
  ],
  dash: [
    '/assets/sounds/easteregg/dash.mp3',
    '/assets/sounds/easteregg/dash.wav',
  ],
  charge: [
    '/assets/sounds/easteregg/charge.mp3',
    '/assets/sounds/easteregg/charge.wav',
  ],
}

// Create sound pool for better performance
const soundPool: Map<string, HTMLAudioElement[]> = new Map()
let soundsInitialized = false

function initializeSounds() {
  if (soundsInitialized) return
  
  // Pre-create sounds on first user interaction
  const initSound = (key: keyof typeof soundPaths) => {
    const paths = soundPaths[key]
    const pool: HTMLAudioElement[] = []
    
    for (const path of paths) {
      try {
        const audio = new Audio(path)
        audio.volume = 0.3
        audio.preload = 'auto'
        // Try to load (this might fail without user interaction)
        try {
          audio.load()
        } catch {
          // Ignore
        }
        pool.push(audio)
      } catch (e) {
        // Continue
      }
    }
    
    if (pool.length > 0) {
      soundPool.set(key, pool)
    }
  }
  
  Object.keys(soundPaths).forEach(key => initSound(key as keyof typeof soundPaths))
  soundsInitialized = true
}

function playSound(soundName: keyof typeof soundPaths) {
  try {
    initializeSounds()
    
    // Get or create sound from pool
    if (!soundPool.has(soundName)) {
      const paths = soundPaths[soundName]
      const pool: HTMLAudioElement[] = []
      
      for (const path of paths) {
        try {
          const audio = new Audio(path)
          audio.volume = 0.3
          audio.preload = 'auto'
          pool.push(audio)
        } catch (e) {
          // Continue
        }
      }
      
      if (pool.length > 0) {
        soundPool.set(soundName, pool)
      } else {
        return
      }
    }
    
    const pool = soundPool.get(soundName)
    if (!pool || pool.length === 0) return
    
    // Find an available sound (not playing)
    let sound = pool.find(s => s.paused || s.ended)
    
    // If all sounds are playing, create a new one
    if (!sound) {
      const paths = soundPaths[soundName]
      for (const path of paths) {
        try {
          const audio = new Audio(path)
          audio.volume = 0.3
          pool.push(audio)
          sound = audio
          break
        } catch (e) {
          // Continue
        }
      }
      
      if (!sound) {
        sound = pool[0] // Reuse first one
      }
    }
    
    // Play sound
    sound.currentTime = 0
    sound.play().catch(() => {
      // Ignore errors (user interaction required, etc.)
    })
  } catch (error) {
    // Ignore sound errors
  }
}

// Load animations JSON
async function loadAnimations() {
  try {
    debug.log('🎮 Loading animations.json...')
    const response = await fetch('/assets/easteregg/megaman/sprites/animations.json')
    if (response.ok) {
      animations.value = await response.json()
      debug.log('🎮 Loaded animations:', {
        idle: animations.value?.idle?.length || 0,
        walk: animations.value?.walk?.length || 0,
        jump: animations.value?.jump?.length || 0,
        dash: animations.value?.dash?.length || 0,
        wall: animations.value?.wall?.length || 0,
      })
      
      // Load all sprite images
      await loadSpriteImages()
      await loadBusterSprites()
    } else {
      debug.warn('Could not load animations.json:', response.status, response.statusText)
    }
  } catch (error) {
    debug.error('Error loading animations:', error)
  }
}

// Load all sprite images
async function loadSpriteImages() {
  if (!animations.value) {
    debug.warn('🎮 Cannot load sprites: animations not loaded')
    return
  }
  
  const allFrames: AnimationFrame[] = [
    ...(animations.value.idle || []),
    ...(animations.value.walk || []),
    ...(animations.value.jump || []),
    ...(animations.value.shoot || []),
    ...(animations.value.fall || []),
    ...(animations.value.land || []),
    ...(animations.value.dash || []),
    ...(animations.value.wall || []),
  ]
  
  debug.log(`🎮 Loading ${allFrames.length} sprite images...`)
  
  const loadPromises = allFrames.map(frame => {
    return new Promise<void>((resolve) => {
      // Check if already loaded
      if (spriteImages.value.has(frame.file)) {
        resolve()
        return
      }
      
      const img = new Image()
      img.onload = () => {
        spriteImages.value.set(frame.file, img)
        resolve()
      }
      img.onerror = () => {
        debug.warn(`❌ Failed to load sprite: ${frame.file}`)
        resolve()
      }
      const spritePath = `/assets/easteregg/megaman/sprites/${frame.file}`
      img.src = spritePath
    })
  })
  
  await Promise.all(loadPromises)
  debug.log(`🎮 Loaded ${spriteImages.value.size}/${allFrames.length} sprite images`)
}

// Load buster/ammo sprites
async function loadBusterSprites() {
  try {
    // Load buster sprite mapping
    const response = await fetch('/assets/easteregg/megaman/sprites/busters.json')
    if (response.ok) {
      busterData.value = await response.json()
      debug.log('🎮 Loaded buster data:', busterData.value)
      
      // Load all buster sprite images
      const allBusterFrames: Array<{name: string, file: string}> = []
      
      for (const frames of Object.values(busterData.value)) {
        if (Array.isArray(frames)) {
          for (const frame of frames) {
            allBusterFrames.push(frame)
          }
        }
      }
      
      debug.log(`🎮 Loading ${allBusterFrames.length} buster sprite images...`)
      
      const loadPromises = allBusterFrames.map(frame => {
        return new Promise<void>((resolve) => {
          if (busterSprites.value.has(frame.file)) {
            resolve()
            return
          }
          
          const img = new Image()
          img.onload = () => {
            busterSprites.value.set(frame.file, img)
            resolve()
          }
          img.onerror = () => {
            debug.warn(`❌ Failed to load buster sprite: ${frame.file}`)
            resolve()
          }
          const spritePath = `/assets/easteregg/megaman/sprites/${frame.file}`
          img.src = spritePath
        })
      })
      
      await Promise.all(loadPromises)
      debug.log(`🎮 Loaded ${busterSprites.value.size}/${allBusterFrames.length} buster sprites`)
    } else {
      debug.warn('Could not load busters.json')
    }
  } catch (error) {
    debug.error('Error loading buster sprites:', error)
  }
}

// Initialize players
function initializePlayers() {
  players.value.clear()
  currentFrame.value.clear()
  frameTime.value.clear()
  
  // Get canvas dimensions
  const canvasHeight = canvas ? canvas.height / (window.devicePixelRatio || 1) : 300
  const floorY = canvasHeight - 20 // Floor is 20px from bottom
  
  debug.log(`🎮 Initializing ${props.participants.length} players`)
  
  props.participants.forEach((participant, index) => {
    const player: Player = {
      userId: participant.userId,
      x: 50 + index * 120,
      y: floorY - 64,
      facing: 'right',
      state: 'idle',
      velocityX: 0,
      velocityY: 0,
      onGround: true,
      onWall: false,
      wallSide: null,
      color: PLAYER_COLORS[index % PLAYER_COLORS.length],
      isShooting: false,
      isCharging: false,
      chargeLevel: 0,
      chargeStartTime: 0,
      lastShotTime: 0,
      dashCooldown: 0,
      canDash: true
    }
    
    players.value.set(participant.userId, player)
    currentFrame.value.set(participant.userId, 0)
    frameTime.value.set(participant.userId, 0)
    chargeFrame.value.set(participant.userId, 0)
    
    debug.log(`🎮 Created player: ${participant.userId} at (${player.x}, ${player.y})`)
  })
  
  debug.log(`🎮 Total players: ${players.value.size}`)
}

// Handle keyboard input
function handleKeyDown(event: KeyboardEvent) {
  if (!props.isActive) return
  
  // Use arrow keys, space, and shift
  const key = event.code
  keys.value.add(key)
  
  // Prevent default for game keys
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space', 'ShiftLeft', 'ShiftRight'].includes(key)) {
    event.preventDefault()
  }
  
  // Initialize sounds on first key press
  if (!soundsInitialized) {
    initializeSounds()
    // Try to play a silent sound to unlock audio
    playSound('shoot')
  }
  
  handleInput()
}

function handleKeyUp(event: KeyboardEvent) {
  const key = event.code
  keys.value.delete(key)
  
  const localPlayer = players.value.get(props.userId)
  if (!localPlayer) return
  
  // Release charge shot - only fire on release, not while holding
  if (key === 'Space') {
    const now = Date.now()
    const chargeTime = now - localPlayer.chargeStartTime
    
    if (localPlayer.isCharging) {
      // Fire based on charge level
      if (chargeTime >= CHARGE_TIME_LV1) {
        // Charged shot
        fireChargedShot(localPlayer)
      } else {
        // Quick tap = uncharged shot
        fireBullet(localPlayer, 0)
        playSound('shoot')
      }
    } else {
      // Very quick tap without charging state
      fireBullet(localPlayer, 0)
      playSound('shoot')
    }
    
    localPlayer.isCharging = false
    localPlayer.chargeLevel = 0
    localPlayer.chargeStartTime = 0
    localPlayer.isShooting = false
  }
  
  handleInput()
}

function handleInput() {
  const localPlayer = players.value.get(props.userId)
  if (!localPlayer) return
  
  const now = Date.now()
  
  // Dash (Shift)
  if ((keys.value.has('ShiftLeft') || keys.value.has('ShiftRight')) && localPlayer.canDash && now - localPlayer.dashCooldown >= DASH_COOLDOWN) {
    if (localPlayer.onGround || localPlayer.onWall) {
      localPlayer.state = 'dashing'
      localPlayer.velocityX = localPlayer.facing === 'right' ? DASH_SPEED : -DASH_SPEED
      localPlayer.canDash = false
      localPlayer.dashCooldown = now
      playSound('dash')
      
      // End dash after duration
      setTimeout(() => {
        if (localPlayer.state === 'dashing') {
          localPlayer.state = localPlayer.velocityX !== 0 ? 'walking' : 'idle'
          localPlayer.velocityX *= 0.5 // Slow down after dash
        }
        localPlayer.canDash = true
      }, DASH_DURATION)
    }
  }
  
  // Charging (hold Space) - only update charge, don't fire here
  if (keys.value.has('Space')) {
    if (!localPlayer.isCharging) {
      localPlayer.isCharging = true
      localPlayer.chargeStartTime = now
      localPlayer.chargeLevel = 0
      localPlayer.isShooting = true
    } else {
      // Update charge level
      const chargeTime = now - localPlayer.chargeStartTime
      if (chargeTime >= CHARGE_TIME_LV3) {
        localPlayer.chargeLevel = 3
      } else if (chargeTime >= CHARGE_TIME_LV2) {
        localPlayer.chargeLevel = 2
      } else if (chargeTime >= CHARGE_TIME_LV1) {
        localPlayer.chargeLevel = 1
      }
      
      // Play charge sound occasionally
      if (chargeTime % 500 < 50 && chargeTime > 100) {
        playSound('charge')
      }
    }
  }
  
  // Movement with arrow keys
  if (localPlayer.state !== 'dashing') {
    if (keys.value.has('ArrowLeft')) {
      localPlayer.velocityX = -WALK_SPEED
      localPlayer.facing = 'left'
      if (localPlayer.onGround && !localPlayer.isCharging) {
        localPlayer.state = 'walking'
      }
    } else if (keys.value.has('ArrowRight')) {
      localPlayer.velocityX = WALK_SPEED
      localPlayer.facing = 'right'
      if (localPlayer.onGround && !localPlayer.isCharging) {
        localPlayer.state = 'walking'
      }
    } else {
      localPlayer.velocityX = 0
      if (localPlayer.onGround && localPlayer.state !== 'jumping' && localPlayer.state !== 'falling' && localPlayer.state !== 'landing' && (localPlayer.state as string) !== 'dashing') {
        localPlayer.state = localPlayer.isCharging ? 'shooting' : 'idle'
      }
    }
  }
  
  // Jump (ArrowUp)
  if (keys.value.has('ArrowUp')) {
    if (localPlayer.onWall && localPlayer.wallSide) {
      // Wall jump
      localPlayer.velocityY = WALL_JUMP_Y
      localPlayer.velocityX = localPlayer.wallSide === 'left' ? WALL_JUMP_X : -WALL_JUMP_X
      localPlayer.onWall = false
      localPlayer.wallSide = null
      localPlayer.state = 'jumping'
      playSound('jump')
    } else if (localPlayer.onGround && localPlayer.state !== 'jumping') {
      localPlayer.velocityY = JUMP_STRENGTH
      localPlayer.onGround = false
      localPlayer.state = 'jumping'
      playSound('jump')
    }
  }
  
  // Play walk sound when moving
  if (localPlayer.velocityX !== 0 && localPlayer.onGround && Math.random() < 0.05) {
    playSound('walk')
  }
  
  // Broadcast player state
  broadcastPlayerState(localPlayer)
}

// Fire a bullet (uncharged or charged)
function fireBullet(player: Player, chargeLevel: number = 0) {
  if (!props.channelId) return
  
  const bulletId = `bullet-${bulletIdCounter++}-${Date.now()}`
  const bulletX = player.facing === 'right' ? player.x + 64 : player.x
  const bulletY = player.y + 32 // Center of player
  
  // Bullet size and speed based on charge level
  const speed = BULLET_SPEED * (1 + chargeLevel * 0.5)
  
  // Get buster sprite for this charge level
  let spriteFile: string | null = null
  if (busterData.value) {
    if (chargeLevel === 0 && busterData.value.Buster_LV0) {
      spriteFile = busterData.value.Buster_LV0[0]?.file || null
    } else if (chargeLevel === 1 && busterData.value.Buster_LV1) {
      // Use Fire1 sprite
      const fireSprite = busterData.value.Buster_LV1.find((f: any) => f.name.includes('Fire1'))
      spriteFile = fireSprite?.file || busterData.value.Buster_LV1[0]?.file || null
    } else if (chargeLevel === 2 && busterData.value.Buster_LV2) {
      const fireSprite = busterData.value.Buster_LV2.find((f: any) => f.name.includes('Fire1'))
      spriteFile = fireSprite?.file || busterData.value.Buster_LV2[0]?.file || null
    } else if (chargeLevel === 3 && busterData.value.Buster_LV3) {
      spriteFile = busterData.value.Buster_LV3[0]?.file || null
    }
  }
  
  const bullet: Bullet = {
    id: bulletId,
    userId: player.userId,
    x: bulletX,
    y: bulletY,
    velocityX: player.facing === 'right' ? speed : -speed,
    velocityY: 0,
    chargeLevel: chargeLevel,
    sprite: spriteFile,
    color: player.color
  }
  
  bullets.value.set(bulletId, bullet)
  
  // Broadcast bullet creation
  const channel = supabase.channel(`megaman-game:${props.channelId}`)
  channel.send({
    type: 'broadcast',
    event: 'bullet-fired',
    payload: bullet
  })
  
  // Remove bullet after time based on charge level
  const lifetime = 3000 + chargeLevel * 1000
  setTimeout(() => {
    bullets.value.delete(bulletId)
  }, lifetime)
  
  player.lastShotTime = Date.now()
}

function fireChargedShot(player: Player) {
  if (player.chargeLevel > 0) {
    fireBullet(player, player.chargeLevel)
    playSound('shoot')
  }
}

// Broadcast player state to other participants
function broadcastPlayerState(player: Player) {
  if (!props.channelId) return
  
  const channel = supabase.channel(`megaman-game:${props.channelId}`)
  channel.send({
    type: 'broadcast',
    event: 'player-update',
    payload: {
      userId: player.userId,
      x: player.x,
      y: player.y,
      facing: player.facing,
      state: player.state,
      velocityX: player.velocityX,
      velocityY: player.velocityY,
      isShooting: player.isShooting,
      isCharging: player.isCharging,
      chargeLevel: player.chargeLevel,
      onWall: player.onWall,
      wallSide: player.wallSide,
    }
  })
}

// Game loop with delta time
function gameLoop(currentTime: number) {
  if (!canvas || !ctx) {
    debug.warn('🎮 Canvas or context not available')
    return
  }
  
  // Calculate delta time
  const deltaTime = lastFrameTime > 0 ? currentTime - lastFrameTime : 16.67 // Default to ~60fps
  lastFrameTime = currentTime
  const deltaSeconds = deltaTime / 1000 // Convert to seconds
  
  // Get actual canvas dimensions (accounting for DPR scaling)
  const dpr = window.devicePixelRatio || 1
  const canvasWidth = canvas.width / dpr
  const canvasHeight = canvas.height / dpr
  const floorY = canvasHeight - 20 // Floor is 20px from bottom
  const wallLeft = 0
  const wallRight = canvasWidth
  
  // Clear canvas
  ctx.fillStyle = 'rgba(26, 26, 46, 0.9)' // Semi-transparent
  ctx.fillRect(0, 0, canvasWidth, canvasHeight)
  
  // Draw floor
  ctx.fillStyle = '#16213e'
  ctx.fillRect(0, floorY, canvasWidth, canvasHeight - floorY)
  
  // Draw walls (for wall sliding)
  ctx.fillStyle = '#1a2e3a'
  ctx.fillRect(0, 0, 5, canvasHeight) // Left wall
  ctx.fillRect(canvasWidth - 5, 0, 5, canvasHeight) // Right wall
  
  // Debug: Draw player count
  if (players.value.size === 0) {
    ctx.fillStyle = '#fff'
    ctx.font = '16px monospace'
    ctx.fillText('No players initialized', 10, 30)
    debug.warn('🎮 No players in game')
  }
  
  // Update bullets
  bullets.value.forEach((bullet, bulletId) => {
    bullet.x += bullet.velocityX * deltaSeconds * 60 // Scale by delta
    bullet.y += bullet.velocityY * deltaSeconds * 60
    
    // Remove bullets that go off screen
    if (bullet.x < -20 || bullet.x > canvasWidth + 20 || bullet.y < -20 || bullet.y > canvasHeight + 20) {
      bullets.value.delete(bulletId)
    }
    
    // Draw bullet using buster sprite
    if (ctx) {
      if (bullet.sprite && busterSprites.value.has(bullet.sprite)) {
        const spriteImg = busterSprites.value.get(bullet.sprite)!
        if (spriteImg && spriteImg.complete && spriteImg.naturalWidth > 0) {
          const spriteWidth = spriteImg.naturalWidth
          const spriteHeight = spriteImg.naturalHeight
          const scale = spriteWidth > 100 ? 0.5 : 1
          const drawWidth = spriteWidth * scale
          const drawHeight = spriteHeight * scale
          
          ctx.drawImage(
            spriteImg,
            bullet.x - drawWidth / 2,
            bullet.y - drawHeight / 2,
            drawWidth,
            drawHeight
          )
        } else {
          // Fallback to colored rectangle
          const bulletSize = 8 + bullet.chargeLevel * 4
          ctx.fillStyle = bullet.color
          ctx.fillRect(bullet.x - bulletSize/2, bullet.y - bulletSize/2, bulletSize, bulletSize)
        }
      } else {
        // Fallback to colored rectangle if sprite not loaded
        const bulletSize = 8 + bullet.chargeLevel * 4
        ctx.fillStyle = bullet.chargeLevel === 0 ? bullet.color : 
                        bullet.chargeLevel === 1 ? '#ffff00' :
                        bullet.chargeLevel === 2 ? '#ff8800' : '#ff0000'
        ctx.fillRect(bullet.x - bulletSize/2, bullet.y - bulletSize/2, bulletSize, bulletSize)
      }
    }
  })
  
  // Update and draw players
  players.value.forEach((player, userId) => {
    // Update physics
    if (!player.onGround && !player.onWall) {
      player.velocityY += GRAVITY * deltaSeconds * 60
    }
    
    // Wall detection
    const wallThreshold = 5
    const isNearLeftWall = player.x <= wallLeft + wallThreshold
    const isNearRightWall = player.x >= wallRight - wallThreshold - 64
    
    if ((isNearLeftWall || isNearRightWall) && !player.onGround && player.velocityY > 0) {
      // Can wall cling
      if (keys.value.has('ArrowLeft') && isNearLeftWall) {
        player.onWall = true
        player.wallSide = 'left'
        player.velocityY = WALL_SLIDE_SPEED // Slide down slowly
        player.state = 'wallCling'
      } else if (keys.value.has('ArrowRight') && isNearRightWall) {
        player.onWall = true
        player.wallSide = 'right'
        player.velocityY = WALL_SLIDE_SPEED
        player.state = 'wallCling'
      } else {
        player.onWall = false
        player.wallSide = null
      }
    } else {
      player.onWall = false
      player.wallSide = null
    }
    
    player.x += player.velocityX * deltaSeconds * 60
    player.y += player.velocityY * deltaSeconds * 60
    
    // Ground collision
    if (player.y >= floorY - 64) {
      if (!player.onGround) {
        // Just landed
        player.state = 'landing'
        setTimeout(() => {
          if (player.state === 'landing') {
            player.state = player.velocityX !== 0 ? 'walking' : (player.isCharging ? 'shooting' : 'idle')
          }
        }, 200)
      }
      player.y = floorY - 64
      player.velocityY = 0
      player.onGround = true
      player.onWall = false
      player.wallSide = null
    } else {
      player.onGround = false
    }
    
    // Update state based on velocity when in air
    if (!player.onGround && !player.onWall && (player.state as string) !== 'dashing') {
      if (player.velocityY > 0) {
        player.state = player.isCharging ? 'shooting' : 'falling'
      } else if (player.velocityY < 0) {
        player.state = player.isCharging ? 'shooting' : 'jumping'
      }
    }
    
    // Boundary collision
    if (player.x < 0) {
      player.x = 0
      if (!player.onGround) {
        player.onWall = true
        player.wallSide = 'left'
      }
    }
    if (player.x > canvasWidth - 64) {
      player.x = canvasWidth - 64
      if (!player.onGround) {
        player.onWall = true
        player.wallSide = 'right'
      }
    }
    
    // Draw player
    drawPlayer(player, userId, deltaSeconds)
  })
  
  animationFrame = requestAnimationFrame(gameLoop)
}

// Get current animation frames based on player state
function getAnimationFrames(player: Player): AnimationFrame[] {
  if (!animations.value) {
    debug.warn('🎮 Animations not loaded yet')
    return []
  }
  
  // Wall cling takes priority
  if (player.onWall && player.state === 'wallCling') {
    return animations.value.wall || []
  }
  
  // Dash takes priority
  if (player.state === 'dashing') {
    return animations.value.dash || animations.value.walk || []
  }
  
  // Shooting takes priority - use shoot animation that matches current state
  if (player.isCharging || player.isShooting) {
    // Find shooting animation that matches current movement state
    const shootFrames = animations.value.shoot.filter(frame => {
      const name = frame.name.toLowerCase()
      if (player.state === 'idle' && name.includes('idle')) return true
      if (player.state === 'walking' && name.includes('run')) return true
      if (player.state === 'jumping' && name.includes('jump')) return true
      if (player.state === 'falling' && name.includes('fall')) return true
      if (player.state === 'dashing' && name.includes('dash')) return true
      return false
    })
    
    if (shootFrames.length > 0) {
      return shootFrames
    }
    // Fallback to idle fire
    const idleFire = animations.value.shoot.filter(f => f.name.toLowerCase().includes('idle'))
    if (idleFire.length > 0) return idleFire
  }
  
  // Normal animations
  switch (player.state) {
    case 'walking':
      return animations.value.walk || []
    case 'jumping':
      return animations.value.jump || []
    case 'falling':
      return animations.value.fall || []
    case 'landing':
      return animations.value.land || []
    case 'idle':
    default:
      return animations.value.idle || []
  }
}

// Draw player sprite with delta time
function drawPlayer(player: Player, userId: string, deltaSeconds: number) {
  if (!ctx) {
    debug.warn('🎮 No canvas context for drawing')
    return
  }
  
  const frames = getAnimationFrames(player)
  
  // Always draw something, even if animations aren't loaded
  if (frames.length === 0 || !animations.value) {
    // Draw placeholder
    ctx.fillStyle = player.color
    ctx.fillRect(player.x, player.y, 64, 64)
    
    // Draw charge indicator
    if (player.isCharging && player.chargeLevel > 0) {
      ctx.fillStyle = player.chargeLevel === 1 ? '#ffff00' :
                      player.chargeLevel === 2 ? '#ff8800' : '#ff0000'
      ctx.fillRect(player.x + 20, player.y - 10, 24, 4)
    }
    
    // Draw simple face
    ctx.fillStyle = '#000'
    ctx.fillRect(player.x + 16, player.y + 16, 8, 8) // Left eye
    ctx.fillRect(player.x + 40, player.y + 16, 8, 8) // Right eye
    ctx.fillRect(player.x + 20, player.y + 40, 24, 8) // Mouth
    return
  }
  
  // Update frame timer using delta time
  const currentTime = frameTime.value.get(userId) || 0
  const newTime = currentTime + (deltaSeconds * 1000) // Add delta in ms
  frameTime.value.set(userId, newTime)
  
  if (newTime >= FRAME_DURATION) {
    const current = currentFrame.value.get(userId) || 0
    const next = (current + 1) % frames.length
    currentFrame.value.set(userId, next)
    frameTime.value.set(userId, 0) // Reset timer
  }
  
  const frameIndex = currentFrame.value.get(userId) || 0
  const frame = frames[frameIndex]
  
  if (!frame) {
    // Draw placeholder if no frame
    ctx.fillStyle = player.color
    ctx.fillRect(player.x, player.y, 64, 64)
    return
  }
  
  // Get sprite image
  const spriteImg = spriteImages.value.get(frame.file)
  
  if (spriteImg && spriteImg.complete && spriteImg.naturalWidth > 0) {
    // Draw sprite - get actual sprite dimensions
    const spriteWidth = spriteImg.naturalWidth
    const spriteHeight = spriteImg.naturalHeight
    
    // Scale down if sprite is 2x resolution (Scratch uses 2x bitmaps)
    const scale = spriteWidth > 100 ? 0.5 : 1
    const drawWidth = spriteWidth * scale
    const drawHeight = spriteHeight * scale
    
    ctx.save()
    
    // Flip horizontally if facing left
    if (player.facing === 'left') {
      ctx.scale(-1, 1)
      ctx.drawImage(
        spriteImg,
        -player.x - drawWidth, // Adjust for flipped position
        player.y,
        drawWidth,
        drawHeight
      )
    } else {
      ctx.drawImage(
        spriteImg,
        player.x,
        player.y,
        drawWidth,
        drawHeight
      )
    }
    
    ctx.restore()
    
    // Draw charging animation sprite overlay
    if (player.isCharging && busterData.value) {
      let chargeFrames: any[] = []
      let chargeFrameIndex = 0
      
      // Get charge frames based on level
      if (player.chargeLevel >= 1 && busterData.value.Buster_LV1) {
        // Get non-Fire frames (the charging animation frames)
        chargeFrames = busterData.value.Buster_LV1.filter((f: any) => 
          !f.name.includes('Fire') && !f.name.includes('Hit')
        )
        // Animate through charge frames
        const chargeTime = Date.now() - player.chargeStartTime
        chargeFrameIndex = Math.floor((chargeTime / 100) % chargeFrames.length)
      }
      
      if (player.chargeLevel >= 2 && busterData.value.Buster_LV2) {
        chargeFrames = busterData.value.Buster_LV2.filter((f: any) => 
          !f.name.includes('Fire') && !f.name.includes('Hit')
        )
        const chargeTime = Date.now() - player.chargeStartTime
        chargeFrameIndex = Math.floor((chargeTime / 150) % chargeFrames.length)
      }
      
      if (player.chargeLevel >= 3 && busterData.value.Buster_LV3) {
        chargeFrames = busterData.value.Buster_LV3
        const chargeTime = Date.now() - player.chargeStartTime
        chargeFrameIndex = Math.floor((chargeTime / 200) % chargeFrames.length)
      }
      
      // Draw charge sprite overlay
      if (chargeFrames.length > 0 && chargeFrameIndex < chargeFrames.length) {
        const chargeFrame = chargeFrames[chargeFrameIndex]
        const chargeSprite = busterSprites.value.get(chargeFrame.file)
        
        if (chargeSprite && chargeSprite.complete && chargeSprite.naturalWidth > 0) {
          const chargeWidth = chargeSprite.naturalWidth
          const chargeHeight = chargeSprite.naturalHeight
          const chargeScale = chargeWidth > 100 ? 0.5 : 1
          const chargeDrawWidth = chargeWidth * chargeScale
          const chargeDrawHeight = chargeHeight * chargeScale
          
          // Position charge sprite in front of player (arm position)
          const chargeX = player.facing === 'right' ? player.x + 40 : player.x - 20
          const chargeY = player.y + 20
          
          ctx.save()
          if (player.facing === 'left') {
            ctx.scale(-1, 1)
            ctx.drawImage(
              chargeSprite,
              -chargeX - chargeDrawWidth,
              chargeY,
              chargeDrawWidth,
              chargeDrawHeight
            )
          } else {
            ctx.drawImage(
              chargeSprite,
              chargeX,
              chargeY,
              chargeDrawWidth,
              chargeDrawHeight
            )
          }
          ctx.restore()
        }
      }
    }
  } else {
    // Draw placeholder if sprite not loaded
    ctx.fillStyle = player.color
    ctx.fillRect(player.x, player.y, 64, 64)
    
    // Draw simple face
    ctx.fillStyle = '#000'
    ctx.fillRect(player.x + 16, player.y + 16, 8, 8) // Left eye
    ctx.fillRect(player.x + 40, player.y + 16, 8, 8) // Right eye
    ctx.fillRect(player.x + 20, player.y + 40, 24, 8) // Mouth
    
    // Draw charge indicator
    if (player.isCharging && player.chargeLevel > 0) {
      ctx.fillStyle = player.chargeLevel === 1 ? '#ffff00' :
                      player.chargeLevel === 2 ? '#ff8800' : '#ff0000'
      ctx.fillRect(player.x + 20, player.y - 10, 24, 4)
    }
  }
}

// Setup Supabase realtime listener
let gameChannel: ReturnType<typeof supabase.channel> | null = null

function setupRealtimeListener() {
  if (!props.channelId) return
  
  gameChannel = supabase.channel(`megaman-game:${props.channelId}`, {
    config: { broadcast: { self: false } }
  })
  
  gameChannel.on('broadcast', { event: 'player-update' }, (payload) => {
    const { userId, x, y, facing, state, velocityX, velocityY, isShooting, isCharging, chargeLevel, onWall, wallSide } = payload.payload as any
    
    // Don't update local player from remote updates
    if (userId === props.userId) return
    
    const player = players.value.get(userId)
    if (player) {
      player.x = x
      player.y = y
      player.facing = facing
      player.state = state
      player.velocityX = velocityX
      player.velocityY = velocityY
      player.isShooting = isShooting || false
      player.isCharging = isCharging || false
      player.chargeLevel = chargeLevel || 0
      player.onWall = onWall || false
      player.wallSide = wallSide || null
    }
  })
  
  gameChannel.on('broadcast', { event: 'bullet-fired' }, (payload) => {
    const bullet = payload.payload as Bullet
    
    // Don't add our own bullets (we already created them locally)
    if (bullet.userId === props.userId) return
    
    // Add remote bullet
    bullets.value.set(bullet.id, bullet)
    
    // Remove bullet after time
    const lifetime = 3000 + (bullet.chargeLevel || 0) * 1000
    setTimeout(() => {
      bullets.value.delete(bullet.id)
    }, lifetime)
  })
  
  gameChannel.subscribe()
}

// Watch for active state
watch(() => props.isActive, (active) => {
  if (active) {
    initializeCanvas()
    // Start game loop immediately so we can see placeholders
    startGame()
    // Then initialize players and load assets
    initializePlayers()
    loadAnimations().then(() => {
      debug.log('🎮 Animations and sprites loaded')
    })
    setupRealtimeListener()
  } else {
    stopGame()
  }
})

function initializeCanvas() {
  if (!canvasRef.value) return
  
  canvas = canvasRef.value
  ctx = canvas.getContext('2d')
  
  // Set canvas size - smaller for overlay on voice chat
  const canvasWidth = 600
  const canvasHeight = 300
  
  // Scale for high DPI displays
  const dpr = window.devicePixelRatio || 1
  canvas.width = canvasWidth * dpr
  canvas.height = canvasHeight * dpr
  ctx?.scale(dpr, dpr)
  canvas.style.width = `${canvasWidth}px`
  canvas.style.height = `${canvasHeight}px`
  
  lastFrameTime = 0
}

function startGame() {
  if (animationFrame) return
  lastFrameTime = performance.now()
  animationFrame = requestAnimationFrame(gameLoop)
  
  // Add event listeners
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  
  // Initialize sounds on first interaction
  window.addEventListener('click', initializeSounds, { once: true })
  window.addEventListener('keydown', initializeSounds, { once: true })
}

function stopGame() {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame)
    animationFrame = null
  }
  
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  
  if (gameChannel) {
    gameChannel.unsubscribe()
    gameChannel = null
  }
  
  lastFrameTime = 0
}

onMounted(() => {
  if (props.isActive) {
    initializeCanvas()
    // Start game loop immediately
    startGame()
    // Then initialize players and load assets
    initializePlayers()
    loadAnimations().then(() => {
      debug.log('🎮 Animations and sprites loaded')
    })
    setupRealtimeListener()
  }
})

onUnmounted(() => {
  stopGame()
})
</script>

<style scoped>
.megaman-game-overlay {
  position: absolute;
  bottom: 80px; /* Above voice controls */
  right: 20px;
  z-index: 10003; /* Above voice overlay */
  pointer-events: all;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}

.megaman-canvas {
  background: rgba(26, 26, 46, 0.95);
  border: 2px solid #4ecdc4;
  box-shadow: 0 0 20px rgba(78, 205, 196, 0.6);
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  display: block;
}
</style>
