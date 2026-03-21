<!-- NoServersSplash.vue -->
<template>
  <div class="no-servers-container">
    <!-- Animated background -->
    <div class="background-overlay">
      <div class="floating-particles">
        <div v-for="i in 8" :key="i" class="particle" :style="getParticleStyle(i)"></div>
      </div>
      <div class="gradient-orbs">
        <div class="orb orb-1"></div>
        <div class="orb orb-2"></div>
        <div class="orb orb-3"></div>
      </div>
    </div>

    <!-- Main splash content -->
    <div class="splash-card">
      <!-- Logo and welcome section -->
      <div class="welcome-section">
        <div class="logo-container">
          <div class="logo-glow"></div>
          <img src="/img/app_icon_square.webp" alt="Harmony Logo" class="harmony-logo" />
        </div>
        
        <div class="welcome-text">
          <h1 class="welcome-title">{{ $t('server.welcomeToHarmony') }}</h1>
          <p class="welcome-subtitle">{{ $t('server.journeyBegins') }}</p>
        </div>

        <div class="status-indicator">
          <div class="status-dot"></div>
          <span>{{ $t('server.readyToConnect') }}</span>
        </div>
      </div>

      <!-- Action cards -->
      <div class="action-cards">
        <div class="action-card create-card" @click="showCreateServerForm = true">
          <div class="card-icon">
            <svg viewBox="0 0 24 24" class="icon">
              <path d="M12 2C13.1 2 14 2.9 14 4C14 5.1 13.1 6 12 6C10.9 6 10 5.1 10 4C10 2.9 10.9 2 12 2ZM21 9V7L15 1H5C3.89 1 3 1.89 3 3V19A2 2 0 0 0 5 21H11V19H5V3H13V9H21ZM17 13V11H15V13H13V15H15V17H17V15H19V13H17Z" fill="currentColor"/>
            </svg>
          </div>
          <div class="card-content">
            <h3 class="card-title">{{ $t('server.createYourServer') }}</h3>
            <p class="card-description">{{ $t('server.buildCommunityDesc') }}</p>
            <div class="card-features">
              <span class="feature">{{ $t('server.customBranding') }}</span>
              <span class="feature">{{ $t('server.fullControl') }}</span>
              <span class="feature">{{ $t('server.customChannels') }}</span>
            </div>
          </div>
          <div class="card-arrow">
            <svg viewBox="0 0 24 24" class="arrow-icon">
              <path d="M4,11V13H16L10.5,18.5L11.92,19.92L19.84,12L11.92,4.08L10.5,5.5L16,11H4Z" fill="currentColor"/>
            </svg>
          </div>
        </div>

        <div class="action-card join-card" @click="togglePublicServers">
          <div class="card-icon">
            <img
              src="/img/app_icon_badge.png"
              alt=""
              class="join-card-portal-bear"
              width="30"
              height="30"
            />
          </div>
          <div class="card-content">
            <h3 class="card-title">{{ $t('server.discoverCommunities') }}</h3>
            <p class="card-description">{{ $t('server.browseAndJoin') }}</p>
            <div class="card-features">
              <span class="feature">{{ $t('server.publicServers') }}</span>
              <span class="feature">{{ $t('server.activeCommunities') }}</span>
              <span class="feature">{{ $t('server.easyDiscovery') }}</span>
            </div>
          </div>
          <div class="card-arrow">
            <svg viewBox="0 0 24 24" class="arrow-icon">
              <path d="M4,11V13H16L10.5,18.5L11.92,19.92L19.84,12L11.92,4.08L10.5,5.5L16,11H4Z" fill="currentColor"/>
            </svg>
          </div>
        </div>
      </div>

      <!-- Federated server join option -->
      <div class="federated-join-section" @click="showFederatedJoin = true">
        <div class="federated-icon">
          <svg viewBox="0 0 24 24" class="icon">
            <path d="M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.79 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor"/>
          </svg>
        </div>
        <div class="federated-text">
          <span class="federated-label">{{ $t('federation.joinRemoteServer') }}</span>
          <span class="federated-desc">{{ $t('federation.joinByUrl') }}</span>
        </div>
        <div class="federated-arrow">
          <svg viewBox="0 0 24 24" class="arrow-icon">
            <path d="M4,11V13H16L10.5,18.5L11.92,19.92L19.84,12L11.92,4.08L10.5,5.5L16,11H4Z" fill="currentColor"/>
          </svg>
        </div>
      </div>

      <!-- Additional info -->
      <div class="info-section">
        <div class="info-card">
          <svg viewBox="0 0 24 24" class="info-icon">
            <path d="M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z" fill="currentColor"/>
          </svg>
          <div class="info-text">
            <h4>{{ $t('server.newToHarmony') }}</h4>
            <p>{{ $t('server.serversAreWhat') }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Create Server Modal -->
    <CreateServerForm v-if="showCreateServerForm" @close="showCreateServerForm = false" />
    
    <!-- Join Federated Server Modal -->
    <JoinFederatedServer v-if="showFederatedJoin" @close="showFederatedJoin = false" />
  </div>
</template>

<script setup lang="ts">
import CreateServerForm from './CreateServer.vue';
import JoinFederatedServer from './JoinFederatedServer.vue';
import { ref } from 'vue';

const emit = defineEmits<{
  showPublicServers: []
}>();

const showCreateServerForm = ref(false);
const showFederatedJoin = ref(false);

const togglePublicServers = () => {
  emit('showPublicServers');
};

const getParticleStyle = (index: number) => {
  const delay = index * 0.8;
  const duration = 4 + (index % 2);
  return {
    animationDelay: `${delay}s`,
    animationDuration: `${duration}s`,
    left: `${(index * 12.5) % 100}%`,
    top: `${(index * 15) % 100}%`
  };
};
</script>

<style scoped>
.no-servers-container {
  min-height: 100vh;
  background: linear-gradient(135deg, #1e1f22 0%, #2b2d31 50%, #1e1f22 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  position: relative;
  overflow-x: hidden;
  overflow-y: auto;
}

.background-overlay {
  position: absolute;
  inset: 0;
  opacity: 0.4;
  overflow: hidden;
}

.floating-particles {
  position: absolute;
  width: 100%;
  height: 100%;
}

.particle {
  position: absolute;
  width: 6px;
  height: 6px;
  background: linear-gradient(45deg, #0EA5E9, #00d4ff);
  border-radius: 50%;
  animation: float infinite ease-in-out;
  box-shadow: 0 0 15px rgba(14, 165, 233, 0.6);
}

@keyframes float {
  0%, 100% { transform: translateY(0) rotate(0deg); opacity: 0; }
  50% { transform: translateY(-30px) rotate(180deg); opacity: 1; }
}

.gradient-orbs {
  position: absolute;
  width: 100%;
  height: 100%;
}

.orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(40px);
  animation: pulse 6s ease-in-out infinite;
}

.orb-1 {
  width: 200px;
  height: 200px;
  background: radial-gradient(circle, rgba(14, 165, 233, 0.3), transparent);
  top: 20%;
  left: 10%;
  animation-delay: 0s;
}

.orb-2 {
  width: 150px;
  height: 150px;
  background: radial-gradient(circle, rgba(0, 212, 255, 0.2), transparent);
  top: 60%;
  right: 15%;
  animation-delay: 2s;
}

.orb-3 {
  width: 100px;
  height: 100px;
  background: radial-gradient(circle, rgba(14, 165, 233, 0.3), transparent);
  bottom: 20%;
  left: 60%;
  animation-delay: 4s;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 0.3; }
  50% { transform: scale(1.2); opacity: 0.6; }
}

.splash-card {
  background: rgba(47, 49, 54, 0.95);
  backdrop-filter: blur(20px);
  border-radius: 24px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 
    0 32px 64px rgba(0, 0, 0, 0.4),
    0 0 0 1px rgba(255, 255, 255, 0.05),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  width: 100%;
  max-width: 800px;
  max-height: 95vh;
  padding: 48px;
  position: relative;
  overflow-y: auto;
  overflow-x: hidden;
  margin: auto;
}

.splash-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(14, 165, 233, 0.5), transparent);
}

.welcome-section {
  text-align: center;
  margin-bottom: 48px;
}

.logo-container {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 80px;
  height: 80px;
  margin: 0 auto 24px;
}

.logo-glow {
  position: absolute;
  inset: -12px;
  background: conic-gradient(from 180deg, #0EA5E9, #00d4ff, #38BDF8, #0EA5E9);
  border-radius: 50%;
  animation: spin 4s linear infinite;
  opacity: 0.8;
}

.harmony-logo {
  position: relative;
  width: 64px;
  height: 64px;
  color: var(--text-primary);
  overflow: visible;
  border-radius: 50%;
  z-index: 1;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.welcome-text {
  margin-bottom: 24px;
}

.welcome-title {
  font-size: 42px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 12px;
  background: linear-gradient(135deg, #ffffff, var(--text-secondary));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.welcome-subtitle {
  font-size: 18px;
  color: var(--text-secondary);
  margin: 0;
  font-weight: 500;
}

.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: rgba(87, 242, 135, 0.1);
  border: 1px solid rgba(87, 242, 135, 0.3);
  border-radius: 20px;
  color: #57f287;
  font-size: 14px;
  font-weight: 500;
}

.status-dot {
  width: 8px;
  height: 8px;
  background: #57f287;
  border-radius: 50%;
  animation: pulse-dot 2s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.7; transform: scale(1.2); }
}

.action-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  margin-bottom: 40px;
}

.action-card {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  padding: 24px;
  cursor: pointer;
  transition: all 0.3s ease;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.action-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.1), transparent);
  opacity: 0;
  transition: opacity 0.3s ease;
}

.action-card:hover {
  transform: translateY(-4px);
  border-color: rgba(14, 165, 233, 0.5);
  box-shadow: 0 16px 32px rgba(0, 0, 0, 0.3);
}

.action-card:hover::before {
  opacity: 1;
}

.create-card:hover {
  border-color: rgba(87, 242, 135, 0.5);
  box-shadow: 0 16px 32px rgba(87, 242, 135, 0.1);
}

.join-card:hover {
  border-color: rgba(14, 165, 233, 0.5);
  box-shadow: 0 16px 32px rgba(14, 165, 233, 0.1);
}

.card-icon {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, #0EA5E9, #38BDF8);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.create-card .card-icon {
  background: linear-gradient(135deg, #57f287, #00d166);
}

.card-icon .icon {
  width: 24px;
  height: 24px;
  color: var(--text-primary);
}

/* Same white bear as Harmony Portal (ServerSidebar) */
.join-card .join-card-portal-bear {
  width: 30px;
  height: 30px;
  object-fit: contain;
  display: block;
  pointer-events: none;
}

.card-content {
  flex: 1;
}

.card-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.card-description {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin: 0 0 16px;
}

.card-features {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.feature {
  font-size: 12px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--text-primary);
  font-weight: 500;
}

.card-arrow {
  align-self: flex-end;
  width: 24px;
  height: 24px;
  color: var(--text-secondary);
  transition: all 0.3s ease;
}

.action-card:hover .card-arrow {
  color: var(--text-primary);
  transform: translateX(4px);
}

.arrow-icon {
  width: 100%;
  height: 100%;
}

/* Federated join section */
.federated-join-section {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  background: rgba(0, 212, 255, 0.05);
  border: 1px solid rgba(0, 212, 255, 0.2);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.3s ease;
  margin-bottom: 32px;
}

.federated-join-section:hover {
  background: rgba(0, 212, 255, 0.1);
  border-color: rgba(0, 212, 255, 0.4);
  transform: translateY(-2px);
}

.federated-icon {
  width: 40px;
  height: 40px;
  background: linear-gradient(135deg, #00d4ff, #0EA5E9);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.federated-icon .icon {
  width: 22px;
  height: 22px;
  color: var(--text-primary);
}

.federated-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.federated-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.federated-desc {
  font-size: 13px;
  color: #00d4ff;
}

.federated-arrow {
  width: 24px;
  height: 24px;
  color: #00d4ff;
  transition: transform 0.3s ease;
}

.federated-join-section:hover .federated-arrow {
  transform: translateX(4px);
}

.info-section {
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  padding-top: 32px;
}

.info-card {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 20px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.info-icon {
  width: 24px;
  height: 24px;
  color: #0EA5E9;
  flex-shrink: 0;
  margin-top: 2px;
}

.info-text h4 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.info-text p {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin: 0;
}

@media (max-width: 768px) {
  .no-servers-container {
    padding: 12px;
    align-items: flex-start;
    padding-top: 20px;
  }
  
  .splash-card {
    padding: 32px 24px;
    max-height: 96vh;
  }
  
  .welcome-title {
    font-size: 32px;
  }
  
  .action-cards {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  
  .orb-1, .orb-2, .orb-3 {
    width: 100px;
    height: 100px;
  }
  
  .welcome-section {
    margin-bottom: 32px;
  }

  .action-cards {
    margin-bottom: 28px;
  }
}

@media (max-width: 480px) {
  .no-servers-container {
    padding: 8px;
    padding-top: 16px;
  }

  .splash-card {
    padding: 24px 20px;
    max-height: 97vh;
  }

  .welcome-title {
    font-size: 28px;
  }
  
  .action-card {
    padding: 20px;
  }
  
  .card-features {
    flex-direction: column;
    align-items: flex-start;
  }

  .welcome-section {
    margin-bottom: 24px;
  }

  .action-cards {
    margin-bottom: 24px;
  }

  .logo-container {
    width: 64px;
    height: 64px;
    margin-bottom: 16px;
  }

  .welcome-subtitle {
    font-size: 16px;
  }
}

@media (max-height: 700px) {
  .no-servers-container {
    align-items: flex-start;
    padding-top: 12px;
    padding-bottom: 12px;
  }

  .splash-card {
    max-height: 96vh;
    padding: 28px;
  }

  .welcome-section {
    margin-bottom: 24px;
  }

  .action-cards {
    margin-bottom: 24px;
  }

  .info-section {
    padding-top: 20px;
  }
}
</style>
