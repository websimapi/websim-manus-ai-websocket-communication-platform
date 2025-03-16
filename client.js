document.addEventListener('DOMContentLoaded', function() {
    // Handle the download button click
    const downloadBtn = document.getElementById('downloadBtn');
    
    downloadBtn.addEventListener('click', async function() {
        try {
            // Load JSZip from CDN
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
            document.head.appendChild(script);
            
            // Wait for the script to load
            await new Promise((resolve, reject) => {
                script.onload = resolve;
                script.onerror = reject;
            });
            
            // Create a new zip instance
            const zip = new JSZip();
            
            // Create the server files
            const serverFiles = {
                'package.json': JSON.stringify({
                    "name": "manus-websocket-server",
                    "version": "1.0.0",
                    "description": "Node.js WebSocket server for Manus AI",
                    "main": "server.js",
                    "scripts": {
                        "start": "node server.js"
                    },
                    "dependencies": {
                        "express": "^4.18.2",
                        "ws": "^8.14.2",
                        "cors": "^2.8.5",
                        "uuid": "^9.0.1"
                    },
                    "engines": {
                        "node": ">=14.0.0"
                    },
                    "author": "Manus AI",
                    "license": "MIT"
                }, null, 2),
                
                'server.js': `const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// Configuration
const PORT = process.env.PORT || 8080;
const STORAGE_DIR = path.join(__dirname, 'data');

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected clients
const clients = new Map();
// Store presence data
const presenceData = new Map();
// Store collections
const collections = new Map();

// Load existing collections from disk
const loadCollections = () => {
    try {
        const collectionDirs = fs.readdirSync(STORAGE_DIR);
        
        collectionDirs.forEach(dir => {
            const collectionPath = path.join(STORAGE_DIR, dir);
            if (fs.statSync(collectionPath).isDirectory()) {
                const collectionData = new Map();
                const files = fs.readdirSync(collectionPath);
                
                files.forEach(file => {
                    if (file.endsWith('.json')) {
                        const recordPath = path.join(collectionPath, file);
                        const recordId = path.basename(file, '.json');
                        const recordData = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
                        collectionData.set(recordId, recordData);
                    }
                });
                
                collections.set(dir, collectionData);
                console.log(\`Loaded collection: \${dir} with \${collectionData.size} records\`);
            }
        });
    } catch (error) {
        console.error('Error loading collections:', error);
    }
};

// Save a record to disk
const saveRecord = (collection, id, data) => {
    try {
        const collectionDir = path.join(STORAGE_DIR, collection);
        if (!fs.existsSync(collectionDir)) {
            fs.mkdirSync(collectionDir, { recursive: true });
        }
        
        const recordPath = path.join(collectionDir, \`\${id}.json\`);
        fs.writeFileSync(recordPath, JSON.stringify(data));
    } catch (error) {
        console.error(\`Error saving record \${id} to collection \${collection}:\`, error);
    }
};

// Delete a record from disk
const deleteRecord = (collection, id) => {
    try {
        const recordPath = path.join(STORAGE_DIR, collection, \`\${id}.json\`);
        if (fs.existsSync(recordPath)) {
            fs.unlinkSync(recordPath);
        }
    } catch (error) {
        console.error(\`Error deleting record \${id} from collection \${collection}:\`, error);
    }
};

// Initialize server by loading existing data
loadCollections();

// Handle WebSocket connections
wss.on('connection', (ws) => {
    // Generate a unique ID for this client
    const clientId = uuidv4();
    let username = \`user_\${clientId.substring(0, 6)}\`;
    
    // Store the client connection
    clients.set(clientId, {
        ws,
        username,
        connectTime: new Date()
    });
    
    // Initialize presence for this client
    presenceData.set(clientId, {});
    
    console.log(\`Client connected: \${clientId} (\${username})\`);
    
    // Send initial connection message to the client
    ws.send(JSON.stringify({
        type: 'welcome',
        clientId,
        username
    }));
    
    // Broadcast new user to all clients
    broadcastToAll({
        type: 'connected',
        clientId,
        username
    });
    
    // Send current peers to the new client
    const peersData = {};
    clients.forEach((client, id) => {
        peersData[id] = { 
            username: client.username 
        };
    });
    
    ws.send(JSON.stringify({
        type: 'peers',
        peers: peersData
    }));
    
    // Send current presence to the new client
    const presencePayload = {};
    presenceData.forEach((data, id) => {
        presencePayload[id] = data;
    });
    
    ws.send(JSON.stringify({
        type: 'presence',
        presence: presencePayload
    }));
    
    // Handle incoming messages
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // Handle different message types
            switch (data.type) {
                case 'update_username':
                    if (data.username && typeof data.username === 'string') {
                        const oldUsername = clients.get(clientId).username;
                        clients.get(clientId).username = data.username;
                        username = data.username;
                        
                        // Notify all clients about the username change
                        broadcastToAll({
                            type: 'username_changed',
                            clientId,
                            oldUsername,
                            newUsername: username
                        });
                    }
                    break;
                    
                case 'update_presence':
                    if (data.presence && typeof data.presence === 'object') {
                        // Update presence for this client
                        presenceData.set(clientId, {
                            ...presenceData.get(clientId),
                            ...data.presence
                        });
                        
                        // Broadcast the updated presence
                        broadcastPresence();
                    }
                    break;
                    
                case 'collection_create':
                    handleCollectionCreate(clientId, data);
                    break;
                    
                case 'collection_update':
                    handleCollectionUpdate(clientId, data);
                    break;
                    
                case 'collection_delete':
                    handleCollectionDelete(clientId, data);
                    break;
                    
                case 'collection_get':
                    handleCollectionGet(clientId, data);
                    break;
                    
                case 'collection_list':
                    handleCollectionList(clientId, data);
                    break;
                    
                default:
                    // Forward the message to all clients, adding sender info
                    const messageToForward = {
                        ...data,
                        clientId,
                        username
                    };
                    
                    // Check if the message should echo back to sender
                    if (data.echo === false) {
                        broadcastToOthers(clientId, messageToForward);
                    } else {
                        broadcastToAll(messageToForward);
                    }
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });
    
    // Handle disconnection
    ws.on('close', () => {
        console.log(\`Client disconnected: \${clientId} (\${username})\`);
        
        // Remove client data
        clients.delete(clientId);
        presenceData.delete(clientId);
        
        // Notify all clients about the disconnection
        broadcastToAll({
            type: 'disconnected',
            clientId,
            username
        });
        
        // Update presence data for all clients
        broadcastPresence();
    });
});

// Collection handlers
function handleCollectionCreate(clientId, data) {
    if (!data.collection || !data.data) return;
    
    const { collection, data: recordData } = data;
    const client = clients.get(clientId);
    
    if (!client) return;
    
    // Initialize collection if it doesn't exist
    if (!collections.has(collection)) {
        collections.set(collection, new Map());
    }
    
    // Generate record ID and add metadata
    const recordId = uuidv4();
    const record = {
        ...recordData,
        id: recordId,
        username: client.username,
        created_at: new Date().toISOString()
    };
    
    // Store the record
    collections.get(collection).set(recordId, record);
    
    // Save to disk
    saveRecord(collection, recordId, record);
    
    // Send response to the client
    client.ws.send(JSON.stringify({
        type: 'collection_created',
        collection,
        record
    }));
    
    // Notify all clients about the new record
    broadcastToAll({
        type: 'collection_updated',
        collection,
        action: 'create',
        record
    });
}

function handleCollectionUpdate(clientId, data) {
    if (!data.collection || !data.id || !data.data) return;
    
    const { collection, id, data: updateData } = data;
    const client = clients.get(clientId);
    
    if (!client) return;
    
    // Check if collection and record exist
    if (!collections.has(collection) || !collections.get(collection).has(id)) {
        client.ws.send(JSON.stringify({
            type: 'error',
            message: \`Record \${id} not found in collection \${collection}\`
        }));
        return;
    }
    
    // Get existing record
    const existingRecord = collections.get(collection).get(id);
    
    // Check permissions (only creator can update)
    if (existingRecord.username !== client.username) {
        client.ws.send(JSON.stringify({
            type: 'error',
            message: 'Permission denied: You can only update your own records'
        }));
        return;
    }
    
    // Update the record
    const updatedRecord = {
        ...existingRecord,
        ...updateData,
        id, // Ensure ID remains the same
        username: existingRecord.username, // Ensure username remains the same
        created_at: existingRecord.created_at, // Ensure creation time remains the same
        updated_at: new Date().toISOString()
    };
    
    // Store the updated record
    collections.get(collection).set(id, updatedRecord);
    
    // Save to disk
    saveRecord(collection, id, updatedRecord);
    
    // Send response to the client
    client.ws.send(JSON.stringify({
        type: 'collection_updated',
        collection,
        record: updatedRecord
    }));
    
    // Notify all clients about the updated record
    broadcastToAll({
        type: 'collection_updated',
        collection,
        action: 'update',
        record: updatedRecord
    });
}

function handleCollectionDelete(clientId, data) {
    if (!data.collection || !data.id) return;
    
    const { collection, id } = data;
    const client = clients.get(clientId);
    
    if (!client) return;
    
    // Check if collection and record exist
    if (!collections.has(collection) || !collections.get(collection).has(id)) {
        client.ws.send(JSON.stringify({
            type: 'error',
            message: \`Record \${id} not found in collection \${collection}\`
        }));
        return;
    }
    
    // Get existing record
    const existingRecord = collections.get(collection).get(id);
    
    // Check permissions (only creator can delete)
    if (existingRecord.username !== client.username) {
        client.ws.send(JSON.stringify({
            type: 'error',
            message: 'Permission denied: You can only delete your own records'
        }));
        return;
    }
    
    // Delete the record
    collections.get(collection).delete(id);
    
    // Delete from disk
    deleteRecord(collection, id);
    
    // Send response to the client
    client.ws.send(JSON.stringify({
        type: 'collection_deleted',
        collection,
        id
    }));
    
    // Notify all clients about the deleted record
    broadcastToAll({
        type: 'collection_updated',
        collection,
        action: 'delete',
        id
    });
}

function handleCollectionGet(clientId, data) {
    if (!data.collection || !data.id) return;
    
    const { collection, id } = data;
    const client = clients.get(clientId);
    
    if (!client) return;
    
    // Check if collection and record exist
    if (!collections.has(collection) || !collections.get(collection).has(id)) {
        client.ws.send(JSON.stringify({
            type: 'error',
            message: \`Record \${id} not found in collection \${collection}\`
        }));
        return;
    }
    
    // Get the record
    const record = collections.get(collection).get(id);
    
    // Send the record to the client
    client.ws.send(JSON.stringify({
        type: 'collection_record',
        collection,
        record
    }));
}

function handleCollectionList(clientId, data) {
    if (!data.collection) return;
    
    const { collection, filter } = data;
    const client = clients.get(clientId);
    
    if (!client) return;
    
    // Initialize empty list if collection doesn't exist
    if (!collections.has(collection)) {
        client.ws.send(JSON.stringify({
            type: 'collection_list',
            collection,
            records: []
        }));
        return;
    }
    
    // Get all records in the collection
    let records = Array.from(collections.get(collection).values());
    
    // Apply filter if provided
    if (filter && typeof filter === 'object') {
        records = records.filter(record => {
            for (const key in filter) {
                if (record[key] !== filter[key]) {
                    return false;
                }
            }
            return true;
        });
    }
    
    // Sort by created_at (newest first)
    records.sort((a, b) => {
        return new Date(b.created_at) - new Date(a.created_at);
    });
    
    // Send the records to the client
    client.ws.send(JSON.stringify({
        type: 'collection_list',
        collection,
        records
    }));
}

// Utility functions
function broadcastToAll(message) {
    const messageStr = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
        }
    });
}

function broadcastToOthers(excludeClientId, message) {
    const messageStr = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client !== clients.get(excludeClientId)?.ws && client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
        }
    });
}

function broadcastPresence() {
    const presencePayload = {};
    presenceData.forEach((data, id) => {
        presencePayload[id] = data;
    });
    
    broadcastToAll({
        type: 'presence',
        presence: presencePayload
    });
}

// API endpoints
app.get('/status', (req, res) => {
    res.json({
        status: 'running',
        clients: clients.size,
        collections: Array.from(collections.keys())
    });
});

// Start the server
server.listen(PORT, () => {
    console.log(\`Manus WebSocket Server running on port \${PORT}\`);
    console.log(\`Data stored in: \${STORAGE_DIR}\`);
});
`,
            
            'README.md': `# Manus WebSocket Server

A Node.js WebSocket server for real-time communication, designed for Linux environments.

## Features

- Real-time WebSocket communication
- User presence tracking
- Persistent data collections
- Event broadcasting
- Username management

## Requirements

- Node.js 14 or higher
- npm

## Installation

1. Unzip the downloaded files to a directory
2. Navigate to the directory in your terminal
3. Install dependencies:

\`\`\`bash
npm install
\`\`\`

## Usage

Start the server:

\`\`\`bash
npm start
\`\`\`

By default, the server runs on port 8080. You can change this by setting the PORT environment variable:

\`\`\`bash
PORT=3000 npm start
\`\`\`

## API Endpoints

- \`GET /status\`: Get server status information

## WebSocket Protocol

### Connection

When a client connects, the server sends a welcome message with a client ID and default username:

\`\`\`json
{
  "type": "welcome",
  "clientId": "unique-id",
  "username": "user_xxxxxx"
}
\`\`\`

### Client Messages

Clients can send various message types:

#### Update Username

\`\`\`json
{
  "type": "update_username",
  "username": "new_username"
}
\`\`\`

#### Update Presence

\`\`\`json
{
  "type": "update_presence",
  "presence": {
    "typing": true,
    "status": "online"
  }
}
\`\`\`

#### Collection Operations

Create a record:
\`\`\`json
{
  "type": "collection_create",
  "collection": "messages",
  "data": {
    "text": "Hello, world!",
    "parent_id": null
  }
}
\`\`\`

Update a record:
\`\`\`json
{
  "type": "collection_update",
  "collection": "messages",
  "id": "record-id",
  "data": {
    "text": "Updated message"
  }
}
\`\`\`

Delete a record:
\`\`\`json
{
  "type": "collection_delete",
  "collection": "messages",
  "id": "record-id"
}
\`\`\`

Get a record:
\`\`\`json
{
  "type": "collection_get",
  "collection": "messages",
  "id": "record-id"
}
\`\`\`

List records:
\`\`\`json
{
  "type": "collection_list",
  "collection": "messages",
  "filter": {
    "parent_id": null
  }
}
\`\`\`

#### Custom Messages

Any other message type will be broadcasted to all clients:

\`\`\`json
{
  "type": "chat_message",
  "message": "Hello, everyone!",
  "echo": true
}
\`\`\`

Set \`echo: false\` to prevent the message from being sent back to the sender.

### Server Messages

The server broadcasts various events to clients:

#### User Connection/Disconnection

\`\`\`json
{
  "type": "connected",
  "clientId": "unique-id",
  "username": "username"
}
\`\`\`

\`\`\`json
{
  "type": "disconnected",
  "clientId": "unique-id",
  "username": "username"
}
\`\`\`

#### Presence Updates

\`\`\`json
{
  "type": "presence",
  "presence": {
    "client-id-1": {
      "typing": true,
      "status": "online"
    },
    "client-id-2": {
      "typing": false,
      "status": "away"
    }
  }
}
\`\`\`

#### Collection Updates

\`\`\`json
{
  "type": "collection_updated",
  "collection": "messages",
  "action": "create",
  "record": {
    "id": "record-id",
    "text": "Hello, world!",
    "username": "creator",
    "created_at": "2023-05-01T12:00:00Z"
  }
}
\`\`\`

## Data Persistence

All collection data is persisted to the \`data\` directory and loaded on server startup.

## Credits

Based on [WebSim Multiplayer](https://gist.github.com/jlia0/db0a9695b3ca7609c9b1a08dcbf872c9)

## License

MIT
`,
            
            'public/index.html': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Manus WebSocket Server - Status</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            background-color: #f5f7fa;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }
        
        header {
            text-align: center;
            margin-bottom: 40px;
            padding: 20px;
            background: linear-gradient(135deg, #6a11cb 0%, #2575fc 100%);
            color: white;
            border-radius: 10px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        
        h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
        }
        
        .status-container {
            background-color: white;
            border-radius: 10px;
            padding: 20px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            margin-bottom: 30px;
        }
        
        .status-box {
            margin-top: 20px;
            padding: 15px;
            background-color: #f0f4f8;
            border-radius: 8px;
        }
        
        .status-item {
            margin-bottom: 10px;
            padding-bottom: 10px;
            border-bottom: 1px solid #ddd;
        }
        
        .status-item:last-child {
            border-bottom: none;
        }
        
        .status-label {
            font-weight: bold;
            display: inline-block;
            min-width: 150px;
        }
    </style>
</head>
<body>
    <header>
        <h1>Manus WebSocket Server</h1>
        <p>Real-time communication platform</p>
    </header>

    <main>
        <div class="status-container">
            <h2>Server Status</h2>
            <div class="status-box" id="statusBox">
                <div class="status-item">
                    <span class="status-label">Status:</span>
                    <span id="serverStatus">Loading...</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Connected Clients:</span>
                    <span id="clientCount">Loading...</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Collections:</span>
                    <span id="collectionsList">Loading...</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Last Updated:</span>
                    <span id="lastUpdated">Loading...</span>
                </div>
            </div>
        </div>
    </main>

    <script>
        // Function to fetch and display server status
        function updateStatus() {
            fetch('/status')
                .then(response => response.json())
                .then(data => {
                    document.getElementById('serverStatus').textContent = data.status;
                    document.getElementById('clientCount').textContent = data.clients;
                    document.getElementById('collectionsList').textContent = 
                        data.collections.length > 0 ? data.collections.join(', ') : 'No collections';
                    document.getElementById('lastUpdated').textContent = new Date().toLocaleString();
                })
                .catch(error => {
                    console.error('Error fetching status:', error);
                    document.getElementById('serverStatus').textContent = 'Error connecting to server';
                });
        }
        
        // Update status immediately and then every 5 seconds
        updateStatus();
        setInterval(updateStatus, 5000);
    </script>
</body>
</html>`
            };
            
            // Add files to the ZIP
            for (const [filename, content] of Object.entries(serverFiles)) {
                // Handle nested directories
                if (filename.includes('/')) {
                    const parts = filename.split('/');
                    const file = parts.pop();
                    let folder = zip;
                    
                    // Create nested folders as needed
                    for (const part of parts) {
                        folder = folder.folder(part);
                    }
                    
                    folder.file(file, content);
                } else {
                    zip.file(filename, content);
                }
            }
            
            // Generate ZIP file
            const blob = await zip.generateAsync({type: 'blob'});
            
            // Create download link
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'manus-websocket-server.zip';
            
            // Trigger download
            document.body.appendChild(link);
            link.click();
            
            // Clean up
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Error creating ZIP file:', error);
            alert('Failed to create ZIP file. Please check console for details.');
        }
    });
    
});