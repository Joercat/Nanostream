const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fetch = require('node-fetch');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;
const PHP_API_URL = process.env.PHP_API_URL || 'https://joercat.infinityfree.com/db_connector.php';

console.log('PHP API URL:', PHP_API_URL);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const rooms = new Map();
const userSockets = new Map();
const socketUsers = new Map();

// Create custom HTTPS agent that ignores SSL errors
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

// Updated makePhpRequest function with better error handling
async function makePhpRequest(action, data) {
  try {
    console.log('Making PHP request:', { 
      url: PHP_API_URL,
      action, 
      data 
    });
    
    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'NanoStream/1.0'
      },
      body: JSON.stringify({ action, ...data }),
      agent: httpsAgent,
      timeout: 30000
    };

    console.log('Request options:', requestOptions);
    
    const response = await fetch(PHP_API_URL, requestOptions);
    
    // Get raw text first
    const rawText = await response.text();
    console.log('Response status:', response.status);
    console.log('Response headers:', response.headers);
    console.log('Raw response:', rawText);
    
    // Check if response starts with HTML
    if (rawText.trim().toLowerCase().startsWith('<html')) {
      console.error('Received HTML response instead of JSON');
      return { 
        success: false, 
        error: 'Server returned HTML instead of JSON',
        debug_info: {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          rawResponse: rawText.substring(0, 500)
        }
      };
    }
    
    try {
      // Try to parse as JSON
      const result = JSON.parse(rawText);
      return result;
    } catch (parseError) {
      console.error('JSON Parse Error:', parseError);
      // Return a structured error response
      return { 
        success: false, 
        error: 'Invalid JSON response',
        debug_info: {
          parseError: parseError.message,
          rawResponse: rawText.substring(0, 500),
          status: response.status,
          headers: Object.fromEntries(response.headers)
        }
      };
    }
  } catch (error) {
    console.error('Request Error:', error);
    return { 
      success: false, 
      error: error.message,
      debug_info: {
        action,
        data,
        url: PHP_API_URL,
        timestamp: new Date().toISOString(),
        errorType: error.name,
        errorStack: error.stack
      }
    };
  }
}

// Example registration route
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.json({ success: false, error: 'Missing required fields' });
  }
  
  const result = await makePhpRequest('register', { username, password });
  res.json(result);
});

// Example login route
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.json({ success: false, error: 'Missing required fields' });
  }
  
  const result = await makePhpRequest('login', { username, password });
  res.json(result);
});
class Room {
  constructor(roomId, streamerId, streamerSocketId, streamerUsername, streamTitle) {
    this.roomId = roomId;
    this.streamerId = streamerId;
    this.streamerSocketId = streamerSocketId;
    this.streamerUsername = streamerUsername;
    this.streamTitle = streamTitle || 'Untitled Stream';
    this.viewers = new Map();
    this.startedAt = new Date();
    this.chatHistory = [];
  }

  addViewer(socketId, userId, username) {
    this.viewers.set(socketId, { userId, username, joinedAt: new Date() });
  }

  removeViewer(socketId) {
    this.viewers.delete(socketId);
  }

  getViewerCount() {
    return this.viewers.size;
  }

  isStreamer(socketId) {
    return this.streamerSocketId === socketId;
  }

  hasStreamer() {
    return this.streamerSocketId !== null;
  }

  endStream() {
    this.streamerSocketId = null;
    this.streamerId = null;
  }
}

async function makePhpRequest(action, data) {
  try {
    const response = await fetch(PHP_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...data })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const result = await response.json();
    return result;
  } catch (error) {
    console.error('PHP Request Error:', error);
    return { success: false, error: error.message };
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.json({ success: false, error: 'Username and password required' });
  }
  
  if (username.length < 3 || username.length > 20) {
    return res.json({ success: false, error: 'Username must be 3-20 characters' });
  }
  
  if (password.length < 6) {
    return res.json({ success: false, error: 'Password must be at least 6 characters' });
  }
  
  const result = await makePhpRequest('register', { username, password });
  res.json(result);
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.json({ success: false, error: 'Username and password required' });
  }
  
  const result = await makePhpRequest('login', { username, password });
  res.json(result);
});

app.get('/api/streams', async (req, res) => {
  const result = await makePhpRequest('getActiveStreams', {});
  
  if (result.success) {
    const streamsWithViewers = result.streams.map(stream => {
      const room = rooms.get(stream.room_id);
      return {
        ...stream,
        viewer_count: room ? room.getViewerCount() : 0
      };
    });
    res.json({ success: true, streams: streamsWithViewers });
  } else {
    res.json(result);
  }
});

app.post('/api/stream/create', async (req, res) => {
  const { roomId, userId, username, title } = req.body;
  
  if (!roomId || !userId || !username) {
    return res.json({ success: false, error: 'Missing required fields' });
  }
  
  const result = await makePhpRequest('createStream', { 
    roomId, 
    userId, 
    username,
    title: title || 'Untitled Stream'
  });
  
  res.json(result);
});

app.post('/api/stream/end', async (req, res) => {
  const { roomId, userId } = req.body;
  
  if (!roomId || !userId) {
    return res.json({ success: false, error: 'Missing required fields' });
  }
  
  const result = await makePhpRequest('endStream', { roomId, userId });
  res.json(result);
});

app.post('/api/chat/save', async (req, res) => {
  const { roomId, userId, username, message } = req.body;
  
  if (!roomId || !userId || !username || !message) {
    return res.json({ success: false, error: 'Missing required fields' });
  }
  
  const result = await makePhpRequest('saveChatMessage', { 
    roomId, 
    userId, 
    username, 
    message 
  });
  
  res.json(result);
});

app.get('/api/chat/:roomId', async (req, res) => {
  const { roomId } = req.params;
  const { limit = 100 } = req.query;
  
  const result = await makePhpRequest('getChatHistory', { 
    roomId, 
    limit: parseInt(limit) 
  });
  
  res.json(result);
});

io.use((socket, next) => {
  const userId = socket.handshake.auth.userId;
  const username = socket.handshake.auth.username;
  
  if (!userId || !username) {
    return next(new Error('Authentication required'));
  }
  
  socket.userId = userId;
  socket.username = username;
  next();
});

io.on('connection', (socket) => {
  userSockets.set(socket.userId, socket.id);
  socketUsers.set(socket.id, { userId: socket.userId, username: socket.username });
  
  socket.emit('connected', { 
    socketId: socket.id,
    userId: socket.userId,
    username: socket.username
  });

  socket.on('join-room', async (data) => {
    const { roomId, isStreamer, streamTitle } = data;
    
    if (!roomId) {
      socket.emit('error', { message: 'Room ID required' });
      return;
    }
    
    socket.join(roomId);
    socket.currentRoom = roomId;
    
    let room = rooms.get(roomId);
    
    if (isStreamer) {
      if (room && room.hasStreamer()) {
        socket.emit('error', { message: 'Stream already active in this room' });
        return;
      }
      
      room = new Room(
        roomId,
        socket.userId,
        socket.id,
        socket.username,
        streamTitle
      );
      
      rooms.set(roomId, room);
      
      socket.emit('joined-as-streamer', {
        roomId,
        viewerCount: 0
      });
      
      await makePhpRequest('createStream', {
        roomId,
        userId: socket.userId,
        username: socket.username,
        title: streamTitle || 'Untitled Stream'
      });
      
    } else {
      if (!room || !room.hasStreamer()) {
        socket.emit('stream-offline', { message: 'Stream is offline' });
        return;
      }
      
      room.addViewer(socket.id, socket.userId, socket.username);
      
      socket.emit('joined-as-viewer', {
        roomId,
        streamerUsername: room.streamerUsername,
        streamTitle: room.streamTitle,
        viewerCount: room.getViewerCount()
      });
      
      io.to(room.streamerSocketId).emit('viewer-joined', {
        viewerId: socket.id,
        username: socket.username,
        viewerCount: room.getViewerCount()
      });
      
      await makePhpRequest('updateViewerCount', {
        roomId,
        viewerCount: room.getViewerCount()
      });
    }
    
    const chatHistory = await makePhpRequest('getChatHistory', {
      roomId,
      limit: 50
    });
    
    if (chatHistory.success) {
      socket.emit('chat-history', { messages: chatHistory.messages });
    }
    
    io.to(roomId).emit('viewer-count-update', {
      viewerCount: room.getViewerCount()
    });
  });

  socket.on('offer', (data) => {
    const { roomId, offer, targetSocketId } = data;
    const room = rooms.get(roomId);
    
    if (!room || !room.isStreamer(socket.id)) {
      socket.emit('error', { message: 'Only streamer can send offers' });
      return;
    }
    
    io.to(targetSocketId).emit('offer', {
      offer,
      streamerSocketId: socket.id
    });
  });

  socket.on('answer', (data) => {
    const { roomId, answer } = data;
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    io.to(room.streamerSocketId).emit('answer', {
      answer,
      viewerSocketId: socket.id
    });
  });

  socket.on('ice-candidate', (data) => {
    const { roomId, candidate, targetSocketId } = data;
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice-candidate', {
        candidate,
        fromSocketId: socket.id
      });
    }
  });

  socket.on('chat-message', async (data) => {
    const { roomId, message } = data;
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    if (!message || message.trim().length === 0) {
      return;
    }
    
    const chatMessage = {
      roomId,
      userId: socket.userId,
      username: socket.username,
      message: message.trim(),
      timestamp: new Date().toISOString()
    };
    
    room.chatHistory.push(chatMessage);
    
    if (room.chatHistory.length > 100) {
      room.chatHistory.shift();
    }
    
    io.to(roomId).emit('chat-message', chatMessage);
    
    await makePhpRequest('saveChatMessage', chatMessage);
  });

  socket.on('request-stream', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);
    
    if (!room || !room.hasStreamer()) {
      socket.emit('stream-offline', { message: 'Stream is offline' });
      return;
    }
    
    io.to(room.streamerSocketId).emit('viewer-requesting-stream', {
      viewerSocketId: socket.id,
      username: socket.username
    });
  });

  socket.on('typing', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);
    
    if (!room) return;
    
    socket.to(roomId).emit('user-typing', {
      username: socket.username,
      userId: socket.userId
    });
  });

  socket.on('stop-typing', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);
    
    if (!room) return;
    
    socket.to(roomId).emit('user-stop-typing', {
      username: socket.username,
      userId: socket.userId
    });
  });

  socket.on('get-viewer-count', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);
    
    if (room) {
      socket.emit('viewer-count-update', {
        viewerCount: room.getViewerCount()
      });
    }
  });

  socket.on('disconnect', async () => {
    userSockets.delete(socket.userId);
    socketUsers.delete(socket.id);
    
    if (socket.currentRoom) {
      const room = rooms.get(socket.currentRoom);
      
      if (room) {
        if (room.isStreamer(socket.id)) {
          io.to(socket.currentRoom).emit('stream-ended', {
            message: 'Stream has ended'
          });
          
          room.viewers.forEach((viewer, viewerSocketId) => {
            io.to(viewerSocketId).emit('stream-offline', {
              message: 'Streamer has disconnected'
            });
          });
          
          await makePhpRequest('endStream', {
            roomId: socket.currentRoom,
            userId: socket.userId
          });
          
          rooms.delete(socket.currentRoom);
          
        } else {
          room.removeViewer(socket.id);
          
          io.to(socket.currentRoom).emit('viewer-count-update', {
            viewerCount: room.getViewerCount()
          });
          
          if (room.streamerSocketId) {
            io.to(room.streamerSocketId).emit('viewer-left', {
              viewerSocketId: socket.id,
              viewerCount: room.getViewerCount()
            });
          }
          
          await makePhpRequest('updateViewerCount', {
            roomId: socket.currentRoom,
            viewerCount: room.getViewerCount()
          });
        }
      }
    }
  });

  socket.on('end-stream', async (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);
    
    if (!room || !room.isStreamer(socket.id)) {
      socket.emit('error', { message: 'Only streamer can end stream' });
      return;
    }
    
    io.to(roomId).emit('stream-ended', {
      message: 'Stream has ended'
    });
    
    room.viewers.forEach((viewer, viewerSocketId) => {
      io.to(viewerSocketId).emit('stream-offline', {
        message: 'Stream has ended'
      });
    });
    
    await makePhpRequest('endStream', {
      roomId,
      userId: socket.userId
    });
    
    rooms.delete(roomId);
    
    socket.leave(roomId);
    socket.currentRoom = null;
  });

  socket.on('update-stream-title', async (data) => {
    const { roomId, title } = data;
    const room = rooms.get(roomId);
    
    if (!room || !room.isStreamer(socket.id)) {
      socket.emit('error', { message: 'Only streamer can update title' });
      return;
    }
    
    room.streamTitle = title;
    
    io.to(roomId).emit('stream-title-updated', { title });
    
    await makePhpRequest('updateStreamTitle', {
      roomId,
      title
    });
  });

  socket.on('heartbeat', () => {
    socket.emit('heartbeat-ack', { timestamp: Date.now() });
  });
});

setInterval(async () => {
  for (const [roomId, room] of rooms.entries()) {
    if (room.hasStreamer()) {
      await makePhpRequest('updateViewerCount', {
        roomId,
        viewerCount: room.getViewerCount()
      });
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Test the connection immediately
  makePhpRequest('ping', {}).then(result => {
    console.log('Initial connection test result:', result);
  }).catch(error => {
    console.error('Initial connection test failed:', error);
  });
});
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  
  for (const [roomId, room] of rooms.entries()) {
    if (room.hasStreamer()) {
      await makePhpRequest('endStream', {
        roomId,
        userId: room.streamerId
      });
    }
  }
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
