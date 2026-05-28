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
              <span>Database Size</span>
              <div class="metric-status healthy"></div>
            </div>
            <div class="metric-value">{{ systemHealth.storage.total }}</div>
            <div class="metric-detail">total size</div>
          </div>
          <div class="metric-card placeholder-metric">
            <div class="metric-header">
              <span>Memory</span>
              <div class="metric-status healthy"></div>
            </div>
            <div class="metric-value">--</div>
            <div class="metric-detail">not available via Supabase</div>
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

        <!-- Endpoint Health Stats -->
        <div class="federation-section" v-if="federationStats">
          <div class="section-header">
            <h3>Endpoint Health</h3>
            <div class="health-indicator" :class="getEndpointHealthClass(federationStats.endpoint_health)">
              {{ federationStats.endpoint_health.success_rate }}% success rate
            </div>
          </div>
          <div class="federation-stats">
            <div class="stat-card">
              <div class="stat-value">{{ formatNumber(federationStats.endpoint_health.total_endpoints) }}</div>
              <div class="stat-label">Total Endpoints</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" :class="{ 'error-text': federationStats.endpoint_health.dead_endpoints > 0 }">
                {{ formatNumber(federationStats.endpoint_health.dead_endpoints) }}
              </div>
              <div class="stat-label">Dead Endpoints</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">{{ formatNumber(federationStats.endpoint_health.healthy_endpoints) }}</div>
              <div class="stat-label">Healthy</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">{{ formatNumber(federationStats.endpoint_health.endpoints_with_failures) }}</div>
              <div class="stat-label">With Failures</div>
            </div>
          </div>
          <div class="endpoint-details" v-if="federationStats.endpoint_health.dead_endpoints > 0">
            <div class="warning-banner">
              <Icon name="alert-triangle" :size="16" />
              <span>{{ federationStats.endpoint_health.dead_endpoints }} endpoint(s) marked as dead and removed from follows</span>
              <button
                class="danger-btn purge-btn"
                :disabled="loadingStates.purgingDead"
                @click="purgeDeadEndpoints"
              >
                <Icon v-if="!loadingStates.purgingDead" name="trash" :size="14" />
                <span v-if="loadingStates.purgingDead" class="spinner-small"></span>
                Purge All
              </button>
            </div>
            <div class="dead-endpoints-list" v-if="deadEndpointsList.length > 0">
              <div
                v-for="ep in deadEndpointsList"
                :key="ep.id"
                class="dead-endpoint-row"
              >
                <div class="dead-endpoint-info">
                  <div class="dead-endpoint-url" :title="ep.endpoint_url">{{ ep.endpoint_url }}</div>
                  <div class="dead-endpoint-meta">
                    <span class="meta-tag domain">{{ ep.domain }}</span>
                    <span class="meta-tag" v-if="ep.last_http_status">HTTP {{ ep.last_http_status }}</span>
                    <span class="meta-tag failures">{{ ep.total_failures }} failures</span>
                    <span class="meta-tag" v-if="ep.last_failure_at">Last fail: {{ formatTimeAgo(ep.last_failure_at) }}</span>
                  </div>
                  <div class="dead-endpoint-error" v-if="ep.last_error_message" :title="ep.last_error_message">
                    {{ ep.last_error_message }}
                  </div>
                </div>
                <button
                  class="purge-single-btn"
                  :disabled="purgingEndpointIds.has(ep.id)"
                  @click="purgeSingleEndpoint(ep)"
                  title="Remove this endpoint"
                >
                  <span v-if="purgingEndpointIds.has(ep.id)" class="spinner-small"></span>
                  <Icon v-else name="trash" :size="14" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Federation Maintenance -->
        <div class="federation-section">
          <div class="section-header-row">
            <h3>Federation Maintenance</h3>
            <button @click="refreshKeyConsistency" class="action-btn" :disabled="loadingStates.keyConsistency">
              <Icon name="refresh-cw" :size="16" />
            </button>
          </div>
          
          <!-- Key Consistency Report -->
          <div class="maintenance-status" v-if="keyConsistency">
            <div class="status-indicator" :class="keyConsistency.status">
              <Icon :name="keyConsistency.status === 'ok' ? 'check-circle' : 'alert-triangle'" :size="16" />
              <span v-if="keyConsistency.status === 'ok'">All local users have valid key pairs</span>
              <span v-else>
                {{ keyConsistency.users_missing_keys }} user(s) missing keys, 
                {{ keyConsistency.users_with_inconsistent_keys }} with inconsistent state
              </span>
            </div>
          </div>
          
          <!-- Maintenance Actions -->
          <div class="maintenance-actions">
            <div class="maintenance-card">
              <div class="maintenance-info">
                <h4>Key Generation Sweep</h4>
                <p>Generate missing RSA keys for local users who don't have them</p>
              </div>
              <button 
                @click="runKeyGenerationSweep" 
                class="action-btn primary"
                :disabled="loadingStates.keySweep"
              >
                <Icon v-if="loadingStates.keySweep" name="loader" :size="16" class="spin" />
                <Icon v-else name="key" :size="16" />
                Run Sweep
              </button>
            </div>
            
            <div class="maintenance-card">
              <div class="maintenance-info">
                <h4>Orphan Cleanup</h4>
                <p>Fix users with inconsistent key states (public without private or vice versa)</p>
              </div>
              <button 
                @click="runOrphanCleanup" 
                class="action-btn"
                :disabled="loadingStates.orphanCleanup"
              >
                <Icon v-if="loadingStates.orphanCleanup" name="loader" :size="16" class="spin" />
                <Icon v-else name="trash-2" :size="16" />
                Run Cleanup
              </button>
            </div>
          </div>
          
          <!-- Scheduled Jobs Info -->
          <div class="scheduled-info">
            <Icon name="clock" :size="14" />
            <span>Maintenance jobs run automatically: Key sweep at 03:00 UTC, Orphan cleanup at 04:00 UTC</span>
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
                  <DisplayName :user-id="user.id" :fallback="user.display_name || user.username" />
                  <span v-if="user.is_suspended" class="badge suspended">Suspended</span>
                  <span v-if="user.is_admin" class="badge admin">Admin</span>
                  <span v-if="user.is_moderator && !user.is_admin" class="badge moderator">Mod</span>
                  <span v-if="user.force_sensitive" class="badge sensitive" title="All media from this user is force-marked sensitive">F-Sensitive</span>
                  <span v-if="user.is_silenced" class="badge silenced" title="This user is silenced (hidden from public timelines)">Silenced</span>
                </div>
                <div class="user-meta">
                  {{ user.handle }}
                  <span class="user-joined">Joined {{ formatDate(user.created_at) }}</span>
                  <span v-if="user.is_suspended && user.suspension_reason" class="suspension-reason">
                    - {{ user.suspension_reason }}
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
                  v-if="!user.is_admin"
                  @click="toggleModerator(user)"
                  class="mod-btn"
                  :class="user.is_moderator ? 'demote-btn' : 'promote-btn'"
                  :title="user.is_moderator ? 'Remove Moderator' : 'Make Moderator'"
                >
                  <Icon :name="user.is_moderator ? 'shield-off' : 'shield'" :size="16" />
                </button>
                <button
                  @click="moderateUser(user, user.force_sensitive ? 'unforce_sensitive' : 'force_sensitive')"
                  class="mod-btn"
                  :class="user.force_sensitive ? 'unsuspend-btn' : 'warning-btn'"
                  :title="user.force_sensitive ? 'Remove force-sensitive' : 'Force all media as sensitive'"
                >
                  <Icon :name="user.force_sensitive ? 'eye' : 'eye-off'" :size="16" />
                </button>
                <button
                  @click="moderateUser(user, user.is_silenced ? 'unsilence' : 'silence')"
                  class="mod-btn"
                  :class="user.is_silenced ? 'unsuspend-btn' : 'warning-btn'"
                  :title="user.is_silenced ? 'Remove silence' : 'Silence (hide from public timelines)'"
                >
                  <Icon :name="user.is_silenced ? 'volume-2' : 'volume-x'" :size="16" />
                </button>
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

        <!-- User Pagination -->
        <div v-if="userPagination.total > userPagination.limit" class="pagination">
          <button
            @click="loadPreviousUsers"
            :disabled="userPagination.offset === 0"
            class="pagination-btn"
          >Previous</button>
          <span class="pagination-info">
            {{ userPagination.offset + 1 }}–{{ Math.min(userPagination.offset + userPagination.limit, userPagination.total) }}
            of {{ userPagination.total }}
          </span>
          <button
            @click="loadNextUsers"
            :disabled="userPagination.offset + userPagination.limit >= userPagination.total"
            class="pagination-btn"
          >Next</button>
        </div>
      </div>

      <!-- Reports & Moderation -->
      <div class="admin-module reports-module">
        <div class="module-header">
          <Icon name="flag" :size="20" />
          <h2>Reports & Moderation</h2>
          <span v-if="pendingReportsCount > 0" class="reports-badge">{{ pendingReportsCount }} pending</span>
        </div>

        <div class="report-filters">
          <button
            v-for="filter in reportFilters"
            :key="filter.key"
            @click="activeReportFilter = filter.key"
            :class="['filter-btn', { active: activeReportFilter === filter.key }]"
          >
            {{ filter.label }}
          </button>
        </div>

        <div class="reports-list" v-if="reports.length > 0">
          <div
            v-for="report in reports"
            :key="report.id"
            class="report-item"
            :class="{ expanded: expandedReportId === report.id }"
            @click="toggleReportExpand(report.id)"
          >
            <div class="report-summary">
              <div class="report-type-badge" :class="report.report_type">
                {{ report.report_type }}
              </div>
              <div class="report-users">
                <div class="report-reporter">
                  <Avatar :src="report.reporter_avatar_url" :alt="report.reporter_username" size="xs" />
                  <span class="report-user-link" @click.stop="navigateToReportUser(report, 'reporter')">
                    <DisplayName v-if="report.reporter_id" :user-id="(report.reporter_id ?? undefined)" :fallback="(report.reporter_display_name || report.reporter_username) ?? undefined" />
                    <template v-else>{{ report.reporter_display_name || report.reporter_username }}</template>
                    <span v-if="!report.reporter_is_local && report.reporter_domain" class="federation-badge" title="Federated user">
                      @{{ report.reporter_domain }}
                    </span>
                  </span>
                </div>
                <span class="report-arrow">&#8594;</span>
                <div class="report-reported" v-if="report.reported_user_id || report.reported_user_username">
                  <Avatar :src="report.reported_user_avatar_url" :alt="report.reported_user_username ?? undefined" size="xs" />
                  <span class="report-user-link" @click.stop="navigateToReportUser(report, 'reported')">
                    <DisplayName v-if="report.reported_user_id" :user-id="(report.reported_user_id ?? undefined)" :fallback="(report.reported_user_display_name || report.reported_user_username) ?? undefined" />
                    <template v-else>{{ report.reported_user_display_name || report.reported_user_username }}</template>
                    <span v-if="!report.reported_user_is_local && report.reported_user_domain" class="federation-badge" title="Federated user">
                      @{{ report.reported_user_domain }}
                    </span>
                  </span>
                  <a
                    v-if="!report.reported_user_is_local && report.reported_user_domain"
                    :href="`https://${report.reported_user_domain}/@${report.reported_user_username}`"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="report-external-link"
                    title="View on remote instance"
                    @click.stop
                  >
                    <Icon name="external-link" :size="14" />
                  </a>
                </div>
              </div>
              <div class="report-reason">{{ report.reason }}</div>
              <div class="report-meta">
                <span v-if="report.source !== 'local'" class="report-source federation-badge">{{ report.source_instance || report.source }}</span>
                <span v-else class="report-source-local">local</span>
                <time class="report-time">{{ formatDate(report.created_at) }}</time>
              </div>
              <div class="report-status-badge" :class="report.status">{{ report.status }}</div>
            </div>

            <div v-if="expandedReportId === report.id" class="report-detail" @click.stop>
              <div v-if="report.comment" class="report-comment">
                <label>Reporter's comment</label>
                <p>{{ report.comment }}</p>
              </div>

              <div v-if="report.reported_message_preview" class="report-proof">
                <label>Reported message</label>
                <blockquote v-html="linkifyReportPreview(report.reported_message_preview)"></blockquote>
              </div>

              <div v-if="report.reported_post_preview" class="report-proof">
                <label>Reported post</label>
                <blockquote v-html="linkifyReportPreview(report.reported_post_preview)"></blockquote>
                <div class="report-post-meta">
                  <span v-if="report.reported_post_is_sensitive" class="badge sensitive">Sensitive</span>
                  <span v-if="report.reported_post_content_warning" class="badge cw">CW: {{ report.reported_post_content_warning }}</span>
                </div>
                <div class="report-post-links">
                  <button
                    v-if="report.reported_post_id"
                    class="report-link-btn"
                    @click.stop="navigateToPost(report.reported_post_id!)"
                  >
                    <Icon name="eye" :size="14" /> View post
                  </button>
                  <a
                    v-if="report.reported_post_url || report.reported_post_ap_id"
                    :href="report.reported_post_url || report.reported_post_ap_id!"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="report-link-btn"
                    @click.stop
                  >
                    <Icon name="external-link" :size="14" /> View on remote instance
                  </a>
                </div>
              </div>

              <div v-if="report.resolution_note" class="report-resolution">
                <label>Resolution note</label>
                <p>{{ report.resolution_note }}</p>
              </div>

              <div v-if="report.status === 'pending' || report.status === 'investigating'" class="report-actions-panel">
                <div class="report-punitive-actions">
                  <button
                    v-if="report.reported_post_id"
                    class="report-action-btn warning"
                    @click.stop="markPostSensitive(report)"
                  >{{ report.reported_post_is_sensitive ? 'Unmark Sensitive' : 'Mark Sensitive' }}</button>
                  <button
                    v-if="report.reported_post_id"
                    class="report-action-btn warning"
                    @click.stop="setPostContentWarning(report)"
                  >{{ report.reported_post_content_warning ? 'Edit CW' : 'Add CW' }}</button>
                  <button
                    v-if="report.reported_post_id"
                    class="report-action-btn danger"
                    @click.stop="deleteReportedPost(report)"
                  >Delete Post</button>
                  <button
                    v-if="report.reported_message_id"
                    class="report-action-btn danger"
                    @click.stop="deleteReportedMessage(report)"
                  >Delete Message</button>
                  <button
                    v-if="extractStorageUrls(report).length > 0"
                    class="report-action-btn danger"
                    @click.stop="deleteReportedMedia(report)"
                  >Delete Media ({{ extractStorageUrls(report).length }})</button>
                </div>
                <div class="report-punitive-actions">
                  <button
                    v-if="report.reported_user_id"
                    class="report-action-btn warning"
                    @click.stop="forceSensitiveReportedUser(report)"
                  >Force Sensitive Account</button>
                  <button
                    v-if="report.reported_user_id"
                    class="report-action-btn warning"
                    @click.stop="silenceReportedUser(report)"
                  >Silence Account</button>
                  <button
                    v-if="report.reported_user_id"
                    class="report-action-btn danger"
                    @click.stop="suspendReportedUser(report)"
                  >Suspend User</button>
                </div>

                <textarea
                  v-model="reportResolutionNote"
                  placeholder="Add resolution notes..."
                  class="cyber-input resolution-textarea"
                  rows="2"
                  @click.stop
                ></textarea>
                <label class="toggle-label report-show-resolver" title="If checked, the reporter will see who resolved this (default off for harassment/backlash prevention)">
                  <input type="checkbox" v-model="reportShowResolver" @click.stop />
                  <span class="toggle-slider"></span>
                  <span>Show my name to reporter</span>
                </label>
                <div class="report-action-buttons">
                  <button
                    v-if="report.status === 'pending'"
                    class="report-action-btn investigating"
                    @click.stop="updateReport(report.id, 'investigating')"
                  >Mark Investigating</button>
                  <button
                    class="report-action-btn resolve"
                    @click.stop="updateReport(report.id, 'resolved')"
                  >Resolve</button>
                  <button
                    class="report-action-btn dismiss"
                    @click.stop="updateReport(report.id, 'dismissed')"
                  >Dismiss</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="reports-empty">
          <Icon name="check-circle" :size="32" />
          <p>No reports{{ activeReportFilter !== 'all' ? ` with status "${activeReportFilter}"` : '' }}</p>
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
          <div v-for="event in filteredRecentActivity" :key="event.id" class="activity-item">
            <div class="activity-icon" :class="getActivityCategory(event.type)">
              <Icon :name="getActivityIcon(event.type)" :size="16" />
            </div>
            <div class="activity-content">
              <div class="activity-message">{{ formatActivityMessage(event) }}</div>
              <div class="activity-meta">
                <span class="activity-time">{{ formatTime(event.timestamp) }}</span>
                <span class="activity-source">{{ event.source }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Announcements -->
      <div class="admin-module announcements-module">
        <div class="module-header">
          <Icon name="message-square" :size="20" />
          <h2>Announcements</h2>
          <button @click="showAnnouncementForm = true" class="primary-btn-sm">
            <Icon name="plus" :size="14" />
            Create
          </button>
        </div>
        <p class="module-hint">Instance-wide announcements shown to users. Create and manage them here.</p>
        <div v-if="showAnnouncementForm" class="announcement-form">
          <h4>{{ editingAnnouncementId ? 'Edit' : 'New' }} Announcement</h4>
          <div class="form-row">
            <label>Title</label>
            <input v-model="announcementForm.title" class="cyber-input" placeholder="Announcement title" />
          </div>
          <div class="form-row">
            <label>Content (supports basic HTML)</label>
            <textarea v-model="announcementForm.content" class="cyber-input" rows="4" placeholder="Announcement content"></textarea>
          </div>
          <div class="form-row">
            <label>Icon (emoji or name: info, warning, megaphone)</label>
            <input v-model="announcementForm.icon" class="cyber-input" placeholder="info" />
          </div>
          <div class="form-row">
            <label>Image URL (optional)</label>
            <input v-model="announcementForm.image_url" class="cyber-input" type="url" placeholder="https://..." />
          </div>
          <div class="form-row two-col">
            <div>
              <label>Starts at (optional)</label>
              <input
                v-model="announcementForm.starts_at"
                class="cyber-input"
                type="datetime-local"
              />
              <p class="form-hint">Leave empty to publish immediately. Times are interpreted in your local timezone.</p>
            </div>
            <div>
              <label>Ends at (optional)</label>
              <input
                v-model="announcementForm.ends_at"
                class="cyber-input"
                type="datetime-local"
                :min="announcementForm.starts_at || undefined"
              />
              <p class="form-hint">Leave empty for no expiration. After this time the announcement is hidden from users automatically.</p>
            </div>
          </div>
          <div class="form-row checks">
            <label class="toggle-label">
              <input type="checkbox" v-model="announcementForm.is_pinned" />
              <span class="toggle-slider"></span>
              <span class="toggle-text">Pinned</span>
            </label>
            <label class="toggle-label">
              <input type="checkbox" v-model="announcementForm.show_popup" />
              <span class="toggle-slider"></span>
              <span class="toggle-text">Show popup</span>
            </label>
            <label class="toggle-label" v-if="editingAnnouncementId">
              <input type="checkbox" v-model="announcementForm.is_active" />
              <span class="toggle-slider"></span>
              <span class="toggle-text">Active</span>
            </label>
          </div>
          <div class="form-actions">
            <button @click="saveAnnouncement" class="primary-btn-sm" :disabled="!announcementForm.title || !announcementForm.content">
              {{ editingAnnouncementId ? 'Update' : 'Create' }}
            </button>
            <button @click="cancelAnnouncementForm" class="cyber-btn-sm">Cancel</button>
          </div>
        </div>
        <div class="announcements-list">
          <div v-for="a in announcements" :key="a.id" class="announcement-item">
            <div class="announcement-meta">
              <span class="announcement-icon">{{ getAnnouncementIcon(a.icon) }}</span>
              <span class="announcement-title">{{ a.title }}</span>
              <span v-if="a.is_pinned" class="badge">Pinned</span>
              <span v-if="!a.is_active" class="badge inactive">Inactive</span>
            </div>
            <div class="announcement-actions">
              <button @click="editAnnouncement(a)" class="action-btn-sm" title="Edit">
                <Icon name="edit" :size="14" />
              </button>
              <button @click="deleteAnnouncement(a.id)" class="danger-btn-sm" title="Delete">
                <Icon name="trash" :size="14" />
              </button>
            </div>
          </div>
          <div v-if="announcements.length === 0 && !loadingStates.announcements" class="empty-state">
            No announcements. Create one to notify users.
          </div>
        </div>
      </div>

      <!-- Featured Communities -->
      <div class="admin-module featured-module">
        <div class="module-header">
          <Icon name="star" :size="20" />
          <h2>Featured Communities</h2>
          <button @click="loadFeaturedServers" class="action-btn" :disabled="loadingStates.featuredServers">
            <Icon v-if="loadingStates.featuredServers" name="loader" :size="16" class="spin" />
            <Icon v-else name="refresh-cw" :size="16" />
            Refresh
          </button>
        </div>
        <p class="module-hint">Pin public servers to the top of the community discovery page. Featured servers appear first.</p>
        <div v-if="loadingStates.featuredServers" class="loading-state">
          <div class="loading-spinner"></div>
          <span>Loading communities...</span>
        </div>
        <div v-else class="featured-servers-list">
          <div
            v-for="server in featuredServersList"
            :key="server.id"
            class="featured-server-item"
            :class="{ featured: server.is_featured }"
          >
            <div class="server-icon-wrap">
              <img
                :src="getServerIconUrl(server.icon)"
                :alt="server.name"
                class="server-icon"
              />
              <span v-if="server.is_featured" class="featured-badge">
                <Icon name="star" :size="12" />
              </span>
            </div>
            <div class="server-details">
              <div class="server-name">{{ server.name }}</div>
              <div class="server-meta">
                {{ server.member_count ?? 0 }} members
                <span v-if="server.is_featured" class="featured-order">#{{ server.featured_order }}</span>
              </div>
            </div>
            <button
              @click="toggleFeaturedServer(server)"
              class="action-btn-sm"
              :class="server.is_featured ? 'unpin-btn' : 'pin-btn'"
              :disabled="featuredServerToggling.has(server.id)"
              :title="server.is_featured ? 'Remove from featured' : 'Add to featured'"
            >
              <Icon v-if="featuredServerToggling.has(server.id)" name="loader" :size="14" class="spin" />
              <Icon v-else :name="server.is_featured ? 'x' : 'star'" :size="14" />
              {{ server.is_featured ? 'Unpin' : 'Pin' }}
            </button>
          </div>
          <div v-if="featuredServersList.length === 0 && !loadingStates.featuredServers" class="empty-state">
            No public communities yet. Create public servers to feature them.
          </div>
        </div>
      </div>

      <!-- Configuration -->
      <div class="admin-module config-module">
        <div class="module-header">
          <Icon name="settings" :size="20" />
          <h2>Configuration</h2>
        </div>
        <div class="config-tabs">
          <button
            v-for="tab in [
              { key: 'general', label: 'General', icon: 'settings' },
              { key: 'federation', label: 'Federation', icon: 'globe' },
              { key: 'branding', label: 'Branding', icon: 'image' },
              { key: 'oauth', label: 'Authentication', icon: 'shield' },
              { key: 'webrtc', label: 'Voice & Video', icon: 'mic' },
            ]"
            :key="tab.key"
            :class="['config-tab-btn', { active: configTab === tab.key }]"
            @click="configTab = tab.key as any"
          >
            <Icon :name="tab.icon" :size="16" />
            {{ tab.label }}
          </button>
        </div>
        <div class="config-sections">
          <!-- General / Chat Settings -->
          <div v-if="configTab === 'general'" class="config-section">
            <h3>Chat Settings</h3>
            <div class="setting-group">
              <label>Max Server Size</label>
              <input v-model.number="config.chat.maxServerSize" type="number" class="cyber-input" />
            </div>
            <div class="setting-group">
              <label>Max Message Length</label>
              <input v-model.number="config.chat.maxMessageLength" type="number" class="cyber-input" />
            </div>
            <div class="setting-group">
              <label>Max Media Attachments per Post/Message</label>
              <input v-model.number="config.chat.maxMediaAttachmentsPerPost" type="number" class="cyber-input" min="1" />
              <span class="setting-hint">Maximum images/videos/files per post or chat message. Default: 20.</span>
            </div>
            <div class="setting-row">
              <label class="toggle-label">
                <input type="checkbox" v-model="config.chat.allowFileUploads" />
                <span class="toggle-slider"></span>
                <span class="toggle-text">Allow File Uploads</span>
              </label>
              <label class="toggle-label">
                <input type="checkbox" v-model="config.chat.enableVoiceChannels" />
                <span class="toggle-slider"></span>
                <span class="toggle-text">Enable Voice Channels</span>
              </label>
            </div>

            <h3 style="margin-top: 24px;">Trending & Discovery</h3>
            <div class="setting-group">
              <label>Trending Posts</label>
              <div class="setting-control-row">
                <button type="button" class="primary-btn-sm refresh-trending-btn" @click="refreshTrendingPosts" :disabled="loadingStates.trendingRefresh">
                  <Icon v-if="loadingStates.trendingRefresh" name="loader" :size="16" class="spin" />
                  <Icon v-else name="refresh-cw" :size="16" />
                  {{ loadingStates.trendingRefresh ? 'Refreshing...' : 'Refresh Trending Now' }}
                </button>
                <span class="setting-hint">Manually recalculate trending posts. Normally runs every 15 minutes.</span>
              </div>
            </div>

            <button @click="saveConfig" class="save-btn" :disabled="!configChanged" style="margin-top: 16px;">
              <Icon name="save" :size="16" />
              Save Changes
            </button>
          </div>

          <!-- Federation Settings -->
          <div v-if="configTab === 'federation'" class="config-section">
            <h3>Federation Settings</h3>
            <div class="setting-group">
              <label>Max Post Length</label>
              <input v-model.number="config.federation.maxPostLength" type="number" class="cyber-input" />
            </div>
            <div class="setting-group">
              <label>Delivery Retry Attempts</label>
              <input v-model.number="config.federation.retryAttempts" type="number" class="cyber-input" />
            </div>
            <div class="setting-group">
              <label>Max Custom Emojis per Server</label>
              <input v-model.number="config.federation.maxCustomEmojisPerServer" type="number" class="cyber-input" min="0" />
              <span class="setting-hint">Maximum custom emojis allowed per server. 0 = unlimited.</span>
            </div>
            <div class="setting-group">
              <label>Custom Emoji Image Quality</label>
              <input
                v-model.number="config.federation.customEmojiTransformQuality"
                type="number"
                class="cyber-input"
                min="1"
                max="100"
              />
              <span class="setting-hint">
                JPEG/WebP quality (20–100) for resized custom emoji images from storage. Default 80. Lower values reduce bandwidth at the cost of artifacts.
              </span>
            </div>
            <div class="setting-group">
              <label class="toggle-label">
                <input type="checkbox" v-model="config.federation.allowCustomEmojisInDisplayNames" />
                <span class="toggle-slider"></span>
                <span class="toggle-text">Allow Custom Emojis in Display Names</span>
              </label>
              <span class="setting-hint">
                When off, emojis won't display in names and users can't add them.
              </span>
            </div>
            <div class="setting-row">
              <label class="toggle-label">
                <input type="checkbox" v-model="config.federation.enableOutbound" />
                <span class="toggle-slider"></span>
                <span class="toggle-text">Enable Outbound Federation</span>
              </label>
              <label class="toggle-label">
                <input type="checkbox" v-model="config.federation.enableInbound" />
                <span class="toggle-slider"></span>
                <span class="toggle-text">Enable Inbound Federation</span>
              </label>
            </div>

            <button @click="saveConfig" class="save-btn" :disabled="!configChanged" style="margin-top: 16px;">
              <Icon name="save" :size="16" />
              Save Changes
            </button>
          </div>

          <!-- Instance Branding -->
          <div v-if="configTab === 'branding'" class="config-section">
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

            <div class="config-subsection">
              <h4>Appearance</h4>
              <div class="setting-group">
                <label>Instance Icon</label>
                <div class="instance-appearance-row">
                  <div
                    class="instance-icon-preview"
                    @click="($refs.instanceIconInput as HTMLInputElement)?.click()"
                  >
                    <img
                      v-if="instanceIconPreviewUrl"
                      :src="instanceIconPreviewUrl"
                      alt="Instance icon"
                      class="instance-icon-img"
                    />
                    <Icon v-else name="image" :size="24" />
                  </div>
                  <div class="instance-appearance-controls">
                    <button type="button" class="save-btn" @click="($refs.instanceIconInput as HTMLInputElement)?.click()">
                      Upload Icon
                    </button>
                    <button
                      v-if="instanceConfig.iconUrl || instanceIconFile"
                      type="button"
                      class="save-btn"
                      style="background: #ed4245;"
                      @click="instanceIconFile = null; instanceConfig.iconUrl = ''; instanceBrandingChanged = true"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <input
                  ref="instanceIconInput"
                  type="file"
                  accept="image/*"
                  style="display: none;"
                  @change="handleInstanceIconChange"
                />
                <span class="setting-hint">
                  Your instance's logo. Shown to other federated instances and in the instances directory.
                </span>
              </div>

              <div class="setting-group">
                <label>Instance Banner</label>
                <div
                  class="instance-banner-preview"
                  :style="instanceBannerPreviewUrl ? { backgroundImage: `url(${instanceBannerPreviewUrl})` } : {}"
                  @click="($refs.instanceBannerInput as HTMLInputElement)?.click()"
                >
                  <div v-if="!instanceBannerPreviewUrl" class="instance-banner-placeholder">
                    <Icon name="image" :size="20" />
                    <span>Click to upload banner</span>
                  </div>
                  <div v-else class="instance-banner-overlay">
                    <span>Change banner</span>
                  </div>
                </div>
                <div v-if="instanceConfig.bannerUrl || instanceBannerFile" style="margin-top: 8px;">
                  <button
                    type="button"
                    class="save-btn"
                    style="background: #ed4245;"
                    @click="instanceBannerFile = null; instanceConfig.bannerUrl = ''; instanceBrandingChanged = true"
                  >
                    Remove Banner
                  </button>
                </div>
                <input
                  ref="instanceBannerInput"
                  type="file"
                  accept="image/*"
                  style="display: none;"
                  @change="handleInstanceBannerChange"
                />
                <span class="setting-hint">
                  A hero image for your instance. Shown in the instances directory and exposed via NodeInfo.
                </span>
              </div>

              <div class="setting-group">
                <label>Theme Color</label>
                <div style="display: flex; align-items: center; gap: 12px;">
                  <input
                    v-model="instanceConfig.themeColor"
                    type="color"
                    class="cyber-input"
                    style="width: 48px; height: 36px; padding: 2px; cursor: pointer;"
                    @input="instanceBrandingChanged = true"
                  />
                  <input
                    v-model="instanceConfig.themeColor"
                    type="text"
                    class="cyber-input"
                    placeholder="#0EA5E9"
                    style="flex: 1;"
                    @input="instanceBrandingChanged = true"
                  />
                </div>
                <span class="setting-hint">
                  Your instance's accent color. Exposed via NodeInfo for other instances to use.
                </span>
              </div>

              <div class="setting-group">
                <label>Default Theme for New Users</label>
                <span class="setting-hint" style="margin-bottom: 8px;">
                  Import a theme JSON file (exported from Appearance settings) to set as the default for new and non-signed-in users.
                </span>
                <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                  <button type="button" class="save-btn" @click="($refs.defaultThemeInput as HTMLInputElement)?.click()">
                    Import Theme JSON
                  </button>
                  <button 
                    v-if="instanceConfig.defaultThemeJson"
                    type="button" 
                    class="delete-btn"
                    @click="clearDefaultTheme"
                  >
                    Clear Default Theme
                  </button>
                  <span v-if="instanceConfig.defaultThemeJson" class="setting-hint" style="margin: 0;">
                    Default theme is set
                  </span>
                </div>
                <input
                  ref="defaultThemeInput"
                  type="file"
                  accept=".json"
                  style="display: none;"
                  @change="handleDefaultThemeImport"
                />
              </div>
            </div>

            <div class="config-subsection">
              <h4>Legal & Contact</h4>
              <div class="setting-group">
                <label>Terms of Service URL</label>
                <input
                  v-model="instanceConfig.termsUrl"
                  type="url"
                  class="cyber-input"
                  placeholder="https://example.com/terms"
                  @input="instanceBrandingChanged = true"
                />
                <span class="setting-hint">
                  Link to your Terms of Service. Shown on the registration page. Leave empty to hide.
                </span>
              </div>
              <div class="setting-group">
                <label>Privacy Policy URL</label>
                <input
                  v-model="instanceConfig.privacyUrl"
                  type="url"
                  class="cyber-input"
                  placeholder="https://example.com/privacy"
                  @input="instanceBrandingChanged = true"
                />
                <span class="setting-hint">
                  Link to your Privacy Policy. Shown on the registration page. Leave empty to hide.
                </span>
              </div>
              <div class="setting-group">
                <label>Maintainer Name</label>
                <input
                  v-model="instanceConfig.maintainerName"
                  type="text"
                  class="cyber-input"
                  placeholder="Admin"
                  @input="instanceBrandingChanged = true"
                />
                <span class="setting-hint">
                  Public contact name for this instance's administrator.
                </span>
              </div>
              <div class="setting-group">
                <label>Maintainer Email</label>
                <input
                  v-model="instanceConfig.maintainerEmail"
                  type="email"
                  class="cyber-input"
                  placeholder="admin@example.com"
                  @input="instanceBrandingChanged = true"
                />
                <span class="setting-hint">
                  Public contact email. Exposed via NodeInfo for federation transparency.
                </span>
              </div>
            </div>

            <button 
              @click="saveInstanceBranding" 
              class="save-btn" 
              :disabled="!instanceBrandingChanged || savingBranding"
              style="margin-top: 16px;"
            >
              <Icon name="save" :size="16" />
              {{ savingBranding ? 'Saving...' : 'Save Branding' }}
            </button>
          </div>

          <!-- OAuth Providers -->
          <div v-if="configTab === 'oauth'" class="config-section">
            <h3>OAuth Providers</h3>
            <p class="setting-hint" style="margin-bottom: 16px;">
              Enable or disable OAuth login providers. When disabled, the provider will not appear on the login/register page.
            </p>
            <div style="display: flex; flex-direction: column; gap: 12px;">
              <label class="toggle-label" style="justify-content: space-between; width: 100%;">
                <div style="display: flex; align-items: center; gap: 12px;">
                  <span style="font-weight: 500;">Google</span>
                  <span style="font-size: 12px; color: var(--text-secondary);">Allow users to sign in with Google</span>
                </div>
                <input 
                  type="checkbox" 
                  v-model="oauthProviders.google"
                  @change="oauthProvidersChanged = true"
                />
                <span class="toggle-slider"></span>
              </label>
              <label class="toggle-label" style="justify-content: space-between; width: 100%;">
                <div style="display: flex; align-items: center; gap: 12px;">
                  <span style="font-weight: 500;">Twitch</span>
                  <span style="font-size: 12px; color: var(--text-secondary);">Allow users to sign in with Twitch</span>
                </div>
                <input 
                  type="checkbox" 
                  v-model="oauthProviders.twitch"
                  @change="oauthProvidersChanged = true"
                />
                <span class="toggle-slider"></span>
              </label>
              <label class="toggle-label" style="justify-content: space-between; width: 100%;">
                <div style="display: flex; align-items: center; gap: 12px;">
                  <span style="font-weight: 500;">GitHub</span>
                  <span style="font-size: 12px; color: var(--text-secondary);">Allow users to sign in with GitHub</span>
                </div>
                <input 
                  type="checkbox" 
                  v-model="oauthProviders.github"
                  @change="oauthProvidersChanged = true"
                />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <button 
              @click="saveOAuthProviders" 
              class="save-btn" 
              :disabled="!oauthProvidersChanged || savingOAuthProviders"
              style="margin-top: 16px;"
            >
              <Icon name="save" :size="16" />
              {{ savingOAuthProviders ? 'Saving...' : 'Save OAuth Settings' }}
            </button>
          </div>

          <!-- WebRTC / Voice Settings -->
          <div v-if="configTab === 'webrtc'" class="config-section">
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

            <button @click="saveConfig" class="save-btn" :disabled="!configChanged" style="margin-top: 16px;">
              <Icon name="save" :size="16" />
              Save Changes
            </button>
          </div>
        </div>
      </div>

      <!-- Funding Management -->
      <div class="admin-module funding-module">
        <div class="module-header">
          <Icon name="heart" :size="20" />
          <h2>Funding & Supporters</h2>
          <button @click="saveFundingConfig" class="save-btn" :disabled="!fundingChanged">
            <Icon name="save" :size="16" />
            Save Changes
          </button>
        </div>
        <div class="funding-content">
          <!-- Funding Config -->
          <div class="funding-section">
            <h3>Funding Goal</h3>
            <div class="setting-row">
              <label class="toggle-label">
                <input type="checkbox" v-model="fundingEnabled" />
                <span class="toggle-slider"></span>
                Enable funding
              </label>
            </div>
            <div v-if="fundingEnabled" class="funding-fields">
              <div class="setting-row">
                <label class="toggle-label">
                  <input type="checkbox" v-model="fundingShowInBar" />
                  <span class="toggle-slider"></span>
                  Show in context bar
                </label>
              </div>
              <div class="setting-row">
                <label class="toggle-label">
                  <input type="checkbox" v-model="fundingShowProgress" />
                  <span class="toggle-slider"></span>
                  Show progress bar
                </label>
              </div>
              <div class="funding-form-row">
                <div class="funding-field">
                  <label>Goal amount</label>
                  <input type="number" v-model.number="fundingGoalAmount" class="cyber-input" min="0" step="1" />
                </div>
                <div class="funding-field">
                  <label>Currency</label>
                  <select v-model="fundingCurrency" class="cyber-select">
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                    <option value="JPY">JPY</option>
                  </select>
                </div>
                <div class="funding-field">
                  <label>Period</label>
                  <select v-model="fundingPeriod" class="cyber-select">
                    <option value="monthly">Monthly (resets each month)</option>
                    <option value="all">All time</option>
                  </select>
                  <span class="setting-hint" style="display: block; margin-top: 4px;">
                    Total is computed from donation history; period controls which donations count.
                  </span>
                </div>
              </div>
              <div class="funding-field" style="margin-top: 8px;">
                <label>Description</label>
                <input type="text" v-model="fundingDescription" class="cyber-input" placeholder="What the funding is for..." />
              </div>
              <div class="funding-field" style="margin-top: 8px;">
                <label>Thank you message</label>
                <input type="text" v-model="fundingThankYou" class="cyber-input" placeholder="Message shown to supporters" />
              </div>

              <!-- Funding Links -->
              <div class="funding-links-section" style="margin-top: 16px;">
                <label style="font-size: 12px; color: var(--text-secondary); font-weight: 600; display: block; margin-bottom: 8px;">Donation Links</label>
                <div v-if="fundingLinks.length > 0" class="funding-links-list">
                  <div v-for="(link, i) in fundingLinks" :key="i" class="funding-link-row">
                    <select v-model="link.platform" class="cyber-select" style="width: 160px;">
                      <option v-for="opt in FUNDING_PLATFORMS" :key="opt" :value="opt">{{ platformLabel(opt) }}</option>
                    </select>
                    <input v-model="link.url" class="cyber-input" placeholder="https://..." style="flex: 1;" />
                    <input v-model="link.label" class="cyber-input" placeholder="Label (optional)" style="width: 140px;" />
                    <button class="mod-btn delete-btn" @click="fundingLinks.splice(i, 1)" title="Remove link">
                      <Icon name="delete" :size="14" />
                    </button>
                  </div>
                </div>
                <div class="funding-link-row" style="margin-top: 6px;">
                  <select v-model="newLinkPlatform" class="cyber-select" style="width: 160px;">
                    <option value="" disabled>Platform…</option>
                    <option v-for="opt in FUNDING_PLATFORMS" :key="opt" :value="opt">{{ platformLabel(opt) }}</option>
                  </select>
                  <input v-model="newLinkUrl" class="cyber-input" placeholder="https://..." style="flex: 1;" />
                  <input v-model="newLinkLabel" class="cyber-input" placeholder="Label (optional)" style="width: 140px;" />
                  <button class="action-btn" @click="addFundingLink" :disabled="!newLinkPlatform || !newLinkUrl" style="white-space: nowrap;">
                    <Icon name="plus" :size="14" /> Add
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Ko-fi Webhook (automation) -->
          <div class="funding-section">
            <h3>Ko-fi Webhook <span class="section-badge">Automation</span></h3>
            <p class="section-description" style="margin-bottom: 12px;">
              Auto-record donations from Ko-fi. Requires a Ko-fi Gold subscription.
              Paste your verification token from
              <a href="https://ko-fi.com/manage/webhooks" target="_blank" rel="noopener noreferrer">Ko-fi Settings → API</a>
              and set the Webhook URL to:
            </p>
            <div class="webhook-url-display">
              <code>{{ kofiWebhookUrl }}</code>
              <button class="mod-btn" @click="copyKofiWebhookUrl" title="Copy URL">
                <Icon name="copy" :size="14" />
              </button>
            </div>
            <div class="funding-form-row" style="margin-top: 12px;">
              <div class="funding-field" style="flex: 1;">
                <label>Verification Token</label>
                <input
                  v-model="kofiWebhookToken"
                  :type="showKofiToken ? 'text' : 'password'"
                  class="cyber-input"
                  placeholder="Paste from Ko-fi Settings → API"
                  autocomplete="off"
                />
              </div>
              <div class="funding-field" style="align-self: flex-end;">
                <button class="mod-btn" type="button" @click="showKofiToken = !showKofiToken" :title="showKofiToken ? 'Hide' : 'Show'">
                  <Icon :name="showKofiToken ? 'eye-off' : 'eye'" :size="14" />
                </button>
              </div>
            </div>
            <label class="funding-field" style="margin-top: 8px; display: flex; align-items: center; gap: 8px;">
              <input type="checkbox" v-model="kofiAutoAssignTier" />
              <span>Auto-assign supporter tier based on donation amount</span>
            </label>
            <p class="section-hint">
              Donors include their handle (<code>@username@{{ instanceDomain }}</code>) anywhere in their Ko-fi
              message — the webhook auto-attributes it and recomputes their tier based on cumulative cycle
              donations. Donations without a matched handle land in the <strong>Pending Donations</strong>
              queue below, and you (and instance moderators) get a notification.
            </p>
          </div>

          <!-- Pending Donations -->
          <div class="funding-section" v-if="pendingDonations.length > 0 || pendingDonationCount > 0">
            <h3>
              Pending Donations
              <span v-if="pendingDonationCount > 0" class="pending-count-badge">{{ pendingDonationCount }}</span>
            </h3>
            <p class="section-description" style="margin-bottom: 12px;">
              Webhook donations that couldn't be auto-matched to a user. Search for the recipient or dismiss.
            </p>
            <div v-if="pendingDonations.length > 0" class="pending-donations-list">
              <div v-for="pending in pendingDonations" :key="pending.id" class="pending-donation-item">
                <div class="pending-donation-header">
                  <span class="pending-amount">{{ pending.currency }} {{ pending.amount.toFixed(2) }}</span>
                  <span class="pending-platform">{{ pending.platform }}</span>
                  <span class="pending-date">{{ formatDate(pending.received_at) }}</span>
                </div>
                <div class="pending-donation-meta">
                  <span v-if="pending.donor_name"><strong>From:</strong> {{ pending.donor_name }}</span>
                  <span v-if="pending.donor_email" class="pending-email">{{ pending.donor_email }}</span>
                </div>
                <div v-if="pending.donor_message" class="pending-message">
                  &ldquo;{{ pending.donor_message }}&rdquo;
                </div>
                <div class="pending-resolve-row">
                  <input
                    v-model="pendingResolveSearch[pending.id]"
                    class="cyber-input"
                    placeholder="Search user by username..."
                    @input="onPendingResolveSearch(pending.id)"
                    style="flex: 1;"
                  />
                  <button class="report-action-btn resolve" :disabled="!pendingResolveUserId[pending.id]" @click="resolvePending(pending)">
                    <Icon name="check" :size="14" /> Attribute
                  </button>
                  <button class="report-action-btn dismiss" @click="dismissPending(pending.id)">
                    <Icon name="x" :size="14" /> Dismiss
                  </button>
                </div>
                <div v-if="pendingResolveSuggestions[pending.id]?.length" class="pending-suggestions">
                  <div
                    v-for="user in pendingResolveSuggestions[pending.id]"
                    :key="user.id"
                    class="pending-suggestion"
                    :class="{ active: pendingResolveUserId[pending.id] === user.id }"
                    @click="pendingResolveUserId[pending.id] = user.id; pendingResolveSearch[pending.id] = user.handle"
                  >
                    <Avatar :src="user.avatar_url" :alt="user.username" size="xs" />
                    <span>{{ user.handle }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Supporter Tiers -->
          <div class="funding-section">
            <h3>Supporter Tiers</h3>
            <div class="tiers-list" v-if="supporterTiers.length > 0">
              <div v-for="tier in supporterTiers" :key="tier.id" class="tier-item">
                <template v-if="editingTierId === tier.id">
                  <div class="tier-icon-picker" style="position: relative;">
                    <input v-model="editTierIcon" class="cyber-input" style="width: 60px;" />
                    <button
                      ref="editTierEmojiButtonRef"
                      type="button"
                      class="mod-btn emoji-picker-btn"
                      @click.stop="showEditTierEmojiPicker = !showEditTierEmojiPicker"
                      title="Pick emoji"
                    >
                      <SupporterBadgeIcon v-if="editTierIcon" :icon="editTierIcon" />
                      <span v-else>😀</span>
                    </button>
                    <EmojiPopup
                      v-if="showEditTierEmojiPicker"
                      @click.stop
                      @sendEmoji="handleEditTierEmoji"
                      :closeEmojiList="() => showEditTierEmojiPicker = false"
                      :emojiIconClicked="true"
                      :position="'below'"
                      :triggerElement="((editTierEmojiButtonRef as any) as HTMLElement | null) || undefined"
                      @resetEmojiIconClicked="() => {}"
                    />
                  </div>
                  <input v-model="editTierName" class="cyber-input" style="flex: 1;" />
                  <input v-model.number="editTierMinAmount" type="number" class="cyber-input" style="width: 90px;" min="0" />
                  <input v-model="editTierColor" type="color" class="color-input" />
                  <button class="mod-btn" @click="saveEditTier(tier.id)" title="Save"><Icon name="check" :size="14" /></button>
                  <button class="mod-btn" @click="editingTierId = null; showEditTierEmojiPicker = false" title="Cancel"><Icon name="x" :size="14" /></button>
                </template>
                <template v-else>
                  <span class="tier-icon" :style="tier.badge_color ? { color: tier.badge_color } : {}">
                    <SupporterBadgeIcon :icon="tier.badge_icon" />
                  </span>
                  <div class="tier-info">
                    <span class="tier-name">{{ tier.name }}</span>
                    <span class="tier-amount">Min: {{ tier.min_amount }}</span>
                    <span v-if="tier.perks" class="tier-perks">{{ tier.perks }}</span>
                  </div>
                  <div class="tier-actions">
                    <button class="mod-btn" @click="startEditTier(tier)" title="Edit tier"><Icon name="edit" :size="14" /></button>
                    <button class="mod-btn delete-btn" @click="deleteTier(tier.id)" title="Delete tier"><Icon name="delete" :size="14" /></button>
                  </div>
                </template>
              </div>
            </div>
            <div v-else class="empty-hint">No tiers configured</div>
            <div class="add-tier-form">
              <input v-model="newTierName" class="cyber-input" placeholder="Tier name" />
              <input v-model.number="newTierMinAmount" type="number" class="cyber-input" placeholder="Min amount" min="0" style="width: 120px;" />
              <div class="tier-icon-picker" style="position: relative;">
                <input v-model="newTierIcon" class="cyber-input" placeholder="Icon" style="width: 60px;" />
                <button
                  ref="newTierEmojiButtonRef"
                  type="button"
                  class="mod-btn emoji-picker-btn"
                  @click.stop="showNewTierEmojiPicker = !showNewTierEmojiPicker"
                  title="Pick emoji"
                >
                  <SupporterBadgeIcon v-if="newTierIcon" :icon="newTierIcon" />
                  <span v-else>😀</span>
                </button>
                <EmojiPopup
                  v-if="showNewTierEmojiPicker"
                  @click.stop
                  @sendEmoji="handleNewTierEmoji"
                  :closeEmojiList="() => showNewTierEmojiPicker = false"
                  :emojiIconClicked="true"
                  :position="'above'"
                  :triggerElement="((newTierEmojiButtonRef as any) as HTMLElement | null) || undefined"
                  @resetEmojiIconClicked="() => {}"
                />
              </div>
              <input v-model="newTierColor" type="color" class="color-input" title="Badge color" />
              <button class="action-btn" @click="addTier" :disabled="!newTierName || !newTierMinAmount">
                <Icon name="plus" :size="16" /> Add
              </button>
            </div>
          </div>

          <!-- Supporters -->
          <div class="funding-section">
            <h3>Active Supporters</h3>
            <div class="supporters-list" v-if="supporters.length > 0">
              <div v-for="supporter in supporters" :key="supporter.id" class="supporter-item">
                <Avatar :src="supporter.user?.avatar_url" :alt="supporter.user?.username" size="sm" />
                <div class="supporter-info">
                  <span class="supporter-name">
                    <DisplayName v-if="supporter.user_id" :user-id="supporter.user_id" :fallback="supporter.user?.display_name || supporter.user?.username" />
                    <template v-else>{{ supporter.user?.display_name || supporter.user?.username }}</template>
                  </span>
                  <span class="supporter-meta">
                    {{ supporter.tier?.name || 'No tier' }}
                    <template v-if="supporter.amount"> &middot; {{ supporter.amount }}</template>
                    <template v-if="supporter.platform"> &middot; {{ supporter.platform }}</template>
                  </span>
                </div>
                <div class="supporter-actions">
                  <button class="mod-btn" @click="startEditSupporter(supporter)" title="Edit supporter"><Icon name="edit" :size="14" /></button>
                  <button class="mod-btn" @click="openRecordDonation(supporter)" title="Record donation">
                    <Icon name="dollar-sign" :size="14" />
                  </button>
                  <button class="mod-btn delete-btn" @click="removeSupporter(supporter.user_id)" title="Remove supporter"><Icon name="delete" :size="14" /></button>
                </div>
              </div>
            </div>
            <div v-else class="empty-hint">No active supporters</div>

            <!-- Add Supporter -->
            <div class="add-supporter-form">
              <div class="supporter-search-wrapper" style="position: relative; flex: 1; min-width: 100px;">
                <input
                  ref="supporterSearchInputRef"
                  v-model="addSupporterSearch"
                  class="cyber-input"
                  placeholder="Username to add as supporter..."
                  @input="onSupporterSearchInput"
                  @keydown="onSupporterSearchKeydown"
                  @focus="supporterSearchFocused = true"
                  @blur="onSupporterSearchBlur"
                  autocomplete="off"
                />
                <div
                  v-if="supporterSearchFocused && supporterSuggestions.length > 0"
                  class="supporter-suggestions"
                >
                  <div
                    v-for="(s, idx) in supporterSuggestions"
                    :key="s.id"
                    class="supporter-suggestion-item"
                    :class="{ selected: idx === supporterSelectedIdx }"
                    @mousedown.prevent="selectSupporterSuggestion(s)"
                  >
                    <Avatar :src="s.avatar_url" :alt="s.username" size="xs" />
                    <div class="supporter-suggestion-text">
                      <DisplayName :userId="s.id" :fallback="s.display_name || s.username" :truncate="true" class="supporter-suggestion-name" />
                      <span class="supporter-suggestion-handle">{{ s.handle }}</span>
                    </div>
                  </div>
                </div>
              </div>
              <select v-model="addSupporterTierId" class="cyber-select" style="width: 140px;">
                <option value="">No tier</option>
                <option v-for="t in supporterTiers" :key="t.id" :value="t.id">{{ t.name }}</option>
              </select>
              <input v-model.number="addSupporterAmount" type="number" class="cyber-input" placeholder="Amount" min="0" style="width: 100px;" />
              <input v-model="addSupporterPlatform" class="cyber-input" placeholder="Platform" style="width: 110px;" />
              <button class="action-btn" @click="addNewSupporter" :disabled="!addSupporterSearch">
                <Icon name="plus" :size="16" /> Add
              </button>
            </div>
          </div>

          <!-- Edit Supporter Modal (inline) -->
          <div v-if="editingSupporterData" class="funding-section edit-supporter-panel">
            <h3>Edit Supporter: <DisplayName v-if="editingSupporterData.user_id" :user-id="editingSupporterData.user_id" :fallback="editingSupporterData.user?.display_name || editingSupporterData.user?.username" /><template v-else>{{ editingSupporterData.user?.display_name || editingSupporterData.user?.username }}</template></h3>
            <div class="funding-form-row">
              <div class="funding-field">
                <label>Tier</label>
                <select v-model="editSupporterTierId" class="cyber-select">
                  <option value="">No tier</option>
                  <option v-for="t in supporterTiers" :key="t.id" :value="t.id">{{ t.name }}</option>
                </select>
              </div>
              <div class="funding-field">
                <label>Amount</label>
                <input v-model.number="editSupporterAmount" type="number" class="cyber-input" min="0" />
              </div>
              <div class="funding-field">
                <label>Platform</label>
                <input v-model="editSupporterPlatform" class="cyber-input" />
              </div>
            </div>
            <div class="report-action-buttons" style="margin-top: 8px;">
              <button class="report-action-btn resolve" @click="saveEditSupporter">Save</button>
              <button class="report-action-btn dismiss" @click="editingSupporterData = null">Cancel</button>
            </div>
          </div>

          <!-- Record Donation Modal (inline) -->
          <div v-if="recordDonationSupporter" class="funding-section edit-supporter-panel">
            <h3>Record Donation for <DisplayName v-if="recordDonationSupporter.user_id" :user-id="recordDonationSupporter.user_id" :fallback="recordDonationSupporter.user?.display_name || recordDonationSupporter.user?.username" /><template v-else>{{ recordDonationSupporter.user?.display_name || recordDonationSupporter.user?.username }}</template></h3>
            <div class="funding-form-row">
              <div class="funding-field">
                <label>Amount</label>
                <input v-model.number="recordDonationAmount" type="number" class="cyber-input" min="0" step="0.01" />
              </div>
              <div class="funding-field">
                <label>Currency</label>
                <select v-model="recordDonationCurrency" class="cyber-select">
                  <option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="JPY">JPY</option>
                </select>
              </div>
              <div class="funding-field">
                <label>Platform</label>
                <input v-model="recordDonationPlatform" class="cyber-input" placeholder="e.g. Patreon, Ko-fi" />
              </div>
            </div>
            <div class="funding-field" style="margin-top: 8px;">
              <label>Note</label>
              <input v-model="recordDonationNote" class="cyber-input" placeholder="Optional note..." />
            </div>
            <div class="report-action-buttons" style="margin-top: 8px;">
              <button class="report-action-btn resolve" @click="saveRecordDonation" :disabled="!recordDonationAmount">Record</button>
              <button class="report-action-btn dismiss" @click="recordDonationSupporter = null">Cancel</button>
            </div>
          </div>

          <!-- Donation History -->
          <div class="funding-section">
            <h3>Donation History</h3>
            <div v-if="donationStats.donationCount > 0" class="donation-stats-row">
              <div class="donation-stat">
                <span class="donation-stat-value">{{ donationStats.totalDonated.toFixed(2) }}</span>
                <span class="donation-stat-label">Total donated</span>
              </div>
              <div class="donation-stat">
                <span class="donation-stat-value">{{ donationStats.donationCount }}</span>
                <span class="donation-stat-label">Donations</span>
              </div>
              <div class="donation-stat">
                <span class="donation-stat-value">{{ donationStats.uniqueDonors }}</span>
                <span class="donation-stat-label">Unique donors</span>
              </div>
            </div>
            <div v-if="donationHistory.length > 0" class="donations-list">
              <div v-for="donation in donationHistory" :key="donation.id" class="donation-item">
                <Avatar v-if="donation.user" :src="donation.user.avatar_url" :alt="donation.user.username" size="xs" />
                <span class="donation-user" v-if="donation.user">
                  <DisplayName v-if="donation.user_id" :user-id="donation.user_id" :fallback="donation.user.display_name || donation.user.username" />
                  <template v-else>{{ donation.user.display_name || donation.user.username }}</template>
                </span>
                <span class="donation-amount">{{ donation.currency }} {{ donation.amount }}</span>
                <span class="donation-date">{{ formatDate(donation.donated_at) }}</span>
                <span v-if="donation.platform" class="donation-platform">{{ donation.platform }}</span>
                <span v-if="donation.note" class="donation-note">{{ donation.note }}</span>
                <div class="donation-actions">
                  <button class="mod-btn" @click="startEditDonation(donation)" title="Edit"><Icon name="edit" :size="12" /></button>
                  <button class="mod-btn delete-btn" @click="deleteDonation(donation.id)" title="Delete"><Icon name="delete" :size="12" /></button>
                </div>
              </div>
            </div>
            <div v-else class="empty-hint">No donations recorded</div>

            <!-- Edit Donation (inline) -->
            <div v-if="editingDonation" class="edit-donation-panel">
              <div class="funding-form-row">
                <div class="funding-field">
                  <label>Amount</label>
                  <input v-model.number="editDonationAmount" type="number" class="cyber-input" min="0" step="0.01" />
                </div>
                <div class="funding-field">
                  <label>Currency</label>
                  <select v-model="editDonationCurrency" class="cyber-select">
                    <option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="JPY">JPY</option>
                  </select>
                </div>
                <div class="funding-field">
                  <label>Platform</label>
                  <input v-model="editDonationPlatform" class="cyber-input" />
                </div>
                <div class="funding-field">
                  <label>Note</label>
                  <input v-model="editDonationNote" class="cyber-input" />
                </div>
              </div>
              <div class="report-action-buttons" style="margin-top: 8px;">
                <button class="report-action-btn resolve" @click="saveEditDonation">Save</button>
                <button class="report-action-btn dismiss" @click="editingDonation = null">Cancel</button>
              </div>
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
              Servers for <DisplayName v-if="selectedUserForServers?.id" :user-id="selectedUserForServers.id" :fallback="selectedUserForServers?.display_name || selectedUserForServers?.username" /><template v-else>{{ selectedUserForServers?.display_name || selectedUserForServers?.username }}</template>
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
import { escapeHtml } from '@/utils/sanitize'
import { useAuthStore } from '@/stores/auth'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import EmojiImporter from '@/components/admin/EmojiImporter.vue'
import PerformanceMonitoring from '@/components/admin/PerformanceMonitoring.vue'
import { supabase } from '@/supabase'
import { adminService, type SystemStats, type SystemHealth, type AdminUser, type AdminActivity, type BlockedInstance, type FederatedInstance, type InstanceStats, type InstanceSearchResult, type FederationStats, type DeadEndpoint } from '@/services/AdminService'
import { reportService, type ReportWithDetails } from '@/services/ReportService'
import { fundingService, FUNDING_PLATFORMS, type FundingPlatformKey, type SupporterTier, type Supporter, type DonationRecord, type PendingDonation } from '@/services/FundingService'
import { messageService } from '@/services/MessageService'
import { trendingService } from '@/services/TrendingService'
import { announcementService, type Announcement } from '@/services/AnnouncementService'
import { usePublicServersStore } from '@/stores/usePublicServers'
import { getServerIconUrl } from '@/utils/serverUtils'
import { userDataService } from '@/services/userDataService'
import { activityPubService } from '@/services/activityPubService'
import EmojiPopup from '@/components/EmojiPopup.vue'
import { getEmojiShortcodeForInsert } from '@/services/emojiShortcodeResolver'
import SupporterBadgeIcon from '@/components/common/SupporterBadgeIcon.vue'
import type { Emoji } from '@/types'

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
const configTab = ref<'general' | 'federation' | 'branding' | 'oauth' | 'webrtc'>('general')

// Reports & Moderation data
const reports = ref<ReportWithDetails[]>([])
const pendingReportsCount = ref(0)
const activeReportFilter = ref<string>('all')
const expandedReportId = ref<string | null>(null)
const reportResolutionNote = ref('')
const reportShowResolver = ref(false)
const reportFilters = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'investigating', label: 'Investigating' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'dismissed', label: 'Dismissed' },
]

// Funding management data
const fundingChanged = ref(false)
const fundingEnabled = ref(false)
const fundingShowInBar = ref(false)
const fundingShowProgress = ref(true)
const fundingGoalAmount = ref<number>(0)
const fundingCurrency = ref('USD')
const fundingCurrentAmount = ref<number>(0)
const fundingPeriod = ref<'all' | 'monthly'>('monthly')
const fundingDescription = ref('')
const fundingThankYou = ref('')
const fundingLinks = ref<{ platform: string; url: string; label: string }[]>([])
const newLinkPlatform = ref('')
const newLinkUrl = ref('')
const newLinkLabel = ref('')

// Ko-fi webhook config
const kofiWebhookToken = ref('')
const kofiAutoAssignTier = ref(true)
const showKofiToken = ref(false)
const kofiWebhookUrl = computed(() => {
  // Federation backend exposes /webhooks/kofi. Prefer explicit federation URL,
  // fall back to current origin.
  const base = (import.meta.env.VITE_FEDERATION_URL as string | undefined)
    || (typeof window !== 'undefined' ? window.location.origin : '')
  return `${base.replace(/\/$/, '')}/webhooks/kofi`
})
const instanceDomain = computed(() =>
  (import.meta.env.VITE_DOMAIN as string | undefined) || 'your-domain'
)

// Pending donations (webhooks awaiting admin resolution)
const pendingDonations = ref<PendingDonation[]>([])
const pendingDonationCount = ref(0)
const pendingResolveSearch = ref<Record<string, string>>({})
const pendingResolveUserId = ref<Record<string, string | null>>({})
const pendingResolveSuggestions = ref<Record<string, Array<{ id: string; username: string; handle: string; avatar_url?: string }>>>({})
const pendingResolveTimers: Record<string, ReturnType<typeof setTimeout>> = {}
const supporterTiers = ref<SupporterTier[]>([])
const supporters = ref<Supporter[]>([])
const donationHistory = ref<DonationRecord[]>([])
const donationStats = ref<{ totalDonated: number; donationCount: number; uniqueDonors: number }>({ totalDonated: 0, donationCount: 0, uniqueDonors: 0 })
const newTierName = ref('')
const newTierMinAmount = ref<number>(0)
const newTierIcon = ref('⭐')
const newTierColor = ref('#0EA5E9')

// Tier editing
const editingTierId = ref<string | null>(null)
const editTierName = ref('')
const editTierMinAmount = ref<number>(0)
const editTierIcon = ref('')
const editTierColor = ref('#0EA5E9')

const showNewTierEmojiPicker = ref(false)
const showEditTierEmojiPicker = ref(false)
const newTierEmojiButtonRef = ref<HTMLElement | null>(null)
const editTierEmojiButtonRef = ref<HTMLElement | null>(null)

// Supporter CRUD
const addSupporterSearch = ref('')
const addSupporterSelectedUserId = ref<string | null>(null)
const addSupporterTierId = ref('')
const addSupporterAmount = ref<number>(0)
const addSupporterPlatform = ref('')
const supporterSearchInputRef = ref<HTMLInputElement | null>(null)
const supporterSearchFocused = ref(false)
const supporterSelectedIdx = ref(0)
const supporterSuggestions = ref<Array<{ id: string; username: string; display_name: string; avatar_url?: string; handle: string; is_local: boolean }>>([])
let supporterSearchTimeout: ReturnType<typeof setTimeout> | null = null
const editingSupporterData = ref<Supporter | null>(null)
const editSupporterTierId = ref('')
const editSupporterAmount = ref<number>(0)
const editSupporterPlatform = ref('')

// Record donation
const recordDonationSupporter = ref<Supporter | null>(null)
const recordDonationAmount = ref<number>(0)
const recordDonationCurrency = ref('USD')
const recordDonationPlatform = ref('')
const recordDonationNote = ref('')

// Donation editing
const editingDonation = ref<DonationRecord | null>(null)
const editDonationAmount = ref<number>(0)
const editDonationCurrency = ref('USD')
const editDonationPlatform = ref('')
const editDonationNote = ref('')

// Federation management data
const instanceStats = ref<InstanceStats>({
  total_instances: 0,
  blocked_instances: 0,
  trusted_instances: 0,
  active_instances: 0,
  recently_discovered: 0
})

const federationStats = ref<FederationStats | null>(null)
const deadEndpointsList = ref<DeadEndpoint[]>([])
const purgingEndpointIds = ref<Set<string>>(new Set())
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
  discovering: false,
  keyConsistency: false,
  keySweep: false,
  orphanCleanup: false,
  trendingRefresh: false,
  announcements: false,
  featuredServers: false,
  purgingDead: false,
})

// Key consistency state
const keyConsistency = ref<{
  users_missing_keys: number;
  users_with_inconsistent_keys: number;
  inconsistent_users: Array<{
    user_id: string;
    username: string;
    has_public_key: boolean;
    has_private_key: boolean;
  }>;
  status: 'ok' | 'needs_attention';
} | null>(null)

// Announcements
const announcements = ref<Announcement[]>([])
const showAnnouncementForm = ref(false)
const editingAnnouncementId = ref<string | null>(null)
const announcementForm = ref({
  title: '',
  content: '',
  icon: 'info',
  image_url: '',
  is_pinned: false,
  show_popup: true,
  is_active: true,
  // datetime-local strings ("YYYY-MM-DDTHH:mm" in the admin's local TZ).
  // Empty string means "use the DB default" (now() for starts_at, NULL /
  // never-expires for ends_at). Converted to ISO at save time via
  // `localInputToIso` so PostgreSQL stores UTC.
  starts_at: '',
  ends_at: '',
})

// ---------------------------------------------------------------------------
// datetime-local <-> ISO helpers
// ---------------------------------------------------------------------------
// HTML's `datetime-local` input gives us a naive local timestamp without a
// timezone (e.g. "2026-05-26T21:00"). We convert in both directions so the
// admin sees their own timezone but the DB stores UTC ISO strings.
//
// Both helpers are intentionally null-safe and treat an empty input as "no
// value" rather than as the Unix epoch.
function localInputToIso(local: string): string | undefined {
  if (!local) return undefined
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString()
}

function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // Shift by the local TZ offset so `toISOString().slice(0, 16)` formats
  // as the admin's wall-clock time rather than as UTC.
  const tzOffsetMs = d.getTimezoneOffset() * 60_000
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16)
}

// Featured communities
const featuredServersList = ref<Array<{
  id: string;
  name: string;
  description?: string;
  icon?: string;
  is_featured: boolean;
  featured_order: number;
  member_count?: number;
}>>([])
const featuredServerToggling = ref<Set<string>>(new Set())

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
  termsUrl: '',
  privacyUrl: '',
  openRegistration: true,
  approvalRequired: false,
  iconUrl: '',
  bannerUrl: '',
  themeColor: '#0EA5E9',
  maintainerName: '',
  maintainerEmail: '',
  defaultThemeJson: '' as string,
})
const instanceIconFile = ref<File | null>(null)
const instanceBannerFile = ref<File | null>(null)

// OAuth provider configuration
const oauthProviders = ref({
  google: false,
  twitch: false,
  github: false
})
const oauthProvidersChanged = ref(false)
const savingOAuthProviders = ref(false)

// Configuration
const config = ref({
  chat: {
    maxServerSize: 1000,
    maxMessageLength: 2000,
    maxMediaAttachmentsPerPost: 20,
    allowFileUploads: true,
    enableVoiceChannels: true
  },
  federation: {
    maxPostLength: 500,
    retryAttempts: 3,
    maxCustomEmojisPerServer: 0,
    customEmojiTransformQuality: 80,
    allowCustomEmojisInDisplayNames: true,
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
const userCounts = ref({ total: 0, local: 0, federated: 0, suspended: 0 })
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

// Filter recent activity by category and format JSON details for display
const filteredRecentActivity = computed(() => {
  let list = recentActivity.value
  if (activityFilter.value !== 'all') {
    list = list.filter(e => getActivityCategory(e.type) === activityFilter.value)
  }
  return list
})

const userFilters = computed(() => [
  { key: 'all', label: 'All Users', count: userCounts.value.total },
  { key: 'local', label: 'Local', count: userCounts.value.local },
  { key: 'federated', label: 'Federated', count: userCounts.value.federated },
  { key: 'suspended', label: 'Suspended', count: userCounts.value.suspended }
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

  return filtered
})

// Watch for config changes
watch(config, () => {
  configChanged.value = true
}, { deep: true })

// Watch for report filter changes
watch(activeReportFilter, () => {
  loadReports()
})

// Watch for funding config changes
watch(
  [fundingEnabled, fundingShowInBar, fundingShowProgress, fundingGoalAmount, fundingCurrency, fundingCurrentAmount, fundingPeriod, fundingDescription, fundingThankYou, fundingLinks, kofiWebhookToken, kofiAutoAssignTier],
  () => { fundingChanged.value = true },
  { deep: true }
)

// Methods
const loadInitialData = async () => {
  loading.value = true
  try {
    await Promise.all([
      loadSystemStats(),
      loadUsers(),
      loadUserCounts(),
      loadSystemHealth(),
      loadInstanceConfig(),
      loadRecentActivity(),
      loadAnnouncements(),
      loadFeaturedServers(),
      loadInstanceStats(),
      loadFederatedInstances(),
      loadFederationStats(),
      refreshKeyConsistency(),
      loadReports(),
      loadPendingReportsCount(),
      loadFundingData()
    ])
  } catch (error) {
    debug.error('Failed to load admin data:', error)
  } finally {
    loading.value = false
  }
}

const loadAnnouncements = async () => {
  loadingStates.value.announcements = true
  try {
    announcements.value = await announcementService.getAllAnnouncements()
  } catch (error) {
    debug.error('Failed to load announcements:', error)
    announcements.value = []
  } finally {
    loadingStates.value.announcements = false
  }
}

const loadFeaturedServers = async () => {
  loadingStates.value.featuredServers = true
  try {
    featuredServersList.value = await adminService.getPublicServersForAdmin()
  } catch (error) {
    debug.error('Failed to load featured servers:', error)
    featuredServersList.value = []
  } finally {
    loadingStates.value.featuredServers = false
  }
}

const toggleFeaturedServer = async (server: { id: string; name: string; is_featured: boolean; featured_order: number }) => {
  if (featuredServerToggling.value.has(server.id)) return
  featuredServerToggling.value = new Set([...featuredServerToggling.value, server.id])
  try {
    const newFeatured = !server.is_featured
    const order = newFeatured
      ? Math.max(0, ...featuredServersList.value.filter(s => s.is_featured).map(s => s.featured_order), -1) + 1
      : 0
    await adminService.setServerFeatured(server.id, newFeatured, order)
    toast.success(newFeatured ? `Featured "${server.name}"` : `Removed "${server.name}" from featured`)
    await loadFeaturedServers()
    usePublicServersStore().fetchPublicServers(true)
  } catch (error: any) {
    debug.error('Failed to toggle featured:', error)
    toast.error(error.message || 'Failed to update featured status')
  } finally {
    featuredServerToggling.value = new Set([...featuredServerToggling.value].filter(id => id !== server.id))
  }
}

const getAnnouncementIcon = (icon: string | undefined) => {
  if (!icon) return '📢'
  const icons: Record<string, string> = {
    info: 'ℹ️',
    warning: '⚠️',
    megaphone: '📢',
  }
  return icons[icon] || (icon.length <= 2 ? icon : '📢')
}

const saveAnnouncement = async () => {
  if (!announcementForm.value.title || !announcementForm.value.content) return

  // Asymmetric handling for the two timestamps:
  //   * `starts_at`: an empty input means "use the DB default (now()) on
  //     create" / "leave the existing value alone on update". Sending
  //     undefined makes the Supabase client omit the key entirely.
  //   * `ends_at`:   an empty input means "no expiration" — admins clearing
  //     the field must be able to explicitly drop the value back to NULL,
  //     otherwise an existing expiry would be impossible to remove. We
  //     send `null` rather than undefined so the column is overwritten.
  // Cross-field validation: end-before-start would silently produce an
  // announcement that's already expired the moment it's published.
  const startsIso = localInputToIso(announcementForm.value.starts_at)
  const endsIsoOrNull = announcementForm.value.ends_at
    ? localInputToIso(announcementForm.value.ends_at) ?? null
    : null
  if (startsIso && endsIsoOrNull && new Date(endsIsoOrNull) <= new Date(startsIso)) {
    toast.error('"Ends at" must be after "Starts at"')
    return
  }
  try {
    if (editingAnnouncementId.value) {
      await announcementService.updateAnnouncement(editingAnnouncementId.value, {
        title: announcementForm.value.title,
        content: announcementForm.value.content,
        icon: announcementForm.value.icon || 'info',
        image_url: announcementForm.value.image_url || undefined,
        is_pinned: announcementForm.value.is_pinned,
        show_popup: announcementForm.value.show_popup,
        is_active: announcementForm.value.is_active,
        starts_at: startsIso,
        ends_at: endsIsoOrNull,
      })
      toast.success('Announcement updated')
    } else {
      await announcementService.createAnnouncement({
        title: announcementForm.value.title,
        content: announcementForm.value.content,
        icon: announcementForm.value.icon || 'info',
        image_url: announcementForm.value.image_url || undefined,
        is_pinned: announcementForm.value.is_pinned,
        show_popup: announcementForm.value.show_popup,
        starts_at: startsIso,
        ends_at: endsIsoOrNull,
      })
      toast.success('Announcement created')
    }
    cancelAnnouncementForm()
    await loadAnnouncements()
  } catch (error: any) {
    debug.error('Failed to save announcement:', error)
    toast.error(error.message || 'Failed to save announcement')
  }
}

const cancelAnnouncementForm = () => {
  showAnnouncementForm.value = false
  editingAnnouncementId.value = null
  announcementForm.value = {
    title: '',
    content: '',
    icon: 'info',
    image_url: '',
    is_pinned: false,
    show_popup: true,
    is_active: true,
    starts_at: '',
    ends_at: '',
  }
}

const editAnnouncement = (a: Announcement) => {
  editingAnnouncementId.value = a.id
  announcementForm.value = {
    title: a.title,
    content: a.content,
    icon: a.icon || 'info',
    image_url: a.image_url || '',
    is_pinned: a.is_pinned ?? false,
    show_popup: a.show_popup ?? true,
    is_active: (a as any).is_active ?? true,
    // Convert the DB-stored UTC ISO back to the admin's local "YYYY-MM-DDTHH:mm"
    // so the datetime-local inputs render the wall-clock time they originally
    // entered, not UTC. Empty when unset.
    starts_at: isoToLocalInput((a as any).starts_at),
    ends_at: isoToLocalInput(a.ends_at),
  }
  showAnnouncementForm.value = true
}

const deleteAnnouncement = async (id: string) => {
  if (!confirm('Delete this announcement?')) return
  try {
    await announcementService.deleteAnnouncement(id)
    toast.success('Announcement deleted')
    await loadAnnouncements()
  } catch (error: any) {
    debug.error('Failed to delete announcement:', error)
    toast.error(error.message || 'Failed to delete')
  }
}

const loadRecentActivity = async () => {
  try {
    const activity = await adminService.getRecentActivity(20)
    
    recentActivity.value = activity.map((event: AdminActivity) => ({
      id: event.id,
      type: event.action_type,
      message: event.details,
      targetUsername: event.target_username,
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

const userPagination = ref({ offset: 0, limit: 25, total: 0 })

const loadUserCounts = async () => {
  try {
    userCounts.value = await adminService.getUserCounts()
  } catch (error) {
    debug.error('Failed to load user counts:', error)
    userCounts.value = { total: 0, local: 0, federated: 0, suspended: 0 }
  }
}

const loadUsers = async () => {
  try {
    const result = await adminService.getUsers(
      userPagination.value.limit,
      userPagination.value.offset
    )
    users.value = result.users
    userPagination.value.total = result.total
    // Prime user cache so DisplayName can resolve custom emojis in admin list
    if (result.users.length > 0) {
      userDataService.ensureUsersLoaded(result.users.map((u) => u.id)).catch(() => {})
    }
  } catch (error) {
    debug.error('Failed to load users:', error)
    users.value = []
  }
}

const loadNextUsers = () => {
  userPagination.value.offset += userPagination.value.limit
  loadUsers()
}

const loadPreviousUsers = () => {
  userPagination.value.offset = Math.max(0, userPagination.value.offset - userPagination.value.limit)
  loadUsers()
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
    const cfg = await adminService.getInstanceConfig()
    if (cfg) {
      if (cfg.chat) {
        config.value.chat = { ...config.value.chat, ...cfg.chat }
      }
      if (cfg.federation) {
        config.value.federation = { ...config.value.federation, ...cfg.federation }
      }
      if (cfg.webrtc) {
        config.value.webrtc = { ...config.value.webrtc, ...cfg.webrtc }
      }
    }
    if (cfg?.instance) {
      instanceConfig.value = {
        name: cfg.instance.name || 'Harmony Instance',
        domain: cfg.instance.domain || import.meta.env.VITE_DOMAIN as string,
        description: cfg.instance.description || 'A federated social platform',
        termsUrl: cfg.instance.termsUrl || '',
        privacyUrl: cfg.instance.privacyUrl || '',
        openRegistration: cfg.instance.registrationOpen ?? true,
        approvalRequired: cfg.instance.requiresApproval ?? false,
        iconUrl: cfg.instance.iconUrl || '',
        bannerUrl: cfg.instance.bannerUrl || '',
        themeColor: cfg.instance.themeColor || '#0EA5E9',
        maintainerName: cfg.instance.maintainerName || '',
        maintainerEmail: cfg.instance.maintainerEmail || '',
        defaultThemeJson: cfg.instance.defaultThemeJson || '',
      }
      
      // Load OAuth providers
      if (cfg.instance.oauthProviders) {
        const providers = cfg.instance.oauthProviders
        if (Array.isArray(providers)) {
          // If it's an array like ["google", "github"]
          oauthProviders.value = {
            google: providers.includes('google'),
            twitch: providers.includes('twitch'),
            github: providers.includes('github')
          }
        } else if (typeof providers === 'object' && providers !== null) {
          // If it's an object like { google: true, twitch: false }
          oauthProviders.value = {
            google: providers.google === true || providers.google === 'true',
            twitch: providers.twitch === true || providers.twitch === 'true',
            github: providers.github === true || providers.github === 'true'
          }
        }
      } else {
        // If no config or empty, all providers are disabled
        oauthProviders.value = {
          google: false,
          twitch: false,
          github: false
        }
      }
      oauthProvidersChanged.value = false
    }
  } catch (error) {
    debug.error('Failed to load instance config:', error)
    // Keep defaults if loading fails
  }
}

// Funding management methods
const loadFundingData = async () => {
  const config = await fundingService.getFundingConfig()
  if (config) {
    fundingEnabled.value = config.enabled
    fundingShowInBar.value = config.show_in_context_bar
    fundingShowProgress.value = config.show_progress_bar
    fundingGoalAmount.value = config.goal_amount || 0
    fundingCurrency.value = config.goal_currency
    fundingCurrentAmount.value = config.current_amount
    fundingPeriod.value = config.funding_period === 'all' ? 'all' : 'monthly'
    fundingDescription.value = config.goal_description || ''
    fundingThankYou.value = config.thank_you_message || ''
    fundingLinks.value = config.funding_links || []
    kofiWebhookToken.value = config.kofi_webhook_token || ''
    kofiAutoAssignTier.value = config.kofi_auto_assign_tier !== false
  }
  supporterTiers.value = await fundingService.getTiers()
  supporters.value = await fundingService.getSupporters()
  donationHistory.value = await fundingService.getDonationHistory()
  donationStats.value = await fundingService.getDonationStats()
  pendingDonations.value = await fundingService.getPendingDonations()
  pendingDonationCount.value = pendingDonations.value.filter(p => !p.resolved_at).length
  // Reset after populating to avoid false dirty state from watchers
  fundingChanged.value = false
}

const PLATFORM_LABELS: Record<FundingPlatformKey, string> = {
  'ko-fi': 'Ko-fi',
  'patreon': 'Patreon',
  'github-sponsors': 'GitHub Sponsors',
  'liberapay': 'Liberapay',
  'open-collective': 'Open Collective',
  'paypal': 'PayPal',
  'buymeacoffee': 'Buy Me a Coffee',
  'custom': 'Custom',
}
const platformLabel = (key: string): string => PLATFORM_LABELS[key as FundingPlatformKey] || key

const copyKofiWebhookUrl = async () => {
  try {
    await navigator.clipboard.writeText(kofiWebhookUrl.value)
    toast.success('Webhook URL copied')
  } catch {
    toast.error('Failed to copy')
  }
}

// Pending donations: search for the right user to attribute to.
const onPendingResolveSearch = (pendingId: string) => {
  if (pendingResolveTimers[pendingId]) clearTimeout(pendingResolveTimers[pendingId])
  pendingResolveTimers[pendingId] = setTimeout(async () => {
    const query = (pendingResolveSearch.value[pendingId] || '').trim().replace(/^@+/, '')
    if (query.length < 2) {
      pendingResolveSuggestions.value[pendingId] = []
      return
    }
    try {
      const users = await activityPubService.searchUsers(query, 5)
      pendingResolveSuggestions.value[pendingId] = users.map((u: any) => ({
        id: u.id,
        username: u.username,
        handle: u.handle || (u.is_local ? `@${u.username}` : `@${u.username}@${u.domain}`),
        avatar_url: u.avatar_url,
      }))
    } catch (e) {
      debug.error('Pending donation user search failed:', e)
    }
  }, 250)
}

const resolvePending = async (pending: PendingDonation) => {
  const userId = pendingResolveUserId.value[pending.id]
  if (!userId) return
  // Tier is resolved server-side from the user's cumulative cycle total
  // (recompute_supporter_tier). No need to compute it here.
  const ok = await fundingService.resolvePendingDonation(pending.id, userId)
  if (ok) {
    toast.success('Donation attributed')
    await adminService.logAdminAction({ action: 'pending_donation_resolve', targetType: 'pending_donation', targetId: pending.id, details: { userId } })
    pendingDonations.value = pendingDonations.value.filter(p => p.id !== pending.id)
    pendingDonationCount.value = pendingDonations.value.filter(p => !p.resolved_at).length
    donationHistory.value = await fundingService.getDonationHistory()
    supporters.value = await fundingService.getSupporters()
  } else {
    toast.error('Failed to attribute donation')
  }
}

const dismissPending = async (pendingId: string) => {
  if (!confirm('Dismiss this donation? It will not be attributed to any user.')) return
  const ok = await fundingService.dismissPendingDonation(pendingId)
  if (ok) {
    toast.success('Donation dismissed')
    await adminService.logAdminAction({ action: 'pending_donation_dismiss', targetType: 'pending_donation', targetId: pendingId })
    pendingDonations.value = pendingDonations.value.filter(p => p.id !== pendingId)
    pendingDonationCount.value = pendingDonations.value.filter(p => !p.resolved_at).length
  } else {
    toast.error('Failed to dismiss')
  }
}

const addFundingLink = () => {
  if (!newLinkPlatform.value || !newLinkUrl.value) return
  fundingLinks.value.push({
    platform: newLinkPlatform.value,
    url: newLinkUrl.value,
    label: newLinkLabel.value || newLinkPlatform.value,
  })
  newLinkPlatform.value = ''
  newLinkUrl.value = ''
  newLinkLabel.value = ''
}

const saveFundingConfig = async () => {
  const success = await fundingService.updateFundingConfig({
    enabled: fundingEnabled.value,
    show_in_context_bar: fundingShowInBar.value,
    show_progress_bar: fundingShowProgress.value,
    goal_amount: fundingGoalAmount.value || null,
    goal_currency: fundingCurrency.value,
    current_amount: fundingCurrentAmount.value,
    funding_period: fundingPeriod.value,
    goal_description: fundingDescription.value || null,
    thank_you_message: fundingThankYou.value || null,
    funding_links: fundingLinks.value,
    kofi_webhook_token: kofiWebhookToken.value.trim() || null,
    kofi_auto_assign_tier: kofiAutoAssignTier.value,
  } as any)
  if (success) {
    fundingChanged.value = false
    toast.success('Funding settings saved')
  } else {
    toast.error('Failed to save funding settings')
  }
}

const addTier = async () => {
  if (!newTierName.value || !newTierMinAmount.value) return
  const tier = await fundingService.createTier({
    name: newTierName.value,
    min_amount: newTierMinAmount.value,
    badge_icon: newTierIcon.value || null,
    badge_color: newTierColor.value || null,
    perks: null,
    display_order: supporterTiers.value.length,
  })
  if (tier) {
    await adminService.logAdminAction({ action: 'tier_create', targetType: 'tier', targetId: tier.id, details: { name: tier.name } })
    supporterTiers.value.push(tier)
    newTierName.value = ''
    newTierMinAmount.value = 0
    newTierIcon.value = '⭐'
    toast.success('Tier created')
  }
}

// Tier CRUD
const startEditTier = (tier: SupporterTier) => {
  editingTierId.value = tier.id
  editTierName.value = tier.name
  editTierMinAmount.value = tier.min_amount
  editTierIcon.value = tier.badge_icon || '⭐'
  editTierColor.value = tier.badge_color || '#0EA5E9'
}

const saveEditTier = async (tierId: string) => {
  const success = await fundingService.updateTier(tierId, {
    name: editTierName.value,
    min_amount: editTierMinAmount.value,
    badge_icon: editTierIcon.value,
    badge_color: editTierColor.value,
  })
  if (success) {
    await adminService.logAdminAction({ action: 'tier_update', targetType: 'tier', targetId: tierId, details: { name: editTierName.value } })
    editingTierId.value = null
    supporterTiers.value = await fundingService.getTiers()
    toast.success('Tier updated')
  }
}

const handleNewTierEmoji = (emoji: Emoji & { display_name?: string }) => {
  newTierIcon.value = getEmojiShortcodeForInsert(emoji)
  showNewTierEmojiPicker.value = false
}

const handleEditTierEmoji = (emoji: Emoji & { display_name?: string }) => {
  editTierIcon.value = getEmojiShortcodeForInsert(emoji)
  showEditTierEmojiPicker.value = false
}

const deleteTier = async (tierId: string) => {
  if (!confirm('Delete this tier? Supporters on this tier will keep their status but lose the tier badge.')) return
  const success = await fundingService.deleteTier(tierId)
  if (success) {
    await adminService.logAdminAction({ action: 'tier_delete', targetType: 'tier', targetId: tierId })
    supporterTiers.value = supporterTiers.value.filter(t => t.id !== tierId)
    toast.success('Tier deleted')
  }
}

// Supporter search & autocomplete
const onSupporterSearchInput = () => {
  addSupporterSelectedUserId.value = null
  supporterSelectedIdx.value = 0
  if (supporterSearchTimeout) clearTimeout(supporterSearchTimeout)
  const q = addSupporterSearch.value.trim()
  if (q.length < 2) {
    supporterSuggestions.value = []
    return
  }
  supporterSearchTimeout = setTimeout(async () => {
    try {
      const byKey = new Map<string, typeof supporterSuggestions.value[0]>()
      const currentDomain = (import.meta.env.VITE_DOMAIN as string || '').toLowerCase()
      const currentHost = currentDomain.split(':')[0]

      // Domain is "ours" (localhost, 127.0.0.1, or matches instance)
      const isOurDomain = (d: string | null | undefined) => {
        if (!d) return true
        const host = d.split(':')[0].toLowerCase()
        return host === 'localhost' || host === '127.0.0.1' || host === currentHost
      }

      // Canonical key: our-instance users = username only, remote = username@domain
      const canonicalKey = (username: string, domain?: string | null, isLocal?: boolean) => {
        const un = username.toLowerCase()
        if (isLocal || isOurDomain(domain)) return un
        return `${un}@${(domain || '').toLowerCase()}`
      }

      // Normalize handle to always have leading @
      const normalizeHandle = (handle: string) => {
        const h = (handle || '').trim()
        return h.startsWith('@') ? h : `@${h}`
      }

      const byId = new Set<string>()

      // Local profiles first (preferred - has proper display_name/emoji resolution)
      const { data: locals } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, domain')
        .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
        .limit(8)
      if (locals) {
        for (const u of locals) {
          const isLocal = isOurDomain(u.domain)
          const handle = isLocal ? `@${u.username}` : `@${u.username}@${u.domain}`
          const key = canonicalKey(u.username, u.domain, isLocal)
          byKey.set(key, {
            id: u.id,
            username: u.username,
            display_name: u.display_name || u.username,
            avatar_url: u.avatar_url,
            handle,
            is_local: isLocal,
          })
          byId.add(u.id)
        }
      }

      // Federated users (skip if we already have them - local + RPC both hit profiles)
      try {
        const federated = await activityPubService.searchUsers(q, 6)
        const localUsernames = new Set(Array.from(byKey.values()).filter(r => r.is_local).map(r => r.username.toLowerCase()))
        for (const f of federated) {
          const fid = f.id ?? (f as { user_id?: string }).user_id
          if (fid && byId.has(fid)) continue
          const isLocal = typeof f.is_local === 'boolean' ? f.is_local : isOurDomain(f.domain)
          const key = canonicalKey(f.username, f.domain, isLocal)
          if (byKey.has(key)) continue
          if (localUsernames.has(f.username.toLowerCase())) continue
          const rawHandle = f.handle || (isLocal ? `@${f.username}` : `@${f.username}@${f.domain || ''}`)
          byKey.set(key, {
            id: fid ?? f.id,
            username: f.username,
            display_name: f.display_name || f.username,
            avatar_url: f.avatar_url,
            handle: normalizeHandle(rawHandle),
            is_local: isLocal,
          })
          if (fid) byId.add(fid)
        }
      } catch { /* federated search may not be available */ }

      supporterSuggestions.value = Array.from(byKey.values()).slice(0, 8)
    } catch (e) {
      debug.error('Supporter search error:', e)
    }
  }, 250)
}

const selectSupporterSuggestion = (s: typeof supporterSuggestions.value[0]) => {
  addSupporterSearch.value = s.handle
  addSupporterSelectedUserId.value = s.id
  supporterSuggestions.value = []
  supporterSearchFocused.value = false
}

const onSupporterSearchKeydown = (e: KeyboardEvent) => {
  const list = supporterSuggestions.value
  if (!list.length) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    supporterSelectedIdx.value = (supporterSelectedIdx.value + 1) % list.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    supporterSelectedIdx.value = (supporterSelectedIdx.value - 1 + list.length) % list.length
  } else if (e.key === 'Enter' && list.length > 0) {
    e.preventDefault()
    selectSupporterSuggestion(list[supporterSelectedIdx.value])
  } else if (e.key === 'Escape') {
    supporterSuggestions.value = []
  }
}

const onSupporterSearchBlur = () => {
  setTimeout(() => { supporterSearchFocused.value = false }, 150)
}

// Supporter CRUD
const addNewSupporter = async () => {
  if (!addSupporterSearch.value) return

  let userId: string | undefined = addSupporterSelectedUserId.value ?? undefined
  if (!userId) {
    // Fallback: try to find by username
    const { data: users } = await supabase.from('profiles').select('id').ilike('username', addSupporterSearch.value.replace(/^@/, '')).limit(1)
    if (!users?.length) {
      toast.error('User not found')
      return
    }
    userId = users[0].id
  }

  const success = await fundingService.addSupporter(userId!, addSupporterTierId.value || undefined, addSupporterAmount.value || undefined, addSupporterPlatform.value || undefined)
  if (success) {
    await adminService.logAdminAction({ action: 'supporter_add', targetType: 'supporter', targetId: userId!, details: { username: addSupporterSearch.value } })
    supporters.value = await fundingService.getSupporters()
    addSupporterSearch.value = ''
    addSupporterSelectedUserId.value = null
    addSupporterTierId.value = ''
    addSupporterAmount.value = 0
    addSupporterPlatform.value = ''
    toast.success('Supporter added')
  }
}

const startEditSupporter = (supporter: Supporter) => {
  editingSupporterData.value = supporter
  editSupporterTierId.value = supporter.tier_id || ''
  editSupporterAmount.value = supporter.amount || 0
  editSupporterPlatform.value = supporter.platform || ''
}

const saveEditSupporter = async () => {
  if (!editingSupporterData.value) return
  const userId = editingSupporterData.value.user_id
  const success = await fundingService.updateSupporter(userId, {
    tier_id: editSupporterTierId.value || null,
    amount: editSupporterAmount.value || null,
    platform: editSupporterPlatform.value || null,
  })
  if (success) {
    await adminService.logAdminAction({ action: 'supporter_update', targetType: 'supporter', targetId: userId })
    editingSupporterData.value = null
    supporters.value = await fundingService.getSupporters()
    toast.success('Supporter updated')
  }
}

const removeSupporter = async (userId: string) => {
  if (!confirm('Remove this supporter?')) return
  const success = await fundingService.removeSupporter(userId)
  if (success) {
    await adminService.logAdminAction({ action: 'supporter_remove', targetType: 'supporter', targetId: userId })
    supporters.value = supporters.value.filter(s => s.user_id !== userId)
    toast.success('Supporter removed')
  }
}

// Donation CRUD
const openRecordDonation = (supporter: Supporter) => {
  recordDonationSupporter.value = supporter
  recordDonationAmount.value = 0
  recordDonationCurrency.value = fundingCurrency.value
  recordDonationPlatform.value = supporter.platform || ''
  recordDonationNote.value = ''
}

const saveRecordDonation = async () => {
  if (!recordDonationSupporter.value || !recordDonationAmount.value) return
  const s = recordDonationSupporter.value
  const success = await fundingService.addDonation(s.id, s.user_id, recordDonationAmount.value, recordDonationCurrency.value, recordDonationPlatform.value || undefined, recordDonationNote.value || undefined)
  if (success) {
    await adminService.logAdminAction({ action: 'donation_record', targetType: 'donation', targetId: s.user_id, details: { amount: recordDonationAmount.value, currency: recordDonationCurrency.value } })
    recordDonationSupporter.value = null
    donationHistory.value = await fundingService.getDonationHistory()
    donationStats.value = await fundingService.getDonationStats()
    toast.success('Donation recorded')
  }
}

const startEditDonation = (donation: DonationRecord) => {
  editingDonation.value = donation
  editDonationAmount.value = donation.amount
  editDonationCurrency.value = donation.currency
  editDonationPlatform.value = donation.platform || ''
  editDonationNote.value = donation.note || ''
}

const saveEditDonation = async () => {
  if (!editingDonation.value) return
  const success = await fundingService.updateDonation(editingDonation.value.id, {
    amount: editDonationAmount.value,
    currency: editDonationCurrency.value,
    platform: editDonationPlatform.value || null,
    note: editDonationNote.value || null,
  })
  if (success) {
    await adminService.logAdminAction({ action: 'donation_update', targetType: 'donation', targetId: editingDonation.value.id })
    editingDonation.value = null
    donationHistory.value = await fundingService.getDonationHistory()
    donationStats.value = await fundingService.getDonationStats()
    toast.success('Donation updated')
  }
}

const deleteDonation = async (donationId: string) => {
  if (!confirm('Delete this donation record?')) return
  const success = await fundingService.deleteDonation(donationId)
  if (success) {
    await adminService.logAdminAction({ action: 'donation_delete', targetType: 'donation', targetId: donationId })
    donationHistory.value = donationHistory.value.filter(d => d.id !== donationId)
    donationStats.value = await fundingService.getDonationStats()
    toast.success('Donation deleted')
  }
}

// Reports & Moderation methods
const loadReports = async () => {
  try {
    const statusParam = activeReportFilter.value === 'all' ? null : activeReportFilter.value
    const result = await reportService.getReports({ status: statusParam })
    reports.value = result.reports
    const ids = result.reports
      .flatMap((r) => [r.reporter_id, r.reported_user_id].filter(Boolean) as string[])
    if (ids.length > 0) {
      userDataService.ensureUsersLoaded(ids).catch(() => {})
    }
  } catch (error) {
    debug.error('Failed to load reports:', error)
  }
}

const loadPendingReportsCount = async () => {
  pendingReportsCount.value = await reportService.getPendingReportsCount()
}

const toggleReportExpand = (id: string) => {
  expandedReportId.value = expandedReportId.value === id ? null : id
  reportResolutionNote.value = ''
  reportShowResolver.value = false
}

const updateReport = async (reportId: string, status: 'investigating' | 'resolved' | 'dismissed') => {
  const options = (status === 'resolved' || status === 'dismissed') ? { showResolver: reportShowResolver.value } : undefined
  const success = await reportService.updateReportStatus(reportId, status, reportResolutionNote.value || undefined, options)
  if (success) {
    toast.success(`Report ${status}`)
    reportResolutionNote.value = ''
    expandedReportId.value = null
    await loadReports()
    await loadPendingReportsCount()
  } else {
    toast.error('Failed to update report')
  }
}

const linkifyReportPreview = (text: string): string => {
  const escaped = escapeHtml(text)
  return escaped.replace(
    /(https?:\/\/[^\s\]]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="report-link" onclick="event.stopPropagation()">$1</a>'
  )
}

const extractStorageUrls = (report: ReportWithDetails): string[] => {
  const preview = report.reported_message_preview || report.reported_post_preview || ''
  const supabaseHost = import.meta.env.VITE_SUPABASE_URL || ''
  const urls: string[] = []
  const urlRegex = /https?:\/\/[^\s\]]+/g
  let match
  while ((match = urlRegex.exec(preview)) !== null) {
    const url = match[0]
    if (url.includes('/storage/') || (supabaseHost && url.startsWith(supabaseHost))) {
      urls.push(url)
    }
  }
  return urls
}

const deleteReportedMedia = async (report: ReportWithDetails) => {
  const urls = extractStorageUrls(report)
  if (urls.length === 0) return
  if (!confirm(`Delete ${urls.length} media file(s) from storage? This cannot be undone.\n\n${urls.join('\n')}`)) return

  let deleted = 0
  for (const url of urls) {
    try {
      const pathMatch = url.match(/\/storage\/v1\/object\/public\/([^?]+)/)
      if (pathMatch) {
        const fullPath = pathMatch[1]
        const slashIdx = fullPath.indexOf('/')
        const bucket = fullPath.substring(0, slashIdx)
        const filePath = fullPath.substring(slashIdx + 1)
        const { error } = await supabase.storage.from(bucket).remove([filePath])
        if (!error) deleted++
        else debug.error(`Failed to delete ${filePath}:`, error)
      }
    } catch (error) {
      debug.error('Failed to delete media:', error)
    }
  }

  if (deleted > 0) {
    await adminService.logAdminAction({ action: 'media_delete', targetType: 'storage', details: { count: deleted, urls } })
    toast.success(`Deleted ${deleted} media file(s)`)
  } else {
    toast.error('Failed to delete media files')
  }
}

const deleteReportedMessage = async (report: ReportWithDetails) => {
  if (!report.reported_message_id) return
  if (!confirm('Delete this message? This cannot be undone.')) return
  try {
    await messageService.deleteMessage(report.reported_message_id)
    toast.success('Message deleted')
    await updateReport(report.id, 'resolved')
  } catch (error) {
    debug.error('Failed to delete message:', error)
    toast.error('Failed to delete message')
  }
}

const suspendReportedUser = async (report: ReportWithDetails) => {
  if (!report.reported_user_id) return
  const reason = prompt('Suspension reason:')
  if (!reason) return
  try {
    await adminService.moderateUser(report.reported_user_id, 'suspend', reason, authStore.session?.user?.id || '')
    toast.success(`User ${report.reported_user_display_name || report.reported_user_username} suspended`)
    await updateReport(report.id, 'resolved')
    await loadUsers()
  } catch (error) {
    debug.error('Failed to suspend user:', error)
    toast.error('Failed to suspend user')
  }
}

const markPostSensitive = async (report: ReportWithDetails) => {
  if (!report.reported_post_id) return
  try {
    const action = report.reported_post_is_sensitive ? 'unmark_sensitive' : 'mark_sensitive'
    await adminService.moderatePost(report.reported_post_id, action)
    report.reported_post_is_sensitive = !report.reported_post_is_sensitive
    toast.success(report.reported_post_is_sensitive ? 'Post marked as sensitive' : 'Post unmarked as sensitive')
  } catch (error) {
    debug.error('Failed to toggle sensitive:', error)
    toast.error('Failed to update post sensitivity')
  }
}

const setPostContentWarning = async (report: ReportWithDetails) => {
  if (!report.reported_post_id) return
  const cw = prompt('Content warning text (leave empty to remove):', report.reported_post_content_warning || '')
  if (cw === null) return
  try {
    if (cw.trim()) {
      await adminService.moderatePost(report.reported_post_id, 'set_cw', cw.trim())
      report.reported_post_content_warning = cw.trim()
      toast.success('Content warning set')
    } else {
      await adminService.moderatePost(report.reported_post_id, 'remove_cw')
      report.reported_post_content_warning = null
      toast.success('Content warning removed')
    }
  } catch (error) {
    debug.error('Failed to set content warning:', error)
    toast.error('Failed to update content warning')
  }
}

const deleteReportedPost = async (report: ReportWithDetails) => {
  if (!report.reported_post_id) return
  if (!confirm('Delete this post? This cannot be undone.')) return
  try {
    await adminService.moderatePost(report.reported_post_id, 'delete')
    toast.success('Post deleted')
    await updateReport(report.id, 'resolved')
  } catch (error) {
    debug.error('Failed to delete post:', error)
    toast.error('Failed to delete post')
  }
}

const forceSensitiveReportedUser = async (report: ReportWithDetails) => {
  if (!report.reported_user_id) return
  const reason = prompt('Reason for marking all media as sensitive:')
  if (!reason) return
  try {
    await adminService.moderateUser(report.reported_user_id, 'force_sensitive', reason, authStore.session?.user?.id || '')
    toast.success(`All future media from ${report.reported_user_display_name || report.reported_user_username} will be marked sensitive`)
  } catch (error) {
    debug.error('Failed to force sensitive:', error)
    toast.error('Failed to force-sensitive account')
  }
}

const silenceReportedUser = async (report: ReportWithDetails) => {
  if (!report.reported_user_id) return
  const reason = prompt('Reason for silencing (hiding from public timelines):')
  if (!reason) return
  try {
    await adminService.moderateUser(report.reported_user_id, 'silence', reason, authStore.session?.user?.id || '')
    toast.success(`User ${report.reported_user_display_name || report.reported_user_username} silenced`)
  } catch (error) {
    debug.error('Failed to silence user:', error)
    toast.error('Failed to silence user')
  }
}

const navigateToReportUser = (report: ReportWithDetails, which: 'reporter' | 'reported') => {
  let username: string | null
  let domain: string | null
  if (which === 'reporter') {
    username = report.reporter_username
    domain = report.reporter_domain
  } else {
    username = report.reported_user_username
    domain = report.reported_user_domain
  }
  if (!username) return
  const localDomain = import.meta.env.VITE_DOMAIN as string
  const handle = (domain && domain !== localDomain) ? `${username}@${domain}` : username
  router.push({ name: 'UserProfile', params: { handle } })
}

const navigateToPost = (postId: string) => {
  router.push(`/post/${postId}`)
}

const refreshData = async () => {
  await loadInitialData()
}

const refreshTrendingPosts = async () => {
  loadingStates.value.trendingRefresh = true
  try {
    await trendingService.updateTrendingScores()
    toast.success('Trending posts refreshed')
  } catch (error: any) {
    debug.error('Failed to refresh trending:', error)
    toast.error(error.message || 'Failed to refresh trending posts')
  } finally {
    loadingStates.value.trendingRefresh = false
  }
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

const toggleModerator = async (user: any) => {
  const newStatus = !user.is_moderator
  const label = newStatus ? 'promote to moderator' : 'remove moderator from'
  if (!confirm(`Are you sure you want to ${label} ${user.username}?`)) return

  try {
    await adminService.setModeratorStatus(user.id, newStatus)
    user.is_moderator = newStatus
    await loadRecentActivity()
  } catch (error) {
    debug.error('Failed to toggle moderator status:', error)
    alert('Failed to update moderator status.')
  }
}

const moderateUser = async (user: any, action: string) => {
  try {
    if (action === 'suspend') {
      const reason = prompt('Suspension reason:')
      if (!reason) return
      await adminService.moderateUser(user.id, 'suspend', reason, authStore.session?.user?.id || '')
      await loadUsers()
      await loadRecentActivity()
      toast.success(`User ${user.username} has been suspended.`)
    } else if (action === 'unsuspend') {
      if (!confirm(`Are you sure you want to unsuspend user ${user.username}?`)) return
      await adminService.moderateUser(user.id, 'unsuspend', 'Admin unsuspend', authStore.session?.user?.id || '')
      await loadUsers()
      await loadRecentActivity()
      toast.success(`User ${user.username} has been unsuspended.`)
    } else if (action === 'delete') {
      if (!confirm(`Are you sure you want to delete user ${user.username}? This cannot be undone.`)) return
      await adminService.moderateUser(user.id, 'delete', 'Admin deletion', authStore.session?.user?.id || '')
      await loadUsers()
      await loadRecentActivity()
      toast.success(`User ${user.username} has been deleted.`)
    } else if (action === 'force_sensitive') {
      const reason = prompt('Reason for marking all media as sensitive:')
      if (!reason) return
      await adminService.moderateUser(user.id, 'force_sensitive', reason, authStore.session?.user?.id || '')
      await loadUsers()
      toast.success(`All future media from ${user.username} will be marked sensitive.`)
    } else if (action === 'unforce_sensitive') {
      if (!confirm(`Remove force-sensitive from ${user.username}?`)) return
      await adminService.moderateUser(user.id, 'unforce_sensitive', '', authStore.session?.user?.id || '')
      await loadUsers()
      toast.success(`Force-sensitive removed from ${user.username}.`)
    } else if (action === 'silence') {
      const reason = prompt('Reason for silencing (hidden from public timelines):')
      if (!reason) return
      await adminService.moderateUser(user.id, 'silence', reason, authStore.session?.user?.id || '')
      await loadUsers()
      toast.success(`User ${user.username} has been silenced.`)
    } else if (action === 'unsilence') {
      if (!confirm(`Remove silence from ${user.username}?`)) return
      await adminService.moderateUser(user.id, 'unsilence', '', authStore.session?.user?.id || '')
      await loadUsers()
      toast.success(`User ${user.username} has been unsilenced.`)
    }
  } catch (error: any) {
    debug.error('Failed to moderate user:', error)
    toast.error(`Failed to ${action} user: ${error.message || 'Unknown error'}`)
  }
}

const navigateToUserPosts = (user: any) => {
  const handle = (user.domain && user.domain !== import.meta.env.VITE_DOMAIN as string)
    ? `${user.username}@${user.domain}`
    : user.username
  router.push({ name: 'UserProfile', params: { handle } })
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
  if (!authStore.session?.user?.id) {
    toast.error('You must be logged in to save configuration')
    return
  }

  try {
    const userId = authStore.session.user.id
    
    // Save federation settings
    const fedSuccess = await adminService.updateFederationSettings({
      userId,
      inboundEnabled: config.value.federation.enableInbound,
      outboundEnabled: config.value.federation.enableOutbound,
      federationEnabled: config.value.federation.enableInbound || config.value.federation.enableOutbound
    })

    if (!fedSuccess) {
      toast.error('Failed to save federation settings')
      return
    }

    await adminService.setInstanceConfigs({
      max_server_size: config.value.chat.maxServerSize,
      max_message_length: config.value.chat.maxMessageLength,
      max_media_attachments_per_post: config.value.chat.maxMediaAttachmentsPerPost ?? 20,
      allow_file_uploads: config.value.chat.allowFileUploads,
      enable_voice_channels: config.value.chat.enableVoiceChannels,
      max_post_length: config.value.federation.maxPostLength,
      federation_retry_attempts: config.value.federation.retryAttempts,
      max_custom_emojis_per_server: config.value.federation.maxCustomEmojisPerServer ?? 0,
      custom_emoji_transform_quality: Math.min(
        100,
        Math.max(1, Math.round(Number(config.value.federation.customEmojiTransformQuality) || 100))
      ),
      allow_custom_emojis_in_display_names: config.value.federation.allowCustomEmojisInDisplayNames,
    }, userId)

    await adminService.updateWebRTCSettings({
      mode: config.value.webrtc.mode,
      livekitUrl: config.value.webrtc.livekitUrl,
      allowFederatedVoice: config.value.webrtc.allowFederatedVoice,
      maxStageListeners: config.value.webrtc.maxStageListeners
    })

    configChanged.value = false
    toast.success('Configuration saved successfully')
    debug.log('Configuration saved:', config.value)
    
    // Refresh instance settings store so UI updates
    const instanceSettings = useInstanceSettingsStore()
    await instanceSettings.fetchSettings(true)
  } catch (error: any) {
    debug.error('Failed to save configuration:', error)
    toast.error(error.message || 'Failed to save configuration')
  }
}

const instanceIconPreviewUrl = computed(() => {
  if (instanceIconFile.value) return URL.createObjectURL(instanceIconFile.value)
  if (instanceConfig.value.iconUrl) {
    if (instanceConfig.value.iconUrl.startsWith('http')) return instanceConfig.value.iconUrl
    const { data } = supabase.storage.from('server_icons').getPublicUrl(instanceConfig.value.iconUrl)
    return data.publicUrl
  }
  return null
})

const instanceBannerPreviewUrl = computed(() => {
  if (instanceBannerFile.value) return URL.createObjectURL(instanceBannerFile.value)
  if (instanceConfig.value.bannerUrl) {
    if (instanceConfig.value.bannerUrl.startsWith('http')) return instanceConfig.value.bannerUrl
    const { data } = supabase.storage.from('server_banners').getPublicUrl(instanceConfig.value.bannerUrl)
    return data.publicUrl
  }
  return null
})

const handleInstanceIconChange = (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file && file.size > 5 * 1024 * 1024) {
    toast.error('Icon file too large (max 5MB)')
    return
  }
  if (file) {
    instanceIconFile.value = file
    instanceBrandingChanged.value = true
  }
  if (input) input.value = ''
}

const handleInstanceBannerChange = (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file && file.size > 10 * 1024 * 1024) {
    toast.error('Banner file too large (max 10MB)')
    return
  }
  if (file) {
    instanceBannerFile.value = file
    instanceBrandingChanged.value = true
  }
  if (input) input.value = ''
}

const saveInstanceBranding = async () => {
  if (!authStore.session?.user?.id) {
    toast.error('You must be logged in to save instance branding')
    return
  }

  savingBranding.value = true
  try {
    // Upload icon if a new file was selected
    if (instanceIconFile.value) {
      const ext = instanceIconFile.value.name.split('.').pop()
      const filePath = `instance/instance_icon.${ext}`
      const { error: uploadErr } = await supabase.storage
        .from('server_icons')
        .upload(filePath, instanceIconFile.value, { upsert: true })
      if (uploadErr) {
        toast.error(`Failed to upload icon: ${uploadErr.message}`)
        savingBranding.value = false
        return
      }
      const { data: urlData } = supabase.storage.from('server_icons').getPublicUrl(filePath)
      instanceConfig.value.iconUrl = urlData.publicUrl
      instanceIconFile.value = null
    }

    // Upload banner if a new file was selected
    if (instanceBannerFile.value) {
      const ext = instanceBannerFile.value.name.split('.').pop()
      const filePath = `instance/instance_banner.${ext}`
      const { error: uploadErr } = await supabase.storage
        .from('server_banners')
        .upload(filePath, instanceBannerFile.value, { upsert: true })
      if (uploadErr) {
        toast.error(`Failed to upload banner: ${uploadErr.message}`)
        savingBranding.value = false
        return
      }
      const { data: urlData } = supabase.storage.from('server_banners').getPublicUrl(filePath)
      instanceConfig.value.bannerUrl = urlData.publicUrl
      instanceBannerFile.value = null
    }

    // Batch-save all branding config in a single RPC call
    await adminService.setInstanceConfigs({
      instance_name: instanceConfig.value.name,
      instance_description: instanceConfig.value.description,
      terms_url: instanceConfig.value.termsUrl,
      privacy_url: instanceConfig.value.privacyUrl,
      instance_icon: instanceConfig.value.iconUrl,
      instance_banner: instanceConfig.value.bannerUrl,
      theme_color: instanceConfig.value.themeColor,
      maintainer_name: instanceConfig.value.maintainerName,
      maintainer_email: instanceConfig.value.maintainerEmail,
    }, authStore.session.user.id)

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

const handleDefaultThemeImport = async (event: Event) => {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') {
      toast.error('Invalid theme JSON file')
      return
    }
    instanceConfig.value.defaultThemeJson = text
    instanceBrandingChanged.value = true

    if (authStore.session?.user?.id) {
      await adminService.setInstanceConfigs({
        default_theme_json: text,
      }, authStore.session.user.id)
      toast.success('Default theme imported and saved')
    }
  } catch {
    toast.error('Failed to parse theme JSON file')
  }
  const input = event.target as HTMLInputElement
  if (input) input.value = ''
}

const clearDefaultTheme = async () => {
  instanceConfig.value.defaultThemeJson = ''
  instanceBrandingChanged.value = true
  if (authStore.session?.user?.id) {
    try {
      await adminService.setInstanceConfigs({
        default_theme_json: '',
      }, authStore.session.user.id)
      toast.success('Default theme cleared')
    } catch {
      toast.error('Failed to clear default theme')
    }
  }
}

const saveOAuthProviders = async () => {
  if (!authStore.session?.user?.id) {
    toast.error('You must be logged in to save OAuth provider settings')
    return
  }

  savingOAuthProviders.value = true
  try {
    // Build array of enabled providers
    const enabledProviders: string[] = []
    if (oauthProviders.value.google) enabledProviders.push('google')
    if (oauthProviders.value.twitch) enabledProviders.push('twitch')
    if (oauthProviders.value.github) enabledProviders.push('github')

    // Save OAuth providers as an array
    await adminService.setInstanceConfig(
      'oauth_providers',
      enabledProviders, // Pass as array, Supabase will convert to JSONB
      authStore.session.user.id,
      'Enabled OAuth providers'
    )

    oauthProvidersChanged.value = false
    toast.success('OAuth provider settings saved successfully')
    debug.log('OAuth providers saved:', enabledProviders)
  } catch (error: any) {
    debug.error('Failed to save OAuth provider settings:', error)
    toast.error(error.message || 'Failed to save OAuth provider settings')
  } finally {
    savingOAuthProviders.value = false
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

const getActivityCategory = (type: string): string => {
  if (!type) return 'other'
  const t = type.toLowerCase()
  if (t.startsWith('instance_') || t.includes('federation') || t.includes('add_instance')) return 'federation'
  if (t.startsWith('user_') || t.includes('moderate') || t.includes('report') || t.includes('suspend')) return 'moderation'
  if (t.includes('security') || t.includes('login') || t.includes('config')) return 'security'
  return 'other'
}

const CONFIG_KEY_LABELS: Record<string, string> = {
  instance_name: 'Instance name',
  instance_description: 'Instance description',
  terms_url: 'Terms URL',
  privacy_url: 'Privacy URL',
  max_post_length: 'Max post length',
  max_server_size: 'Max server size',
  max_message_length: 'Max message length',
  max_custom_emojis_per_server: 'Max custom emojis per server',
  custom_emoji_transform_quality: 'Custom emoji image quality',
  allow_file_uploads: 'Allow file uploads',
  enable_voice_channels: 'Enable voice channels',
  federation_retry_attempts: 'Federation retry attempts',
  oauth_providers: 'OAuth providers'
}

const formatConfigValue = (v: unknown): string => {
  if (v == null || (typeof v === 'string' && v === '')) return '(empty)'
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const formatActivityMessage = (event: { type: string; message: string | object; targetUsername?: string }) => {
  const raw = event.message
  const targetUser = event.targetUsername
  if (raw == null || raw === '') {
    if (event.type?.startsWith('user_') && targetUser) {
      const verb = event.type === 'user_suspend' ? 'Suspended' : event.type === 'user_delete' ? 'Deleted' : event.type === 'user_unsuspend' ? 'Unsuspended' : event.type
      return `${verb} @${targetUser}`
    }
    return event.type || 'Event'
  }
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (typeof obj !== 'object' || obj === null) return String(raw)

    // Config change: key, new_value, old_value
    if (obj.key != null && ('new_value' in obj || 'old_value' in obj)) {
      const label = CONFIG_KEY_LABELS[obj.key] || obj.key.replace(/_/g, ' ')
      const newVal = formatConfigValue(obj.new_value)
      const oldVal = formatConfigValue(obj.old_value)
      if (oldVal !== '(empty)' && newVal !== oldVal) {
        return `${label}: ${newVal} (was ${oldVal})`
      }
      return `${label}: ${newVal}`
    }

    // User moderation with target
    if ((event.type?.startsWith('user_') || obj.action === 'suspend' || obj.action === 'delete' || obj.action === 'unsuspend') && (targetUser || obj.user_id)) {
      const who = targetUser ? `@${targetUser}` : (obj.user_id ? `user ${String(obj.user_id).slice(0, 8)}…` : '')
      const reason = obj.reason ? ` - ${obj.reason}` : ''
      const verb = event.type === 'user_suspend' ? 'Suspended' : event.type === 'user_delete' ? 'Deleted' : event.type === 'user_unsuspend' ? 'Unsuspended' : ''
      return `${verb || 'Moderated'} ${who}${reason}`.trim()
    }

    // Build human-readable message from common keys
    const parts: string[] = []
    if (obj.domain) parts.push(obj.domain)
    if (obj.reason) parts.push(`- ${obj.reason}`)
    if (obj.action) parts.push(`(${obj.action})`)
    if (obj.user_id && !targetUser) parts.push(`user: ${obj.user_id}`)
    if (targetUser) parts.unshift(`@${targetUser}`)
    if (parts.length) return parts.join(' ')

    // Fallback: format key-value pairs
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(', ')
  } catch {
    return typeof raw === 'string' ? raw : String(raw)
  }
}

const getActivityIcon = (type: string) => {
  const cat = getActivityCategory(type)
  switch (cat) {
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
      loadFederatedInstances(),
      loadFederationStats()
    ])
  } catch (error) {
    debug.error('Failed to refresh federation data:', error)
  } finally {
    loadingStates.value.federationStats = false
  }
}

const loadFederationStats = async () => {
  try {
    const [stats, deadEndpoints] = await Promise.all([
      adminService.getFederationStats(),
      adminService.getDeadEndpoints()
    ])
    federationStats.value = stats
    deadEndpointsList.value = deadEndpoints
  } catch (error) {
    debug.error('Failed to load federation stats:', error)
  }
}

const getEndpointHealthClass = (health: FederationStats['endpoint_health']) => {
  if (health.dead_endpoints > 0) return 'error'
  if (health.success_rate < 80) return 'warning'
  return 'healthy'
}

const purgeDeadEndpoints = async () => {
  if (!confirm(`Permanently remove all ${federationStats.value?.endpoint_health.dead_endpoints} dead endpoint(s) and their failed deliveries? This cannot be undone.`)) return
  loadingStates.value.purgingDead = true
  try {
    const result = await adminService.purgeDeadEndpoints()
    debug.log(`Purged ${result.purgedEndpoints} dead endpoints and ${result.purgedDeliveries} failed deliveries`)
    await loadFederationStats()
  } catch (error) {
    debug.error('Failed to purge dead endpoints:', error)
  } finally {
    loadingStates.value.purgingDead = false
  }
}

const purgeSingleEndpoint = async (endpoint: DeadEndpoint) => {
  purgingEndpointIds.value.add(endpoint.id)
  try {
    await adminService.purgeSingleEndpoint(endpoint.id, endpoint.endpoint_url)
    deadEndpointsList.value = deadEndpointsList.value.filter(e => e.id !== endpoint.id)
    if (federationStats.value) {
      federationStats.value.endpoint_health.dead_endpoints--
      federationStats.value.endpoint_health.total_endpoints--
    }
  } catch (error) {
    debug.error('Failed to purge endpoint:', error)
  } finally {
    purgingEndpointIds.value.delete(endpoint.id)
  }
}

const formatTimeAgo = (dateStr: string | null): string => {
  if (!dateStr) return 'Never'
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHrs = Math.floor(diffMin / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  const diffDays = Math.floor(diffHrs / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

// Federation maintenance methods
const refreshKeyConsistency = async () => {
  loadingStates.value.keyConsistency = true
  try {
    keyConsistency.value = await adminService.getKeyConsistencyReport()
  } catch (error) {
    debug.error('Failed to load key consistency:', error)
  } finally {
    loadingStates.value.keyConsistency = false
  }
}

const runKeyGenerationSweep = async () => {
  loadingStates.value.keySweep = true
  try {
    const result = await adminService.runKeyGenerationSweep()
    if (result.success) {
      debug.log('Key generation sweep queued:', result.message)
      // Refresh consistency after a short delay to see results
      setTimeout(() => refreshKeyConsistency(), 3000)
    } else {
      debug.error('Key generation sweep failed:', result.message)
    }
  } catch (error) {
    debug.error('Failed to run key sweep:', error)
  } finally {
    loadingStates.value.keySweep = false
  }
}

const runOrphanCleanup = async () => {
  loadingStates.value.orphanCleanup = true
  try {
    const result = await adminService.runOrphanedKeyCleanup()
    if (result.success) {
      debug.log('Orphan cleanup queued:', result.message)
      setTimeout(() => refreshKeyConsistency(), 3000)
    } else {
      debug.error('Orphan cleanup failed:', result.message)
    }
  } catch (error) {
    debug.error('Failed to run orphan cleanup:', error)
  } finally {
    loadingStates.value.orphanCleanup = false
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
  font-family: var(--font-family);
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

.setting-control-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.setting-control-row .setting-hint {
  margin-bottom: 0;
}

.refresh-trending-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.refresh-trending-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
  transform: none;
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

/* Override parent label styles so toggles stay horizontal and text doesn't truncate */
.setting-group .toggle-label,
.announcement-form .form-row.checks .toggle-label {
  display: flex;
  margin-bottom: 0;
}

.toggle-label .toggle-slider {
  flex-shrink: 0;
}

.toggle-label .toggle-text {
  flex-shrink: 0;
  white-space: nowrap;
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
  color: var(--text-primary);
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

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-header h3 {
  margin: 0;
}

.health-indicator {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.health-indicator.healthy {
  background: rgba(0, 255, 136, 0.2);
  color: #00ff88;
}

.health-indicator.warning {
  background: rgba(255, 193, 7, 0.2);
  color: #ffc107;
}

.health-indicator.error {
  background: rgba(255, 69, 58, 0.2);
  color: #ff453a;
}

.endpoint-details {
  margin-top: 16px;
}

.warning-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: rgba(255, 193, 7, 0.1);
  border: 1px solid rgba(255, 193, 7, 0.3);
  border-radius: 8px;
  color: #ffc107;
  font-size: 14px;
  flex-wrap: wrap;
}

.purge-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid rgba(255, 69, 58, 0.4);
  background: rgba(255, 69, 58, 0.15);
  color: #ff453a;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.purge-btn:hover:not(:disabled) {
  background: rgba(255, 69, 58, 0.3);
  border-color: rgba(255, 69, 58, 0.6);
}

.purge-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinner-small {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 69, 58, 0.3);
  border-top-color: #ff453a;
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.8s linear infinite;
}

.dead-endpoints-list {
  margin-top: 10px;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--background-secondary);
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
}

.dead-endpoint-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  transition: background 0.15s ease;
}

.dead-endpoint-row:last-child {
  border-bottom: none;
}

.dead-endpoint-row:hover {
  background: var(--background-modifier-hover);
}

.dead-endpoint-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dead-endpoint-url {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dead-endpoint-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.meta-tag {
  font-size: 0.7rem;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-secondary);
  white-space: nowrap;
}

.meta-tag.domain {
  color: var(--harmony-primary, #7c8aff);
  background: rgba(124, 138, 255, 0.12);
}

.meta-tag.failures {
  color: #ff453a;
  background: rgba(255, 69, 58, 0.12);
}

.dead-endpoint-error {
  font-size: 0.75rem;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.purge-single-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
  margin-top: 2px;
}

.purge-single-btn:hover:not(:disabled) {
  background: rgba(255, 69, 58, 0.15);
  border-color: rgba(255, 69, 58, 0.3);
  color: #ff453a;
}

.purge-single-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Federation Maintenance Styles */
.section-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-header-row h3 {
  margin: 0;
}

.maintenance-status {
  margin-bottom: 20px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 14px;
  width:100%;
}

.status-indicator.ok {
  background: rgba(0, 255, 136, 0.1);
  border: 1px solid rgba(0, 255, 136, 0.3);
  color: #00ff88;
}

.status-indicator.needs_attention {
  background: rgba(255, 193, 7, 0.1);
  border: 1px solid rgba(255, 193, 7, 0.3);
  color: #ffc107;
}

.maintenance-actions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.maintenance-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: var(--surface-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.maintenance-info h4 {
  margin: 0 0 4px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.maintenance-info p {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.maintenance-card .action-btn.primary {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
}

.scheduled-info {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.error-text {
  color: #ff453a;
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
  color: var(--text-primary);
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
  color: var(--text-primary);
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
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 600px;
  overflow-y: auto;
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

.badge.moderator {
  background: rgba(46, 204, 113, 0.2);
  color: #2ecc71;
}

.promote-btn {
  color: #2ecc71 !important;
  &:hover { background: rgba(46, 204, 113, 0.2) !important; }
}

.demote-btn {
  color: #e67e22 !important;
  &:hover { background: rgba(230, 126, 34, 0.2) !important; }
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

.metric-card.placeholder-metric {
  opacity: 0.5;
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

.activity-icon.other {
  background: rgba(128, 128, 128, 0.1);
  color: var(--text-secondary);
}

/* Announcements module */
.module-hint {
  font-size: 13px;
  color: var(--text-secondary);
  padding: 16px 24px;
  margin: 0;
  text-align: center;
  line-height: 1.5;
}
.announcement-form {
  margin: 0 24px 20px;
  padding: 20px;
  background: var(--background-tertiary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}
.announcement-form h4 { margin: 0 0 16px 0; }
.announcement-form .form-row { margin-bottom: 12px; }
.announcement-form .form-row label { display: block; font-size: 13px; margin-bottom: 4px; color: var(--text-secondary); }
.announcement-form .form-row.checks { display: flex; gap: 16px; flex-wrap: wrap; }
.announcement-form .form-row.two-col {
  /* Two-up layout for the scheduling inputs so the form doesn't get
     unnecessarily tall. Collapses to a stack on narrow viewports. */
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 640px) {
  .announcement-form .form-row.two-col { grid-template-columns: 1fr; }
}
.announcement-form .form-row.two-col > div { display: flex; flex-direction: column; }
.announcement-form .form-row.two-col label { margin-bottom: 4px; }
.announcement-form .form-hint {
  margin: 4px 0 0 0;
  font-size: 11px;
  color: var(--text-muted, #949ba4);
  line-height: 1.35;
}
.announcement-form .form-actions { display: flex; gap: 8px; margin-top: 16px; }
.announcements-list { padding: 0 24px 24px; }
.announcement-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border-radius: 8px;
  margin-bottom: 8px;
  border: 1px solid var(--border-color);
}
.announcement-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.announcement-icon { font-size: 18px; }
.announcement-title { font-weight: 600; color: var(--text-primary); }
.announcement-item .badge.inactive { background: var(--background-quaternary); color: var(--text-muted); }
.announcement-actions { display: flex; gap: 4px; }

/* Featured Communities Module */
.featured-module .module-hint { margin: 0 24px 16px; font-size: 13px; color: var(--text-secondary); }
.featured-servers-list { display: flex; flex-direction: column; gap: 8px; padding: 0 24px 24px; }
.featured-server-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
  transition: all 0.2s ease;
}
.featured-server-item:hover { border-color: var(--accent-color); }
.featured-server-item.featured {
  border-color: rgba(255, 193, 7, 0.5);
  background: rgba(255, 193, 7, 0.05);
}
.server-icon-wrap {
  position: relative;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
}
.server-icon {
  width: 100%;
  height: 100%;
  border-radius: 8px;
  object-fit: cover;
}
.featured-badge {
  position: absolute;
  bottom: -4px;
  right: -4px;
  color: var(--accent-color);
  background: var(--background-secondary);
  border-radius: 50%;
  padding: 2px;
}
.server-details { flex: 1; min-width: 0; }
.server-details .server-name { font-weight: 600; color: var(--text-primary); }
.server-details .server-meta { font-size: 13px; color: var(--text-secondary); }
.featured-order { margin-left: 8px; opacity: 0.8; }
.featured-server-item .action-btn-sm.pin-btn { color: var(--accent-color); }
.featured-server-item .action-btn-sm.unpin-btn { color: var(--text-secondary); }
.featured-server-item .action-btn-sm { display: flex; align-items: center; gap: 6px; }

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
.config-tabs {
  display: flex;
  gap: 4px;
  padding: 12px 24px 0;
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
}

.config-tab-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.config-tab-btn:hover {
  color: var(--text-primary);
  background: var(--background-tertiary);
  border-radius: 6px 6px 0 0;
}

.config-tab-btn.active {
  color: var(--accent-color);
  border-bottom-color: var(--accent-color);
}

.config-sections {
  padding: 24px;
}

.config-section {
  margin-bottom: 0;
}

.config-section h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--text-primary);
}

.config-subsection {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--border-color);
}

.config-subsection h4 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 14px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* Instance appearance (icon/banner) */
.instance-appearance-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 8px;
}

.instance-icon-preview {
  width: 64px;
  height: 64px;
  border-radius: 12px;
  background: var(--background-tertiary);
  border: 2px dashed var(--border-color);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: hidden;
  flex-shrink: 0;
  transition: border-color 0.2s;
  color: var(--text-secondary);
}

.instance-icon-preview:hover {
  border-color: var(--harmony-primary);
}

.instance-icon-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.instance-appearance-controls {
  display: flex;
  gap: 8px;
}

.instance-banner-preview {
  width: 100%;
  height: 100px;
  border-radius: 8px;
  background: var(--background-tertiary);
  background-size: cover;
  background-position: center;
  border: 2px dashed var(--border-color);
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: border-color 0.2s;
}

.instance-banner-preview:hover {
  border-color: var(--harmony-primary);
}

.instance-banner-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--text-secondary);
  font-size: 13px;
}

.instance-banner-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 14px;
  font-weight: 500;
  opacity: 0;
  transition: opacity 0.2s;
}

.instance-banner-preview:hover .instance-banner-overlay {
  opacity: 1;
}

.save-btn {
  padding: 8px 16px;
  background: var(--accent-color);
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
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
  .admin-grid {
    display: flex;
    flex-direction: column;
    flex-wrap: wrap;
    gap: 16px;
  }
  .admin-module {
    max-width: calc(100vw - 32px);
  }
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

/* Reports & Moderation */
.reports-badge {
  background: #ed4245;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 10px;
  margin-left: auto;
}

.report-filters {
  display: flex;
  gap: 4px;
  padding: 16px 20px;
  flex-wrap: wrap;
}

.reports-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 20px 20px;
}

.report-item {
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.report-item:hover {
  border-color: var(--accent-color);
}

.report-item.expanded {
  border-color: var(--accent-color);
}

.report-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  flex-wrap: wrap;
}

.report-type-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}

.report-type-badge.user { background: rgba(14, 165, 233, 0.2); color: #38BDF8; }
.report-type-badge.post { background: rgba(87, 242, 135, 0.2); color: #57f287; }
.report-type-badge.message { background: rgba(254, 231, 92, 0.2); color: #fee75c; }
.report-type-badge.server { background: rgba(235, 69, 158, 0.2); color: #eb459e; }

.report-users {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.report-reporter,
.report-reported {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-primary);
}

.report-arrow {
  color: var(--text-secondary);
  font-size: 12px;
}

.report-reason {
  font-size: 13px;
  color: var(--text-secondary);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 80px;
}

.report-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.report-source {
  background: rgba(255, 255, 255, 0.1);
  padding: 1px 6px;
  border-radius: 4px;
}

.report-status-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}

.report-status-badge.pending { background: rgba(254, 231, 92, 0.2); color: #fee75c; }
.report-status-badge.investigating { background: rgba(14, 165, 233, 0.2); color: #38BDF8; }
.report-status-badge.resolved { background: rgba(87, 242, 135, 0.2); color: #57f287; }
.report-status-badge.dismissed { background: rgba(255, 255, 255, 0.1); color: var(--text-secondary); }

.report-detail {
  border-top: 1px solid var(--border-color);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.report-detail label {
  display: flex;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin-bottom: 4px;
  letter-spacing: 0.5px;
}

.report-detail p {
  margin: 0;
  font-size: 14px;
  color: var(--text-primary);
}

.report-proof blockquote {
  margin: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--accent-color);
  background: rgba(0, 0, 0, 0.2);
  border-radius: 0 6px 6px 0;
  font-size: 14px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.report-proof :deep(.report-link) {
  color: var(--accent-color);
  text-decoration: underline;
  word-break: break-all;
}

.report-proof :deep(.report-link:hover) {
  opacity: 0.8;
}

.report-actions-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.resolution-textarea {
  width: 100%;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
}

.report-punitive-actions {
  display: flex;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 4px;
}

.report-action-btn.danger {
  background: rgba(237, 66, 69, 0.2);
  color: #ed4245;
}

.report-action-btn.danger:hover {
  background: rgba(237, 66, 69, 0.4);
}

.report-action-buttons {
  display: flex;
  gap: 8px;
}

.report-action-btn {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.report-action-btn:hover {
  opacity: 0.85;
}

.report-action-btn.investigating {
  background: rgba(14, 165, 233, 0.3);
  color: #38BDF8;
}

.report-action-btn.resolve {
  background: rgba(87, 242, 135, 0.3);
  color: #57f287;
}

.report-action-btn.dismiss {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-secondary);
}

.report-action-btn.warning {
  background: rgba(250, 166, 26, 0.2);
  color: #faa61a;
}

.report-action-btn.warning:hover {
  background: rgba(250, 166, 26, 0.4);
}

.federation-badge {
  background: rgba(88, 101, 242, 0.2);
  color: #7c8af5;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  margin-left: 4px;
}

.report-user-link {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.report-user-link:hover {
  text-decoration: underline;
  color: var(--accent-color);
}

.report-external-link {
  display: inline-flex;
  align-items: center;
  color: var(--text-secondary);
  margin-left: 4px;
  opacity: 0.7;
  transition: opacity 0.15s;
}

.report-external-link:hover {
  opacity: 1;
  color: var(--accent-color);
}

.report-source-local {
  font-size: 11px;
  color: var(--text-tertiary);
}

.report-post-meta {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.badge.sensitive {
  background: rgba(250, 166, 26, 0.2);
  color: #faa61a;
}

.badge.cw {
  background: rgba(88, 101, 242, 0.2);
  color: #7c8af5;
}

.badge.silenced {
  background: rgba(250, 166, 26, 0.2);
  color: #faa61a;
}

.report-post-links {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.report-link-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s;
}

.report-link-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text-primary);
}

.mod-btn.warning-btn {
  background: rgba(250, 166, 26, 0.15);
  color: #faa61a;
}

.mod-btn.warning-btn:hover {
  background: rgba(250, 166, 26, 0.3);
}

.reports-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 40px 20px;
  color: var(--text-secondary);
  font-size: 14px;
}

/* Funding Management */
.funding-content {
  padding: 0 20px 20px;
}

.funding-section {
  margin-bottom: 24px;
  padding-top :24px;
}

.funding-section h3 {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.section-badge {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(14, 165, 233, 0.15);
  color: var(--harmony-primary);
  text-transform: none;
  letter-spacing: 0;
  font-weight: 600;
}

.section-description {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 8px;
  line-height: 1.5;
}

.section-description a {
  color: var(--harmony-primary);
}

.section-hint {
  font-size: 12px;
  color: var(--text-tertiary, var(--text-secondary));
  margin: 8px 0 0;
  line-height: 1.5;
  font-style: italic;
}

.section-hint code {
  background: var(--background-secondary);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
  font-style: normal;
}

.webhook-url-display {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
}

.webhook-url-display code {
  flex: 1;
  color: var(--text-primary);
  word-break: break-all;
}

.pending-count-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--status-danger, #ed4245);
  color: #fff;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 700;
}

.pending-donations-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pending-donation-item {
  padding: 12px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pending-donation-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pending-amount {
  font-size: 16px;
  font-weight: 700;
  color: var(--harmony-primary);
}

.pending-platform {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-secondary);
  text-transform: capitalize;
}

.pending-date {
  font-size: 12px;
  color: var(--text-tertiary, var(--text-secondary));
  margin-left: auto;
}

.pending-donation-meta {
  display: flex;
  gap: 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.pending-email {
  color: var(--text-tertiary, var(--text-secondary));
}

.pending-message {
  padding: 8px 12px;
  background: var(--background-tertiary);
  border-left: 3px solid var(--harmony-primary);
  border-radius: 4px;
  font-size: 13px;
  color: var(--text-secondary);
  font-style: italic;
}

.pending-resolve-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.pending-suggestions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 4px;
}

.pending-suggestion {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  transition: background 0.15s;
}

.pending-suggestion:hover,
.pending-suggestion.active {
  background: rgba(14, 165, 233, 0.15);
  color: var(--text-primary);
}

.funding-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.funding-form-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.funding-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 120px;
}

.funding-field label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 600;
}

.tiers-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.tier-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--background-tertiary);
  border-radius: 6px;
}

.tier-icon {
  font-size: 18px;
}

.tier-icon-picker {
  display: flex;
  align-items: center;
  gap: 4px;
}

.emoji-picker-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  font-size: 16px;
  padding: 2px 4px;
  cursor: pointer;
}

.icon-preview-img {
  height: 1.2em;
  width: auto;
  vertical-align: -0.15em;
  object-fit: contain;
}

.tier-info {
  flex: 1;
  min-width: 0;
}

.tier-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  display: block;
}

.tier-amount {
  font-size: 12px;
  color: var(--text-secondary);
}

.add-tier-form {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  flex-wrap: wrap;
}

.add-tier-form .cyber-input {
  flex: 1;
  min-width: 100px;
}

.color-input {
  width: 36px;
  height: 36px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--background-tertiary);
  cursor: pointer;
  padding: 2px;
}

.supporters-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.supporter-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--background-tertiary);
  border-radius: 6px;
}

.supporter-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.supporter-info {
  flex: 1;
  min-width: 0;
}

.supporter-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  display: block;
}

.supporter-meta {
  font-size: 12px;
  color: var(--text-secondary);
}

.donation-stats-row {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
}

.donation-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border-radius: 8px;
  flex: 1;
}

.donation-stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--accent-color);
}

.donation-stat-label {
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
}

.donations-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
}

.donation-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--text-secondary);
}

.donation-amount {
  font-weight: 600;
  color: var(--text-primary);
}

.donation-note {
  font-style: italic;
  opacity: 0.7;
}

.funding-links-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.funding-link-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.funding-link-row .cyber-input {
  min-width: 0;
}

.add-supporter-form {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  flex-wrap: wrap;
  margin-top: 12px;
}

.add-supporter-form .cyber-input {
  flex: 1;
  min-width: 100px;
}

.supporter-search-wrapper .cyber-input {
  width: 100%;
}

.supporter-suggestions {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 100;
  background: var(--background-tertiary);
  border: 1px solid var(--h-black-lighter);
  border-radius: 8px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  max-height: 220px;
  overflow-y: auto;
  margin-top: 4px;
}

.supporter-suggestion-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background-color 0.1s ease;
}

.supporter-suggestion-item:hover,
.supporter-suggestion-item.selected {
  background: var(--harmony-primary);
}

.supporter-suggestion-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.supporter-suggestion-name {
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.supporter-suggestion-handle {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.supporter-suggestion-item.selected .supporter-suggestion-handle {
  color: rgba(255, 255, 255, 0.6);
}

.edit-supporter-panel {
  background: var(--background-tertiary);
  border: 1px solid var(--accent-color);
  border-radius: 8px;
  padding: 16px;
}

.edit-donation-panel {
  background: var(--background-tertiary);
  border: 1px solid var(--accent-color);
  border-radius: 8px;
  padding: 12px;
  margin-top: 8px;
}

.donation-user {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 13px;
}

.donation-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
  flex-shrink: 0;
}

.tier-perks {
  font-size: 11px;
  color: var(--text-secondary);
  font-style: italic;
}

.empty-hint {
  font-size: 13px;
  color: var(--text-secondary);
  padding: 12px;
  text-align: center;
  background: var(--background-tertiary);
  border-radius: 6px;
  margin-bottom: 12px;
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