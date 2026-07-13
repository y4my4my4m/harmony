<template>
  <!--
    Wrapper span carries `icon icon-${name}` since pseudo-elements (::after/::before)
    don't render on SVG root elements; theme skins hide the SVG via visibility:hidden
    and paint a mask-image on this wrapper instead.
  -->
  <span :class="['icon-wrap', ...wrapperClass]" :style="wrapperStyle">
  <component
    v-if="lucideIcon && !useFilledSvg"
    :is="lucideIcon"
    :class="componentClass"
    :size="iconSize"
    :stroke-width="computedStrokeWidth"
    v-bind="extraAttrs"
  />
  <svg
    v-else-if="useFilledSvg"
    :class="svgClass"
    :width="iconSize"
    :height="iconSize"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <path :d="filledSvgPath" />
  </svg>
  <svg
    v-else
    :class="svgClass"
    :width="iconSize"
    :height="iconSize"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <!-- Volume Spatial (custom) -->
    <template v-if="name === 'volume-spatial'">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
      <circle cx="19" cy="9" r="2"></circle>
      <circle cx="17" cy="15" r="1.5"></circle>
      <circle cx="21" cy="15" r="1"></circle>
    </template>

    <!-- Mony Mascot (custom) -->
    <template v-if="name === 'mony-mascot'">
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-width="2" fill="none"/>
      <polygon
        points="12,6.5 18,12 12,17.5 6.5,12"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        opacity="0.85"
      />
    </template>

    <!-- Post (custom) -->
    <template v-if="name === 'post'">
      <rect x="4" y="4" width="16" height="16" rx="3" ry="3"></rect>
      <polyline points="16 20 20 20 20 16"></polyline>
      <polyline points="16 20 20 16"></polyline>
      <line x1="8" y1="9" x2="16" y2="9"></line>
      <line x1="8" y1="13" x2="16" y2="13"></line>
      <line x1="8" y1="17" x2="13" y2="17"></line>
    </template>

    <!-- Interaction (custom) -->
    <template v-if="name === 'interaction'">
      <path d="M7 17c-2-2-2-6 1-8 3-2 7 0 8 3"></path>
      <path d="M17 7c2 2 2 6-1 8-3 2-7 0-8-3"></path>
      <polyline points="7 17 7 21 11 21"></polyline>
      <polyline points="17 7 17 3 13 3"></polyline>
    </template>

    <!-- Unblock (custom) -->
    <template v-if="name === 'unblock'">
      <circle cx="12" cy="12" r="10"></circle>
      <path d="M8.5 8.5l7 7"></path>
      <path d="M15.5 8.5l-7 7"></path>
    </template>

    <!-- Headphones Off (no Lucide equivalent) -->
    <template v-if="name === 'headphones-off'">
      <line x1="1" y1="1" x2="23" y2="23"></line>
      <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zm-14 0a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"></path>
    </template>

    <!-- Wifi Low (custom composite) -->
    <template v-if="name === 'wifi-low'">
      <path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9z"></path>
      <path d="M5 13l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.24 9.24 8.76 9.24 5 13z"></path>
      <line x1="1" y1="1" x2="23" y2="23"></line>
    </template>

    <!-- GIF (custom, original design) -->
    <template v-if="name === 'gif'">
      <rect x="2" y="4" width="20" height="16" rx="3" ry="3"></rect>
      <text x="12" y="15.5" text-anchor="middle" font-size="8" font-weight="700" fill="currentColor" stroke="none" font-family="sans-serif">GIF</text>
    </template>

    <!-- Picture in Picture -->
    <template v-if="name === 'picture-in-picture'">
      <rect x="1" y="3" width="22" height="18" rx="2" ry="2"></rect>
      <rect x="12" y="9" width="9" height="7" rx="1"></rect>
    </template>

    <!-- Mentioned (dot indicators) -->
    <template v-if="name === 'mentioned'">
      <circle cx="12" cy="12" r="1" fill="currentColor"></circle>
      <circle cx="12" cy="5" r="1" fill="currentColor"></circle>
    </template>
  </svg>
  </span>
</template>

<script lang="ts">
import { defineComponent, computed, type Component } from 'vue';
import {
  Calendar, Copy, Ban, Camera, CameraOff, Video, VideoOff, Send, BellOff, ScreenShare,
  Headphones, Phone, PhoneOff, Smartphone, Tablet,
  Monitor, Laptop, MonitorSmartphone, Settings, Volume2, VolumeOff,
  Maximize2, X, LayoutGrid, List, Keyboard, Maximize, Minimize,
  Minimize2, User, Map, RefreshCw, Shuffle, CheckCircle2, Circle,
  AtSign, MessageCircle, Heart, MousePointer, Info, Music, Database,
  Download, Package, Smile, Inbox, BarChart2, Trash2, Terminal,
  LayoutDashboard, Users, Server, Mail, Activity, Search, Trash,
  Save, Shield, Key, ShieldOff, Gavel, RotateCcw, CornerDownRight,
  CornerDownLeft, MessageSquare, BotMessageSquare, ExternalLink, Eye, EyeOff,
  CircleAlert, Volume1, Loader, ToggleRight, Upload, ChevronUp,
  ChevronDown, Image, TriangleAlert, Home, Bookmark, Bell,
  ChevronsUpDown, Plus, Minus, XCircle, Lock, Globe, Unlock,
  UserPlus, Check, Loader2, SquarePen, Sparkles, Repeat,
  MoreHorizontal, Link, FileText, VolumeX, UserX, Flag,
  ChevronLeft, ChevronRight, ArrowLeft, ArrowRight, Play, Share2,
  UserCheck, Pencil, TrendingUp, TrendingDown, Compass, Hash,
  UserMinus, MoreVertical, Zap, Star, LogIn, LogOut, DoorOpen, ShieldCheck,
  Wifi, WifiOff, CircleHelp, Clock, Repeat2, Pin, PinOff,
  DollarSign, Layers, AudioLines, Megaphone, Wrench,
} from 'lucide-vue-next'

const ICON_MAP: Record<string, Component> = {
  'calendar': Calendar,
  'copy': Copy,
  'ban': Ban,
  'camera': Camera,
  'camera-off': CameraOff,
  'video': Video,
  'video-off': VideoOff,
  'send': Send,
  'bell-off': BellOff,
  'screen-share': ScreenShare,
  'headphones': Headphones,
  'phone': Phone,
  'phone-off': PhoneOff,
  'smartphone': Smartphone,
  'tablet': Tablet,
  'monitor': Monitor,
  'laptop': Laptop,
  'devices': MonitorSmartphone,
  'settings': Settings,
  'volume': Volume2,
  'volume-off': VolumeOff,
  'expand': Maximize2,
  'x': X,
  'close': X,
  'grid': LayoutGrid,
  'list': List,
  'keyboard': Keyboard,
  'maximize': Maximize,
  'maximize-2': Maximize2,
  'minimize': Minimize,
  'minimize-2': Minimize2,
  'user': User,
  'map': Map,
  'refresh': RefreshCw,
  'shuffle': Shuffle,
  'check-circle': CheckCircle2,
  'circle': Circle,
  'at-sign': AtSign,
  'message-circle': MessageCircle,
  'heart': Heart,
  'mouse-pointer': MousePointer,
  'info': Info,
  'music': Music,
  'volume-2': Volume2,
  'database': Database,
  'download': Download,
  'package-import': Package,
  'emoji': Smile,
  'inbox': Inbox,
  'bar-chart-2': BarChart2,
  'trash-2': Trash2,
  'admin-terminal': Terminal,
  'dashboard': LayoutDashboard,
  'users': Users,
  'server': Server,
  'message': Mail,
  'health': Activity,
  'activity': Activity,
  'search': Search,
  'suspend': Ban,
  'delete': Trash,
  'save': Save,
  'shield': Shield,
  'key': Key,
  'shield-off': ShieldOff,
  'gavel': Gavel,
  'rotate-ccw': RotateCcw,
  'corner-down-right': CornerDownRight,
  'corner-down-left': CornerDownLeft,
  'message-square': MessageSquare,
  'bot-message-square': BotMessageSquare,
  'external-link': ExternalLink,
  'eye': Eye,
  'eye-off': EyeOff,
  'alert-circle': CircleAlert,
  'volume-1': Volume1,
  'refresh-cw': RefreshCw,
  'loader': Loader,
  'toggle-right': ToggleRight,
  'upload': Upload,
  'chevron-up': ChevronUp,
  'chevron-down': ChevronDown,
  'image': Image,
  'smile': Smile,
  'alert-triangle': TriangleAlert,
  'home': Home,
  'bookmark': Bookmark,
  'bell': Bell,
  'chevron-up-down': ChevronsUpDown,
  'chevron-left-right': ChevronsUpDown,
  'plus': Plus,
  'minus': Minus,
  'x-circle': XCircle,
  'visibility': Eye,
  'lock': Lock,
  'globe': Globe,
  'federation': Globe,
  'unlock': Unlock,
  'user-plus': UserPlus,
  'mail': Mail,
  'check': Check,
  'spinner': Loader2,
  'edit': SquarePen,
  'sparkles': Sparkles,
  'reblog': Repeat2,
  'reply': MessageSquare,
  'more-horizontal': MoreHorizontal,
  'link': Link,
  'trash': Trash,
  'file': FileText,
  'volume-x': VolumeX,
  'user-x': UserX,
  'flag': Flag,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'play': Play,
  'share': Share2,
  'user-check': UserCheck,
  'pencil': Pencil,
  'thread': MessageSquare,
  'repeat': Repeat,
  'trending-up': TrendingUp,
  'trending-down': TrendingDown,
  'compass': Compass,
  'hash': Hash,
  'follow': UserPlus,
  'followed': UserCheck,
  'unfollow': UserMinus,
  'dots-vertical': MoreVertical,
  'dots-horizontal': MoreHorizontal,
  'mention': AtSign,
  'zap': Zap,
  'star': Star,
  'log-in': LogIn,
  'log-out': LogOut,
  'door-open': DoorOpen,
  'shield-check': ShieldCheck,
  'wifi': Wifi,
  'wifi-off': WifiOff,
  'help-circle': CircleHelp,
  'clock': Clock,
  'pin': Pin,
  'pin-off': PinOff,
  'dollar-sign': DollarSign,
  'layers': Layers,
  'audio-lines': AudioLines,
  'megaphone': Megaphone,
  'wrench': Wrench,
}

const FILLED_ICONS = new Set(['heart-filled', 'bookmark-filled'])

// Solid-shape SVG variants; mic/mic-off have no Lucide component and are always filled
const FILLED_SVG_ICONS = new Set(['music', 'activity', 'volume-2', 'headphones', 'mic', 'mic-off'])
const ALWAYS_FILLED_SVG = new Set(['mic', 'mic-off'])
const FILLED_SVG_PATHS: Record<string, string> = {
  'music': 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
  'activity': 'M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z',
  'volume-2': 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  'headphones': 'M12 1c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1c0-3.87 3.13-7 7-7s7 3.13 7 7v1h-4v8h4c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z',
  'mic': 'M12 2a4 4 0 0 0-4 4v5a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4m-7 8a1 1 0 0 1 1 1a6 6 0 0 0 12 0a1 1 0 1 1 2 0a8 8 0 0 1-7 7.938V21a1 1 0 1 1-2 0v-2.062A8 8 0 0 1 4 11a1 1 0 0 1 1-1',
  'mic-off': 'M8.953 3.409A4 4 0 0 1 16 6v3.343a1 1 0 1 1-2 0V6a2 2 0 0 0-3.524-1.295a1 1 0 0 1-1.524-1.296m5.336 9.465l-.04-.04L9.72 8.306l-.026-.026l-4.987-4.987a1 1 0 0 0-1.414 1.414L8 9.414V11a4 4 0 0 0 5.351 3.766l1.51 1.51A6 6 0 0 1 6 11a1 1 0 1 0-2-.001a8 8 0 0 0 7 7.938V21a1 1 0 1 0 2 0v-2.062a7.96 7.96 0 0 0 3.32-1.204l2.973 2.973a1 1 0 0 0 1.414-1.414l-3.559-3.56l-.034-.033zM19 10a1 1 0 0 1 1 1c0 .81-.12 1.593-.346 2.332a1 1 0 1 1-1.913-.582c.168-.553.259-1.14.259-1.75a1 1 0 0 1 1-1'
}

export default defineComponent({
  name: 'IconComponent',
  props: {
    name: {
      type: String,
      required: true
    },
    size: {
      type: [String, Number],
      default: 'md',
      validator: (value: string | number) => {
        if (typeof value === 'number') return value > 0 && value <= 128;
        if (typeof value === 'string') {
          if (['xs', 'sm', 'md', 'lg', 'xl'].includes(value)) return true;
          const num = parseInt(value, 10);
          return !isNaN(num) && num > 0 && num <= 128;
        }
        return false;
      }
    },
    strokeWidth: {
      type: Number,
      default: undefined
    },
    filled: {
      type: Boolean,
      default: false
    }
  },
  setup(props) {
    const iconSize = computed(() => {
      if (typeof props.size === 'number') return props.size;
      const num = parseInt(props.size, 10);
      if (!isNaN(num)) return num;
      const sizes: Record<string, number> = { xs: 12, sm: 16, md: 20, lg: 24, xl: 28 };
      return sizes[props.size] ?? 20;
    });

    // eslint-disable-next-line unused-imports/no-unused-vars
    const computedStrokeWidth = computed(() => props.strokeWidth ?? 2);

    const baseName = computed(() => {
      if (props.name === 'heart-filled') return 'heart';
      if (props.name === 'bookmark-filled') return 'bookmark';
      if (props.name === 'microphone') return 'mic';
      return props.name;
    });

    const lucideIcon = computed(() => {
      if (FILLED_SVG_ICONS?.has(baseName.value) && (props.filled || ALWAYS_FILLED_SVG?.has(baseName.value))) return null;
      return ICON_MAP[baseName.value] ?? null;
    });

    const useFilledSvg = computed(() =>
      (props.filled || ALWAYS_FILLED_SVG?.has(baseName.value)) && (FILLED_SVG_ICONS?.has(baseName.value) ?? false)
    );

    const filledSvgPath = computed(() =>
      useFilledSvg.value ? FILLED_SVG_PATHS[baseName.value] ?? '' : ''
    );

    const extraAttrs = computed(() => {
      // heart-filled and bookmark-filled use fill (Lucide Heart/Bookmark have fillable paths)
      if (FILLED_ICONS?.has(props.name)) {
        return {
          fill: 'currentColor',
          strokeWidth: 0,
          stroke: 'none'
        };
      }
      return {};
    });

    const effectiveStrokeWidth = computed(() => {
      if (FILLED_ICONS?.has(props.name)) return 0;
      return props.strokeWidth ?? 2;
    });

    const isFilledIcon = computed(() => props.filled || FILLED_ICONS.has(props.name));

    const componentClass = computed(() => {
      const classes: any[] = ['icon', `icon-${props.name}`];
      if (typeof props.size === 'string') classes.push(`icon-${props.size}`);
      classes.push({ 'icon-filled': isFilledIcon.value });
      return classes;
    });

    const svgClass = computed(() => {
      const classes = ['icon', `icon-${props.name}`];
      if (typeof props.size === 'string') classes.push(`icon-${props.size}`);
      return classes;
    });

    const wrapperClass = computed(() => {
      const classes = ['icon', `icon-${props.name}`];
      if (typeof props.size === 'string') classes.push(`icon-${props.size}`);
      return classes;
    });

    const wrapperStyle = computed(() => {
      // numeric sizes need explicit px on the wrapper for skin masks to size correctly
      if (typeof props.size === 'number') {
        return { width: `${props.size}px`, height: `${props.size}px` };
      }
      const parsed = parseInt(props.size as string, 10);
      if (!isNaN(parsed) && String(parsed) === props.size) {
        return { width: `${parsed}px`, height: `${parsed}px` };
      }
      return {};
    });

    return { iconSize, computedStrokeWidth: effectiveStrokeWidth, lucideIcon, extraAttrs, useFilledSvg, filledSvgPath, isFilledIcon, componentClass, svgClass, wrapperClass, wrapperStyle };
  }
});
</script>

<style scoped>
.icon-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  line-height: 0;
  /* Make pseudo-elements positionable for theme skins. */
  position: relative;
}

.icon-wrap > :deep(.icon) {
  display: block;
}

.icon {
  display: inline-block;
  vertical-align: middle;
  transition: all 0.2s ease;
}

.icon-xs { width: 12px; height: 12px; }
.icon-sm { width: 16px; height: 16px; }
.icon-md { width: 20px; height: 20px; }
.icon-lg { width: 24px; height: 24px; }
.icon-xl { width: 28px; height: 28px; }
</style>
