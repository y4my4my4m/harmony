<template>
  <component
    v-if="lucideIcon"
    :is="lucideIcon"
    :class="['icon', `icon-${name}`, { [`icon-${size}`]: typeof size === 'string' }]"
    :size="iconSize"
    :stroke-width="computedStrokeWidth"
    v-bind="extraAttrs"
  />
  <svg
    v-else
    :class="['icon', `icon-${name}`, { [`icon-${size}`]: typeof size === 'string' }]"
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
</template>

<script lang="ts">
import { defineComponent, computed, type Component } from 'vue';
import {
  Calendar, Copy, Ban, Camera, CameraOff, Send, BellOff, ScreenShare,
  Mic, MicOff, Headphones, Phone, PhoneOff, Smartphone, Tablet,
  Monitor, Laptop, MonitorSmartphone, Settings, Volume2, VolumeOff,
  Maximize2, X, LayoutGrid, List, Keyboard, Maximize, Minimize,
  Minimize2, User, Map, RefreshCw, Shuffle, CheckCircle2, Circle,
  AtSign, MessageCircle, Heart, MousePointer, Info, Music, Database,
  Download, Package, Smile, Inbox, BarChart2, Trash2, Terminal,
  LayoutDashboard, Users, Server, Mail, Activity, Search, Trash,
  Save, Shield, Key, ShieldOff, Gavel, RotateCcw, CornerDownRight,
  CornerDownLeft, MessageSquare, ExternalLink, Eye, EyeOff,
  CircleAlert, Volume1, Loader, ToggleRight, Upload, ChevronUp,
  ChevronDown, Image, TriangleAlert, Home, Bookmark, Bell,
  ChevronsUpDown, Plus, Minus, XCircle, Lock, Globe, Unlock,
  UserPlus, Check, Loader2, SquarePen, Sparkles, Repeat,
  MoreHorizontal, Link, FileText, VolumeX, UserX, Flag,
  ChevronLeft, ChevronRight, ArrowLeft, ArrowRight, Play, Share2,
  UserCheck, Pencil, TrendingUp, TrendingDown, Compass, Hash,
  UserMinus, MoreVertical, Zap, Star, LogIn, ShieldCheck,
  Wifi, WifiOff, CircleHelp, Clock, Repeat2,
} from 'lucide-vue-next'

const ICON_MAP: Record<string, Component> = {
  'calendar': Calendar,
  'copy': Copy,
  'ban': Ban,
  'camera': Camera,
  'camera-off': CameraOff,
  'send': Send,
  'bell-off': BellOff,
  'screen-share': ScreenShare,
  'mic': Mic,
  'mic-off': MicOff,
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
  'microphone': Mic,
  'dots-vertical': MoreVertical,
  'dots-horizontal': MoreHorizontal,
  'mention': AtSign,
  'zap': Zap,
  'star': Star,
  'log-in': LogIn,
  'shield-check': ShieldCheck,
  'wifi': Wifi,
  'wifi-off': WifiOff,
  'help-circle': CircleHelp,
  'clock': Clock,
}

const FILLED_ICONS = new Set(['heart-filled', 'bookmark-filled'])

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

    const computedStrokeWidth = computed(() => props.strokeWidth ?? 2);

    const baseName = computed(() => {
      if (props.name === 'heart-filled') return 'heart';
      if (props.name === 'bookmark-filled') return 'bookmark';
      return props.name;
    });

    const lucideIcon = computed(() => ICON_MAP[baseName.value] ?? null);

    const extraAttrs = computed(() => {
      if (FILLED_ICONS.has(props.name)) {
        return { fill: 'currentColor', stroke: 'none' };
      }
      return {};
    });

    return { iconSize, computedStrokeWidth, lucideIcon, extraAttrs };
  }
});
</script>

<style scoped>
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
