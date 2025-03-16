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
                console.log(`Loaded collection: ${dir} with ${collectionData.size} records`);
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
        
        const recordPath = path.join(collectionDir, `${id}.json`);
        fs.writeFileSync(recordPath, JSON.stringify(data));
    } catch (error) {
        console.error(`Error saving record ${id} to collection ${collection}:`, error);
    }
};

// Delete a record from disk
const deleteRecord = (collection, id) => {
    try {
        const recordPath = path.join(STORAGE_DIR, collection, `${id}.json`);
        if (fs.existsSync(recordPath)) {
            fs.unlinkSync(recordPath);
        }
    } catch (error) {
        console.error(`Error deleting record ${id} from collection ${collection}:`, error);
    }
};

// Initialize server by loading existing data
loadCollections();

// Handle WebSocket connections
wss.on('connection', (ws) => {
    // Generate a unique ID for this client
    const clientId = uuidv4();
    let username = `user_${clientId.substring(0, 6)}`;
    
    // Store the client connection
    clients.set(clientId, {
        ws,
        username,
        connectTime: new Date()
    });
    
    // Initialize presence for this client
    presenceData.set(clientId, {});
    
    console.log(`Client connected: ${clientId} (${username})`);
    
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
        console.log(`Client disconnected: ${clientId} (${username})`);
        
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
            message: `Record ${id} not found in collection ${collection}`
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
            message: `Record ${id} not found in collection ${collection}`
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
            message: `Record ${id} not found in collection ${collection}`
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
    console.log(`Manus WebSocket Server running on port ${PORT}`);
    console.log(`Data stored in: ${STORAGE_DIR}`);
});