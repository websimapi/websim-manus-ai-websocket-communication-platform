// Initialize WebSocket connection with configurable URL
let serverUrl = localStorage.getItem('serverUrl') || 'ws://localhost:8080';
let room;
let connectionStatus = 'disconnected';

// Function to connect to the WebSocket server
function connectToServer(url) {
    try {
        // Close existing connection if any
        if (room) {
            room.close();
        }
        
        // Update status to connecting
        connectionStatus = 'connecting';
        updateConnectionStatus();
        
        // Create new WebSocket connection
        room = new WebSocket(url);
        
        // Handle connection events
        room.onopen = () => {
            console.log('Connected to server');
            connectionStatus = 'connected';
            updateConnectionStatus();
        };
        
        room.onclose = () => {
            console.log('Disconnected from server');
            connectionStatus = 'disconnected';
            updateConnectionStatus();
            
            // Attempt to reconnect after 5 seconds
            setTimeout(() => {
                if (connectionStatus === 'disconnected') {
                    connectToServer(url);
                }
            }, 5000);
        };
        
        room.onerror = (error) => {
            console.error('WebSocket error:', error);
            connectionStatus = 'disconnected';
            updateConnectionStatus();
        };
        
        // Handle incoming messages
        room.onmessage = (event) => {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        };
    } catch (error) {
        console.error('Failed to connect to server:', error);
        connectionStatus = 'disconnected';
        updateConnectionStatus();
    }
}

// Function to update the connection status indicator
function updateConnectionStatus() {
    if (window.updateConnectionStatusUI) {
        window.updateConnectionStatusUI(connectionStatus);
    }
}

// Function to handle WebSocket messages
function handleWebSocketMessage(data) {
    // Pass message to React component via global function
    if (window.handleIncomingMessage) {
        window.handleIncomingMessage(data);
    }
}

// Function to send messages via WebSocket
function sendWebSocketMessage(message) {
    if (room && room.readyState === WebSocket.OPEN) {
        room.send(JSON.stringify(message));
        return true;
    }
    return false;
}

// Connect to the server on page load
connectToServer(serverUrl);

// Expose functions globally
window.connectToServer = connectToServer;
window.sendWebSocketMessage = sendWebSocketMessage;

// React Component for the Connection Settings
const ConnectionSettings = () => {
    const [showSettings, setShowSettings] = React.useState(false);
    const [url, setUrl] = React.useState(serverUrl);
    
    const handleSubmit = (e) => {
        e.preventDefault();
        localStorage.setItem('serverUrl', url);
        connectToServer(url);
        setShowSettings(false);
    };
    
    return (
        <div className="connection-settings">
            <div className="connection-status">
                <div className={`status-indicator ${connectionStatus}`}></div>
                <span>Server: {connectionStatus}</span>
                <button 
                    className="toggle-settings" 
                    onClick={() => setShowSettings(!showSettings)}
                >
                    {showSettings ? 'Hide Settings' : 'Configure'}
                </button>
            </div>
            
            {showSettings && (
                <div className="settings-panel">
                    <h3>Server Connection Settings</h3>
                    <form className="settings-form" onSubmit={handleSubmit}>
                        <input 
                            type="text" 
                            value={url} 
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="WebSocket URL (ws://hostname:port)"
                        />
                        <button type="submit">Connect</button>
                    </form>
                </div>
            )}
        </div>
    );
};

// React Component for the Chat Application
const ChatApp = () => {
    const [messages, setMessages] = React.useState([]);
    const [inputValue, setInputValue] = React.useState('');
    const messageListRef = React.useRef(null);
    const [peers, setPeers] = React.useState({});
    const [presence, setPresence] = React.useState({});
    
    // Store client ID and username
    const [clientInfo, setClientInfo] = React.useState({
        id: null,
        username: null
    });
    
    React.useEffect(() => {
        // Handle incoming messages
        window.handleIncomingMessage = (data) => {
            console.log('Received message:', data);
            
            switch(data.type) {
                case 'welcome':
                    setClientInfo({
                        id: data.clientId,
                        username: data.username
                    });
                    break;
                    
                case 'peers':
                    setPeers(data.peers);
                    break;
                    
                case 'presence':
                    setPresence(data.presence);
                    break;
                    
                case 'connected':
                case 'disconnected':
                    // Update peers on connection/disconnection events
                    setPeers(prevPeers => {
                        const newPeers = {...prevPeers};
                        
                        if (data.type === 'connected') {
                            newPeers[data.clientId] = { username: data.username };
                        } else if (data.type === 'disconnected') {
                            delete newPeers[data.clientId];
                        }
                        
                        return newPeers;
                    });
                    break;
                    
                case 'chat_message':
                    setMessages(prevMessages => [
                        ...prevMessages, 
                        {
                            id: Date.now(),
                            text: data.message,
                            sender: data.username,
                            senderId: data.clientId,
                            timestamp: new Date().toISOString()
                        }
                    ]);
                    break;
                
                default:
                    console.log('Unhandled message type:', data.type);
            }
        };
        
        // Update connection status UI
        window.updateConnectionStatusUI = (status) => {
            // This function is handled by the ConnectionSettings component
        };
        
        // Update typing indicator
        const updateTypingStatus = (isTyping) => {
            sendWebSocketMessage({
                type: 'update_presence',
                presence: {
                    typing: isTyping
                }
            });
        };
        
        return () => {
            // Cleanup
            window.handleIncomingMessage = null;
            window.updateConnectionStatusUI = null;
            updateTypingStatus(false);
        };
    }, []);
    
    // Scroll to bottom when messages change
    React.useEffect(() => {
        if (messageListRef.current) {
            messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
        }
    }, [messages]);
    
    // Handle message input changes
    const handleInputChange = (e) => {
        setInputValue(e.target.value);
        
        // Update typing status
        sendWebSocketMessage({
            type: 'update_presence',
            presence: {
                typing: e.target.value.length > 0
            }
        });
    };
    
    // Send a message
    const sendMessage = (e) => {
        e.preventDefault();
        
        if (inputValue.trim() === '') return;
        
        sendWebSocketMessage({
            type: 'chat_message',
            message: inputValue,
        });
        
        setInputValue('');
        sendWebSocketMessage({
            type: 'update_presence',
            presence: {
                typing: false
            }
        });
    };
    
    return (
        <div className="chat-app">
            <ConnectionSettings />
            
            <div className="user-list">
                <h3>Users Online ({Object.keys(peers).length})</h3>
                {Object.keys(peers).map(clientId => (
                    <div key={clientId} className="user-item">
                        <div className="user-status online"></div>
                        <img 
                            className="user-avatar" 
                            src={`https://images.websim.ai/avatar/${peers[clientId].username}`} 
                            alt={`${peers[clientId].username}'s avatar`} 
                        />
                        <span>
                            {peers[clientId].username} 
                            {presence[clientId]?.typing && <em> (typing...)</em>}
                            {clientId === clientInfo.id && " (you)"}
                        </span>
                    </div>
                ))}
            </div>
            
            <div className="chat-container">
                <div className="message-list" ref={messageListRef}>
                    {messages.map(msg => (
                        <div 
                            key={msg.id} 
                            className={`message ${msg.senderId === clientInfo.id ? 'sent' : 'received'}`}
                        >
                            <div className="message-sender">{msg.sender}</div>
                            <div className="message-text">{msg.text}</div>
                        </div>
                    ))}
                </div>
                
                <form className="message-form" onSubmit={sendMessage}>
                    <input 
                        type="text" 
                        className="message-input"
                        value={inputValue}
                        onChange={handleInputChange}
                        placeholder="Type a message..."
                    />
                    <button type="submit" className="send-button">Send</button>
                </form>
            </div>
        </div>
    );
};

// Render the React application
ReactDOM.render(<ChatApp />, document.getElementById('app'));