/**
 * NanoStream - Main Server Entry Point
 * 
 * This file initializes the Express HTTP server and Socket.io WebSocket server.
 * It serves static files (HTML, CSS, JS) and delegates all WebRTC signaling
 * and room management logic to the signaling module.
 * 
 * Key Responsibilities:
 * - Serve the client-side application files
 * - Initialize and configure Socket.io for real-time communication
 * - Handle server lifecycle (startup, shutdown)
 * - Provide basic health check endpoint
 */

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const signaling = require('./signaling');

// ============================================================================
// SERVER CONFIGURATION
// ============================================================================

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*", // In production, specify exact origins
    methods: ["GET", "POST"]
  },
  // Optimize for low-latency by reducing ping intervals
  pingInterval: 10000,
  pingTimeout: 5000,
  // Allow larger payloads for video metadata if needed
  maxHttpBufferSize: 1e6
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Parse JSON bodies (for potential REST endpoints)
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url} - ${req.ip}`);
  next();
});

// ============================================================================
// HTTP ROUTES
// ============================================================================

/**
 * Health check endpoint
 * Returns server status and basic statistics
 */
app.get('/api/health', (req, res) => {
  const stats = signaling.getServerStats();
  res.json({
    status: 'online',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    ...stats
  });
});

/**
 * Get room information endpoint
 * Returns details about a specific room
 */
app.get('/api/room/:roomId', (req, res) => {
  const roomInfo = signaling.getRoomInfo(req.params.roomId);
  if (roomInfo) {
    res.json(roomInfo);
  } else {
    res.status(404).json({ error: 'Room not found' });
  }
});

/**
 * Fallback route - serve index.html for all other requests
 * This enables client-side routing if needed
 */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// SOCKET.IO CONNECTION HANDLING
// ============================================================================

/**
 * Main Socket.io connection handler
 * Delegates all signaling logic to the signaling module
 */
io.on('connection', (socket) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ✓ New socket connection: ${socket.id}`);

  // Initialize signaling handlers for this socket
  signaling.handleConnection(socket, io);

  // Handle socket disconnection
  socket.on('disconnect', (reason) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ✗ Socket disconnected: ${socket.id} (${reason})`);
  });

  // Handle socket errors
  socket.on('error', (error) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ⚠ Socket error for ${socket.id}:`, error);
  });
});

// ============================================================================
// SERVER LIFECYCLE
// ============================================================================

/**
 * Start the server and listen on the configured port
 */
server.listen(PORT, HOST, () => {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║              NanoStream Server Started                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\n🚀 Server running at: http://localhost:${PORT}`);
  console.log(`📡 WebSocket ready for connections`);
  console.log(`⏰ Started at: ${new Date().toISOString()}\n`);
  console.log('Press Ctrl+C to stop the server\n');
});

/**
 * Graceful shutdown handler
 * Ensures all connections are properly closed before exit
 */
process.on('SIGTERM', () => {
  console.log('\n⚠ SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('✓ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n\n⚠ SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('✓ Server closed');
    process.exit(0);
  });
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Handle uncaught exceptions
 */
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  process.exit(1);
});

/**
 * Handle unhandled promise rejections
 */
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

module.exports = { app, server, io };
