// Global variables
let socket = null;
let localStream = null;
let peerConnections = new Map();
let currentRole = null;
let currentRoom = null;
let currentUsername = null;
let isLive = false;

// ICE configuration
const iceConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
};

// Initialize socket connection
function initializeSocket() {
    socket = io();
    
    socket.on('connect', () => {
        console.log('Connected to server');
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        handleDisconnection();
    });
    
    // Role assignment
    socket.on('role-assigned', ({ role, roomInfo }) => {
        currentRole = role;
        console.log(`Assigned role: ${role}`);
        
        if (role === 'streamer') {
            showStreamerView(roomInfo);
        } else {
            showViewerView(roomInfo);
        }
        
        // Load chat history
        if (roomInfo.messages) {
            roomInfo.messages.forEach(msg => {
                displayChatMessage(msg);
            });
        }
    });
    
    // WebRTC signaling events
    socket.on('viewer-wants-stream', async ({ viewerId, viewerUsername }) => {
        if (currentRole === 'streamer' && isLive) {
            console.log(`Viewer ${viewerUsername} wants to connect`);
            await createPeerConnection(viewerId);
        }
    });
    
    socket.on('offer', async ({ streamerId, offer }) => {
        if (currentRole === 'viewer') {
            console.log('Received offer from streamer');
            await handleOffer(streamerId, offer);
        }
    });
    
    socket.on('answer', async ({ viewerId, answer }) => {
        if (currentRole === 'streamer') {
            console.log(`Received answer from viewer ${viewerId}`);
            await handleAnswer(viewerId, answer);
        }
    });
    
    socket.on('ice-candidate', async ({ senderId, candidate }) => {
        console.log(`Received ICE candidate from ${senderId}`);
        await handleIceCandidate(senderId, candidate);
    });
    
    // Stream events
    socket.on('stream-started', ({ streamerUsername }) => {
        if (currentRole === 'viewer') {
            document.getElementById('streamer-name').textContent = `${streamerUsername}'s Stream`;
            document.getElementById('stream-status').innerHTML = `
                <p class="text-green-400">Stream is live! Connecting...</p>
            `;
            // Request stream connection
            socket.emit('viewer-request-stream', { 
                roomId: currentRoom, 
                viewerId: socket.id 
            });
        }
    });
    
    socket.on('stream-ended', () => {
        if (currentRole === 'viewer') {
            handleStreamEnded();
        }
    });
    
    socket.on('viewer-joined', ({ viewerId, username, viewerCount }) => {
        if (currentRole === 'streamer') {
            updateViewerCount(viewerCount);
            displaySystemMessage(`${username} joined the stream`, 'info');
        }
    });
    
    socket.on('viewer-left', ({ viewerId, viewerCount }) => {
        if (currentRole === 'streamer') {
            updateViewerCount(viewerCount);
            // Clean up peer connection
            if (peerConnections.has(viewerId)) {
                peerConnections.get(viewerId).close();
                peerConnections.delete(viewerId);
            }
        }
    });
    
    // Chat events
    socket.on('chat-message', (message) => {
        displayChatMessage(message);
    });
    
    socket.on('chat-cleared', () => {
        clearChatDisplay();
        displaySystemMessage('Chat has been cleared', 'info');
    });
}

// Join room
document.getElementById('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const roomId = document.getElementById('room-id').value.trim();
    const username = document.getElementById('username').value.trim();
    
    if (!roomId || !username) return;
    
    currentRoom = roomId;
    currentUsername = username;
    
    // Initialize socket if not already connected
    if (!socket) {
        initializeSocket();
    }
    
    // Join room
    socket.emit('join-room', { roomId, user: username });
});

// Streamer functions
function showStreamerView(roomInfo) {
    document.getElementById('join-screen').classList.add('hidden');
    document.getElementById('streamer-view').classList.remove('hidden');
    
    initializeChat('chat-panel-streamer');
    updateViewerCount(roomInfo.viewerCount || 0);
    
    // Setup local video preview
    setupLocalVideo();
}

async function setupLocalVideo() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 }
            },
            audio: true
        });
        
        const localVideo = document.getElementById('local-video');
        localVideo.srcObject = localStream;
        
    } catch (error) {
        console.error('Error accessing media devices:', error);
        displaySystemMessage('Failed to access camera/microphone', 'error');
    }
}

document.getElementById('go-live-btn').addEventListener('click', async () => {
    const btn = document.getElementById('go-live-btn');
    
    if (!isLive) {
        // Start streaming
        if (!localStream) {
            await setupLocalVideo();
        }
        
        if (localStream) {
            isLive = true;
            btn.textContent = 'End Stream';
            btn.classList.remove('bg-red-600', 'hover:bg-red-700');
            btn.classList.add('bg-gray-600', 'hover:bg-gray-700');
            
            socket.emit('streamer-live', { 
                roomId: currentRoom, 
                username: currentUsername 
            });
            
            displaySystemMessage('You are now live!', 'success');
        }
    } else {
        // Stop streaming
        isLive = false;
        btn.textContent = 'Go Live';
        btn.classList.remove('bg-gray-600', 'hover:bg-gray-700');
        btn.classList.add('bg-red-600', 'hover:bg-red-700');
        
        // Close all peer connections
        peerConnections.forEach(pc => pc.close());
        peerConnections.clear();
        
        socket.emit('stop-stream', { roomId: currentRoom });
        displaySystemMessage('Stream ended', 'info');
    }
});

// Viewer functions
function showViewerView(roomInfo) {
    document.getElementById('join-screen').classList.add('hidden');
    document.getElementById('viewer-view').classList.remove('hidden');
    
    initializeChat('chat-panel-viewer');
    
    if (roomInfo.isLive && roomInfo.streamerUsername) {
        document.getElementById('streamer-name').textContent = `${roomInfo.streamerUsername}'s Stream`;
        document.getElementById('stream-status').innerHTML = `
            <p class="text-green-400">Stream is live! Connecting...</p>
        `;
        // Request stream
        socket.emit('viewer-request-stream', { 
            roomId: currentRoom, 
            viewerId: socket.id 
        });
    }
}

// WebRTC functions
async function createPeerConnection(viewerId) {
    const pc = new RTCPeerConnection(iceConfig);
    peerConnections.set(viewerId, pc);
    
    // Add local stream tracks
    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });
    
    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                roomId: currentRoom,
                targetId: viewerId,
                candidate: event.candidate
            });
        }
    };
    
    // Create offer
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        socket.emit('offer', {
            roomId: currentRoom,
            viewerId: viewerId,
            offer: offer
        });
    } catch (error) {
        console.error('Error creating offer:', error);
    }
}

async function handleOffer(streamerId, offer) {
    const pc = new RTCPeerConnection(iceConfig);
    peerConnections.set(streamerId, pc);
    
    // Handle incoming stream
    pc.ontrack = (event) => {
        console.log('Received remote stream');
        const remoteVideo = document.getElementById('remote-video');
        remoteVideo.srcObject = event.streams[0];
        remoteVideo.classList.remove('hidden');
        document.getElementById('stream-status').classList.add('hidden');
    };
    
    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                roomId: currentRoom,
                targetId: streamerId,
                candidate: event.candidate
            });
        }
    };
    
    // Set remote description and create answer
    try {
        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        socket.emit('answer', {
            roomId: currentRoom,
            streamerId: streamerId,
            answer: answer
        });
    } catch (error) {
        console.error('Error handling offer:', error);
    }
}

async function handleAnswer(viewerId, answer) {
    const pc = peerConnections.get(viewerId);
    if (pc) {
        try {
            await pc.setRemoteDescription(answer);
            console.log(`Connection established with viewer ${viewerId}`);
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }
}

async function handleIceCandidate(senderId, candidate) {
    const pc = peerConnections.get(senderId);
    if (pc) {
        try {
            await pc.addIceCandidate(candidate);
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }
}

// Chat functions
function initializeChat(panelId) {
    const chatPanel = document.getElementById(panelId);
    chatPanel.innerHTML = `
        <div class="p-4 border-b border-gray-700">
            <h3 class="font-semibold">Stream Chat</h3>
        </div>
        <div id="chat-messages" class="flex-1 overflow-y-auto p-4 space-y-2">
            <!-- Messages will appear here -->
        </div>
        <div class="p-4 border-t border-gray-700">
            <form id="chat-form" class="flex gap-2">
                <input 
                    type="text" 
                    id="chat-input" 
                    placeholder="Type a message..."
                    class="flex-1 px-3 py-2 bg-gray-700 rounded-lg focus:ring-2 focus:ring-violet-500 focus:outline-none"
                    maxlength="500"
                >
                <button 
                    type="submit"
                    class="px-4 py-2 bg-violet-600 rounded-lg hover:bg-violet-700 transition"
                >
                    Send
                </button>
            </form>
        </div>
    `;
    
    // Setup chat form
    document.getElementById('chat-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('chat-input');
        const message = input.value.trim();
        
        if (message) {
            socket.emit('chat-message', {
                roomId: currentRoom,
                username: currentUsername,
                message: message
            });
            input.value = '';
        }
    });
}

function displayChatMessage(message) {
    const messagesContainer = document.getElementById('chat-messages');
    if (!messagesContainer) return;
    
    const messageEl = document.createElement('div');
    messageEl.className = 'animate-fade-in';
    
    if (message.isSystem) {
        messageEl.innerHTML = `
            <div class="text-sm text-gray-400 italic">${message.message}</div>
        `;
    } else {
        const usernameColor = message.isStreamer ? 'text-violet-400' : 'text-gray-300';
        const badge = message.isStreamer ? '<span class="ml-1 text-xs bg-violet-600 px-1 rounded">LIVE</span>' : '';
        
        messageEl.innerHTML = `
            <div>
                <span class="font-semibold ${usernameColor}">${message.username}${badge}:</span>
                <span class="text-gray-100 break-words">${escapeHtml(message.message)}</span>
            </div>
        `;
    }
    
    messagesContainer.appendChild(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function displaySystemMessage(message, type = 'info') {
    socket.emit('system-message', {
        roomId: currentRoom,
        message: message,
        type: type
    });
}

function clearChatDisplay() {
    const messagesContainer = document.getElementById('chat-messages');
    if (messagesContainer) {
        messagesContainer.innerHTML = '';
    }
}

// Utility functions
function updateViewerCount(count) {
    document.getElementById('viewer-count').textContent = count;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function handleStreamEnded() {
    const remoteVideo = document.getElementById('remote-video');
    remoteVideo.srcObject = null;
    remoteVideo.classList.add('hidden');
    
    document.getElementById('stream-status').classList.remove('hidden');
    document.getElementById('stream-status').innerHTML = `
        <div class="mb-4">
            <div class="inline-flex items-center justify-center w-16 h-16 bg-gray-800 rounded-full">
                <svg class="w-8 h-8 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                </svg>
            </div>
        </div>
        <p class="text-gray-400">Stream has ended</p>
    `;
    
    // Clean up peer connections
    peerConnections.forEach(pc => pc.close());
    peerConnections.clear();
}

function handleDisconnection() {
    // Clean up resources
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    peerConnections.forEach(pc => pc.close());
    peerConnections.clear();
    
    // Return to join screen
    document.getElementById('join-screen').classList.remove('hidden');
    document.getElementById('streamer-view').classList.add('hidden');
    document.getElementById('viewer-view').classList.add('hidden');
}

// Leave buttons
document.getElementById('leave-btn-streamer').addEventListener('click', () => {
    if (confirm('Are you sure you want to end the stream and leave?')) {
        handleDisconnection();
        if (socket) {
            socket.disconnect();
            socket = null;
        }
    }
});

document.getElementById('leave-btn-viewer').addEventListener('click', () => {
    handleDisconnection();
    if (socket) {
        socket.disconnect();
        socket = null;
    }
});
