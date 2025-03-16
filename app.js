// Initialize WebSocket connection
const room = new WebsimSocket();

// React Component for the Chat Application
const ChatApp = () => {
    const [messages, setMessages] = React.useState([]);
    const [inputValue, setInputValue] = React.useState('');
    const messageListRef = React.useRef(null);
    
    // Get current peers from WebsimSocket
    const peers = React.useSyncExternalStore(
        room.party.subscribe,
        () => room.party.peers
    );
    
    // Get current presence data
    const presence = React.useSyncExternalStore(
        room.party.subscribePresence,
        () => room.party.presence
    );
    
    React.useEffect(() => {
        // Handle incoming messages
        room.onmessage = (event) => {
            const data = event.data;
            
            if (data.type === 'chat_message') {
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
            }
        };
        
        // Update typing indicator
        const updateTypingStatus = (isTyping) => {
            room.party.updatePresence({
                typing: isTyping
            });
        };
        
        return () => {
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
        room.party.updatePresence({
            typing: e.target.value.length > 0
        });
    };
    
    // Send a message
    const sendMessage = (e) => {
        e.preventDefault();
        
        if (inputValue.trim() === '') return;
        
        room.send({
            type: 'chat_message',
            message: inputValue,
        });
        
        setInputValue('');
        room.party.updatePresence({
            typing: false
        });
    };
    
    return (
        <div className="chat-app">
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
                            {clientId === room.party.client.id && " (you)"}
                        </span>
                    </div>
                ))}
            </div>
            
            <div className="chat-container">
                <div className="message-list" ref={messageListRef}>
                    {messages.map(msg => (
                        <div 
                            key={msg.id} 
                            className={`message ${msg.senderId === room.party.client.id ? 'sent' : 'received'}`}
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

