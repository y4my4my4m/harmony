<template>
  <div class="admin-panel">
    <div class="admin-header">
      <div class="admin-title">
        <Icon name="admin-terminal" :size="24" />
        <h1>Instance Control Panel</h1>
        <div class="system-status" :class="systemStatus.class">
          <div class="status-indicator"></div>
          <span>{{ systemStatus.text }}</span>
        </div>
      </div>
      <div class="admin-actions">
        <button @click="refreshData" class="action-btn refresh-btn" :disabled="loading">
          <Icon name="refresh" :size="16" />
          Refresh
        </button>
        <button @click="exportLogs" class="action-btn export-btn">
          <Icon name="download" :size="16" />
          Export Logs
        </button>
      </div>
    </div>

    <div class="admin-grid">
      <!-- System Overview -->
      <div class="admin-module overview-module">
        <div class="module-header">
          <Icon name="dashboard" :size="20" />
          <h2>System Overview</h2>
          <div class="uptime">{{ formatUptime(systemStats.uptime) }}</div>
        </div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon">
              <Icon name="users" :size="24" />
            </div>
            <div class="stat-content">
              <div class="stat-value">{{ systemStats.totalUsers }}</div>
              <div class="stat-label">Total Users</div>
              <div class="stat-change positive">+{{ systemStats.newUsersToday }} today</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">
              <Icon name="server" :size="24" />
            </div>
            <div class="stat-content">
              <div class="stat-value">{{ systemStats.totalServers }}</div>
              <div class="stat-label">Chat Servers</div>
              <div class="stat-change">{{ systemStats.activeServers }} active</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">
              <Icon name="federation" :size="24" />
            </div>
            <div class="stat-content">
              <div class="stat-value">{{ systemStats.federatedInstances }}</div>
              <div class="stat-label">Federated Instances</div>
              <div class="stat-change positive">{{ systemStats.federationHealth }}% healthy</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">
              <Icon name="message" :size="24" />
            </div>
            <div class="stat-content">
              <div class="stat-value">{{ formatNumber(systemStats.totalPosts) }}</div>
              <div class="stat-label">Total Posts</div>
              <div class="stat-change">{{ systemStats.postsToday }} today</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Federation Management -->
      <div class="admin-module federation-module">
        <div class="module-header">
          <Icon name="federation" :size="20" />
          <h2>Federation Management</h2>
          <div class="module-actions">
            <button @click="handleAddInstance" class="primary-btn">
              <Icon name="plus" :size="16" />
              Add Instance
            </button>
            <button @click="refreshFederationData" class="action-btn" :disabled="loadingStates.federationStats">
              <Icon name="refresh-cw" :size="16" />
              Refresh
            </button>
          </div>
        </div>

        <!-- Federation Stats -->
        <div class="federation-stats">
          <div class="stat-card">
            <div class="stat-value">{{ formatNumber(instanceStats?.total_instances) }}</div>
            <div class="stat-label">Total Instances</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ formatNumber(instanceStats?.active_instances) }}</div>
            <div class="stat-label">Active (7 days)</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ formatNumber(instanceStats?.trusted_instances) }}</div>
            <div class="stat-label">Trusted</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ formatNumber(instanceStats?.blocked_instances) }}</div>
            <div class="stat-label">Blocked</div>
          </div>
        </div>

        <!-- Instance Management -->
        <div class="federation-section">
          <div class="section-controls">
            <h3>Instance Directory</h3>
            <div class="filter-controls">
              <select v-model="instanceFilter" @change="loadFederatedInstances" class="cyber-select">
                <option value="all">All Instances</option>
                <option value="active">Active</option>
                <option value="trusted">Trusted</option>
                <option value="blocked">Blocked</option>
              </select>
              <input
                v-model="instanceSearch"
                @input="debouncedSearchInstances"
                placeholder="Search instances..."
                class="cyber-input"
              />
            </div>
          </div>

          <!-- Loading State -->
          <div v-if="loadingStates.instances" class="loading-state">
            <div class="loading-spinner"></div>
            <span>Loading instances...</span>
          </div>

          <!-- Instance List -->
          <div v-else class="instance-list">
            <div
              v-for="instance in federatedInstances"
              :key="instance.id"
              class="instance-item"
              :class="{ 
                'blocked': instance.is_blocked, 
                'trusted': instance.is_trusted,
                'inactive': isInstanceInactive(instance)
              }"
            >
              <div class="instance-main">
                <div class="instance-info">
                  <div class="instance-domain">
                    <strong>{{ instance.domain }}</strong>
                    <div class="instance-badges">
                      <span v-if="instance.is_trusted" class="badge trusted">Trusted</span>
                      <span v-if="instance.is_blocked" class="badge blocked">Blocked</span>
                      <span v-if="isInstanceInactive(instance)" class="badge inactive">Inactive</span>
                    </div>
                  </div>
                  <div class="instance-details">
                    <span v-if="instance.software" class="detail-item">
                      {{ instance.software }} {{ instance.version }}
                    </span>
                    <span class="detail-item">
                      {{ formatNumber(instance.user_count) }} users
                    </span>
                    <span class="detail-item">
                      {{ formatNumber(instance.status_count) }} posts
                    </span>
                    <span class="detail-item">
                      Last seen: {{ formatRelativeTime(instance.last_seen_at) }}
                    </span>
                  </div>
                  <div v-if="instance.description" class="instance-description">
                    {{ instance.description }}
                  </div>
                </div>
                <div class="instance-actions">
                  <button 
                    @click="refreshInstance(instance.id)" 
                    class="action-btn-sm"
                    title="Refresh instance info"
                  >
                    <Icon name="refresh-cw" :size="14" />
                  </button>
                  <button 
                    v-if="!instance.is_trusted && !instance.is_blocked"
                    @click="toggleInstanceTrust(instance.id, true)" 
                    class="action-btn-sm"
                    title="Mark as trusted"
                  >
                    <Icon name="check" :size="14" />
                  </button>
                  <button 
                    v-if="instance.is_trusted"
                    @click="toggleInstanceTrust(instance.id, false)" 
                    class="action-btn-sm trusted"
                    title="Remove trust"
                  >
                    <Icon name="check" :size="14" />
                  </button>
                  <button 
                    v-if="!instance.is_blocked"
                    @click="toggleInstanceBlock(instance.id, true)" 
                    class="danger-btn-sm"
                    title="Block instance"
                  >
                    <Icon name="shield" :size="14" />
                  </button>
                  <button 
                    v-if="instance.is_blocked"
                    @click="toggleInstanceBlock(instance.id, false)" 
                    class="action-btn-sm"
                    title="Unblock instance"
                  >
                    <Icon name="shield-off" :size="14" />
                  </button>
                  <button 
                    @click="deleteInstance(instance.id)" 
                    class="danger-btn-sm"
                    title="Delete instance"
                  >
                    <Icon name="trash" :size="14" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Pagination -->
          <div v-if="instancePagination.total > instancePagination.limit" class="pagination">
            <button 
              @click="loadPreviousInstances" 
              :disabled="instancePagination.offset === 0"
              class="pagination-btn"
            >
              Previous
            </button>
            <span class="pagination-info">
              {{ instancePagination.offset + 1 }}-{{ Math.min(instancePagination.offset + instancePagination.limit, instancePagination.total) }} 
              of {{ instancePagination.total }}
            </span>
            <button 
              @click="loadNextInstances" 
              :disabled="instancePagination.offset + instancePagination.limit >= instancePagination.total"
              class="pagination-btn"
            >
              Next
            </button>
          </div>
        </div>

        <!-- Discovery Section -->
        <div class="federation-section">
          <h3>Instance Discovery</h3>
          <div class="discovery-tabs">
            <button 
              @click="discoveryTab = 'discovered'" 
              :class="{ active: discoveryTab === 'discovered' }"
              class="tab-btn"
            >
              From Interactions
            </button>
            <button 
              @click="discoveryTab = 'search'" 
              :class="{ active: discoveryTab === 'search' }"
              class="tab-btn"
            >
              Search & Add
            </button>
          </div>

          <!-- Discovered Instances -->
          <div v-if="discoveryTab === 'discovered'" class="discovery-content">
            <div v-if="discoveredInstances.length === 0" class="empty-state">
              <Icon name="search" :size="32" />
              <p>No instances discovered from user interactions yet.</p>
              <button @click="loadDiscoveredInstances" class="primary-btn">
                Scan for Interactions
              </button>
            </div>
            <div v-else class="discovered-list">
              <div
                v-for="discovered in discoveredInstances"
                :key="discovered.domain"
                class="discovered-item"
              >
                <div class="discovered-info">
                  <strong>{{ discovered.domain }}</strong>
                  <span class="interaction-count">{{ discovered.interaction_count }} interactions</span>
                </div>
                <button 
                  @click="addDiscoveredInstance(discovered.domain)" 
                  class="primary-btn-sm"
                >
                  <Icon name="plus" :size="14" />
                  Add
                </button>
              </div>
            </div>
          </div>

          <!-- Search & Add -->
          <div v-if="discoveryTab === 'search'" class="discovery-content">
            <div class="search-form">
              <input
                v-model="newInstanceDomain"
                @keyup.enter="discoverInstance"
                placeholder="Enter domain (e.g., mastodon.social)"
                class="cyber-input"
              />
              <button 
                @click="discoverInstance" 
                :disabled="!newInstanceDomain || loadingStates.discovering"
                class="primary-btn"
              >
                <Icon v-if="loadingStates.discovering" name="loader" :size="16" class="spinning" />
                <Icon v-else name="search" :size="16" />
                {{ loadingStates.discovering ? 'Discovering...' : 'Discover' }}
              </button>
            </div>

            <!-- Discovery Result -->
            <div v-if="discoveryResult" class="discovery-result">
              <div class="result-header">
                <h4>{{ discoveryResult.domain }}</h4>
                <div class="result-badges">
                  <span v-if="discoveryResult.federation_enabled" class="badge success">Federation Enabled</span>
                  <span v-if="discoveryResult.api_available" class="badge info">API Available</span>
                </div>
              </div>
              <div class="result-details">
                <div v-if="discoveryResult.software" class="detail-row">
                  <strong>Software:</strong> {{ discoveryResult.software }} {{ discoveryResult.version }}
                </div>
                <div v-if="discoveryResult.description" class="detail-row">
                  <strong>Description:</strong> {{ discoveryResult.description }}
                </div>
                <div class="detail-row">
                  <strong>Users:</strong> {{ formatNumber(discoveryResult.user_count) }}
                </div>
                <div class="detail-row">
                  <strong>Posts:</strong> {{ formatNumber(discoveryResult.status_count) }}
                </div>
                <div v-if="discoveryResult.admin_contact" class="detail-row">
                  <strong>Admin:</strong> {{ discoveryResult.admin_contact }}
                </div>
              </div>
              <div class="result-actions">
                <label class="checkbox-label">
                  <input type="checkbox" v-model="addAsTrusted" />
                  Add as trusted instance
                </label>
                <button @click="addInstanceFromDiscovery" class="primary-btn">
                  <Icon name="plus" :size="16" />
                  Add Instance
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- User Management -->
      <div class="admin-module users-module">
        <div class="module-header">
          <Icon name="users" :size="20" />
          <h2>User Management</h2>
          <div class="search-bar">
            <Icon name="search" :size="16" />
            <input v-model="userSearch" placeholder="Search users..." class="cyber-input" />
          </div>
        </div>
        <div class="users-content">
          <div class="user-filters">
            <button 
              v-for="filter in userFilters" 
              :key="filter.key"
              @click="activeUserFilter = filter.key"
              :class="['filter-btn', { active: activeUserFilter === filter.key }]"
            >
              {{ filter.label }} ({{ filter.count }})
            </button>
          </div>
          <div class="users-list">
            <div 
              v-for="user in filteredUsers" 
              :key="user.id" 
              class="user-item"
              :class="{ 'user-suspended': user.is_suspended }"
            >
              <Avatar 
                :src="user.avatar_url" 
                :alt="user.display_name || user.username"
                size="md"
              />
              <div class="user-info">
                <div class="user-name">
                  {{ user.display_name || user.username }}
                  <span v-if="user.is_suspended" class="badge suspended">Suspended</span>
                  <span v-if="user.is_admin" class="badge admin">Admin</span>
                </div>
                <div class="user-meta">
                  {{ user.handle }}
                  <span class="user-joined">Joined {{ formatDate(user.created_at) }}</span>
                  <span v-if="user.is_suspended && user.suspension_reason" class="suspension-reason">
                    — {{ user.suspension_reason }}
                  </span>
                </div>
              </div>
              <div class="user-stats">
                <button @click="navigateToUserPosts(user)" class="user-stat clickable">
                  {{ user.postCount }} posts
                </button>
                <button 
                  v-if="user.is_local" 
                  @click="navigateToUserServers(user)" 
                  class="user-stat clickable"
                >
                  {{ user.serverCount }} servers
                </button>
                <span v-else class="user-stat">federated</span>
              </div>
              <div class="user-actions">
                <button 
                  v-if="user.is_suspended"
                  @click="moderateUser(user, 'unsuspend')" 
                  class="mod-btn unsuspend-btn"
                  title="Unsuspend user"
                >
                  <Icon name="check" :size="16" />
                </button>
                <button 
                  v-else
                  @click="moderateUser(user, 'suspend')" 
                  class="mod-btn suspend-btn"
                  title="Suspend user"
                >
                  <Icon name="suspend" :size="16" />
                </button>
                <button 
                  @click="moderateUser(user, 'delete')" 
                  class="mod-btn delete-btn"
                  title="Delete user"
                >
                  <Icon name="delete" :size="16" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- System Health -->
      <div class="admin-module health-module">
        <div class="module-header">
          <Icon name="health" :size="20" />
          <h2>System Health</h2>
          <div class="health-indicator" :class="healthStatus.class">
            {{ healthStatus.text }}
          </div>
        </div>
        <div class="health-metrics">
          <div class="metric-card">
            <div class="metric-header">
              <span>Database</span>
              <div class="metric-status healthy"></div>
            </div>
            <div class="metric-value">{{ systemHealth.database.responseTime }}ms</div>
            <div class="metric-detail">{{ systemHealth.database.connections }} connections</div>
          </div>
          <div class="metric-card">
            <div class="metric-header">
              <span>Federation Queue</span>
              <div class="metric-status" :class="systemHealth.federation.status"></div>
            </div>
            <div class="metric-value">{{ systemHealth.federation.pending }}</div>
            <div class="metric-detail">pending deliveries</div>
          </div>
          <div class="metric-card">
            <div class="metric-header">
              <span>Storage</span>
              <div class="metric-status healthy"></div>
            </div>
            <div class="metric-value">{{ systemHealth.storage.used }}%</div>
            <div class="metric-detail">{{ systemHealth.storage.total }} total</div>
          </div>
          <div class="metric-card">
            <div class="metric-header">
              <span>Memory</span>
              <div class="metric-status warning"></div>
            </div>
            <div class="metric-value">{{ systemHealth.memory.used }}%</div>
            <div class="metric-detail">{{ systemHealth.memory.total }} available</div>
          </div>
        </div>
      </div>

      <!-- Recent Activity -->
      <div class="admin-module activity-module">
        <div class="module-header">
          <Icon name="activity" :size="20" />
          <h2>Recent Activity</h2>
          <select v-model="activityFilter" class="cyber-select">
            <option value="all">All Events</option>
            <option value="federation">Federation</option>
            <option value="moderation">Moderation</option>
            <option value="security">Security</option>
          </select>
        </div>
        <div class="activity-feed">
          <div v-for="event in recentActivity" :key="event.id" class="activity-item">
            <div class="activity-icon" :class="event.type">
              <Icon :name="getActivityIcon(event.type)" :size="16" />
            </div>
            <div class="activity-content">
              <div class="activity-message">{{ event.message }}</div>
              <div class="activity-meta">
                <span class="activity-time">{{ formatTime(event.timestamp) }}</span>
                <span class="activity-source">{{ event.source }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Configuration -->
      <div class="admin-module config-module">
        <div class="module-header">
          <Icon name="settings" :size="20" />
          <h2>Configuration</h2>
          <button @click="saveConfig" class="save-btn" :disabled="!configChanged">
            <Icon name="save" :size="16" />
            Save Changes
          </button>
        </div>
        <div class="config-sections">
          <div class="config-section">
            <h3>Chat Settings</h3>
            <div class="setting-group">
              <label>Max Server Size</label>
              <input v-model.number="config.chat.maxServerSize" type="number" class="cyber-input" />
            </div>
            <div class="setting-group">
              <label>Max Message Length</label>
              <input v-model.number="config.chat.maxMessageLength" type="number" class="cyber-input" />
            </div>
            <div class="setting-row">
              <label class="toggle-label">
                <input type="checkbox" v-model="config.chat.allowFileUploads" />
                <span class="toggle-slider"></span>
                Allow File Uploads
              </label>
              <label class="toggle-label">
                <input type="checkbox" v-model="config.chat.enableVoiceChannels" />
                <span class="toggle-slider"></span>
                Enable Voice Channels
              </label>
            </div>
          </div>
          
          <div class="config-section">
            <h3>Federation Settings</h3>
            <div class="setting-group">
              <label>Max Post Length</label>
              <input v-model.number="config.federation.maxPostLength" type="number" class="cyber-input" />
            </div>
            <div class="setting-group">
              <label>Delivery Retry Attempts</label>
              <input v-model.number="config.federation.retryAttempts" type="number" class="cyber-input" />
            </div>
            <div class="setting-row">
              <label class="toggle-label">
                <input type="checkbox" v-model="config.federation.enableOutbound" />
                <span class="toggle-slider"></span>
                Enable Outbound Federation
              </label>
              <label class="toggle-label">
                <input type="checkbox" v-model="config.federation.enableInbound" />
                <span class="toggle-slider"></span>
                Enable Inbound Federation
              </label>
            </div>
          </div>

          <div class="config-section">
            <h3>Instance Branding</h3>
            <div class="setting-group">
              <label>Instance Name</label>
              <input 
                v-model="instanceConfig.name" 
                type="text" 
                class="cyber-input"
                placeholder="Harmony Instance"
                @input="instanceBrandingChanged = true"
              />
              <span class="setting-hint">
                This name appears on the login/register page. Changes will be visible to all users.
              </span>
            </div>
            <div class="setting-group">
              <label>Instance Description</label>
              <textarea 
                v-model="instanceConfig.description" 
                class="cyber-input"
                rows="3"
                placeholder="A federated social platform"
                @input="instanceBrandingChanged = true"
              ></textarea>
              <span class="setting-hint">
                This description appears as the subtitle on the login/register page.
              </span>
            </div>
            <button 
              @click="saveInstanceBranding" 
              class="save-btn" 
              :disabled="!instanceBrandingChanged || savingBranding"
              style="margin-top: 12px;"
            >
              <Icon name="save" :size="16" />
              {{ savingBranding ? 'Saving...' : 'Save Branding' }}
            </button>
          </div>

          <div class="config-section">
            <h3>WebRTC / Voice Settings</h3>
            <div class="setting-group">
              <label>WebRTC Mode</label>
              <select v-model="config.webrtc.mode" class="cyber-input">
                <option value="hybrid">Hybrid (SFU with P2P fallback)</option>
                <option value="sfu">SFU Only (LiveKit)</option>
                <option value="p2p">P2P Only (Peer-to-Peer)</option>
              </select>
              <span class="setting-hint">
                Hybrid uses LiveKit server when available, falls back to P2P
              </span>
            </div>
            <div class="setting-group">
              <label>LiveKit Server URL</label>
              <input 
                v-model="config.webrtc.livekitUrl" 
                type="text" 
                class="cyber-input"
                placeholder="wss://livekit.yourdomain.com"
              />
              <span class="setting-hint">
                WebSocket URL for the LiveKit server (configured in backend .env)
              </span>
            </div>
            <div class="setting-group">
              <label>Max Stage Listeners</label>
              <input 
                v-model.number="config.webrtc.maxStageListeners" 
                type="number" 
                class="cyber-input"
              />
              <span class="setting-hint">
                Maximum audience size for stage events (speaker mode)
              </span>
            </div>
            <div class="setting-row">
              <label class="toggle-label">
                <input type="checkbox" v-model="config.webrtc.allowFederatedVoice" />
                <span class="toggle-slider"></span>
                Allow Federated Voice Calls
                <span class="setting-hint-inline">
                  Enable voice/video calls with users from other instances
                </span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- Performance Monitoring -->
      <div class="admin-module performance-module">
        <div class="module-header">
          <Icon name="activity" :size="20" />
          <h2>Performance Monitoring</h2>
        </div>
        <div class="performance-content">
          <PerformanceMonitoring />
        </div>
      </div>

      <!-- Emoji Importer -->
      <div class="admin-module emoji-module">
        <div class="module-header">
          <Icon name="emoji" :size="20" />
          <h2>Remote Emoji Importer</h2>
        </div>
        <div class="emoji-content">
          <EmojiImporter />
        </div>
      </div>
    </div>

    <!-- User Servers Modal -->
    <Teleport to="body">
      <div v-if="showServersModal" class="modal-overlay" @click.self="closeServersModal">
        <div class="modal-content servers-modal">
          <div class="modal-header">
            <h3>
              <Icon name="server" :size="20" />
              Servers for {{ selectedUserForServers?.display_name || selectedUserForServers?.username }}
            </h3>
            <button @click="closeServersModal" class="close-btn">
              <Icon name="close" :size="20" />
            </button>
          </div>
          <div class="modal-body">
            <div v-if="loadingServers" class="loading-state">
              <div class="loading-spinner"></div>
              <span>Loading servers...</span>
            </div>
            <div v-else-if="userServers.length === 0" class="empty-state">
              <Icon name="server" :size="32" />
              <p>This user is not a member of any servers.</p>
            </div>
            <div v-else class="servers-list">
              <div 
                v-for="server in userServers" 
                :key="server.id" 
                class="server-item"
              >
                <div class="server-icon">
                  <img 
                    v-if="server.icon_url" 
                    :src="getServerIconUrl(server.icon_url)" 
                    :alt="server.name"
                  />
                  <div v-else class="server-icon-placeholder">
                    {{ server.name.charAt(0).toUpperCase() }}
                  </div>
                </div>
                <div class="server-info">
                  <div class="server-name">
                    {{ server.name }}
                    <span v-if="server.is_owner" class="badge owner">Owner</span>
                  </div>
                  <div class="server-meta">
                    <span class="member-count">
                      <Icon name="users" :size="12" />
                      {{ server.member_count }} members
                    </span>
                    <span class="join-date">
                      Joined {{ formatDate(server.joined_at) }}
                    </span>
                  </div>
                </div>
                <div class="server-actions">
                  <button 
                    @click="navigateToServer(server.id)" 
                    class="action-btn-sm"
                    title="View server"
                  >
                    <Icon name="arrow-right" :size="14" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import EmojiImporter from '@/components/admin/EmojiImporter.vue'
import PerformanceMonitoring from '@/components/admin/PerformanceMonitoring.vue'
import { adminService, type SystemStats, type SystemHealth, type AdminUser, type AdminActivity, type BlockedInstance, type FederatedInstance, type InstanceStats, type InstanceSearchResult } from '@/services/AdminService'
import { getServerIconUrl } from '@/utils/serverUtils'

const authStore = useAuthStore()
const router = useRouter()
const toast = useToast()

// Security check - only allow admins
onMounted(async () => {
  if (!authStore.session?.user?.id) {
    router.push('/login')
    return
  }

  // Check if user is admin using AdminService
  const isAdmin = await adminService.checkAdminPermissions(authStore.session.user.id)
  
  if (!isAdmin) {
    router.push('/')
    return
  }

  await loadInitialData()
})

// Reactive data
const loading = ref(false)
const userSearch = ref('')
const activeUserFilter = ref('all')
const activityFilter = ref('all')
const newBlockDomain = ref('')
const newBlockReason = ref('')
const configChanged = ref(false)
const instanceBrandingChanged = ref(false)
const savingBranding = ref(false)

// Federation management data
const instanceStats = ref<InstanceStats>({
  total_instances: 0,
  blocked_instances: 0,
  trusted_instances: 0,
  active_instances: 0,
  recently_discovered: 0
})

const federatedInstances = ref<FederatedInstance[]>([])
const discoveredInstances = ref<{ domain: string; user_count: number; interaction_count: number }[]>([])
const discoveryResult = ref<InstanceSearchResult | null>(null)
const showAddInstanceModal = ref(false)
const instanceFilter = ref<'all' | 'blocked' | 'trusted' | 'active'>('all')
const instanceSearch = ref('')
const discoveryTab = ref('discovered')
const newInstanceDomain = ref('')
const addAsTrusted = ref(false)

// Loading states
const loadingStates = ref({
  federationStats: false,
  instances: false,
  discovering: false
})

// User servers modal
const showServersModal = ref(false)
const selectedUserForServers = ref<AdminUser | null>(null)
const userServers = ref<{
  id: string;
  name: string;
  icon_url: string | null;
  member_count: number;
  owner_id: string;
  is_owner: boolean;
  joined_at: string;
}[]>([])
const loadingServers = ref(false)

// Pagination for instances
const instancePagination = ref({
  offset: 0,
  limit: 20,
  total: 0
})

// System stats
const systemStats = ref({
  uptime: 0,
  totalUsers: 0,
  newUsersToday: 0,
  totalServers: 0,
  activeServers: 0,
  federatedInstances: 0,
  federationHealth: 0,
  totalPosts: 0,
  postsToday: 0
})

// System health
const systemHealth = ref({
  database: { responseTime: 0, connections: 0 },
  federation: { pending: 0, status: 'healthy' },
  storage: { used: 0, total: '100GB' },
  memory: { used: 0, total: '16GB' }
})

// Instance configuration
const instanceConfig = ref({
  name: 'Harmony Instance',
  domain: import.meta.env.VITE_DOMAIN as string,
  description: 'A federated social platform',
  openRegistration: true,
  approvalRequired: false
})

// Configuration
const config = ref({
  chat: {
    maxServerSize: 1000,
    maxMessageLength: 2000,
    allowFileUploads: true,
    enableVoiceChannels: true
  },
  federation: {
    maxPostLength: 500,
    retryAttempts: 3,
    enableOutbound: true,
    enableInbound: true
  },
  webrtc: {
    mode: 'hybrid' as 'sfu' | 'p2p' | 'hybrid',
    livekitUrl: '',
    allowFederatedVoice: true,
    maxStageListeners: 100000
  }
})

// Users data
const users = ref<AdminUser[]>([])
const blockedInstances = ref([
  { domain: 'bad-instance.com', reason: 'Spam and harassment' },
  { domain: 'another-bad.net', reason: 'Policy violations' }
])

const recentActivity = ref<any[]>([])

// Computed properties
const systemStatus = computed(() => {
  const health = systemHealth.value
  if (health.federation.status === 'error') {
    return { class: 'error', text: 'Federation Issues' }
  }
  if (health.memory.used > 90) {
    return { class: 'warning', text: 'High Memory Usage' }
  }
  return { class: 'healthy', text: 'All Systems Operational' }
})

const federationStatus = computed(() => {
  const pending = systemHealth.value.federation.pending
  if (pending > 100) {
    return { class: 'warning', text: `${pending} pending deliveries` }
  }
  return { class: 'healthy', text: 'Federation Active' }
})

const healthStatus = computed(() => {
  const issues = []
  if (systemHealth.value.memory.used > 90) issues.push('memory')
  if (systemHealth.value.federation.status === 'error') issues.push('federation')
  
  if (issues.length === 0) return { class: 'healthy', text: 'Healthy' }
  if (issues.length === 1) return { class: 'warning', text: 'Minor Issues' }
  return { class: 'error', text: 'Critical Issues' }
})

const userFilters = computed(() => [
  { key: 'all', label: 'All Users', count: users.value.length },
  { key: 'local', label: 'Local', count: users.value.filter(u => u.is_local).length },
  { key: 'federated', label: 'Federated', count: users.value.filter(u => !u.is_local).length },
  { key: 'suspended', label: 'Suspended', count: users.value.filter(u => u.is_suspended).length }
])

const filteredUsers = computed(() => {
  let filtered = users.value

  // Apply filter
  if (activeUserFilter.value !== 'all') {
    switch (activeUserFilter.value) {
      case 'local':
        filtered = filtered.filter(u => u.is_local)
        break
      case 'federated':
        filtered = filtered.filter(u => !u.is_local)
        break
      case 'suspended':
        filtered = filtered.filter(u => u.is_suspended)
        break
    }
  }

  // Apply search
  if (userSearch.value) {
    const search = userSearch.value.toLowerCase()
    filtered = filtered.filter(u => 
      u.username.toLowerCase().includes(search) ||
      u.display_name?.toLowerCase().includes(search) ||
      u.domain?.toLowerCase().includes(search)
    )
  }

  return filtered.slice(0, 50) // Limit results
})

// Watch for config changes
watch(config, () => {
  configChanged.value = true
}, { deep: true })

// Methods
const loadInitialData = async () => {
  loading.value = true
  try {
    await Promise.all([
      loadSystemStats(),
      loadUsers(),
      loadSystemHealth(),
      loadInstanceConfig(),
      loadRecentActivity(),
      loadInstanceStats(),
      loadFederatedInstances()
    ])
  } catch (error) {
    debug.error('Failed to load admin data:', error)
  } finally {
    loading.value = false
  }
}

const loadRecentActivity = async () => {
  try {
    const activity = await adminService.getRecentActivity(20)
    
    recentActivity.value = activity.map((event: AdminActivity) => ({
      id: event.id,
      type: event.action_type,
      message: event.details,
      timestamp: new Date(event.created_at),
      source: `Admin: ${event.admin_username}`,
      admin_id: event.admin_id
    }))
  } catch (error) {
    debug.error('Failed to load recent activity:', error)
    recentActivity.value = []
  }
}

const loadSystemStats = async () => {
  try {
    const stats = await adminService.getSystemStats()
    
    systemStats.value = {
      uptime: stats.uptime || Date.now() - (7 * 24 * 60 * 60 * 1000),
      totalUsers: stats.total_users,
      newUsersToday: stats.newUsersToday || 0,
      totalServers: stats.total_servers,
      activeServers: stats.active_servers,
      federatedInstances: stats.federated_instances,
      federationHealth: 95, // Mock for now
      totalPosts: stats.total_posts,
      postsToday: stats.postsToday || 0
    }
  } catch (error) {
    debug.error('Failed to load system stats:', error)
    // Set defaults on error
    systemStats.value = {
      uptime: Date.now() - (7 * 24 * 60 * 60 * 1000),
      totalUsers: 0,
      newUsersToday: 0,
      totalServers: 0,
      activeServers: 0,
      federatedInstances: 0,
      federationHealth: 0,
      totalPosts: 0,
      postsToday: 0
    }
  }
}

const loadUsers = async () => {
  try {
    users.value = await adminService.getUsers(100)
  } catch (error) {
    debug.error('Failed to load users:', error)
    users.value = []
  }
}

const loadSystemHealth = async () => {
  try {
    systemHealth.value = await adminService.getSystemHealth()
  } catch (error) {
    debug.error('Failed to load system health:', error)
    // Set defaults
    systemHealth.value = {
      database: { responseTime: 0, connections: 0 },
      federation: { pending: 0, status: 'error' },
      storage: { used: 0, total: '100GB' },
      memory: { used: 0, total: '16GB' }
    }
  }
}

const loadInstanceConfig = async () => {
  try {
    const config = await adminService.getInstanceConfig()
    if (config?.instance) {
      instanceConfig.value = {
        name: config.instance.name || 'Harmony Instance',
        domain: config.instance.domain || import.meta.env.VITE_DOMAIN as string,
        description: config.instance.description || 'A federated social platform',
        openRegistration: config.instance.registrationOpen ?? true,
        approvalRequired: config.instance.requiresApproval ?? false
      }
    }
  } catch (error) {
    debug.error('Failed to load instance config:', error)
    // Keep defaults if loading fails
  }
}

const refreshData = async () => {
  await loadInitialData()
}

const exportLogs = () => {
  // Export system logs
  debug.log('Exporting logs...')
}

const blockInstance = async () => {
  if (newBlockDomain.value && newBlockReason.value) {
    try {
      await adminService.moderateInstance(
        newBlockDomain.value,
        'block',
        newBlockReason.value,
        authStore.session?.user?.id || ''
      )

      blockedInstances.value.push({
        domain: newBlockDomain.value,
        reason: newBlockReason.value
      })
      
      newBlockDomain.value = ''
      newBlockReason.value = ''
      
      // Refresh activity log
      await loadRecentActivity()
    } catch (error) {
      debug.error('Failed to block instance:', error)
      alert('Failed to block instance. Check console for details.')
    }
  }
}

const unblockInstance = async (domain: string) => {
  try {
    await adminService.moderateInstance(
      domain,
      'unblock',
      'Admin unblock',
      authStore.session?.user?.id || ''
    )

    const index = blockedInstances.value.findIndex(i => i.domain === domain)
    if (index !== -1) {
      blockedInstances.value.splice(index, 1)
    }
    
    // Refresh activity log
    await loadRecentActivity()
  } catch (error) {
    debug.error('Failed to unblock instance:', error)
    alert('Failed to unblock instance. Check console for details.')
  }
}

const moderateUser = async (user: any, action: string) => {
  try {
    if (action === 'suspend') {
      const reason = prompt('Suspension reason:')
      if (!reason) return

      await adminService.moderateUser(
        user.id,
        'suspend',
        reason,
        authStore.session?.user?.id || ''
      )
      
      // Refresh user list
      await loadUsers()
      await loadRecentActivity()
      debug.log(`User ${user.username} suspended`)
      alert(`User ${user.username} has been suspended.`)
    } else if (action === 'unsuspend') {
      if (!confirm(`Are you sure you want to unsuspend user ${user.username}?`)) {
        return
      }

      await adminService.moderateUser(
        user.id,
        'unsuspend',
        'Admin unsuspend',
        authStore.session?.user?.id || ''
      )
      
      // Refresh user list
      await loadUsers()
      await loadRecentActivity()
      debug.log(`User ${user.username} unsuspended`)
      alert(`User ${user.username} has been unsuspended.`)
    } else if (action === 'delete') {
      if (!confirm(`Are you sure you want to delete user ${user.username}? This cannot be undone.`)) {
        return
      }

      await adminService.moderateUser(
        user.id,
        'delete',
        'Admin deletion',
        authStore.session?.user?.id || ''
      )
      
      // Refresh user list
      await loadUsers()
      await loadRecentActivity()
      debug.log(`User ${user.username} deleted`)
      alert(`User ${user.username} has been deleted.`)
    }
  } catch (error: any) {
    debug.error('Failed to moderate user:', error)
    alert(`Failed to ${action} user: ${error.message || 'Unknown error'}`)
  }
}

const navigateToUserPosts = (user: any) => {
  // Navigate to user's profile/posts
  if (user.domain && user.domain !== import.meta.env.VITE_DOMAIN as string) {
    router.push(`/social/profile/${user.username}@${user.domain}`)
  } else {
    router.push(`/social/profile/${user.username}`)
  }
}

const navigateToUserServers = async (user: AdminUser) => {
  // Open modal and load user's servers
  selectedUserForServers.value = user
  showServersModal.value = true
  loadingServers.value = true
  
  try {
    userServers.value = await adminService.getUserServers(user.id)
  } catch (error) {
    debug.error('Failed to load user servers:', error)
    userServers.value = []
  } finally {
    loadingServers.value = false
  }
}

const closeServersModal = () => {
  showServersModal.value = false
  selectedUserForServers.value = null
  userServers.value = []
}

const navigateToServer = (serverId: string) => {
  closeServersModal()
  router.push(`/chat/${serverId}`)
}

const saveConfig = async () => {
  try {
    // Save configuration to database
    debug.log('Saving configuration...', config.value)
    configChanged.value = false
  } catch (error) {
    debug.error('Failed to save configuration:', error)
  }
}

const saveInstanceBranding = async () => {
  if (!authStore.session?.user?.id) {
    toast.error('You must be logged in to save instance branding')
    return
  }

  savingBranding.value = true
  try {
    // Save instance name
    await adminService.setInstanceConfig(
      'instance_name',
      instanceConfig.value.name,
      authStore.session.user.id,
      'The name of this Harmony instance'
    )

    // Save instance description
    await adminService.setInstanceConfig(
      'instance_description',
      instanceConfig.value.description,
      authStore.session.user.id,
      'Description of this instance'
    )

    instanceBrandingChanged.value = false
    toast.success('Instance branding saved successfully')
    debug.log('Instance branding saved:', instanceConfig.value)
  } catch (error: any) {
    debug.error('Failed to save instance branding:', error)
    toast.error(error.message || 'Failed to save instance branding')
  } finally {
    savingBranding.value = false
  }
}

// Utility functions
const formatUptime = (timestamp: number) => {
  const diff = Date.now() - timestamp
  const days = Math.floor(diff / (24 * 60 * 60 * 1000))
  const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
  return `${days}d ${hours}h`
}

const formatNumber = (num: number | undefined) => {
  if (num === undefined || num === null) return '0'
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}

const formatDate = (date: string) => {
  return new Date(date).toLocaleDateString()
}

const formatTime = (date: Date) => {
  return date.toLocaleTimeString()
}

const getActivityIcon = (type: string) => {
  switch (type) {
    case 'federation': return 'federation'
    case 'security': return 'shield'
    case 'moderation': return 'gavel'
    default: return 'info'
  }
}

// Federation management methods
const refreshFederationData = async () => {
  loadingStates.value.federationStats = true
  try {
    await Promise.all([
      loadInstanceStats(),
      loadFederatedInstances()
    ])
  } catch (error) {
    debug.error('Failed to refresh federation data:', error)
  } finally {
    loadingStates.value.federationStats = false
  }
}

const loadInstanceStats = async () => {
  try {
    const stats = await adminService.getInstanceStats()
    instanceStats.value = stats
  } catch (error) {
    debug.error('Failed to load instance stats:', error)
  }
}

const loadFederatedInstances = async () => {
  loadingStates.value.instances = true
  try {
    const instances = await adminService.getFederatedInstances({
      filter: instanceFilter.value,
      limit: instancePagination.value.limit,
      offset: instancePagination.value.offset,
      search: instanceSearch.value
    })
    federatedInstances.value = instances.instances
    instancePagination.value.total = instances.total
  } catch (error) {
    debug.error('Failed to load federated instances:', error)
  } finally {
    loadingStates.value.instances = false
  }
}

const debouncedSearchInstances = (() => {
  let timeout: NodeJS.Timeout
  return () => {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      instancePagination.value.offset = 0
      loadFederatedInstances()
    }, 300)
  }
})()

const loadPreviousInstances = () => {
  if (instancePagination.value.offset >= instancePagination.value.limit) {
    instancePagination.value.offset -= instancePagination.value.limit
    loadFederatedInstances()
  }
}

const loadNextInstances = () => {
  if (instancePagination.value.offset + instancePagination.value.limit < instancePagination.value.total) {
    instancePagination.value.offset += instancePagination.value.limit
    loadFederatedInstances()
  }
}

const isInstanceInactive = (instance: FederatedInstance) => {
  if (!instance.last_seen_at) return true
  const daysSinceLastSeen = (Date.now() - new Date(instance.last_seen_at).getTime()) / (1000 * 60 * 60 * 24)
  return daysSinceLastSeen > 7
}

const formatRelativeTime = (dateString: string) => {
  if (!dateString) return 'Never'
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`
  return `${Math.floor(diffDays / 30)} months ago`
}

const refreshInstance = async (instanceId: string) => {
  try {
    await adminService.refreshInstanceInfo(instanceId)
    await loadFederatedInstances()
  } catch (error) {
    debug.error('Failed to refresh instance:', error)
    alert('Failed to refresh instance info')
  }
}

const toggleInstanceTrust = async (instanceId: string, trusted: boolean) => {
  try {
    await adminService.updateInstanceTrust(instanceId, trusted, authStore.session?.user?.id || '')
    await loadFederatedInstances()
    await loadInstanceStats()
  } catch (error) {
    debug.error('Failed to update instance trust:', error)
    alert('Failed to update instance trust')
  }
}

const toggleInstanceBlock = async (instanceId: string, blocked: boolean) => {
  try {
    const reason = blocked ? prompt('Block reason:') || 'Admin decision' : 'Admin unblock'
    await adminService.updateInstanceBlock(instanceId, blocked, reason, authStore.session?.user?.id || '')
    await loadFederatedInstances()
    await loadInstanceStats()
  } catch (error) {
    debug.error('Failed to update instance block status:', error)
    alert('Failed to update instance block status')
  }
}

const deleteInstance = async (instanceId: string) => {
  if (!confirm('Are you sure you want to delete this instance? This will remove all federation data.')) {
    return
  }
  
  try {
    await adminService.deleteInstance(instanceId, authStore.session?.user?.id || '')
    await loadFederatedInstances()
    await loadInstanceStats()
  } catch (error) {
    debug.error('Failed to delete instance:', error)
    alert('Failed to delete instance')
  }
}

const loadDiscoveredInstances = async () => {
  try {
    const discovered = await adminService.getDiscoveredInstances()
    discoveredInstances.value = discovered
  } catch (error) {
    debug.error('Failed to load discovered instances:', error)
  }
}

const addDiscoveredInstance = async (domain: string) => {
  try {
    await adminService.addInstanceFromDomain(domain, false, authStore.session?.user?.id || '')
    await loadFederatedInstances()
    await loadInstanceStats()
    // Remove from discovered list
    discoveredInstances.value = discoveredInstances.value.filter(i => i.domain !== domain)
  } catch (error) {
    debug.error('Failed to add discovered instance:', error)
    alert('Failed to add instance')
  }
}

const discoverInstance = async () => {
  if (!newInstanceDomain.value) return
  
  loadingStates.value.discovering = true
  try {
    const result = await adminService.discoverInstance(newInstanceDomain.value)
    discoveryResult.value = result
  } catch (error) {
    debug.error('Failed to discover instance:', error)
    alert('Failed to discover instance. Check if the domain is valid and supports ActivityPub.')
  } finally {
    loadingStates.value.discovering = false
  }
}

const addInstanceFromDiscovery = async () => {
  if (!discoveryResult.value) return
  
  try {
    await adminService.addInstanceFromDomain(
      discoveryResult.value.domain, 
      addAsTrusted.value,
      authStore.session?.user?.id || ''
    )
    await loadFederatedInstances()
    await loadInstanceStats()
    
    // Reset form
    newInstanceDomain.value = ''
    discoveryResult.value = null
    addAsTrusted.value = false
    
    alert('Instance added successfully!')
  } catch (error) {
    debug.error('Failed to add instance:', error)
    alert('Failed to add instance')
  }
}

// Handle Add Instance button click
const handleAddInstance = () => {
  // Switch to search tab and focus on input
  discoveryTab.value = 'search'
  // Reset form state
  newInstanceDomain.value = ''
  discoveryResult.value = null
  addAsTrusted.value = false
}
</script>

<style scoped>
.admin-panel {
  padding: 24px;
  background: var(--background-primary);
  min-height: 100vh;
  color: var(--text-primary);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  overflow-y: auto;
}

.admin-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 32px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}

.admin-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.admin-title h1 {
  font-size: 28px;
  font-weight: 700;
  margin: 0;
  background: linear-gradient(135deg, #00d4ff, #00ff88);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.system-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  border-radius: 16px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.system-status.healthy {
  background: rgba(0, 255, 136, 0.1);
  color: #00ff88;
  border: 1px solid rgba(0, 255, 136, 0.3);
}

.system-status.warning {
  background: rgba(255, 193, 7, 0.1);
  color: #ffc107;
  border: 1px solid rgba(255, 193, 7, 0.3);
}

.system-status.error {
  background: rgba(255, 69, 58, 0.1);
  color: #ff453a;
  border: 1px solid rgba(255, 69, 58, 0.3);
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.admin-actions {
  display: flex;
  gap: 12px;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.action-btn:hover {
  background: var(--background-tertiary);
  border-color: var(--accent-color);
  transform: translateY(-1px);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.admin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(600px, 1fr));
  gap: 24px;
}

.admin-module {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
  transition: all 0.3s ease;
}

.admin-module:hover {
  border-color: var(--accent-color);
  box-shadow: 0 8px 32px rgba(0, 212, 255, 0.1);
  transform: translateY(-2px);
}

.module-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 24px;
  background: linear-gradient(135deg, rgba(0, 212, 255, 0.05), rgba(0, 255, 136, 0.05));
  border-bottom: 1px solid var(--border-color);
}

.module-header h2 {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
  flex: 1;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  padding: 24px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  background: var(--background-tertiary);
  border: 1px solid rgba(0, 212, 255, 0.2);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.stat-card:hover {
  border-color: var(--accent-color);
  box-shadow: 0 4px 16px rgba(0, 212, 255, 0.1);
}

.stat-icon {
  padding: 12px;
  background: linear-gradient(135deg, rgba(0, 212, 255, 0.1), rgba(0, 255, 136, 0.1));
  border-radius: 8px;
  color: #00d4ff;
}

.stat-content {
  flex: 1;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.stat-label {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.stat-change {
  font-size: 12px;
  font-weight: 500;
}

.stat-change.positive {
  color: #00ff88;
}

/* Federation Module */
.federation-content {
  padding: 24px;
}

.federation-section {
  margin-bottom: 32px;
}

.federation-section h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--text-primary);
}

.setting-group {
  margin-bottom: 16px;
}

.setting-group label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.cyber-input, .cyber-textarea, .cyber-select {
  width: 100%;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
  transition: all 0.2s ease;
}

.cyber-input:focus, .cyber-textarea:focus, .cyber-select:focus {
  outline: none;
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px rgba(0, 212, 255, 0.1);
}

.cyber-textarea {
  resize: vertical;
  min-height: 80px;
}

.setting-row {
  display: flex;
  gap: 24px;
  align-items: center;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  cursor: pointer;
}

.toggle-label input[type="checkbox"] {
  display: none;
}

.toggle-slider {
  position: relative;
  width: 44px;
  height: 24px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 24px;
  transition: all 0.2s ease;
}

.toggle-slider:before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  background: var(--text-secondary);
  border-radius: 50%;
  transition: all 0.2s ease;
}

.toggle-label input[type="checkbox"]:checked + .toggle-slider {
  background: var(--accent-color);
  border-color: var(--accent-color);
}

.toggle-label input[type="checkbox"]:checked + .toggle-slider:before {
  left: 22px;
  background: white;
}

/* Blocked Instances */
.blocked-instances {
  space-y: 16px;
}

.blocked-instance {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: var(--background-tertiary);
  border: 1px solid rgba(255, 69, 58, 0.2);
  border-radius: 8px;
  margin-bottom: 12px;
}

.instance-info .domain {
  font-weight: 600;
  color: var(--text-primary);
}

.instance-info .reason {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.unblock-btn {
  padding: 8px 12px;
  background: rgba(255, 69, 58, 0.1);
  border: 1px solid rgba(255, 69, 58, 0.3);
  border-radius: 6px;
  color: #ff453a;
  cursor: pointer;
  transition: all 0.2s ease;
}

/* Federation Management Styles */
.module-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.primary-btn, .primary-btn-sm {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--accent-color);
  border: none;
  border-radius: 6px;
  color: white;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.primary-btn-sm {
  padding: 6px 12px;
  font-size: 12px;
}

.primary-btn:hover, .primary-btn-sm:hover {
  background: #0099cc;
  transform: translateY(-1px);
}

.federation-module {
  grid-column: 1 / -1; /* Span full width */
}

.federation-section {
  padding: 24px;
  border-bottom: 1px solid var(--border-color);
}

.federation-section:last-child {
  border-bottom: none;
}

.federation-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  padding: 24px;
  border-bottom: 1px solid var(--border-color);
}

.section-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.filter-controls {
  display: flex;
  gap: 12px;
  align-items: center;
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  color: var(--text-secondary);
}

.loading-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-color);
  border-top: 2px solid var(--accent-color);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.instance-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.instance-item {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.instance-item:hover {
  border-color: var(--accent-color);
}

.instance-item.blocked {
  border-color: rgba(255, 69, 58, 0.5);
  background: rgba(255, 69, 58, 0.05);
}

.instance-item.trusted {
  border-color: rgba(0, 255, 136, 0.5);
  background: rgba(0, 255, 136, 0.05);
}

.instance-item.inactive {
  opacity: 0.6;
}

.instance-main {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 16px;
}

.instance-info {
  flex: 1;
}

.instance-domain {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.instance-badges {
  display: flex;
  gap: 6px;
}

.badge {
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.badge.trusted {
  background: rgba(0, 255, 136, 0.2);
  color: #00ff88;
}

.badge.blocked {
  background: rgba(255, 69, 58, 0.2);
  color: #ff453a;
}

.badge.inactive {
  background: rgba(156, 163, 175, 0.2);
  color: #9ca3af;
}

.badge.success {
  background: rgba(0, 255, 136, 0.2);
  color: #00ff88;
}

.badge.info {
  background: rgba(0, 212, 255, 0.2);
  color: #00d4ff;
}

.instance-details {
  display: flex;
  gap: 16px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.detail-item {
  white-space: nowrap;
}

.instance-description {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.4;
  max-width: 400px;
}

.instance-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.action-btn-sm, .danger-btn-sm {
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--background-tertiary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.action-btn-sm:hover {
  border-color: var(--accent-color);
  color: var(--accent-color);
}

.action-btn-sm.trusted {
  border-color: rgba(0, 255, 136, 0.5);
  color: #00ff88;
}

.danger-btn-sm:hover {
  border-color: rgba(255, 69, 58, 0.5);
  color: #ff453a;
}

.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  padding: 20px;
  border-top: 1px solid var(--border-color);
}

.pagination-btn {
  padding: 8px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.pagination-btn:hover:not(:disabled) {
  border-color: var(--accent-color);
  color: var(--accent-color);
}

.pagination-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pagination-info {
  color: var(--text-secondary);
  font-size: 14px;
}

.discovery-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 20px;
  background: var(--background-tertiary);
  border-radius: 8px;
  padding: 4px;
}

.tab-btn {
  flex: 1;
  padding: 8px 16px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.tab-btn.active {
  background: var(--accent-color);
  color: white;
}

.discovery-content {
  min-height: 200px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 40px;
  text-align: center;
  color: var(--text-secondary);
}

.discovered-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.discovered-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.discovered-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.interaction-count {
  font-size: 12px;
  color: var(--text-secondary);
}

.search-form {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}

.search-form input {
  flex: 1;
}

.discovery-result {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: var(--background-tertiary);
  border-bottom: 1px solid var(--border-color);
}

.result-header h4 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.result-badges {
  display: flex;
  gap: 8px;
}

.result-details {
  padding: 16px;
}

.detail-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 14px;
}

.detail-row strong {
  min-width: 80px;
  color: var(--text-secondary);
}

.result-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: var(--background-tertiary);
  border-top: 1px solid var(--border-color);
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
}

.spinning {
  animation: spin 1s linear infinite;
}

/* Users Module */
.users-content {
  padding: 24px;
}

.user-filters {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
}

.filter-btn {
  padding: 8px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.filter-btn:hover, .filter-btn.active {
  background: var(--accent-color);
  border-color: var(--accent-color);
  color: white;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
}

.search-bar .cyber-input {
  padding-left: 36px;
  max-width: 200px;
}

.search-bar .icon {
  position: absolute;
  left: 12px;
  color: var(--text-secondary);
}

.users-list {
  space-y: 12px;
}

.user-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
  margin: 8px 0;
}

.user-item:hover {
  border-color: var(--accent-color);
}

.user-info {
  flex: 1;
}

.user-name {
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.user-meta {
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  gap: 12px;
  align-items: center;
}

.user-stats {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary);
}

.user-stat {
  background: none;
  border: none;
  color: inherit;
  font-size: inherit;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: all 0.2s ease;
}

.user-stat.clickable:hover {
  background: rgba(0, 212, 255, 0.1);
  color: #00d4ff;
  transform: translateY(-1px);
}

.user-actions {
  display: flex;
  gap: 8px;
}

.mod-btn {
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--background-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.mod-btn:hover {
  border-color: var(--accent-color);
  color: var(--text-primary);
}

.suspend-btn:hover {
  border-color: #ffc107;
  color: #ffc107;
}

.delete-btn:hover {
  border-color: #ff453a;
  color: #ff453a;
}

.unsuspend-btn {
  border-color: rgba(0, 255, 136, 0.3);
  color: #00ff88;
}

.unsuspend-btn:hover {
  border-color: #00ff88;
  background: rgba(0, 255, 136, 0.1);
}

/* Suspended user styling */
.user-item.user-suspended {
  opacity: 0.25;
  background: rgba(255, 193, 7, 0.05);
  border-color: rgba(255, 193, 7, 0.3);
}

.user-name {
  display: flex;
  align-items: center;
  gap: 8px;
}

.user-name .badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
  text-transform: uppercase;
}

.badge.suspended {
  background: rgba(255, 193, 7, 0.2);
  color: #ffc107;
}

.badge.admin {
  background: rgba(0, 212, 255, 0.2);
  color: #00d4ff;
}

.suspension-reason {
  font-style: italic;
  color: #ffc107;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Health Module */
.health-metrics {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  padding: 24px;
}

.metric-card {
  padding: 20px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.metric-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
}

.metric-status {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.metric-status.healthy {
  background: #00ff88;
}

.metric-status.warning {
  background: #ffc107;
}

.metric-status.error {
  background: #ff453a;
}

.metric-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.metric-detail {
  font-size: 12px;
  color: var(--text-secondary);
}

/* Activity Module */
.activity-feed {
  padding: 24px;
  max-height: 400px;
  overflow-y: auto;
}

.activity-item {
  display: flex;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 1px solid var(--border-color);
}

.activity-item:last-child {
  border-bottom: none;
}

.activity-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  font-size: 14px;
}

.activity-icon.federation {
  background: rgba(0, 212, 255, 0.1);
  color: #00d4ff;
}

.activity-icon.security {
  background: rgba(255, 193, 7, 0.1);
  color: #ffc107;
}

.activity-icon.moderation {
  background: rgba(255, 69, 58, 0.1);
  color: #ff453a;
}

.activity-content {
  flex: 1;
}

.activity-message {
  font-size: 14px;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.activity-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-secondary);
}

/* Emoji Importer Module */
.emoji-module {
  grid-column: span 2; /* Full width like other major modules */
  max-height: 1130px;
}

.emoji-content {
  padding: 0;
  overflow-y: auto;
}

/* Performance Monitoring Module */
.performance-module {
  grid-column: 1 / -1; /* Full width */
}

.performance-content {
  padding: 0;
  max-height: 800px;
  overflow-y: auto;
}

/* Configuration Module */
.config-sections {
  padding: 24px;
}

.config-section {
  margin-bottom: 32px;
}

.config-section h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--text-primary);
}

.save-btn {
  padding: 8px 16px;
  background: var(--accent-color);
  border: none;
  border-radius: 6px;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.save-btn:hover {
  background: #0099cc;
  transform: translateY(-1px);
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

/* Responsive Design */
@media (max-width: 1200px) {
  .admin-grid {
    grid-template-columns: 1fr;
  }
  
  .stats-grid {
    grid-template-columns: 1fr;
  }
  
  .health-metrics {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .admin-panel {
    padding: 16px;
  }
  
  .admin-header {
    flex-direction: column;
    gap: 16px;
    align-items: flex-start;
  }
  
  .admin-title {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }
  
  .add-block {
    flex-direction: column;
  }
  
  .user-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .user-actions {
    align-self: flex-end;
  }
}

/* Modal Styles */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}

.modal-content {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  max-width: 600px;
  width: 90%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
  background: linear-gradient(135deg, rgba(0, 212, 255, 0.05), rgba(0, 255, 136, 0.05));
}

.modal-header h3 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 18px;
  font-weight: 600;
}

.close-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s ease;
}

.close-btn:hover {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.modal-body {
  padding: 24px;
  overflow-y: auto;
  flex: 1;
}

.servers-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.server-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.server-item:hover {
  border-color: var(--accent-color);
}

.server-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
}

.server-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.server-icon-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, rgba(0, 212, 255, 0.2), rgba(0, 255, 136, 0.2));
  color: var(--accent-color);
  font-size: 20px;
  font-weight: 700;
}

.server-info {
  flex: 1;
  min-width: 0;
}

.server-name {
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge.owner {
  background: rgba(255, 193, 7, 0.2);
  color: #ffc107;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
  text-transform: uppercase;
}

.server-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary);
}

.member-count {
  display: flex;
  align-items: center;
  gap: 4px;
}

.server-actions {
  flex-shrink: 0;
}

/* Dark theme variables (these should be in your global CSS) */
:root {
  --background-primary: #1a1a1a;
  --background-secondary: #2a2a2a;
  --background-tertiary: #3a3a3a;
  --text-primary: #ffffff;
  --text-secondary: #b0b0b0;
  --border-color: #404040;
  --accent-color: #00d4ff;
}
</style> 