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
  playerIndex: number
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
  isWallJumping?: boolean // True when performing a wall jump (keep jump animation until re-attaching)
  wallKickTime?: number // When wall kick animation started
  chargeLoopStarted?: boolean // Track if charge loop has been started for this charge cycle
  // Interpolation for remote players
  targetX?: number // Target position from network
  targetY?: number // Target position from network
  lastNetworkUpdate?: number // Timestamp of last network update
  dashFrameProgress?: number // Dash animation progress (0.0 to 1.0) for deltaTime-based animation
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
const lastAnimationType = ref<Map<string, 'walk' | 'run_fire' | 'other'>>(new Map()) // Track last animation to detect switches
const lastPlayerStateMap = ref<Map<string, string>>(new Map()) // Track last player state to detect state transitions
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
const WALL_SLIDE_SPEED = 3.5 // Slide down faster (positive = down)
const WALK_SPEED = 3
const DASH_SPEED = 10
const DASH_DURATION = 350 // ms
const DASH_COOLDOWN = 500 // ms
const FRAME_DURATION = 200 // ms per frame (slower animation)
const BULLET_SPEED = 12
const CHARGE_TIME_LV1 = 500 // ms
const CHARGE_TIME_LV2 = 1500 // ms
const CHARGE_TIME_LV3 = 3000 // ms

// Player colors for differentiation
const PLAYER_COLORS = [
  '#ff6b6b', '#cd3c41', '#7832bf', '#f9ca24', 
  '#b83275', '#2ec91c', '#020203', '#e5e4f2'
]

// Palette maps for color swapping - maps actual source colors to target player colors
// Source colors: 203080, 0040f0, 0080f8, 1858b0, 50a0f0, 78d8f0, f04010
// Edit these HEX values to fine-tune each player's palette
// Indexed by player index (0 = Player 1, 1 = Player 2, etc.)
const PALETTE_MAPS: Array<Record<string, string>> = [
  // Player 1 (index 0): Red (#ff6b6b) - stays as original blue Megaman (no swap)
  {
    '203080': '203080', // dark blue → dark blue (unchanged)
    '0040f0': '0040f0', // mid blue → mid blue (unchanged)
    '0080f8': '0080f8', // bright blue → bright blue (unchanged)
    '1858b0': '1858b0', // dark light blue → dark light blue (unchanged)
    '50a0f0': '50a0f0', // mid light blue → mid light blue (unchanged)
    '78d8f0': '78d8f0', // bright light blue → bright light blue (unchanged)
    'f04010': 'f04010'  // accent → accent (unchanged)
  },
  
  // Player 2 (index 1): Dark Red (#cd3c41)
  {
    '203080': '96050b', // dark blue → dark red
    '0040f0': 'df3030', // mid blue → mid red
    '0080f8': 'f75757', // bright blue → bright red
    '1858b0': '666699', // dark light blue → dark light red
    '50a0f0': '9999cc', // mid light blue → mid light red
    '78d8f0': 'ccccff', // bright light blue → bright light red
    'f04010': 'f04010'  // accent → red accent
  },
  
  // Player 3 (index 2): Purple (#7832bf)
  {
    '203080': '601976', // dark blue → dark purple
    '0040f0': '9f33b3', // mid blue → mid purple
    '0080f8': 'ca4dd9', // bright blue → bright purple
    '1858b0': '995a6c', // dark light blue → dark light purple
    '50a0f0': 'bf8294', // mid light blue → mid light purple
    '78d8f0': 'e7afbf', // bright light blue → bright light purple
    'f04010': 'f04010'  // accent → purple accent
  },
  
  // Player 4 (index 3): purple/orange 
  {
    '203080': '403850', // dark blue → dark yellow
    '0040f0': '5040b0', // mid blue → mid yellow
    '0080f8': '5868e8', // bright blue → bright yellow
    '1858b0': 'd85800', // dark light blue → dark light yellow
    '50a0f0': 'f88000', // mid light blue → mid light yellow
    '78d8f0': 'f8c000', // bright light blue → bright light yellow
    'f04010': 'f04010'  // accent → yellow accent
  },
  
  // Player 5 (index 4): Green
  {
    '203080': '085028', // dark blue → dark magenta
    '0040f0': '209050', // mid blue → mid magenta
    '0080f8': '18b050', // bright blue → bright magenta
    '1858b0': '20b878', // dark light blue → dark light magenta
    '50a0f0': '60d0a8', // mid light blue → mid light magenta
    '78d8f0': 'c0f0e0', // bright light blue → bright light magenta
    'f04010': 'f04010'  // accent → magenta accent
  },
  // Player 6 (index 5): Light Blue
  {
    '203080': '2868b0', // dark blue → dark light blue
    '0040f0': '50a0f0', // mid blue → mid light blue
    '0080f8': '78d8f0', // bright blue → bright light blue
    '1858b0': '8868b8', // dark light blue → dark light light blue
    '50a0f0': 'b090e0', // mid light blue → mid light light blue
    '78d8f0': 'f0c8f8', // bright light blue → bright light light blue
    'f04010': 'f04010'  // accent → light blue accent
  },
  
  // Player 7 (index 6): Black (#020203)
  {
    '203080': '3d3d3d', // dark blue → black
    '0040f0': '5f5f5f', // mid blue → dark gray
    '0080f8': '858585', // bright blue → mid gray
    '1858b0': 'c06808', // dark light blue → dark gray
    '50a0f0': 'e09810', // mid light blue → gray
    '78d8f0': 'e8c808', // bright light blue → light gray
    'f04010': 'f04010'  // accent → gray accent
  },
  // Player 8 (index 7): Light Gray/White (#e5e4f2)
  {
    '203080': '602078', // dark blue → dark gray
    '0040f0': '7040b8', // mid blue → mid gray
    '0080f8': 'a080f8', // bright blue → light gray
    '1858b0': '608840', // dark light blue → gray
    '50a0f0': '78d048', // mid light blue → light gray
    '78d8f0': 'd0e098', // bright light blue → white
    'f04010': 'f04010'  // accent → light gray accent
  }
  
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
    
    // For looping sounds, stop any existing sound first to ensure clean restart
    if (loop || soundName === 'chargeLoop') {
      const currentSound = playingSounds.get(soundName)
      if (currentSound) {
        // If already playing and we're trying to start the same loop, don't restart (let it continue)
        if (!currentSound.paused && soundName === 'chargeLoop') {
          return // Already playing charge loop, don't restart
        }
        // If paused or different sound, clean it up first
        currentSound.pause()
        currentSound.currentTime = 0
        playingSounds.delete(soundName)
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
        
        // Set up error handler before playing
        audio.onerror = () => {
          debug.warn(`🎮 Audio error for ${soundName}:`, path)
          playingSounds.delete(soundName)
        }
        
        const playPromise = audio.play()
        if (playPromise) {
          playPromise.then(() => {
            // Store reference for looping sounds so we can stop them
            if (loop || soundName === 'chargeLoop') {
              playingSounds.set(soundName, audio)
              debug.log(`🎮 Started playing ${soundName}`)
            }
          }).catch((err) => {
            // Ignore errors - file might not exist or need user interaction
            debug.warn(`Could not play sound ${path}:`, err)
            playingSounds.delete(soundName)
          })
        } else {
          // If play() returns undefined, still store it (some browsers)
          if (loop || soundName === 'chargeLoop') {
            playingSounds.set(soundName, audio)
          }
        }
        // If we successfully created and attempted to play, break
        break
      } catch (e) {
        // Try next path
        debug.warn(`🎮 Failed to create audio for ${soundName}:`, e)
        continue
      }
    }
  } catch (error) {
    debug.warn(`🎮 Error in playSound for ${soundName}:`, error)
  }
}

function stopSound(soundName: keyof typeof soundPaths) {
  const currentSound = playingSounds.get(soundName)
  if (currentSound) {
    try {
      currentSound.pause()
      currentSound.currentTime = 0
      // Remove all event listeners to prevent memory leaks
      currentSound.onerror = null
      currentSound.onended = null
    } catch (e) {
      debug.warn(`🎮 Error stopping sound ${soundName}:`, e)
    }
    playingSounds.delete(soundName)
    debug.log(`🎮 Stopped ${soundName}`)
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
  
  // Load intro/spawn sprites (teleport down animation) with actual asset IDs from project.json
  const introAssetIds = [
    '062d1319d34873caf1595d5350fa0f95', // Intro1
    '7eabef48d8ae4ca359b4f2b413c01d3f', // Intro2
    '397dd48364d7797a1966111ac645499d', // Intro3
    '51b4931d1cad57ed6f312959345d6e15', // Intro4
    'e65748ac66ef7a8421589d5eed9ca23b', // Intro5
    '5f5c15f2c31c879bf52a9d302a5557f7', // Intro6
    'e9a0864c7c300064114ea52988445b2d', // Intro7
  ]
  for (let i = 0; i < introAssetIds.length; i++) {
    const introImg = new Image()
    introImg.src = `/assets/easteregg/megaman/sprites/${introAssetIds[i]}.png`
    introImg.onload = () => {
      readySprites.value.set(`Intro${i + 1}.png`, introImg)
      debug.log(`🎮 Loaded Intro${i + 1} sprite`)
    }
    introImg.onerror = () => debug.warn(`🎮 Failed to load Intro${i + 1} sprite`)
  }
  
  // Load Ready text sprites with actual asset IDs from project.json
  const readyAssetIds = [
    '3495321c6b96977754d0640a217b0bbb', // Ready0
    'ab48d7b0004000561df78c2ed1a49097', // Ready1
    '527415308683c1ae03002b994f62523c', // Ready2
    '05361c98720aa7b021e7baa040305c96', // Ready3
    '53916d8af31494b8ad18e43da577f42d', // Ready4
    '273d250fa24222dfabc193731ece432e', // Ready5
    '2d99806b4adb3c306337b7b831d7dc9f', // Ready6
    'c105cc8cfe61d517749eee97dd6a44d4', // Ready7
    'a34556b9a853e584a69aee58987bea60', // Ready8
    'cf16acf016e7eccdf36303bc36154417', // Ready9
    'b80a6838d5f53cddf60be65dc119c25a', // Ready10
    'ebc29ca008dad4472c2364093628cd0e', // Ready11
    'd27003a4b30032e3001dfef312fc4c69', // Ready12
  ]
  for (let i = 0; i < readyAssetIds.length; i++) {
    const readyImg = new Image()
    readyImg.src = `/assets/easteregg/megaman/sprites/${readyAssetIds[i]}.png`
    readyImg.onload = () => {
      readySprites.value.set(`Ready${i}.png`, readyImg)
      debug.log(`🎮 Loaded Ready${i} sprite`)
    }
    readyImg.onerror = () => debug.warn(`🎮 Failed to load Ready${i} sprite`)
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
  
  // Ensure local player is always created, even if not in participants yet
  const allParticipants = [...props.participants]
  const localPlayerExists = allParticipants.some(p => p.userId === props.userId)
  if (!localPlayerExists && props.userId) {
    allParticipants.push({ userId: props.userId })
  }
  
  // Get colors already used by existing players
  const usedColors = new Set<string>()
  players.value.forEach((existingPlayer) => {
    usedColors.add(existingPlayer.color)
  })
  
  allParticipants.forEach((participant, index) => {
    // Spawn positions - random X position for each player
    const canvasWidth = canvas ? canvas.width / (window.devicePixelRatio || 1) : 600
    // Random X position between 50 and canvasWidth - 114 (leaving some margin)
    const spawnX = Math.max(50, Math.min(canvasWidth - 114, 50 + Math.random() * (canvasWidth - 164)))
    const targetY = floorY - 64 // Where player will land
    
    // Assign unique color - randomly select from available colors (not used by other players)
    const availableColors = PLAYER_COLORS.filter(color => !usedColors.has(color))
    let playerColor: string
    let playerIndex: number
    
    if (availableColors.length > 0) {
      // Randomly pick from available colors
      const randomIndex = Math.floor(Math.random() * availableColors.length)
      playerColor = availableColors[randomIndex]
      playerIndex = PLAYER_COLORS.indexOf(playerColor)
      usedColors.add(playerColor) // Mark as used
    } else {
      // Fallback: all colors used (shouldn't happen with 8 colors max), pick randomly
      const randomIndex = Math.floor(Math.random() * PLAYER_COLORS.length)
      playerColor = PLAYER_COLORS[randomIndex]
      playerIndex = randomIndex
    }
    
    debug.log(`🎮 Player ${index} (${participant.userId.substring(0, 6)}) spawning at x=${spawnX} with color ${playerColor}`)
    
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
      color: playerColor,
      playerIndex: playerIndex,
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
      isWallJumping: false,
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
      // Broadcast initial spawn position multiple times to ensure sync
      setTimeout(() => broadcastPlayerState(player, true), 50)
      setTimeout(() => broadcastPlayerState(player, true), 150)
      setTimeout(() => broadcastPlayerState(player, true), 300)
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
    
    // Always stop charge loop when releasing space (clean up)
    stopSound('chargeLoop')
    localPlayer.chargeLoopStarted = false // Reset flag immediately
    
    if (localPlayer.isCharging) {
      // Fire based on charge level
      if (chargeTime >= CHARGE_TIME_LV1) {
        // Charged shot
        fireChargedShot(localPlayer)
        // Play appropriate charge level sound
        if (localPlayer.chargeLevel >= 3) {
          playSound('shootLv3')
        } else if (localPlayer.chargeLevel >= 2) {
          playSound('shootLv2')
        } else {
          playSound('shootLv1')
        }
      } else {
        // Quick tap = uncharged shot
        fireBullet(localPlayer, 0)
        playSound('shoot')
      }
      
      localPlayer.isCharging = false
      localPlayer.chargeLevel = 0
      localPlayer.chargeLoopStarted = false // Reset loop flag
      localPlayer.isShooting = false
      
      // Broadcast charge release to network
      broadcastPlayerState(localPlayer, true)
    } else {
      // Very quick tap without charging state
      fireBullet(localPlayer, 0)
      playSound('shoot')
    }
    
    // Always stop charge loop when releasing space (clean up)
    stopSound('chargeLoop')
    localPlayer.chargeStartTime = 0
    
    // Always broadcast when releasing charge (even if not charging)
    broadcastPlayerState(localPlayer, true)
  }
  
  handleInput()
}

function handleInput() {
  const localPlayer = players.value.get(props.userId)
  if (!localPlayer) return
  
  const now = Date.now()
  
  // Dash (Shift) - single press, not hold, Megaman X style
  // Only trigger dash on key press (not while holding)
  const dashKeyPressed = keys.value.has('ShiftLeft') || keys.value.has('ShiftRight')
  const wasDashKeyPressed = localPlayer.lastDashKeyPressed || false
  
  // Handle dash state FIRST - check if dash should end
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
    
    // Dash ends automatically after DASH_DURATION - not holdable
    // Force end dash after duration, regardless of input
    if (dashElapsed >= DASH_DURATION) {
      // End dash - transition to next state based on input
      const holdingLeft = keys.value.has('ArrowLeft')
      const holdingRight = keys.value.has('ArrowRight')
      if ((holdingLeft && localPlayer.facing === 'left') || (holdingRight && localPlayer.facing === 'right')) {
        localPlayer.state = 'walking'
        localPlayer.velocityX = localPlayer.facing === 'right' ? WALK_SPEED : -WALK_SPEED
      } else {
        localPlayer.state = 'idle'
        localPlayer.velocityX = 0
      }
      // Clear dash state completely - IMPORTANT: clear before setting canDash
      localPlayer.dashStartTime = 0 // Clear dash start time so animation doesn't keep showing dash frames
      localPlayer.dashFrameProgress = 0 // Clear dash frame progress
      localPlayer.isDashJumping = false
      // Set canDash AFTER clearing dash state to prevent immediate re-trigger
      // Also ensure we don't allow dash if shift is still held
      localPlayer.canDash = true
      broadcastPlayerState(localPlayer, true)
      // Update lastDashKeyPressed BEFORE returning to prevent re-trigger
      localPlayer.lastDashKeyPressed = dashKeyPressed
      // Return here to prevent processing dash trigger logic below
      return
    } else {
      // Still dashing - broadcast state
      broadcastPlayerState(localPlayer, true)
    }
    localPlayer.lastJumpKeyPressed = keys.value.has('ArrowUp')
    localPlayer.lastDashKeyPressed = dashKeyPressed // Update while dashing
    return // Don't process other movement during dash
  }
  
  // Update lastDashKeyPressed for next frame (only if not dashing)
  localPlayer.lastDashKeyPressed = dashKeyPressed
  
  // Only allow dash if NOT currently dashing and key was just pressed
  // This prevents holding shift from re-triggering dash
  // CRITICAL: !wasDashKeyPressed means key was NOT pressed last frame, so this is a new press
  if (dashKeyPressed && !wasDashKeyPressed && localPlayer.canDash && 
      localPlayer.onGround && (localPlayer.state as string) !== 'dashing' && 
      now - localPlayer.dashCooldown >= DASH_COOLDOWN) {
      localPlayer.state = 'dashing'
      localPlayer.dashStartTime = now
      localPlayer.dashFrameProgress = 0 // Reset dash frame progress
      localPlayer.isDashJumping = false
    localPlayer.velocityX = localPlayer.facing === 'right' ? DASH_SPEED : -DASH_SPEED
    localPlayer.velocityY = 0 // Stay on ground during dash
    localPlayer.canDash = false
    localPlayer.dashCooldown = now
    playSound('dash')
    broadcastPlayerState(localPlayer, true)
    return // Don't process other input during dash start
  }
  
  // Charging (hold Space) - only update charge, don't fire here
  if (keys.value.has('Space')) {
    if (!localPlayer.isCharging) {
      // Starting a new charge - stop any existing loop first
      stopSound('chargeLoop')
      localPlayer.isCharging = true
      localPlayer.chargeStartTime = now
      localPlayer.chargeLevel = 0
      localPlayer.chargeLoopStarted = false // Reset loop flag
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
      
      // Play charge sound on start, then loop continuously (ONLY ONCE per charge cycle)
      // Megaman X behavior: Initial charge sound plays once, then loop starts and continues
      // Since handleInput is called every frame now, we need to be careful about the loop
      // Only play charge sound if we're actually going to charge (chargeTime >= 150ms)
      // Don't play for quick taps that will just fire uncharged bullets (< 150ms)
      // Quick taps are typically < 100ms, so 150ms threshold ensures we only play for actual charges
      if (chargeTime >= 150 && chargeTime < 200 && !localPlayer.chargeLoopStarted) {
        // Initial charge sound - play once after 150ms (only if actually charging, not quick tap)
        playSound('charge')
        localPlayer.chargeLoopStarted = false // Reset flag when starting new charge
      } else if (chargeTime >= 250 && !localPlayer.chargeLoopStarted) {
        // Start charge loop after initial charge sound - ONLY ONCE
        // Stop any existing loop first to ensure clean start
        stopSound('chargeLoop')
        playSound('chargeLoop', true) // Loop continuously until release
        localPlayer.chargeLoopStarted = true // Mark that we've started the loop
      }
    }
  } else {
    // Space not pressed - if we were charging, stop the loop
    // This handles the case where Space is released but handleKeyUp hasn't fired yet
    if (localPlayer.isCharging) {
      stopSound('chargeLoop')
      localPlayer.chargeLoopStarted = false // Reset flag
    }
  }
  
  // Movement with arrow keys (not during dash or dashJumping)
  // Physics-like: Don't override velocityX while in the air - preserve momentum
  // This is especially important for dash jumps to maintain horizontal dash speed
  const previousFacing = localPlayer.facing
  // Note: We already return early if dashing, so this check is just for safety
  // Also exclude dashJumping to preserve horizontal dash momentum during dash jump
  const isInAir = !localPlayer.onGround && !localPlayer.onWall
  
  if ((localPlayer.state as string) !== 'dashing' && (localPlayer.state as string) !== 'dashJumping') {
    // Only apply movement input when on ground - preserve momentum while in air
    if (!isInAir) {
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
    }
    // While in air: preserve existing velocityX (don't override) - physics-like behavior
    
    // Broadcast immediately if facing changed (force broadcast)
    if (previousFacing !== localPlayer.facing) {
      // Force immediate broadcast on facing change
      broadcastPlayerState(localPlayer, true)
      debug.log(`🎮 Facing changed to ${localPlayer.facing}, broadcasting immediately`)
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
      // Wall kick - jump up and in the direction the player is pressing (left/right)
      localPlayer.velocityY = -14 // Strong upward kick
      
      // Check which direction player is pressing - allow directional control
      const pressingLeft = keys.value.has('ArrowLeft')
      const pressingRight = keys.value.has('ArrowRight')
      
      if (pressingLeft) {
        // Jump left
        localPlayer.velocityX = -8 // Jump left with more speed
        localPlayer.facing = 'left'
      } else if (pressingRight) {
        // Jump right
        localPlayer.velocityX = 8 // Jump right with more speed
        localPlayer.facing = 'right'
      } else {
        // No direction pressed - kick away from wall (default behavior)
        localPlayer.velocityX = localPlayer.wallSide === 'left' ? 5 : -5
        localPlayer.facing = localPlayer.wallSide === 'left' ? 'right' : 'left'
      }
      localPlayer.onWall = false
      const previousWallSide = localPlayer.wallSide
      localPlayer.wallSide = null
      localPlayer.canWallJump = false
      localPlayer.state = 'wallKick' // Use wall kick state for animation
      localPlayer.isWallJumping = true // Mark as wall jumping to preserve jump animation
      localPlayer.wallKickTime = Date.now()
      playSound('jump')
      broadcastPlayerState(localPlayer, true) // Force broadcast wall jump with facing change
      // Add smoke effect at kick position
      localPlayer.smokeEffects.push({
        x: previousWallSide === 'left' ? localPlayer.x : localPlayer.x + 64,
        y: localPlayer.y + 32,
        frame: 0,
        createdAt: Date.now()
      })
      // After wall kick animation (200ms), switch to jumping
      // Keep jump animation until re-attaching to wall
      setTimeout(() => {
        if (localPlayer.state === 'wallKick' && !localPlayer.onWall) {
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
let lastFacing: 'left' | 'right' | null = null
let lastState: string | null = null
const BROADCAST_INTERVAL = 16 // Broadcast every ~16ms (~60fps) - minimal throttling for network efficiency

function broadcastPlayerState(player: Player, force: boolean = false) {
  if (!props.channelId || !gameChannel) return
  
  const now = Date.now()
  
  // Ensure facing is always valid ('left' or 'right')
  const facingValue = (player.facing === 'left' || player.facing === 'right') ? player.facing : 'right'
  
  // Detect critical changes that need immediate broadcast
  const facingChanged = lastFacing !== null && lastFacing !== facingValue
  const stateChanged = lastState !== null && lastState !== player.state
  const isCriticalUpdate = facingChanged || stateChanged || force
  
  if (facingChanged) {
    lastFacing = facingValue
    debug.log(`🎮 Facing changed to ${facingValue}, forcing immediate broadcast`)
  } else if (lastFacing === null) {
    lastFacing = facingValue
  }
  
  if (stateChanged) {
    lastState = player.state
  } else if (lastState === null) {
    lastState = player.state
  }
  
  // Minimal throttling - only skip if it's a non-critical update and very recent
  if (!isCriticalUpdate && now - lastBroadcastTime < BROADCAST_INTERVAL) {
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
      facing: facingValue, // Critical: must always be included for proper orientation sync
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
      isSpawning: player.isSpawning || false, // Sync spawn state
      spawnY: player.spawnY || 0,
      spawnX: player.x, // Broadcast spawn X position
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
  
  // Always clear canvas first (proper z-buffer clearing)
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)
  
  // Draw background
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
          player.hitTime = now // Set hitTime for death animation
          playSound('death') // Use X_LoseLife sound for death
          
          // Broadcast death event
          if (gameChannel) {
            gameChannel.send({
              type: 'broadcast',
              event: 'player-died',
              payload: {
                userId: player.userId,
                health: player.health
              }
            })
          }
          
          // Broadcast death state
          broadcastPlayerState(player, true)
          
          // Respawn after 3 seconds with spawn animation
          setTimeout(() => {
            if (player.health <= 0) {
              const canvasWidth = gameCanvasWidth.value
              const canvasHeight = gameCanvasHeight.value
              const floorY = canvasHeight - 20
              
              // Random spawn X position
              const spawnX = Math.max(50, Math.min(canvasWidth - 114, 50 + Math.random() * (canvasWidth - 164)))
              
              player.health = player.maxHealth
              player.x = spawnX
              player.y = -100 // Start above screen for spawn animation
              player.velocityX = 0
              player.velocityY = 0
              player.state = 'idle'
              player.isSpawning = true
              player.spawnTime = Date.now()
              player.spawnY = floorY - 64 // Target Y position
              player.invulnerableUntil = Date.now() + 2000 // Extra invulnerability on respawn
              playSound('spawn') // Teleport down sound
              
              // Broadcast respawn with spawn position
              broadcastPlayerState(player, true)
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
    const isLocalPlayer = userId === props.userId
    
    if (isLocalPlayer) {
      // Process input every frame (not just on key events) so dash duration checks run continuously
      handleInput()
      
      // Update physics for local player only
      if (!player.onGround && !player.onWall) {
        player.velocityY += GRAVITY * deltaSeconds * 60
      }
    } else {
      // REMOTE PLAYERS: Apply physics locally based on network velocity for smooth movement
      // This makes them move smoothly every frame, not just when network updates arrive
      if (!player.onGround && !player.onWall && player.velocityY !== undefined) {
        // Apply gravity to remote players based on their state
        if (player.state !== 'wallCling') {
          player.velocityY += GRAVITY * deltaSeconds * 60
        }
      }
      
      // Apply velocity to remote player position every frame (smooth movement)
      if (player.velocityX !== undefined && player.velocityY !== undefined) {
        player.x += player.velocityX * deltaSeconds * 60
        player.y += player.velocityY * deltaSeconds * 60
      }
      
      // Snap to network position if difference is large (correction for drift)
      // Use tighter threshold for smoother correction
      if (player.targetX !== undefined && player.targetY !== undefined && player.lastNetworkUpdate) {
        const timeSinceUpdate = Date.now() - player.lastNetworkUpdate
        // Only correct if update is recent (within 100ms) and difference is significant
        if (timeSinceUpdate < 100) {
          const dx = Math.abs(player.targetX - player.x)
          const dy = Math.abs(player.targetY - player.y)
          // Snap if difference is large (teleport correction) or interpolate if small
          if (dx > 20 || dy > 20) {
            // Large difference - snap immediately (network correction)
            player.x = player.targetX
            player.y = player.targetY
          } else if (dx > 1 || dy > 1) {
            // Small difference - smooth interpolation
            const interpolationSpeed = 0.5 // Faster interpolation
            player.x += (player.targetX - player.x) * interpolationSpeed
            player.y += (player.targetY - player.y) * interpolationSpeed
          }
        }
      }
      
      // Ground collision for remote players (prevent falling through floor)
      // But respect spawn animation - don't snap to floor during spawn
      if (!player.isSpawning && player.y >= floorY - 64) {
        player.y = floorY - 64
        if (player.velocityY !== undefined && player.velocityY > 0) {
          player.velocityY = 0
        }
        player.onGround = true
      } else if (player.isSpawning) {
        // During spawn, use spawnY as floor limit
        const spawnFloorY = player.spawnY || (floorY - 64)
        if (player.y >= spawnFloorY) {
          player.y = spawnFloorY
          if (player.velocityY !== undefined && player.velocityY > 0) {
            player.velocityY = 0
          }
          player.onGround = true
        } else {
          player.onGround = false
        }
      } else {
        player.onGround = false
      }
      
      // Boundary collision for remote players
      if (player.x < 0) {
        player.x = 0
      }
      if (player.x > canvasWidth - 64) {
        player.x = canvasWidth - 64
      }
    }
    
    // Wall detection (only for local player - remote players get wall state from network)
    const wallThreshold = 5
    const isNearLeftWall = player.x <= wallLeft + wallThreshold
    const isNearRightWall = player.x >= wallRight - wallThreshold - 64
    
    // Only apply wall detection and collision to LOCAL player
    // Remote players use network-synced wall state but still apply physics
    if (isLocalPlayer) {
      if ((isNearLeftWall || isNearRightWall) && !player.onGround) {
        // Check if player is moving towards wall
        const isPressingTowardLeft = keys.value.has('ArrowLeft')
        const isPressingTowardRight = keys.value.has('ArrowRight')
        
          // Wall cling only when pressing toward wall AND falling (velocityY > 0)
          if ((isPressingTowardLeft && isNearLeftWall) || (isPressingTowardRight && isNearRightWall)) {
            if (!player.onWall) {
              // Just touched wall - switch from jump/wallKick to wallCling
              player.canWallJump = true
              // If we were jumping or in wallKick state, switch to wallCling
              if (player.state === 'jumping' || player.state === 'wallKick') {
                player.state = 'wallCling'
                player.isWallJumping = false // Clear wall jump flag when re-attaching
              }
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
            // Ensure we're in wallCling state when on wall
            if (player.state === 'jumping' || player.state === 'wallKick') {
              player.state = 'wallCling'
              player.isWallJumping = false // Clear wall jump flag when re-attaching
            }
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
      
      // Apply velocity to position (local player - remote players already handled above)
      player.x += player.velocityX * deltaSeconds * 60
      player.y += player.velocityY * deltaSeconds * 60
      
      // Ground collision (local player)
      if (player.y >= floorY - 64) {
        if (!player.onGround) {
          // Just landed - play land sound
          playSound('land')
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
      // Keep dashJumping, wallKick, and wallJumping states until landing or state changes
      if (!player.onGround && !player.onWall && 
          player.state !== 'dashing' && 
          player.state !== 'dashJumping' && 
          player.state !== 'wallKick' &&
          player.state !== 'hit' &&
          player.state !== 'dead' &&
          !player.isWallJumping) { // Don't override state during wall jump
        if (player.velocityY > 0) {
          player.state = 'falling'
        } else if (player.velocityY < 0) {
          player.state = 'jumping'
        }
      }
      
      // Clear wall jump flag when landing
      if (player.onGround && player.isWallJumping) {
        player.isWallJumping = false
      }
      
      // Dash-jumping transitions: when velocity drops significantly, switch to fall
      if (player.state === 'dashJumping' && player.velocityY > 2) {
        player.state = 'falling'
        player.isDashJumping = true // Keep the momentum indicator
      }
      
      // Boundary collision (only for local player)
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
    }
    // Remote players: position/state come from network, no physics applied
    
    // Draw player
    drawPlayer(player, userId, deltaSeconds)
  })
  
  // Draw "READY" text animation ON TOP of everything (after players)
  if (showIntro && gameStartTime > 0 && ctx) {
    const introTime = Date.now() - gameStartTime
    // Show Ready text from 600ms (after spawn starts) to 2500ms
    if (introTime >= 600 && introTime < 2500) {
      const readyAnimTime = introTime - 600
      const readyFrame = Math.min(Math.floor(readyAnimTime / 130), 12) // ~130ms per frame
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
          (canvasHeight - readyHeight) / 2 - 20, // Slightly above center
          readyWidth,
          readyHeight
        )
        ctx.restore()
      }
    } else if (introTime >= 2500) {
      showIntro = false
    }
  }
  
  animationFrame = requestAnimationFrame(gameLoop)
}

// Get current animation frames based on player state
function getAnimationFrames(player: Player, deltaSeconds?: number): AnimationFrame[] {
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
  
  // Wall cling animation - slide down with static frame (no looping)
  if (player.onWall && player.state === 'wallCling') {
    const wallClingFrames = animations.value.wall_cling || []
    if (wallClingFrames.length > 0) {
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
  // When shooting during dash, use dash_fire sprites with same frame progression
  if (player.state === 'dashing') {
    const timeSinceLastShot = Date.now() - (player.lastShotTime || 0)
    const isShooting = (player.isShooting || timeSinceLastShot < 200) && !player.isCharging
    
    // Get base frames (dash or dash_fire depending on shooting)
    let baseFrames: AnimationFrame[] = []
    if (isShooting) {
      // Dash + shooting = use Dash_Fire sprites
      baseFrames = animations.value.dash_fire || animations.value.shoot.filter(f => 
        f.name.toLowerCase().includes('dash') && f.name.toLowerCase().includes('fire')
      )
      // Fallback to regular dash if no dash_fire available
      if (baseFrames.length === 0) {
        baseFrames = animations.value.dash || []
      }
    } else {
      // Normal dash = use Dash sprites
      baseFrames = animations.value.dash || []
    }
    
    if (baseFrames.length >= 2) {
      // Check if dashStartTime is valid (not 0 or undefined)
      if (!player.dashStartTime || player.dashStartTime === 0) {
        // Dash just started or dash ended - show frame1
        return [baseFrames[0]]
      }
      
      // Use deltaTime-based frame counter for smoother animation
      // Track dash frame progress (0.0 to 1.0)
      if (!player.dashFrameProgress) {
        player.dashFrameProgress = 0
      }
      
      // Increment dash frame progress using deltaTime
      if (deltaSeconds !== undefined) {
        const dashDurationSeconds = DASH_DURATION / 1000 // Convert to seconds
        player.dashFrameProgress += deltaSeconds / dashDurationSeconds
        
        // Clamp to 1.0 (dash complete)
        if (player.dashFrameProgress >= 1.0) {
          player.dashFrameProgress = 1.0
          // Dash ended - return to normal animation
          return animations.value.idle || []
        }
      } else {
        // Fallback to timestamp-based if deltaSeconds not provided
        const dashElapsed = Date.now() - player.dashStartTime
        const dashDuration = DASH_DURATION
        if (dashElapsed >= dashDuration) {
          return animations.value.idle || []
        }
        player.dashFrameProgress = dashElapsed / dashDuration
      }
      
      // First 25% (0.0 to 0.25): frame1 (start)
      if (player.dashFrameProgress < 0.25) {
        return [baseFrames[0]] // Dash1 or Dash_Fire1
      } 
      // Middle 50% (0.25 to 0.75): hold frame2
      else if (player.dashFrameProgress < 0.75) {
        return [baseFrames[1]] // Dash2 or Dash_Fire2 - held for most of dash
      } 
      // Last 25% (0.75 to 1.0): frame1 (end)
      else {
        return [baseFrames[0]] // Dash1 or Dash_Fire1 for end
      }
    } else if (baseFrames.length > 0) {
      return baseFrames
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
    // When walking and shooting, use run_fire sprites (same animation as walk, but with gun extended)
    // IMPORTANT: Preserve frame index when switching between walk and run_fire to avoid jerking
    if (player.state === 'walking') {
      // Get run_fire frames that match walk animation
      const runFireFrames = animations.value.shoot.filter(frame => {
        const name = frame.name.toLowerCase()
        return name.includes('run') && name.includes('fire')
      })
      
      if (runFireFrames.length > 0) {
        // Return run_fire frames - frame index will be preserved by the shared frame timer
        // The frame timer continues seamlessly, so frame 3 of walk becomes frame 3 of run_fire
        return runFireFrames
      }
    }
    
    const shootFrames = animations.value.shoot.filter(frame => {
      const name = frame.name.toLowerCase()
      if ((player.state === 'idle' || player.state === 'landing') && name.includes('idle') && name.includes('fire')) return true
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
  
  // No debug logging needed - facing is handled correctly
  
  // Handle spawn animation (teleport down from top of screen)
  // Megaman X style: Intro1 while falling from sky, then Intro2-7 when landing
  if (player.isSpawning && player.spawnTime) {
    const spawnElapsed = Date.now() - player.spawnTime
    const fallDuration = 500 // 500ms for falling from top
    const landDuration = 400 // 400ms for landing animation (Intro2-7)
    const totalSpawnDuration = fallDuration + landDuration
    
    if (spawnElapsed < totalSpawnDuration) {
      const targetY = player.spawnY || 200
      const startY = -80 // Start above screen
      
      let currentY: number
      let introFrameIndex: number
      
      if (spawnElapsed < fallDuration) {
        // FALLING PHASE: Use Intro1 (the beam/teleport effect) while falling
        const fallProgress = spawnElapsed / fallDuration
        // Fast ease-in for teleport feel
        const easedProgress = fallProgress * fallProgress * fallProgress
        currentY = startY + (targetY - startY) * easedProgress
        introFrameIndex = 1 // Always Intro1 while falling
      } else {
        // LANDING PHASE: Cycle through Intro2-7 at ground level
        currentY = targetY
        const landElapsed = spawnElapsed - fallDuration
        const landProgress = landElapsed / landDuration
        // Intro2-7 = 6 frames during landing
        introFrameIndex = Math.min(Math.floor(landProgress * 6) + 2, 7)
      }
      
      const introSprite = readySprites.value.get(`Intro${introFrameIndex}.png`)
      
      if (introSprite && introSprite.complete && introSprite.naturalWidth > 0) {
        ctx.save()
        const drawWidth = introSprite.naturalWidth
        const drawHeight = introSprite.naturalHeight
        
        // Center the sprite on player X position
        const drawX = player.x - drawWidth / 2 + 32 // Offset to center on player
        ctx.drawImage(introSprite, drawX, currentY - drawHeight + 64, drawWidth, drawHeight)
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
  
  const frames = getAnimationFrames(player, deltaSeconds)
  
  // Don't draw placeholder - wait for sprites to load
  if (frames.length === 0 || !animations.value) {
    return
  }
  
  // Update frame timer using delta time
  // Walking animation is faster (3x speed for smoother running)
  // Dash animation uses time-based frame selection (not cycling), so skip timer for dash
  // Wall cling plays through frames once (no looping) - stops at last frame
  let frameIndex = 0
  if (player.state === 'dashing') {
    // Dash uses time-based selection in getAnimationFrames, so always use first (and only) frame
    frameIndex = 0
  } else {
    const isWalking = player.state === 'walking' && !player.isCharging
    const isShooting = (player.isShooting || (Date.now() - (player.lastShotTime || 0) < 200)) && !player.isCharging
    const isWalkOrRunFire = isWalking || (player.state === 'walking' && isShooting)
    const isWallCling = player.state === 'wallCling'
    
    // Reset frame to 0 when transitioning to wallCling state (so animation plays from start)
    const lastPlayerState = lastPlayerStateMap.value.get(userId)
    if (isWallCling && lastPlayerState !== 'wallCling') {
      currentFrame.value.set(userId, 0)
      frameTime.value.set(userId, 0)
    }
    lastPlayerStateMap.value.set(userId, player.state)
    
    // Determine current animation type
    const currentAnimType: 'walk' | 'run_fire' | 'other' = 
      (player.state === 'walking' && isShooting) ? 'run_fire' :
      (player.state === 'walking') ? 'walk' : 'other'
    
    // Check if we switched between walk and run_fire
    const lastAnim = lastAnimationType.value.get(userId)
    const switchedWalkRunFire = (lastAnim === 'walk' && currentAnimType === 'run_fire') || 
                                (lastAnim === 'run_fire' && currentAnimType === 'walk')
    
    // Make walk animation 3x faster for smoother running
    const frameDuration = isWalkOrRunFire ? FRAME_DURATION / 3 : FRAME_DURATION
    
    const currentTime = frameTime.value.get(userId) || 0
    const newTime = currentTime + (deltaSeconds * 1000) // Add delta in ms
    frameTime.value.set(userId, newTime)
    
    if (newTime >= frameDuration) {
      const current = currentFrame.value.get(userId) || 0
      if (isWallCling) {
        // Wall cling: advance to next frame but stop at last frame (no looping)
        const next = Math.min(current + 1, frames.length - 1)
        currentFrame.value.set(userId, next)
      } else {
        // Other animations: loop using modulo
        const next = (current + 1) % frames.length
        currentFrame.value.set(userId, next)
      }
      frameTime.value.set(userId, 0) // Reset timer
    }
    
    frameIndex = currentFrame.value.get(userId) || 0
    
    // If we switched between walk and run_fire, advance to next frame immediately
    // This ensures: walk frame 3 → run_fire frame 4 (next in sequence)
    if (switchedWalkRunFire && frameIndex < frames.length) {
      frameIndex = (frameIndex + 1) % frames.length
      currentFrame.value.set(userId, frameIndex)
    }
    
    // Clamp frame index to valid range for current animation
    if (frameIndex >= frames.length) {
      if (isWallCling) {
        // Wall cling: clamp to last frame (no looping)
        frameIndex = frames.length - 1
      } else {
        // Other animations: use modulo to loop
        frameIndex = frameIndex % frames.length
      }
      currentFrame.value.set(userId, frameIndex)
    }
    
    // Update last animation type for next frame
    lastAnimationType.value.set(userId, currentAnimType)
  }
  
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
    // Player 1 (first color) stays as original blue Megaman - no palette swap
    // const playerColorHex = player.color.replace('#', '').toLowerCase()
    // const isPlayer1 = playerColorHex === PLAYER_COLORS[0].replace('#', '').toLowerCase()
    // const palette = isPlayer1 ? null : PALETTE_MAPS[playerColorHex]

    const palette = PALETTE_MAPS[player.playerIndex]
    
    if (palette) {
      // Draw sprite to offscreen canvas for color manipulation
      const offscreenCanvas = document.createElement('canvas')
      offscreenCanvas.width = drawWidth
      offscreenCanvas.height = drawHeight
      const offscreenCtx = offscreenCanvas.getContext('2d')
      
      if (offscreenCtx) {
        // Draw sprite to offscreen WITHOUT flipping (we'll flip when drawing to main canvas)
        offscreenCtx.drawImage(spriteImg, 0, 0, drawWidth, drawHeight)
        
        // Get image data
        const imageData = offscreenCtx.getImageData(0, 0, drawWidth, drawHeight)
        const data = imageData.data
        
        // Apply explicit color mapping with tolerance for slight color variations
        // First, build a tolerance map for faster lookups
        const tolerance = 1 // Allow ±15 RGB difference for matching
        const sourceColors = Object.keys(palette)
        const sourceColorRgb = sourceColors.map(hex => ({
          hex,
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16)
        }))
        
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue // Skip transparent pixels
          
          const r = data[i]
          const g = data[i + 1]
          const b = data[i + 2]
          
          // Try exact match first
          const exactKey = (
            r.toString(16).padStart(2, '0') +
            g.toString(16).padStart(2, '0') +
            b.toString(16).padStart(2, '0')
          ).toLowerCase()
          
          let matchedColor: string | null = null
          
          if (palette[exactKey]) {
            matchedColor = exactKey
          } else {
            // Try tolerance-based matching (for scaled/processed sprites)
            for (const source of sourceColorRgb) {
              const dr = Math.abs(r - source.r)
              const dg = Math.abs(g - source.g)
              const db = Math.abs(b - source.b)
              
              // Check if within tolerance and is blue-ish (B >= R and B >= G)
              if (dr <= tolerance && dg <= tolerance && db <= tolerance && 
                  b >= r && b >= g && b > 80) {
                matchedColor = source.hex
                break
              }
            }
          }
          
          // Apply color replacement if matched
          if (matchedColor && palette[matchedColor]) {
            const hex = palette[matchedColor]
            data[i] = parseInt(hex.slice(0, 2), 16)     // R
            data[i + 1] = parseInt(hex.slice(2, 4), 16)   // G
            data[i + 2] = parseInt(hex.slice(4, 6), 16) // B
            // Alpha (data[i + 3]) stays the same
          }
          // Non-mapped pixels (skin, eyes, etc.) keep original color
        }
        
        // Put modified image data back
        offscreenCtx.putImageData(imageData, 0, 0)
        
        // Draw tinted sprite to main canvas (flip here based on facing direction)
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
        const scale = 1.0 // 1x scale (half of original 2x)
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
    const data = payload.payload as any
    const { userId, x, y, facing, state, velocityX, velocityY, isShooting, isCharging, chargeLevel, onWall, wallSide, health, maxHealth, isSpawning, spawnY, spawnX } = data
    
    // Don't update local player from remote updates
    if (userId === props.userId) return
    
    let player = players.value.get(userId)
    
    // Create player if they don't exist (for late joiners)
    if (!player) {
      const canvasHeight = gameCanvasHeight.value
      const floorY = canvasHeight - 20
      
      // Find unique color for this user (not used by other players)
      const usedColors = new Set<string>()
      players.value.forEach((existingPlayer) => {
        if (existingPlayer.userId !== userId) {
          usedColors.add(existingPlayer.color)
        }
      })
      
      // Randomly pick from available colors (not used by other players)
      const availableColors = PLAYER_COLORS.filter(color => !usedColors.has(color))
      let playerColor: string
      let playerIndex: number
      
      if (availableColors.length > 0) {
        // Randomly pick from available colors
        const randomIndex = Math.floor(Math.random() * availableColors.length)
        playerColor = availableColors[randomIndex]
        playerIndex = PLAYER_COLORS.indexOf(playerColor)
      } else {
        // Fallback: all colors used (shouldn't happen with 8 colors max), pick randomly
        const randomIndex = Math.floor(Math.random() * PLAYER_COLORS.length)
        playerColor = PLAYER_COLORS[randomIndex]
        playerIndex = randomIndex
      }
      
      // Use spawnX if provided (for initial spawn), otherwise use received x
      const initialX = spawnX !== undefined && spawnX !== null ? spawnX : (x || 100)
      
      player = {
        userId,
        x: initialX, // USE RECEIVED spawnX or X, not random!
        y: y || (floorY - 64), // USE RECEIVED Y!
        facing: facing || 'right', // USE RECEIVED FACING!
        state: state || 'idle',
        velocityX: velocityX || 0,
        velocityY: velocityY || 0,
        onGround: state !== 'jumping' && state !== 'falling' && state !== 'dashJumping',
        onWall: onWall || false,
        wallSide: wallSide || null,
        color: playerColor,
        playerIndex: playerIndex,
        isShooting: isShooting || false,
        isCharging: isCharging || false,
        chargeLevel: chargeLevel || 0,
        chargeStartTime: 0,
        lastShotTime: 0,
        dashCooldown: 0,
        canDash: true,
        health: health || 100,
        maxHealth: maxHealth || 100,
        hitTime: 0,
        invulnerableUntil: 0,
        canWallJump: false,
        smokeEffects: [],
        lastJumpKeyPressed: false,
        lastDashKeyPressed: false,
        isSpawning: isSpawning || false,
        spawnTime: isSpawning ? Date.now() : 0,
        spawnY: spawnY || (floorY - 64),
        // Initialize interpolation targets
        targetX: initialX,
        targetY: y || (floorY - 64),
        lastNetworkUpdate: Date.now()
      } as Player
      
      players.value.set(userId, player)
      currentFrame.value.set(userId, 0)
      frameTime.value.set(userId, 0)
      chargeFrame.value.set(userId, 0)
      
      debug.log(`🎮 Created remote player: ${userId} at (${player.x}, ${player.y}) facing ${player.facing}`)
    }
    
    // Update player state - ALWAYS update position and facing from network
    // Remote players should use network data, not local physics
    if (player) {
      // ALWAYS update facing immediately from network (critical for visual sync)
      // facing should always be 'left' or 'right'
      if (facing === 'left' || facing === 'right') {
        // Always update facing - don't check if changed, just update it
        if (player.facing !== facing) {
          debug.log(`🎮 Remote player ${userId.substring(0, 6)} facing changed: ${player.facing} -> ${facing}`)
        }
        player.facing = facing // Always set from network
      } else if (facing !== undefined && facing !== null) {
        // Fallback: if facing is provided but invalid, log warning and use default
        debug.warn(`🎮 Invalid facing value for player ${userId}: ${facing}, defaulting to 'right'`)
        player.facing = 'right'
      }
      
      // Store network position as target for interpolation (smooth movement)
      // Remote players will interpolate towards this while applying physics locally
      if (x !== undefined && x !== null) {
        player.targetX = x
        // Snap immediately if difference is very large (teleport correction)
        if (Math.abs(player.x - x) > 100) {
          player.x = x
        }
      }
      if (y !== undefined && y !== null) {
        player.targetY = y
        // Snap immediately if difference is very large (teleport correction)
        if (Math.abs(player.y - y) > 100) {
          player.y = y
        }
      }
      player.lastNetworkUpdate = Date.now()
      
      // Update state and velocity from network (controls the physics)
      if (state !== undefined && state !== null) player.state = state
      if (velocityX !== undefined && velocityX !== null) player.velocityX = velocityX
      if (velocityY !== undefined && velocityY !== null) player.velocityY = velocityY
      player.isShooting = isShooting || false
      player.isCharging = isCharging || false
      player.chargeLevel = chargeLevel || 0
      player.onWall = onWall || false
      player.wallSide = wallSide || null
      if (health !== undefined) player.health = health
      if (maxHealth !== undefined) player.maxHealth = maxHealth
      
      // Sync spawn state
      if (isSpawning !== undefined) {
        if (isSpawning && !player.isSpawning) {
          // Player just started spawning
          player.isSpawning = true
          player.spawnTime = Date.now()
          player.spawnY = spawnY || player.y
        } else if (!isSpawning && player.isSpawning) {
          // Player finished spawning
          player.isSpawning = false
          player.spawnTime = 0
        }
      }
      
      // Update lastShotTime for shooting animation sync
      const remoteLastShotTime = data.lastShotTime
      if (remoteLastShotTime !== undefined && remoteLastShotTime > 0) {
        player.lastShotTime = remoteLastShotTime
        player.isShooting = Date.now() - remoteLastShotTime < 200
      }
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
