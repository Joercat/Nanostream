/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NANOSTREAM - LOW-LATENCY WEBRTC STREAMING SERVER
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * PURPOSE: Handle WebRTC signaling, room management, and chat relay for a 
 *          minimalist Twitch-style streaming service.
 * 
 * ARCHITECTURE:
 * - Express serves the single index.html file
 * - Socket.io manages real-time signaling and chat
 * - Rooms object tracks streamer and viewers per room ID
 * 
 * FLOW:
 * 1. Client connects and joins a room
 * 2. First user becomes streamer, subsequent users are viewers
 * 3. Server relays WebRTC signaling messages (offer/answer/ICE)
 * 4. Server broadcasts chat messages to all room participants
 * ═══════════════════════════════════════════════════════════════════════════
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// SERVER INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // Allow all origins for local development
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000, // Increase timeout for stability
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

// Serve static files (our single index.html)
app.use(express.static(path.join(__dirname)));

// Fallback route - serve index.html for all routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ═══════════════════════════════════════════════════════════════════════════
// ROOM MANAGEMENT DATA STRUCTURE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ROOMS OBJECT STRUCTURE:
 * {
 *   "room-id-1": {
 *     streamer: {
 *       socketId: "abc123",
 *       username: "Streamer_Name"
 *     },
 *     viewers: [
 *       { socketId: "def456", username: "Viewer_1" },
 *       { socketId: "ghi789", username: "Viewer_2" }
 *     ]
 *   }
 * }
 */
let rooms = {};

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the current viewer count for a room
 * @param {string} roomId - The room identifier
 * @returns {number} Number of active viewers
 */
const getViewerCount = (roomId) => {
  if (!rooms[roomId]) return 0;
  return rooms[roomId].viewers.length;
};

/**
 * Check if a room has an active streamer
 * @param {string} roomId - The room identifier
 * @returns {boolean} True if streamer exists
 */
const hasStreamer = (roomId) => {
  return rooms[roomId] && rooms[roomId].streamer !== null;
};

/**
 * Find which room a socket is in
 * @param {string} socketId - The socket identifier
 * @returns {string|null} Room ID or null if not found
 */
const findRoomBySocket = (socketId) => {
  for (const [roomId, room] of Object.entries(rooms)) {
    if (room.streamer?.socketId === socketId) return roomId;
    if (room.viewers.some(v => v.socketId === socketId)) return roomId;
  }
  return null;
};

/**
 * Remove a socket from its room
 * @param {string} socketId - The socket identifier
 * @returns {object|null} Removal result with room info
 */
const removeSocketFromRoom = (socketId) => {
  const roomId = findRoomBySocket(socketId);
  if (!roomId) return null;

  const room = rooms[roomId];
  let wasStreamer = false;
  let username = '';

  // Check if disconnecting user is the streamer
  if (room.streamer?.socketId === socketId) {
    username = room.streamer.username;
    room.streamer = null;
    wasStreamer = true;
  } else {
    // Remove from viewers
    const viewerIndex = room.viewers.findIndex(v => v.socketId === socketId);
    if (viewerIndex !== -1) {
      username = room.viewers[viewerIndex].username;
      room.viewers.splice(viewerIndex, 1);
    }
  }

  // Clean up empty rooms
  if (!room.streamer && room.viewers.length === 0) {
    delete rooms[roomId];
  }

  return { roomId, wasStreamer, username, viewerCount: getViewerCount(roomId) };
};

// ═══════════════════════════════════════════════════════════════════════════
// SOCKET.IO EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);

  // ─────────────────────────────────────────────────────────────────────────
  // EVENT: join-room
  // Handles initial room joining and role assignment
  // ─────────────────────────────────────────────────────────────────────────
  socket.on('join-room', ({ roomId, username }) => {
    try {
      console.log(`👤 ${username} (${socket.id}) attempting to join room: ${roomId}`);

      // Initialize room if it doesn't exist
      if (!rooms[roomId]) {
        rooms[roomId] = {
          streamer: null,
          viewers: []
        };
      }

      // Join the Socket.io room
      socket.join(roomId);

      const room = rooms[roomId];
      let role = 'viewer';

      // Assign role based on current room state
      if (!hasStreamer(roomId)) {
        // First user becomes the streamer
        room.streamer = {
          socketId: socket.id,
          username: username
        };
        role = 'streamer';
        console.log(`🎥 ${username} is now the STREAMER for room ${roomId}`);
      } else {
        // Subsequent users are viewers
        room.viewers.push({
          socketId: socket.id,
          username: username
        });
        console.log(`👁️  ${username} joined as VIEWER (${room.viewers.length} total viewers)`);
      }

      // Send role assignment to the connecting client
      socket.emit('role-assigned', {
        role: role,
        roomId: roomId,
        username: username,
        viewerCount: getViewerCount(roomId),
        streamerUsername: room.streamer?.username
      });

      // If user is a viewer and streamer exists, notify streamer of new viewer
      if (role === 'viewer' && room.streamer) {
        io.to(room.streamer.socketId).emit('new-viewer', {
          viewerId: socket.id,
          username: username,
          viewerCount: getViewerCount(roomId)
        });
      }

      // Broadcast updated viewer count to all in room
      io.to(roomId).emit('viewer-count-update', {
        count: getViewerCount(roomId)
      });

      // Send join notification to chat
      io.to(roomId).emit('chat-message', {
        username: 'System',
        message: `${username} joined the ${role === 'streamer' ? 'stream' : 'chat'}`,
        timestamp: Date.now(),
        isSystem: true
      });

    } catch (error) {
      console.error('❌ Error in join-room:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EVENT: streamer-ready
  // Notifies all viewers that the stream is starting
  // ─────────────────────────────────────────────────────────────────────────
  socket.on('streamer-ready', ({ roomId }) => {
    try {
      console.log(`🔴 STREAM STARTED in room: ${roomId}`);
      
      const room = rooms[roomId];
      if (!room || room.streamer?.socketId !== socket.id) {
        console.error('❌ Unauthorized streamer-ready event');
        return;
      }

      // Notify all viewers to initiate WebRTC connection
      room.viewers.forEach(viewer => {
        io.to(viewer.socketId).emit('streamer-live', {
          streamerId: socket.id,
          streamerUsername: room.streamer.username
        });
      });

      // Broadcast system message
      io.to(roomId).emit('chat-message', {
        username: 'System',
        message: '🔴 Stream is now LIVE!',
        timestamp: Date.now(),
        isSystem: true
      });

    } catch (error) {
      console.error('❌ Error in streamer-ready:', error);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EVENT: webrtc-offer
  // Relay WebRTC offer from streamer to specific viewer
  // ─────────────────────────────────────────────────────────────────────────
  socket.on('webrtc-offer', ({ offer, targetId, roomId }) => {
    try {
      console.log(`📤 Relaying offer from ${socket.id} to ${targetId}`);
      
      io.to(targetId).emit('webrtc-offer', {
        offer: offer,
        streamerId: socket.id
      });

    } catch (error) {
      console.error('❌ Error relaying offer:', error);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EVENT: webrtc-answer
  // Relay WebRTC answer from viewer to streamer
  // ─────────────────────────────────────────────────────────────────────────
  socket.on('webrtc-answer', ({ answer, targetId, roomId }) => {
    try {
      console.log(`📥 Relaying answer from ${socket.id} to ${targetId}`);
      
      io.to(targetId).emit('webrtc-answer', {
        answer: answer,
        viewerId: socket.id
      });

    } catch (error) {
      console.error('❌ Error relaying answer:', error);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EVENT: webrtc-ice-candidate
  // Relay ICE candidates between peers
  // ─────────────────────────────────────────────────────────────────────────
  socket.on('webrtc-ice-candidate', ({ candidate, targetId, roomId }) => {
    try {
      console.log(`🧊 Relaying ICE candidate from ${socket.id} to ${targetId}`);
      
      io.to(targetId).emit('webrtc-ice-candidate', {
        candidate: candidate,
        fromId: socket.id
      });

    } catch (error) {
      console.error('❌ Error relaying ICE candidate:', error);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EVENT: chat-message
  // Broadcast chat messages to all users in the room
  // ─────────────────────────────────────────────────────────────────────────
  socket.on('chat-message', ({ roomId, username, message }) => {
    try {
      if (!message || message.trim() === '') return;

      console.log(`💬 [${roomId}] ${username}: ${message}`);

      // Broadcast to all clients in the room
      io.to(roomId).emit('chat-message', {
        username: username,
        message: message.trim(),
        timestamp: Date.now(),
        isSystem: false
      });

    } catch (error) {
      console.error('❌ Error sending chat message:', error);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EVENT: end-stream
  // Handle streamer ending the broadcast
  // ─────────────────────────────────────────────────────────────────────────
  socket.on('end-stream', ({ roomId }) => {
    try {
      console.log(`⏹️  Stream ended in room: ${roomId}`);

      const room = rooms[roomId];
      if (!room || room.streamer?.socketId !== socket.id) return;

      // Notify all viewers that stream has ended
      io.to(roomId).emit('stream-ended', {
        message: 'The stream has ended'
      });

      // Broadcast system message
      io.to(roomId).emit('chat-message', {
        username: 'System',
        message: '⏹️  Stream has ended',
        timestamp: Date.now(),
        isSystem: true
      });

    } catch (error) {
      console.error('❌ Error ending stream:', error);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EVENT: disconnect
  // Clean up when a user disconnects
  // ─────────────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    try {
      console.log(`🔌 Disconnected: ${socket.id}`);

      const result = removeSocketFromRoom(socket.id);
      
      if (result) {
        const { roomId, wasStreamer, username, viewerCount } = result;

        if (wasStreamer) {
          // Stream ended due to disconnection
          console.log(`⚠️  Streamer disconnected from room ${roomId}`);
          
          io.to(roomId).emit('stream-ended', {
            message: 'The streamer has disconnected'
          });

          io.to(roomId).emit('chat-message', {
            username: 'System',
            message: '⚠️  Stream ended (streamer disconnected)',
            timestamp: Date.now(),
            isSystem: true
          });
        } else {
          // Viewer disconnected
          console.log(`👋 Viewer left room ${roomId} (${viewerCount} viewers remaining)`);
          
          // Update viewer count
          io.to(roomId).emit('viewer-count-update', {
            count: viewerCount
          });

          io.to(roomId).emit('chat-message', {
            username: 'System',
            message: `${username} left`,
            timestamp: Date.now(),
            isSystem: true
          });
        }

        // Log current room state
        console.log(`📊 Room ${roomId} status:`, {
          hasStreamer: hasStreamer(roomId),
          viewerCount: viewerCount
        });
      }

    } catch (error) {
      console.error('❌ Error handling disconnect:', error);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EVENT: error
  // Log socket errors
  // ─────────────────────────────────────────────────────────────────────────
  socket.on('error', (error) => {
    console.error(`❌ Socket error for ${socket.id}:`, error);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║                                                                      ║
║   🚀 NANOSTREAM SERVER RUNNING                                      ║
║                                                                      ║
║   📡 Port: ${PORT}                                                      ║
║   🌐 URL:  http://localhost:${PORT}                                    ║
║   💬 WebSocket: Active                                              ║
║   🎥 WebRTC: Ready                                                  ║
║                                                                      ║
║   Press Ctrl+C to stop                                              ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
  `);
});

// ═══════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════

process.on('SIGTERM', () => {
  console.log('⏹️  SIGTERM received, closing server gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n⏹️  SIGINT received, closing server gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
