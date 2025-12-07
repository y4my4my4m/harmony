<template>
  <div v-if="isActive" class="megaman-game-overlay">
    <button class="close-button" @click="closeGame" title="Close game">
      <Icon name="x" />
    </button>
    <canvas ref="canvasRef" class="megaman-canvas" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { debug } from '@/utils/debug'
import { supabase } from '@/supabase'
import Icon from '@/components/common/Icon.vue'

interface Props {
  isActive: boolean
  channelId: string
  userId: string
  participants: Array<{ userId: string; username?: string }>
}

const props = defineProps<Props>()

const emit = defineEmits<{
  close: []
}>()

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
  state: 'idle' | 'walking' | 'jumping' | 'falling' | 'landing' | 'shooting' | 'dashing' | 'dashJumping' | 'wallCling' | 'wallKick' | 'hit' | 'dead'
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
  health: number
  maxHealth: number
  hitTime: number // When player was hit
  invulnerableUntil: number // Invulnerability timer
  canWallJump: boolean // Can wall jump (must press jump again)
  smokeEffects: Array<{ x: number; y: number; frame: number; createdAt: number }>
  lastJumpKeyPressed?: boolean // Track if jump key was pressed last frame
  lastDashKeyPressed?: boolean // Track if dash key was pressed last frame
  dashStartTime?: number // When dash started
  isSpawning?: boolean // True during intro animation
  spawnTime?: number // When spawn started
  spawnY?: number // Y position when spawning (comes from top)
  isDashJumping?: boolean // True when performing a dash-jump
  wallKickTime?: number // When wall kick animation started
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
  sprite2: string | null // For Fire1/Fire2 animation
  chargingSprites: string[] // Buster charging sprites for the projectile
  color: string
  createdAt: number
  damage: number
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
  dash_fire?: AnimationFrame[]
  wall?: AnimationFrame[]
  wall_cling?: AnimationFrame[]
  wall_kick?: AnimationFrame[]
  hit?: AnimationFrame[]
  death?: AnimationFrame[]
}

const animations = ref<Animations | null>(null)
const spriteImages = ref<Map<string, HTMLImageElement>>(new Map())
const busterSprites = ref<Map<string, HTMLImageElement>>(new Map())
const busterData = ref<any>(null)
const hpBarSprites = ref<Map<string, HTMLImageElement>>(new Map())
const hpBarData = ref<any>(null)
const currentFrame = ref<Map<string, number>>(new Map())
const frameTime = ref<Map<string, number>>(new Map()) // Use time instead of timer
const chargeFrame = ref<Map<string, number>>(new Map()) // For charge animation
const smokeSprites = ref<Map<string, HTMLImageElement>>(new Map())
const hitSprites = ref<Map<string, HTMLImageElement>>(new Map())
const readySprites = ref<Map<string, HTMLImageElement>>(new Map())
const deathBubbleSprites = ref<Map<string, HTMLImageElement>>(new Map())
const dashEffectSprites = ref<Map<string, HTMLImageElement>>(new Map())
let gameStartTime = 0
let showIntro = true
const introFrame = ref(0)
const introFrameTime = ref(0)
const gameCanvasWidth = ref(360) // Minimum 360
const gameCanvasHeight = ref(240) // Minimum 240
const playerResolutions = ref<Map<string, { width: number; height: number }>>(new Map())

// Constants
const GRAVITY = 0.8
const JUMP_STRENGTH = -15
const WALL_JUMP_X = 6
const WALL_JUMP_Y = -12
const WALL_SLIDE_SPEED = 1.5 // Slide down slowly (positive = down)
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

// Sound effects - using actual Megaman X sounds from Scratch project
const soundPaths = {
  jump: [
    '/assets/easteregg/x_jump.wav',
  ],
  shoot: [
    '/assets/easteregg/x_buster.wav',
  ],
  shootLv1: [
    '/assets/easteregg/x_buster_lv1.wav',
  ],
  shootLv2: [
    '/assets/easteregg/x_buster_lv2.wav',
  ],
  shootLv3: [
    '/assets/easteregg/x_buster_lv3.wav',
  ],
  land: [
    '/assets/easteregg/x_land.wav',
  ],
  dash: [
    '/assets/easteregg/x_dash.wav',
  ],
  charge: [
    '/assets/easteregg/x_charge.wav',
  ],
  chargeLoop: [
    '/assets/easteregg/x_charge_loop.wav',
  ],
  damage: [
    '/assets/easteregg/x_damage.wav',
  ],
  hit: [
    '/assets/easteregg/buster_hit.wav',
  ],
  death: [
    '/assets/easteregg/x_loselife.wav',
  ],
  spawn: [
    '/assets/easteregg/x_teleportdown.wav',
  ],
}

// Create sound pool for better performance
const soundPool: Map<string, HTMLAudioElement[]> = new Map()
const playingSounds: Map<string, HTMLAudioElement> = new Map() // Track currently playing looping sounds
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

function playSound(soundName: keyof typeof soundPaths, loop: boolean = false) {
  try {
    initializeSounds()
    
    // For looping sounds, check if already playing
    if (loop || soundName === 'chargeLoop') {
      const currentSound = playingSounds.get(soundName)
      if (currentSound && !currentSound.paused) {
        return // Already playing, don't restart
      }
    }
    
    const paths = soundPaths[soundName]
    if (!paths || paths.length === 0) return
    
    // Try to play sound - create new Audio each time for better reliability
    for (const path of paths) {
      try {
        const audio = new Audio(path)
        audio.loop = loop || soundName === 'chargeLoop'
        audio.volume = soundName === 'chargeLoop' ? 0.2 : 0.3 // Quieter for loop
        const playPromise = audio.play()
        if (playPromise) {
          playPromise.then(() => {
            // Store reference for looping sounds so we can stop them
            if (loop || soundName === 'chargeLoop') {
              playingSounds.set(soundName, audio)
            }
          }).catch((err) => {
            // Ignore errors - file might not exist or need user interaction
            debug.warn(`Could not play sound ${path}:`, err)
          })
        }
        // If we successfully created and attempted to play, break
        break
      } catch (e) {
        // Try next path
        continue
      }
    }
  } catch (error) {
    // Ignore sound errors - sounds are optional
  }
}

function stopSound(soundName: keyof typeof soundPaths) {
  const currentSound = playingSounds.get(soundName)
  if (currentSound) {
    currentSound.pause()
    currentSound.currentTime = 0
    playingSounds.delete(soundName)
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
      await loadHPBarSprites()
      await loadEffectSprites()
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

// Load HP bar sprites
async function loadHPBarSprites() {
  try {
    const response = await fetch('/assets/easteregg/megaman/sprites/hp_bars.json')
    if (response.ok) {
      hpBarData.value = await response.json()
      debug.log('🎮 Loaded HP bar data:', hpBarData.value)
      
      // Load all HP bar sprite images
      const allHPFrames: Array<{name: string, file: string}> = []
      
      for (const frames of Object.values(hpBarData.value)) {
        if (Array.isArray(frames)) {
          for (const frame of frames) {
            allHPFrames.push(frame)
          }
        }
      }
      
      debug.log(`🎮 Loading ${allHPFrames.length} HP bar sprite images...`)
      
      const loadPromises = allHPFrames.map(frame => {
        return new Promise<void>((resolve) => {
          if (hpBarSprites.value.has(frame.file)) {
            resolve()
            return
          }
          
          const img = new Image()
          img.onload = () => {
            hpBarSprites.value.set(frame.file, img)
            resolve()
          }
          img.onerror = () => {
            debug.warn(`❌ Failed to load HP bar sprite: ${frame.file}`)
            resolve()
          }
          const spritePath = `/assets/easteregg/megaman/sprites/${frame.file}`
          img.src = spritePath
        })
      })
      
      await Promise.all(loadPromises)
      debug.log(`🎮 Loaded ${hpBarSprites.value.size}/${allHPFrames.length} HP bar sprites`)
    } else {
      debug.warn('Could not load hp_bars.json')
    }
  } catch (error) {
    debug.error('Error loading HP bar sprites:', error)
  }
}

// Load effect sprites (smoke, hit, death, ready, intro)
async function loadEffectSprites() {
  // Load smoke sprites (from named files)
  for (let i = 1; i <= 6; i++) {
    const smokeImg = new Image()
    smokeImg.src = `/assets/easteregg/megaman/sprites/effects/Smoke${i}.png`
    smokeImg.onload = () => smokeSprites.value.set(`Smoke${i}.png`, smokeImg)
  }
  
  // Load hit sprites
  const hitFiles = [
    // Hit sprites (Hit1-Hit10) from project.json
    { name: '158a6fc8342580dad99bcd0cc3da6f5d.png', path: '/assets/easteregg/megaman/sprites/158a6fc8342580dad99bcd0cc3da6f5d.png' }, // Hit1
    { name: '49d8234616dc6d46d1d29ae6a10b6b5f.png', path: '/assets/easteregg/megaman/sprites/49d8234616dc6d46d1d29ae6a10b6b5f.png' }, // Hit2
    { name: '5b0a9bbe83f883e0e648f3cffda96839.png', path: '/assets/easteregg/megaman/sprites/5b0a9bbe83f883e0e648f3cffda96839.png' }, // Hit3
    { name: '5f4eacbd8a13fe907a24e9dd4b366ca8.png', path: '/assets/easteregg/megaman/sprites/5f4eacbd8a13fe907a24e9dd4b366ca8.png' }, // Hit4
    { name: 'ee5b4945c2685f318106f951a537a73c.png', path: '/assets/easteregg/megaman/sprites/ee5b4945c2685f318106f951a537a73c.png' }, // Hit5
    { name: '91a9950186deed6b06296ec179d17a24.png', path: '/assets/easteregg/megaman/sprites/91a9950186deed6b06296ec179d17a24.png' }, // Hit6
    { name: 'a37bb271560e365e9eac949ac675c009.png', path: '/assets/easteregg/megaman/sprites/a37bb271560e365e9eac949ac675c009.png' }, // Hit7
    { name: '68a9b48294eab02f64a9aacec96b76c6.png', path: '/assets/easteregg/megaman/sprites/68a9b48294eab02f64a9aacec96b76c6.png' }, // Hit8
    { name: '4fd717ba3385c8d6d76ea1df21e2b245.png', path: '/assets/easteregg/megaman/sprites/4fd717ba3385c8d6d76ea1df21e2b245.png' }, // Hit9
    { name: '399f62bacb879833ca499c139e9a4461.png', path: '/assets/easteregg/megaman/sprites/399f62bacb879833ca499c139e9a4461.png' }, // Hit10
    // Also load the armor hit sprite with original name for backwards compat
    { name: 'aabdd8a0c4b70511511ef63327f01483.png', path: '/assets/easteregg/megaman/sprites/aabdd8a0c4b70511511ef63327f01483.png' },
  ]
  for (const hit of hitFiles) {
    const hitImg = new Image()
    hitImg.src = hit.path
    hitImg.onload = () => {
      hitSprites.value.set(hit.name, hitImg)
      spriteImages.value.set(hit.name, hitImg) // Also add to sprite images for getAnimationFrames
    }
  }
  
  // Load death sprites (Death1-Death3) from project.json
  const deathFiles = [
    { name: '9bac76cd3cca6342e5e1f3dc7fee5ac8.png', path: '/assets/easteregg/megaman/sprites/9bac76cd3cca6342e5e1f3dc7fee5ac8.png' }, // Death1
    { name: 'f1f7bf17578b56bf022ee33081cc5c1a.png', path: '/assets/easteregg/megaman/sprites/f1f7bf17578b56bf022ee33081cc5c1a.png' }, // Death2
    { name: '169c783f60359234fad5ec797d0cc9c9.png', path: '/assets/easteregg/megaman/sprites/169c783f60359234fad5ec797d0cc9c9.png' }, // Death3
  ]
  for (const death of deathFiles) {
    const deathImg = new Image()
    deathImg.src = death.path
    // Store in spriteImages so getAnimationFrames can find them
    deathImg.onload = () => spriteImages.value.set(death.name, deathImg)
  }
  
  // Load death bubble sprites
  for (let i = 1; i <= 5; i++) {
    const bubbleImg = new Image()
    bubbleImg.src = `/assets/easteregg/megaman/sprites/death/Bubble${i}.png`
    bubbleImg.onload = () => deathBubbleSprites.value.set(`Bubble${i}.png`, bubbleImg)
  }
  
  // Load intro/spawn sprites (teleport down animation)
  for (let i = 1; i <= 7; i++) {
    const introImg = new Image()
    introImg.src = `/assets/easteregg/megaman/sprites/intro/Intro${i}.png`
    introImg.onload = () => readySprites.value.set(`Intro${i}.png`, introImg)
  }
  
  // Load Ready text sprites
  for (let i = 0; i <= 12; i++) {
    const readyImg = new Image()
    readyImg.src = `/assets/easteregg/megaman/sprites/ready/Ready${i}.png`
    readyImg.onload = () => readySprites.value.set(`Ready${i}.png`, readyImg)
  }
  
  // Load dash effect sprites (size: 200 in project.json = 2x scale)
  for (let i = 1; i <= 4; i++) {
    const dashEffectImg = new Image()
    dashEffectImg.src = `/assets/easteregg/megaman/sprites/effects/Dash_Effect${i}.png`
    dashEffectImg.onload = () => dashEffectSprites.value.set(`Dash_Effect${i}.png`, dashEffectImg)
  }
  
  debug.log('🎮 Loaded effect sprites')
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
    // Fixed spawn position for first player, offset for others
    // This ensures all players see the same spawn positions
    const canvasWidth = canvas ? canvas.width / (window.devicePixelRatio || 1) : 600
    const spawnX = 100 + (index * 100) % (canvasWidth - 200) // Deterministic positions
    const targetY = floorY - 64 // Where player will land
    
    const player: Player = {
      userId: participant.userId,
      x: spawnX,
      y: -100, // Start above screen (spawn from top)
      facing: 'right',
      state: 'idle',
      velocityX: 0,
      velocityY: 0,
      onGround: false, // Not on ground yet (spawning)
      onWall: false,
      wallSide: null,
      color: PLAYER_COLORS[index % PLAYER_COLORS.length],
      isShooting: false,
      isCharging: false,
      chargeLevel: 0,
      chargeStartTime: 0,
      lastShotTime: 0,
      dashCooldown: 0,
      canDash: true,
      health: 100,
      maxHealth: 100,
      hitTime: 0,
      invulnerableUntil: 0,
      canWallJump: false,
      smokeEffects: [],
      lastJumpKeyPressed: false,
      lastDashKeyPressed: false,
      dashStartTime: 0,
      isSpawning: true, // Start with spawn animation
      spawnTime: Date.now(),
      spawnY: targetY // Target Y position
    } as Player
    
    players.value.set(participant.userId, player)
    currentFrame.value.set(participant.userId, 0)
    frameTime.value.set(participant.userId, 0)
    chargeFrame.value.set(participant.userId, 0)
    
    debug.log(`🎮 Created player: ${participant.userId} at (${player.x}, ${player.y})`)
    
    // Play spawn sound and broadcast position for local player
    if (participant.userId === props.userId) {
      playSound('spawn')
      // Broadcast initial spawn position after a short delay to ensure channel is ready
      setTimeout(() => {
        broadcastPlayerState(player, true)
      }, 100)
    }
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
      // Stop charge loop sound
      stopSound('chargeLoop')
      
      // Fire based on charge level
      if (chargeTime >= CHARGE_TIME_LV1) {
        // Charged shot
        fireChargedShot(localPlayer)
        // Stop charge loop and play appropriate charge level sound
        stopSound('chargeLoop')
        if (localPlayer.chargeLevel >= 3) {
          playSound('shootLv3')
        } else if (localPlayer.chargeLevel >= 2) {
          playSound('shootLv2')
        } else {
          playSound('shootLv1')
        }
      } else {
        // Quick tap = uncharged shot
        stopSound('chargeLoop')
        fireBullet(localPlayer, 0)
        playSound('shoot')
      }
      
      localPlayer.isCharging = false
      localPlayer.chargeLevel = 0
      localPlayer.isShooting = false
    } else {
      // Very quick tap without charging state
      stopSound('chargeLoop') // Stop charge loop if playing
      fireBullet(localPlayer, 0)
      playSound('shoot')
    }
    
    stopSound('chargeLoop') // Always stop charge loop when releasing space
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
  
  // Dash (Shift) - single press, not hold, Megaman X style
  const dashKeyPressed = keys.value.has('ShiftLeft') || keys.value.has('ShiftRight')
  const wasDashKeyPressed = localPlayer.lastDashKeyPressed || false
  localPlayer.lastDashKeyPressed = dashKeyPressed
  
  if (dashKeyPressed && !wasDashKeyPressed && localPlayer.canDash && now - localPlayer.dashCooldown >= DASH_COOLDOWN) {
    if (localPlayer.onGround && localPlayer.state !== 'dashing') {
      localPlayer.state = 'dashing'
      localPlayer.dashStartTime = now
      localPlayer.isDashJumping = false
      localPlayer.velocityX = localPlayer.facing === 'right' ? DASH_SPEED : -DASH_SPEED
      localPlayer.velocityY = 0 // Stay on ground during dash
      localPlayer.canDash = false
      localPlayer.dashCooldown = now
      playSound('dash')
      broadcastPlayerState(localPlayer, true)
    }
  }
  
  // Handle dash state - check for dash-jump first
  if (localPlayer.state === 'dashing') {
    const dashElapsed = now - (localPlayer.dashStartTime || now)
    
    // DASH JUMP: Jump while dashing = higher horizontal speed jump
    const jumpKeyPressed = keys.value.has('ArrowUp')
    const wasJumpKeyPressed = localPlayer.lastJumpKeyPressed || false
    
    if (jumpKeyPressed && !wasJumpKeyPressed) {
      // Perform dash-jump - keep horizontal dash momentum and jump
      localPlayer.state = 'dashJumping'
      localPlayer.isDashJumping = true
      localPlayer.velocityY = JUMP_STRENGTH
      // Keep dash horizontal velocity (faster than normal walk)
      localPlayer.onGround = false
      localPlayer.canDash = true // Reset dash for when you land
      playSound('jump')
      // Add smoke effect
      localPlayer.smokeEffects.push({
        x: localPlayer.x + 32,
        y: localPlayer.y + 64,
        frame: 0,
        createdAt: Date.now()
      })
      broadcastPlayerState(localPlayer, true)
      localPlayer.lastJumpKeyPressed = jumpKeyPressed
      return // Jump takes over from dash
    }
    
    if (dashElapsed >= DASH_DURATION) {
      // End dash smoothly - keep some momentum if still holding direction
      const holdingLeft = keys.value.has('ArrowLeft')
      const holdingRight = keys.value.has('ArrowRight')
      if ((holdingLeft && localPlayer.facing === 'left') || (holdingRight && localPlayer.facing === 'right')) {
        localPlayer.state = 'walking'
        localPlayer.velocityX = localPlayer.facing === 'right' ? WALK_SPEED : -WALK_SPEED
      } else {
        localPlayer.state = 'idle'
        localPlayer.velocityX = 0
      }
      localPlayer.canDash = true
      localPlayer.isDashJumping = false
    }
    broadcastPlayerState(localPlayer, true)
    localPlayer.lastJumpKeyPressed = keys.value.has('ArrowUp')
    return // Don't process other movement during dash
  }
  
  // Charging (hold Space) - only update charge, don't fire here
  if (keys.value.has('Space')) {
    if (!localPlayer.isCharging) {
      localPlayer.isCharging = true
      localPlayer.chargeStartTime = now
      localPlayer.chargeLevel = 0
      localPlayer.isShooting = true // Show shooting animation while charging
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
      
      // Play charge sound on start, then loop continuously
      if (chargeTime < 100) {
        playSound('charge')
      } else if (chargeTime >= 200 && chargeTime < 300) {
        // Start charge loop after initial charge sound (only once)
        playSound('chargeLoop', true) // Loop continuously
      }
    }
  }
  
  // Movement with arrow keys (not during dash)
  const previousFacing = localPlayer.facing
  // Note: We already return early if dashing, so this check is just for safety
  if ((localPlayer.state as string) !== 'dashing') {
    if (keys.value.has('ArrowLeft')) {
      localPlayer.velocityX = -WALK_SPEED
      localPlayer.facing = 'left'
      if (localPlayer.onGround) {
        localPlayer.state = 'walking' // Always show walking when moving, even while charging
      }
    } else if (keys.value.has('ArrowRight')) {
      localPlayer.velocityX = WALK_SPEED
      localPlayer.facing = 'right'
      if (localPlayer.onGround) {
        localPlayer.state = 'walking' // Always show walking when moving, even while charging
      }
    } else {
      localPlayer.velocityX = 0
      if (localPlayer.onGround && localPlayer.state !== 'jumping' && localPlayer.state !== 'falling' && localPlayer.state !== 'landing' && (localPlayer.state as string) !== 'dashing') {
        localPlayer.state = localPlayer.isCharging ? 'idle' : 'idle' // Don't use 'shooting' state while charging
      }
    }
    
    // Broadcast immediately if facing changed (force broadcast)
    if (previousFacing !== localPlayer.facing) {
      broadcastPlayerState(localPlayer, true)
    }
  }
  
  // Jump (ArrowUp) - only on key press, not hold
  // Track if jump key was just pressed (not held)
  const jumpKeyPressed = keys.value.has('ArrowUp')
  const wasJumpKeyPressed = localPlayer.lastJumpKeyPressed || false
  localPlayer.lastJumpKeyPressed = jumpKeyPressed
  
  if (jumpKeyPressed && !wasJumpKeyPressed) {
    // Jump key just pressed (not held)
    if (localPlayer.onWall && localPlayer.wallSide) {
      // Wall kick/jump - Megaman X style: kick off wall, can re-grab to climb
      // Wall kick - jump up and slightly away from wall (can return to wall for climbing)
      localPlayer.velocityY = -14 // Strong upward kick
      // Kick away from wall - but not too far so player can return
      localPlayer.velocityX = localPlayer.wallSide === 'left' ? 5 : -5
      localPlayer.facing = localPlayer.wallSide === 'left' ? 'right' : 'left'
      localPlayer.onWall = false
      const previousWallSide = localPlayer.wallSide
      localPlayer.wallSide = null
      localPlayer.canWallJump = false
      localPlayer.state = 'wallKick' // Use wall kick state for animation
      localPlayer.wallKickTime = Date.now()
      playSound('jump')
      // Add smoke effect at kick position
      localPlayer.smokeEffects.push({
        x: previousWallSide === 'left' ? localPlayer.x : localPlayer.x + 64,
        y: localPlayer.y + 32,
        frame: 0,
        createdAt: Date.now()
      })
      // After wall kick animation (200ms), switch to jumping
      setTimeout(() => {
        if (localPlayer.state === 'wallKick') {
          localPlayer.state = 'jumping'
        }
      }, 200)
      broadcastPlayerState(localPlayer, true) // Force broadcast wall kick
    } else if (localPlayer.onGround && !localPlayer.onWall) {
      // Ground jump - only if actually on ground AND not on wall
      localPlayer.velocityY = JUMP_STRENGTH
      localPlayer.onGround = false
      localPlayer.state = 'jumping'
      playSound('jump')
      // Add smoke effect at jump position
      localPlayer.smokeEffects.push({
        x: localPlayer.x + 32,
        y: localPlayer.y + 64,
        frame: 0,
        createdAt: Date.now()
      })
    }
  }
  
  // Note: No walk sound in Megaman X - only jump, dash, shoot, charge sounds
  
  // Broadcast player state
  broadcastPlayerState(localPlayer)
}

// Fire a bullet (uncharged or charged)
function fireBullet(player: Player, chargeLevel: number = 0) {
  if (!props.channelId) return
  
  // Set shooting state to show shooting animation
  player.isShooting = true
  player.lastShotTime = Date.now()
  
  // Clear shooting state after animation duration
  setTimeout(() => {
    if (Date.now() - player.lastShotTime >= 200) {
      player.isShooting = false
    }
  }, 200)
  
  const bulletId = `bullet-${bulletIdCounter++}-${Date.now()}`
  const bulletX = player.facing === 'right' ? player.x + 64 : player.x
  const bulletY = player.y + 32 // Center of player
  
  // Bullet size and speed based on charge level
  const speed = BULLET_SPEED * (1 + chargeLevel * 0.5)
  
  // Get buster sprite for this charge level
  let spriteFile: string | null = null
  let spriteFile2: string | null = null // For Fire1/Fire2 animation
  let chargingSprites: string[] = []
  let damage = 10
  
  if (busterData.value) {
    if (chargeLevel === 0 && busterData.value.Buster_LV0) {
      // Use base Buster_LV0 sprite
      spriteFile = busterData.value.Buster_LV0.find((f: any) => f.name === 'Buster_LV0')?.file || busterData.value.Buster_LV0[0]?.file || null
      damage = 10
    } else if (chargeLevel === 1 && busterData.value.Buster_LV1) {
      // Use Fire1 and Fire2 for animation
      const fire1 = busterData.value.Buster_LV1.find((f: any) => f.name.includes('Fire1'))
      const fire2 = busterData.value.Buster_LV1.find((f: any) => f.name.includes('Fire2'))
      spriteFile = fire1?.file || null
      spriteFile2 = fire2?.file || null
      // Get charging sprites for projectile: Buster_LV1_1 through Buster_LV1_6
      chargingSprites = busterData.value.Buster_LV1
        .filter((f: any) => f.name.startsWith('Buster_LV1_') && !f.name.includes('Fire'))
        .sort((a: any, b: any) => {
          const numA = parseInt(a.name.match(/_(\d+)/)?.[1] || '0')
          const numB = parseInt(b.name.match(/_(\d+)/)?.[1] || '0')
          return numA - numB
        })
        .map((f: any) => f.file)
      damage = 20
    } else if (chargeLevel === 2 && busterData.value.Buster_LV2) {
      // Use Fire1 and Fire2 for animation
      const fire1 = busterData.value.Buster_LV2.find((f: any) => f.name.includes('Fire1'))
      const fire2 = busterData.value.Buster_LV2.find((f: any) => f.name.includes('Fire2'))
      spriteFile = fire1?.file || null
      spriteFile2 = fire2?.file || null
      // Get charging sprites for projectile: Buster_LV2_1, Buster_LV2_2, Buster_LV2_3
      chargingSprites = busterData.value.Buster_LV2
        .filter((f: any) => f.name.startsWith('Buster_LV2_') && !f.name.includes('Fire'))
        .sort((a: any, b: any) => {
          const numA = parseInt(a.name.match(/_(\d+)/)?.[1] || '0')
          const numB = parseInt(b.name.match(/_(\d+)/)?.[1] || '0')
          return numA - numB
        })
        .map((f: any) => f.file)
      damage = 35
    } else if (chargeLevel === 3 && busterData.value.Buster_LV3) {
      // LV3 uses the ball sprite - but also use Flash sprites for the projectile
      if (busterData.value.Buster_LV3_Flash && busterData.value.Buster_LV3_Flash.length > 0) {
        // Use Flash1 as the main projectile sprite
        spriteFile = busterData.value.Buster_LV3_Flash[0]?.file || busterData.value.Buster_LV3[0]?.file || null
      } else {
        spriteFile = busterData.value.Buster_LV3[0]?.file || null
      }
      damage = 50
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
    sprite2: spriteFile2,
    chargingSprites: chargingSprites,
    color: player.color,
    createdAt: Date.now(),
    damage: damage
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
let lastBroadcastTime = 0
const BROADCAST_INTERVAL = 50 // Broadcast every 50ms for smooth updates

function broadcastPlayerState(player: Player, force: boolean = false) {
  if (!props.channelId || !gameChannel) return
  
  const now = Date.now()
  // Only broadcast if enough time has passed or forced (for immediate updates like facing/dash changes)
  if (!force && now - lastBroadcastTime < BROADCAST_INTERVAL) {
    return
  }
  lastBroadcastTime = now
  
  // Use the existing gameChannel instead of creating a new one
  gameChannel.send({
    type: 'broadcast',
    event: 'player-update',
    payload: {
      userId: player.userId,
      x: player.x,
      y: player.y,
      facing: player.facing, // Critical: must always be included for proper orientation sync
      state: player.state,
      velocityX: player.velocityX,
      velocityY: player.velocityY,
      isShooting: player.isShooting,
      isCharging: player.isCharging,
      chargeLevel: player.chargeLevel,
      onWall: player.onWall,
      wallSide: player.wallSide,
      health: player.health,
      maxHealth: player.maxHealth,
      lastShotTime: player.lastShotTime || 0,
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
  
  // Get actual canvas dimensions (using synced resolution)
  const canvasWidth = gameCanvasWidth.value
  const canvasHeight = gameCanvasHeight.value
  const floorY = canvasHeight - 20 // Floor is 20px from bottom
  const wallLeft = 0
  const wallRight = canvasWidth
  
  // Draw "READY" text animation (after spawn animation)
  if (showIntro && gameStartTime > 0 && ctx) {
    const introTime = Date.now() - gameStartTime
    // Show Ready text from 800ms (after spawn) to 2500ms
    if (introTime >= 800 && introTime < 2500) {
      const readyAnimTime = introTime - 800
      const readyFrame = Math.min(Math.floor(readyAnimTime / 100), 12)
      const readySprite = readySprites.value.get(`Ready${readyFrame}.png`)
      if (readySprite && readySprite.complete && readySprite.naturalWidth > 0) {
        ctx.save()
        // Ready sprite uses 2x scale (size: 200 in project.json)
        const scale = 2.0
        const readyWidth = readySprite.naturalWidth * scale
        const readyHeight = readySprite.naturalHeight * scale
        ctx.drawImage(
          readySprite,
          (canvasWidth - readyWidth) / 2,
          (canvasHeight - readyHeight) / 2,
          readyWidth,
          readyHeight
        )
        ctx.restore()
      }
    } else if (introTime >= 2500) {
      showIntro = false
    }
  }
  
  // Always clear canvas first (proper z-buffer clearing)
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)
  
  // Draw background (only if not showing intro)
  if (!showIntro || Date.now() - gameStartTime >= 2000) {
    ctx.fillStyle = 'rgba(26, 26, 46, 0.9)' // Semi-transparent
    ctx.fillRect(0, 0, canvasWidth, canvasHeight)
    
    // Draw floor
    ctx.fillStyle = '#16213e'
    ctx.fillRect(0, floorY, canvasWidth, canvasHeight - floorY)
    
    // Draw walls (for wall sliding)
    ctx.fillStyle = '#1a2e3a'
    ctx.fillRect(0, 0, 5, canvasHeight) // Left wall
    ctx.fillRect(canvasWidth - 5, 0, 5, canvasHeight) // Right wall
  }
  
  // Debug: Draw player count
  if (players.value.size === 0 && (!showIntro || Date.now() - gameStartTime >= 2000)) {
    ctx.fillStyle = '#fff'
    ctx.font = '16px monospace'
    ctx.fillText('No players initialized', 10, 30)
    debug.warn('🎮 No players in game')
  }
  
  // Update bullets and check collisions
  bullets.value.forEach((bullet, bulletId) => {
    bullet.x += bullet.velocityX * deltaSeconds * 60 // Scale by delta
    bullet.y += bullet.velocityY * deltaSeconds * 60
    
    // Check collision with players
    players.value.forEach((player) => {
      // Don't hit the shooter
      if (player.userId === bullet.userId) return
      // Don't hit dead or spawning players
      if (player.state === 'dead' || player.isSpawning) return
      
      // Simple collision detection (bullet center vs player bounds)
      const bulletSize = 16
      const playerSize = 64
      const playerCenterX = player.x + playerSize / 2
      const playerCenterY = player.y + playerSize / 2
      const distanceX = Math.abs(bullet.x - playerCenterX)
      const distanceY = Math.abs(bullet.y - playerCenterY)
      
      if (distanceX < (bulletSize + playerSize) / 2 && distanceY < (bulletSize + playerSize) / 2) {
        // Check invulnerability
        const now = Date.now()
        if (now < player.invulnerableUntil) return
        
        // Hit! Apply damage
        player.health = Math.max(0, player.health - bullet.damage)
        player.hitTime = now
        player.invulnerableUntil = now + 1000 // 1 second invulnerability
        player.state = 'hit'
        
        // Remove bullet immediately (both locally and for all players)
        bullets.value.delete(bulletId)
        
        // Broadcast bullet removal to all players
        if (gameChannel) {
          gameChannel.send({
            type: 'broadcast',
            event: 'bullet-removed',
            payload: {
              bulletId: bulletId
            }
          })
        }
        
        // Broadcast damage
        if (gameChannel) {
          gameChannel.send({
            type: 'broadcast',
            event: 'player-damaged',
            payload: {
              userId: player.userId,
              health: player.health,
              damage: bullet.damage,
              attackerId: bullet.userId
            }
          })
        }
        
        // Play hit sound
        playSound('hit') // Use buster hit sound
        
        // Check if player died
        if (player.health <= 0) {
          player.state = 'dead'
          playSound('death') // Use X_LoseLife sound for death
          // Respawn after 3 seconds with spawn animation
          setTimeout(() => {
            if (player.health <= 0) {
              player.health = player.maxHealth
              player.x = 50 + Math.random() * (canvasWidth - 150)
              player.y = floorY - 64
              player.velocityX = 0
              player.velocityY = 0
              player.state = 'idle'
              player.isSpawning = true
              player.spawnTime = Date.now()
              player.invulnerableUntil = Date.now() + 2000 // Extra invulnerability on respawn
              playSound('spawn') // Teleport down sound
            }
          }, 3000)
        } else {
          // Return to previous state after hit animation
          setTimeout(() => {
            if (player.state === 'hit' && player.health > 0) {
              player.state = player.velocityX !== 0 ? 'walking' : 'idle'
            }
          }, 300)
        }
      }
    })
    
    // Remove bullets that go off screen
    if (bullet.x < -20 || bullet.x > canvasWidth + 20 || bullet.y < -20 || bullet.y > canvasHeight + 20) {
      bullets.value.delete(bulletId)
    }
    
    // Draw bullet using buster sprite
    if (ctx) {
      // Animate Fire1/Fire2 for charged shots
      let currentSprite = bullet.sprite
      if (bullet.sprite2 && (bullet.chargeLevel === 1 || bullet.chargeLevel === 2)) {
        // Alternate between Fire1 and Fire2
        const animTime = Date.now() - bullet.createdAt
        const frame = Math.floor(animTime / 100) % 2
        currentSprite = frame === 0 ? bullet.sprite : bullet.sprite2
      }
      
      if (currentSprite && busterSprites.value.has(currentSprite)) {
        const spriteImg = busterSprites.value.get(currentSprite)!
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
          
          // Draw charging sprites on projectile (for LV1 and LV2)
          if (bullet.chargingSprites.length > 0 && (bullet.chargeLevel === 1 || bullet.chargeLevel === 2)) {
            const chargeTime = Date.now() - bullet.createdAt
            const chargeFrame = Math.floor((chargeTime / 100) % bullet.chargingSprites.length)
            const chargeSpriteFile = bullet.chargingSprites[chargeFrame]
            
            if (chargeSpriteFile && busterSprites.value.has(chargeSpriteFile)) {
              const chargeSprite = busterSprites.value.get(chargeSpriteFile)!
              if (chargeSprite && chargeSprite.complete) {
                const chargeWidth = chargeSprite.naturalWidth * (chargeSprite.naturalWidth > 100 ? 0.5 : 1)
                const chargeHeight = chargeSprite.naturalHeight * (chargeSprite.naturalHeight > 100 ? 0.5 : 1)
                ctx.drawImage(
                  chargeSprite,
                  bullet.x - chargeWidth / 2,
                  bullet.y - chargeHeight / 2,
                  chargeWidth,
                  chargeHeight
                )
              }
            }
          }
          
          // Draw LV3 trail and flash effects
          if (bullet.chargeLevel === 3 && busterData.value) {
            // Trail effect
            if (busterData.value.Buster_LV3_Trail) {
              const trailTime = Date.now() - bullet.createdAt
              const trailFrame = Math.floor((trailTime / 50) % busterData.value.Buster_LV3_Trail.length)
              const trail = busterData.value.Buster_LV3_Trail[trailFrame]
              if (trail) {
                const trailSprite = busterSprites.value.get(trail.file)
                if (trailSprite && trailSprite.complete) {
                  const trailWidth = trailSprite.naturalWidth * (trailSprite.naturalWidth > 100 ? 0.5 : 1)
                  const trailHeight = trailSprite.naturalHeight * (trailSprite.naturalHeight > 100 ? 0.5 : 1)
                  // Draw trail behind bullet
                  ctx.drawImage(
                    trailSprite,
                    bullet.x - bullet.velocityX * 2 - trailWidth / 2,
                    bullet.y - trailHeight / 2,
                    trailWidth,
                    trailHeight
                  )
                }
              }
            }
          }
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
    
    // Wall detection - can cling if in the air and touching wall
    // Megaman X style: wall slide is slow, wall jump kicks off the wall
    const isLocalPlayer = userId === props.userId
    
    if ((isNearLeftWall || isNearRightWall) && !player.onGround) {
      // Check if player is moving towards wall (or already on wall)
      const isPressingTowardLeft = isLocalPlayer ? keys.value.has('ArrowLeft') : player.wallSide === 'left'
      const isPressingTowardRight = isLocalPlayer ? keys.value.has('ArrowRight') : player.wallSide === 'right'
      
      // Wall cling only when pressing toward wall AND falling (velocityY > 0)
      if ((isPressingTowardLeft && isNearLeftWall) || (isPressingTowardRight && isNearRightWall)) {
        if (!player.onWall) {
          // Just touched wall
          player.canWallJump = true
        }
        player.onWall = true
        player.wallSide = isNearLeftWall ? 'left' : 'right'
        
        // Wall slide: slow controlled descent, not going up
        // Only slow down if actually falling (velocityY > 0)
        if (player.velocityY > 0) {
          player.velocityY = Math.min(player.velocityY, WALL_SLIDE_SPEED)
        } else if (player.velocityY < 0) {
          // Rising - let gravity slow us down naturally, but faster
          player.velocityY += GRAVITY * deltaSeconds * 60 * 1.5
        }
        
        // Horizontal velocity should be 0 while wall clinging
        player.velocityX = 0
        player.state = 'wallCling'
      } else {
        // Releasing direction key while on wall - detach and fall
        player.onWall = false
        player.wallSide = null
      }
    } else {
      player.onWall = false
      player.wallSide = null
      player.canWallJump = false
    }
    
    player.x += player.velocityX * deltaSeconds * 60
    player.y += player.velocityY * deltaSeconds * 60
    
    // Ground collision
    const wasOnGround = player.onGround
    if (player.y >= floorY - 64) {
      if (!player.onGround) {
        // Just landed - play land sound
        if (userId === props.userId) {
          playSound('land')
        }
        // Reset dash-jump indicator
        player.isDashJumping = false
        player.canDash = true // Can dash again after landing
        
        player.state = 'landing'
        // Add landing smoke effect
        player.smokeEffects.push({
          x: player.x + 32,
          y: player.y + 64,
          frame: 0,
          createdAt: Date.now()
        })
        setTimeout(() => {
          if (player.state === 'landing') {
            player.state = player.velocityX !== 0 ? 'walking' : 'idle'
          }
        }, 150) // Slightly faster landing animation
      }
      player.y = floorY - 64
      player.velocityY = 0
      player.onGround = true
      player.onWall = false
      player.wallSide = null
    } else {
      player.onGround = false
    }
    
    // Update state based on velocity when in air (charging doesn't change state)
    // Keep dashJumping and wallKick states until landing or state changes
    if (!player.onGround && !player.onWall && 
        player.state !== 'dashing' && 
        player.state !== 'dashJumping' && 
        player.state !== 'wallKick' &&
        player.state !== 'hit' &&
        player.state !== 'dead') {
      if (player.velocityY > 0) {
        player.state = 'falling'
      } else if (player.velocityY < 0) {
        player.state = 'jumping'
      }
    }
    
    // Dash-jumping transitions: when velocity drops significantly, switch to fall
    if (player.state === 'dashJumping' && player.velocityY > 2) {
      player.state = 'falling'
      player.isDashJumping = true // Keep the momentum indicator
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
  
  // Handle hit state - cycle through Hit1-Hit10 (10 frames at ~50ms each = 500ms total)
  if (player.state === 'hit') {
    const hitFrames = animations.value.hit || []
    if (hitFrames.length > 0) {
      const hitElapsed = Date.now() - player.hitTime
      const hitFrameIndex = Math.min(Math.floor(hitElapsed / 50), hitFrames.length - 1)
      return [hitFrames[hitFrameIndex]]
    }
  }
  
  // Handle death state - first show Death1-3, then fade out with bubbles
  if (player.state === 'dead') {
    const deathElapsed = Date.now() - player.hitTime
    
    // First 600ms: Show Death1-3 animation
    if (deathElapsed < 600) {
      const deathFrames = animations.value.death || []
      if (deathFrames.length > 0) {
        const deathFrameIndex = Math.min(Math.floor(deathElapsed / 200), deathFrames.length - 1)
        return [deathFrames[deathFrameIndex]]
      }
    }
    
    // After 600ms: Show bubble explosion effect
    const deathBubbleFrames: AnimationFrame[] = []
    for (let i = 1; i <= 5; i++) {
      const bubbleSprite = deathBubbleSprites.value.get(`Bubble${i}.png`)
      if (bubbleSprite) {
        deathBubbleFrames.push({ name: `Bubble${i}`, file: `Bubble${i}.png` })
      }
    }
    if (deathBubbleFrames.length > 0) {
      const bubbleTime = deathElapsed - 600
      const bubbleFrameIndex = Math.min(Math.floor(bubbleTime / 150), deathBubbleFrames.length - 1)
      return [deathBubbleFrames[bubbleFrameIndex]]
    }
  }
  
  // Wall kick animation (after wall jump, show wall kick frames)
  if (player.state === 'wallKick') {
    const wallKickFrames = animations.value.wall_kick || []
    if (wallKickFrames.length > 0) {
      const kickTime = Date.now() - (player.wallKickTime || Date.now())
      const kickFrameIndex = Math.min(Math.floor(kickTime / 100), wallKickFrames.length - 1)
      return [wallKickFrames[kickFrameIndex]]
    }
  }
  
  // Wall cling animation - slide down with animated Wall_Cling1-3
  if (player.onWall && player.state === 'wallCling') {
    const wallClingFrames = animations.value.wall_cling || []
    if (wallClingFrames.length > 0) {
      // Animate through Wall_Cling1-3 while sliding
      return wallClingFrames
    }
    // Fallback to old wall array
    const wallFrames = animations.value.wall || []
    const clingFrames = wallFrames.filter(f => f.name.startsWith('Wall_Cling') && !f.name.includes('Fire'))
    if (clingFrames.length > 0) {
      return clingFrames
    }
    return wallFrames.slice(0, 1)
  }
  
  // Dash takes priority - use dash animation frames
  // But check for dash+shooting first (Dash_Fire)
  if (player.state === 'dashing') {
    const timeSinceLastShot = Date.now() - (player.lastShotTime || 0)
    if ((player.isShooting || timeSinceLastShot < 200) && !player.isCharging) {
      // Dash + shooting = Dash_Fire sprites
      const dashFireFrames = animations.value.dash_fire || animations.value.shoot.filter(f => 
        f.name.toLowerCase().includes('dash') && f.name.toLowerCase().includes('fire')
      )
      if (dashFireFrames && dashFireFrames.length > 0) {
        return dashFireFrames
      }
    }
    // Normal dash animation
    const dashFrames = animations.value.dash || []
    if (dashFrames.length > 0) {
      return dashFrames // Return Dash1 and Dash2 frames
    }
    // Fallback to walk if dash not available
    return animations.value.walk || []
  }
  
  // Shooting animation when shooting (but NOT while charging - charging shows movement animation with charge effect)
  // Show shooting animation for 200ms after firing
  const timeSinceLastShot = Date.now() - (player.lastShotTime || 0)
  if ((player.isShooting || timeSinceLastShot < 200) && !player.isCharging) {
    // Dash-jumping + shooting uses Jump_Fire sprites
    if (player.state === 'dashJumping' || player.isDashJumping) {
      const jumpFireFrames = animations.value.shoot.filter(f => 
        f.name.toLowerCase().includes('jump') && f.name.toLowerCase().includes('fire')
      )
      if (jumpFireFrames.length > 0) {
        return jumpFireFrames
      }
    }
    
    // Find shooting animation that matches current movement state
    const shootFrames = animations.value.shoot.filter(frame => {
      const name = frame.name.toLowerCase()
      if ((player.state === 'idle' || player.state === 'landing') && name.includes('idle') && name.includes('fire')) return true
      if (player.state === 'walking' && name.includes('run') && name.includes('fire')) return true
      if ((player.state === 'jumping' || player.state === 'dashJumping' || player.state === 'wallKick') && name.includes('jump') && name.includes('fire')) return true
      if (player.state === 'falling' && name.includes('fall') && name.includes('fire')) return true
      if (player.onWall && name.includes('wall') && name.includes('fire')) return true
      return false
    })
    
    if (shootFrames.length > 0) {
      return shootFrames
    }
    // Fallback to idle fire
    const idleFire = animations.value.shoot.filter(f => {
      const name = f.name.toLowerCase()
      return name.includes('idle') && name.includes('fire')
    })
    if (idleFire.length > 0) return idleFire
  }
  
  // Normal animations
  switch (player.state) {
    case 'walking':
      return animations.value.walk || []
    case 'jumping':
      return animations.value.jump || []
    case 'dashJumping':
      // Dash-jump uses jump animation but with dash momentum
      return animations.value.jump || []
    case 'falling':
      return animations.value.fall || []
    case 'landing':
      return animations.value.land || []
    case 'wallKick':
      return animations.value.wall_kick || animations.value.jump || []
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
  
  // Handle spawn animation (teleport down from top of screen)
  if (player.isSpawning && player.spawnTime) {
    const spawnElapsed = Date.now() - player.spawnTime
    const spawnDuration = 600 // 600ms for falling from top
    
    if (spawnElapsed < spawnDuration) {
      // Calculate Y position - fall from top to target
      const targetY = player.spawnY || 200
      const startY = -80 // Start above screen
      const progress = Math.min(spawnElapsed / spawnDuration, 1)
      // Ease out for smooth landing
      const easedProgress = 1 - Math.pow(1 - progress, 2)
      const currentY = startY + (targetY - startY) * easedProgress
      
      // Calculate which intro frame to show (1-7)
      const introFrameIndex = Math.min(Math.floor(progress * 6) + 1, 7)
      const introSprite = readySprites.value.get(`Intro${introFrameIndex}.png`)
      
      if (introSprite && introSprite.complete && introSprite.naturalWidth > 0) {
        ctx.save()
        // Use 2x scale like project.json
        const scale = 1.0 // Sprites are already 2x in source
        const drawWidth = introSprite.naturalWidth * scale
        const drawHeight = introSprite.naturalHeight * scale
        
        // Draw at calculated position
        ctx.drawImage(introSprite, player.x, currentY, drawWidth, drawHeight)
        ctx.restore()
      }
      return // Don't draw normal player sprite during spawn
    } else {
      // Spawn complete - put player at ground level
      player.isSpawning = false
      player.spawnTime = 0
      player.y = player.spawnY || 200
      player.onGround = true
      // Add landing smoke effect
      player.smokeEffects.push({
        x: player.x + 32,
        y: player.y + 64,
        frame: 0,
        createdAt: Date.now()
      })
    }
  }
  
  const frames = getAnimationFrames(player)
  
  // Don't draw placeholder - wait for sprites to load
  if (frames.length === 0 || !animations.value) {
    return
  }
  
  // Update frame timer using delta time
  // Walking animation is twice as fast
  // Dash animation should be faster too (cycle through Dash1/Dash2 quickly)
  const isWalking = player.state === 'walking' && !player.isCharging
  const isDashing = player.state === 'dashing'
  const frameDuration = isWalking ? FRAME_DURATION / 2 : (isDashing ? FRAME_DURATION / 3 : FRAME_DURATION) // Dash cycles 3x faster
  
  const currentTime = frameTime.value.get(userId) || 0
  const newTime = currentTime + (deltaSeconds * 1000) // Add delta in ms
  frameTime.value.set(userId, newTime)
  
  if (newTime >= frameDuration) {
    const current = currentFrame.value.get(userId) || 0
    const next = (current + 1) % frames.length
    currentFrame.value.set(userId, next)
    frameTime.value.set(userId, 0) // Reset timer
  }
  
  const frameIndex = currentFrame.value.get(userId) || 0
  const frame = frames[frameIndex]
  
  if (!frame) {
    // No frame available - try to show idle as fallback
    const idleFrames = animations.value?.idle || []
    if (idleFrames.length > 0) {
      const fallbackSprite = spriteImages.value.get(idleFrames[0].file)
      if (fallbackSprite && fallbackSprite.complete && ctx) {
        ctx.drawImage(fallbackSprite, player.x, player.y, 64, 64)
      }
    }
    return
  }
  
  // Get sprite image - check hit sprites first if in hit state
  let spriteImg: HTMLImageElement | null = null
  if (player.state === 'hit') {
    // Try to get hit sprite directly
    spriteImg = hitSprites.value.get(frame.file) || null
  }
  // Also check death bubble sprites for dead state
  if (!spriteImg && player.state === 'dead') {
    spriteImg = deathBubbleSprites.value.get(frame.file) || null
  }
  // Fallback to regular sprite images
  if (!spriteImg) {
    spriteImg = spriteImages.value.get(frame.file) || null
  }
  
  // If still no sprite, try to get first idle sprite as ultimate fallback
  if (!spriteImg) {
    const idleFrames = animations.value?.idle || []
    if (idleFrames.length > 0) {
      spriteImg = spriteImages.value.get(idleFrames[0].file) || null
      debug.warn(`🎮 Missing sprite ${frame.file}, using idle fallback`)
    }
  }
  
  if (spriteImg && spriteImg.complete && spriteImg.naturalWidth > 0) {
    // Draw sprite - get actual sprite dimensions
    const spriteWidth = spriteImg.naturalWidth
    const spriteHeight = spriteImg.naturalHeight
    
    // Scale down if sprite is 2x resolution (Scratch uses 2x bitmaps)
    const scale = spriteWidth > 100 ? 0.5 : 1
    const drawWidth = spriteWidth * scale
    const drawHeight = spriteHeight * scale
    
    ctx.save()
    
    // Handle invulnerability flash effect (only after hit animation completes)
    const now = Date.now()
    const isInvulnerable = now < player.invulnerableUntil
    const hitTime = now - player.hitTime
    if (isInvulnerable && player.state === 'hit' && hitTime > 500) {
      // After hit animation (500ms), show flash effect on normal sprite
      const flashRate = 100 // ms
      const flashVisible = Math.floor((hitTime - 500) / flashRate) % 2 === 0
      if (!flashVisible) {
        ctx.globalAlpha = 0.5 // Semi-transparent flash, not fully invisible
      }
    } else if (isInvulnerable && player.state !== 'hit') {
      // Invulnerable but not in hit state (e.g., after respawn)
      const flashRate = 100 // ms
      const flashVisible = Math.floor((now - (player.invulnerableUntil - 1000)) / flashRate) % 2 === 0
      if (!flashVisible) {
        ctx.globalAlpha = 0.5
      }
    }
    
    // Apply palette swap for different players - Megaman style (replace blues with player color)
    if (player.color !== '#ff6b6b') { // Default color - no swap needed
      // Draw sprite to offscreen canvas for color manipulation
      const offscreenCanvas = document.createElement('canvas')
      offscreenCanvas.width = drawWidth
      offscreenCanvas.height = drawHeight
      const offscreenCtx = offscreenCanvas.getContext('2d')
      
      if (offscreenCtx) {
        // Draw sprite to offscreen (handle flipping)
        if (player.facing === 'left') {
          offscreenCtx.scale(-1, 1)
          offscreenCtx.drawImage(spriteImg, -drawWidth, 0, drawWidth, drawHeight)
        } else {
          offscreenCtx.drawImage(spriteImg, 0, 0, drawWidth, drawHeight)
        }
        
        // Get image data
        const imageData = offscreenCtx.getImageData(0, 0, drawWidth, drawHeight)
        const data = imageData.data
        
        // Convert player color to RGB
        const hex = player.color.replace('#', '')
        const targetR = parseInt(hex.substr(0, 2), 16)
        const targetG = parseInt(hex.substr(2, 2), 16)
        const targetB = parseInt(hex.substr(4, 2), 16)
        
        // Megaman X uses specific blue tones - we'll replace blue-ish pixels
        // This gives a more authentic palette swap look
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 0) { // Only process non-transparent pixels
            const r = data[i]
            const g = data[i + 1]
            const b = data[i + 2]
            
            // Detect blue-ish pixels (Megaman's armor colors)
            // Light blue: high B, medium R/G
            // Dark blue: low-medium R/G, medium-high B
            const isBlueish = b > 80 && b >= r && b >= g
            
            if (isBlueish) {
              // Calculate intensity (how light/dark the pixel is)
              const intensity = (r + g + b) / 3 / 255
              
              // Replace with player color while keeping intensity
              data[i] = Math.floor(targetR * intensity + targetR * 0.3) // R
              data[i + 1] = Math.floor(targetG * intensity + targetG * 0.3) // G
              data[i + 2] = Math.floor(targetB * intensity + targetB * 0.3) // B
            }
            // Non-blue pixels (skin, eyes, etc.) keep original color
          }
        }
        
        // Put modified image data back
        offscreenCtx.putImageData(imageData, 0, 0)
        
        // Draw tinted sprite to main canvas
        if (player.facing === 'left') {
          ctx.scale(-1, 1)
          ctx.drawImage(offscreenCanvas, -player.x - drawWidth, player.y)
          ctx.scale(-1, 1) // Reset
        } else {
          ctx.drawImage(offscreenCanvas, player.x, player.y)
        }
      }
    } else {
      // Draw sprite normally (no tint)
      if (player.facing === 'left') {
        ctx.scale(-1, 1)
        ctx.drawImage(
          spriteImg,
          -player.x - drawWidth, // Adjust for flipped position
          player.y,
          drawWidth,
          drawHeight
        )
        ctx.scale(-1, 1) // Reset
      } else {
        ctx.drawImage(
          spriteImg,
          player.x,
          player.y,
          drawWidth,
          drawHeight
        )
      }
    }
    
    // Reset composite operation
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1.0
    
    ctx.restore()
    
    // Draw charging effect (aura around player) - NO buster arm sprites on player
    if (player.isCharging && busterData.value && busterData.value.Charge_Effect) {
      const chargeTime = Date.now() - player.chargeStartTime
      let chargeEffectFrames: any[] = []
      let effectFrameIndex = 0
      
      // Get charge effect frames based on level
      if (player.chargeLevel >= 1) {
        chargeEffectFrames = busterData.value.Charge_Effect.filter((f: any) => 
          f.name.startsWith('Charge_LV1_')
        ).sort((a: any, b: any) => {
          const numA = parseInt(a.name.match(/_(\d+)/)?.[1] || '0')
          const numB = parseInt(b.name.match(/_(\d+)/)?.[1] || '0')
          return numA - numB
        })
        effectFrameIndex = Math.floor((chargeTime / 150) % chargeEffectFrames.length)
      }
      
      if (player.chargeLevel >= 2) {
        chargeEffectFrames = busterData.value.Charge_Effect.filter((f: any) => 
          f.name.startsWith('Charge_LV2_')
        ).sort((a: any, b: any) => {
          const numA = parseInt(a.name.match(/_(\d+)/)?.[1] || '0')
          const numB = parseInt(b.name.match(/_(\d+)/)?.[1] || '0')
          return numA - numB
        })
        effectFrameIndex = Math.floor((chargeTime / 150) % chargeEffectFrames.length)
      }
      
      if (player.chargeLevel >= 3) {
        chargeEffectFrames = busterData.value.Charge_Effect.filter((f: any) => 
          f.name.startsWith('Charge_LV3_')
        ).sort((a: any, b: any) => {
          const numA = parseInt(a.name.match(/_(\d+)/)?.[1] || '0')
          const numB = parseInt(b.name.match(/_(\d+)/)?.[1] || '0')
          return numA - numB
        })
        effectFrameIndex = Math.floor((chargeTime / 200) % chargeEffectFrames.length)
      }
      
      // Draw charge effect (glow/aura around player)
      if (chargeEffectFrames.length > 0 && effectFrameIndex < chargeEffectFrames.length) {
        const effectFrame = chargeEffectFrames[effectFrameIndex]
        const effectSprite = busterSprites.value.get(effectFrame.file)
        
        if (effectSprite && effectSprite.complete && effectSprite.naturalWidth > 0) {
          const effectWidth = effectSprite.naturalWidth
          const effectHeight = effectSprite.naturalHeight
          const effectScale = effectWidth > 100 ? 0.5 : 1
          const effectDrawWidth = effectWidth * effectScale
          const effectDrawHeight = effectHeight * effectScale
          
          // Position charge effect centered on player
          const effectX = player.x + (64 - effectDrawWidth) / 2
          const effectY = player.y + (64 - effectDrawHeight) / 2
          
          ctx.drawImage(
            effectSprite,
            effectX,
            effectY,
            effectDrawWidth,
            effectDrawHeight
          )
        }
      }
    }
    
    // Draw health bar using HP sprites
    if (ctx && hpBarData.value && hpBarData.value.HP_Bar) {
      // Calculate HP value (0-32, since HP_Bar has 33 sprites: HP_0 to HP_32)
      const hpValue = Math.floor((player.health / player.maxHealth) * 32)
      const hpSpriteName = `HP_${hpValue}`
      
      const hpFrame = hpBarData.value.HP_Bar.find((f: any) => f.name === hpSpriteName)
      if (hpFrame && hpBarSprites.value.has(hpFrame.file)) {
        const hpSprite = hpBarSprites.value.get(hpFrame.file)!
        if (hpSprite && hpSprite.complete) {
          // Make health bar taller - use full height, scale width if needed
          const hpWidth = hpSprite.naturalWidth * (hpSprite.naturalWidth > 100 ? 0.5 : 1)
          const hpHeight = hpSprite.naturalHeight * (hpSprite.naturalHeight > 50 ? 1.0 : 2) // Make taller
          const hpX = player.x + (64 - hpWidth) / 2
          const hpY = player.y - hpHeight - 5
          
          ctx.drawImage(hpSprite, hpX, hpY, hpWidth, hpHeight)
        }
      }
    } else if (ctx) {
      // Fallback to simple bar if sprites not loaded
      const barWidth = 60
      const barHeight = 12 // Make taller
      const barX = player.x + (64 - barWidth) / 2
      const barY = player.y - 18
      
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
      ctx.fillRect(barX, barY, barWidth, barHeight)
      
      const healthPercent = player.health / player.maxHealth
      ctx.fillStyle = healthPercent > 0.5 ? '#4ecdc4' : healthPercent > 0.25 ? '#f9ca24' : '#eb4d4b'
      ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight)
    }
    
    // Draw smoke effects (size: 200 in project.json = 2x scale)
    if (player.smokeEffects.length > 0 && ctx) {
      player.smokeEffects = player.smokeEffects.filter(smoke => {
        const age = Date.now() - smoke.createdAt
        if (age > 400) return false // Remove after 400ms (6 frames at ~66ms each)
        
        // Draw smoke sprite (if loaded) - not looping, just one cycle
        const smokeFrame = Math.min(Math.floor(age / 66), 5) // 6 smoke frames, no loop
        const smokeSprite = smokeSprites.value.get(`Smoke${smokeFrame + 1}.png`)
        if (smokeSprite && smokeSprite.complete && ctx) {
          // 2x scale like project.json (size: 200)
          const scale = 2.0
          const smokeWidth = smokeSprite.naturalWidth * scale
          const smokeHeight = smokeSprite.naturalHeight * scale
          ctx.globalAlpha = 1 - (age / 400) // Fade out
          ctx.drawImage(smokeSprite, smoke.x - smokeWidth/2, smoke.y - smokeHeight/2, smokeWidth, smokeHeight)
          ctx.globalAlpha = 1.0
        }
        return true
      })
    }
    
    // Draw dash effect behind player when dashing (size: 200 = 2x scale)
    if (player.state === 'dashing' && player.dashStartTime && ctx) {
      const dashElapsed = Date.now() - player.dashStartTime
      const dashFrame = Math.min(Math.floor(dashElapsed / 50), 3) + 1 // 4 frames, cycle quickly
      const dashEffectSprite = dashEffectSprites.value.get(`Dash_Effect${dashFrame}.png`)
      
      if (dashEffectSprite && dashEffectSprite.complete) {
        const scale = 2.0 // 2x scale like project.json
        const effectWidth = dashEffectSprite.naturalWidth * scale
        const effectHeight = dashEffectSprite.naturalHeight * scale
        
        ctx.save()
        // Position effect behind player (opposite of facing direction)
        const effectX = player.facing === 'right' 
          ? player.x - effectWidth + 20 
          : player.x + 64 - 20
        
        if (player.facing === 'left') {
          ctx.scale(-1, 1)
          ctx.drawImage(dashEffectSprite, -effectX - effectWidth, player.y + 32 - effectHeight/2, effectWidth, effectHeight)
        } else {
          ctx.drawImage(dashEffectSprite, effectX, player.y + 32 - effectHeight/2, effectWidth, effectHeight)
        }
        ctx.restore()
      }
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
    const { userId, x, y, facing, state, velocityX, velocityY, isShooting, isCharging, chargeLevel, onWall, wallSide, health, maxHealth } = payload.payload as any
    
    // Don't update local player from remote updates
    if (userId === props.userId) return
    
    let player = players.value.get(userId)
    
    // Create player if they don't exist (for late joiners)
    if (!player) {
      const canvasHeight = gameCanvasHeight.value
      const floorY = canvasHeight - 20
      const canvasWidth = gameCanvasWidth.value
      const randomX = 50 + Math.random() * (canvasWidth - 150)
      
      // Find color index for this user
      const participantIndex = props.participants.findIndex(p => p.userId === userId)
      const colorIndex = participantIndex >= 0 ? participantIndex : players.value.size
      
      player = {
        userId,
        x: randomX,
        y: floorY - 64,
        facing: 'right',
        state: 'idle',
        velocityX: 0,
        velocityY: 0,
        onGround: true,
        onWall: false,
        wallSide: null,
        color: PLAYER_COLORS[colorIndex % PLAYER_COLORS.length],
        isShooting: false,
        isCharging: false,
        chargeLevel: 0,
        chargeStartTime: 0,
        lastShotTime: 0,
        dashCooldown: 0,
        canDash: true,
        health: 100,
        maxHealth: 100,
        hitTime: 0,
        invulnerableUntil: 0,
        canWallJump: false,
        smokeEffects: [],
        lastJumpKeyPressed: false,
        lastDashKeyPressed: false,
        isSpawning: false, // Remote players don't show spawn locally
        spawnTime: 0
      } as Player
      
      players.value.set(userId, player)
      currentFrame.value.set(userId, 0)
      frameTime.value.set(userId, 0)
      chargeFrame.value.set(userId, 0)
      
      debug.log(`🎮 Created remote player: ${userId}`)
    }
    
    // Update player state
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
      if (health !== undefined) player.health = health
      if (maxHealth !== undefined) player.maxHealth = maxHealth
      // Update lastShotTime for shooting animation sync
      const remoteLastShotTime = (payload.payload as any).lastShotTime
      if (remoteLastShotTime !== undefined && remoteLastShotTime > 0) {
        player.lastShotTime = remoteLastShotTime
        player.isShooting = Date.now() - remoteLastShotTime < 200
      }
      
      // Debug: Log facing updates
      // debug.log(`🎮 Remote player ${userId.substring(0, 6)} facing: ${facing}`)
    }
  })
  
  gameChannel.on('broadcast', { event: 'player-damaged' }, (payload) => {
    const { userId, health } = payload.payload as any
    
    const player = players.value.get(userId)
    if (player) {
      player.health = health
    }
  })
  
  gameChannel.on('broadcast', { event: 'resolution-request' }, (payload) => {
    const { userId, width, height } = payload.payload
    playerResolutions.value.set(userId, { width, height })
    updateCanvasSize()
    
    // Respond with our resolution using the same channel
    if (gameChannel) {
      gameChannel.send({
        type: 'broadcast',
        event: 'resolution-response',
        payload: {
          userId: props.userId,
          width: Math.max(360, window.innerWidth),
          height: Math.max(240, window.innerHeight)
        }
      })
    }
  })
  
  gameChannel.on('broadcast', { event: 'resolution-response' }, (payload) => {
    const { userId, width, height } = payload.payload
    playerResolutions.value.set(userId, { width, height })
    updateCanvasSize()
  })
  
  gameChannel.on('broadcast', { event: 'bullet-fired' }, (payload) => {
    const bullet = payload.payload as Bullet
    
    // Don't add our own bullets (we already created them locally)
    if (bullet.userId === props.userId) return
    
    // Add remote bullet
    bullets.value.set(bullet.id, bullet)
  })
  
  gameChannel.on('broadcast', { event: 'bullet-removed' }, (payload) => {
    const { bulletId } = payload.payload as { bulletId: string }
    // Remove bullet for all players when it hits someone
    bullets.value.delete(bulletId)
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

function updateCanvasSize() {
  if (playerResolutions.value.size === 0) {
    gameCanvasWidth.value = Math.max(360, window.innerWidth)
    gameCanvasHeight.value = Math.max(240, window.innerHeight)
    return
  }
  
  // Find minimum resolution
  let minWidth = Infinity
  let minHeight = Infinity
  
  playerResolutions.value.forEach((res) => {
    minWidth = Math.min(minWidth, res.width)
    minHeight = Math.min(minHeight, res.height)
  })
  
  // Apply minimums
  gameCanvasWidth.value = Math.max(360, minWidth)
  gameCanvasHeight.value = Math.max(240, minHeight)
  
  // Update canvas if it exists
  if (canvas && ctx) {
    const dpr = window.devicePixelRatio || 1
    canvas.width = gameCanvasWidth.value * dpr
    canvas.height = gameCanvasHeight.value * dpr
    ctx.scale(dpr, dpr)
    canvas.style.width = `${gameCanvasWidth.value}px`
    canvas.style.height = `${gameCanvasHeight.value}px`
  }
}

function requestPlayerResolutions() {
  // Store our own resolution first
  playerResolutions.value.set(props.userId, {
    width: Math.max(360, window.innerWidth),
    height: Math.max(240, window.innerHeight)
  })
  
  // Update canvas size based on minimum resolution
  updateCanvasSize()
  
  // Broadcast our resolution using gameChannel (after it's set up)
  // This will be called after setupRealtimeListener, so gameChannel should exist
  if (gameChannel) {
    gameChannel.send({
      type: 'broadcast',
      event: 'resolution-request',
      payload: {
        userId: props.userId,
        width: Math.max(360, window.innerWidth),
        height: Math.max(240, window.innerHeight)
      }
    })
  }
}

function initializeCanvas() {
  if (!canvasRef.value) return
  
  canvas = canvasRef.value
  ctx = canvas.getContext('2d')
  
  // Request window resolution from all players
  requestPlayerResolutions()
  
  // Use synced canvas dimensions (will be updated when resolutions are received)
  const canvasWidth = gameCanvasWidth.value
  const canvasHeight = gameCanvasHeight.value
  
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
  gameStartTime = Date.now()
  showIntro = true
  
  // Initialize players after a short delay to show intro first
  setTimeout(() => {
    initializePlayers()
  }, 100)
  
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
    setupRealtimeListener() // Setup listener first so gameChannel is available
    // Start game loop immediately
    startGame()
    // Then initialize players and load assets
    initializePlayers()
    loadAnimations().then(() => {
      debug.log('🎮 Animations and sprites loaded')
    })
    // Request resolutions after channel is set up
    setTimeout(() => {
      requestPlayerResolutions()
    }, 100)
  }
})

onUnmounted(() => {
  stopGame()
})

function closeGame() {
  stopGame()
  emit('close')
}
</script>

<style scoped>
.megaman-game-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  height: 100%;
  z-index: 10003; /* Above voice overlay */
  pointer-events: all;
  overflow: hidden;
}

.megaman-canvas {
  background: rgba(26, 26, 46, 0.95);
  border: 2px solid #4ecdc4;
  box-shadow: 0 0 20px rgba(78, 205, 196, 0.6);
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  display: block;
  position: relative;
  z-index: 10003;
}

.close-button {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 10005; /* Higher than canvas z-index (10003) */
  background: rgba(0, 0, 0, 0.8);
  border: 2px solid #4ecdc4;
  border-radius: 4px;
  color: #4ecdc4;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
  pointer-events: all;
}

.close-button:hover {
  background: rgba(78, 205, 196, 0.2);
  transform: scale(1.1);
}

.close-button:active {
  transform: scale(0.95);
}
</style>
