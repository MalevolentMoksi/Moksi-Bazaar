
// Enhanced PostgreSQL database utilities for Discord bot memory system
// Add these functions to your existing db.js file

// Memory storage for conversations
async function storeConversationMemory(userId, channelId, memoryData) {
    // Create tables if they don't exist
    await pool.query(`
        CREATE TABLE IF NOT EXISTS conversation_memories (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            user_message TEXT,
            bot_response TEXT,
            timestamp BIGINT NOT NULL,
            context TEXT,
            summary TEXT,
            relevance_score DECIMAL(3,2) DEFAULT 0.5,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_conversation_memories_user_channel 
        ON conversation_memories(user_id, channel_id);

        CREATE INDEX IF NOT EXISTS idx_conversation_memories_timestamp 
        ON conversation_memories(timestamp);
    `);

    const summary = `${memoryData.userMessage} -> ${memoryData.botResponse}`.slice(0, 200);
    const relevanceScore = calculateRelevanceScore(memoryData);

    await pool.query(`
        INSERT INTO conversation_memories 
        (user_id, channel_id, user_message, bot_response, timestamp, context, summary, relevance_score)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
        userId,
        channelId,
        memoryData.userMessage,
        memoryData.botResponse,
        memoryData.timestamp,
        memoryData.context,
        summary,
        relevanceScore
    ]);

    // Clean up old memories (keep last 100 per user/channel combo)
    await cleanupOldMemories(userId, channelId);
}

// Retrieve relevant memories based on context and recency
async function getRelevantMemories(userId, channelId, limit = 5) {
    const { rows } = await pool.query(`
        SELECT summary, timestamp, relevance_score, context
        FROM conversation_memories
        WHERE (user_id = $1 AND channel_id = $2) 
           OR (user_id = $1)
           OR (channel_id = $2)
        ORDER BY 
            CASE 
                WHEN user_id = $1 AND channel_id = $2 THEN 3
                WHEN user_id = $1 THEN 2
                ELSE 1
            END DESC,
            timestamp DESC,
            relevance_score DESC
        LIMIT $3
    `, [userId, channelId, limit * 2]);

    // Process memories to add time context
    const now = Date.now();
    const processedMemories = rows.map(memory => {
        const elapsed = now - parseInt(memory.timestamp);
        const timeAgo = formatTimeAgo(elapsed);

        return {
            summary: memory.summary,
            timeAgo: timeAgo,
            relevanceScore: parseFloat(memory.relevance_score),
            context: memory.context
        };
    });

    // Return the most relevant memories
    return processedMemories
        .filter(memory => memory.relevanceScore > 0.3)
        .slice(0, limit);
}

// Enhanced user preference tracking
async function updateUserPreferences(userId, interaction) {
    // Create table if it doesn't exist
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_preferences (
            user_id TEXT PRIMARY KEY,
            display_name TEXT,
            interaction_count INTEGER DEFAULT 0,
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            channels TEXT[],
            recent_topics TEXT[],
            preferred_style TEXT DEFAULT 'neutral',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    const displayName = interaction.member?.displayName || interaction.user.username;
    const channelId = interaction.channel.id;
    const topics = extractTopics(interaction.options.getString('request'));

    await pool.query(`
        INSERT INTO user_preferences (user_id, display_name, interaction_count, channels, recent_topics)
        VALUES ($1, $2, 1, ARRAY[$3], $4)
        ON CONFLICT (user_id) 
        DO UPDATE SET
            display_name = EXCLUDED.display_name,
            interaction_count = user_preferences.interaction_count + 1,
            last_seen = CURRENT_TIMESTAMP,
            channels = array_remove(array_append(user_preferences.channels, $3), NULL),
            recent_topics = array_remove(array_append(user_preferences.recent_topics, $4), NULL),
            updated_at = CURRENT_TIMESTAMP
    `, [userId, displayName, channelId, topics]);
}

// Get user interaction history for personalization
async function getUserContext(userId) {
    const { rows } = await pool.query(`
        SELECT * FROM user_preferences WHERE user_id = $1
    `, [userId]);

    if (rows.length === 0) {
        return {
            isNewUser: true,
            interactionCount: 0,
            preferredStyle: 'neutral',
            recentTopics: []
        };
    }

    const userPrefs = rows[0];
    return {
        isNewUser: false,
        interactionCount: userPrefs.interaction_count,
        preferredStyle: determinePreferredStyle(userPrefs),
        recentTopics: userPrefs.recent_topics?.slice(-5) || [],
        lastSeen: userPrefs.last_seen
    };
}

// Helper functions
function calculateRelevanceScore(memoryData) {
    let score = 0.5; // Base score

    // Boost score for longer, more meaningful interactions
    if (memoryData.userMessage.length > 50) score += 0.2;
    if (memoryData.botResponse.length > 30) score += 0.2;

    // Boost for certain contexts
    if (memoryData.context === 'speak_command') score += 0.1;

    // Boost for questions or meaningful content
    if (memoryData.userMessage.includes('?')) score += 0.1;
    if (memoryData.userMessage.includes('how') || 
        memoryData.userMessage.includes('what') || 
        memoryData.userMessage.includes('why')) {
        score += 0.2;
    }

    return Math.min(score, 1.0);
}

function formatTimeAgo(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    return 'just now';
}

function extractTopics(message) {
    if (!message) return [];

    // Simple topic extraction - can be enhanced with NLP
    const topics = [];
    const words = message.toLowerCase().split(/\s+/);

    // Look for meaningful words (longer than 3 characters, not common words)
    const commonWords = ['the', 'and', 'but', 'for', 'are', 'with', 'you', 'this', 'that', 'can', 'what', 'how', 'why'];
    const meaningfulWords = words.filter(word => 
        word.length > 3 && 
        !commonWords.includes(word) &&
        !/^[0-9]+$/.test(word)
    );

    return meaningfulWords.slice(0, 3); // Keep top 3 topics
}

function determinePreferredStyle(userPrefs) {
    // Simple heuristic to determine user's preferred interaction style
    if (userPrefs.interaction_count > 20) return 'familiar';
    if (userPrefs.interaction_count > 5) return 'friendly';
    return 'neutral';
}

async function cleanupOldMemories(userId, channelId) {
    // Keep only the most recent 100 memories per user/channel combination
    await pool.query(`
        DELETE FROM conversation_memories 
        WHERE user_id = $1 AND channel_id = $2 
        AND id NOT IN (
            SELECT id FROM conversation_memories 
            WHERE user_id = $1 AND channel_id = $2 
            ORDER BY timestamp DESC 
            LIMIT 100
        )
    `, [userId, channelId]);
}

// Add these to your existing module.exports
module.exports = {
    // ... existing functions ...
    pool,
    init,
    getBalance,
    getTopBalances,
    updateBalance,
    isUserBlacklisted,
    addUserToBlacklist,
    removeUserFromBlacklist,
    getSettingState,
    // New memory functions
    storeConversationMemory,
    getRelevantMemories,
    updateUserPreferences,
    getUserContext
};
