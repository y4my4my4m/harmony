/**
 * Centralized Voice & Video Settings Service
 * 
 * Manages device preferences and audio settings with localStorage persistence.
 * Used by both WebRTC services (P2P and LiveKit) and settings UI components.
 */

import { debug } from '@/utils/debug';
import { enumerateMediaDevices } from '@/utils/mediaDevices';
import { userStorage } from '@/utils/userScopedStorage';

const STORAGE_KEY = 'voice-settings';

export interface VoiceSettings {
  // Device IDs
  selectedInputDevice: string | null;
  selectedOutputDevice: string | null;
  selectedVideoDevice: string | null;
  
  // Volume levels (0-100)
  inputVolume: number;
  outputVolume: number;
  
  // Audio processing
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  
  // Video settings
  videoQuality: '480p' | '720p' | '1080p';
  frameRate: string;
  audioBitrate: string;
}

const DEFAULT_SETTINGS: VoiceSettings = {
  selectedInputDevice: null,
  selectedOutputDevice: null,
  selectedVideoDevice: null,
  inputVolume: 75,
  outputVolume: 75,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  videoQuality: '720p',
  frameRate: '30',
  audioBitrate: '128',
};

class VoiceSettingsServiceClass {
  private settings: VoiceSettings = { ...DEFAULT_SETTINGS };
  private listeners: Set<(settings: VoiceSettings) => void> = new Set();
  private initialized = false;
  
  constructor() {
    this.load();
  }
  
  /**
   * Load settings from localStorage
   */
  load(): VoiceSettings {
    try {
      const stored = userStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.settings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
        };
        debug.log('[VoiceSettings] Loaded settings:', this.settings);
      }
    } catch (error) {
      debug.warn('[VoiceSettings] Failed to load settings:', error);
      this.settings = { ...DEFAULT_SETTINGS };
    }
    this.initialized = true;
    return this.settings;
  }
  
  /**
   * Save settings to localStorage
   */
  private save(): void {
    try {
      userStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
      debug.log('[VoiceSettings] Saved settings');
      
      this.listeners.forEach(listener => listener(this.settings));
    } catch (error) {
      debug.warn('[VoiceSettings] Failed to save settings:', error);
    }
  }
  
  /**
   * Get all settings
   */
  getAll(): VoiceSettings {
    if (!this.initialized) {
      this.load();
    }
    return { ...this.settings };
  }
  
  /**
   * Get device settings only
   */
  getDevices(): { inputDevice: string | null; outputDevice: string | null; videoDevice: string | null } {
    return {
      inputDevice: this.settings.selectedInputDevice,
      outputDevice: this.settings.selectedOutputDevice,
      videoDevice: this.settings.selectedVideoDevice,
    };
  }
  
  /**
   * Get audio constraints
   */
  getAudioConstraints(): { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } {
    return {
      echoCancellation: this.settings.echoCancellation,
      noiseSuppression: this.settings.noiseSuppression,
      autoGainControl: this.settings.autoGainControl,
    };
  }
  
  /**
   * Update a single setting
   */
  update<K extends keyof VoiceSettings>(key: K, value: VoiceSettings[K]): void {
    this.settings[key] = value;
    this.save();
  }
  
  /**
   * Update multiple settings at once
   */
  updateMany(updates: Partial<VoiceSettings>): void {
    Object.assign(this.settings, updates);
    this.save();
  }
  
  /**
   * Set input device
   */
  setInputDevice(deviceId: string | null): void {
    this.settings.selectedInputDevice = deviceId;
    this.save();
    debug.log('[VoiceSettings] Input device set to:', deviceId);
  }
  
  /**
   * Set output device
   */
  setOutputDevice(deviceId: string | null): void {
    this.settings.selectedOutputDevice = deviceId;
    this.save();
    debug.log('[VoiceSettings] Output device set to:', deviceId);
  }
  
  /**
   * Set video device
   */
  setVideoDevice(deviceId: string | null): void {
    this.settings.selectedVideoDevice = deviceId;
    this.save();
    debug.log('[VoiceSettings] Video device set to:', deviceId);
  }
  
  /**
   * Set audio constraints
   */
  setAudioConstraints(constraints: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean }): void {
    if (constraints.echoCancellation !== undefined) {
      this.settings.echoCancellation = constraints.echoCancellation;
    }
    if (constraints.noiseSuppression !== undefined) {
      this.settings.noiseSuppression = constraints.noiseSuppression;
    }
    if (constraints.autoGainControl !== undefined) {
      this.settings.autoGainControl = constraints.autoGainControl;
    }
    this.save();
  }
  
  /**
   * Subscribe to settings changes
   */
  subscribe(callback: (settings: VoiceSettings) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  
  /**
   * Validate that a device ID still exists in the available devices
   */
  async validateDevices(): Promise<{ input: boolean; output: boolean; video: boolean }> {
    try {
      const devices = await enumerateMediaDevices();
      const inputDevices = devices.filter(d => d.kind === 'audioinput');
      const outputDevices = devices.filter(d => d.kind === 'audiooutput');
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      
      const inputValid = !this.settings.selectedInputDevice || 
        inputDevices.some(d => d.deviceId === this.settings.selectedInputDevice);
      const outputValid = !this.settings.selectedOutputDevice || 
        outputDevices.some(d => d.deviceId === this.settings.selectedOutputDevice);
      const videoValid = !this.settings.selectedVideoDevice || 
        videoDevices.some(d => d.deviceId === this.settings.selectedVideoDevice);
      
      if (!inputValid) {
        debug.warn('[VoiceSettings] Stored input device no longer exists, clearing');
        this.settings.selectedInputDevice = null;
        this.save();
      }
      if (!outputValid) {
        debug.warn('[VoiceSettings] Stored output device no longer exists, clearing');
        this.settings.selectedOutputDevice = null;
        this.save();
      }
      if (!videoValid) {
        debug.warn('[VoiceSettings] Stored video device no longer exists, clearing');
        this.settings.selectedVideoDevice = null;
        this.save();
      }
      
      return { input: inputValid, output: outputValid, video: videoValid };
    } catch (error) {
      debug.warn('[VoiceSettings] Failed to validate devices:', error);
      return { input: true, output: true, video: true }; // Assume valid on error
    }
  }
  
  /**
   * Get validated device IDs - returns null if device doesn't exist
   */
  async getValidatedDevices(): Promise<{ inputDevice: string | null; outputDevice: string | null; videoDevice: string | null }> {
    await this.validateDevices();
    return this.getDevices();
  }
  
  /**
   * Reset to default settings
   */
  reset(): void {
    this.settings = { ...DEFAULT_SETTINGS };
    this.save();
    debug.log('[VoiceSettings] Reset to defaults');
  }
}

// Singleton export
export const VoiceSettingsService = new VoiceSettingsServiceClass();
export default VoiceSettingsService;

