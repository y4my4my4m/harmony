<template>
  <div class="new-profile-container">
    <!-- Animated background -->
    <div class="background-overlay">
      <div class="floating-particles">
        <div v-for="i in 12" :key="i" class="particle" :style="getParticleStyle(i)"></div>
      </div>
    </div>

    <!-- Main content -->
    <div class="profile-creation-card" data-testid="new-profile-card">
      <!-- Loading overlay -->
      <div v-if="isCreatingProfile" class="creation-loading-overlay">
        <div class="loading-content">
          <div class="harmony-spinner">
            <div class="spinner-ring"></div>
            <div class="spinner-ring"></div>
            <div class="spinner-ring"></div>
            <svg viewBox="0 0 24 24" class="harmony-logo">
              <path d="M12 2L2 7v10c0 5.55 3.84 9.74 9 11 5.16-1.26 9-5.45 9-11V7l-10-5z" fill="currentColor"/>
            </svg>
          </div>
          <p class="loading-text">{{ creationStep }}</p>
        </div>
      </div>

      <!-- Header section -->
      <div class="card-header">
        <div class="logo-section">
          <div class="logo-icon">
            <div class="icon-glow"></div>
            <svg viewBox="0 0 24 24" class="harmony-icon">
              <path d="M12 2L2 7v10c0 5.55 3.84 9.74 9 11 5.16-1.26 9-5.45 9-11V7l-10-5z" fill="currentColor"/>
            </svg>
          </div>
          <h1 class="welcome-title">Welcome to Harmony</h1>
          <p class="welcome-subtitle">Let's create your digital identity</p>
        </div>
        <div class="progress-indicator">
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: progressWidth }"></div>
          </div>
          <span class="progress-text">{{ currentStep }} of 3</span>
        </div>
      </div>

      <!-- Step content -->
      <div class="card-content">
        <!-- Step 1: Avatar -->
        <div v-if="currentStep === 1" class="step-content" key="step1" data-testid="profile-step-1">
          <div class="step-header">
            <h2>Choose Your Avatar</h2>
            <p>Upload a photo or use a default avatar</p>
          </div>
          
          <div class="avatar-section">
            <div class="avatar-upload-container">
              <div class="avatar-preview" @click="triggerAvatarUpload">
                <img v-if="avatarPreview" :src="avatarPreview" alt="Avatar preview" />
                <div v-else class="default-avatar">
                  <svg viewBox="0 0 24 24" class="avatar-icon">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor"/>
                  </svg>
                </div>
                <div class="upload-overlay">
                  <svg viewBox="0 0 24 24" class="upload-icon">
                    <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z" fill="currentColor"/>
                  </svg>
                  <span>{{ avatarPreview ? 'Change' : 'Upload' }}</span>
                </div>
              </div>
              <input 
                ref="avatarInput" 
                type="file" 
                accept="image/*" 
                @change="handleAvatarUpload" 
                class="file-input"
              />
            </div>
            <div class="avatar-options">
              <button class="option-btn" :class="{ active: !avatarFile }" @click="useDefaultAvatar" data-testid="avatar-use-default">
                Use Default
              </button>
              <button class="option-btn primary" @click="triggerAvatarUpload" data-testid="avatar-upload">
                Upload Image
              </button>
            </div>
          </div>
        </div>

        <!-- Step 2: Basic Info -->
        <div v-if="currentStep === 2" class="step-content" key="step2" data-testid="profile-step-2">
          <div class="step-header">
            <h2>Basic Information</h2>
            <p>Tell us about yourself</p>
          </div>

          <div class="form-section">
            <div class="input-group">
              <label class="input-label">Display Name</label>
              <div class="input-container">
                <input
                  v-model="displayName"
                  type="text"
                  class="modern-input"
                  placeholder="How others will see you"
                  maxlength="50"
                  data-testid="profile-display-name"
                  @input="validateDisplayName"
                />
                <div class="input-accent"></div>
              </div>
              <div class="input-feedback">
                <span class="char-count">{{ displayName.length }}/50</span>
                <span v-if="displayNameError" class="error-text">{{ displayNameError }}</span>
              </div>
            </div>

            <div class="input-group">
              <label class="input-label">Username</label>
              <div class="input-container username-container">
                <span class="username-prefix">@</span>
                <input
                  v-model="username"
                  type="text"
                  class="modern-input username-input"
                  placeholder="uniqueusername"
                  maxlength="24"
                  data-testid="profile-username"
                  @input="formatUsername"
                />
                <span class="username-suffix">@{{ domain }}</span>
                <div class="input-accent"></div>
              </div>
              <div class="input-feedback">
                <span class="char-count">{{ username.length }}/24</span>
                <span v-if="usernameError" class="error-text">{{ usernameError }}</span>
                <span v-else-if="checkingUsername" class="checking-text">Checking...</span>
                <span v-else-if="usernameAvailable" class="success-text" data-testid="username-available">✓ Available</span>
              </div>
            </div>

            <div class="input-group">
              <label class="input-label">About Me <span class="optional">(optional)</span></label>
              <div class="input-container">
                <textarea
                  v-model="bio"
                  class="modern-textarea"
                  placeholder="Tell others about yourself..."
                  maxlength="500"
                  rows="3"
                  data-testid="profile-bio"
                ></textarea>
                <div class="input-accent"></div>
              </div>
              <div class="input-feedback">
                <span class="char-count">{{ bio.length }}/500</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Step 3: Customization -->
        <div v-if="currentStep === 3" class="step-content" key="step3" data-testid="profile-step-3">
          <div class="step-header">
            <h2>Personalize Your Profile</h2>
            <p>Choose your signature color</p>
          </div>

          <div class="customization-section">
            <div class="profile-preview-card">
              <div class="preview-banner" :style="bannerPreviewStyle"></div>
              <div class="preview-content">
                <div class="preview-avatar">
                  <img v-if="avatarPreview" :src="avatarPreview" alt="Preview" />
                  <div v-else class="default-preview-avatar">
                    <svg viewBox="0 0 24 24">
                      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor"/>
                    </svg>
                  </div>
                </div>
                <div class="preview-info">
                  <h3 class="preview-display-name" :style="{ color: selectedColor }">
                    {{ displayName || 'Your Name' }}
                  </h3>
                  <p class="preview-username">{{ formattedUsername || '@username@' + domain }}</p>
                </div>
              </div>
            </div>

            <div class="color-picker-section">
              <label class="input-label">Profile Color</label>
              <ColorPicker
                :color="selectedColor"
                @update:color="selectedColor = $event"
                @change="selectedColor = $event"
              />
            </div>

            <div class="banner-upload-section">
              <label class="input-label">Profile Banner <span class="optional">(Optional)</span></label>
              <div class="banner-upload-container">
                <div class="banner-preview" @click="triggerBannerUpload">
                  <img v-if="bannerPreview" :src="bannerPreview" alt="Banner preview" />
                  <div v-else class="default-banner">
                    <svg viewBox="0 0 24 24" class="banner-icon">
                      <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z" fill="currentColor"/>
                    </svg>
                  </div>
                  <div class="upload-overlay">
                    <svg viewBox="0 0 24 24" class="upload-icon">
                      <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z" fill="currentColor"/>
                    </svg>
                    <span>{{ bannerPreview ? 'Change Banner' : 'Upload Banner' }}</span>
                  </div>
                </div>
                <input 
                  ref="bannerInput" 
                  type="file" 
                  accept="image/*" 
                  @change="handleBannerUpload" 
                  class="file-input"
                />
              </div>
              <div class="banner-options">
                <button class="option-btn" :class="{ active: !bannerFile }" @click="useDefaultBanner">
                  Use Color Only
                </button>
                <button class="option-btn primary" @click="triggerBannerUpload">
                  Upload Image
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Action buttons -->
      <div class="card-actions">
        <button 
          v-if="currentStep > 1" 
          @click="previousStep" 
          class="action-btn secondary"
          data-testid="profile-back-btn"
        >
          <svg viewBox="0 0 24 24" class="btn-icon">
            <path d="M20,11V13H8L13.5,18.5L12.08,19.92L4.16,12L12.08,4.08L13.5,5.5L8,11H20Z" fill="currentColor"/>
          </svg>
          Back
        </button>
        <button 
          @click="nextStep" 
          class="action-btn primary"
          :disabled="!canProceed || isCreatingProfile"
          data-testid="profile-next-btn"
        >
          {{ currentStep === 3 ? 'Create Profile' : 'Continue' }}
          <svg v-if="currentStep < 3" viewBox="0 0 24 24" class="btn-icon">
            <path d="M4,11V13H16L10.5,18.5L11.92,19.92L19.84,12L11.92,4.08L10.5,5.5L16,11H4Z" fill="currentColor"/>
          </svg>
          <svg v-else viewBox="0 0 24 24" class="btn-icon">
            <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { debug } from '@/utils/debug'
import { useProfileStore } from '@/stores/useProfile';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import { useToast } from 'vue-toastification';
import { uploadAvatar, downloadAndUploadImage } from '@/utils/fileUpload';
import { uploadBanner } from '@/utils/bannerUtils';
import { supabase } from '@/supabase';
import ColorPicker from '@/components/common/ColorPicker.vue';

const username = ref('');
const displayName = ref('');
const bio = ref('');
const currentStep = ref(1);
const avatarFile = ref<File | null>(null);
const avatarPreview = ref<string | null>(null);
const bannerFile = ref<File | null>(null);
const bannerPreview = ref<string | null>(null);
const selectedColor = ref('#0EA5E9');
const usernameError = ref('');
const displayNameError = ref('');
const usernameAvailable = ref(false);
const checkingUsername = ref(false);
const isCreatingProfile = ref(false);
const creationStep = ref('');

const domain = import.meta.env.VITE_DOMAIN;
const profileStore = useProfileStore();
const authStore = useAuthStore();
const router = useRouter();
const toast = useToast();

const avatarInput = ref<HTMLInputElement>();
const bannerInput = ref<HTMLInputElement>();

let usernameCheckTimeout: NodeJS.Timeout | null = null;

// Extract OAuth provider data and auto-populate form
onMounted(async () => {
  try {
    const session = authStore.session
    if (!session?.user) return

    const user = session.user
    const metadata = user.user_metadata || {}
    const identities = user.identities || []
    
    // Available OAuth providers (should match AuthComponent.vue)
    const OAUTH_PROVIDERS = ['google', 'github', 'twitch'] as const
    
    // Find OAuth identity (not email provider)
    const oauthIdentity = identities.find((id: any) => 
      id.provider !== 'email' && OAUTH_PROVIDERS.includes(id.provider as typeof OAUTH_PROVIDERS[number])
    )

    if (!oauthIdentity) {
      debug.log('No OAuth identity found, using defaults')
      return
    }

    debug.log('🔐 Extracting OAuth data from provider:', oauthIdentity.provider)

    // Extract avatar from user_metadata (Supabase automatically fetches this from OAuth providers)
    if (metadata.avatar_url) {
      avatarPreview.value = metadata.avatar_url
      debug.log('✅ Auto-populated avatar from OAuth:', metadata.avatar_url)
    } else if (metadata.picture) {
      // Some providers use 'picture' instead of 'avatar_url'
      avatarPreview.value = metadata.picture
      debug.log('✅ Auto-populated avatar from OAuth (picture):', metadata.picture)
    }

    // Extract display name
    if (metadata.full_name) {
      displayName.value = metadata.full_name
      debug.log('✅ Auto-populated display name:', metadata.full_name)
    } else if (metadata.name) {
      displayName.value = metadata.name
      debug.log('✅ Auto-populated display name (name):', metadata.name)
    } else if (metadata.preferred_username) {
      // Fallback to username if no name available
      displayName.value = metadata.preferred_username
      debug.log('✅ Auto-populated display name (preferred_username):', metadata.preferred_username)
    }

    // Extract username
    // Try different possible fields from OAuth providers
    let suggestedUsername = ''
    if (metadata.preferred_username) {
      suggestedUsername = metadata.preferred_username.toLowerCase().replace(/[^a-z0-9_]/g, '')
    } else if (metadata.user_name) {
      suggestedUsername = metadata.user_name.toLowerCase().replace(/[^a-z0-9_]/g, '')
    } else if (metadata.username) {
      suggestedUsername = metadata.username.toLowerCase().replace(/[^a-z0-9_]/g, '')
    } else if (metadata.login) {
      // GitHub uses 'login'
      suggestedUsername = metadata.login.toLowerCase().replace(/[^a-z0-9_]/g, '')
    } else if (user.email) {
      // Fallback: use email username part
      const emailUsername = user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '')
      suggestedUsername = emailUsername
    }

    if (suggestedUsername && suggestedUsername.length >= 3) {
      username.value = suggestedUsername
      // Trigger username availability check
      formatUsername({ target: { value: suggestedUsername } } as any)
      debug.log('✅ Auto-populated username:', suggestedUsername)
    }

    // Extract bio if available (some providers might have this)
    if (metadata.bio || metadata.description) {
      bio.value = (metadata.bio || metadata.description).substring(0, 500)
      debug.log('✅ Auto-populated bio')
    }

    debug.log('✅ OAuth data extraction complete', {
      provider: oauthIdentity.provider,
      hasAvatar: !!avatarPreview.value,
      hasDisplayName: !!displayName.value,
      hasUsername: !!username.value
    })

  } catch (error) {
    debug.error('Failed to extract OAuth data:', error)
    // Don't block profile creation if OAuth extraction fails
  }
})

// Computed properties
const progressWidth = computed(() => `${(currentStep.value / 3) * 100}%`);

const formattedUsername = computed(() => {
  return username.value ? `@${username.value}@${domain}` : '';
});

const canProceed = computed(() => {
  switch (currentStep.value) {
    case 1: return true; // Avatar is optional
    case 2: return displayName.value.trim() && username.value.trim() && !usernameError.value && !displayNameError.value && usernameAvailable.value && !checkingUsername.value;
    case 3: return true;
    default: return false;
  }
});

const bannerPreviewStyle = computed(() => {
  if (bannerPreview.value) {
    return {
      backgroundImage: `url(${bannerPreview.value})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat'
    }
  }
  return {
    background: selectedColor.value
  }
});

// Methods
const getParticleStyle = (index: number) => {
  const delay = index * 0.5;
  const duration = 3 + (index % 3);
  return {
    animationDelay: `${delay}s`,
    animationDuration: `${duration}s`,
    left: `${(index * 8.33) % 100}%`,
    top: `${(index * 13) % 100}%`
  };
};

const triggerAvatarUpload = () => {
  avatarInput.value?.click();
};

const handleAvatarUpload = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  
  if (file) {
    if (file.size > 5 * 1024 * 1024) { // 5MB limit
      toast.error('File size must be less than 5MB');
      return;
    }
    
    avatarFile.value = file;
    const reader = new FileReader();
    reader.onload = (e) => {
      avatarPreview.value = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  }
};

const useDefaultAvatar = () => {
  avatarFile.value = null;
  avatarPreview.value = null;
};

const triggerBannerUpload = () => {
  bannerInput.value?.click();
};

const handleBannerUpload = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  
  if (file) {
    if (file.size > 10 * 1024 * 1024) { // 10MB limit for banners
      toast.error('Banner file size must be less than 10MB');
      return;
    }
    
    bannerFile.value = file;
    const reader = new FileReader();
    reader.onload = (e) => {
      bannerPreview.value = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  }
};

const useDefaultBanner = () => {
  bannerFile.value = null;
  bannerPreview.value = null;
};

const checkUsernameAvailability = async (usernameToCheck: string) => {
  if (usernameToCheck.length < 3) {
    return;
  }

  checkingUsername.value = true;
  usernameAvailable.value = false;

  try {
    // Check if username exists in database
    const { data, error } = await supabase
      .from('profiles')
      .select('username')
      .eq('username', usernameToCheck.toLowerCase())
      .maybeSingle();

    if (error) {
      debug.error('Error checking username availability:', error);
      usernameError.value = 'Error checking username availability';
      checkingUsername.value = false;
      return;
    }

    if (data) {
      // Username already exists
      usernameError.value = 'Username is already taken';
      usernameAvailable.value = false;
    } else {
      // Username is available
      usernameError.value = '';
      usernameAvailable.value = true;
    }
  } catch (error) {
    debug.error('Exception checking username:', error);
    usernameError.value = 'Error checking username availability';
  } finally {
    checkingUsername.value = false;
  }
};

const formatUsername = (event: Event) => {
  const target = event.target as HTMLInputElement;
  let value = target.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
  
  username.value = value;
  usernameAvailable.value = false;
  
  // Clear any existing timeout
  if (usernameCheckTimeout) {
    clearTimeout(usernameCheckTimeout);
  }
  
  // Validate username format
  if (value.length < 3 && value.length > 0) {
    usernameError.value = 'Username must be at least 3 characters';
    checkingUsername.value = false;
    return;
  } else if (value.length === 0) {
    usernameError.value = 'Username is required';
    checkingUsername.value = false;
    return;
  }
  
  // Debounce the availability check
  usernameError.value = '';
  checkingUsername.value = true;
  usernameCheckTimeout = setTimeout(() => {
    checkUsernameAvailability(value);
  }, 500);
};

const validateDisplayName = () => {
  if (displayName.value.trim().length < 1) {
    displayNameError.value = 'Display name is required';
  } else if (displayName.value.trim().length > 50) {
    displayNameError.value = 'Display name is too long';
  } else {
    displayNameError.value = '';
  }
};

const nextStep = async () => {
  if (currentStep.value < 3) {
    currentStep.value++;
  } else {
    await createProfile();
  }
};

const previousStep = () => {
  if (currentStep.value > 1) {
    currentStep.value--;
  }
};

const createProfile = async () => {
  if (!authStore.session?.user) {
    toast.error('Authentication required');
    return;
  }

  // Set loading state
  isCreatingProfile.value = true;
  creationStep.value = 'Creating profile...';

  // Add loading state and better error handling
  try {
    debug.log('Creating profile with data:', {
      id: authStore.session.user.id,
      username: username.value.trim().toLowerCase(),
      display_name: displayName.value.trim(),
      bio: bio.value.trim() || null,
      color: selectedColor.value,
    });

    // Get instance domain from config
    creationStep.value = 'Configuring instance...';
    const { data: instanceConfig } = await supabase
      .from('instance_config')
      .select('config_value')
      .eq('config_key', 'domain')
      .maybeSingle();
    
    const instanceDomain = instanceConfig?.config_value 
      ? (typeof instanceConfig.config_value === 'string' 
          ? instanceConfig.config_value 
          : instanceConfig.config_value.toString().replace(/"/g, ''))
      : 'localhost';

    const profileData = {
      id: authStore.session.user.id, // Keep using auth user ID as profile ID for compatibility
      auth_user_id: authStore.session.user.id, // Also set the new auth_user_id field
      username: username.value.trim().toLowerCase(),
      display_name: displayName.value.trim(),
      bio: bio.value.trim() || undefined,
      color: selectedColor.value,
      is_local: true, // This is a local user
      domain: instanceDomain, // Get from instance config
      federated_id: `https://${instanceDomain}/users/${username.value.trim().toLowerCase()}`, // Set federated_id directly
      inbox_url: `https://${instanceDomain}/users/${username.value.trim().toLowerCase()}/inbox`,
      outbox_url: `https://${instanceDomain}/users/${username.value.trim().toLowerCase()}/outbox`,
      followers_url: `https://${instanceDomain}/users/${username.value.trim().toLowerCase()}/followers`,
      following_url: `https://${instanceDomain}/users/${username.value.trim().toLowerCase()}/following`,
    };

    debug.log('Calling profileStore.createProfile...');
    creationStep.value = 'Setting up your profile...';
    const result = await profileStore.createProfile(profileData);
    debug.log('Profile creation result:', result);
    
    // Generate ActivityPub keys for federation
    // This ensures the user is immediately ready for federation (can be followed, etc.)
    creationStep.value = 'Generating federation keys...';
    try {
      // Use relative URL - federation backend is proxied through the same domain
      const keyGenResponse = await fetch('/api/federation/generate-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: authStore.session.user.id }),
      });
      
      if (keyGenResponse.ok) {
        const keyGenResult = await keyGenResponse.json();
        debug.log('✅ Federation keys generated:', keyGenResult);
      } else {
        const errorData = await keyGenResponse.json().catch(() => ({}));
        debug.warn('⚠️ Failed to generate federation keys:', errorData);
        // Don't fail profile creation - keys can be generated later when needed
      }
    } catch (keyGenError) {
      debug.warn('⚠️ Federation key generation error (non-fatal):', keyGenError);
      // Don't fail profile creation - the Actor endpoint will generate keys on-the-fly
    }
    
    // Handle avatar: upload file if exists, or use OAuth avatar URL if available
    if (avatarFile.value && result) {
      // User uploaded a file - upload it
      debug.log('Uploading avatar...');
      creationStep.value = 'Uploading avatar...';
      try {
        const uploadResult = await uploadAvatar(avatarFile.value, authStore.session.user.id);
        
        if (uploadResult.success && uploadResult.url) {
          const { normalizeAvatarForStorage } = await import('@/utils/avatarUtils');
          const normalizedPath = normalizeAvatarForStorage(uploadResult.url) || uploadResult.url;
          await profileStore.updateProfile({
            avatar_url: normalizedPath
          });
          debug.log('Avatar uploaded successfully:', normalizedPath);
        } else {
          debug.error('Avatar upload failed:', uploadResult.error);
          toast.warning(`Profile created, but the avatar couldn't be uploaded: ${uploadResult.error || 'unknown error'}. You can update it later in settings.`);
        }
      } catch (uploadError) {
        debug.error('Avatar upload error:', uploadError);
        toast.warning('Profile created but avatar upload failed. You can update it later in settings.');
      }
    } else if (avatarPreview.value && !avatarFile.value && result && authStore.session?.user?.id) {
      // OAuth avatar URL - download and upload to Supabase storage
      debug.log('Downloading and uploading OAuth avatar...');
      creationStep.value = 'Setting up avatar...';
      try {
        const uploadResult = await downloadAndUploadImage(
          avatarPreview.value,
          authStore.session.user.id,
          'avatar'
        );
        
        if (uploadResult.success && uploadResult.url) {
          // Normalize the URL for storage (convert public URL to storage path if needed)
          const { normalizeAvatarForStorage } = await import('@/utils/avatarUtils');
          const normalizedPath = normalizeAvatarForStorage(uploadResult.url) || uploadResult.url;
          
          await profileStore.updateProfile({
            avatar_url: normalizedPath
          });
          debug.log('✅ OAuth avatar uploaded successfully:', normalizedPath);
        } else {
          debug.error('OAuth avatar upload failed:', uploadResult.error);
          toast.warning('Profile created but avatar upload failed. You can update it later in settings.');
        }
      } catch (avatarError) {
        debug.error('Failed to download/upload OAuth avatar:', avatarError);
        toast.warning('Profile created but avatar setup failed. You can update it later in settings.');
      }
    }

    // Handle banner upload if file exists
    if (bannerFile.value && result) {
      debug.log('Uploading banner...');
      creationStep.value = 'Uploading banner...';
      try {
        const uploadResult = await uploadBanner(bannerFile.value, authStore.session.user.id);
        
        if (uploadResult.success && uploadResult.url) {
          // Update profile with banner URL only
          await profileStore.updateProfile({
            banner_url: uploadResult.url
          });
          debug.log('Banner uploaded successfully:', uploadResult.url);
        } else {
          debug.error('Banner upload failed:', uploadResult.error);
          toast.warning('Profile created but banner upload failed. You can update it later in settings.');
        }
      } catch (uploadError) {
        debug.error('Banner upload error:', uploadError);
        toast.warning('Profile created but banner upload failed. You can update it later in settings.');
      }
    }

    // Update userDataService with the new profile data to prevent "Unknown" user display
    creationStep.value = 'Finalizing...';
    try {
      const { useUserData } = await import('@/composables/useUserData');
      const userData = useUserData();
      
      // Force refresh the user profile from database to get the latest data
      await userData.fetchUserProfile(authStore.session.user.id, true);
      
      // Re-initialize userDataService with the new profile data to ensure proper state
      await userData.initialize(
        authStore.session.user.id,
        username.value,
        avatarFile.value ? undefined : '/default_avatar.webp'
      );
      
      // Also update with the current form data to ensure immediate UI updates
      await userData.updateCurrentUserProfile({
        displayName: displayName.value.trim(),
        bio: bio.value.trim() || undefined,
        color: selectedColor.value
      });
      
      debug.log('✅ UserDataService updated and re-initialized with new profile data');
    } catch (updateError) {
      debug.warn('⚠️ Failed to update userDataService, but profile was created successfully:', updateError);
    }

    toast.success('Welcome to Harmony! Your profile has been created.');
    debug.log('Navigating to /chat...');
    await router.push('/chat');
  } catch (error: any) {
    debug.error('Profile creation error:', error);
    
    // More detailed error messaging
    let errorMessage = 'Failed to create profile';
    
    if (error.message) {
      errorMessage = error.message;
    } else if (error.code) {
      switch (error.code) {
        case '23505':
          errorMessage = 'Username already exists. Please choose a different username.';
          break;
        case '23502':
          errorMessage = 'Missing required information. Please fill in all required fields.';
          break;
        default:
          errorMessage = `Database error: ${error.code}`;
      }
    }
    
    toast.error(errorMessage);
  } finally {
    isCreatingProfile.value = false;
    creationStep.value = '';
  }
};
</script>

<style scoped>
.new-profile-container {
  min-height: 100vh;
  background: linear-gradient(135deg, #1e1f22 0%, #2b2d31 50%, #1e1f22 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  position: relative;
  overflow-x: hidden;
  overflow-y: auto;
  width: 100%;
}

.background-overlay {
  position: absolute;
  inset: 0;
  opacity: 0.3;
  overflow: hidden;
}

.floating-particles {
  position: absolute;
  width: 100%;
  height: 100%;
}

.particle {
  position: absolute;
  width: 4px;
  height: 4px;
  background: linear-gradient(45deg, #0EA5E9, #00d4ff);
  border-radius: 50%;
  animation: float infinite ease-in-out;
  box-shadow: 0 0 10px rgba(14, 165, 233, 0.5);
}

@keyframes float {
  0%, 100% { transform: translateY(0) rotate(0deg); opacity: 0; }
  50% { transform: translateY(-20px) rotate(180deg); opacity: 1; }
}

.profile-creation-card {
  background: rgba(47, 49, 54, 0.95);
  backdrop-filter: blur(20px);
  border-radius: 24px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 
    0 32px 64px rgba(0, 0, 0, 0.4),
    0 0 0 1px rgba(255, 255, 255, 0.05),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  width: 100%;
  max-width: 500px;
  max-height: 95vh;
  padding: 40px;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.profile-creation-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(14, 165, 233, 0.5), transparent);
}

/* Loading Overlay */
.creation-loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(47, 49, 54, 0.98);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  border-radius: 24px;
}

.loading-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
}

.harmony-spinner {
  position: relative;
  width: 100px;
  height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.spinner-ring {
  position: absolute;
  width: 100%;
  height: 100%;
  border: 3px solid transparent;
  border-radius: 50%;
  animation: spin-ring 2s linear infinite;
}

.spinner-ring:nth-child(1) {
  border-top-color: #0EA5E9;
  animation-duration: 1.5s;
}

.spinner-ring:nth-child(2) {
  border-right-color: #38BDF8;
  animation-duration: 2s;
  animation-direction: reverse;
}

.spinner-ring:nth-child(3) {
  border-bottom-color: #00d4ff;
  animation-duration: 2.5s;
}

@keyframes spin-ring {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.harmony-logo {
  width: 40px;
  height: 40px;
  color: var(--text-primary);
  filter: drop-shadow(0 0 10px rgba(14, 165, 233, 0.5));
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.6; transform: scale(0.95); }
  50% { opacity: 1; transform: scale(1.05); }
}

.loading-text {
  font-size: 18px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0;
  animation: fade-in-out 2s ease-in-out infinite;
}

@keyframes fade-in-out {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

.card-header {
  text-align: center;
  margin-bottom: 40px;
  flex-shrink: 0;
}

.logo-section {
  margin-bottom: 24px;
}

.logo-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  margin: 0 auto 16px;
}

.icon-glow {
  position: absolute;
  inset: -8px;
  background: conic-gradient(from 180deg, #0EA5E9, #00d4ff, #0EA5E9);
  border-radius: 50%;
  animation: spin 3s linear infinite;
  opacity: 0.7;
}

.harmony-icon {
  position: relative;
  width: 40px;
  height: 40px;
  color: var(--text-primary);
  background: linear-gradient(135deg, #0EA5E9, #38BDF8);
  padding: 12px;
  border-radius: 50%;
  z-index: 1;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.welcome-title {
  font-size: 32px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 8px;
  background: linear-gradient(135deg, #ffffff, var(--text-secondary));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.welcome-subtitle {
  font-size: 16px;
  color: var(--text-secondary);
  margin: 0;
}

.progress-indicator {
  display: flex;
  align-items: center;
  gap: 12px;
}

.progress-bar {
  flex: 1;
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #0EA5E9, #38BDF8);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.progress-text {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 500;
}

.card-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
  margin-right: -4px;
}

.card-content::-webkit-scrollbar {
  width: 6px;
}

.card-content::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 3px;
}

.card-content::-webkit-scrollbar-thumb {
  background: rgba(14, 165, 233, 0.5);
  border-radius: 3px;
}

.card-content::-webkit-scrollbar-thumb:hover {
  background: rgba(14, 165, 233, 0.7);
}

.step-content {
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

.step-header {
  text-align: center;
  margin-bottom: 32px;
}

.step-header h2 {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.step-header p {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.avatar-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
}

.avatar-upload-container {
  position: relative;
}

.avatar-preview {
  width: 120px;
  height: 120px;
  border-radius: 50%;
  border: 4px solid rgba(14, 165, 233, 0.3);
  overflow: hidden;
  cursor: pointer;
  position: relative;
  background: linear-gradient(135deg, var(--background-secondary), var(--background-tertiary));
  transition: all 0.3s ease;
}

.avatar-preview:hover {
  border-color: #0EA5E9;
  transform: scale(1.05);
}

.avatar-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.default-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--text-secondary);
}

.avatar-icon {
  width: 48px;
  height: 48px;
}

.upload-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.3s ease;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 500;
  gap: 4px;
}

.avatar-preview:hover .upload-overlay {
  opacity: 1;
}

.upload-icon {
  width: 20px;
  height: 20px;
}

.file-input {
  display: none;
}

.avatar-options {
  display: flex;
  gap: 12px;
}

.option-btn {
  padding: 12px 24px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-secondary);
  border-radius: 12px;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.3s ease;
}

.option-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
}

.option-btn.active {
  background: rgba(14, 165, 233, 0.2);
  border-color: #0EA5E9;
  color: var(--text-primary);
}

.option-btn.primary {
  background: linear-gradient(135deg, #0EA5E9, #38BDF8);
  border-color: transparent;
  color: var(--text-primary);
}

.option-btn.primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 25px rgba(14, 165, 233, 0.3);
}

/* Banner Upload Styles */
.banner-upload-section {
  margin-top: 32px;
}

.banner-upload-container {
  display: flex;
  justify-content: center;
  margin: 16px 0;
}

.banner-preview {
  width: 300px;
  height: 100px;
  border: 2px dashed rgba(255, 255, 255, 0.3);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.3s ease;
  position: relative;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.02);
  display: flex;
  align-items: center;
  justify-content: center;
}

.banner-preview:hover {
  border-color: #0EA5E9;
  background: rgba(14, 165, 233, 0.1);
}

.banner-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 8px;
}

.default-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: rgba(255, 255, 255, 0.4);
}

.banner-icon {
  width: 32px;
  height: 32px;
  color: rgba(255, 255, 255, 0.4);
}

.banner-preview .upload-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.3s ease;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
}

.banner-preview:hover .upload-overlay {
  opacity: 1;
}

.banner-preview .upload-overlay .upload-icon {
  width: 24px;
  height: 24px;
  margin-bottom: 8px;
}

.banner-options {
  display: flex;
  gap: 12px;
  justify-content: center;
}

.optional {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  font-weight: normal;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.input-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.optional {
  font-weight: 400;
  color: var(--text-secondary);
  font-size: 12px;
}

.input-container {
  position: relative;
}

.modern-input,
.modern-textarea {
  width: 100%;
  padding: 16px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  color: var(--text-primary);
  font-size: 16px;
  transition: all 0.3s ease;
  box-sizing: border-box;
}

.modern-input:focus,
.modern-textarea:focus {
  outline: none;
  border-color: #0EA5E9;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.1);
}

.modern-input::placeholder,
.modern-textarea::placeholder {
  color: var(--text-muted);
}

.input-accent {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  background: linear-gradient(90deg, #0EA5E9, #38BDF8);
  border-radius: 1px;
  width: 0;
  transition: width 0.3s ease;
}

.modern-input:focus + .input-accent,
.modern-textarea:focus + .input-accent {
  width: 100%;
}

.username-container {
  display: flex;
  align-items: center;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 16px;
  transition: all 0.3s ease;
}

.username-container:focus-within {
  border-color: #0EA5E9;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.1);
}

.username-prefix,
.username-suffix {
  color: var(--text-muted);
  font-weight: 500;
  white-space: nowrap;
}

.username-input {
  flex: 1;
  background: transparent;
  border: none;
  padding: 0 8px;
  min-width: 0;
}

.username-input:focus {
  outline: none;
  box-shadow: none;
}

.input-feedback {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 20px;
}

.char-count {
  font-size: 12px;
  color: var(--text-muted);
}

.error-text {
  font-size: 12px;
  color: #ed4245;
  font-weight: 500;
}

.success-text {
  font-size: 12px;
  color: #00d166;
  font-weight: 500;
}

.checking-text {
  font-size: 12px;
  color: #f0b232;
  font-weight: 500;
}

.customization-section {
  display: flex;
  flex-direction: column;
  gap: 32px;
}

.profile-preview-card {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.preview-banner {
  height: 80px;
  background: linear-gradient(135deg, #0EA5E9, #38BDF8);
}

.preview-content {
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: -32px;
  position: relative;
}

.preview-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 4px solid rgba(47, 49, 54, 1);
  overflow: hidden;
  background: var(--background-secondary);
  flex-shrink: 0;
}

.preview-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.default-preview-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--text-secondary);
}

.default-preview-avatar svg {
  width: 32px;
  height: 32px;
}

.preview-info {
  flex: 1;
}

.preview-display-name {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 4px;
  color: #0EA5E9;
}

.preview-username {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.color-picker-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.color-options {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 12px;
}

.color-option {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.3s ease;
  position: relative;
}

.color-option:hover {
  transform: scale(1.1);
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
}

.color-option.active {
  border-color: var(--text-primary);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.3);
}

.custom-color {
  background: linear-gradient(135deg, #ff6b6b, #4ecdc4, #45b7d1, #96ceb4, #feca57);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
}

.plus-icon {
  width: 20px;
  height: 20px;
}

.hidden-color-input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.card-actions {
  display: flex;
  gap: 16px;
  margin-top: 40px;
  flex-shrink: 0;
}

.action-btn {
  flex: 1;
  padding: 16px 24px;
  border: none;
  border-radius: 12px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  position: relative;
  overflow: hidden;
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn.secondary {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-secondary);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.action-btn.secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.action-btn.primary {
  background: linear-gradient(135deg, #0EA5E9, #38BDF8);
  color: var(--text-primary);
  box-shadow: 0 4px 15px rgba(14, 165, 233, 0.3);
}

.action-btn.primary:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 8px 25px rgba(14, 165, 233, 0.4);
}

.action-btn.primary::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.1), transparent);
  opacity: 0;
  transition: opacity 0.3s ease;
}

.action-btn.primary:hover::before {
  opacity: 1;
}

.btn-icon {
  width: 18px;
  height: 18px;
}

@media (max-width: 768px) {
  .new-profile-container {
    padding: 12px;
    align-items: flex-start;
    padding-top: 20px;
  }
  
  .profile-creation-card {
    padding: 24px;
    max-width: 100%;
    max-height: 96vh;
  }
  
  .welcome-title {
    font-size: 24px;
  }
  
  .color-options {
    grid-template-columns: repeat(6, 1fr);
  }
  
  .color-option {
    width: 36px;
    height: 36px;
  }

  .card-header {
    margin-bottom: 24px;
  }

  .step-header {
    margin-bottom: 20px;
  }

  .card-actions {
    margin-top: 28px;
  }
}

@media (max-width: 480px) {
  .new-profile-container {
    padding: 8px;
    padding-top: 16px;
  }

  .profile-creation-card {
    padding: 20px;
    max-height: 97vh;
  }

  .card-actions {
    flex-direction: column;
    gap: 12px;
  }
  
  .color-options {
    grid-template-columns: repeat(5, 1fr);
  }

  .card-header {
    margin-bottom: 16px;
  }

  .step-header {
    margin-bottom: 16px;
  }

  .step-header h2 {
    font-size: 20px;
  }

  .step-header p {
    font-size: 13px;
  }

  .welcome-title {
    font-size: 22px;
  }

  .logo-icon {
    width: 56px;
    height: 56px;
  }

  .card-actions {
    margin-top: 20px;
  }

  .form-section {
    gap: 20px;
  }

  .customization-section {
    gap: 24px;
  }

  .avatar-section {
    gap: 20px;
  }
}

@media (max-width: 400px) {
  .new-profile-container {
    padding: 4px;
    padding-top: 12px;
  }

  .profile-creation-card {
    padding: 16px;
    max-height: 98vh;
  }

  .welcome-title {
    font-size: 20px;
  }

  .banner-preview {
    width: 100%;
    max-width: 250px;
  }

  .color-options {
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
  }

  .card-header {
    margin-bottom: 12px;
  }

  .step-header {
    margin-bottom: 12px;
  }

  .card-actions {
    margin-top: 16px;
  }

  .form-section {
    gap: 16px;
  }

  .customization-section {
    gap: 20px;
  }

  .avatar-section {
    gap: 16px;
  }

  .logo-section {
    margin-bottom: 16px;
  }

  .progress-indicator {
    gap: 8px;
  }
}

@media (max-height: 700px) {
  .new-profile-container {
    align-items: flex-start;
    padding-top: 12px;
    padding-bottom: 12px;
  }

  .profile-creation-card {
    margin: 0;
    max-height: 96vh;
  }

  .card-header {
    margin-bottom: 16px;
  }

  .logo-icon {
    width: 48px;
    height: 48px;
  }

  .welcome-title {
    font-size: 22px;
    margin: 0 0 4px;
  }

  .logo-section {
    margin-bottom: 16px;
  }

  .card-actions {
    margin-top: 20px;
  }

  .step-header {
    margin-bottom: 16px;
  }

  .form-section {
    gap: 18px;
  }

  .customization-section {
    gap: 24px;
  }

  .avatar-section {
    gap: 18px;
  }
}

@media (max-height: 600px) {
  .profile-creation-card {
    max-height: 97vh;
    padding: 20px;
  }

  .card-header {
    margin-bottom: 12px;
  }

  .logo-section {
    margin-bottom: 12px;
  }

  .logo-icon {
    width: 40px;
    height: 40px;
  }

  .welcome-title {
    font-size: 20px;
  }

  .step-header {
    margin-bottom: 12px;
  }

  .step-header h2 {
    font-size: 18px;
  }

  .card-actions {
    margin-top: 16px;
    gap: 10px;
  }

  .action-btn {
    padding: 12px 20px;
  }
}
</style>
