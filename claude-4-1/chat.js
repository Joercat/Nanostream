// Chat handler module
function handleChat(socket, io, rooms) {
    // Handle chat messages
    socket.on('chat-message', ({ roomId, username, message }) => {
        if (!roomId || !username || !message) return;
        
        const room = rooms.get(roomId);
        if (!room) return;
        
        // Create message object
        const chatMessage = {
            id: Date.now() + Math.random(),
            username,
            message: message.substring(0, 500), // Limit message length
            timestamp: new Date().toISOString(),
            isStreamer: socket.id === room.streamerId
        };
        
        // Store message in room (keep last 100 messages)
        room.messages.push(chatMessage);
        if (room.messages.length > 100) {
            room.messages = room.messages.slice(-100);
        }
        
        // Broadcast to all users in room
        io.to(roomId).emit('chat-message', chatMessage);
        
        console.log(`Chat message in room ${roomId} from ${username}`);
    });

    // Handle chat moderation (basic implementation)
    socket.on('clear-chat', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (room && room.streamerId === socket.id) {
            // Only streamer can clear chat
            room.messages = [];
            io.to(roomId).emit('chat-cleared');
            console.log(`Chat cleared in room ${roomId}`);
        }
    });

    // Get chat history (for late joiners)
    socket.on('get-chat-history', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (room) {
            socket.emit('chat-history', {
                messages: room.messages.slice(-50) // Send last 50 messages
            });
        }
    });

    // System messages
    socket.on('system-message', ({ roomId, message, type }) => {
        const room = rooms.get(roomId);
        if (room) {
            const systemMessage = {
                id: Date.now() + Math.random(),
                username: 'System',
                message,
                timestamp: new Date().toISOString(),
                isSystem: true,
                type: type || 'info' // info, warning, error
            };
            
            room.messages.push(systemMessage);
            io.to(roomId).emit('chat-message', systemMessage);
        }
    });
}

module.exports = { handleChat };
