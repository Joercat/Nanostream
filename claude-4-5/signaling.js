/**
 * NanoStream - WebRTC Signaling & Room Management Module
 * 
 * This module handles all WebRTC signaling logic and room management.
 * It tracks streamers and viewers, relays SDP offers/answers and ICE candidates,
 * manages chat messages, and handles connection lifecycle events.
 * 
 * Room Structure:
 * {
 *   roomId: {
 *     streamer: { socketId, username, connectedAt },
 *     viewers: Map<socketId, { username, connectedAt }>,
 *     messages: Array<{ username, message, timestamp }>,
 *     createdAt: timestamp
 *   }
 * }
 */

// ============================================================================
// ROOM MANAGEMENT STATE
// ============================================================================

/**
 * Central storage for all active rooms
 * Key: roomId (string)
 * Value: Room object containing streamer, viewers, and messages
 */
const rooms = new Map();

/**
 * Reverse lookup map: socketId -> roomId
 * Enables fast room lookup when a socket disconnects
 */
const socketToRoom = new Map();

// Configuration constants
const MAX_VIEWERS_PER_ROOM = 20;
const MAX_MESSAGES_PER_ROOM = 100;
const MESSAGE_RATE_LIMIT = 500; // ms between messages per user

// Rate limiting map: socketId -> last message timestamp
const messageRateLimits = new Map();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Initialize a new room with default structure
 * @param {string} roomId - Unique room identifier
 * @returns {Object} New room object
 */
function createRoom(roomId) {
  const room = {
    streamer: null,
    viewers: new Map(),
    messages: [],
    createdAt: Date.now(),
    stats: {
      totalViewers: 0,
      peakViewers: 0,
      messagesCount: 0
    }
  };
  rooms.set(roomId, room);
  console.log(`[ROOM] Created new room: ${roomId}`);
  return room;
}

/**
 * Get or create a room by ID
 * @param {string} roomId - Room identifier
 * @returns {Object} Room object
 */
function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    return createRoom(roomId);
  }
  return rooms.get(roomId);
}

/**
 * Add a streamer to a room
 * @param {string} roomId - Room identifier
 * @param {string} socketId - Socket ID of the streamer
 * @param {string} username - Streamer's username
 * @returns {Object} Result object with success status
 */
function addStreamer(roomId, socketId, username) {
  const room = getOrCreateRoom(roomId);
  
  if (room.streamer) {
    return { 
      success: false, 
      error: 'Room already has an active streamer',
      currentStreamer: room.streamer.username
    };
  }
  
  room.streamer = {
    socketId,
    username,
    connectedAt: Date.now()
  };
  
  socketToRoom.set(socketId, roomId);
  console.log(`[ROOM] Streamer "${username}" started streaming in room: ${roomId}`);
  
  return { success: true, role: 'streamer' };
}

/**
 * Add a viewer to a room
 * @param {string} roomId - Room identifier
 * @param {string} socketId - Socket ID of the viewer
 * @param {string} username - Viewer's username
 * @returns {Object} Result object with success status
 */
function addViewer(roomId, socketId, username) {
  const room = getOrCreateRoom(roomId);
  
  // Check if room has a streamer
  if (!room.streamer) {
    return { 
      success: false, 
      error: 'No active stream in this room',
      waiting: true
    };
  }
  
  // Check viewer limit
  if (room.viewers.size >= MAX_VIEWERS_PER_ROOM) {
    return { 
      success: false, 
      error: `Room is full (max ${MAX_VIEWERS_PER_ROOM} viewers)`
    };
  }
  
  room.viewers.set(socketId, {
    username,
    connectedAt: Date.now()
  });
  
  socketToRoom.set(socketId, roomId);
  
  // Update statistics
  room.stats.totalViewers++;
  room.stats.peakViewers = Math.max(room.stats.peakViewers, room.viewers.size);
  
  console.log(`[ROOM] Viewer "${username}" joined room: ${roomId} (${room.viewers.size} viewers)`);
  
  return { 
    success: true, 
    role: 'viewer',
    viewerCount: room.viewers.size
  };
}

/**
 * Remove a user from their room
 * @param {string} socketId - Socket ID of the user
 * @returns {Object} Information about the removed user and room
 */
function removeUser(socketId) {
  const roomId = socketToRoom.get(socketId);
  if (!roomId) return null;
  
  const room = rooms.get(roomId);
  if (!room) return null;
  
  let role = null;
  let username = null;
  
  // Check if user is the streamer
  if (room.streamer && room.streamer.socketId === socketId) {
    username = room.streamer.username;
    role = 'streamer';
    room.streamer = null;
    console.log(`[ROOM] Streamer "${username}" left room: ${roomId}`);
    
    // If streamer leaves, we might want to close the room or notify viewers
    // For now, we'll keep the room open for potential reconnection
  } 
  // Check if user is a viewer
  else if (room.viewers.has(socketId)) {
    const viewer = room.viewers.get(socketId);
    username = viewer.username;
    role = 'viewer';
    room.viewers.delete(socketId);
    console.log(`[ROOM] Viewer "${username}" left room: ${roomId} (${room.viewers.size} viewers)`);
  }
  
  socketToRoom.delete(socketId);
  messageRateLimits.delete(socketId);
  
  // Clean up empty rooms
  if (!room.streamer && room.viewers.size === 0) {
    rooms.delete(roomId);
    console.log(`[ROOM] Deleted empty room: ${roomId}`);
  }
  
  return { roomId, role, username, viewerCount: room.viewers.size };
}

/**
 * Add a chat message to a room
 * @param {string} roomId - Room identifier
 * @param {string} username - Username of the sender
 * @param {string} message - Message content
 * @returns {Object} Result with success status and message data
 */
function addMessage(roomId, socketId, username, message) {
  const room = rooms.get(roomId);
  if (!room) {
    return { success: false, error: 'Room not found' };
  }
  
  // Rate limiting check
  const now = Date.now();
  const lastMessageTime = messageRateLimits.get(socketId) || 0;
  if (now - lastMessageTime < MESSAGE_RATE_LIMIT) {
    return { success: false, error: 'Sending messages too quickly' };
  }
  messageRateLimits.set(socketId, now);
  
  // Sanitize message (basic XSS prevention)
  const sanitizedMessage = message
    .trim()
    .substring(0, 500) // Max 500 characters
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  if (!sanitizedMessage) {
    return { success: false, error: 'Empty message' };
  }
  
  const messageObj = {
    username,
    message: sanitizedMessage,
    timestamp: now,
    id: `${socketId}-${now}`
  };
  
  room.messages.push(messageObj);
  room.stats.messagesCount++;
  
  // Keep only last N messages to prevent memory issues
  if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
    room.messages.shift();
  }
  
  return { success: true, message: messageObj };
}

/**
 * Get current viewer count for a room
 * @param {string} roomId - Room identifier
 * @returns {number} Number of viewers
 */
function getViewerCount(roomId) {
  const room = rooms.get(roomId);
  return room ? room.viewers.size : 0;
}

/**
 * Get room information
 * @param {string} roomId - Room identifier
 * @returns {Object|null} Room info or null if not found
 */
function getRoomInfo(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  
  return {
    roomId,
    hasStreamer: !!room.streamer,
    streamerName: room.streamer ? room.streamer.username : null,
    viewerCount: room.viewers.size,
    createdAt: room.createdAt,
    stats: room.stats
  };
}

/**
 * Get server-wide statistics
 * @returns {Object} Server stats
 */
function getServerStats() {
  let totalViewers = 0;
  let totalMessages = 0;
  
  rooms.forEach(room => {
    totalViewers += room.viewers.size;
    totalMessages += room.stats.messagesCount;
  });
  
  return {
    activeRooms: rooms.size,
    totalViewers,
    totalMessages
  };
}

// ============================================================================
// SOCKET.IO EVENT HANDLERS
// ============================================================================

/**
 * Main connection handler - sets up all event listeners for a socket
 * @param {Socket} socket - Socket.io socket instance
 * @param {Server} io - Socket.io server instance
 */
function handleConnection(socket, io) {
  
  /**
   * Handle user joining a room
   * Determines if user should be streamer or viewer based on room state
   */
  socket.on('join-room', ({ roomId, username }) => {
    console.log(`[JOIN] ${username} attempting to join room: ${roomId}`);
    
    if (!roomId || !username) {
      socket.emit('error', { message: 'Room ID and username are required' });
      return;
    }
    
    const room = getOrCreateRoom(roomId);
    
    // Join the Socket.io room for easy broadcasting
    socket.join(roomId);
    
    // Determine role and send appropriate response
    if (!room.streamer) {
      // User is attempting to be the streamer
      socket.emit('role-assigned', { 
        role: 'awaiting-stream',
        roomId,
        message: 'You can start streaming by clicking "Go Live"'
      });
    } else {
      // User will be a viewer
      const result = addViewer(roomId, socket.id, username);
      
      if (result.success) {
        // Notify the viewer
        socket.emit('role-assigned', { 
          role: 'viewer',
          roomId,
          streamerName: room.streamer.username,
          viewerCount: result.viewerCount
        });
        
        // Send chat history to the new viewer
        socket.emit('chat-history', room.messages);
        
        // Notify streamer of new viewer
        io.to(room.streamer.socketId).emit('viewer-joined', {
          username,
          viewerCount: result.viewerCount
        });
        
        // Notify all viewers about viewer count update
        io.to(roomId).emit('viewer-count-update', {
          count: result.viewerCount
        });
        
        // Broadcast join message to chat
        const joinMessage = {
          username: 'System',
          message: `${username} joined the stream`,
          timestamp: Date.now(),
          system: true
        };
        io.to(roomId).emit('chat-message', joinMessage);
      } else {
        socket.emit('error', { message: result.error });
      }
    }
  });
  
  /**
   * Handle streamer going live
   * Initiates the streaming session and notifies waiting viewers
   */
  socket.on('start-stream', ({ roomId, username }) => {
    console.log(`[STREAM] ${username} starting stream in room: ${roomId}`);
    
    const result = addStreamer(roomId, socket.id, username);
    
    if (result.success) {
      socket.emit('stream-started', { 
        role: 'streamer',
        roomId
      });
      
      // Notify all users in the room that stream has started
      socket.to(roomId).emit('streamer-ready', {
        streamerName: username,
        streamerId: socket.id
      });
      
      // Send chat history to streamer
      const room = rooms.get(roomId);
      socket.emit('chat-history', room.messages);
      
    } else {
      socket.emit('error', { message: result.error });
    }
  });
  
  /**
   * Handle WebRTC offer from streamer to viewer
   * Relays the SDP offer to the specific viewer
   */
  socket.on('offer', ({ offer, targetSocketId }) => {
    console.log(`[WEBRTC] Relaying offer from ${socket.id} to ${targetSocketId}`);
    io.to(targetSocketId).emit('offer', {
      offer,
      streamerSocketId: socket.id
    });
  });
  
  /**
   * Handle WebRTC answer from viewer to streamer
   * Relays the SDP answer back to the streamer
   */
  socket.on('answer', ({ answer, targetSocketId }) => {
    console.log(`[WEBRTC] Relaying answer from ${socket.id} to ${targetSocketId}`);
    io.to(targetSocketId).emit('answer', {
      answer,
      viewerSocketId: socket.id
    });
  });
  
  /**
   * Handle ICE candidates
   * Relays ICE candidates between peers for NAT traversal
   */
  socket.on('ice-candidate', ({ candidate, targetSocketId }) => {
    console.log(`[WEBRTC] Relaying ICE candidate from ${socket.id} to ${targetSocketId}`);
    io.to(targetSocketId).emit('ice-candidate', {
      candidate,
      fromSocketId: socket.id
    });
  });
  
  /**
   * Handle viewer requesting stream
   * Notifies streamer that a viewer is ready to receive stream
   */
  socket.on('request-stream', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.streamer) {
      console.log(`[WEBRTC] Viewer ${socket.id} requesting stream from ${room.streamer.socketId}`);
      io.to(room.streamer.socketId).emit('viewer-ready', {
        viewerSocketId: socket.id
      });
    }
  });
  
  /**
   * Handle chat messages
   * Validates, sanitizes, and broadcasts messages to all room members
   */
  socket.on('chat-message', ({ roomId, username, message }) => {
    const result = addMessage(roomId, socket.id, username, message);
    
    if (result.success) {
      // Broadcast to all users in the room
      io.to(roomId).emit('chat-message', result.message);
    } else {
      socket.emit('error', { message: result.error });
    }
  });
  
  /**
   * Handle streamer stopping stream
   * Notifies all viewers and cleans up the room
   */
  socket.on('stop-stream', ({ roomId }) => {
    console.log(`[STREAM] Stream stopped in room: ${roomId}`);
    const room = rooms.get(roomId);
    
    if (room && room.streamer && room.streamer.socketId === socket.id) {
      // Notify all viewers
      io.to(roomId).emit('stream-ended', {
        message: 'The stream has ended'
      });
      
      // Remove streamer but keep room for viewers
      room.streamer = null;
    }
  });
  
  /**
   * Handle socket disconnection
   * Cleans up user data and notifies other room members
   */
  socket.on('disconnect', () => {
    const userData = removeUser(socket.id);
    
    if (userData) {
      const { roomId, role, username, viewerCount } = userData;
      
      if (role === 'streamer') {
        // Notify all viewers that stream has ended
        io.to(roomId).emit('stream-ended', {
          message: 'The streamer has disconnected'
        });
        
        // Broadcast to chat
        const leaveMessage = {
          username: 'System',
          message: `${username} (streamer) has left`,
          timestamp: Date.now(),
          system: true
        };
        io.to(roomId).emit('chat-message', leaveMessage);
        
      } else if (role === 'viewer') {
        // Notify streamer
        const room = rooms.get(roomId);
        if (room && room.streamer) {
          io.to(room.streamer.socketId).emit('viewer-left', {
            username,
            viewerCount
          });
        }
        
        // Update viewer count for everyone
        io.to(roomId).emit('viewer-count-update', {
          count: viewerCount
        });
        
        // Broadcast to chat
        const leaveMessage = {
          username: 'System',
          message: `${username} left the stream`,
          timestamp: Date.now(),
          system: true
        };
        io.to(roomId).emit('chat-message', leaveMessage);
      }
    }
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  handleConnection,
  getServerStats,
  getRoomInfo,
  getViewerCount
};
