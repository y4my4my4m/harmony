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
import { useUserData } from '@/composables/useUserData'

interface Props {
  isActive: boolean
  channelId: string
  userId: string
  participants: Array<{ userId: string; username?: string }> // username is optional, we use useUserData for actual data
}

const props = defineProps<Props>()

const emit = defineEmits<{
  close: []
}>()

// Get user data composable for usernames and profile pictures
const { getUserDisplayName, getUserAvatarUrl } = useUserData()

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
  state: 'idle' | 'walking' | 'jumping' | 'falling' | 'landing' | 'shooting' | 'dashing' | 'dashJumping' | 'wallCling' | 'wallKick' | 'wallSlide' | 'hit' | 'dead'  // Note: wallKick is valid state
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
  initialChargeSound?: HTMLAudioElement // Reference to initial charge sound to detect when it ends
  // Interpolation for remote players
  targetX?: number // Target position from network
  targetY?: number // Target position from network
  lastTargetX?: number // Previous target for smooth interpolation
  lastTargetY?: number // Previous target for smooth interpolation
  targetUpdateTime?: number // When target was last updated
  lastNetworkUpdate?: number // Timestamp of last network update
  dashFrameProgress?: number // Dash animation progress (0.0 to 1.0) for deltaTime-based animation
  // Player info
  username?: string
  profilePicture?: string
  kills: number // Kill count for score
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
  facing: 'left' | 'right' // Direction bullet is traveling for sprite flipping
}

interface HealthPickup {
  id: string
  x: number
  y: number
  type: 'HP_Small' | 'HP_Large' // HP2 or HP10
  healAmount: number
  createdAt: number
  animFrame: number
}

interface Platform {
  id: string
  x: number
  y: number
  width: number
  height: number
  type: 'static'
}

const players = ref<Map<string, Player>>(new Map())
const bullets = ref<Map<string, Bullet>>(new Map())
const healthPickups = ref<Map<string, HealthPickup>>(new Map())
const platforms = ref<Platform[]>([])
const keys = ref<Set<string>>(new Set())
let bulletIdCounter = 0
let pickupIdCounter = 0
let lastPickupSpawnTime = 0
const PICKUP_SPAWN_INTERVAL = 8000 // Spawn a pickup every 8 seconds
const MAX_PICKUPS = 5 // Maximum pickups on screen
const colorAssignments = ref<Map<string, { color: string; playerIndex: number }>>(new Map()) // Store color assignments from host
// Display mode: 0 = normal, 1 = hide names, 2 = hide health bars, 3 = fixed health bar positions + names (bar + player), 4 = fixed health bar positions + names (bar only)
const displayMode = ref(0) // Cycle with P key

// Item sprites
const itemSprites = ref<Map<string, HTMLImageElement>>(new Map())
const itemData = ref<any>(null)

// Level sprites
const floorSprite = ref<HTMLImageElement | null>(null)
const wallSprite = ref<HTMLImageElement | null>(null)
const platformSprite = ref<HTMLImageElement | null>(null)
const profilePictures = ref<Map<string, HTMLImageElement>>(new Map())

// Use WebP format for smaller file sizes (set to false to use original PNGs)
const USE_WEBP_SPRITES = true
const SPRITES_BASE = '/assets/easteregg/megaman/sprites'

// Helper to convert sprite path to WebP if enabled
// WebP files are in /sprites/webp/ folder structure mirroring the original
function getSpriteUrl(basePath: string, file: string): string {
  if (USE_WEBP_SPRITES && file.endsWith('.png')) {
    const webpFile = file.replace('.png', '.webp')
    // Extract the subfolder relative to sprites base
    const relPath = basePath.replace(SPRITES_BASE, '').replace(/^\//, '')
    if (relPath) {
      return `${SPRITES_BASE}/webp/${relPath}/${webpFile}`
    }
    return `${SPRITES_BASE}/webp/${webpFile}`
  }
  return `${basePath}/${file}`
}

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
const lastSwitchFrameMap = ref<Map<string, 'walk' | 'run_fire' | 'other'>>(new Map()) // Track if we've already adjusted frame for current switch
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

// Constants - Megaman X authentic physics
const GRAVITY = 0.6 // Slightly less gravity for floatier jumps like MMX
const JUMP_STRENGTH = -14 // Slightly lower jump for better control
const WALL_JUMP_X = 7 // Horizontal kick-off speed
const WALL_JUMP_Y = -13 // Wall jump vertical strength
const WALL_SLIDE_SPEED = 2.0 // Slower wall slide like real MMX
const WALK_SPEED = 3.5 // Slightly faster walk
const DASH_SPEED = 10
const DASH_DURATION = 300 // ms
const DASH_COOLDOWN = 500 // ms
const FRAME_DURATION = 200 // ms per frame (slower animation)
const BULLET_SPEED = 12
const CHARGE_TIME_LV1 = 500 // ms
const CHARGE_TIME_LV2 = 1500 // ms
const CHARGE_TIME_LV3 = 3000 // ms
const WALL_CLING_GRACE_PERIOD = 100 // ms - time to re-grab wall after wall jump

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
// Using OGG format for smaller file sizes (originals kept as .wav in same folder)
const soundPaths = {
  jump: [
    '/assets/easteregg/ogg/x_jump.ogg',
  ],
  shoot: [
    '/assets/easteregg/ogg/x_buster.ogg',
  ],
  shootLv1: [
    '/assets/easteregg/ogg/x_buster_lv1.ogg',
  ],
  shootLv2: [
    '/assets/easteregg/ogg/x_buster_lv2.ogg',
  ],
  shootLv3: [
    '/assets/easteregg/ogg/x_buster_lv3.ogg',
  ],
  land: [
    '/assets/easteregg/ogg/x_land.ogg',
  ],
  dash: [
    '/assets/easteregg/ogg/x_dash.ogg',
  ],
  charge: [
    '/assets/easteregg/ogg/x_charge.ogg',
  ],
  chargeLoop: [
    '/assets/easteregg/ogg/x_charge_loop.ogg',
  ],
  damage: [
    '/assets/easteregg/ogg/x_damage.ogg',
  ],
  hit: [
    '/assets/easteregg/ogg/buster_hit.ogg',
  ],
  death: [
    '/assets/easteregg/ogg/x_loselife.ogg',
  ],
  spawn: [
    '/assets/easteregg/ogg/x_teleportdown.ogg',
  ],
  energyFill: [
    '/assets/easteregg/ogg/energy_fill.ogg',
  ],
}

// Audio Manager for charge loop - handles all lifecycle cleanly with seamless looping
class ChargeLoopManager {
  private currentAudio: HTMLAudioElement | null = null
  private audioContext: AudioContext | null = null
  private sourceNode: AudioBufferSourceNode | null = null
  private gainNode: GainNode | null = null
  private audioBuffer: AudioBuffer | null = null
  private lastStartTime: number = 0
  private readonly DEBOUNCE_MS = 500
  private useWebAudio: boolean = true // Use Web Audio API for seamless looping
  
  private async loadAudioBuffer(audioPath: string): Promise<AudioBuffer | null> {
    try {
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
      }
      
      const response = await fetch(audioPath)
      const arrayBuffer = await response.arrayBuffer()
      const buffer = await this.audioContext.decodeAudioData(arrayBuffer)
      return buffer
    } catch (e) {
      debug.warn(`🔊 ChargeLoopManager: Failed to load audio buffer:`, e)
      return null
    }
  }
  
  private startWebAudioLoop(buffer: AudioBuffer): void {
    if (!this.audioContext) return
    
    // Create gain node for volume control
    if (!this.gainNode) {
      this.gainNode = this.audioContext.createGain()
      this.gainNode.gain.value = 0.2
      this.gainNode.connect(this.audioContext.destination)
    }
    
    // Create and start buffer source with seamless looping
    const source = this.audioContext.createBufferSource()
    source.buffer = buffer
    source.loop = true // Seamless loop in Web Audio API
    source.connect(this.gainNode)
    
    source.start(0)
    this.sourceNode = source
    
    debug.log(`🔊 ChargeLoopManager: Started Web Audio seamless loop`)
  }
  
  async start(audioPath: string): Promise<HTMLAudioElement | null> {
    const now = Date.now()
    
    // Debounce rapid starts
    if (now - this.lastStartTime < this.DEBOUNCE_MS) {
      debug.log(`🔊 ChargeLoopManager: Debounced start (${now - this.lastStartTime}ms since last)`)
      return this.currentAudio
    }
    
    // Stop any existing audio first
    this.stop()
    
    // Try Web Audio API first for seamless looping
    if (this.useWebAudio) {
      try {
        // Load audio buffer
        const buffer = await this.loadAudioBuffer(audioPath)
        if (buffer) {
          this.audioBuffer = buffer
          this.startWebAudioLoop(buffer)
          this.lastStartTime = now
          debug.log(`🔊 ChargeLoopManager: Using Web Audio API for seamless looping`)
          // Return null since we're not using HTMLAudioElement
          return null
        } else {
          // Fallback to HTML5 Audio if Web Audio fails
          debug.log(`🔊 ChargeLoopManager: Web Audio failed, falling back to HTML5 Audio`)
          this.useWebAudio = false
        }
      } catch (e) {
        debug.warn(`🔊 ChargeLoopManager: Web Audio error, falling back:`, e)
        this.useWebAudio = false
      }
    }
    
    // Fallback to HTML5 Audio with immediate restart for faster looping
    try {
      const audio = new Audio(audioPath)
      audio.loop = true
      audio.volume = 0.2
      
      // Store reference IMMEDIATELY - before play() resolves
      this.currentAudio = audio
      this.lastStartTime = now
      
      debug.log(`🔊 ChargeLoopManager: Created HTML5 audio, stored reference`, {
        src: audioPath,
        loop: audio.loop,
        volume: audio.volume
      })
      
      // For faster looping: restart immediately when it ends (if loop fails)
      audio.onended = () => {
        if (this.currentAudio === audio && !audio.paused) {
          // Immediately restart for seamless feel
          audio.currentTime = 0
          audio.play().catch(() => {})
        }
      }
      
      // Set up error handler
      audio.onerror = () => {
        debug.warn(`🔊 ChargeLoopManager: Audio error`)
      }
      
      // Start playing
      const playPromise = audio.play()
      if (playPromise) {
        playPromise.then(() => {
          debug.log(`🔊 ChargeLoopManager: Play promise resolved - audio should be playing`)
        }).catch((err) => {
          debug.warn(`🔊 ChargeLoopManager: Play failed:`, err)
        })
      }
      
      return audio
    } catch (e) {
      debug.warn(`🔊 ChargeLoopManager: Failed to create audio:`, e)
      this.currentAudio = null
      return null
    }
  }
  
  stop(): void {
    let stoppedCount = 0
    
    // Stop Web Audio source if using it
    if (this.sourceNode) {
      try {
        debug.log(`🔊 ChargeLoopManager: Stopping Web Audio source`)
        this.sourceNode.stop()
        this.sourceNode.disconnect()
        this.sourceNode = null
        stoppedCount++
      } catch (e) {
        debug.warn(`🔊 ChargeLoopManager: Error stopping Web Audio source:`, e)
      }
    }
    
    // Stop tracked HTML5 audio
    if (this.currentAudio) {
      try {
        const audio = this.currentAudio
        debug.log(`🔊 ChargeLoopManager: Stopping tracked audio`, {
          paused: audio.paused,
          ended: audio.ended,
          loop: audio.loop,
          readyState: audio.readyState,
          src: audio.src.substring(audio.src.lastIndexOf('/') + 1)
        })
        
        // Remove all handlers FIRST to prevent any callbacks
        audio.onerror = null
        audio.onended = null
        audio.onplay = null
        
        // Stop the audio - multiple methods for maximum reliability
        // Order matters: disable loop first, then pause, then reset
        audio.loop = false
        
      // Pause even if it hasn't started playing yet
      try {
        audio.pause()
      } catch (e) {
        debug.warn(`🔊 ChargeLoopManager: Pause error (may not have started):`, e)
      }
        
        audio.currentTime = 0
        audio.volume = 0
        
        // Force stop by removing src (nuclear option)
        try {
          const originalSrc = audio.src
          audio.src = ''
          audio.load()
          debug.log(`🔊 ChargeLoopManager: Cleared audio src`)
        } catch (e) {
          // Some browsers don't allow this, that's okay
          debug.log(`🔊 ChargeLoopManager: Could not clear src (expected in some browsers)`)
        }
        
        // Double-check it's stopped
        if (!audio.paused || audio.ended) {
          debug.warn(`🔊 ChargeLoopManager: Audio still playing after stop attempt!`, {
            paused: audio.paused,
            ended: audio.ended
          })
        }
        
        stoppedCount++
        debug.log(`🔊 ChargeLoopManager: Tracked audio stopped`)
      } catch (e) {
        debug.warn(`🔊 ChargeLoopManager: Error stopping tracked audio:`, e)
      }
      
      this.currentAudio = null
    } else {
      debug.log(`🔊 ChargeLoopManager: No tracked audio to stop`)
    }
    
    // NUCLEAR OPTION: Search DOM for ANY playing charge loop audio
    // This catches cases where the reference was lost
    try {
      const allAudios = document.querySelectorAll('audio')
      debug.log(`🔊 ChargeLoopManager: Searching ${allAudios.length} audio elements in DOM`)
      
      allAudios.forEach((audio) => {
        const src = audio.src || ''
        const isChargeLoop = src.includes('x_charge_loop') || src.includes('charge_loop')
        const isPlaying = !audio.paused && !audio.ended && audio.loop
        
        if (isChargeLoop && isPlaying) {
          debug.log(`🔊 ChargeLoopManager: Found playing charge loop in DOM:`, {
            src: src.substring(src.lastIndexOf('/') + 1),
            paused: audio.paused,
            ended: audio.ended,
            loop: audio.loop,
            volume: audio.volume
          })
          
          try {
            // Remove handlers
            audio.onerror = null
            audio.onended = null
            audio.onplay = null
            
            // Stop it
            audio.loop = false
            audio.pause()
            audio.currentTime = 0
            audio.volume = 0
            
            // Nuclear: clear src
            try {
              audio.src = ''
              audio.load()
            } catch (e) {}
            
            stoppedCount++
            debug.log(`🔊 ChargeLoopManager: Stopped DOM audio`)
          } catch (e) {
            debug.warn(`🔊 ChargeLoopManager: Error stopping DOM audio:`, e)
          }
        }
      })
    } catch (e) {
      debug.warn(`🔊 ChargeLoopManager: Error searching DOM:`, e)
    }
    
    debug.log(`🔊 ChargeLoopManager: Total stopped: ${stoppedCount}`)
    this.lastStartTime = 0
  }
  
  isPlaying(): boolean {
    // Check Web Audio source
    if (this.sourceNode) {
      return true
    }
    // Check HTML5 audio
    return this.currentAudio !== null && 
           !this.currentAudio.paused && 
           !this.currentAudio.ended
  }
  
  getAudio(): HTMLAudioElement | null {
    return this.currentAudio
  }
  
  cleanup(): void {
    this.stop()
    // Clean up Web Audio context
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {})
      this.audioContext = null
    }
    this.gainNode = null
    this.audioBuffer = null
  }
}

// Create sound pool for better performance
const soundPool: Map<string, HTMLAudioElement[]> = new Map()
const playingSounds: Map<string, HTMLAudioElement> = new Map() // Track currently playing looping sounds (non-charge-loop)
const chargeLoopManager = new ChargeLoopManager() // Dedicated manager for charge loop
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

function playSound(soundName: keyof typeof soundPaths, loop: boolean = false): HTMLAudioElement | null {
  try {
    initializeSounds()
    
    // Special handling for charge loop - use dedicated manager (async, but we fire and forget)
    if (soundName === 'chargeLoop') {
      const path = soundPaths.chargeLoop[0]
      chargeLoopManager.start(path).catch((e) => {
        debug.warn(`🔊 Failed to start charge loop:`, e)
      })
      // Return null since Web Audio API doesn't return HTMLAudioElement
      // The manager handles everything internally
      return null
    } else if (loop) {
      // For other looping sounds, stop existing first
      const currentSound = playingSounds.get(soundName)
      if (currentSound) {
        if (!currentSound.paused) {
          return currentSound // Already playing
        }
        currentSound.pause()
        currentSound.currentTime = 0
        playingSounds.delete(soundName)
      }
    }
    
    const paths = soundPaths[soundName]
    if (!paths || paths.length === 0) return null
    
    // Try to play sound - create new Audio each time for better reliability
    for (const path of paths) {
      try {
        const audio = new Audio(path)
        const isLoopSound = loop
        audio.loop = isLoopSound
        audio.volume = 0.3
        
        // For looping sounds (except chargeLoop which uses manager), add to map AFTER we successfully start playing
        // Set up error handler FIRST
        audio.onerror = () => {
          debug.warn(`🎮 Audio error for ${soundName}:`, path)
          if (isLoopSound) {
            playingSounds.delete(soundName)
          }
        }
        
        const playPromise = audio.play()
        if (playPromise) {
          playPromise.then(() => {
            // Only add to map AFTER play succeeds
            if (isLoopSound) {
              playingSounds.set(soundName, audio)
              debug.log(`🔊 playSound: Successfully started ${soundName}, added to map`)
            }
          }).catch((err) => {
            debug.warn(`Could not play sound ${path}:`, err)
            if (isLoopSound) {
              playingSounds.delete(soundName)
            }
          })
        } else {
          // If play() returns undefined (some browsers), still add to map
          if (isLoopSound) {
            playingSounds.set(soundName, audio)
          }
        }
        
        return audio
      } catch (e) {
        debug.warn(`🎮 Failed to create audio for ${soundName}:`, e)
        continue
      }
    }
  } catch (error) {
    debug.warn(`🎮 Error in playSound for ${soundName}:`, error)
  }
  return null
}

function stopSound(soundName: keyof typeof soundPaths) {
  // Use dedicated manager for charge loop
  if (soundName === 'chargeLoop') {
    debug.log(`🔊 stopSound(chargeLoop): Called via manager`)
    chargeLoopManager.stop()
    return
  }
  
  // For other sounds, use the normal method
  const currentSound = playingSounds.get(soundName)
  if (currentSound) {
    try {
      // Remove all event listeners first to prevent callbacks
      currentSound.onerror = null
      currentSound.onended = null
      currentSound.onplay = null
      // Disable loop FIRST to ensure it stops
      currentSound.loop = false
      // Stop the sound
      currentSound.pause()
      currentSound.currentTime = 0
      // Mute as extra safety
      currentSound.volume = 0
    } catch (e) {
      debug.warn(`🎮 Error stopping sound ${soundName}:`, e)
    }
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
      await loadItemSprites()
      await loadLevelSprites()
    } else {
      debug.warn('Could not load animations.json:', response.status, response.statusText)
    }
  } catch (error) {
    debug.error('Error loading animations:', error)
  }
}

// Load level sprites (floor, wall, platform)
async function loadLevelSprites() {
  // Load floor sprite
  const floorImg = new Image()
  floorImg.onload = () => {
    floorSprite.value = floorImg
    debug.log('🎮 Loaded floor sprite')
  }
  floorImg.onerror = () => debug.warn('❌ Failed to load floor sprite')
  floorImg.src = '/assets/easteregg/megaman/sprites/webp/levels/floor.webp'
  
  // Load wall sprite
  const wallImg = new Image()
  wallImg.onload = () => {
    wallSprite.value = wallImg
    debug.log('🎮 Loaded wall sprite')
  }
  wallImg.onerror = () => debug.warn('❌ Failed to load wall sprite')
  wallImg.src = '/assets/easteregg/megaman/sprites/webp/levels/wall.webp'
  
  // Load platform sprite
  const platformImg = new Image()
  platformImg.onload = () => {
    platformSprite.value = platformImg
    debug.log('🎮 Loaded platform sprite')
  }
  platformImg.onerror = () => debug.warn('❌ Failed to load platform sprite')
  platformImg.src = '/assets/easteregg/megaman/sprites/webp/levels/platform.webp'
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
      img.src = getSpriteUrl('/assets/easteregg/megaman/sprites', frame.file)
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
          img.src = getSpriteUrl('/assets/easteregg/megaman/sprites', frame.file)
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
          img.src = getSpriteUrl('/assets/easteregg/megaman/sprites', frame.file)
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
    const smokeUrl = getSpriteUrl('/assets/easteregg/megaman/sprites/effects', `Smoke${i}.png`)
    smokeImg.onload = () => {
      smokeSprites.value.set(`Smoke${i}.png`, smokeImg)
      debug.log(`🎮 Loaded Smoke${i} sprite from ${smokeUrl}`)
    }
    smokeImg.onerror = () => debug.warn(`❌ Failed to load Smoke${i} from ${smokeUrl}`)
    smokeImg.src = smokeUrl
  }
  
  // Load hit sprites
  const hitFileNames = [
    '158a6fc8342580dad99bcd0cc3da6f5d.png', // Hit1
    '49d8234616dc6d46d1d29ae6a10b6b5f.png', // Hit2
    '5b0a9bbe83f883e0e648f3cffda96839.png', // Hit3
    '5f4eacbd8a13fe907a24e9dd4b366ca8.png', // Hit4
    'ee5b4945c2685f318106f951a537a73c.png', // Hit5
    '91a9950186deed6b06296ec179d17a24.png', // Hit6
    'a37bb271560e365e9eac949ac675c009.png', // Hit7
    '68a9b48294eab02f64a9aacec96b76c6.png', // Hit8
    '4fd717ba3385c8d6d76ea1df21e2b245.png', // Hit9
    '399f62bacb879833ca499c139e9a4461.png', // Hit10
    'aabdd8a0c4b70511511ef63327f01483.png', // Armor hit (backwards compat)
  ]
  // Build hit animation frames from hit sprites (Hit1-Hit10, excluding armor sprite)
  const hitAnimationFrames: AnimationFrame[] = []
  for (let i = 0; i < hitFileNames.length - 1; i++) { // Exclude last one (armor sprite)
    const fileName = hitFileNames[i]
    hitAnimationFrames.push({ 
      name: `Hit${i + 1}`, 
      file: fileName 
    })
    
    const hitImg = new Image()
    hitImg.src = getSpriteUrl('/assets/easteregg/megaman/sprites', fileName)
    hitImg.onload = () => {
      hitSprites.value.set(fileName, hitImg)
      spriteImages.value.set(fileName, hitImg) // Also add to sprite images for getAnimationFrames
    }
  }
  
  // Also load the armor hit sprite (backwards compat)
  const armorHitFileName = hitFileNames[hitFileNames.length - 1]
  const armorHitImg = new Image()
  armorHitImg.src = getSpriteUrl('/assets/easteregg/megaman/sprites', armorHitFileName)
  armorHitImg.onload = () => {
    hitSprites.value.set(armorHitFileName, armorHitImg)
    spriteImages.value.set(armorHitFileName, armorHitImg)
  }
  
  // Add hit frames to animations if not already present
  if (animations.value) {
    if (!animations.value.hit || animations.value.hit.length === 0) {
      animations.value.hit = hitAnimationFrames
      debug.log(`🎮 Added ${hitAnimationFrames.length} hit animation frames`)
    }
  }
  
  // Load death sprites (Death1-Death3) from project.json
  const deathFileNames = [
    '9bac76cd3cca6342e5e1f3dc7fee5ac8.png', // Death1
    'f1f7bf17578b56bf022ee33081cc5c1a.png', // Death2
    '169c783f60359234fad5ec797d0cc9c9.png', // Death3
  ]
  for (const fileName of deathFileNames) {
    const deathImg = new Image()
    deathImg.src = getSpriteUrl('/assets/easteregg/megaman/sprites', fileName)
    // Store in spriteImages so getAnimationFrames can find them
    deathImg.onload = () => spriteImages.value.set(fileName, deathImg)
  }
  
  // Load death bubble sprites
  for (let i = 1; i <= 5; i++) {
    const bubbleImg = new Image()
    bubbleImg.src = getSpriteUrl('/assets/easteregg/megaman/sprites/death', `Bubble${i}.png`)
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
    introImg.src = getSpriteUrl('/assets/easteregg/megaman/sprites', `${introAssetIds[i]}.png`)
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
    readyImg.src = getSpriteUrl('/assets/easteregg/megaman/sprites', `${readyAssetIds[i]}.png`)
    readyImg.onload = () => {
      readySprites.value.set(`Ready${i}.png`, readyImg)
      debug.log(`🎮 Loaded Ready${i} sprite`)
    }
    readyImg.onerror = () => debug.warn(`🎮 Failed to load Ready${i} sprite`)
  }
  
  // Load dash effect sprites (size: 200 in project.json = 2x scale)
  for (let i = 1; i <= 4; i++) {
    const dashEffectImg = new Image()
    const dashUrl = getSpriteUrl('/assets/easteregg/megaman/sprites/effects', `Dash_Effect${i}.png`)
    dashEffectImg.onload = () => {
      dashEffectSprites.value.set(`Dash_Effect${i}.png`, dashEffectImg)
      debug.log(`🎮 Loaded Dash_Effect${i} sprite from ${dashUrl}`)
    }
    dashEffectImg.onerror = () => debug.warn(`❌ Failed to load Dash_Effect${i} from ${dashUrl}`)
    dashEffectImg.src = dashUrl
  }
  
  debug.log('🎮 Loaded effect sprites')
}

// Load item sprites (health pickups)
async function loadItemSprites() {
  try {
    const response = await fetch('/assets/easteregg/megaman/sprites/items.json')
    if (response.ok) {
      itemData.value = await response.json()
      debug.log('🎮 Loaded item data:', itemData.value)
      
      // Load all item sprite images
      const allItemFrames: Array<{ name: string; file: string }> = []
      
      for (const frames of Object.values(itemData.value)) {
        if (Array.isArray(frames)) {
          for (const frame of frames as Array<{ name: string; file: string }>) {
            allItemFrames.push(frame)
          }
        }
      }
      
      debug.log(`🎮 Loading ${allItemFrames.length} item sprite images...`)
      
      const loadPromises = allItemFrames.map(frame => {
        return new Promise<void>((resolve) => {
          if (itemSprites.value.has(frame.file)) {
            resolve()
            return
          }
          
          const img = new Image()
          img.onload = () => {
            itemSprites.value.set(frame.file, img)
            resolve()
          }
          img.onerror = () => {
            debug.warn(`❌ Failed to load item sprite: ${frame.file}`)
            resolve()
          }
          const spritePath = `/assets/easteregg/megaman/sprites/${frame.file}`
          img.src = spritePath
        })
      })
      
      await Promise.all(loadPromises)
      debug.log(`🎮 Loaded ${itemSprites.value.size}/${allItemFrames.length} item sprites`)
      
      // Background sprite loading removed - using simple overlay instead
    } else {
      debug.warn('Could not load items.json')
    }
  } catch (error) {
    debug.error('Error loading item sprites:', error)
  }
}

// Initialize platforms
function initializePlatforms() {
  platforms.value = []
  const canvasWidth = gameCanvasWidth.value
  const canvasHeight = gameCanvasHeight.value
  const floorY = canvasHeight - 20
  const platformHeight = 24 // Taller platforms
  
  // Create platforms at varying heights - more spread out on Y axis
  const platformConfigs = [
    // Low level platforms (just above floor)
    { x: 192, y: floorY - 170, width: 256, height: platformHeight },
    { x: canvasWidth - 256 - 196, y: floorY - 170, width: 256, height: platformHeight },
    
    // Mid level platforms
    { x: canvasWidth / 2 - 128, y: floorY - 140, width: 256, height: platformHeight },
    
    // High level platforms
    { x: 265, y: floorY - 320, width: 256/2, height: platformHeight },
    { x: canvasWidth - 230 - 210, y: floorY - 320, width: 256/2, height: platformHeight },
    
    // Top level platform
    { x: canvasWidth / 2 - 64, y: floorY - 380, width: 128, height: platformHeight },
  ]
  
  platformConfigs.forEach((config, index) => {
    platforms.value.push({
      id: `platform-${index}`,
      x: config.x,
      y: config.y,
      width: config.width,
      height: config.height,
      type: 'static'
    })
  })
  
  debug.log(`🎮 Initialized ${platforms.value.length} platforms`)
}

// Spawn a health pickup at random position (only on ground/platforms)
function spawnHealthPickup() {
  if (healthPickups.value.size >= MAX_PICKUPS) return
  
  const canvasWidth = gameCanvasWidth.value
  const canvasHeight = gameCanvasHeight.value
  const floorY = canvasHeight - 64
  
  let x: number
  let y: number
  
  // 50% chance to spawn on a platform if platforms exist
  if (platforms.value.length > 0 && Math.random() > 0.5) {
    // Spawn on a random platform
    const platform = platforms.value[Math.floor(Math.random() * platforms.value.length)]
    // Random X position within platform bounds (leave some margin)
    const margin = 10
    x = platform.x + margin + Math.random() * (platform.width - margin * 2)
    // Y position on top of platform
    y = platform.y - 20 // 20px above platform top
  } else {
    // Spawn on floor
    x = 30 + Math.random() * (canvasWidth - 60)
    y = floorY - 20 // 20px above floor
  }
  
  // Random type: 70% small (2 HP), 30% large (10 HP)
  const isLarge = Math.random() > 0.7
  const type = isLarge ? 'HP_Large' : 'HP_Small'
  const healAmount = isLarge ? 10 : 2
  
  const pickup: HealthPickup = {
    id: `pickup-${pickupIdCounter++}`,
    x,
    y,
    type,
    healAmount,
    createdAt: Date.now(),
    animFrame: 0
  }
  
  healthPickups.value.set(pickup.id, pickup)
  debug.log(`🎮 Spawned ${type} pickup at (${x.toFixed(0)}, ${y.toFixed(0)})`)
  
  // Broadcast pickup spawn to all players (only host should spawn)
  if (gameChannel) {
    gameChannel.send({
      type: 'broadcast',
      event: 'pickup-spawned',
      payload: {
        pickupId: pickup.id,
        x: pickup.x,
        y: pickup.y,
        type: pickup.type,
        healAmount: pickup.healAmount,
        createdAt: pickup.createdAt
      }
    })
  }
}

// Check collision between player and pickup
function checkPickupCollision(player: Player, pickup: HealthPickup): boolean {
  const playerWidth = 64
  const playerHeight = 64
  // Original sprite sizes: HP_Large=32x24, HP_Small=20x16
  const pickupWidth = pickup.type === 'HP_Large' ? 32 : 20
  const pickupHeight = pickup.type === 'HP_Large' ? 24 : 16
  
  return (
    player.x < pickup.x + pickupWidth &&
    player.x + playerWidth > pickup.x &&
    player.y < pickup.y + pickupHeight &&
    player.y + playerHeight > pickup.y
  )
}

// Check collision between player and platform (returns the platform if on top)
function checkPlatformCollision(player: Player, prevY: number): Platform | null {
  const playerWidth = 64
  const playerHeight = 64
  const playerBottom = player.y + playerHeight
  const prevPlayerBottom = prevY + playerHeight
  
  for (const platform of platforms.value) {
    // Check if player is above platform and falling onto it
    const playerCenterX = player.x + playerWidth / 2
    const isWithinPlatformX = playerCenterX > platform.x && playerCenterX < platform.x + platform.width
    const wasAbovePlatform = prevPlayerBottom <= platform.y
    const isNowAtOrBelowPlatform = playerBottom >= platform.y
    
    if (isWithinPlatformX && wasAbovePlatform && isNowAtOrBelowPlatform && player.velocityY >= 0) {
      return platform
    }
  }
  
  return null
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
  
  // Sort participants by userId to determine host (first player assigns colors)
  allParticipants.sort((a, b) => a.userId.localeCompare(b.userId))
  const isHost = allParticipants.length > 0 && allParticipants[0].userId === props.userId
  
  // Get colors already used by existing players (preserve existing assignments)
  const usedColors = new Set<string>()
  const userIdToColor = new Map<string, string>()
  players.value.forEach((existingPlayer) => {
    usedColors.add(existingPlayer.color)
    userIdToColor.set(existingPlayer.userId, existingPlayer.color)
  })
  
  // If we're the host and don't have color assignments yet, assign random colors
  if (isHost && colorAssignments.value.size === 0) {
    const availableColors = [...PLAYER_COLORS]
    const shuffledColors = [...availableColors].sort(() => Math.random() - 0.5) // Shuffle
    
    allParticipants.forEach((participant, index) => {
      const colorIndex = index % shuffledColors.length
      const playerColor = shuffledColors[colorIndex]
      const playerIndex = PLAYER_COLORS.indexOf(playerColor)
      colorAssignments.value.set(participant.userId, { color: playerColor, playerIndex })
    })
    
    // Broadcast color assignments to all players (with a small delay to ensure channel is ready)
    setTimeout(() => {
      if (gameChannel) {
        const assignments: Record<string, { color: string; playerIndex: number }> = {}
        colorAssignments.value.forEach((assignment, userId) => {
          assignments[userId] = assignment
        })
        
        gameChannel.send({
          type: 'broadcast',
          event: 'color-assignments',
          payload: {
            assignments
          }
        })
        
        debug.log(`🎮 Host assigned colors:`, assignments)
      }
    }, 100)
  }
  
  allParticipants.forEach((participant, index) => {
    // Spawn positions - random X position for each player
    const canvasWidth = canvas ? canvas.width / (window.devicePixelRatio || 1) : 600
    // Random X position between 50 and canvasWidth - 114 (leaving some margin)
    const spawnX = Math.max(50, Math.min(canvasWidth - 114, 50 + Math.random() * (canvasWidth - 164)))
    const targetY = floorY - 106 // Where player will land
    
    // Assign color: use existing assignment, colorAssignments from host, or fallback
    let playerColor: string
    let playerIndex: number
    
    // Check if this player already has a color assigned (from existing players)
    if (userIdToColor.has(participant.userId)) {
      playerColor = userIdToColor.get(participant.userId)!
      playerIndex = PLAYER_COLORS.indexOf(playerColor)
    } else if (colorAssignments.value.has(participant.userId)) {
      // Use color assignment from host
      const assignment = colorAssignments.value.get(participant.userId)!
      playerColor = assignment.color
      playerIndex = assignment.playerIndex
    } else {
      // Fallback: use index-based assignment (will be updated when host broadcasts)
      playerIndex = index % PLAYER_COLORS.length
      playerColor = PLAYER_COLORS[playerIndex]
    }
    
    debug.log(`🎮 Player ${index} (${participant.userId.substring(0, 6)}) spawning at x=${spawnX} with color ${playerColor}`)
    
    // Get username and profile picture from useUserData composable
    const username = getUserDisplayName(participant.userId).value || `Player ${index + 1}`
    const profilePictureUrl = getUserAvatarUrl(participant.userId).value || undefined
    
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
      spawnY: targetY, // Target Y position
      username: username,
      profilePicture: profilePictureUrl,
      kills: 0
    } as Player
    
    // Load profile picture if available
    if (profilePictureUrl) {
      const profileImg = new Image()
      profileImg.crossOrigin = 'anonymous'
      profileImg.onload = () => {
        profilePictures.value.set(player.userId, profileImg)
      }
      profileImg.onerror = () => {
        debug.warn(`Failed to load profile picture for ${player.userId}`)
      }
      profileImg.src = profilePictureUrl
    }
    
    players.value.set(participant.userId, player)
    currentFrame.value.set(participant.userId, 0)
    frameTime.value.set(participant.userId, 0)
    chargeFrame.value.set(participant.userId, 0)
    
    debug.log(`🎮 Created player: ${participant.userId} at (${player.x}, ${player.y})`)
    
    // Play spawn sound for local player
    if (participant.userId === props.userId) {
      playSound('spawn')
    }
  })
  
  debug.log(`🎮 Total players: ${players.value.size}`)
}

// Helper function to calculate fixed health bar position based on corner pattern
// Pattern: player1 bottom-left, player2 bottom-right, player3 top-left, player4 top-right,
//          player5 bottom-left next to player1, player6 bottom-right next to player2, etc.
function getFixedHealthBarPosition(playerIndex: number, totalPlayers: number, barWidth: number, barHeight: number, canvasWidth: number, canvasHeight: number): { x: number; y: number } {
  const cornerIndex = playerIndex % 4 // 0=bottom-left, 1=bottom-right, 2=top-left, 3=top-right
  const stackIndex = Math.floor(playerIndex / 4) // Which stack in this corner (0, 1, 2...)
  const spacing = 8 // Space between stacked bars
  const margin = 8 // Margin from screen edges
  
  let x: number, y: number
  
  if (cornerIndex === 2) {
    // Bottom-left
    x = margin
    y = canvasHeight - margin - barHeight - spacing - (stackIndex * (barHeight + spacing))
  } else if (cornerIndex === 3) {
    // Bottom-right
    x = canvasWidth - margin - barWidth
    y = canvasHeight - margin - barHeight - spacing - (stackIndex * (barHeight + spacing))
  } else if (cornerIndex === 0) {
    // Top-left
    x = margin
    y = margin + (barHeight/2) + spacing + (stackIndex * (barHeight + spacing))
  } else {
    // Top-right
    x = canvasWidth - margin - barWidth
    y = margin + (barHeight/2) + spacing + (stackIndex * (barHeight + spacing))
  }
  
  return { x, y }
}

// Helper function to draw player name label
function drawNameLabel(name: string, x: number, y: number, ctx: CanvasRenderingContext2D, userId: string, playerColor: string, profilePictures: Map<string, HTMLImageElement>, alignRight: boolean = false, pictureOnly: boolean = false) {
  // Measure text width
  ctx.font = '12px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const textMetrics = ctx.measureText(name)
  const textWidth = textMetrics.width
  const textHeight = 16
  const padding = 4
  const profileSize = 24
  const totalWidth = textWidth + profileSize + padding * 3
  
  let nameX: number
  let bgX: number
  if (alignRight) {
    // For right alignment, x is the right edge of the label (including padding)
    bgX = x - totalWidth - padding
    nameX = bgX + padding
  } else {
    // For left alignment, x is the left edge of the label (before padding)
    bgX = x - padding
    nameX = x
  }
  
  // Draw background
  if (!pictureOnly) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)'
    ctx.fillRect(bgX, y - textHeight / 2 - padding, totalWidth + padding * 2, textHeight + padding * 2)
  }
  
  // Draw profile picture
  const profileImg = profilePictures.get(userId)
  if (profileImg && profileImg.complete) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(nameX + profileSize / 2, y, profileSize / 2, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(profileImg, nameX, y - profileSize / 2, profileSize, profileSize)
    ctx.restore()
  } else {
    // Fallback: colored circle
    ctx.fillStyle = playerColor
    ctx.beginPath()
    ctx.arc(nameX + profileSize / 2, y, profileSize / 2, 0, Math.PI * 2)
    ctx.fill()
  }
  
  if (pictureOnly) return;
  // Draw name text
  ctx.fillStyle = '#ffffff'
  ctx.fillText(name, nameX + profileSize + padding, y)
}

// Handle keyboard input
function handleKeyDown(event: KeyboardEvent) {
  if (!props.isActive) return
  
  // Use arrow keys, space, and shift
  const key = event.code
  
  // Cycle display mode with P key (only on first press, not while held)
  if (key === 'KeyP' && !keys.value.has('KeyP')) {
    displayMode.value = (displayMode.value + 1) % 5
    event.preventDefault()
    keys.value.add(key)
    return
  }
  
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
    
    // DEBUG: Log charge state on key release
    const loopPlaying = chargeLoopManager.isPlaying()
    const initialSoundExists = !!localPlayer.initialChargeSound
    const initialSoundPlaying = localPlayer.initialChargeSound && !localPlayer.initialChargeSound.paused
    debug.log(`🔊 SPACE RELEASED - Charge State:`, {
      isCharging: localPlayer.isCharging,
      chargeLoopStarted: localPlayer.chargeLoopStarted,
      loopPlaying: loopPlaying,
      initialSoundExists: initialSoundExists,
      initialSoundPlaying: initialSoundPlaying,
      chargeLevel: localPlayer.chargeLevel,
      chargeTime: chargeTime
    })
    
    // IMMEDIATELY stop ALL charge-related sounds when releasing space
    stopSound('chargeLoop')
    stopSound('charge') // Also stop initial charge sound via sound pool
    
    // Clean up initial charge sound reference
    if (localPlayer.initialChargeSound) {
      try {
        localPlayer.initialChargeSound.pause()
        localPlayer.initialChargeSound.currentTime = 0
        localPlayer.initialChargeSound.onended = null // Remove callback to prevent late loop start
        localPlayer.initialChargeSound.loop = false
      } catch (e) {
        // Ignore errors
      }
      localPlayer.initialChargeSound = undefined
    }
    
    // Reset all charge state flags
    localPlayer.chargeLoopStarted = false
    const wasCharging = localPlayer.isCharging
    const previousChargeLevel = localPlayer.chargeLevel
    localPlayer.chargeStartTime = 0
    
    // DEBUG: Log after cleanup
    debug.log(`🔊 SPACE RELEASED - After Cleanup:`, {
      isCharging: localPlayer.isCharging,
      chargeLoopStarted: localPlayer.chargeLoopStarted,
      loopStillPlaying: chargeLoopManager.isPlaying(),
      initialSoundCleared: !localPlayer.initialChargeSound
    })
    
    if (wasCharging && chargeTime > 0) {
      // Fire based on charge level
      if (chargeTime >= CHARGE_TIME_LV1 && previousChargeLevel >= 1) {
        // Charged shot
        fireChargedShot(localPlayer)
        // Play appropriate charge level sound
        if (previousChargeLevel >= 3) {
          playSound('shootLv3')
        } else if (previousChargeLevel >= 2) {
          playSound('shootLv2')
        } else {
          playSound('shootLv1')
        }
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
    
    // Clear charging state after firing
    localPlayer.isCharging = false
    localPlayer.chargeLevel = 0
    
    // Double-check charge loop is stopped (belt and suspenders)
    if (chargeLoopManager.isPlaying()) {
      stopSound('chargeLoop')
    }
  }
  
  handleInput()
}

function handleInput() {
  const localPlayer = players.value.get(props.userId)
  if (!localPlayer) return
  
  // Safety check: Stop charge loop if player is dead or in invalid state
  if (localPlayer.state === 'dead' || localPlayer.state === 'hit') {
    if (localPlayer.isCharging || chargeLoopManager.isPlaying()) {
      stopSound('chargeLoop')
      localPlayer.isCharging = false
      localPlayer.chargeLoopStarted = false
    }
  }
  
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
      // Perform dash-jump - PRESERVE horizontal dash momentum and jump
      // Save the dash velocity BEFORE changing state
      const dashVelocityX = localPlayer.velocityX
      
      localPlayer.state = 'dashJumping'
      localPlayer.isDashJumping = true
      localPlayer.velocityY = JUMP_STRENGTH
      // EXPLICITLY preserve the dash horizontal velocity
      localPlayer.velocityX = dashVelocityX
      localPlayer.onGround = false
      localPlayer.canDash = true // Reset dash for when you land
      // Clear dash start time so dash duration check doesn't affect us
      localPlayer.dashStartTime = 0
      localPlayer.dashFrameProgress = 0
      
      playSound('jump')
      // Add smoke effect
      localPlayer.smokeEffects.push({
        x: localPlayer.x + 32,
        y: localPlayer.y + 64,
        frame: 0,
        createdAt: Date.now()
      })
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
      // Update lastDashKeyPressed BEFORE returning to prevent re-trigger
      localPlayer.lastDashKeyPressed = dashKeyPressed
      // Return here to prevent processing dash trigger logic below
      return
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
    return // Don't process other input during dash start
  }
  
  // Charging (hold Space) - only update charge, don't fire here
  // CRITICAL: Only process charging if Space key is actually pressed (not from network state)
  const spaceKeyPressed = keys.value.has('Space')
  
  // ALWAYS check for stale charge state FIRST - clean up if space not pressed
  // This runs EVERY FRAME to ensure we catch key releases
  // BUT: Don't call stopSound here - that's handled by handleKeyUp
  // Just reset the flags so handleKeyUp knows to stop the sound
  if (!spaceKeyPressed) {
    // Space NOT pressed - reset charge flags (actual sound stopping happens in handleKeyUp)
    // This prevents the charge state from persisting, but doesn't clear audio references
    if (localPlayer.isCharging || localPlayer.chargeLoopStarted) {
      // Just reset flags - don't stop sound here (handleKeyUp will do that)
      localPlayer.isCharging = false
      localPlayer.chargeLoopStarted = false
      localPlayer.chargeStartTime = 0
      localPlayer.chargeLevel = 0
      
      // Clean up initial charge sound reference (but don't stop it - let handleKeyUp do that)
      if (localPlayer.initialChargeSound) {
        // Remove the onended handler to prevent loop from starting
        try {
          localPlayer.initialChargeSound.onended = null
        } catch (e) {
          // Ignore errors
        }
        localPlayer.initialChargeSound = undefined
      }
    }
    // Don't process any charging logic when space not pressed
  } else {
    // Space IS pressed - handle charging
    if (!localPlayer.isCharging) {
      // Starting a new charge - clean up any stale audio first
      stopSound('chargeLoop')
      if (localPlayer.initialChargeSound) {
        try {
          localPlayer.initialChargeSound.pause()
          localPlayer.initialChargeSound.onended = null
        } catch (e) {}
        localPlayer.initialChargeSound = undefined
      }
      
      localPlayer.isCharging = true
      localPlayer.chargeStartTime = now
      localPlayer.chargeLevel = 0
      localPlayer.chargeLoopStarted = false
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
      
      // Play initial charge sound, then loop - only if charging long enough (300ms)
      // This prevents sound from playing for quick taps
      // CRITICAL: Check if charge sound is already playing to prevent multiple instances
      const chargeSoundAlreadyPlaying = localPlayer.initialChargeSound && 
                                        !localPlayer.initialChargeSound.paused && 
                                        !localPlayer.initialChargeSound.ended &&
                                        localPlayer.initialChargeSound.currentTime > 0
      
      // Also check DOM for any playing charge sounds (nuclear option)
      let domChargeSoundPlaying = false
      try {
        const allAudios = document.querySelectorAll('audio')
        allAudios.forEach((audio) => {
          const src = audio.src || ''
          if ((src.includes('x_charge') || src.includes('charge')) && 
              !src.includes('charge_loop') && 
              !audio.paused && 
              !audio.ended) {
            domChargeSoundPlaying = true
            debug.warn(`🔊 Found playing charge sound in DOM, preventing duplicate`)
          }
        })
      } catch (e) {
        // Ignore
      }
      
      if (chargeTime >= 300 && 
          !chargeSoundAlreadyPlaying && 
          !domChargeSoundPlaying &&
          !localPlayer.initialChargeSound && 
          !localPlayer.chargeLoopStarted && 
          !chargeLoopManager.isPlaying()) {
        debug.log(`🔊 Starting initial charge sound at ${chargeTime}ms`)
        
        // Stop any existing charge sounds first (safety)
        stopSound('charge')
        
        // Create a temporary audio element to mark that we're creating it
        // This prevents race conditions where multiple frames try to create it
        const tempAudio = new Audio() // Dummy to mark as "creating"
        localPlayer.initialChargeSound = tempAudio as any
        
        const chargeSound = playSound('charge', false) // EXPLICITLY set loop to false
        if (chargeSound) {
          // CRITICAL: Ensure charge sound does NOT loop and only plays once
          chargeSound.loop = false
          
          // Verify it's not already playing (might have been created elsewhere)
          if (!chargeSound.paused && chargeSound.currentTime > 0.1) {
            debug.warn(`🔊 Charge sound was already playing, stopping duplicate`)
            chargeSound.pause()
            chargeSound.currentTime = 0
          }
          
          // Store reference IMMEDIATELY to prevent duplicate creation
          localPlayer.initialChargeSound = chargeSound
          const chargeStartTimeSnapshot = localPlayer.chargeStartTime
          
          debug.log(`🔊 Initial charge sound created`, {
            loop: chargeSound.loop,
            paused: chargeSound.paused,
            currentTime: chargeSound.currentTime
          })
          
          // Remove onended handler if it was set elsewhere (safety)
          chargeSound.onended = null
          
          chargeSound.onended = () => {
            // TRIPLE CHECK all conditions before starting loop
            // This callback might fire after space is released
            const stillCharging = localPlayer.isCharging
            const spaceStillPressed = keys.value.has('Space')
            const sameChargeSession = localPlayer.chargeStartTime === chargeStartTimeSnapshot
            const loopNotStarted = !localPlayer.chargeLoopStarted && !chargeLoopManager.isPlaying()
            const gameActive = props.isActive
            
            debug.log(`🔊 Initial charge sound ended - checking loop start:`, {
              stillCharging,
              spaceStillPressed,
              sameChargeSession,
              loopNotStarted,
              gameActive,
              willStartLoop: stillCharging && spaceStillPressed && sameChargeSession && loopNotStarted && gameActive
            })
            
            if (stillCharging && spaceStillPressed && sameChargeSession && loopNotStarted && gameActive) {
              debug.log(`🔊 Starting charge loop via manager`)
              const loopSound = playSound('chargeLoop', true)
              if (loopSound) {
                localPlayer.chargeLoopStarted = true
                debug.log(`🔊 Charge loop started successfully`)
              } else {
                debug.warn(`🔊 Failed to start charge loop`)
              }
            } else {
              debug.log(`🔊 Charge loop NOT started - conditions not met`)
            }
            
            // Always clear reference
            if (localPlayer.initialChargeSound === chargeSound) {
              localPlayer.initialChargeSound = undefined
            }
          }
        }
      }
    }
  }
  
  // Movement with arrow keys
  // Megaman X has air control but with some momentum preservation
  const previousFacing = localPlayer.facing
  const isInAir = !localPlayer.onGround && !localPlayer.onWall
  const isDashJump = localPlayer.isDashJumping || localPlayer.state === 'dashJumping'
  
  // Handle dash jump air control separately (runs even during dashJumping state)
  if (isDashJump && isInAir && !localPlayer.isWallJumping) {
    // DASH JUMP: Allow gradual direction change mid-air by applying opposite force
    // Player can change direction, but it gradually shifts velocity (like applying opposite force)
    if (keys.value.has('ArrowLeft')) {
      localPlayer.facing = 'left'
      // Apply leftward force gradually - slows down rightward momentum and accelerates leftward
      if (localPlayer.velocityX > 0) {
        // Moving right, pressing left - apply opposite force to slow down and reverse
        localPlayer.velocityX = Math.max(-WALK_SPEED, localPlayer.velocityX - 0.6)
      } else if (localPlayer.velocityX > -WALK_SPEED) {
        // Already moving left but not at max - accelerate leftward
        localPlayer.velocityX = Math.max(-WALK_SPEED, localPlayer.velocityX - 0.4)
      }
    } else if (keys.value.has('ArrowRight')) {
      localPlayer.facing = 'right'
      // Apply rightward force gradually - slows down leftward momentum and accelerates rightward
      if (localPlayer.velocityX < 0) {
        // Moving left, pressing right - apply opposite force to slow down and reverse
        localPlayer.velocityX = Math.min(WALK_SPEED, localPlayer.velocityX + 0.6)
      } else if (localPlayer.velocityX < WALK_SPEED) {
        // Already moving right but not at max - accelerate rightward
        localPlayer.velocityX = Math.min(WALK_SPEED, localPlayer.velocityX + 0.4)
      }
    } else {
      // No input - gradually slow down (air friction), but slower than regular jump to preserve momentum
      localPlayer.velocityX *= 0.95
      if (Math.abs(localPlayer.velocityX) < 0.1) {
        localPlayer.velocityX = 0
      }
    }
    
  } else if ((localPlayer.state as string) !== 'dashing') {
    // Regular movement (not dashing, and not dash jumping)
    if (localPlayer.onGround) {
      // Ground movement - full control
      if (keys.value.has('ArrowLeft')) {
        localPlayer.velocityX = -WALK_SPEED
        localPlayer.facing = 'left'
        localPlayer.state = 'walking'
      } else if (keys.value.has('ArrowRight')) {
        localPlayer.velocityX = WALK_SPEED
        localPlayer.facing = 'right'
        localPlayer.state = 'walking'
      } else {
        localPlayer.velocityX = 0
        if (localPlayer.state !== 'landing') {
          localPlayer.state = 'idle'
        }
      }
    } else if (isInAir && !localPlayer.isWallJumping) {
      // REGULAR JUMP: Full air control like original Megaman
      if (keys.value.has('ArrowLeft')) {
        localPlayer.velocityX = -WALK_SPEED
        localPlayer.facing = 'left'
      } else if (keys.value.has('ArrowRight')) {
        localPlayer.velocityX = WALK_SPEED
        localPlayer.facing = 'right'
      } else {
        // No input - gradually slow down (air friction)
        localPlayer.velocityX *= 0.92
        if (Math.abs(localPlayer.velocityX) < 0.1) {
          localPlayer.velocityX = 0
        }
      }
    } else if (localPlayer.isWallJumping) {
      // During wall jump, allow direction change but preserve kick momentum for a short time
      const kickTime = Date.now() - (localPlayer.wallKickTime || 0)
      if (kickTime > 150) {
        // After brief kick phase, allow some air control
        if (keys.value.has('ArrowLeft')) {
          localPlayer.facing = 'left'
          if (localPlayer.velocityX > -WALK_SPEED) {
            localPlayer.velocityX -= 0.5 // Gradual acceleration
          }
        } else if (keys.value.has('ArrowRight')) {
          localPlayer.facing = 'right'
          if (localPlayer.velocityX < WALK_SPEED) {
            localPlayer.velocityX += 0.5
          }
        }
      }
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
      // Wall kick/jump - Megaman X style: kick off wall in direction AWAY from wall
      // In real MMX, wall jump always kicks you away from the wall with consistent force
      const previousWallSide = localPlayer.wallSide
      
      // Calculate kick direction - ALWAYS away from wall (authentic MMX behavior)
      // Player can influence with directional input but base kick is always away
      const pressingLeft = keys.value.has('ArrowLeft')
      const pressingRight = keys.value.has('ArrowRight')
      
      // Base kick velocity away from wall
      let kickX = previousWallSide === 'left' ? WALL_JUMP_X : -WALL_JUMP_X
      
      // Allow player to slightly reduce horizontal momentum if pressing toward wall
      // but never let them stay on the same wall (authentic MMX feel)
      if ((pressingLeft && previousWallSide === 'left') || 
          (pressingRight && previousWallSide === 'right')) {
        // Pressing toward wall - reduced kick but still away from wall
        kickX = kickX * 0.5
      } else if ((pressingLeft && previousWallSide === 'right') || 
                 (pressingRight && previousWallSide === 'left')) {
        // Pressing away from wall - full kick with slight boost
        kickX = kickX * 1.2
      }
      
      localPlayer.velocityX = kickX
      localPlayer.velocityY = WALL_JUMP_Y
      // Face the direction we're jumping (away from wall)
      localPlayer.facing = previousWallSide === 'left' ? 'right' : 'left'
      
      // Clear wall state
      localPlayer.onWall = false
      localPlayer.wallSide = null
      localPlayer.canWallJump = false
      localPlayer.onGround = false
      localPlayer.state = 'wallKick'
      localPlayer.isWallJumping = true
      localPlayer.wallKickTime = Date.now()
      
      playSound('jump')
      
      // Add smoke effect at kick position
      localPlayer.smokeEffects.push({
        x: previousWallSide === 'left' ? localPlayer.x : localPlayer.x + 64,
        y: localPlayer.y + 32,
        frame: 0,
        createdAt: Date.now()
      })
      
      // After wall kick animation (200ms), switch to jumping/falling based on velocity
      setTimeout(() => {
        if (localPlayer.state === 'wallKick' && !localPlayer.onWall && !localPlayer.onGround) {
          localPlayer.state = localPlayer.velocityY < 0 ? 'jumping' : 'falling'
        }
      }, 200)
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
}

// Fire a bullet (uncharged or charged)
function fireBullet(player: Player, chargeLevel: number = 0) {
  if (!props.channelId) return
  
  // Set shooting state to show shooting animation
  player.isShooting = true
  player.lastShotTime = Date.now()
  
  // Clear shooting state after animation duration
  // For continuous shooting, lastShotTime will keep getting updated, so isShooting stays true
  setTimeout(() => {
    const timeSinceLastShot = Date.now() - player.lastShotTime
    // Only clear if enough time has passed since last shot (allows for continuous shooting)
    if (timeSinceLastShot >= 200) {
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
    damage: damage,
    facing: player.facing
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

// Batched tick system - send all player states in one event
let lastTickTime = 0
const TICK_INTERVAL = 64 // ~20 ticks per second (1000ms / 20 = 50ms)

function broadcastGameTick() {
  if (!props.channelId || !gameChannel) return
  
  const now = Date.now()
  if (now - lastTickTime < TICK_INTERVAL) return
  lastTickTime = now
  
  // Build tick payload with all player states
  const localPlayer = players.value.get(props.userId)
  if (!localPlayer) return
  
  // Ensure facing is always valid ('left' or 'right')
  const facingValue = (localPlayer.facing === 'left' || localPlayer.facing === 'right') ? localPlayer.facing : 'right'
  
  const tickPayload = {
    userId: props.userId,
    timestamp: now,
    player: {
      x: localPlayer.x,
      y: localPlayer.y,
      facing: facingValue,
      state: localPlayer.state,
      velocityX: localPlayer.velocityX,
      velocityY: localPlayer.velocityY,
      isShooting: localPlayer.isShooting,
      isCharging: localPlayer.isCharging,
      chargeLevel: localPlayer.chargeLevel,
      onWall: localPlayer.onWall,
      wallSide: localPlayer.wallSide,
      health: localPlayer.health,
      maxHealth: localPlayer.maxHealth,
      lastShotTime: localPlayer.lastShotTime || 0,
      isSpawning: localPlayer.isSpawning || false,
      spawnY: localPlayer.spawnY || 0,
      hitTime: localPlayer.hitTime || 0,
      color: localPlayer.color,
      playerIndex: localPlayer.playerIndex,
    }
  }
  
  // Send single tick event with all state
  gameChannel.send({
    type: 'broadcast',
    event: 'game-tick',
    payload: tickPayload
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
  const floorY = canvasHeight - 64 // Floor is 20px from bottom
  const wallLeft = 0
  const wallRight = canvasWidth
  
  // Always clear canvas first (proper z-buffer clearing)
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)
  
  // Draw background - simple semi-transparent overlay
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
  ctx.fillRect(0, 0, canvasWidth, canvasHeight)
  
  // Draw score system at top
  if (ctx) {
    const scoreY = 10
    const scoreHeight = 30
    const scorePadding = 8
    
    // Background for score area
    ctx!.fillStyle = 'rgba(0, 0, 0, 0.2)'
    ctx!.fillRect(0, 0, canvasWidth, scoreHeight + scorePadding * 2)
    
    // Get sorted players by kills (descending)
    const sortedPlayers = Array.from(players.value.values())
      .filter(p => p.username) // Only show players with usernames
      .sort((a, b) => (b.kills || 0) - (a.kills || 0))
    
    if (sortedPlayers.length > 0) {
      ctx!.font = 'bold 14px sans-serif'
      ctx!.textAlign = 'left'
      ctx!.textBaseline = 'middle'
      
      let xOffset = scorePadding + 64
      const itemSpacing = 12
      
      sortedPlayers.forEach((player) => {
        const kills = player.kills || 0
        const name = player.username || `Player ${player.playerIndex + 1}`
        const text = `${name}: ${kills}`
        
        // Draw colored indicator
        ctx!.fillStyle = player.color
        ctx!.fillRect(xOffset, scoreY + scorePadding, 4, 16)
        
        // Draw text
        ctx!.fillStyle = '#ffffff'
        ctx!.fillText(text, xOffset + 8, scoreY + scorePadding + 8)
        
        // Measure and advance
        const textWidth = ctx!.measureText(text).width
        xOffset += textWidth + itemSpacing + 8
      })
    }
  }
  
  // Draw floor using sprite
  const floorHeight = canvasHeight - floorY 
  if (floorSprite.value && floorSprite.value.complete) {
    // Tile the floor sprite across the width
    const floorTileWidth = floorSprite.value.naturalWidth
    for (let x = 0; x < canvasWidth; x += floorTileWidth) {
      const drawWidth = Math.min(floorTileWidth, canvasWidth - x)
      ctx.drawImage(floorSprite.value, 0, 0, drawWidth, floorSprite.value.naturalHeight, x, floorY, drawWidth, floorHeight)
    }
  } else {
    // Fallback
    ctx.fillStyle = '#2a3f5f'
    ctx.fillRect(0, floorY, canvasWidth, floorHeight)
  }
  
  // Draw walls using sprite
  const wallWidth = 64
  if (wallSprite.value && wallSprite.value.complete) {
    // Left wall
    const wallHeight = wallSprite.value.naturalHeight
    const wallTileHeight = wallHeight
    for (let y = 0; y < canvasHeight; y += wallTileHeight) {
      const drawHeight = Math.min(wallTileHeight, canvasHeight - y)
      ctx.drawImage(wallSprite.value, 0, 0, wallSprite.value.naturalWidth, drawHeight, 0, y, wallWidth, drawHeight)
    }
    
    // Right wall (flipped horizontally)
    ctx.save()
    ctx.scale(-1, 1)
    for (let y = 0; y < canvasHeight; y += wallTileHeight) {
      const drawHeight = Math.min(wallTileHeight, canvasHeight - y)
      ctx.drawImage(wallSprite.value, 0, 0, wallSprite.value.naturalWidth, drawHeight, -canvasWidth, y, wallWidth, drawHeight)
    }
    ctx.restore()
  } else {
    // Fallback
    ctx.fillStyle = '#2a3f5f'
    ctx.fillRect(0, 0, wallWidth, canvasHeight)
    ctx.fillRect(canvasWidth - wallWidth, 0, wallWidth, canvasHeight)
  }
  
  // Draw platforms using sprite
  if (ctx) {
    platforms.value.forEach(platform => {
      // Draw platform using sprite
      if (platformSprite.value && platformSprite.value.complete) {
        const spriteWidth = platformSprite.value.naturalWidth
        const spriteHeight = platformSprite.value.naturalHeight
        const tilesX = Math.ceil(platform.width / spriteWidth)
        
        // Tile the platform sprite
        for (let i = 0; i < tilesX; i++) {
          const tileX = platform.x + i * spriteWidth
          const tileWidth = Math.min(spriteWidth, platform.x + platform.width - tileX)
          ctx!.drawImage(
            platformSprite.value,
            0, 0, tileWidth, spriteHeight,
            tileX, platform.y, tileWidth, platform.height
          )
        }
        
      } else {
        // Fallback
        ctx!.fillStyle = '#2a4a68'
        ctx!.fillRect(platform.x, platform.y, platform.width, platform.height)
      }
    })
  }
  
  // Spawn health pickups periodically (only host spawns)
  const now = Date.now()
  // Check if we're the host (first player alphabetically)
  const sortedParticipants = [...props.participants].sort((a, b) => a.userId.localeCompare(b.userId))
  const isHost = sortedParticipants.length > 0 && sortedParticipants[0].userId === props.userId
  
  if (isHost && now - lastPickupSpawnTime > PICKUP_SPAWN_INTERVAL) {
    spawnHealthPickup()
    lastPickupSpawnTime = now
  }
  
  // Update and draw health pickups
  if (ctx) {
    healthPickups.value.forEach((pickup, pickupId) => {
      // Animate pickup (cycle through 3 frames)
      const animTime = now - pickup.createdAt
      pickup.animFrame = Math.floor((animTime / 150) % 3)
      
      // Draw pickup sprite
      if (itemData.value) {
        const itemFrames = itemData.value[pickup.type]
        if (itemFrames && itemFrames.length > pickup.animFrame) {
          const frame = itemFrames[pickup.animFrame]
          if (frame && frame.file) {
            const sprite = itemSprites.value.get(frame.file)
            
            if (sprite && sprite.complete && sprite.naturalWidth > 0) {
              // Draw items at their original size (no scaling)
              ctx!.drawImage(sprite, pickup.x, pickup.y)
            } else {
              // Fallback: draw colored rectangle
              ctx!.fillStyle = pickup.type === 'HP_Large' ? '#00ff00' : '#88ff88'
              const w = pickup.type === 'HP_Large' ? 32 : 20
              const h = pickup.type === 'HP_Large' ? 24 : 16
              ctx!.fillRect(pickup.x, pickup.y, w, h)
            }
          } else {
            // Frame is undefined or missing file property
            ctx!.fillStyle = pickup.type === 'HP_Large' ? '#00ff00' : '#88ff88'
            const w = pickup.type === 'HP_Large' ? 32 : 20
            const h = pickup.type === 'HP_Large' ? 24 : 16
            ctx!.fillRect(pickup.x, pickup.y, w, h)
          }
        } else {
          // Fallback: draw colored rectangle
          ctx!.fillStyle = pickup.type === 'HP_Large' ? '#00ff00' : '#88ff88'
          const w = pickup.type === 'HP_Large' ? 32 : 20
          const h = pickup.type === 'HP_Large' ? 24 : 16
          ctx!.fillRect(pickup.x, pickup.y, w, h)
        }
      } else {
        // Fallback: draw colored rectangle
        ctx!.fillStyle = pickup.type === 'HP_Large' ? '#00ff00' : '#88ff88'
        const w = pickup.type === 'HP_Large' ? 32 : 20
        const h = pickup.type === 'HP_Large' ? 24 : 16
        ctx!.fillRect(pickup.x, pickup.y, w, h)
      }
      
      // Remove pickups after 30 seconds
      if (now - pickup.createdAt > 30000) {
        healthPickups.value.delete(pickupId)
      }
    })
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
        
        // Remove bullet - all clients process hits locally, so just remove locally
        bullets.value.delete(bulletId)
        
        // Broadcast bullet removal to all players (so they remove it too)
        if (gameChannel) {
          gameChannel.send({
            type: 'broadcast',
            event: 'bullet-removed',
            payload: {
              bulletId: bulletId
            }
          })
        }
        
        // Play hit sound
        playSound('hit') // Use buster hit sound
        
        // Check if player died
        if (player.health <= 0) {
          player.state = 'dead'
          player.hitTime = now // Set hitTime for death animation
          // Stop charge loop if player was charging when they died
          if (player.isCharging) {
            stopSound('chargeLoop')
            player.isCharging = false
            player.chargeLoopStarted = false
          }
          playSound('death') // Use X_LoseLife sound for death
          
          // Increment kill count for shooter
          const shooter = players.value.get(bullet.userId)
          if (shooter && shooter.userId !== player.userId) {
            shooter.kills = (shooter.kills || 0) + 1
          }
          
          // Broadcast kill event (for score tracking only)
          if (gameChannel && bullet.userId !== player.userId) {
            gameChannel.send({
              type: 'broadcast',
              event: 'player-killed',
              payload: {
                killerId: bullet.userId,
                victimId: player.userId
              }
            })
          }
          
          // Respawn after 3 seconds with spawn animation (only for local player)
          // Remote players will respawn via network tick
          if (player.userId === props.userId) {
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
              }
            }, 3000)
          }
        } else {
          // Return to previous state after hit animation
          setTimeout(() => {
            if (player.state === 'hit' && player.health > 0) {
              player.state = player.velocityX !== 0 ? 'walking' : 'idle'
            }
          }, 500) // Match hit animation duration
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
          
          // Flip bullet sprite when facing left
          ctx.save()
          if (bullet.facing === 'left') {
            ctx.scale(-1, 1)
            ctx.drawImage(
              spriteImg,
              -bullet.x - drawWidth / 2,
              bullet.y - drawHeight / 2,
              drawWidth,
              drawHeight
            )
          } else {
            ctx.drawImage(
              spriteImg,
              bullet.x - drawWidth / 2,
              bullet.y - drawHeight / 2,
              drawWidth,
              drawHeight
            )
          }
          ctx.restore()
          
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
                // Flip charge effect when facing left
                ctx.save()
                if (bullet.facing === 'left') {
                  ctx.scale(-1, 1)
                  ctx.drawImage(
                    chargeSprite,
                    -bullet.x - chargeWidth / 2,
                    bullet.y - chargeHeight / 2,
                    chargeWidth,
                    chargeHeight
                  )
                } else {
                  ctx.drawImage(
                    chargeSprite,
                    bullet.x - chargeWidth / 2,
                    bullet.y - chargeHeight / 2,
                    chargeWidth,
                    chargeHeight
                  )
                }
                ctx.restore()
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
                  // Draw trail behind bullet (flip when facing left)
                  ctx.save()
                  if (bullet.facing === 'left') {
                    ctx.scale(-1, 1)
                    ctx.drawImage(
                      trailSprite,
                      -bullet.x + bullet.velocityX * 2 - trailWidth / 2,
                      bullet.y - trailHeight / 2,
                      trailWidth,
                      trailHeight
                    )
                  } else {
                    ctx.drawImage(
                      trailSprite,
                      bullet.x - bullet.velocityX * 2 - trailWidth / 2,
                      bullet.y - trailHeight / 2,
                      trailWidth,
                      trailHeight
                    )
                  }
                  ctx.restore()
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
  
  // Broadcast game tick (all player states in one event)
  broadcastGameTick()
  
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
      // REMOTE PLAYERS: Smooth interpolation towards network position
      // Use time-based interpolation for smooth movement between network ticks
      if (player.targetX !== undefined && player.targetY !== undefined && player.targetUpdateTime) {
        const now = Date.now()
        const timeSinceUpdate = now - player.targetUpdateTime
        const tickInterval = 128 // Match TICK_INTERVAL
        
        // Calculate interpolation factor based on time since last update
        // At tickInterval, we should be at target (1.0), before that we interpolate
        const t = Math.min(1.0, timeSinceUpdate / tickInterval)
        
        // Use smooth interpolation (ease-out for more natural movement)
        // Ease-out cubic: starts fast, ends slow
        const smoothT = 1 - Math.pow(1 - t, 3)
        
        // Interpolate current position towards target
        const dx = player.targetX - player.x
        const dy = player.targetY - player.y
        
        // If difference is very large, snap immediately (teleport correction)
        if (Math.abs(dx) > 100 || Math.abs(dy) > 100) {
          player.x = player.targetX
          player.y = player.targetY
          if (player.lastTargetX === undefined) {
            player.lastTargetX = player.targetX
            player.lastTargetY = player.targetY
          }
        } else {
          // Smooth interpolation towards target
          player.x += dx * smoothT * 0.3 // Smooth interpolation speed (0.3 = 30% per frame when t=1)
          player.y += dy * smoothT * 0.3
          
          // Also apply velocity for more natural movement prediction
          if (player.velocityX !== undefined && player.velocityY !== undefined) {
            // Apply velocity as prediction (helps with smoothness)
            const velocityInfluence = 0.2 // How much velocity affects position
            player.x += player.velocityX * deltaSeconds * 60 * velocityInfluence
            player.y += player.velocityY * deltaSeconds * 60 * velocityInfluence
          }
        }
        
        // Apply physics for natural movement (gravity, etc.)
        if (!player.onGround && !player.onWall && player.velocityY !== undefined) {
          // Apply gravity to remote players based on their state
          if (player.state !== 'wallCling') {
            player.velocityY += GRAVITY * deltaSeconds * 60
          }
        }
      } else {
        // Fallback: apply physics if no target (shouldn't happen, but safety)
        if (!player.onGround && !player.onWall && player.velocityY !== undefined) {
          if (player.state !== 'wallCling') {
            player.velocityY += GRAVITY * deltaSeconds * 60
          }
        }
        if (player.velocityX !== undefined && player.velocityY !== undefined) {
          player.x += player.velocityX * deltaSeconds * 60
          player.y += player.velocityY * deltaSeconds * 60
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
      if (player.x < 48) {
        player.x = 48
      }
      if (player.x > canvasWidth - 96) {
        player.x = canvasWidth - 96
      }
    }
    
    // Wall detection (only for local player - remote players get wall state from network)
    const wallThreshold = 54 // Match wall width for proper collision
    const isNearLeftWall = player.x <= wallLeft + wallThreshold
    const isNearRightWall = player.x >= wallRight - (wallThreshold * 2) // actually should fix the sprite's anchor point but whatever, work around...
    
    // Only apply wall detection and collision to LOCAL player
    // Remote players use network-synced wall state but still apply physics
    if (isLocalPlayer) {
      // Check for wall cling grace period (can't re-grab same wall immediately after wall jump)
      const timeSinceWallKick = Date.now() - (player.wallKickTime || 0)
      const canGrabWall = timeSinceWallKick > WALL_CLING_GRACE_PERIOD || !player.isWallJumping
      
      if ((isNearLeftWall || isNearRightWall) && !player.onGround && canGrabWall) {
        // Check if player is pressing toward wall
        const isPressingTowardLeft = keys.value.has('ArrowLeft')
        const isPressingTowardRight = keys.value.has('ArrowRight')
        
        // Wall cling when pressing toward wall - authentic MMX behavior
        const shouldClingLeft = isPressingTowardLeft && isNearLeftWall
        const shouldClingRight = isPressingTowardRight && isNearRightWall
        
        if (shouldClingLeft || shouldClingRight) {
          const newWallSide = shouldClingLeft ? 'left' : 'right'
          
          if (!player.onWall) {
            // Just touched wall - transition to wall cling
            player.canWallJump = true
            player.isWallJumping = false // Clear wall jump flag when grabbing wall
            player.state = 'wallCling'
            // Face AWAY from wall when clinging (authentic MMX)
            player.facing = newWallSide === 'left' ? 'right' : 'left'
          }
          
          player.onWall = true
          player.wallSide = newWallSide
          
          // Wall slide physics - slow descent with gravity
          // In MMX, wall slide is slow and controlled
          if (player.velocityY > WALL_SLIDE_SPEED) {
            // Slow down to wall slide speed
            player.velocityY = WALL_SLIDE_SPEED
          } else if (player.velocityY < 0) {
            // Rising - apply extra gravity to slow ascent quickly
            player.velocityY += GRAVITY * deltaSeconds * 60 * 2.0
            if (player.velocityY > WALL_SLIDE_SPEED) {
              player.velocityY = WALL_SLIDE_SPEED
            }
          } else {
            // At or below wall slide speed - maintain wall slide speed
            player.velocityY = WALL_SLIDE_SPEED
          }
          
          // Stop horizontal movement while wall clinging
          player.velocityX = 0
          
          // Ensure wall cling state and facing direction
          if (player.state !== 'wallCling') {
            player.state = 'wallCling'
          }
          // Always face away from wall when clinging
          player.facing = player.wallSide === 'left' ? 'right' : 'left'
        } else {
          // Releasing direction key or pressing away - detach and fall
          if (player.onWall) {
            player.onWall = false
            player.wallSide = null
            // Transition to falling state
            if (player.state === 'wallCling') {
              player.state = 'falling'
            }
          }
        }
      } else {
        // Not near wall or on ground - clear wall state
        if (player.onWall) {
          player.onWall = false
          player.wallSide = null
          player.canWallJump = false
          if (player.state === 'wallCling') {
            player.state = player.velocityY < 0 ? 'jumping' : 'falling'
          }
        }
      }
      
      // Store previous Y for platform collision detection
      const prevY = player.y
      
      // Apply velocity to position (local player - remote players already handled above)
      player.x += player.velocityX * deltaSeconds * 60
      player.y += player.velocityY * deltaSeconds * 60
      
      // Platform collision (check before ground collision)
      const collidedPlatform = checkPlatformCollision(player, prevY)
      if (collidedPlatform && player.velocityY >= 0) {
        if (!player.onGround) {
          // Just landed on platform - play land sound
          playSound('land')
          player.isDashJumping = false
          player.canDash = true
          
          player.state = 'landing'
          player.smokeEffects.push({
            x: player.x + 32,
            y: collidedPlatform.y,
            frame: 0,
            createdAt: Date.now()
          })
          setTimeout(() => {
            if (player.state === 'landing') {
              player.state = player.velocityX !== 0 ? 'walking' : 'idle'
            }
          }, 150)
        }
        
        // Position player on platform
        player.y = collidedPlatform.y - 64
        player.velocityY = 0
        player.onGround = true
        player.onWall = false
        player.wallSide = null
        
        // Player stays on platform naturally
      }
      // Ground collision (local player)
      else if (player.y >= floorY - 64) {
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
      
      // Check health pickup collection (local player only)
      healthPickups.value.forEach((pickup, pickupId) => {
        if (checkPickupCollision(player, pickup)) {
          // Always collect the pickup, heal up to max HP
          const prevHealth = player.health
          player.health = Math.min(player.maxHealth, player.health + pickup.healAmount)
          healthPickups.value.delete(pickupId)
          playSound('energyFill')
          debug.log(`🎮 Player collected ${pickup.type} (+${player.health - prevHealth} HP, now ${player.health}/${player.maxHealth})`)
          
          // Broadcast pickup collection
          if (gameChannel) {
            gameChannel.send({
              type: 'broadcast',
              event: 'pickup-collected',
              payload: {
                pickupId,
                userId: player.userId,
                health: player.health
              }
            })
          }
        }
      })
      
      // Update state based on velocity when in air (charging doesn't change state)
      // Keep special states until they should transition
      if (!player.onGround && !player.onWall) {
        // Wall kick transitions to jumping/falling after animation
        if (player.state === 'wallKick') {
          const kickTime = Date.now() - (player.wallKickTime || 0)
          if (kickTime > 200) {
            player.state = player.velocityY < 0 ? 'jumping' : 'falling'
          }
        }
        // Dash jump transitions to falling when velocity turns positive
        else if (player.state === 'dashJumping') {
          if (player.velocityY > 0) {
            player.state = 'falling'
            player.isDashJumping = true // Keep momentum indicator
          }
        }
        // Regular air states
        else if (player.state !== 'dashing' && 
                 player.state !== 'hit' &&
                 player.state !== 'dead' &&
                 !player.isWallJumping) {
          if (player.velocityY > 0.5) {
            player.state = 'falling'
          } else if (player.velocityY < -0.5) {
            player.state = 'jumping'
          }
        }
        // Wall jumping state - transitions based on velocity
        else if (player.isWallJumping && (player.state as string) !== 'wallKick') {
          if (player.velocityY > 0.5) {
            player.state = 'falling'
          } else {
            player.state = 'jumping'
          }
        }
      }
      
      // Clear wall jump flag when landing
      if (player.onGround) {
        if (player.isWallJumping) {
          player.isWallJumping = false
        }
        if (player.isDashJumping) {
          player.isDashJumping = false
        }
      }
      
      // Boundary collision (only for local player)
      // Don't auto-cling to walls on collision - require pressing toward wall
      if (player.x < 48) {
        player.x = 48
      }
      if (player.x > canvasWidth - 96) {
        player.x = canvasWidth - 96
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
      const readyFrame = Math.min(Math.floor(readyAnimTime / 60), 12) // ~130ms per frame
      const readySprite = readySprites.value.get(`Ready${readyFrame}.png`)
      if (readySprite && readySprite.complete && readySprite.naturalWidth > 0) {
        ctx.save()
        const scale = 1.0
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
    
    // Death animation duration: 600ms (Death1-3) + 750ms (5 bubbles at 150ms each) = 1350ms total
    const deathAnimationDuration = 1350
    
    // If death animation is complete, return empty array to hide sprite
    if (deathElapsed >= deathAnimationDuration) {
      return []
    }
    
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
  // For walking + shooting: show run_fire animation as long as player is walking (even after releasing Space)
  // For other states: show shooting animation for 200ms after firing
  const timeSinceLastShot = Date.now() - (player.lastShotTime || 0)
  const wasShootingWhileWalking = player.state === 'walking' && (player.isShooting || timeSinceLastShot < 200)
  const isActivelyShooting = (player.isShooting || timeSinceLastShot < 200) && !player.isCharging
  
  // If walking and was shooting, show run_fire until movement stops (not just until Space is released)
  if (player.state === 'walking' && wasShootingWhileWalking && !player.isCharging) {
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
  
  if (isActivelyShooting) {
    // Dash-jumping + shooting uses Jump_Fire sprites
    if (player.state === 'dashJumping' || player.isDashJumping) {
      const jumpFireFrames = animations.value.shoot.filter(f => 
        f.name.toLowerCase().includes('jump') && f.name.toLowerCase().includes('fire')
      )
      if (jumpFireFrames.length > 0) {
        return jumpFireFrames
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
    const isWalking = player.state === 'walking' // Don't exclude charging - walking animation should play at normal speed even when charging
    // Check if player was shooting while walking (isShooting flag or within 200ms of last shot)
    // For walking: show run_fire as long as walking (even after releasing Space, until movement stops)
    const timeSinceLastShot = Date.now() - (player.lastShotTime || 0)
    const wasShootingWhileWalking = player.state === 'walking' && (player.isShooting || timeSinceLastShot < 200)
    const isWalkOrRunFire = isWalking || (player.state === 'walking' && wasShootingWhileWalking)
    const isWalkOnly = isWalking && !wasShootingWhileWalking // Walk animation (has Run_Start)
    const isRunFireOnly = player.state === 'walking' && wasShootingWhileWalking && !player.isCharging // Run_Fire animation (no start frame)
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
      (player.state === 'walking' && wasShootingWhileWalking && !player.isCharging) ? 'run_fire' :
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
      } else if (isWalkOnly) {
        // Walk animation: Run_Start (frame 0) plays once, then loop Run1-Run10 (frames 1-10)
        if (current === 0) {
          // After Run_Start, move to Run1
          currentFrame.value.set(userId, 1)
        } else {
          // Loop Run1-Run10 (frames 1-10), skipping Run_Start
          const next = ((current - 1) + 1) % 10 + 1 // Loop 1-10
          currentFrame.value.set(userId, next)
        }
      } else if (isRunFireOnly) {
        // Run_Fire animation: Just loop Run_Fire1-Run_Fire10 (frames 0-9), no start frame
        const next = (current + 1) % frames.length
        currentFrame.value.set(userId, next)
      } else if (isWalkOrRunFire && !isWalkOnly && !isRunFireOnly) {
        // Walking while charging: use same loop logic as walk (Run_Start plays once, then loop Run1-Run10)
        // But we're in walk animation, not run_fire, so use walk frame logic
        if (current === 0) {
          // After Run_Start, move to Run1
          currentFrame.value.set(userId, 1)
        } else {
          // Loop Run1-Run10 (frames 1-10), skipping Run_Start
          const next = ((current - 1) + 1) % 10 + 1 // Loop 1-10
          currentFrame.value.set(userId, next)
        }
      } else {
        // Other animations: loop using modulo
        const next = (current + 1) % frames.length
        currentFrame.value.set(userId, next)
      }
      frameTime.value.set(userId, 0) // Reset timer
    }
    
    frameIndex = currentFrame.value.get(userId) || 0
    
    // If we switched between walk and run_fire, preserve frame continuity
    // Walk: Run_Start(0), Run1(1)-Run10(10) → Run_Fire: Run_Fire1(0)-Run_Fire10(9)
    // When switching from walk to run_fire: walk frame 5 (Run5) → run_fire frame 4 (Run_Fire5)
    // When switching from run_fire to walk: run_fire frame 4 (Run_Fire5) → walk frame 5 (Run5)
    // Only adjust frame on the FIRST frame of the switch, not every frame
    if (switchedWalkRunFire) {
      // Only adjust if we haven't already adjusted for this switch
      const lastSwitchFrame = lastSwitchFrameMap.value.get(userId)
      if (lastSwitchFrame !== currentAnimType) {
        if (lastAnim === 'walk' && currentAnimType === 'run_fire') {
          // Switching from walk to run_fire
          // Walk frame 0 (Run_Start) → Run_Fire frame 0 (Run_Fire1)
          // Walk frame 1-10 (Run1-Run10) → Run_Fire frame 0-9 (Run_Fire1-Run_Fire10)
          if (frameIndex === 0) {
            frameIndex = 0 // Run_Start → Run_Fire1
          } else {
            frameIndex = frameIndex - 1 // Run1(1) → Run_Fire1(0), Run2(2) → Run_Fire2(1), etc.
          }
        } else if (lastAnim === 'run_fire' && currentAnimType === 'walk') {
          // Switching from run_fire to walk
          // Run_Fire frame 0-9 → Walk frame 1-10 (skip Run_Start)
          frameIndex = frameIndex + 1 // Run_Fire1(0) → Run1(1), Run_Fire2(1) → Run2(2), etc.
          if (frameIndex > 10) frameIndex = 10 // Clamp to Run10
        }
        currentFrame.value.set(userId, frameIndex)
        lastSwitchFrameMap.value.set(userId, currentAnimType) // Remember we've adjusted for this switch
      }
    } else {
      // Not switching, clear the switch tracking
      lastSwitchFrameMap.value.delete(userId)
    }
    
    // Clamp frame index to valid range for current animation
    if (frames.length > 0 && frameIndex >= frames.length) {
      if (isWallCling) {
        // Wall cling: clamp to last frame (no looping)
        frameIndex = frames.length - 1
      } else if (isWalkOnly) {
        // Walk: ensure we're in range 0-10, but after frame 0, loop 1-10
        if (frameIndex === 0 || frameIndex > 10) {
          frameIndex = 1 // Loop back to Run1
        }
      } else if (isRunFireOnly) {
        // Run_Fire: just ensure we're in valid range 0-9
        frameIndex = frameIndex % frames.length
      } else {
        // Other animations: use modulo to loop
        frameIndex = frameIndex % frames.length
      }
      currentFrame.value.set(userId, frameIndex)
    }
    
    // Update last animation type for next frame
    lastAnimationType.value.set(userId, currentAnimType)
  }
  
  // If no frames (e.g., death animation complete), don't draw sprite
  if (frames.length === 0) {
    return
  }
  
  const frame = frames[frameIndex]
  
  // If no frame, don't draw sprite
  if (!frame) {
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
    
    // For hit sprites: anchor at bottom-center to prevent jumping when sprite height varies
    // Standard player height is 64px, so anchor hit sprites at bottom
    const isHitState = player.state === 'hit'
    const standardPlayerHeight = 64
    const drawY = isHitState 
      ? player.y + standardPlayerHeight - drawHeight  // Anchor at bottom
      : player.y  // Normal anchor at top
    
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
        
        // Draw tinted sprite to main canvas (flip based on state)
        // Wall cling sprites: flip based on facing direction (which is set based on wall side)
        // - Left wall: facing = 'right' (away from wall) = don't flip
        // - Right wall: facing = 'left' (away from wall) = flip
        // Other sprites: flip based on facing direction
        const shouldFlip = (player.state === 'wallCling' || player.onWall) 
          ? player.facing === 'right'  // Use facing direction (which is already set correctly for wall cling)
          : player.facing === 'left'    // Regular flip for left-facing
        
        if (shouldFlip) {
          ctx.scale(-1, 1)
          ctx.drawImage(offscreenCanvas, -player.x - drawWidth, drawY)
          ctx.scale(-1, 1) // Reset
        } else {
          ctx.drawImage(offscreenCanvas, player.x, drawY)
        }
      }
    } else {
      // Draw sprite normally (no tint)
      // Wall cling sprites: flip based on facing direction (which is set based on wall side)
      // - Left wall: facing = 'right' (away from wall) = don't flip
      // - Right wall: facing = 'left' (away from wall) = flip
      // Other sprites: flip based on facing direction
      const shouldFlip = (player.state === 'wallCling' || player.onWall) 
        ? player.facing === 'right'  // Use facing direction (which is already set correctly for wall cling)
        : player.facing === 'left'    // Regular flip for left-facing
      
      if (shouldFlip) {
        ctx.scale(-1, 1)
        ctx.drawImage(
          spriteImg,
          -player.x - drawWidth, // Adjust for flipped position
          drawY, // Use bottom-anchored Y for hit sprites
          drawWidth,
          drawHeight
        )
        ctx.scale(-1, 1) // Reset
      } else {
        ctx.drawImage(
          spriteImg,
          player.x,
          drawY, // Use bottom-anchored Y for hit sprites
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
    // Mode 0,1: follow player, Mode 2: hidden, Mode 3,4: fixed positions
    if (displayMode.value !== 2 && ctx && hpBarData.value && hpBarData.value.HP_Bar) {
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
          
          let hpX: number, hpY: number
          if (displayMode.value === 3 || displayMode.value === 4) {
            // Fixed position in corners/edges
            const sortedPlayers = Array.from(players.value.values()).sort((a, b) => a.playerIndex - b.playerIndex)
            const playerIndexInSorted = sortedPlayers.findIndex(p => p.userId === player.userId)
            const canvasWidth = gameCanvasWidth.value
            const canvasHeight = gameCanvasHeight.value
            const pos = getFixedHealthBarPosition(playerIndexInSorted, sortedPlayers.length, hpWidth, hpHeight, canvasWidth, canvasHeight)
            hpX = pos.x
            hpY = pos.y
          } else {
            // Follow player position
            hpX = player.x + (64 - hpWidth) / 2
            hpY = player.y - hpHeight - 5
          }
          
          ctx.drawImage(hpSprite, hpX, hpY, hpWidth, hpHeight)
        }
      }
    } else if (displayMode.value !== 2 && ctx) {
      // Fallback to simple bar if sprites not loaded
      const barWidth = 60
      const barHeight = 12 // Make taller
      
      let barX: number, barY: number
      if (displayMode.value === 3 || displayMode.value === 4) {
        // Fixed position in corners/edges
        const sortedPlayers = Array.from(players.value.values()).sort((a, b) => a.playerIndex - b.playerIndex)
        const playerIndexInSorted = sortedPlayers.findIndex(p => p.userId === player.userId)
        const canvasWidth = gameCanvasWidth.value
        const canvasHeight = gameCanvasHeight.value
        const pos = getFixedHealthBarPosition(playerIndexInSorted, sortedPlayers.length, barWidth, barHeight, canvasWidth, canvasHeight)
        barX = pos.x
        barY = pos.y
      } else {
        // Follow player position
        barX = player.x + (64 - barWidth) / 2
        barY = player.y - 18
      }
      
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
      ctx.fillRect(barX, barY, barWidth, barHeight)
      
      const healthPercent = player.health / player.maxHealth
      ctx.fillStyle = healthPercent > 0.5 ? '#4ecdc4' : healthPercent > 0.25 ? '#f9ca24' : '#eb4d4b'
      ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight)
    }
    
    // Draw player name with profile picture
    // Mode 0: show name under player
    // Mode 1,2: hide names
    // Mode 3: show name both next to health bar AND under player
    // Mode 4: show name only next to health bar
    if (ctx) {
      const name = player.username || `Player ${player.playerIndex + 1}`
      
      if (displayMode.value === 0) {
        // Normal mode: show name under player (lower and more to the left)
        const nameYUnderPlayer = player.y + 64 + 24 // Positioned lower under the player
        const nameXUnderPlayer = player.x - 8  // Positioned more to the left
        drawNameLabel(name, nameXUnderPlayer, nameYUnderPlayer, ctx, player.userId, player.color, profilePictures.value, false)
      } else if (displayMode.value === 3) {
        // Fixed bars mode: show name both next to bar AND under player
        // Name next to health bar
        const sortedPlayers = Array.from(players.value.values()).sort((a, b) => a.playerIndex - b.playerIndex)
        const playerIndexInSorted = sortedPlayers.findIndex(p => p.userId === player.userId)
        const canvasWidth = gameCanvasWidth.value
        const canvasHeight = gameCanvasHeight.value
        
        // Get health bar position to place name next to it
        const barWidth = 60
        const barHeight = 12
        const barPos = getFixedHealthBarPosition(playerIndexInSorted, sortedPlayers.length, barWidth, barHeight, canvasWidth, canvasHeight)
        
        // Position name to the right of the health bar (or left if on right side)
        const cornerIndex = playerIndexInSorted % 4
        let nameX: number, nameY: number
        let alignRight = false
        if (cornerIndex === 0 || cornerIndex === 2) {
          nameX = barPos.x + 3
          nameY = barPos.y + 60
        } else {
          nameX = barPos.x + barWidth * 2 - 5
          nameY = barPos.y + 60
          alignRight = true
        }
        
        // Draw name next to health bar
        drawNameLabel(name, nameX, nameY, ctx, player.userId, player.color, profilePictures.value, alignRight, true)
        
        // Also show name under the player (lower and more to the left)
        const nameYUnderPlayer = player.y + 64 + 24 // Positioned lower under the player
        const nameXUnderPlayer = player.x - 8 // Positioned more to the left
        drawNameLabel(name, nameXUnderPlayer, nameYUnderPlayer, ctx, player.userId, player.color, profilePictures.value, false)
      } else if (displayMode.value === 4) {
        // Fixed bars mode: show name only next to health bar
        const sortedPlayers = Array.from(players.value.values()).sort((a, b) => a.playerIndex - b.playerIndex)
        const playerIndexInSorted = sortedPlayers.findIndex(p => p.userId === player.userId)
        const canvasWidth = gameCanvasWidth.value
        const canvasHeight = gameCanvasHeight.value
        
        // Get health bar position to place name next to it
        const barWidth = 60
        const barHeight = 12
        const barPos = getFixedHealthBarPosition(playerIndexInSorted, sortedPlayers.length, barWidth, barHeight, canvasWidth, canvasHeight)
        
        // Position name to the right of the health bar (or left if on right side)
        const cornerIndex = playerIndexInSorted % 4
        let nameX: number, nameY: number
        let alignRight = false
        if (cornerIndex === 0 || cornerIndex === 2) {
          nameX = barPos.x + 3
          nameY = barPos.y + 60
        } else {

          nameX = barPos.x + barWidth * 2 - 5
          nameY = barPos.y + 60
          alignRight = true
        }
        
        // Draw name next to health bar
        drawNameLabel(name, nameX, nameY, ctx, player.userId, player.color, profilePictures.value, alignRight, true)
      }
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
          // bitmapResolution=2 + size=200 in Scratch = 1.0 effective scale
          const smokeWidth = smokeSprite.naturalWidth
          const smokeHeight = smokeSprite.naturalHeight
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
  
  gameChannel.on('broadcast', { event: 'game-tick' }, (payload) => {
    const data = payload.payload as any
    const { userId, timestamp, player: playerData } = data
    if (!playerData) return
    
    const { x, y, facing, state, velocityX, velocityY, isShooting, isCharging, chargeLevel, onWall, wallSide, health, maxHealth, isSpawning, spawnY, spawnX, hitTime, color, playerIndex } = playerData
    
    // Don't update local player from remote updates
    if (userId === props.userId) return
    
    let player = players.value.get(userId)
    
    // Create player if they don't exist (for late joiners)
    if (!player) {
      const canvasHeight = gameCanvasHeight.value
      const floorY = canvasHeight - 20
      
      // Use color and playerIndex from network if provided (for proper sync)
      // Otherwise use color assignments from host, or fallback
      let playerColor: string
      let assignedPlayerIndex: number
      
      if (color && playerIndex !== undefined && playerIndex >= 0 && playerIndex < PLAYER_COLORS.length) {
        // Use synced color and index from network
        playerColor = color
        assignedPlayerIndex = playerIndex
        debug.log(`🎮 Using synced color for remote player ${userId.substring(0, 6)}: ${playerColor} (index ${assignedPlayerIndex})`)
      } else if (colorAssignments.value.has(userId)) {
        // Use color assignment from host
        const assignment = colorAssignments.value.get(userId)!
        playerColor = assignment.color
        assignedPlayerIndex = assignment.playerIndex
        debug.log(`🎮 Using host-assigned color for remote player ${userId.substring(0, 6)}: ${playerColor} (index ${assignedPlayerIndex})`)
      } else {
        // Fallback: temporary assignment (will be updated when host broadcasts)
        assignedPlayerIndex = 0
        playerColor = PLAYER_COLORS[0]
        debug.log(`🎮 Fallback: temporary color for remote player ${userId.substring(0, 6)}: ${playerColor} (will update from host)`)
      }
      
      // Use spawnX if provided (for initial spawn), otherwise use received x
      const initialX = spawnX !== undefined && spawnX !== null ? spawnX : (x || 100)
      
      // Get username and profile picture from useUserData
      const remoteUsername = getUserDisplayName(userId).value || `Player ${assignedPlayerIndex + 1}`
      const remoteProfilePicture = getUserAvatarUrl(userId).value || undefined
      
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
        playerIndex: assignedPlayerIndex,
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
        lastTargetX: initialX,
        lastTargetY: y || (floorY - 64),
        targetUpdateTime: Date.now(),
        lastNetworkUpdate: Date.now(),
        username: remoteUsername,
        profilePicture: remoteProfilePicture,
        kills: 0
      } as Player
      
      // Load profile picture if available
      if (remoteProfilePicture) {
        const profileImg = new Image()
        profileImg.crossOrigin = 'anonymous'
        profileImg.onload = () => {
          profilePictures.value.set(userId, profileImg)
        }
        profileImg.onerror = () => {
          debug.warn(`Failed to load profile picture for ${userId}`)
        }
        profileImg.src = remoteProfilePicture
      }
      
      players.value.set(userId, player)
      currentFrame.value.set(userId, 0)
      frameTime.value.set(userId, 0)
      chargeFrame.value.set(userId, 0)
      
      debug.log(`🎮 Created remote player: ${userId} at (${player.x}, ${player.y}) facing ${player.facing}`)
    }
    
      // Update player state - ALWAYS update position and facing from network
      // Remote players should use network data, not local physics
      if (player) {
        // Update username and profile picture from useUserData (in case they changed)
        const updatedUsername = getUserDisplayName(userId).value
        const updatedProfilePicture = getUserAvatarUrl(userId).value
        if (updatedUsername && updatedUsername !== player.username) {
          player.username = updatedUsername
        }
        if (updatedProfilePicture && updatedProfilePicture !== player.profilePicture) {
          player.profilePicture = updatedProfilePicture
          // Reload profile picture
          if (updatedProfilePicture) {
            const profileImg = new Image()
            profileImg.crossOrigin = 'anonymous'
            profileImg.onload = () => {
              profilePictures.value.set(userId, profileImg)
            }
            profileImg.onerror = () => {
              debug.warn(`Failed to load updated profile picture for ${userId}`)
            }
            profileImg.src = updatedProfilePicture
          }
        }
        
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
      // Update previous target before setting new target for smooth interpolation
      if (x !== undefined && x !== null) {
        // Store current target as previous before updating
        if (player.targetX !== undefined) {
          player.lastTargetX = player.targetX
        } else {
          player.lastTargetX = player.x
        }
        player.targetX = x
      }
      if (y !== undefined && y !== null) {
        // Store current target as previous before updating
        if (player.targetY !== undefined) {
          player.lastTargetY = player.targetY
        } else {
          player.lastTargetY = player.y
        }
        player.targetY = y
      }
      player.lastNetworkUpdate = Date.now()
      player.targetUpdateTime = Date.now() // Track when target was updated for interpolation
      
      // Update state and velocity from network (controls the physics)
      // BUT: Don't overwrite hit/death states until animations complete
      if (state !== undefined && state !== null) {
        const now = Date.now()
        const isInHitState = player.state === 'hit'
        const isInDeadState = player.state === 'dead'
        
        // If player is in hit state, only allow state change after hit animation completes (500ms)
        if (isInHitState) {
          const hitElapsed = now - player.hitTime
          if (hitElapsed < 500) {
            // Hit animation still playing - don't overwrite state
            // But allow transition to 'dead' if health is 0
            if (state === 'dead' && (player.health <= 0 || health <= 0)) {
              player.state = 'dead'
              // Use network hitTime if provided, otherwise use current time
              player.hitTime = hitTime && hitTime > 0 ? hitTime : now
            }
          } else {
            // Hit animation complete - allow state update
            player.state = state
            // Update hitTime if provided and state is hit/dead
            if ((state === 'hit' || state === 'dead') && hitTime && hitTime > 0) {
              player.hitTime = hitTime
            }
          }
        }
        // If player is in dead state, only allow state change after death animation completes (1350ms)
        else if (isInDeadState) {
          const deathElapsed = now - player.hitTime
          if (deathElapsed < 1350) {
            // Death animation still playing - don't overwrite state
          } else {
            // Death animation complete - allow state update (e.g., respawn)
            player.state = state
          }
        }
        // Normal state update (not in hit/death animation)
        else {
          // Allow state update, but prioritize hit/dead states from network
          if (state === 'hit' || state === 'dead') {
            player.state = state
            // If state is hit or dead, use network hitTime if provided
            if (hitTime && hitTime > 0) {
              player.hitTime = hitTime
            } else if (!player.hitTime || player.hitTime === 0) {
              // Fallback: use current time if no hitTime provided
              player.hitTime = now
            }
          } else {
            player.state = state
          }
        }
      }
      if (velocityX !== undefined && velocityX !== null) player.velocityX = velocityX
      if (velocityY !== undefined && velocityY !== null) player.velocityY = velocityY
      player.isShooting = isShooting || false
      // Only update isCharging for remote players - never update local player from network
      // This prevents network feedback loops from affecting local player state
      if (userId !== props.userId) {
        player.isCharging = isCharging || false
        player.chargeLevel = chargeLevel || 0
      }
      player.onWall = onWall || false
      player.wallSide = wallSide || null
      if (health !== undefined) player.health = health
      if (maxHealth !== undefined) player.maxHealth = maxHealth
      
      // Sync color and playerIndex from network (for proper palette sync)
      if (color && playerIndex !== undefined && playerIndex >= 0 && playerIndex < PLAYER_COLORS.length) {
        if (player.color !== color || player.playerIndex !== playerIndex) {
          debug.log(`🎮 Updating color for remote player ${userId.substring(0, 6)}: ${player.color} -> ${color} (index ${player.playerIndex} -> ${playerIndex})`)
          player.color = color
          player.playerIndex = playerIndex
        }
      }
      
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
      const remoteLastShotTime = playerData.lastShotTime
      if (remoteLastShotTime !== undefined && remoteLastShotTime > 0) {
        player.lastShotTime = remoteLastShotTime
        player.isShooting = Date.now() - remoteLastShotTime < 200
      }
      
      // Sync hitTime if provided (for hit/death animations)
      if (hitTime !== undefined && hitTime > 0) {
        player.hitTime = hitTime
      }
    }
  })
  
  gameChannel.on('broadcast', { event: 'player-respawned' }, (payload) => {
    const { userId, x, y, spawnY, health, maxHealth } = payload.payload as any
    
    const player = players.value.get(userId)
    if (!player) return
    
    // Don't process respawn for local player (handled locally)
    if (userId === props.userId) return
    
    // Clear any pending respawn timeout
    if ((player as any).respawnTimeout) {
      clearTimeout((player as any).respawnTimeout)
      delete (player as any).respawnTimeout
    }
    
    const canvasHeight = gameCanvasHeight.value
    const floorY = canvasHeight - 20
    
    // Respawn player
    player.health = health || maxHealth || 100
    player.maxHealth = maxHealth || 100
    player.x = x || 100
    player.y = y || -100 // Start above screen for spawn animation
    player.velocityX = 0
    player.velocityY = 0
    player.state = 'idle'
    player.isSpawning = true
    player.spawnTime = Date.now()
    player.spawnY = spawnY || (floorY - 64)
    player.invulnerableUntil = Date.now() + 2000 // Extra invulnerability on respawn
    
    debug.log(`🎮 Remote player ${userId.substring(0, 6)} respawned at (${player.x}, ${player.y})`)
  })
  
  gameChannel.on('broadcast', { event: 'color-assignments' }, (payload) => {
    const { assignments } = payload.payload as { assignments: Record<string, { color: string; playerIndex: number }> }
    
    // Store color assignments from host
    Object.entries(assignments).forEach(([userId, assignment]) => {
      colorAssignments.value.set(userId, assignment)
      
      // Update existing players with new color assignments
      const player = players.value.get(userId)
      if (player) {
        player.color = assignment.color
        player.playerIndex = assignment.playerIndex
        debug.log(`🎮 Updated color for player ${userId.substring(0, 6)}: ${assignment.color} (index ${assignment.playerIndex})`)
      }
    })
    
    debug.log(`🎮 Received color assignments from host:`, assignments)
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
  
  gameChannel.on('broadcast', { event: 'pickup-collected' }, (payload) => {
    const { pickupId, userId, health } = payload.payload as { pickupId: string; userId: string; health: number }
    
    // Remove pickup for all players
    healthPickups.value.delete(pickupId)
    
    // Update remote player health
    const player = players.value.get(userId)
    if (player && userId !== props.userId) {
      player.health = health
    }
  })
  
  gameChannel.on('broadcast', { event: 'pickup-spawned' }, (payload) => {
    const { pickupId, x, y, type, healAmount, createdAt } = payload.payload as {
      pickupId: string
      x: number
      y: number
      type: 'HP_Small' | 'HP_Large'
      healAmount: number
      createdAt: number
    }
    
    // Don't add if we already have it (prevent duplicates)
    if (healthPickups.value.has(pickupId)) return
    
    const pickup: HealthPickup = {
      id: pickupId,
      x,
      y,
      type,
      healAmount,
      createdAt,
      animFrame: 0
    }
    
    healthPickups.value.set(pickupId, pickup)
  })
  
  gameChannel.on('broadcast', { event: 'player-killed' }, (payload) => {
    const { killerId, victimId } = payload.payload as { killerId: string; victimId: string }
    
    // Increment kill count for killer
    const killer = players.value.get(killerId)
    if (killer) {
      killer.kills = (killer.kills || 0) + 1
    }
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

// Watch for participants changes to remove disconnected players
watch(() => props.participants, (newParticipants, oldParticipants) => {
  if (!oldParticipants || !props.isActive) return
  
  // Find players that are no longer in participants
  const currentParticipantIds = new Set(newParticipants.map(p => p.userId))
  const oldParticipantIds = new Set(oldParticipants.map(p => p.userId))
  
  // Remove players that are no longer in participants (but keep local player)
  players.value.forEach((player, userId) => {
    if (userId !== props.userId && !currentParticipantIds.has(userId) && oldParticipantIds.has(userId)) {
      debug.log(`🎮 Removing disconnected player: ${userId.substring(0, 6)}`)
      players.value.delete(userId)
      // Also clean up related data
      profilePictures.value.delete(userId)
      colorAssignments.value.delete(userId)
      playerResolutions.value.delete(userId)
      currentFrame.value.delete(userId)
      lastAnimationType.value.delete(userId)
    }
  })
}, { deep: true })

function updateCanvasSize() {
  if (playerResolutions.value.size === 0) {
    gameCanvasWidth.value = Math.max(360, window.innerWidth)
    gameCanvasHeight.value = Math.max(240, window.innerHeight)
    // Re-initialize platforms when canvas size changes
    if (props.isActive) {
      initializePlatforms()
    }
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
  
  // Re-initialize platforms when canvas size changes (so they're canvas-relative)
  if (props.isActive) {
    initializePlatforms()
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
  lastPickupSpawnTime = Date.now()
  
  // Clear pickups from previous game
  healthPickups.value.clear()
  
  // Initialize platforms
  initializePlatforms()
  
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
  
  // Stop ALL sounds when exiting game - especially charge loop
  stopSound('chargeLoop')
  stopSound('charge')
  
  // Stop and clean up all playing sounds
  playingSounds.forEach((audio, soundName) => {
    try {
      audio.pause()
      audio.currentTime = 0
      audio.loop = false
      audio.onended = null
      audio.onerror = null
    } catch (e) {
      // Ignore errors
    }
  })
  playingSounds.clear()
  
  // Clean up charge loop manager
  chargeLoopManager.cleanup()
  
  // Clean up player charge states
  players.value.forEach((player) => {
    player.isCharging = false
    player.chargeLoopStarted = false
    player.chargeStartTime = 0
    if (player.initialChargeSound) {
      try {
        player.initialChargeSound.pause()
        player.initialChargeSound.currentTime = 0
        player.initialChargeSound.onended = null
      } catch (e) {
        // Ignore errors
      }
      player.initialChargeSound = undefined
    }
  })
  
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
  // Ensure all sounds are stopped before closing
  stopSound('chargeLoop')
  stopSound('charge')
  
  // Clean up any player charge sounds
  const localPlayer = players.value.get(props.userId)
  if (localPlayer?.initialChargeSound) {
    try {
      localPlayer.initialChargeSound.pause()
      localPlayer.initialChargeSound.onended = null
    } catch (e) {}
    localPlayer.initialChargeSound = undefined
  }
  
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
  /* background: rgba(26, 26, 46, 0.95); */
  border: 2px solid #4ecdc4;
  backdrop-filter: blur(2px);
  box-shadow: 0 0 20px rgba(78, 205, 196, 0.6);
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  display: block;
  position: fixed;
  z-index: 10003;
  top: 0;
  left: 0;
  bottom: 0;
  right: 0;
  margin: auto;
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
