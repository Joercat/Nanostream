const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;
const PHP_DB_ENDPOINT = process.env.PHP_DB_ENDPOINT || 'http://your-infinityfree-site.com/db_connector.php';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = {};
const userSockets = {};
const socketToUser = {};
const socketToRoom = {};

async function dbQuery(action, params) {
  try {
    const response = await fetch(PHP_DB_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, params })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Database query error:', error);
    return { success: false, error: error.message };
  }
}

io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on('register', async (data) => {
    const { username, password } = data;
    
    if (!username || !password) {
      socket.emit('register-response', { 
        success: false, 
        error: 'Username and password are required' 
      });
      return;
    }

    if (username.length < 3 || username.length > 20) {
      socket.emit('register-response', { 
        success: false, 
        error: 'Username must be between 3 and 20 characters' 
      });
      return;
    }

    if (password.length < 6) {
      socket.emit('register-response', { 
        success: false, 
        error: 'Password must be at least 6 characters' 
      });
      return;
    }

    const result = await dbQuery('register', { username, password });
    
    if (result.success) {
      socket.emit('register-response', { 
        success: true, 
        userId: result.userId,
        username: username
      });
    } else {
      socket.emit('register-response', { 
        success: false, 
        error: result.error || 'Registration failed' 
      });
    }
  });

  socket.on('login', async (data) => {
    const { username, password } = data;
    
    if (!username || !password) {
      socket.emit('login-response', { 
        success: false, 
        error: 'Username and password are required' 
      });
      return;
    }

    const result = await dbQuery('login', { username, password });
    
    if (result.success) {
      userSockets[result.userId] = socket.id;
      socketToUser[socket.id] = {
        userId: result.userId,
        username: username
      };

      socket.emit('login-response', { 
        success: true, 
        userId: result.userId,
        username: username
      });
    } else {
      socket.emit('login-response', { 
        success: false, 
        error: result.error || 'Invalid credentials' 
      });
    }
  });

  socket.on('get-active-streams', async () => {
    const result = await dbQuery('getActiveStreams', {});
    
    if (result.success) {
      socket.emit('active-streams-list', { 
        success: true, 
        streams: result.streams 
      });
    } else {
      socket.emit('active-streams-list', { 
        success: true, 
        streams: [] 
      });
    }
  });

  socket.on('join-room', async (data) => {
    const { roomId, userId } = data;
    
    if (!roomId || !userId) {
      socket.emit('join-error', { error: 'Room ID and User ID required' });
      return;
    }

    const user = socketToUser[socket.id];
    if (!user || user.userId !== userId) {
      socket.emit('join-error', { error: 'User not authenticated' });
      return;
    }

    socket.join(roomId);
    socketToRoom[socket.id] = roomId;

    if (!rooms[roomId]) {
      rooms[roomId] = {
        streamer: null,
        viewers: [],
        streamActive: false
      };
    }

    const streamCheck = await dbQuery('checkStreamActive', { roomId });
    
    if (streamCheck.success && streamCheck.active) {
      rooms[roomId].streamActive = true;
      
      if (!rooms[roomId].streamer) {
        const streamerSocketId = userSockets[streamCheck.userId];
        if (streamerSocketId) {
          rooms[roomId].streamer = streamerSocketId;
        }
      }
    }

    const isStreamer = rooms[roomId].streamer === socket.id;

    if (!isStreamer && !rooms[roomId].viewers.includes(socket.id)) {
      rooms[roomId].viewers.push(socket.id);
    }

    socket.emit('room-joined', {
      roomId,
      role: isStreamer ? 'streamer' : 'viewer',
      streamActive: rooms[roomId].streamActive
    });

    const chatHistory = await dbQuery('getChatHistory', { roomId, limit: 100 });
    if (chatHistory.success && chatHistory.messages) {
      socket.emit('chat-history', { messages: chatHistory.messages });
    }

    if (rooms[roomId].streamer && !isStreamer && rooms[roomId].streamActive) {
      const streamerSocket = io.sockets.sockets.get(rooms[roomId].streamer);
      if (streamerSocket) {
        streamerSocket.emit('new-viewer', { viewerId: socket.id });
      }
    }

    updateViewerCount(roomId);
  });

  socket.on('start-stream', async (data) => {
    const { roomId, userId } = data;
    
    if (!roomId || !userId) {
      socket.emit('stream-error', { error: 'Room ID and User ID required' });
      return;
    }

    const user = socketToUser[socket.id];
    if (!user || user.userId !== userId) {
      socket.emit('stream-error', { error: 'User not authenticated' });
      return;
    }

    if (!rooms[roomId]) {
      rooms[roomId] = {
        streamer: null,
        viewers: [],
        streamActive: false
      };
    }

    const streamCheck = await dbQuery('checkStreamActive', { roomId });
    
    if (streamCheck.success && streamCheck.active && streamCheck.userId !== userId) {
      socket.emit('stream-error', { error: 'Stream already active in this room' });
      return;
    }

    rooms[roomId].streamer = socket.id;
    rooms[roomId].streamActive = true;
    
    const viewers = rooms[roomId].viewers.filter(v => v !== socket.id);
    rooms[roomId].viewers = viewers;

    const result = await dbQuery('startStream', { roomId, userId });
    
    if (result.success) {
      socket.emit('stream-started', { roomId });
      
      io.to(roomId).emit('stream-status-changed', { 
        active: true,
        roomId 
      });

      updateViewerCount(roomId);
    } else {
      socket.emit('stream-error', { error: 'Failed to start stream' });
    }
  });

  socket.on('stop-stream', async (data) => {
    const { roomId, userId } = data;
    
    if (!roomId) return;

    if (rooms[roomId] && rooms[roomId].streamer === socket.id) {
      rooms[roomId].streamActive = false;
      
      await dbQuery('stopStream', { roomId, userId });

      io.to(roomId).emit('stream-status-changed', { 
        active: false,
        roomId 
      });

      rooms[roomId].viewers.forEach(viewerId => {
        const viewerSocket = io.sockets.sockets.get(viewerId);
        if (viewerSocket) {
          viewerSocket.emit('stream-ended');
        }
      });

      updateViewerCount(roomId);
    }
  });

  socket.on('offer', (data) => {
    const { offer, viewerId, roomId } = data;
    
    if (!viewerId || !offer) return;

    const viewerSocket = io.sockets.sockets.get(viewerId);
    if (viewerSocket) {
      viewerSocket.emit('offer', {
        offer,
        streamerId: socket.id
      });
    }
  });

  socket.on('answer', (data) => {
    const { answer, streamerId } = data;
    
    if (!streamerId || !answer) return;

    const streamerSocket = io.sockets.sockets.get(streamerId);
    if (streamerSocket) {
      streamerSocket.emit('answer', {
        answer,
        viewerId: socket.id
      });
    }
  });

  socket.on('ice-candidate', (data) => {
    const { candidate, targetId } = data;
    
    if (!targetId || !candidate) return;

    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit('ice-candidate', {
        candidate,
        senderId: socket.id
      });
    }
  });

  socket.on('send-message', async (data) => {
    const { roomId, userId, message } = data;
    
    if (!roomId || !userId || !message) return;

    const user = socketToUser[socket.id];
    if (!user || user.userId !== userId) {
      socket.emit('message-error', { error: 'Not authenticated' });
      return;
    }

    const trimmedMessage = message.trim();
    if (trimmedMessage.length === 0 || trimmedMessage.length > 500) {
      socket.emit('message-error', { error: 'Invalid message length' });
      return;
    }

    const result = await dbQuery('saveMessage', {
      roomId,
      userId,
      username: user.username,
      message: trimmedMessage
    });

    if (result.success) {
      const messageData = {
        username: user.username,
        message: trimmedMessage,
        timestamp: new Date().toISOString()
      };

      io.to(roomId).emit('new-message', messageData);
    } else {
      socket.emit('message-error', { error: 'Failed to send message' });
    }
  });

  socket.on('viewer-ready', (data) => {
    const { roomId } = data;
    
    if (!roomId || !rooms[roomId]) return;

    if (rooms[roomId].streamer) {
      const streamerSocket = io.sockets.sockets.get(rooms[roomId].streamer);
      if (streamerSocket) {
        streamerSocket.emit('viewer-ready', { viewerId: socket.id });
      }
    }
  });

  socket.on('request-stream', (data) => {
    const { roomId } = data;
    
    if (!roomId || !rooms[roomId]) return;

    if (rooms[roomId].streamer && rooms[roomId].streamActive) {
      const streamerSocket = io.sockets.sockets.get(rooms[roomId].streamer);
      if (streamerSocket) {
        streamerSocket.emit('viewer-requesting-stream', { viewerId: socket.id });
      }
    }
  });

  socket.on('disconnect', async () => {
    console.log(`Disconnected: ${socket.id}`);

    const roomId = socketToRoom[socket.id];
    
    if (roomId && rooms[roomId]) {
      if (rooms[roomId].streamer === socket.id) {
        const user = socketToUser[socket.id];
        if (user) {
          await dbQuery('stopStream', { roomId, userId: user.userId });
        }

        rooms[roomId].streamActive = false;
        
        io.to(roomId).emit('stream-status-changed', { 
          active: false,
          roomId 
        });

        rooms[roomId].viewers.forEach(viewerId => {
          const viewerSocket = io.sockets.sockets.get(viewerId);
          if (viewerSocket) {
            viewerSocket.emit('stream-ended');
          }
        });

        rooms[roomId].streamer = null;
      } else {
        rooms[roomId].viewers = rooms[roomId].viewers.filter(v => v !== socket.id);
        
        if (rooms[roomId].streamer) {
          const streamerSocket = io.sockets.sockets.get(rooms[roomId].streamer);
          if (streamerSocket) {
            streamerSocket.emit('viewer-left', { viewerId: socket.id });
          }
        }
      }

      updateViewerCount(roomId);

      if (!rooms[roomId].streamer && rooms[roomId].viewers.length === 0) {
        delete rooms[roomId];
      }
    }

    const user = socketToUser[socket.id];
    if (user) {
      delete userSockets[user.userId];
    }
    
    delete socketToUser[socket.id];
    delete socketToRoom[socket.id];
  });

  socket.on('ping', () => {
    socket.emit('pong');
  });

  socket.on('get-viewer-count', (data) => {
    const { roomId } = data;
    if (roomId && rooms[roomId]) {
      socket.emit('viewer-count', { 
        count: rooms[roomId].viewers.length 
      });
    }
  });
});

function updateViewerCount(roomId) {
  if (!rooms[roomId]) return;

  const count = rooms[roomId].viewers.length;
  
  io.to(roomId).emit('viewer-count', { count });
}

setInterval(() => {
  Object.keys(rooms).forEach(roomId => {
    updateViewerCount(roomId);
  });
}, 5000);

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: Object.keys(rooms).length,
    connections: io.sockets.sockets.size
  });
});

app.get('/api/rooms', (req, res) => {
  const roomList = Object.keys(rooms).map(roomId => ({
    roomId,
    viewers: rooms[roomId].viewers.length,
    active: rooms[roomId].streamActive
  }));
  res.json({ rooms: roomList });
});

server.listen(PORT, () => {
  console.log(`NanoStream server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing server');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
