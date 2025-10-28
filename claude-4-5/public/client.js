/**
 * NanoStream - Client-Side Application Logic
 * 
 * This file contains all client-side JavaScript for the NanoStream application.
 * It handles WebRTC connections, Socket.io communication, UI state management,
 * and real-time chat functionality.
 * 
 * Architecture:
 * - Socket.io for signaling (offer/answer/ICE candidates)
 * - WebRTC for peer-to-peer media streaming
 * - Event-driven UI updates
 * - Separation of streamer and viewer logic
 */

// ============================================================================
// GLOBAL STATE & CONFIGURATION
// ============================================================================

/**
 * Application state object
 * Tracks the current user's session and connection details
 */
const appState = {
  socket: null,
  roomId: null,
  username: null,
  role: null, // 'streamer' or 'viewer'
  localStream: null,
  peerConnections: new Map(), // Map<viewerSocketId, RTCPeerConnection>
  isStreaming: false
};

/**
 * WebRTC configuration
 * Uses Google's public STUN server for NAT traversal
 */
const rtcConfig = {
  iceServers: [
    {
      urls: 'stun:stun.l.google.com:19302'
    },
    {
      urls: 'stun:stun1.l.google.com:19302'
    }
  ],
  iceCandidatePoolSize: 10
};

/**
 * Media constraints for getUserMedia
 * Optimized for low-latency streaming
 */
const mediaConstraints = {
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 60 },
    facingMode: 'user'
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
};

// ============================================================================
// DOM ELEMENT REFERENCES
// ============================================================================

// Screens
const splashScreen = document.getElementById('splash-screen');
const streamerScreen = document.getElementById('streamer-screen');
const viewerScreen = document.getElementById('viewer-screen');

// Splash screen elements
const roomIdInput = document.getElementById('room-id-input');
const usernameInput = document.getElementById('username-input');
const joinBtn = document.getElementById('join-btn');
const splashError = document.getElementById('splash-error');
const splashErrorText = document.getElementById('splash-error-text');

// Streamer elements
const localVideo = document.getElementById('local-video');
const goLiveBtn = document.getElementById('go-live-btn');
const goLiveOverlay = document.getElementById('go-live-overlay');
const stopStreamBtn = document.getElementById('stop-stream-btn');
const viewerCount = document.getElementById('viewer-count');
const streamerRoomName = document.getElementById('streamer-room-name');
const streamerChatMessages = document.getElementById('streamer-chat-messages');
const streamerChatInput = document.getElementById('streamer-chat-input');
const streamerChatSend = document.getElementById('streamer-chat-send');

// Viewer elements
const remoteVideo = document.getElementById('remote-video');
const viewerStreamerName = document.getElementById('viewer-streamer-name');
const viewerCountDisplay = document.getElementById('viewer-count-display');
const streamLoading = document.getElementById('stream-loading');
const streamOffline = document.getElementById('stream-offline');
const viewerChatMessages = document.getElementById('viewer-chat-messages');
const viewerChatInput = document.getElementById('viewer-chat-input');
const viewerChatSend = document.getElementById('viewer-chat-send');

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize Socket.io connection when page loads
 */
document.addEventListener('DOMContentLoaded', () => {
  console.log('[NanoStream] Initializing application...');
  
  // Connect to Socket.io server
  appState.socket = io({
    transports: ['websocket', 'polling'],
    upgrade: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 5
  });
  
  // Set up Socket.io event handlers
  setupSocketHandlers();
  
  // Set up UI event handlers
  setupUIHandlers();
  
  console.log('[NanoStream] Application initialized');
});

// ============================================================================
// SOCKET.IO EVENT HANDLERS
// ============================================================================

/**
 * Set up all Socket.io event listeners
 */
function setupSocketHandlers() {
  const { socket } = appState;
  
  // Connection established
  socket.on('connect', () => {
    console.log('[Socket] Connected to server:', socket.id);
  });
  
  // Connection error
  socket.on('connect_error', (error) => {
    console.error('[Socket] Connection error:', error);
    showError('Failed to connect to server. Please refresh the page.');
  });
  
  // Disconnection
  socket.on('disconnect', (reason) => {
    console.log('[Socket] Disconnected:', reason);
    if (reason === 'io server disconnect') {
      // Server disconnected us, try to reconnect
      socket.connect();
    }
  });
  
  // Role assignment after joining room
  socket.on('role-assigned', (data) => {
    console.log('[Socket] Role assigned:', data);
    appState.role = data.role;
    
    if (data.role === 'awaiting-stream') {
      // User can become the streamer
      showStreamerUI();
    } else if (data.role === 'viewer') {
      // User is a viewer
      showViewerUI(data.streamerName);
    }
  });
  
  // Stream started notification (for viewers waiting)
  socket.on('streamer-ready', (data) => {
    console.log('[Socket] Streamer is ready:', data);
    if (appState.role === 'viewer') {
      viewerStreamerName.textContent = `Streamer: ${data.streamerName}`;
      // Request the stream
      requestStream();
    }
  });
  
  // Streamer successfully started stream
  socket.on('stream-started', (data) => {
    console.log('[Socket] Stream started successfully');
    appState.isStreaming = true;
    goLiveOverlay.classList.add('hidden');
  });
  
  // New viewer wants to watch (streamer receives this)
  socket.on('viewer-ready', async (data) => {
    console.log('[Socket] New viewer ready:', data.viewerSocketId);
    await createPeerConnection(data.viewerSocketId);
  });
  
  // Viewer joined notification (streamer receives this)
  socket.on('viewer-joined', (data) => {
    console.log('[Socket] Viewer joined:', data.username);
    viewerCount.textContent = data.viewerCount;
  });
  
  // Viewer left notification (streamer receives this)
  socket.on('viewer-left', (data) => {
    console.log('[Socket] Viewer left:', data.username);
    viewerCount.textContent = data.viewerCount;
    
    // Clean up peer connection
    const peerConnection = appState.peerConnections.get(data.viewerSocketId);
    if (peerConnection) {
      peerConnection.close();
      appState.peerConnections.delete(data.viewerSocketId);
    }
  });
  
  // Viewer count update
  socket.on('viewer-count-update', (data) => {
    if (appState.role === 'streamer') {
      viewerCount.textContent = data.count;
    } else if (appState.role === 'viewer') {
      viewerCountDisplay.textContent = data.count;
    }
  });
  
  // WebRTC offer received (viewer receives this)
  socket.on('offer', async (data) => {
    console.log('[WebRTC] Received offer from streamer');
    await handleOffer(data.offer, data.streamerSocketId);
  });
  
  // WebRTC answer received (streamer receives this)
  socket.on('answer', async (data) => {
    console.log('[WebRTC] Received answer from viewer:', data.viewerSocketId);
    await handleAnswer(data.answer, data.viewerSocketId);
  });
  
  // ICE candidate received
  socket.on('ice-candidate', async (data) => {
    console.log('[WebRTC] Received ICE candidate from:', data.fromSocketId);
    await handleIceCandidate(data.candidate, data.fromSocketId);
  });
  
  // Chat message received
  socket.on('chat-message', (data) => {
    displayChatMessage(data);
  });
  
  // Chat history received (when joining)
  socket.on('chat-history', (messages) => {
    console.log('[Chat] Received chat history:', messages.length, 'messages');
    messages.forEach(msg => displayChatMessage(msg));
  });
  
  // Stream ended notification
  socket.on('stream-ended', (data) => {
    console.log('[Socket] Stream ended:', data.message);
    handleStreamEnded(data.message);
  });
  
  // Error from server
  socket.on('error', (data) => {
    console.error('[Socket] Server error:', data.message);
    showError(data.message);
  });
}

// ============================================================================
// UI EVENT HANDLERS
// ============================================================================

/**
 * Set up all UI event listeners
 */
function setupUIHandlers() {
  // Join button click
  joinBtn.addEventListener('click', handleJoinRoom);
  
  // Enter key in inputs
  roomIdInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleJoinRoom();
  });
  
  usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleJoinRoom();
  });
  
  // Go Live button
  goLiveBtn.addEventListener('click', handleGoLive);
  
  // Stop stream button
  stopStreamBtn.addEventListener('click', handleStopStream);
  
  // Streamer chat
  streamerChatSend.addEventListener('click', () => sendChatMessage('streamer'));
  streamerChatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage('streamer');
  });
  
  // Viewer chat
  viewerChatSend.addEventListener('click', () => sendChatMessage('viewer'));
  viewerChatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage('viewer');
  });
}

// ============================================================================
// ROOM MANAGEMENT
// ============================================================================

/**
 * Handle joining a room
 */
function handleJoinRoom() {
  const roomId = roomIdInput.value.trim();
  const username = usernameInput.value.trim();
  
  // Validation
  if (!roomId) {
    showSplashError('Please enter a Room ID');
    roomIdInput.classList.add('shake');
    setTimeout(() => roomIdInput.classList.remove('shake'), 500);
    return;
  }
  
  if (!username) {
    showSplashError('Please enter a Username');
    usernameInput.classList.add('shake');
    setTimeout(() => usernameInput.classList.remove('shake'), 500);
    return;
  }
  
  // Sanitize inputs
  appState.roomId = roomId.replace(/[^a-zA-Z0-9-_]/g, '');
  appState.username = username.substring(0, 20);
  
  console.log(`[App] Joining room: ${appState.roomId} as ${appState.username}`);
  
  // Emit join-room event
  appState.socket.emit('join-room', {
    roomId: appState.roomId,
    username: appState.username
  });
  
  // Hide splash error if visible
  splashError.classList.add('hidden');
}

// ============================================================================
// UI STATE MANAGEMENT
// ============================================================================

/**
 * Show streamer UI
 */
function showStreamerUI() {
  console.log('[UI] Showing streamer interface');
  splashScreen.classList.add('hidden');
  streamerScreen.classList.remove('hidden');
  streamerScreen.classList.add('fade-in');
  
  streamerRoomName.textContent = `Room: ${appState.roomId}`;
  appState.role = 'streamer';
}

/**
 * Show viewer UI
 */
function showViewerUI(streamerName) {
  console.log('[UI] Showing viewer interface');
  splashScreen.classList.add('hidden');
  viewerScreen.classList.remove('hidden');
  viewerScreen.classList.add('fade-in');
  
  viewerStreamerName.textContent = `Streamer: ${streamerName}`;
  appState.role = 'viewer';
}

/**
 * Show error on splash screen
 */
function showSplashError(message) {
  splashErrorText.textContent = message;
  splashError.classList.remove('hidden');
}

/**
 * Show generic error (could be toast notification)
 */
function showError(message) {
  console.error('[Error]', message);
  alert(message); // Simple alert for now, could be improved with toast
}

// ============================================================================
// STREAMER LOGIC
// ============================================================================

/**
 * Handle "Go Live" button click
 * Requests media permissions and starts streaming
 */
async function handleGoLive() {
  console.log('[Streamer] Going live...');
  goLiveBtn.disabled = true;
  goLiveBtn.innerHTML = '<div class="spinner mx-auto"></div>';
  
  try {
    // Request media access
    appState.localStream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
    
    console.log('[Streamer] Media access granted');
    
    // Display local video
    localVideo.srcObject = appState.localStream;
    
    // Notify server that stream is starting
    appState.socket.emit('start-stream', {
      roomId: appState.roomId,
      username: appState.username
    });
    
    console.log('[Streamer] Stream started');
    
  } catch (error) {
    console.error('[Streamer] Failed to access media:', error);
    
    let errorMessage = 'Failed to access camera/microphone. ';
    if (error.name === 'NotAllowedError') {
      errorMessage += 'Please grant camera and microphone permissions.';
    } else if (error.name === 'NotFoundError') {
      errorMessage += 'No camera or microphone found.';
    } else {
      errorMessage += error.message;
    }
    
    showError(errorMessage);
    goLiveBtn.disabled = false;
    goLiveBtn.textContent = '🔴 Go Live';
  }
}

/**
 * Handle "Stop Stream" button click
 */
function handleStopStream() {
  console.log('[Streamer] Stopping stream...');
  
  // Stop all tracks
  if (appState.localStream) {
    appState.localStream.getTracks().forEach(track => track.stop());
    appState.localStream = null;
  }
  
  // Close all peer connections
  appState.peerConnections.forEach(pc => pc.close());
  appState.peerConnections.clear();
  
  // Notify server
  appState.socket.emit('stop-stream', {
    roomId: appState.roomId
  });
  
  // Reset UI
  localVideo.srcObject = null;
  goLiveOverlay.classList.remove('hidden');
  goLiveBtn.disabled = false;
  goLiveBtn.textContent = '🔴 Go Live';
  appState.isStreaming = false;
}

/**
 * Create a peer connection for a viewer
 * @param {string} viewerSocketId - Socket ID of the viewer
 */
async function createPeerConnection(viewerSocketId) {
  console.log('[WebRTC] Creating peer connection for viewer:', viewerSocketId);
  
  // Create new RTCPeerConnection
  const peerConnection = new RTCPeerConnection(rtcConfig);
  appState.peerConnections.set(viewerSocketId, peerConnection);
  
  // Add local stream tracks to peer connection
  appState.localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, appState.localStream);
  });
  
  // Handle ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('[WebRTC] Sending ICE candidate to viewer:', viewerSocketId);
      appState.socket.emit('ice-candidate', {
        candidate: event.candidate,
        targetSocketId: viewerSocketId
      });
    }
  };
  
  // Handle connection state changes
  peerConnection.onconnectionstatechange = () => {
    console.log('[WebRTC] Connection state:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'disconnected' || 
        peerConnection.connectionState === 'failed') {
      appState.peerConnections.delete(viewerSocketId);
    }
  };
  
  // Create and send offer
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    console.log('[WebRTC] Sending offer to viewer:', viewerSocketId);
    appState.socket.emit('offer', {
      offer: offer,
      targetSocketId: viewerSocketId
    });
  } catch (error) {
    console.error('[WebRTC] Error creating offer:', error);
  }
}

/**
 * Handle answer from viewer
 * @param {RTCSessionDescription} answer - SDP answer
 * @param {string} viewerSocketId - Socket ID of the viewer
 */
async function handleAnswer(answer, viewerSocketId) {
  const peerConnection = appState.peerConnections.get(viewerSocketId);
  
  if (peerConnection) {
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      console.log('[WebRTC] Remote description set for viewer:', viewerSocketId);
    } catch (error) {
      console.error('[WebRTC] Error setting remote description:', error);
    }
  }
}

// ============================================================================
// VIEWER LOGIC
// ============================================================================

/**
 * Request stream from streamer
 */
function requestStream() {
  console.log('[Viewer] Requesting stream...');
  appState.socket.emit('request-stream', {
    roomId: appState.roomId
  });
}

/**
 * Handle offer from streamer
 * @param {RTCSessionDescription} offer - SDP offer
 * @param {string} streamerSocketId - Socket ID of the streamer
 */
async function handleOffer(offer, streamerSocketId) {
  console.log('[WebRTC] Handling offer from streamer');
  
  // Create peer connection if it doesn't exist
  let peerConnection = appState.peerConnections.get(streamerSocketId);
  
  if (!peerConnection) {
    peerConnection = new RTCPeerConnection(rtcConfig);
    appState.peerConnections.set(streamerSocketId, peerConnection);
    
    // Handle incoming tracks
    peerConnection.ontrack = (event) => {
      console.log('[WebRTC] Received track:', event.track.kind);
      
      if (remoteVideo.srcObject !== event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
        console.log('[WebRTC] Remote stream attached to video element');
        
        // Hide loading, show video
        streamLoading.classList.add('hidden');
      }
    };
    
    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[WebRTC] Sending ICE candidate to streamer');
        appState.socket.emit('ice-candidate', {
          candidate: event.candidate,
          targetSocketId: streamerSocketId
        });
      }
    };
    
    // Handle connection state
    peerConnection.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', peerConnection.connectionState);
      
      if (peerConnection.connectionState === 'connected') {
        streamLoading.classList.add('hidden');
        streamOffline.classList.add('hidden');
      } else if (peerConnection.connectionState === 'disconnected' || 
                 peerConnection.connectionState === 'failed') {
        streamLoading.classList.add('hidden');
        streamOffline.classList.remove('hidden');
      }
    };
  }
  
  try {
    // Set remote description and create answer
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    console.log('[WebRTC] Sending answer to streamer');
    appState.socket.emit('answer', {
      answer: answer,
      targetSocketId: streamerSocketId
    });
  } catch (error) {
    console.error('[WebRTC] Error handling offer:', error);
  }
}

/**
 * Handle stream ended event
 */
function handleStreamEnded(message) {
  console.log('[Viewer] Stream ended:', message);
  
  // Close peer connections
  appState.peerConnections.forEach(pc => pc.close());
  appState.peerConnections.clear();
  
  // Update UI
  remoteVideo.srcObject = null;
  streamLoading.classList.add('hidden');
  streamOffline.classList.remove('hidden');
  
  // Could show a reconnect button or auto-redirect
}

// ============================================================================
// WEBRTC COMMON HANDLERS
// ============================================================================

/**
 * Handle ICE candidate from peer
 * @param {RTCIceCandidate} candidate - ICE candidate
 * @param {string} fromSocketId - Socket ID of the sender
 */
async function handleIceCandidate(candidate, fromSocketId) {
  const peerConnection = appState.peerConnections.get(fromSocketId);
  
  if (peerConnection) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('[WebRTC] ICE candidate added');
    } catch (error) {
      console.error('[WebRTC] Error adding ICE candidate:', error);
    }
  }
}

// ============================================================================
// CHAT FUNCTIONALITY
// ============================================================================

/**
 * Send a chat message
 * @param {string} role - 'streamer' or 'viewer'
 */
function sendChatMessage(role) {
  const input = role === 'streamer' ? streamerChatInput : viewerChatInput;
  const message = input.value.trim();
  
  if (!message) return;
  
  // Send to server
  appState.socket.emit('chat-message', {
    roomId: appState.roomId,
    username: appState.username,
    message: message
  });
  
  // Clear input
  input.value = '';
}

/**
 * Display a chat message
 * @param {Object} data - Message data
 */
function displayChatMessage(data) {
  const container = appState.role === 'streamer' 
    ? streamerChatMessages 
    : viewerChatMessages;
  
  // Create message element
  const messageDiv = document.createElement('div');
  messageDiv.className = data.system ? 'chat-message system' : 'chat-message';
  
  const timestamp = new Date(data.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit'
  });
  
  messageDiv.innerHTML = `
    <span class="chat-username">${escapeHtml(data.username)}:</span>
    <span class="chat-text">${data.message}</span>
    <span class="chat-timestamp">${timestamp}</span>
  `;
  
  container.appendChild(messageDiv);
  
  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;
  
  // Limit messages in DOM (keep last 50)
  while (container.children.length > 50) {
    container.removeChild(container.firstChild);
  }
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Format bytes to human-readable size
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Log connection statistics (for debugging)
 */
async function logConnectionStats() {
  for (const [id, pc] of appState.peerConnections) {
    const stats = await pc.getStats();
    stats.forEach(report => {
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        console.log(`[Stats] ${id}:`, {
          bytesReceived: formatBytes(report.bytesReceived),
          packetsLost: report.packetsLost,
          jitter: report.jitter
        });
      }
    });
  }
}

// Optional: Log stats every 5 seconds in development
if (window.location.hostname === 'localhost') {
  setInterval(() => {
    if (appState.peerConnections.size > 0) {
      logConnectionStats();
    }
  }, 5000);
}

console.log('[NanoStream] Client script loaded');
