const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const { handleSignaling } = require('./signaling');
const { handleChat } = require('./chat');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Room management structure
const rooms = new Map();
/*
Room Structure:
{
    streamerId: 'socket-id',
    streamerUsername: 'username',
    viewers: Map<socketId, { username, peerId }>,
    messages: []
}
*/

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);
    
    let currentRoom = null;
    let username = null;

    // Join room request
    socket.on('join-room', ({ roomId, user }) => {
        currentRoom = roomId;
        username = user;
        
        socket.join(roomId);
        
        // Initialize room if it doesn't exist
        if (!rooms.has(roomId)) {
            rooms.set(roomId, {
                streamerId: null,
                streamerUsername: null,
                viewers: new Map(),
                messages: []
            });
        }
        
        const room = rooms.get(roomId);
        
        // Determine role and send appropriate response
        if (!room.streamerId) {
            // First user becomes potential streamer
            socket.emit('role-assigned', { 
                role: 'streamer',
                roomInfo: {
                    viewerCount: room.viewers.size,
                    messages: room.messages.slice(-50) // Last 50 messages
                }
            });
        } else {
            // Subsequent users are viewers
            room.viewers.set(socket.id, { username, peerId: null });
            socket.emit('role-assigned', { 
                role: 'viewer',
                roomInfo: {
                    streamerUsername: room.streamerUsername,
                    isLive: true,
                    messages: room.messages.slice(-50)
                }
            });
            
            // Notify streamer of new viewer
            io.to(room.streamerId).emit('viewer-joined', {
                viewerId: socket.id,
                username,
                viewerCount: room.viewers.size
            });
        }
    });

    // Streamer goes live
    socket.on('streamer-live', ({ roomId, username: streamerName }) => {
        const room = rooms.get(roomId);
        if (room && !room.streamerId) {
            room.streamerId = socket.id;
            room.streamerUsername = streamerName;
            
            // Notify all users in room that stream is live
            socket.to(roomId).emit('stream-started', {
                streamerUsername: streamerName
            });
            
            console.log(`Streamer ${streamerName} went live in room ${roomId}`);
        }
    });

    // Handle WebRTC signaling
    handleSignaling(socket, io, rooms);
    
    // Handle chat messages
    handleChat(socket, io, rooms);

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        
        if (currentRoom && rooms.has(currentRoom)) {
            const room = rooms.get(currentRoom);
            
            if (room.streamerId === socket.id) {
                // Streamer disconnected
                room.streamerId = null;
                room.streamerUsername = null;
                
                // Notify all viewers
                io.to(currentRoom).emit('stream-ended');
                
                // Clear all viewer peer connections
                room.viewers.clear();
                
                console.log(`Streamer left room ${currentRoom}`);
            } else if (room.viewers.has(socket.id)) {
                // Viewer disconnected
                room.viewers.delete(socket.id);
                
                // Notify streamer
                if (room.streamerId) {
                    io.to(room.streamerId).emit('viewer-left', {
                        viewerId: socket.id,
                        viewerCount: room.viewers.size
                    });
                }
                
                console.log(`Viewer ${username} left room ${currentRoom}`);
            }
            
            // Clean up empty rooms
            if (!room.streamerId && room.viewers.size === 0) {
                rooms.delete(currentRoom);
                console.log(`Room ${currentRoom} deleted (empty)`);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`NanoStream server running on port ${PORT}`);
    console.log(`Access the application at http://localhost:${PORT}`);
});
