# WebRTC Device Management Changes

These are the changes needed to add device switching functionality to `unifiedWebRTC.ts`:

## 1. Update the existing `loadAudioSettings()` method

Replace the existing `loadAudioSettings()` method to also load device settings:

```typescript
private loadAudioSettings(): void {
  try {
    const stored = localStorage.getItem('harmony-voice-settings');
    if (stored) {
      const settings = JSON.parse(stored);
      
      // Load audio constraints
      if (settings.audioConstraints) {
        this.audioConstraints = {
          ...this.audioConstraints,
          ...settings.audioConstraints
        };
        console.log('🎛️ Loaded audio settings:', this.audioConstraints);
      }
      
      // Load device settings
      this.selectedInputDevice = settings.selectedInputDevice || null;
      this.selectedOutputDevice = settings.selectedOutputDevice || null;
      this.selectedVideoDevice = settings.selectedVideoDevice || null;
      console.log('🎛️ Loaded device settings:', {
        input: this.selectedInputDevice,
        output: this.selectedOutputDevice,
        video: this.selectedVideoDevice
      });
    }
  } catch (error) {
    console.warn('⚠️ Failed to load audio settings:', error);
  }
}
```

## 2. Update the existing `saveAudioSettings()` method

Replace the existing `saveAudioSettings()` method to also save device settings:

```typescript
private saveAudioSettings(): void {
  try {
    const existing = localStorage.getItem('harmony-voice-settings');
    const settings = existing ? JSON.parse(existing) : {};
    
    // Save audio constraints
    settings.audioConstraints = {
      echoCancellation: this.audioConstraints.echoCancellation,
      noiseSuppression: this.audioConstraints.noiseSuppression,
      autoGainControl: this.audioConstraints.autoGainControl
    };
    
    // Save device settings
    settings.selectedInputDevice = this.selectedInputDevice;
    settings.selectedOutputDevice = this.selectedOutputDevice;
    settings.selectedVideoDevice = this.selectedVideoDevice;
    
    localStorage.setItem('harmony-voice-settings', JSON.stringify(settings));
    console.log('💾 Saved audio and device settings');
  } catch (error) {
    console.warn('⚠️ Failed to save audio settings:', error);
  }
}
```

## 3. Add the `getSelectedDevices()` method

Add this new method in the "AUDIO SETTINGS MANAGEMENT" section:

```typescript
private getSelectedDevices(): { inputDevice?: string; outputDevice?: string; videoDevice?: string } {
  return {
    inputDevice: this.selectedInputDevice || undefined,
    outputDevice: this.selectedOutputDevice || undefined,
    videoDevice: this.selectedVideoDevice || undefined
  };
}
```

## 4. Add public device switching methods

Add these methods in the "PUBLIC API" section (after the existing toggle methods):

```typescript
/**
 * Update input device and restart audio stream
 */
async updateInputDevice(deviceId: string): Promise<void> {
  console.log('🎤 Updating input device to:', deviceId);
  
  this.selectedInputDevice = deviceId;
  this.saveAudioSettings(); // Use existing method
  
  // If we're currently connected, restart the audio stream with new device
  if (this.localStream && this.channelId) {
    const currentMuteState = this.localMediaState.isMuted;
    
    try {
      // Stop current audio tracks
      const audioTracks = this.localStream.getAudioTracks();
      audioTracks.forEach(track => {
        track.stop();
        this.localStream!.removeTrack(track);
      });
      
      // Get new audio stream with selected device
      const audioConstraints: MediaTrackConstraints = {
        ...this.audioConstraints,
        deviceId: { exact: deviceId }
      };
      
      const newAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      });
      
      const newAudioTrack = newAudioStream.getAudioTracks()[0];
      if (newAudioTrack) {
        // Add new track to local stream
        this.localStream.addTrack(newAudioTrack);
        
        // Apply current mute state
        newAudioTrack.enabled = !currentMuteState;
        
        // Update all peer connections with new audio track
        for (const [userId, conn] of this.connections) {
          try {
            const senders = conn.peerConnection.getSenders();
            const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
            
            if (audioSender) {
              await audioSender.replaceTrack(newAudioTrack);
              console.log('🔄 Replaced audio track for peer:', userId);
            }
          } catch (error) {
            console.error('❌ Error updating audio track for peer', userId, ':', error);
          }
        }
        
        // Restart audio level monitoring
        this.setupAudioLevelMonitoring();
        
        console.log('✅ Input device updated successfully');
        this.emit('local-stream-changed', this.localStream);
        this.emit('stream-changed', { userId: this.currentUserId, stream: this.localStream, type: 'local' });
      }
    } catch (error) {
      console.error('❌ Failed to update input device:', error);
      this.emit('error', error);
      throw error;
    }
  }
}

/**
 * Update output device for all remote audio elements
 */
async updateOutputDevice(deviceId: string): Promise<void> {
  console.log('🔊 Updating output device to:', deviceId);
  
  this.selectedOutputDevice = deviceId;
  this.saveAudioSettings(); // Use existing method
  
  // Update all existing audio elements to use new output device
  for (const [userId, connection] of this.connections) {
    if (connection.audioElement && connection.audioElement.setSinkId) {
      try {
        await connection.audioElement.setSinkId(deviceId);
        console.log('🔊 Updated output device for user:', userId);
      } catch (error) {
        console.error('❌ Failed to update output device for user:', userId, error);
      }
    }
  }
  
  console.log('✅ Output device updated successfully');
}

/**
 * Update video device and restart video stream if enabled
 */
async updateVideoDevice(deviceId: string): Promise<void> {
  console.log('🎥 Updating video device to:', deviceId);
  
  this.selectedVideoDevice = deviceId;
  this.saveAudioSettings(); // Use existing method
  
  // If video is currently enabled, restart with new device
  if (this.localMediaState.isVideoEnabled && this.localStream && this.channelId) {
    try {
      // Stop current video tracks
      const videoTracks = this.localStream.getVideoTracks();
      videoTracks.forEach(track => {
        track.stop();
        this.localStream!.removeTrack(track);
      });
      
      // Get new video stream with selected device
      const videoConstraints: any = {
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 60 }
        },
        audio: false
      };
      
      const newVideoStream = await navigator.mediaDevices.getUserMedia(videoConstraints);
      const newVideoTrack = newVideoStream.getVideoTracks()[0];
      
      if (newVideoTrack) {
        // Add new track to local stream
        this.localStream.addTrack(newVideoTrack);
        
        // Update all peer connections with new video track
        for (const [userId, conn] of this.connections) {
          try {
            const senders = conn.peerConnection.getSenders();
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');
            
            if (videoSender) {
              await videoSender.replaceTrack(newVideoTrack);
              console.log('🔄 Replaced video track for peer:', userId);
            }
          } catch (error) {
            console.error('❌ Error updating video track for peer', userId, ':', error);
          }
        }
        
        console.log('✅ Video device updated successfully');
        this.emit('local-stream-changed', this.localStream);
        this.emit('stream-changed', { userId: this.currentUserId, stream: this.localStream, type: 'local' });
      }
    } catch (error) {
      console.error('❌ Failed to update video device:', error);
      this.emit('error', error);
      throw error;
    }
  }
}
```

## 5. Update the `initializeLocalAudio()` method

Replace the `initializeLocalAudio()` method content (around line 755) with this version that includes fallback logic:

```typescript
private async initializeLocalAudio(): Promise<void> {
  try {
    const { inputDevice } = this.getSelectedDevices();
    
    // Build audio constraints with device selection
    const audioConstraints: MediaTrackConstraints = {
      ...this.audioConstraints
    };
    
    // Add device ID if specified, but use 'ideal' instead of 'exact' for graceful fallback
    if (inputDevice) {
      audioConstraints.deviceId = { ideal: inputDevice };
      console.log('🎤 Using selected input device:', inputDevice);
    }
    
    let stream: MediaStream;
    
    try {
      // Try with the selected device first
      stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      });
    } catch (error) {
      console.warn('⚠️ Failed to use selected device, falling back to default:', error);
      
      // Clear the invalid device ID and save
      this.selectedInputDevice = null;
      this.saveAudioSettings();
      
      // Fallback to default device (no deviceId constraint)
      const fallbackConstraints: MediaTrackConstraints = {
        ...this.audioConstraints
        // No deviceId - let browser choose
      };
      
      stream = await navigator.mediaDevices.getUserMedia({
        audio: fallbackConstraints,
        video: false
      });
      
      console.log('✅ Using default audio device as fallback');
    }
    
    this.localStream = stream;
    
    // Ensure audio track is enabled based on mute state
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !this.localMediaState.isMuted;
      // console.log('🎤 Audio track enabled:', audioTrack.enabled, 'muted:', this.localMediaState.isMuted);
    }
    
    this.setupAudioLevelMonitoring();
    
    // Emit initial local stream for UI
    this.emit('local-stream-changed', this.localStream);
    this.emit('stream-changed', { userId: this.currentUserId, stream: this.localStream, type: 'local' });
  } catch (error) {
    console.error('❌ Failed to get audio stream:', error);
    throw error;
  }
}
```

## 6. Update the `updateAudioConstraints()` method

Replace the getUserMedia call in `updateAudioConstraints()` method (around line 1240) with this version that includes fallback logic:

```typescript
// Get new audio stream with updated constraints and selected device
const { inputDevice } = this.getSelectedDevices();
const audioConstraints: MediaTrackConstraints = {
  ...this.audioConstraints
};

// Add device ID if specified, but use 'ideal' for graceful fallback
if (inputDevice) {
  audioConstraints.deviceId = { ideal: inputDevice };
  console.log('🎤 Using selected input device for constraint update:', inputDevice);
}

let newAudioStream: MediaStream;

try {
  // Try with the selected device first
  newAudioStream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
    video: false
  });
} catch (error) {
  console.warn('⚠️ Failed to use selected device during constraint update, falling back to default:', error);
  
  // Clear the invalid device ID and save
  this.selectedInputDevice = null;
  this.saveAudioSettings();
  
  // Fallback to default device
  const fallbackConstraints: MediaTrackConstraints = {
    ...this.audioConstraints
    // No deviceId - let browser choose
  };
  
  newAudioStream = await navigator.mediaDevices.getUserMedia({
    audio: fallbackConstraints,
    video: false
  });
  
  console.log('✅ Using default audio device as fallback during constraint update');
}
```

Also, you need to **remove the call to `this.loadDeviceSettings()`** from the constructor since we're now using the existing `loadAudioSettings()` method.

## Quick Fix for Current Issue

If you want to quickly fix the current issue without applying all changes, you can:

1. **Clear the invalid device settings** by running this in the browser console:
   ```javascript
   localStorage.removeItem('harmony-voice-settings');
   ```

2. **Or just change the deviceId constraint** in the current `initializeLocalAudio()` method from:
   ```typescript
   audioConstraints.deviceId = { exact: inputDevice };
   ```
   to:
   ```typescript
   audioConstraints.deviceId = { ideal: inputDevice };
   ```

The key changes that fix the issue:
- **Use `ideal` instead of `exact`** for device constraints (allows fallback)
- **Add try/catch around getUserMedia** to handle device failures gracefully
- **Clear invalid device IDs** when they fail so we don't keep trying them

These changes will enable proper device switching that propagates to active WebRTC streams and peer connections.
