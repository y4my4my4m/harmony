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
  state: 'idle' | 'walking' | 'jumping' | 'falling' | 'landing' | 'shooting' | 'dashing' | 'wallCling' | 'hit' | 'dead'
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
  wall?: AnimationFrame[]
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

function playSound(soundName: keyof typeof soundPaths, loop: boolean = false) {
  try {
    initializeSounds()
    
    const paths = soundPaths[soundName]
    if (!paths || paths.length === 0) return
    
    // Try to play sound - create new Audio each time for better reliability
    for (const path of paths) {
      try {
        const audio = new Audio(path)
        audio.volume = 0.3
        audio.loop = loop
        const playPromise = audio.play()
        if (playPromise) {
          playPromise.catch((err) => {
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

// Load effect sprites (smoke, hit, death, ready)
async function loadEffectSprites() {
  // Load smoke sprites
  for (let i = 1; i <= 6; i++) {
    const img = new Image()
    img.src = `/assets/easteregg/megaman/sprites/91bd67ba95f6268d620fb979740e067d.png` // Smoke1
    if (i === 1) {
      const smokeFiles = [
        '91bd67ba95f6268d620fb979740e067d.png', // Smoke1
        '5c4ed69b9d8d86739e7050c054a4c4e2.png', // Smoke2
        '1b421d6c89210c8d76451461229d1e96.png', // Smoke3
        'c4ce1cacca548b610a33ba6aeb1b02a4.png', // Smoke4
        'ebc1e3f6d1baafc857bfad8c53920cc6.png', // Smoke5
        '46dc7c0864d7011b1d2cbc0baea9d11c.png', // Smoke6
      ]
      for (let j = 0; j < smokeFiles.length; j++) {
        const smokeImg = new Image()
        smokeImg.src = `/assets/easteregg/megaman/sprites/${smokeFiles[j]}`
        smokeImg.onload = () => smokeSprites.value.set(`Smoke${j + 1}.png`, smokeImg)
      }
    }
  }
  
  // Load hit sprites
  const hitFiles = [
    '158a6fc8342580dad99bcd0cc3da6f5d.png', // Hit1
    '49d8234616dc6d46d1d29ae6a10b6b5f.png', // Hit2
    '5b0a9bbe83f883e0e648f3cffda96839.png', // Hit3
    '5f4eacbd8a13fe907a24e9dd4b366ca8.png', // Hit4
    'ee5b4945c2685f318106f951a537a73c.png', // Hit5
    '91a9950186deed6b06296ec179d17a24.png', // Hit6
    'a37bb271560e365e9eac949ac675c009.png', // Hit7
    '68a9b48284eab02f64a9aacec96b76c6.png', // Hit8
    '4fd717ba3385c8d6d76ea1df21e2b245.png', // Hit9
    '399f62bacb879833ca499c139e9a4461.png', // Hit10
  ]
  for (let i = 0; i < hitFiles.length; i++) {
    const hitImg = new Image()
    hitImg.src = `/assets/easteregg/megaman/sprites/${hitFiles[i]}`
    hitImg.onload = () => hitSprites.value.set(`Hit${i + 1}.png`, hitImg)
  }
  
  // Load death bubble sprites
  const bubbleFiles = [
    '9cc8ef10ae74f39329ad6010aa037d7c.png', // Bubble1
    'e7da56b51e9f0a3e45003ec18c486b3f.png', // Bubble2
    '0e2f47ca72197d1cd118d045f9879ae5.png', // Bubble3
    'a631ed7e3a6a9ed3f398760f3b9c2a83.png', // Bubble4
    'a99df56d8b808493ff7feb23fb1a2382.png', // Bubble5
  ]
  for (let i = 0; i < bubbleFiles.length; i++) {
    const bubbleImg = new Image()
    bubbleImg.src = `/assets/easteregg/megaman/sprites/${bubbleFiles[i]}`
    bubbleImg.onload = () => deathBubbleSprites.value.set(`Bubble${i + 1}.png`, bubbleImg)
  }
  
  // Load Ready (intro) sprites
  const readyFiles = [
    '3495321c6b96977754d0640a217b0bbb.png', // Ready0
    'ab48d7b0004000561df78c2ed1a49097.png', // Ready1
    '527415308683c1ae03002b994f62523c.png', // Ready2
    '05361c98720aa7b021e7baa040305c96.png', // Ready3
    '53916d8af31494b8ad18e43da577f42d.png', // Ready4
    '273d250fa24222dfabc193731ece432e.png', // Ready5
    '2d99806b4adb3c306337b7b831d7dc9f.png', // Ready6
    'c105cc8cfe61d517749eee97dd6a44d4.png', // Ready7
    'a34556b9a853e584a69aee58987bea60.png', // Ready8
    'b80a6838d5f53cddf60be65dc119c25a.png', // Ready9
    'cf16acf016e7eccdf36303bc36154417.png', // Ready10
    'ebc29ca008dad4472c2364093628cd0e.png', // Ready11
    'd27003a4b30032e3001dfef312fc4c69.png', // Ready12
  ]
  for (let i = 0; i < readyFiles.length; i++) {
    const readyImg = new Image()
    readyImg.src = `/assets/easteregg/megaman/sprites/${readyFiles[i]}`
    readyImg.onload = () => readySprites.value.set(`Ready${i}.png`, readyImg)
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
    // Random spawn position
    const canvasWidth = canvas ? canvas.width / (window.devicePixelRatio || 1) : 600
    const randomX = 50 + Math.random() * (canvasWidth - 150)
    
    const player: Player = {
      userId: participant.userId,
      x: randomX,
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
      canDash: true,
      health: 100,
      maxHealth: 100,
      hitTime: 0,
      invulnerableUntil: 0,
      canWallJump: false,
      smokeEffects: []
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
      
      // Play charge sound on start, then loop
      if (chargeTime < 100) {
        playSound('charge')
      } else if (chargeTime > 200 && chargeTime % 1000 < 50) {
        // Play charge loop occasionally
        playSound('chargeLoop')
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
  
  // Jump (ArrowUp) - only on key press, not hold
  if (keys.value.has('ArrowUp') && !localPlayer.onGround && !localPlayer.onWall) {
    // Prevent double jump
  } else if (keys.value.has('ArrowUp')) {
    if (localPlayer.onWall && localPlayer.wallSide && localPlayer.canWallJump) {
      // Wall jump - requires canWallJump flag (set when first touching wall)
      localPlayer.velocityY = WALL_JUMP_Y
      localPlayer.velocityX = localPlayer.wallSide === 'left' ? WALL_JUMP_X : -WALL_JUMP_X
      localPlayer.onWall = false
      localPlayer.wallSide = null
      localPlayer.canWallJump = false
      localPlayer.state = 'jumping'
      playSound('jump')
      // Add smoke effect at jump position
      localPlayer.smokeEffects.push({
        x: localPlayer.x + 32,
        y: localPlayer.y + 64,
        frame: 0,
        createdAt: Date.now()
      })
    } else if (localPlayer.onGround && localPlayer.state !== 'jumping' && localPlayer.state !== 'falling') {
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
      health: player.health,
      maxHealth: player.maxHealth,
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
  
  // Draw intro animation
  if (showIntro && gameStartTime > 0 && ctx) {
    const introTime = Date.now() - gameStartTime
    if (introTime < 2000) { // Show intro for 2 seconds
      const readyFrame = Math.min(Math.floor(introTime / 150), 12)
      const readySprite = readySprites.value.get(`Ready${readyFrame}.png`)
      if (readySprite && readySprite.complete) {
        ctx.save()
        const readyWidth = readySprite.naturalWidth * 0.5
        const readyHeight = readySprite.naturalHeight * 0.5
        ctx.drawImage(
          readySprite,
          (canvasWidth - readyWidth) / 2,
          (canvasHeight - readyHeight) / 2,
          readyWidth,
          readyHeight
        )
        ctx.restore()
      }
    } else {
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
        
        // Remove bullet
        bullets.value.delete(bulletId)
        
        // Broadcast damage
        if (props.channelId) {
          const channel = supabase.channel(`megaman-game:${props.channelId}`)
          channel.send({
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
          playSound('damage') // Use damage sound for death
          // Respawn after 3 seconds
          setTimeout(() => {
            if (player.health <= 0) {
              player.health = player.maxHealth
              player.x = 50 + Math.random() * (canvasWidth - 150)
              player.y = floorY - 64
              player.velocityX = 0
              player.velocityY = 0
              player.state = 'idle'
              player.invulnerableUntil = now + 2000 // Extra invulnerability on respawn
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
    
    if ((isNearLeftWall || isNearRightWall) && !player.onGround && player.velocityY > 0) {
      // Can wall cling
      if (keys.value.has('ArrowLeft') && isNearLeftWall) {
        if (!player.onWall) {
          // Just touched wall - enable wall jump
          player.canWallJump = true
        }
        player.onWall = true
        player.wallSide = 'left'
        player.velocityY = WALL_SLIDE_SPEED // Slide down slowly
        player.state = 'wallCling'
      } else if (keys.value.has('ArrowRight') && isNearRightWall) {
        if (!player.onWall) {
          // Just touched wall - enable wall jump
          player.canWallJump = true
        }
        player.onWall = true
        player.wallSide = 'right'
        player.velocityY = WALL_SLIDE_SPEED
        player.state = 'wallCling'
      } else {
        player.onWall = false
        player.wallSide = null
        player.canWallJump = false
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
        player.state = 'landing'
        setTimeout(() => {
          if (player.state === 'landing') {
            player.state = player.velocityX !== 0 ? 'walking' : 'idle'
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
    
    // Update state based on velocity when in air (charging doesn't change state)
    if (!player.onGround && !player.onWall && (player.state as string) !== 'dashing') {
      if (player.velocityY > 0) {
        player.state = 'falling'
      } else if (player.velocityY < 0) {
        player.state = 'jumping'
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
  
  // Handle hit state
  if (player.state === 'hit') {
    // Use hit sprites if available (Hit1-Hit10)
    const hitFrames: AnimationFrame[] = []
    for (let i = 1; i <= 10; i++) {
      const hitSprite = hitSprites.value.get(`Hit${i}.png`)
      if (hitSprite) {
        hitFrames.push({ name: `Hit${i}`, file: `Hit${i}.png` })
      }
    }
    if (hitFrames.length > 0) {
      const hitTime = Date.now() - player.hitTime
      const hitFrameIndex = Math.min(Math.floor(hitTime / 30), hitFrames.length - 1)
      return [hitFrames[hitFrameIndex]]
    }
  }
  
  // Handle death state
  if (player.state === 'dead') {
    // Use death bubble sprites
    const deathFrames: AnimationFrame[] = []
    for (let i = 1; i <= 5; i++) {
      const bubbleSprite = deathBubbleSprites.value.get(`Bubble${i}.png`)
      if (bubbleSprite) {
        deathFrames.push({ name: `Bubble${i}`, file: `Bubble${i}.png` })
      }
    }
    if (deathFrames.length > 0) {
      const deathTime = Date.now() - player.hitTime
      const deathFrameIndex = Math.min(Math.floor(deathTime / 200), deathFrames.length - 1)
      return [deathFrames[deathFrameIndex]]
    }
  }
  
  // Wall cling takes priority
  if (player.onWall && player.state === 'wallCling') {
    return animations.value.wall || []
  }
  
  // Dash takes priority
  if (player.state === 'dashing') {
    return animations.value.dash || animations.value.walk || []
  }
  
  // Shooting animation when shooting (including while charging)
  if (player.isShooting || player.isCharging) {
    // Find shooting animation that matches current movement state
    const shootFrames = animations.value.shoot.filter(frame => {
      const name = frame.name.toLowerCase()
      if (player.state === 'idle' && name.includes('idle') && name.includes('fire')) return true
      if (player.state === 'walking' && name.includes('run') && name.includes('fire')) return true
      if (player.state === 'jumping' && name.includes('jump') && name.includes('fire')) return true
      if (player.state === 'falling' && name.includes('fall') && name.includes('fire')) return true
      if (player.state === 'dashing' && name.includes('dash') && name.includes('fire')) return true
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
  
  // Don't draw placeholder - wait for sprites to load
  if (frames.length === 0 || !animations.value) {
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
    
    // Handle hit state - flash effect
    const now = Date.now()
    const isInvulnerable = now < player.invulnerableUntil
    if (isInvulnerable && player.state === 'hit') {
      // Flash effect - alternate visibility
      const flashRate = 100 // ms
      const flashVisible = Math.floor((now - player.hitTime) / flashRate) % 2 === 0
      if (!flashVisible) {
        ctx.globalAlpha = 0.3
      }
    }
    
    // Apply palette swap (color tint) for different players - preserve transparency
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
        
        // Apply color tint while preserving transparency
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 0) { // Only process non-transparent pixels
            // Blend with target color (60% original, 40% target for subtle tint)
            data[i] = Math.floor(data[i] * 0.6 + targetR * 0.4)     // R
            data[i + 1] = Math.floor(data[i + 1] * 0.6 + targetG * 0.4) // G
            data[i + 2] = Math.floor(data[i + 2] * 0.6 + targetB * 0.4) // B
            // Alpha stays the same
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
    
    // Draw smoke effects
    if (player.smokeEffects.length > 0 && ctx) {
      player.smokeEffects = player.smokeEffects.filter(smoke => {
        const age = Date.now() - smoke.createdAt
        if (age > 500) return false // Remove after 500ms
        
        // Draw smoke sprite (if loaded)
        const smokeFrame = Math.floor((age / 80) % 6) // 6 smoke frames
        const smokeSprite = smokeSprites.value.get(`Smoke${smokeFrame + 1}.png`)
        if (smokeSprite && smokeSprite.complete && ctx) {
          const smokeWidth = smokeSprite.naturalWidth * 0.5
          const smokeHeight = smokeSprite.naturalHeight * 0.5
          ctx.globalAlpha = 1 - (age / 500) // Fade out
          ctx.drawImage(smokeSprite, smoke.x - smokeWidth/2, smoke.y - smokeHeight/2, smokeWidth, smokeHeight)
          ctx.globalAlpha = 1.0
        }
        return true
      })
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
        smokeEffects: []
      }
      
      players.value.set(userId, player)
      currentFrame.value.set(userId, 0)
      frameTime.value.set(userId, 0)
      chargeFrame.value.set(userId, 0)
      
      debug.log(`🎮 Created remote player: ${userId}`)
    }
    
    // Update player state
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
}
</style>
