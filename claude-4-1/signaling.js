// WebRTC signaling handler module
function handleSignaling(socket, io, rooms) {
    // Viewer requests to connect to streamer
    socket.on('viewer-request-stream', ({ roomId, viewerId }) => {
        const room = rooms.get(roomId);
        if (room && room.streamerId) {
            // Forward request to streamer
            io.to(room.streamerId).emit('viewer-wants-stream', {
                viewerId,
                viewerUsername: room.viewers.get(viewerId)?.username
            });
        }
    });

    // WebRTC offer from streamer to viewer
    socket.on('offer', ({ roomId, viewerId, offer }) => {
        const room = rooms.get(roomId);
        if (room && room.streamerId === socket.id) {
            // Forward offer to specific viewer
            io.to(viewerId).emit('offer', {
                streamerId: socket.id,
                offer
            });
            console.log(`Offer sent from streamer to viewer ${viewerId}`);
        }
    });

    // WebRTC answer from viewer to streamer
    socket.on('answer', ({ roomId, streamerId, answer }) => {
        const room = rooms.get(roomId);
        if (room && room.viewers.has(socket.id)) {
            // Forward answer to streamer
            io.to(streamerId).emit('answer', {
                viewerId: socket.id,
                answer
            });
            console.log(`Answer sent from viewer ${socket.id} to streamer`);
        }
    });

    // ICE candidate exchange
    socket.on('ice-candidate', ({ roomId, targetId, candidate }) => {
        // Forward ICE candidate to target peer
        io.to(targetId).emit('ice-candidate', {
            senderId: socket.id,
            candidate
        });
    });

    // Handle stream stop from streamer
    socket.on('stop-stream', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (room && room.streamerId === socket.id) {
            room.streamerId = null;
            room.streamerUsername = null;
            
            // Notify all viewers
            io.to(roomId).emit('stream-ended');
            
            // Clear viewer connections
            room.viewers.clear();
            
            console.log(`Stream stopped in room ${roomId}`);
        }
    });

    // Viewer notifies successful connection
    socket.on('viewer-connected', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (room && room.viewers.has(socket.id)) {
            const viewer = room.viewers.get(socket.id);
            viewer.connected = true;
            
            console.log(`Viewer ${viewer.username} successfully connected to stream in room ${roomId}`);
        }
    });

    // Handle connection failures
    socket.on('connection-failed', ({ roomId, error }) => {
        console.error(`Connection failed in room ${roomId}:`, error);
        
        const room = rooms.get(roomId);
        if (room) {
            if (room.streamerId === socket.id) {
                // Streamer connection failed
                socket.emit('streamer-error', { 
                    message: 'Failed to establish stream connection' 
                });
            } else if (room.viewers.has(socket.id)) {
                // Viewer connection failed
                socket.emit('viewer-error', { 
                    message: 'Failed to connect to stream' 
                });
            }
        }
    });
}

module.exports = { handleSignaling };
