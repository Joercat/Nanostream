<?php
error_reporting(0);
ini_set('display_errors', 0);

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

$DB_HOST = 'sql104.infinityfree.com';
$DB_USER = 'if0_39928081';
$DB_PASS = 'xme8GHrwj1NzhHd';
$DB_NAME = 'if0_39928081_nigga';

function sendResponse($data) {
    echo json_encode($data);
    exit();
}

function sendError($message) {
    sendResponse(['success' => false, 'error' => $message]);
}

function sendSuccess($data = []) {
    sendResponse(array_merge(['success' => true], $data));
}

$conn = @new mysqli($DB_HOST, $DB_USER, $DB_PASS, $DB_NAME);

if ($conn->connect_error) {
    sendError('Database connection failed');
}

$conn->set_charset('utf8mb4');

function createTables($conn) {
    $tables = [
        "CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_login TIMESTAMP NULL,
            INDEX idx_username (username)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        
        "CREATE TABLE IF NOT EXISTS active_streams (
            id INT AUTO_INCREMENT PRIMARY KEY,
            room_id VARCHAR(100) UNIQUE NOT NULL,
            streamer_user_id INT NOT NULL,
            streamer_username VARCHAR(50) NOT NULL,
            title VARCHAR(255) DEFAULT 'Untitled Stream',
            viewer_count INT DEFAULT 0,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_room_id (room_id),
            INDEX idx_streamer (streamer_user_id),
            FOREIGN KEY (streamer_user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        
        "CREATE TABLE IF NOT EXISTS chat_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            room_id VARCHAR(100) NOT NULL,
            user_id INT NOT NULL,
            username VARCHAR(50) NOT NULL,
            message TEXT NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_room_id (room_id),
            INDEX idx_timestamp (timestamp),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
        
        "CREATE TABLE IF NOT EXISTS stream_history (
            id INT AUTO_INCREMENT PRIMARY KEY,
            room_id VARCHAR(100) NOT NULL,
            streamer_user_id INT NOT NULL,
            streamer_username VARCHAR(50) NOT NULL,
            title VARCHAR(255),
            started_at TIMESTAMP NOT NULL,
            ended_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            duration INT,
            peak_viewers INT DEFAULT 0,
            INDEX idx_streamer (streamer_user_id),
            INDEX idx_ended_at (ended_at),
            FOREIGN KEY (streamer_user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
    ];
    
    foreach ($tables as $sql) {
        $conn->query($sql);
    }
}

createTables($conn);

$input = file_get_contents('php://input');
$data = json_decode($input, true);

if (!$data || !isset($data['action'])) {
    sendError('Invalid request');
}

$action = $data['action'];

function sanitizeInput($input) {
    return htmlspecialchars(strip_tags(trim($input)));
}

function validateUsername($username) {
    return preg_match('/^[a-zA-Z0-9_]{3,20}$/', $username);
}

switch ($action) {
    case 'register':
        $username = isset($data['username']) ? sanitizeInput($data['username']) : '';
        $password = isset($data['password']) ? $data['password'] : '';
        
        if (empty($username) || empty($password)) {
            sendError('Username and password required');
        }
        
        if (!validateUsername($username)) {
            sendError('Invalid username format');
        }
        
        if (strlen($password) < 6) {
            sendError('Password must be at least 6 characters');
        }
        
        $stmt = $conn->prepare("SELECT id FROM users WHERE username = ?");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("s", $username);
        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($result->num_rows > 0) {
            $stmt->close();
            sendError('Username already exists');
        }
        $stmt->close();
        
        $passwordHash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
        
        $stmt = $conn->prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("ss", $username, $passwordHash);
        
        if ($stmt->execute()) {
            $stmt->close();
            sendSuccess(['message' => 'Registration successful']);
        } else {
            $stmt->close();
            sendError('Registration failed');
        }
        break;
        
    case 'login':
        $username = isset($data['username']) ? sanitizeInput($data['username']) : '';
        $password = isset($data['password']) ? $data['password'] : '';
        
        if (empty($username) || empty($password)) {
            sendError('Username and password required');
        }
        
        $stmt = $conn->prepare("SELECT id, password_hash FROM users WHERE username = ?");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("s", $username);
        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($result->num_rows === 0) {
            $stmt->close();
            sendError('Invalid username or password');
        }
        
        $user = $result->fetch_assoc();
        $stmt->close();
        
        if (password_verify($password, $user['password_hash'])) {
            $userId = $user['id'];
            $updateStmt = $conn->prepare("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?");
            if ($updateStmt) {
                $updateStmt->bind_param("i", $userId);
                $updateStmt->execute();
                $updateStmt->close();
            }
            
            sendSuccess([
                'userId' => $user['id'],
                'username' => $username
            ]);
        } else {
            sendError('Invalid username or password');
        }
        break;
        
    case 'createStream':
        $roomId = isset($data['roomId']) ? sanitizeInput($data['roomId']) : '';
        $userId = isset($data['userId']) ? intval($data['userId']) : 0;
        $username = isset($data['username']) ? sanitizeInput($data['username']) : '';
        $title = isset($data['title']) ? sanitizeInput($data['title']) : 'Untitled Stream';
        
        if (empty($roomId) || $userId <= 0 || empty($username)) {
            sendError('Missing required fields');
        }
        
        $stmt = $conn->prepare("SELECT id FROM active_streams WHERE room_id = ?");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("s", $roomId);
        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($result->num_rows > 0) {
            $stmt->close();
            sendError('Stream already exists in this room');
        }
        $stmt->close();
        
        $stmt = $conn->prepare("INSERT INTO active_streams (room_id, streamer_user_id, streamer_username, title) VALUES (?, ?, ?, ?)");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("siss", $roomId, $userId, $username, $title);
        
        if ($stmt->execute()) {
            $stmt->close();
            sendSuccess(['message' => 'Stream created']);
        } else {
            $stmt->close();
            sendError('Failed to create stream');
        }
        break;
        
    case 'endStream':
        $roomId = isset($data['roomId']) ? sanitizeInput($data['roomId']) : '';
        $userId = isset($data['userId']) ? intval($data['userId']) : 0;
        
        if (empty($roomId) || $userId <= 0) {
            sendError('Missing required fields');
        }
        
        $stmt = $conn->prepare("SELECT streamer_user_id, streamer_username, title, viewer_count, started_at FROM active_streams WHERE room_id = ? AND streamer_user_id = ?");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("si", $roomId, $userId);
        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($result->num_rows === 0) {
            $stmt->close();
            sendError('Stream not found');
        }
        
        $stream = $result->fetch_assoc();
        $stmt->close();
        
        $startedAt = $stream['started_at'];
        $streamerId = $stream['streamer_user_id'];
        $streamerUsername = $stream['streamer_username'];
        $streamTitle = $stream['title'];
        $peakViewers = $stream['viewer_count'];
        
        $startTimestamp = strtotime($startedAt);
        $duration = time() - $startTimestamp;
        
        $historyStmt = $conn->prepare("INSERT INTO stream_history (room_id, streamer_user_id, streamer_username, title, started_at, duration, peak_viewers) VALUES (?, ?, ?, ?, ?, ?, ?)");
        if ($historyStmt) {
            $historyStmt->bind_param("sisssii", $roomId, $streamerId, $streamerUsername, $streamTitle, $startedAt, $duration, $peakViewers);
            $historyStmt->execute();
            $historyStmt->close();
        }
        
        $deleteStmt = $conn->prepare("DELETE FROM active_streams WHERE room_id = ? AND streamer_user_id = ?");
        if (!$deleteStmt) {
            sendError('Database error');
        }
        
        $deleteStmt->bind_param("si", $roomId, $userId);
        
        if ($deleteStmt->execute()) {
            $deleteStmt->close();
            sendSuccess(['message' => 'Stream ended']);
        } else {
            $deleteStmt->close();
            sendError('Failed to end stream');
        }
        break;
        
    case 'getActiveStreams':
        $stmt = $conn->prepare("SELECT room_id, streamer_user_id, streamer_username, title, viewer_count, started_at FROM active_streams ORDER BY started_at DESC");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->execute();
        $result = $stmt->get_result();
        
        $streams = [];
        while ($row = $result->fetch_assoc()) {
            $streams[] = $row;
        }
        
        $stmt->close();
        sendSuccess(['streams' => $streams]);
        break;
        
    case 'updateViewerCount':
        $roomId = isset($data['roomId']) ? sanitizeInput($data['roomId']) : '';
        $viewerCount = isset($data['viewerCount']) ? intval($data['viewerCount']) : 0;
        
        if (empty($roomId)) {
            sendError('Room ID required');
        }
        
        $stmt = $conn->prepare("UPDATE active_streams SET viewer_count = ? WHERE room_id = ?");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("is", $viewerCount, $roomId);
        
        if ($stmt->execute()) {
            $stmt->close();
            sendSuccess(['message' => 'Viewer count updated']);
        } else {
            $stmt->close();
            sendError('Failed to update viewer count');
        }
        break;
        
    case 'updateStreamTitle':
        $roomId = isset($data['roomId']) ? sanitizeInput($data['roomId']) : '';
        $title = isset($data['title']) ? sanitizeInput($data['title']) : 'Untitled Stream';
        
        if (empty($roomId)) {
            sendError('Room ID required');
        }
        
        $stmt = $conn->prepare("UPDATE active_streams SET title = ? WHERE room_id = ?");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("ss", $title, $roomId);
        
        if ($stmt->execute()) {
            $stmt->close();
            sendSuccess(['message' => 'Title updated']);
        } else {
            $stmt->close();
            sendError('Failed to update title');
        }
        break;
        
    case 'saveChatMessage':
        $roomId = isset($data['roomId']) ? sanitizeInput($data['roomId']) : '';
        $userId = isset($data['userId']) ? intval($data['userId']) : 0;
        $username = isset($data['username']) ? sanitizeInput($data['username']) : '';
        $message = isset($data['message']) ? sanitizeInput($data['message']) : '';
        
        if (empty($roomId) || $userId <= 0 || empty($username) || empty($message)) {
            sendError('Missing required fields');
        }
        
        if (strlen($message) > 500) {
            sendError('Message too long');
        }
        
        $stmt = $conn->prepare("INSERT INTO chat_logs (room_id, user_id, username, message) VALUES (?, ?, ?, ?)");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("siss", $roomId, $userId, $username, $message);
        
        if ($stmt->execute()) {
            $stmt->close();
            sendSuccess(['message' => 'Chat message saved']);
        } else {
            $stmt->close();
            sendError('Failed to save message');
        }
        break;
        
    case 'getChatHistory':
        $roomId = isset($data['roomId']) ? sanitizeInput($data['roomId']) : '';
        $limit = isset($data['limit']) ? intval($data['limit']) : 50;
        
        if (empty($roomId)) {
            sendError('Room ID required');
        }
        
        if ($limit > 200) {
            $limit = 200;
        }
        
        $stmt = $conn->prepare("SELECT user_id, username, message, timestamp FROM chat_logs WHERE room_id = ? ORDER BY timestamp DESC LIMIT ?");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("si", $roomId, $limit);
        $stmt->execute();
        $result = $stmt->get_result();
        
        $messages = [];
        while ($row = $result->fetch_assoc()) {
            $messages[] = $row;
        }
        
        $messages = array_reverse($messages);
        
        $stmt->close();
        sendSuccess(['messages' => $messages]);
        break;
        
    case 'getUserByUsername':
        $username = isset($data['username']) ? sanitizeInput($data['username']) : '';
        
        if (empty($username)) {
            sendError('Username required');
        }
        
        $stmt = $conn->prepare("SELECT id, username, created_at, last_login FROM users WHERE username = ?");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("s", $username);
        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($result->num_rows === 0) {
            $stmt->close();
            sendError('User not found');
        }
        
        $user = $result->fetch_assoc();
        $stmt->close();
        sendSuccess(['user' => $user]);
        break;
        
    case 'getStreamHistory':
        $userId = isset($data['userId']) ? intval($data['userId']) : 0;
        $limit = isset($data['limit']) ? intval($data['limit']) : 20;
        
        if ($userId <= 0) {
            sendError('User ID required');
        }
        
        if ($limit > 100) {
            $limit = 100;
        }
        
        $stmt = $conn->prepare("SELECT room_id, title, started_at, ended_at, duration, peak_viewers FROM stream_history WHERE streamer_user_id = ? ORDER BY ended_at DESC LIMIT ?");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("ii", $userId, $limit);
        $stmt->execute();
        $result = $stmt->get_result();
        
        $history = [];
        while ($row = $result->fetch_assoc()) {
            $history[] = $row;
        }
        
        $stmt->close();
        sendSuccess(['history' => $history]);
        break;
        
    case 'deleteOldChatLogs':
        $daysToKeep = isset($data['days']) ? intval($data['days']) : 7;
        
        $stmt = $conn->prepare("DELETE FROM chat_logs WHERE timestamp < DATE_SUB(NOW(), INTERVAL ? DAY)");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("i", $daysToKeep);
        
        if ($stmt->execute()) {
            $deletedRows = $stmt->affected_rows;
            $stmt->close();
            sendSuccess(['message' => "Deleted $deletedRows old messages"]);
        } else {
            $stmt->close();
            sendError('Failed to delete old messages');
        }
        break;
        
    case 'getStreamStats':
        $roomId = isset($data['roomId']) ? sanitizeInput($data['roomId']) : '';
        
        if (empty($roomId)) {
            sendError('Room ID required');
        }
        
        $stmt = $conn->prepare("SELECT COUNT(*) as message_count FROM chat_logs WHERE room_id = ?");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("s", $roomId);
        $stmt->execute();
        $result = $stmt->get_result();
        $chatStats = $result->fetch_assoc();
        $stmt->close();
        
        $stmt = $conn->prepare("SELECT viewer_count, started_at FROM active_streams WHERE room_id = ?");
        if (!$stmt) {
            sendError('Database error');
        }
        
        $stmt->bind_param("s", $roomId);
        $stmt->execute();
        $result = $stmt->get_result();
        
        if ($result->num_rows > 0) {
            $streamData = $result->fetch_assoc();
            $uptime = time() - strtotime($streamData['started_at']);
            
            $stmt->close();
            sendSuccess([
                'stats' => [
                    'current_viewers' => $streamData['viewer_count'],
                    'total_messages' => $chatStats['message_count'],
                    'uptime_seconds' => $uptime
                ]
            ]);
        } else {
            $stmt->close();
            sendError('Stream not found');
        }
        break;
        
    default:
        sendError('Unknown action');
        break;
}

$conn->close();