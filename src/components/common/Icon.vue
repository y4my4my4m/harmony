<template>
  <svg 
    :class="['icon', `icon-${name}`, { [`icon-${size}`]: size }]"
    :width="iconSize" 
    :height="iconSize" 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    stroke-width="2" 
    stroke-linecap="round" 
    stroke-linejoin="round"
  >
    <!-- Camera -->
    <path v-if="name === 'camera'" d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
    <circle v-if="name === 'camera'" cx="12" cy="13" r="4"></circle>
    
    <!-- Camera Off -->
    <line v-if="name === 'camera-off'" x1="1" y1="1" x2="23" y2="23"></line>
    <path v-if="name === 'camera-off'" d="m21 21-3.6-3.6c-.2.1-.4.2-.6.2H3a2 2 0 0 1-2-2V8c0-.4.1-.8.3-1.2L5 10.7V19h10.7l-2.4-2.4"></path>
    
    <!-- Screen Share -->
    <rect v-if="name === 'screen-share'" x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
    <line v-if="name === 'screen-share'" x1="8" y1="21" x2="16" y2="21"></line>
    <line v-if="name === 'screen-share'" x1="12" y1="17" x2="12" y2="21"></line>
    
    <!-- Microphone -->
    <path v-if="name === 'mic'" d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
    <path v-if="name === 'mic'" d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
    <line v-if="name === 'mic'" x1="12" y1="19" x2="12" y2="23"></line>
    <line v-if="name === 'mic'" x1="8" y1="23" x2="16" y2="23"></line>
    
    <!-- Microphone Off -->
    <line v-if="name === 'mic-off'" x1="1" y1="1" x2="23" y2="23"></line>
    <path v-if="name === 'mic-off'" d="M9 9v3a3 3 0 0 0 5.12 2.12l1.27-1.27A3 3 0 0 0 15 12V4a3 3 0 0 0-6 0v.17"></path>
    <path v-if="name === 'mic-off'" d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
    <line v-if="name === 'mic-off'" x1="12" y1="19" x2="12" y2="23"></line>
    <line v-if="name === 'mic-off'" x1="8" y1="23" x2="16" y2="23"></line>
    
    <!-- Headphones -->
    <path v-if="name === 'headphones'" d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
    <path v-if="name === 'headphones'" d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zm-14 0a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"></path>
    
    <!-- Headphones Off -->
    <path v-if="name === 'headphones-off'" d="M21 14h-1.343a2 2 0 0 0-1.414.586L17 16.828V19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 .586-1.414L14.828 13"></path>
    <path v-if="name === 'headphones-off'" d="M7 14H4a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2z"></path>
    <line v-if="name === 'headphones-off'" x1="1" y1="1" x2="23" y2="23"></line>
    
    <!-- Phone -->
    <path v-if="name === 'phone'" d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
    
    <!-- Phone Off -->
    <path v-if="name === 'phone-off'" d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path>
    <line v-if="name === 'phone-off'" x1="23" y1="1" x2="1" y2="23"></line>
    
    <!-- WiFi Low -->
    <path v-if="name === 'wifi-low'" d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9z"></path>
    <path v-if="name === 'wifi-low'" d="M5 13l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.24 9.24 8.76 9.24 5 13z"></path>
    <line v-if="name === 'wifi-low'" x1="1" y1="1" x2="23" y2="23"></line>
    
    <!-- Settings -->
    <circle v-if="name === 'settings'" cx="12" cy="12" r="3"></circle>
    <path v-if="name === 'settings'" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1 1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    
    <!-- Volume -->
    <polygon v-if="name === 'volume'" points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
    <path v-if="name === 'volume'" d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
    
    <!-- Volume Off -->
    <polygon v-if="name === 'volume-off'" points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
    <line v-if="name === 'volume-off'" x1="23" y1="9" x2="17" y2="15"></line>
    <line v-if="name === 'volume-off'" x1="17" y1="9" x2="23" y2="15"></line>
    
    <!-- Expand -->
    <polyline v-if="name === 'expand'" points="15,3 21,3 21,9"></polyline>
    <polyline v-if="name === 'expand'" points="9,21 3,21 3,15"></polyline>
    <line v-if="name === 'expand'" x1="21" y1="3" x2="14" y2="10"></line>
    <line v-if="name === 'expand'" x1="3" y1="21" x2="10" y2="14"></line>
    
    <!-- X (Close) -->
    <line v-if="name === 'x'" x1="18" y1="6" x2="6" y2="18"></line>
    <line v-if="name === 'x'" x1="6" y1="6" x2="18" y2="18"></line>
    
    <!-- Grid -->
    <rect v-if="name === 'grid'" x="3" y="3" width="7" height="7"></rect>
    <rect v-if="name === 'grid'" x="14" y="3" width="7" height="7"></rect>
    <rect v-if="name === 'grid'" x="14" y="14" width="7" height="7"></rect>
    <rect v-if="name === 'grid'" x="3" y="14" width="7" height="7"></rect>
    
    <!-- List -->
    <line v-if="name === 'list'" x1="8" y1="6" x2="21" y2="6"></line>
    <line v-if="name === 'list'" x1="8" y1="12" x2="21" y2="12"></line>
    <line v-if="name === 'list'" x1="8" y1="18" x2="21" y2="18"></line>
    <line v-if="name === 'list'" x1="3" y1="6" x2="3.01" y2="6"></line>
    <line v-if="name === 'list'" x1="3" y1="12" x2="3.01" y2="12"></line>
    <line v-if="name === 'list'" x1="3" y1="18" x2="3.01" y2="18"></line>
    
    <!-- Picture in Picture -->
    <path v-if="name === 'picture-in-picture'" d="M2 3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h20a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H2z"></path>
    <path v-if="name === 'picture-in-picture'" d="M13 8.5v7h7v-7h-7z"></path>
    
    <!-- Keyboard -->
    <rect v-if="name === 'keyboard'" x="2" y="4" width="20" height="16" rx="2"></rect>
    <path v-if="name === 'keyboard'" d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M7 16h10"></path>

    <!-- Maximize -->
    <rect v-if="name === 'maximize'" x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <polyline v-if="name === 'maximize'" points="7 7 7 5 5 5 5 7"></polyline>
    <polyline v-if="name === 'maximize'" points="17 7 19 7 19 5 17 5"></polyline>
    <polyline v-if="name === 'maximize'" points="17 17 19 17 19 19 17 19"></polyline>
    <polyline v-if="name === 'maximize'" points="7 17 7 19 5 19 5 17"></polyline>

    <!-- Minimize -->
    <rect v-if="name === 'minimize'" x="3" y="11" width="18" height="2" rx="1" ry="1"></rect>
    
    <!-- User -->
    <circle v-if="name === 'user'" cx="12" cy="7" r="4"></circle>
    <path v-if="name === 'user'" d="M20 21v-2a7 5 0 0 0-16 0v2"></path>
    
    <!-- Map -->
    <polygon v-if="name === 'map'" points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon>
    <line v-if="name === 'map'" x1="8" y1="2" x2="8" y2="18"></line>
    <line v-if="name === 'map'" x1="16" y1="6" x2="16" y2="22"></line>
    
    <!-- Volume Spatial -->
    <polygon v-if="name === 'volume-spatial'" points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
    <circle v-if="name === 'volume-spatial'" cx="19" cy="9" r="2"></circle>
    <circle v-if="name === 'volume-spatial'" cx="17" cy="15" r="1.5"></circle>
    <circle v-if="name === 'volume-spatial'" cx="21" cy="15" r="1"></circle>
    
    <!-- Refresh -->
    <polyline v-if="name === 'refresh'" points="23 4 23 10 17 10"></polyline>
    <polyline v-if="name === 'refresh'" points="1 20 1 14 7 14"></polyline>
    <path v-if="name === 'refresh'" d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path>
    
    <!-- Shuffle -->
    <polyline v-if="name === 'shuffle'" points="16 3 21 3 21 8"></polyline>
    <line v-if="name === 'shuffle'" x1="4" y1="7" x2="4" y2="7"></line>
    <line v-if="name === 'shuffle'" x1="21" y1="3" x2="11" y2="13"></line>
    <line v-if="name === 'shuffle'" x1="16" y1="21" x2="21" y2="16"></line>
    <line v-if="name === 'shuffle'" x1="4" y1="17" x2="9" y2="12"></line>
    
    <!-- Check Circle -->
    <path v-if="name === 'check-circle'" d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
    <polyline v-if="name === 'check-circle'" points="22 4 12 14.01 9 11.01"></polyline>
    
    <!-- Circle -->
    <circle v-if="name === 'circle'" cx="12" cy="12" r="10"></circle>
    
    <!-- At Sign -->
    <circle v-if="name === 'at-sign'" cx="12" cy="12" r="4"></circle>
    <path v-if="name === 'at-sign'" d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"></path>
    
    <!-- Message Circle -->
    <path v-if="name === 'message-circle'" d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
    
    <!-- Heart -->
    <path v-if="name === 'heart'" d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>

    <!-- Heart Filled -->
    <path
      v-if="name === 'heart-filled'"
      d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
      fill="currentColor"
      stroke="none"
    ></path>
    
    <!-- Mouse Pointer -->
    <path v-if="name === 'mouse-pointer'" d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"></path>
    <path v-if="name === 'mouse-pointer'" d="M13 13l6 6"></path>
    
    <!-- Info -->
    <circle v-if="name === 'info'" cx="12" cy="12" r="10"></circle>
    <line v-if="name === 'info'" x1="12" y1="16" x2="12" y2="12"></line>
    <line v-if="name === 'info'" x1="12" y1="8" x2="12.01" y2="8"></line>
    
    <!-- Music -->
    <path v-if="name === 'music'" d="M9 18V5l12-2v13"></path>
    <circle v-if="name === 'music'" cx="6" cy="18" r="3"></circle>
    <circle v-if="name === 'music'" cx="18" cy="16" r="3"></circle>
    
    <!-- Volume 2 -->
    <polygon v-if="name === 'volume-2'" points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
    <path v-if="name === 'volume-2'" d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"></path>
    
    <!-- Database -->
    <ellipse v-if="name === 'database'" cx="12" cy="5" rx="9" ry="3"></ellipse>
    <path v-if="name === 'database'" d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
    <path v-if="name === 'database'" d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
    
    <!-- Download -->
    <path v-if="name === 'download'" d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
    <polyline v-if="name === 'download'" points="7 10 12 15 17 10"></polyline>
    <line v-if="name === 'download'" x1="12" y1="15" x2="12" y2="3"></line>
    
    <!-- Trash 2 -->
    <polyline v-if="name === 'trash-2'" points="3 6 5 6 21 6"></polyline>
    <path v-if="name === 'trash-2'" d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
    <line v-if="name === 'trash-2'" x1="10" y1="11" x2="10" y2="17"></line>
    <line v-if="name === 'trash-2'" x1="14" y1="11" x2="14" y2="17"></line>

    <!-- Admin Terminal -->
    <rect v-if="name === 'admin-terminal'" x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
    <polyline v-if="name === 'admin-terminal'" points="6 7 8 9 6 11"></polyline>
    <line v-if="name === 'admin-terminal'" x1="10" y1="11" x2="14" y2="11"></line>

    <!-- Dashboard -->
    <rect v-if="name === 'dashboard'" x="3" y="3" width="7" height="9"></rect>
    <rect v-if="name === 'dashboard'" x="13" y="3" width="8" height="5"></rect>
    <rect v-if="name === 'dashboard'" x="13" y="12" width="8" height="9"></rect>
    <rect v-if="name === 'dashboard'" x="3" y="16" width="7" height="5"></rect>

    <!-- Users -->
    <path v-if="name === 'users'" d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
    <circle v-if="name === 'users'" cx="9" cy="7" r="4"></circle>
    <path v-if="name === 'users'" d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
    <path v-if="name === 'users'" d="M16 3.13a4 4 0 0 1 0 7.75"></path>

    <!-- Server -->
    <rect v-if="name === 'server'" x="2" y="3" width="20" height="3" rx="1" ry="1"></rect>
    <rect v-if="name === 'server'" x="2" y="10" width="20" height="3" rx="1" ry="1"></rect>
    <rect v-if="name === 'server'" x="2" y="17" width="20" height="3" rx="1" ry="1"></rect>
    <circle v-if="name === 'server'" cx="7" cy="4.5" r="0.5"></circle>
    <circle v-if="name === 'server'" cx="7" cy="11.5" r="0.5"></circle>
    <circle v-if="name === 'server'" cx="7" cy="18.5" r="0.5"></circle>

    <!-- Federation -->
    <circle v-if="name === 'federation'" cx="9" cy="12" r="1"></circle>
    <circle v-if="name === 'federation'" cx="15" cy="12" r="1"></circle>
    <path v-if="name === 'federation'" d="M8 12h1m4 0h1m-3-5v2m0 6v2"></path>
    <path v-if="name === 'federation'" d="M12 2a4 4 0 0 1 4 4v1.5h1.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2H8V6a4 4 0 0 1 4-4z"></path>

    <!-- Message -->
    <path v-if="name === 'message'" d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
    <polyline v-if="name === 'message'" points="22 6 12 13 2 6"></polyline>

    <!-- Health -->
    <path v-if="name === 'health'" d="M22 12h-4l-3 9L9 3l-3 9H2"></path>

    <!-- Activity -->
    <polyline v-if="name === 'activity'" points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>

    <!-- Search -->
    <circle v-if="name === 'search'" cx="11" cy="11" r="8"></circle>
    <path v-if="name === 'search'" d="M21 21l-4.35-4.35"></path>

    <!-- Unblock -->
    <circle v-if="name === 'unblock'" cx="12" cy="12" r="10"></circle>
    <path v-if="name === 'unblock'" d="M8.5 8.5l7 7"></path>
    <path v-if="name === 'unblock'" d="M15.5 8.5l-7 7"></path>

    <!-- Suspend -->
    <circle v-if="name === 'suspend'" cx="12" cy="12" r="10"></circle>
    <line v-if="name === 'suspend'" x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>

    <!-- Delete -->
    <polyline v-if="name === 'delete'" points="3 6 5 6 21 6"></polyline>
    <path v-if="name === 'delete'" d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>

    <!-- Save -->
    <path v-if="name === 'save'" d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
    <polyline v-if="name === 'save'" points="17 21 17 13 7 13 7 21"></polyline>
    <polyline v-if="name === 'save'" points="7 3 7 8 15 8"></polyline>

    <!-- Shield -->
    <path v-if="name === 'shield'" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>

    <!-- Gavel -->
    <path v-if="name === 'gavel'" d="M6.2 5L3 1.8 4.8 0 8 3.2l1.4 1.4L6.2 8 5 9.2z"></path>
    <path v-if="name === 'gavel'" d="M14.8 19L18 22.2 16.2 24 13 20.8l-1.4-1.4 3.2-3.2 1 -1.2z"></path>
    <path v-if="name === 'gavel'" d="M9.5 14.5l5-5"></path>
    <path v-if="name === 'gavel'" d="M2.5 21.5L6 18l3 3-3.5 3.5z"></path>
    
    <!-- Rotate CCW -->
    <polyline v-if="name === 'rotate-ccw'" points="1 4 1 10 7 10"></polyline>
    <path v-if="name === 'rotate-ccw'" d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
    
    <!-- Eye -->
    <path v-if="name === 'eye'" d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
    <circle v-if="name === 'eye'" cx="12" cy="12" r="3"></circle>
    
    <!-- Eye Off -->
    <path v-if="name === 'eye-off'" d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
    <line v-if="name === 'eye-off'" x1="1" y1="1" x2="23" y2="23"></line>
    
    <!-- Alert Circle -->
    <circle v-if="name === 'alert-circle'" cx="12" cy="12" r="10"></circle>
    <line v-if="name === 'alert-circle'" x1="12" y1="8" x2="12" y2="12"></line>
    <line v-if="name === 'alert-circle'" x1="12" y1="16" x2="12.01" y2="16"></line>
    
    <!-- Volume 1 -->
    <polygon v-if="name === 'volume-1'" points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
    <path v-if="name === 'volume-1'" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
    
    <!-- Refresh CW -->
    <polyline v-if="name === 'refresh-cw'" points="23 4 23 10 17 10"></polyline>
    <path v-if="name === 'refresh-cw'" d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path>
    <polyline v-if="name === 'refresh-cw'" points="1 20 1 14 7 14"></polyline>
    
    <!-- Loader -->
    <line v-if="name === 'loader'" x1="12" y1="2" x2="12" y2="6"></line>
    <line v-if="name === 'loader'" x1="12" y1="18" x2="12" y2="22"></line>
    <line v-if="name === 'loader'" x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
    <line v-if="name === 'loader'" x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
    <line v-if="name === 'loader'" x1="2" y1="12" x2="6" y2="12"></line>
    <line v-if="name === 'loader'" x1="18" y1="12" x2="22" y2="12"></line>
    <line v-if="name === 'loader'" x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
    <line v-if="name === 'loader'" x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
    
    <!-- Toggle Right -->
    <rect v-if="name === 'toggle-right'" x="1" y="5" width="22" height="14" rx="7" ry="7"></rect>
    <circle v-if="name === 'toggle-right'" cx="16" cy="12" r="3"></circle>
    
    <!-- Upload -->
    <path v-if="name === 'upload'" d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
    <polyline v-if="name === 'upload'" points="17 8 12 3 7 8"></polyline>
    <line v-if="name === 'upload'" x1="12" y1="3" x2="12" y2="15"></line>
    
    <!-- Chevron Up -->
    <polyline v-if="name === 'chevron-up'" points="18 15 12 9 6 15"></polyline>
    
    <!-- Chevron Down -->
    <polyline v-if="name === 'chevron-down'" points="6 9 12 15 18 9"></polyline>
    
    <!-- Image -->
    <rect v-if="name === 'image'" x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <circle v-if="name === 'image'" cx="8.5" cy="8.5" r="1.5"></circle>
    <polyline v-if="name === 'image'" points="21 15 16 10 5 21"></polyline>
    
    <!-- Smile -->
    <circle v-if="name === 'smile'" cx="12" cy="12" r="10"></circle>
    <path v-if="name === 'smile'" d="M8 14s1.5 2 4 2 4-2 4-2"></path>
    <line v-if="name === 'smile'" x1="9" y1="9" x2="9.01" y2="9"></line>
    <line v-if="name === 'smile'" x1="15" y1="9" x2="15.01" y2="9"></line>
    
    <!-- Alert Triangle -->
    <path v-if="name === 'alert-triangle'" d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
    <line v-if="name === 'alert-triangle'" x1="12" y1="9" x2="12" y2="13"></line>
    <line v-if="name === 'alert-triangle'" x1="12" y1="17" x2="12.01" y2="17"></line>

    <!-- Home -->
    <path v-if="name === 'home'" d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z"></path>
    <polyline v-if="name === 'home'" points="9 22 9 12 15 12 15 22"></polyline>

    <!-- Bookmark -->
    <path v-if="name === 'bookmark'" d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
    <polyline v-if="name === 'bookmark'" points="17 21 12 16 7 21"></polyline>

    <!-- Bell -->
    <path v-if="name === 'bell'" d="M18 8A6 6 0 0 0 6 8v5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2V8a6 6 0 0 0-6-6 6 6 0 0 0-6 6"></path>
    <path v-if="name === 'bell'" d="M15 21a3 3 0 0 1-6 0"></path>

    <!-- Search -->
    <circle v-if="name === 'search'" cx="11" cy="11" r="8"></circle>
    <line v-if="name === 'search'" x1="21" y1="21" x2="16.65" y2="16.65"></line>

    <!-- Chevron Up Down -->
    <polyline v-if="name === 'chevron-up-down'" points="18 16 12 10 6 16"></polyline>
    <polyline v-if="name === 'chevron-up-down'" points="6 8 12 14 18 8"></polyline>

    <!-- Chevron Left Right -->
    <polyline v-if="name === 'chevron-left-right'" points="8 18 14 12 8 6"></polyline>
    <polyline v-if="name === 'chevron-left-right'" points="16 6 10 12 16 18"></polyline>

    <!-- Plus -->
    <line v-if="name === 'plus'" x1="12" y1="5" x2="12" y2="19"></line>
    <line v-if="name === 'plus'" x1="5" y1="12" x2="19" y2="12"></line>

    <!-- Minus -->
    <line v-if="name === 'minus'" x1="5" y1="12" x2="19" y2="12"></line>

    <!-- X Circle -->
    <circle v-if="name === 'x-circle'" cx="12" cy="12" r="10"></circle>
    <line v-if="name === 'x-circle'" x1="15" y1="9" x2="9" y2="15"></line>
    <line v-if="name === 'x-circle'" x1="9" y1="9" x2="15" y2="15"></line>

    <!-- Visibility -->
    <path v-if="name === 'visibility'" d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
    <circle v-if="name === 'visibility'" cx="12" cy="12" r="3"></circle>
    <path v-if="name === 'visibility'" d="M15 12a3 3 0 0 1-6 0"></path>

    <!-- Lock -->
    <rect v-if="name === 'lock'" x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
    <path v-if="name === 'lock'" d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    <line v-if="name === 'lock'" x1="12" y1="16" x2="12" y2="16"></line>

    <!-- Globe -->
    <circle v-if="name === 'globe'" cx="12" cy="12" r="10"></circle>
    <line v-if="name === 'globe'" x1="2" y1="12" x2="22" y2="12"></line>
    <path v-if="name === 'globe'" d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
    
    <!-- Unlock -->
    <rect v-if="name === 'unlock'" x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
    <path v-if="name === 'unlock'" d="M7 11V7a5 5 0 0 1 9.9-1"></path>
    
    <!-- Users -->
    <path v-if="name === 'users'" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
    <circle v-if="name === 'users'" cx="9" cy="7" r="4"></circle>
    <path v-if="name === 'users'" d="M22 21v-2a4 4 0 0 0-3-3.87"></path>
    <path v-if="name === 'users'" d="M16 3.13a4 4 0 0 1 0 7.75"></path>

    <!-- User Plus -->
    <path v-if="name === 'user-plus'" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
    <circle v-if="name === 'user-plus'" cx="9" cy="7" r="4"></circle>
    <line v-if="name === 'user-plus'" x1="16" y1="11" x2="22" y2="11"></line>
    <line v-if="name === 'user-plus'" x1="19" y1="8" x2="19" y2="14"></line>
    
    <!-- Mail -->
    <path v-if="name === 'mail'" d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
    <polyline v-if="name === 'mail'" points="22 6 12 13 2 6"></polyline>
    
    <!-- Check -->
    <polyline v-if="name === 'check'" points="20 6 9 17 4 12"></polyline>
    
    <!-- Save -->
    <path v-if="name === 'save'" d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
    <polyline v-if="name === 'save'" points="17 21 17 13 7 13 7 21"></polyline>
    <polyline v-if="name === 'save'" points="7 3 7 8 15 8"></polyline>
    
    <!-- Spinner -->
    <path v-if="name === 'spinner'" d="M21 12a9 9 0 1 1-6.219-8.56"></path>
    
    <!-- Edit -->
    <path v-if="name === 'edit'" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
    <path v-if="name === 'edit'" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
    
    <!-- Sparkles -->
    <path v-if="name === 'sparkles'" d="M9 11H7l1.5-4 4-1.5L11 7l-2 4z"></path>
    <path v-if="name === 'sparkles'" d="M19 15h-2l1-3 3-1-2 2-1 2z"></path>
    <path v-if="name === 'sparkles'" d="M5 5h2l-1 3-3 1 2-2 1-2z"></path>
    <circle v-if="name === 'sparkles'" cx="12" cy="12" r="1"></circle>
    
    <!-- Reblog (Repeat) -->
    <polyline v-if="name === 'reblog'" points="17 1 21 5 17 9"></polyline>
    <path v-if="name === 'reblog'" d="M3 11V9a4 4 0 0 1 4-4h14"></path>
    <polyline v-if="name === 'reblog'" points="7 23 3 19 7 15"></polyline>
    <path v-if="name === 'reblog'" d="M21 13v2a4 4 0 0 1-4 4H3"></path>
    
    <!-- Federation (Share) -->
    <circle v-if="name === 'federation'" cx="18" cy="5" r="3"></circle>
    <circle v-if="name === 'federation'" cx="6" cy="12" r="3"></circle>
    <circle v-if="name === 'federation'" cx="18" cy="19" r="3"></circle>
    <line v-if="name === 'federation'" x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
    <line v-if="name === 'federation'" x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
    
    <!-- Reply (Message Square) -->
    <path v-if="name === 'reply'" d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
    
    <!-- Warning (Alert Triangle) alias -->
    <path v-if="name === 'warning'" d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
    <line v-if="name === 'warning'" x1="12" y1="9" x2="12" y2="13"></line>
    <line v-if="name === 'warning'" x1="12" y1="17" x2="12.01" y2="17"></line>
    
    <!-- More Horizontal -->
    <circle v-if="name === 'more-horizontal'" cx="12" cy="12" r="1"></circle>
    <circle v-if="name === 'more-horizontal'" cx="19" cy="12" r="1"></circle>
    <circle v-if="name === 'more-horizontal'" cx="5" cy="12" r="1"></circle>
    
    <!-- Link -->
    <path v-if="name === 'link'" d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
    <path v-if="name === 'link'" d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
    
    <!-- Trash -->
    <polyline v-if="name === 'trash'" points="3 6 5 6 21 6"></polyline>
    <path v-if="name === 'trash'" d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
    
    <!-- Close (same as X) -->
    <line v-if="name === 'close'" x1="18" y1="6" x2="6" y2="18"></line>
    <line v-if="name === 'close'" x1="6" y1="6" x2="18" y2="18"></line>
    
    <!-- File -->
    <path v-if="name === 'file'" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline v-if="name === 'file'" points="14 2 14 8 20 8"></polyline>
    <line v-if="name === 'file'" x1="16" y1="13" x2="8" y2="13"></line>
    <line v-if="name === 'file'" x1="16" y1="17" x2="8" y2="17"></line>
    <polyline v-if="name === 'file'" points="10 9 9 9 8 9"></polyline>
    
    <!-- Volume X -->
    <polygon v-if="name === 'volume-x'" points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
    <line v-if="name === 'volume-x'" x1="23" y1="9" x2="17" y2="15"></line>
    <line v-if="name === 'volume-x'" x1="17" y1="9" x2="23" y2="15"></line>
    
    <!-- User X -->
    <path v-if="name === 'user-x'" d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
    <circle v-if="name === 'user-x'" cx="8.5" cy="7" r="4"></circle>
    <line v-if="name === 'user-x'" x1="18" y1="8" x2="23" y2="13"></line>
    <line v-if="name === 'user-x'" x1="23" y1="8" x2="18" y2="13"></line>
    
    <!-- Flag -->
    <path v-if="name === 'flag'" d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
    <line v-if="name === 'flag'" x1="4" y1="22" x2="4" y2="15"></line>
    
    <!-- Chevron Left -->
    <polyline v-if="name === 'chevron-left'" points="15 18 9 12 15 6"></polyline>
    
    <!-- Chevron Right -->
    <polyline v-if="name === 'chevron-right'" points="9 18 15 12 9 6"></polyline>

    <!-- Arrow-left -->
    <!-- an arrow that points to the left -->
    <line v-if="name === 'arrow-left'" x1="19" y1="12" x2="5" y2="12"></line>
    <polyline v-if="name === 'arrow-left'" points="12 5 5 12 12 19"></polyline>

    <!-- Arrow-right -->
    <line v-if="name === 'arrow-right'" x1="5" y1="12" x2="19" y2="12"></line>
    <polyline v-if="name === 'arrow-right'" points="12 19 19 12 12 5"></polyline>

    <!-- Play -->
    <polygon v-if="name === 'play'" points="6 4 20 12 6 20 6 4"></polygon>

    <!-- Share -->
    <circle v-if="name === 'share'" cx="18" cy="5" r="3"></circle>
    <circle v-if="name === 'share'" cx="6" cy="12" r="3"></circle>
    <circle v-if="name === 'share'" cx="18" cy="19" r="3"></circle>
    <line v-if="name === 'share'" x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
    <line v-if="name === 'share'" x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
    
    <!-- User Check -->
    <path v-if="name === 'user-check'" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
    <circle v-if="name === 'user-check'" cx="9" cy="7" r="4"></circle>
    <path v-if="name === 'user-check'" d="M22 21l-5-5m5 5l-5-5m5 5l-5-5"></path>

    <!-- Cute O with a four-pointed star in the middle -->
    <circle v-if="name === 'mony-mascot'" cx="12" cy="12" r="9.5" stroke="currentColor" stroke-width="2" fill="none"/>
    <g v-if="name === 'mony-mascot'">
      <!-- Elongated, empty four-pointed star (diamond shape, vertical and horizontal points) -->
      <polygon 
        points="12,6.5 18,12 12,17.5 6.5,12" 
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        opacity="0.85"
      />
    </g>
    <!-- Pencil -->
    <g v-if="name === 'pencil'">
      <path d="M14.7 3.29a1 1 0 0 1 1.41 0l.6.6a1 1 0 0 1 0 1.41l-8.48 8.48-2.12.71.71-2.12 8.48-8.48z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M13.99 4.01l2 2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <path d="M3.5 16.5h13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </g>

    <!-- Repeat (Repost/Retweet) -->
    <polyline v-if="name === 'repeat'" points="17 1 21 5 17 9"></polyline>
    <path v-if="name === 'repeat'" d="M3 11V9a4 4 0 0 1 4-4h14"></path>
    <polyline v-if="name === 'repeat'" points="7 23 3 19 7 15"></polyline>
    <path v-if="name === 'repeat'" d="M21 13v2a4 4 0 0 1-4 4H3"></path>

    <!-- Trending Up -->
    <path v-if="name === 'trending-up'" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path>

    <!-- Trending Down -->
    <path v-if="name === 'trending-down'" d="M21 17H13m8 0V9m0 8l-8-8-4 4-6-6"></path>

    <!-- Compass -->
    <path v-if="name === 'compass'" d="M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z"></path>
    <path v-if="name === 'compass'" d="M12 15l-4-4h8l-4 4z"></path>

    <!-- List -->
    <path v-if="name === 'list'" d="M3 12h18M3 6h18M3 18h18"></path>

    <!-- Grid -->
    <path v-if="name === 'grid'" d="M3 3v18h18M3 3h18M3 3l18 18"></path>

    <!-- Hash -->
    <path v-if="name === 'hash'" fill="currentColor" fill-rule="evenodd" d="M10.99 3.16A1 1 0 1 0 9 2.84L8.15 8H4a1 1 0 0 0 0 2h3.82l-.67 4H3a1 1 0 1 0 0 2h3.82l-.8 4.84a1 1 0 0 0 1.97.32L8.85 16h4.97l-.8 4.84a1 1 0 0 0 1.97.32l.86-5.16H20a1 1 0 1 0 0-2h-3.82l.67-4H21a1 1 0 1 0 0-2h-3.82l.8-4.84a1 1 0 1 0-1.97-.32L15.15 8h-4.97l.8-4.84ZM14.15 14l.67-4H9.85l-.67 4h4.97Z" clip-rule="evenodd"></path>

    <!-- Follow (Arrow with Plus) -->
    <path v-if="name === 'follow'" d="M5 12h9"></path>
    <polyline v-if="name === 'follow'" points="12 9 15 12 12 15"></polyline>
    <circle v-if="name === 'follow'" cx="19" cy="12" r="2"></circle>
    <line v-if="name === 'follow'" x1="19" y1="10.5" x2="19" y2="13.5"></line>
    <line v-if="name === 'follow'" x1="17.5" y1="12" x2="20.5" y2="12"></line>

    <!-- Followed (Arrow with Check) -->
    <path v-if="name === 'followed'" d="M5 12h9"></path>
    <polyline v-if="name === 'followed'" points="12 9 15 12 12 15"></polyline>
    <circle v-if="name === 'followed'" cx="19" cy="12" r="2"></circle>
    <polyline v-if="name === 'followed'" points="18.2 12.8 19 13.6 20.2 11.8"></polyline>

    <!-- Unfollow (Arrow with Minus) -->
    <path v-if="name === 'unfollow'" d="M19 12H10"></path>
    <polyline v-if="name === 'unfollow'" points="13 9 10 12 13 15"></polyline>
    <circle v-if="name === 'unfollow'" cx="5" cy="12" r="2"></circle>
    <line v-if="name === 'unfollow'" x1="3.5" y1="12" x2="6.5" y2="12"></line>

    <!-- Microphone -->
    <path v-if="name === 'microphone'" d="M12 1a3 3 0 0 0-3 3v10a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"></path>
    <path v-if="name === 'microphone'" d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
    <line v-if="name === 'microphone'" x1="12" y1="19" x2="12" y2="23"></line>
    <line v-if="name === 'microphone'" x1="8" y1="23" x2="16" y2="23"></line>

    <!-- Dots Vertical -->
    <path v-if="name === 'dots-vertical'" d="M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"></path>
    <path v-if="name === 'dots-vertical'" d="M12 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"></path>
    <path v-if="name === 'dots-vertical'" d="M12 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"></path>

    <!-- Dots Horizontal -->
    <path v-if="name === 'dots-horizontal'" d="M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"></path>
    <path v-if="name === 'dots-horizontal'" d="M12 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"></path>
    <path v-if="name === 'dots-horizontal'" d="M12 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"></path>

    <!-- Mention -->
    <path v-if="name === 'mention'" d="M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"></path>
    <path v-if="name === 'mention'" d="M12 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"></path>
    <path v-if="name === 'mention'" d="M12 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"></path>

    <!-- Mentioned -->
    <path v-if="name === 'mentioned'" d="M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"></path>
    <path v-if="name === 'mentioned'" d="M12 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"></path>


</svg>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';

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
          // Check if it's a valid size string
          if (['xs', 'sm', 'md', 'lg', 'xl'].includes(value)) return true;
          // Check if it's a numeric string
          const num = parseInt(value, 10);
          return !isNaN(num) && num > 0 && num <= 128;
        }
        return false;
      }
    }
  },
  setup(props) {
    const iconSize = computed(() => {
      if (typeof props.size === 'number') {
        return props.size;
      }
      
      const sizes = {
        xs: 12,
        sm: 16,
        md: 20,
        lg: 24,
        xl: 28
      };
      return sizes[props.size as keyof typeof sizes];
    });

    return {
      iconSize
    };
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