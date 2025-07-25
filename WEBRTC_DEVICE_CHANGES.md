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

Replace the `initializeLocalAudio()` method content (around line 609) with:

```typescript
private async initializeLocalAudio(): Promise<void> {
  try {
    const { inputDevice } = this.getSelectedDevices();
    
    // Build audio constraints with device selection
    const audioConstraints: MediaTrackConstraints = {
      ...this.audioConstraints
    };
    
    // Add device ID if specified
    if (inputDevice) {
      audioConstraints.deviceId = { exact: inputDevice };
      console.log('🎤 Using selected input device:', inputDevice);
    }
    
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false
    });
    
    this.localStream = stream;
    
    // Ensure audio track is enabled based on mute state
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !this.localMediaState.isMuted;
      // console.log('🎤 Audio track enabled:', audioTrack.enabled, 'muted:', this.localMediaState.isMuted);
    }
    
    this.setupAudioLevelMonitoring();
    
    // console.log('🎤 Local audio initialized with tracks:', {
    //   audioTracks: this.localStream.getAudioTracks().length,
    //   videoTracks: this.localStream.getVideoTracks().length,
    //   totalTracks: this.localStream.getTracks().length
    // });
    
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

Replace the getUserMedia call in `updateAudioConstraints()` method (around line 1240) with:

```typescript
// Get new audio stream with updated constraints and selected device
const { inputDevice } = this.getSelectedDevices();
const audioConstraints: MediaTrackConstraints = {
  ...this.audioConstraints
};

// Add device ID if specified
if (inputDevice) {
  audioConstraints.deviceId = { exact: inputDevice };
  console.log('🎤 Using selected input device for constraint update:', inputDevice);
}

const newAudioStream = await navigator.mediaDevices.getUserMedia({
  audio: audioConstraints,
  video: false
});
```

Also, you need to **remove the call to `this.loadDeviceSettings()`** from the constructor since we're now using the existing `loadAudioSettings()` method.

These changes will enable proper device switching that propagates to active WebRTC streams and peer connections.
