// ENHANCED DB.JS - AI-Powered Sentiment Analysis + Media Analysis (FULLY FIXED v3)
// Fixed thumbnail caching issue + improved GIF handling + GIF-to-MP4 conversion

const { Pool, types } = require('pg');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const fs = require('fs');
const path = require('path');

types.setTypeParser(types.builtins.INT8, v => parseInt(v, 10));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ── ENHANCED TABLE INITIALIZATION WITH MEDIA CACHE ───────────────────────────

const init = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS balances (
            user_id TEXT PRIMARY KEY,
            balance BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_preferences (
            user_id TEXT PRIMARY KEY,
            display_name TEXT,
            interaction_count INTEGER DEFAULT 0,
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            attitude_level TEXT DEFAULT 'neutral',
            sentiment_score DECIMAL(4,2) DEFAULT 0.00,
            recent_interactions JSONB DEFAULT '[]'::jsonb,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS conversation_memories (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            user_message TEXT,
            bot_response TEXT,
            sentiment_score DECIMAL(4,2),
            timestamp BIGINT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS speak_blacklist (
            user_id TEXT PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS settings (
            setting TEXT PRIMARY KEY,
            state BOOLEAN NOT NULL
        );
        CREATE TABLE IF NOT EXISTS media_cache (
            media_id TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            media_type TEXT NOT NULL,
            original_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            accessed_count INTEGER DEFAULT 1,
            last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_media_cache_accessed ON media_cache(last_accessed);
    `);

    // Insert default media analysis setting if not exists
    await pool.query(`
        INSERT INTO settings (setting, state)
        VALUES ('media_analysis_provider', true)
        ON CONFLICT DO NOTHING
    `);
};

// ── MEDIA ANALYSIS SYSTEM (FIXED FOR DISCORD CDN URLS) ────────────────────────

// FIXED: Generate unique identifier for media - handles thumbnails properly
function generateMediaId(url, contentHash = null, fileName = '', messageId = '', embedIndex = 0) {
    const crypto = require('crypto');

    // For thumbnails and embeds, include message context to avoid collisions
    let uniqueContent;
    if (fileName === 'thumbnail' || fileName.includes('embedded')) {
        uniqueContent = `${url}_${messageId}_${embedIndex}_${fileName}_${Date.now()}`;
    } else if (contentHash) {
        uniqueContent = contentHash;
    } else {
        uniqueContent = `${url}_${fileName}`;
    }

    return crypto.createHash('sha256').update(uniqueContent).digest('hex').substring(0, 16);
}

// Check if media is already cached
async function getCachedMediaDescription(mediaId) {
    const { rows } = await pool.query(
        'SELECT description, media_type FROM media_cache WHERE media_id = $1',
        [mediaId]
    );

    if (rows.length > 0) {
        await pool.query(`
            UPDATE media_cache
            SET accessed_count = accessed_count + 1, last_accessed = CURRENT_TIMESTAMP
            WHERE media_id = $1
        `, [mediaId]);

        return {
            description: rows[0].description,
            mediaType: rows[0].media_type,
            cached: true
        };
    }

    return null;
}

// Cache new media description (but skip for thumbnails to avoid issues)
async function cacheMediaDescription(mediaId, description, mediaType, originalUrl = null, fileName = '') {
    // Skip caching for thumbnails to prevent description mix-ups
    if (fileName === 'thumbnail' || fileName.includes('embedded')) {
        console.log('[MEDIA] Skipping cache for thumbnail/embedded media to prevent mix-ups');
        return;
    }

    await pool.query(`
        INSERT INTO media_cache (media_id, description, media_type, original_url)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (media_id) DO UPDATE SET
            description = EXCLUDED.description,
            accessed_count = media_cache.accessed_count + 1,
            last_accessed = CURRENT_TIMESTAMP
    `, [mediaId, description, mediaType, originalUrl]);
}

// FIXED: Download media from Discord CDN with proper headers
async function downloadDiscordMedia(mediaUrl) {
    try {
        console.log(`[MEDIA] Downloading Discord media: ${mediaUrl.substring(0, 80)}...`);
        const response = await fetch(mediaUrl, {
            headers: {
                'User-Agent': 'DiscordBot (https://github.com/discord/discord-api-docs, 1.0)',
                'Accept': '*/*',
            },
            timeout: 30000 // 30 second timeout
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > 25 * 1024 * 1024) { // 25MB limit
            throw new Error(`File too large: ${contentLength} bytes (max 25MB)`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        console.log(`[MEDIA] Successfully downloaded ${buffer.length} bytes`);
        return buffer;
    } catch (error) {
        console.error('[MEDIA] Discord media download failed:', error.message);
        throw new Error(`Failed to download Discord media: ${error.message}`);
    }
}

// NEW: Convert GIF to MP4 using ffmpeg (if available)
async function convertGifToMp4(gifBuffer, tempDir = '/storage') {
    try {
        const { spawn } = require('child_process');
        const tempGifPath = path.join(tempDir, `temp_gif_${Date.now()}.gif`);
        const tempMp4Path = path.join(tempDir, `temp_gif_${Date.now()}.mp4`);

        // Ensure temp directory exists
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // Write GIF to temp file
        fs.writeFileSync(tempGifPath, gifBuffer);

        return new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', [
                '-i', tempGifPath,
                '-movflags', 'faststart',
                '-pix_fmt', 'yuv420p',
                '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // Ensure even dimensions
                tempMp4Path
            ]);

            ffmpeg.on('close', (code) => {
                // Clean up temp GIF
                if (fs.existsSync(tempGifPath)) {
                    fs.unlinkSync(tempGifPath);
                }

                if (code === 0 && fs.existsSync(tempMp4Path)) {
                    const mp4Buffer = fs.readFileSync(tempMp4Path);
                    // Clean up temp MP4
                    fs.unlinkSync(tempMp4Path);
                    resolve(mp4Buffer);
                } else {
                    reject(new Error(`ffmpeg failed with code ${code}`));
                }
            });

            ffmpeg.on('error', (error) => {
                // Clean up temp files
                if (fs.existsSync(tempGifPath)) {
                    fs.unlinkSync(tempGifPath);
                }
                if (fs.existsSync(tempMp4Path)) {
                    fs.unlinkSync(tempMp4Path);
                }
                reject(error);
            });
        });

    } catch (error) {
        console.error('[MEDIA] GIF to MP4 conversion failed:', error.message);
        throw error;
    }
}

// Analyze media with AI - ENHANCED with GIF support and conversion
async function analyzeMediaWithAI(mediaUrl, mediaType, fileName = '', messageId = '') {
    const provider = await getMediaAnalysisProvider();
    if (provider === 'disabled') {
        console.log('[MEDIA] Analysis disabled by settings');
        return null;
    }

    console.log(`[MEDIA] Analyzing ${mediaType} with ${provider}: ${fileName}`);

    try {
        const isGif = mediaType.includes('gif') || fileName.toLowerCase().endsWith('.gif');

        if (provider === 'gemini') {
            // Enhanced GIF handling for Gemini
            if (isGif) {
                try {
                    // Try direct GIF analysis first
                    const result = await analyzeWithGemini(mediaUrl, mediaType, fileName);
                    if (result) return result;
                } catch (error) {
                    console.log('[MEDIA] Direct GIF analysis failed, attempting conversion...');

                    // Try converting GIF to MP4 for better analysis
                    try {
                        const gifBuffer = await downloadDiscordMedia(mediaUrl);
                        const mp4Buffer = await convertGifToMp4(gifBuffer);

                        // Create temporary MP4 file for analysis
                        const tempMp4Path = path.join('/storage', `temp_converted_${Date.now()}.mp4`);
                        fs.writeFileSync(tempMp4Path, mp4Buffer);

                        // Analyze MP4 version
                        const mp4Result = await analyzeWithGemini(`file://${tempMp4Path}`, 'video/mp4', fileName, true);

                        // Clean up temp file
                        if (fs.existsSync(tempMp4Path)) {
                            fs.unlinkSync(tempMp4Path);
                        }

                        return mp4Result;
                    } catch (conversionError) {
                        console.log('[MEDIA] GIF conversion failed:', conversionError.message);
                        // Fall back to thumbnail analysis
                        return `Animated GIF (${fileName}) - content analysis not available, conversion failed`;
                    }
                }
            } else {
                return await analyzeWithGemini(mediaUrl, mediaType, fileName);
            }
        } else if (provider === 'groq') {
            return await analyzeWithGroq(mediaUrl, mediaType, fileName);
        }

    } catch (error) {
        console.error(`[MEDIA] Analysis failed with ${provider}:`, error.message);

        // Enhanced fallback descriptions
        try {
            const fileNameLower = fileName.toLowerCase();
            if (fileNameLower.includes('gif') || mediaType.includes('gif')) {
                return `Animated GIF (${fileName || 'unknown'}) - content analysis not available`;
            } else if (fileNameLower.includes('image') || mediaType.startsWith('image/')) {
                return `Image file (${fileName || 'unknown'}) - content analysis unavailable`;
            } else if (fileNameLower.includes('video') || mediaType.startsWith('video/')) {
                return `Video file (${fileName || 'unknown'}) - content analysis unavailable`;
            } else if (fileNameLower.includes('audio') || mediaType.startsWith('audio/')) {
                return `Audio file (${fileName || 'unknown'}) - content analysis unavailable`;
            }

            return `Media file (${fileName || 'unknown'}) - content analysis unavailable`;
        } catch (fallbackError) {
            console.error('[MEDIA] Fallback description failed:', fallbackError.message);
            return null;
        }
    }

    return null;
}

// ENHANCED: Analyze with Google Gemini - improved GIF and video handling
async function analyzeWithGemini(mediaUrl, mediaType, fileName = '', isLocalFile = false) {
    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY not configured');
    }

    const isVideo = mediaType.includes('video') || fileName.match(/\.(mp4|mov|avi|webm|mkv)$/i);
    const isGif = mediaType.includes('gif') || fileName.match(/\.gif$/i);

    try {
        let mediaBuffer;
        let base64Data;

        if (isLocalFile && mediaUrl.startsWith('file://')) {
            // Handle local file
            const filePath = mediaUrl.replace('file://', '');
            mediaBuffer = fs.readFileSync(filePath);
        } else {
            // Download the media file
            mediaBuffer = await downloadDiscordMedia(mediaUrl);
        }

        base64Data = mediaBuffer.toString('base64');

        // Use current stable model name and correct API version
        const model = 'gemini-2.0-flash-exp'; // Updated to experimental model with better capabilities
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

        if (isVideo || isGif) {
            console.log(`[MEDIA] Gemini: Attempting ${isGif ? 'GIF' : 'video'} analysis with 2.0 Flash Experimental`);

            // Try direct video/GIF upload to Gemini
            const videoResponse = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            {
                                text: `Describe this ${isGif ? 'animated GIF' : 'video'} briefly in one or two sentences for conversation context. Focus on key visual elements, actions, people, objects, or scenes. Keep it concise and relevant. Go straight to the description without any preamble.`
                            },
                            {
                                inlineData: {
                                    mimeType: mediaType,
                                    data: base64Data
                                }
                            }
                        ]
                    }]
                }),
            });

            if (videoResponse.ok) {
                const videoData = await videoResponse.json();
                const description = videoData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (description) {
                    console.log(`[MEDIA] Gemini ${isGif ? 'GIF' : 'video'} analysis successful`);
                    return description;
                }
            } else {
                const errorText = await videoResponse.text();
                console.log(`[MEDIA] Gemini ${isGif ? 'GIF' : 'video'} analysis failed (${videoResponse.status}): ${errorText}`);
                // Try with fallback model if experimental fails
                return await tryGeminiFallback(mediaBuffer, mediaType, fileName, true);
            }

            // Final fallback for videos/GIFs
            return `${isGif ? 'Animated GIF' : 'Video'} file (${fileName}) - visual content analysis not available`;

        } else {
            // Handle images
            console.log('[MEDIA] Gemini: Analyzing image with 2.0 Flash Experimental');
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            {
                                text: `Describe this ${mediaType} briefly in one sentence for conversation context. Focus on key visual elements, people, objects, text, or actions. Keep it concise and relevant.`
                            },
                            {
                                inlineData: {
                                    mimeType: mediaType.includes('gif') ? 'image/gif' :
                                              mediaType.includes('png') ? 'image/png' : 'image/jpeg',
                                    data: base64Data
                                }
                            }
                        ]
                    }]
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('[MEDIA] Gemini API error:', errorText);
                // Try fallback model
                return await tryGeminiFallback(mediaBuffer, mediaType, fileName, false);
            }

            const data = await response.json();
            const description = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

            if (!description) {
                throw new Error('No description returned from Gemini');
            }

            return description;
        }

    } catch (error) {
        console.error('[MEDIA] Gemini analysis error:', error.message);
        throw error;
    }
}

// FIXED: Fallback function for Gemini with older model
async function tryGeminiFallback(mediaBuffer, mediaType, fileName, isVideo) {
    try {
        console.log('[MEDIA] Trying Gemini fallback with 2.5-flash');
        const base64Data = mediaBuffer.toString('base64');
        const fallbackModel = 'gemini-2.5-flash'; // Fallback to stable model
        const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/${fallbackModel}:generateContent?key=${GEMINI_API_KEY}`;

        if (isVideo) {
            // For videos, try once more then give up
            const videoResponse = await fetch(fallbackUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            {
                                text: `Describe this video briefly in one sentence for conversation context. Focus on key visual elements, actions, people, objects, or scenes. Keep it concise and relevant.`
                            },
                            {
                                inlineData: {
                                    mimeType: mediaType,
                                    data: base64Data
                                }
                            }
                        ]
                    }]
                }),
            });

            if (videoResponse.ok) {
                const videoData = await videoResponse.json();
                const description = videoData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (description) {
                    console.log('[MEDIA] Gemini video fallback successful');
                    return description;
                }
            }

            return `Video file (${fileName}) - content analysis not available`;
        }

        const response = await fetch(fallbackUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        {
                            text: `Describe this ${mediaType} briefly in one sentence for conversation context. Focus on key visual elements, people, objects, text, or actions. Keep it concise and relevant.`
                        },
                        {
                            inlineData: {
                                mimeType: mediaType.includes('gif') ? 'image/gif' :
                                          mediaType.includes('png') ? 'image/png' : 'image/jpeg',
                                data: base64Data
                            }
                        }
                    ]
                }]
            }),
        });

        if (response.ok) {
            const data = await response.json();
            const description = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (description) {
                console.log('[MEDIA] Gemini fallback successful');
                return description;
            }
        } else {
            const errorText = await response.text();
            console.error('[MEDIA] Gemini fallback also failed:', errorText);
        }

        throw new Error(`All Gemini models failed for ${fileName}`);
    } catch (error) {
        console.error('[MEDIA] Gemini fallback error:', error.message);
        throw new Error(`Gemini analysis completely failed: ${error.message}`);
    }
}

// FIXED: Analyze with Groq - proper Discord media handling
async function analyzeWithGroq(mediaUrl, mediaType, fileName = '') {
    if (!LANGUAGE_API_KEY) {
        throw new Error('LANGUAGE_API_KEY not configured');
    }

    const isVideo = mediaType.includes('video') || fileName.match(/\.(mp4|mov|avi|webm|mkv)$/i);
    const isGif = mediaType.includes('gif') || fileName.match(/\.gif$/i);

    if (isVideo || isGif) {
        console.log(`[MEDIA] Groq does not support ${isGif ? 'GIF' : 'video'} analysis, returning generic description`);
        return `${isGif ? 'Animated GIF' : 'Video'} file (${fileName}) - visual content analysis not available with current provider`;
    }

    try {
        // Download the media file first for Discord URLs
        const mediaBuffer = await downloadDiscordMedia(mediaUrl);
        const base64Data = mediaBuffer.toString('base64');
        const dataUri = `data:${mediaType};base64,${base64Data}`;

        console.log('[MEDIA] Groq: Analyzing image with correct model');
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'llama-3.2-11b-vision-preview', // CORRECT MODEL FOR VISION
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: `Describe this ${mediaType} briefly in one sentence for conversation context. Focus on key visual elements, people, objects, text, or actions. Keep it concise and relevant.`
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: dataUri
                            }
                        }
                    ]
                }],
                max_tokens: 100,
                temperature: 0.3,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[MEDIA] Groq API error:', errorText);
            throw new Error(`Groq API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const description = data.choices?.[0]?.message?.content?.trim();

        if (!description) {
            throw new Error('No description returned from Groq');
        }

        return description;
    } catch (error) {
        console.error('[MEDIA] Groq analysis error:', error.message);
        throw error;
    }
}

// Get media analysis provider setting
async function getMediaAnalysisProvider() {
    const { rows } = await pool.query(`
        SELECT setting FROM settings
        WHERE setting IN ('media_provider_gemini', 'media_provider_groq', 'media_provider_disabled')
        AND state = true
    `);

    if (rows.length === 0) {
        return 'gemini'; // default
    }

    const activeSetting = rows[0].setting;
    if (activeSetting === 'media_provider_gemini') return 'gemini';
    if (activeSetting === 'media_provider_groq') return 'groq';
    if (activeSetting === 'media_provider_disabled') return 'disabled';
    return 'gemini'; // fallback
}

// Set media analysis provider
async function setMediaAnalysisProvider(provider) {
    await pool.query(`
        DELETE FROM settings
        WHERE setting IN ('media_provider_gemini', 'media_provider_groq', 'media_provider_disabled')
    `);

    const settingName = `media_provider_${provider}`;
    await pool.query(`
        INSERT INTO settings (setting, state) VALUES ($1, true)
    `, [settingName]);
}

// ENHANCED: Process media from Discord message attachments/embeds with better error handling and unique IDs
async function processMediaInMessage(message) {
    const mediaDescriptions = [];
    const messageId = message.id || Date.now().toString(); // Ensure unique message ID

    try {
        // Process attachments
        if (message.attachments && message.attachments.size > 0) {
            console.log(`[MEDIA] Processing ${message.attachments.size} attachments`);
            let attachmentIndex = 0;

            for (const [, attachment] of message.attachments) {
                try {
                    console.log(`[MEDIA] Processing attachment: ${attachment.name} (${attachment.contentType})`);
                    const mediaInfo = await processMediaItem(
                        attachment.url,
                        attachment.name,
                        attachment.contentType || 'application/octet-stream',
                        messageId,
                        attachmentIndex
                    );

                    if (mediaInfo) {
                        mediaDescriptions.push(`[${attachment.name}: ${mediaInfo.description}]`);
                    }
                    attachmentIndex++;
                } catch (error) {
                    console.error(`[MEDIA] Failed to process attachment ${attachment.name}:`, error.message);
                    // Add generic description for failed attachments
                    mediaDescriptions.push(`[${attachment.name}: file attachment - analysis failed]`);
                }
            }
        }

        // Process embeds with images
        if (message.embeds && message.embeds.length > 0) {
            console.log(`[MEDIA] Processing ${message.embeds.length} embeds`);
            let embedIndex = 0;

            for (const embed of message.embeds) {
                try {
                    if (embed.image?.url) {
                        const mediaInfo = await processMediaItem(
                            embed.image.url, 
                            `embedded_image_${embedIndex}`, 
                            'image/jpeg',
                            messageId,
                            embedIndex
                        );
                        if (mediaInfo) {
                            mediaDescriptions.push(`[embedded image: ${mediaInfo.description}]`);
                        }
                    }

                    if (embed.thumbnail?.url) {
                        const mediaInfo = await processMediaItem(
                            embed.thumbnail.url, 
                            `thumbnail_${embedIndex}`, 
                            'image/jpeg',
                            messageId,
                            `thumb_${embedIndex}`
                        );
                        if (mediaInfo) {
                            mediaDescriptions.push(`[thumbnail: ${mediaInfo.description}]`);
                        }
                    }
                    embedIndex++;
                } catch (error) {
                    console.error(`[MEDIA] Failed to process embed media:`, error.message);
                    mediaDescriptions.push(`[embedded media: analysis failed]`);
                }
            }
        }

        // Process custom emojis in message content - FIXED REGEX
        if (message.content) {
            try {
                const customEmojiRegex = /<(a?):(\w+):(\d+)>/g;
                let match;
                let emojiIndex = 0;

                while ((match = customEmojiRegex.exec(message.content)) !== null) {
                    const emojiName = match[2];
                    const emojiId = match[3];
                    const isAnimated = match[1] === 'a';
                    const emojiUrl = `https://cdn.discordapp.com/emojis/${emojiId}.${isAnimated ? 'gif' : 'png'}`;

                    try {
                        const mediaInfo = await processMediaItem(
                            emojiUrl, 
                            `emoji_${emojiName}`, 
                            isAnimated ? 'image/gif' : 'image/png',
                            messageId,
                            `emoji_${emojiIndex}`
                        );
                        if (mediaInfo) {
                            mediaDescriptions.push(`[custom emoji ${emojiName}: ${mediaInfo.description}]`);
                        }
                        emojiIndex++;
                    } catch (error) {
                        console.error(`[MEDIA] Failed to process custom emoji ${emojiName}:`, error.message);
                        mediaDescriptions.push(`[custom emoji: ${emojiName}]`);
                    }
                }
            } catch (error) {
                console.error('[MEDIA] Error processing custom emojis:', error.message);
            }
        }

        // Process Discord stickers
        if (message.stickers && message.stickers.size > 0) {
            console.log(`[MEDIA] Processing ${message.stickers.size} stickers`);
            let stickerIndex = 0;

            for (const [, sticker] of message.stickers) {
                try {
                    const stickerUrl = sticker.url;
                    const mediaInfo = await processMediaItem(
                        stickerUrl, 
                        `sticker_${sticker.name}`, 
                        'image/png',
                        messageId,
                        `sticker_${stickerIndex}`
                    );
                    if (mediaInfo) {
                        mediaDescriptions.push(`[sticker ${sticker.name}: ${mediaInfo.description}]`);
                    }
                    stickerIndex++;
                } catch (error) {
                    console.error(`[MEDIA] Failed to process sticker ${sticker.name}:`, error.message);
                    mediaDescriptions.push(`[sticker: ${sticker.name}]`);
                }
            }
        }

    } catch (error) {
        console.error('[MEDIA] Error in processMediaInMessage:', error.message);
    }

    return mediaDescriptions;
}

// ENHANCED: Process individual media items with better error handling and unique caching
async function processMediaItem(url, fileName, contentType, messageId = '', uniqueId = 0) {
    try {
        const mediaId = generateMediaId(url, null, fileName, messageId, uniqueId);

        // Check cache first (but skip for thumbnails and embedded images)
        if (!fileName.includes('thumbnail') && !fileName.includes('embedded')) {
            const cachedResult = await getCachedMediaDescription(mediaId);
            if (cachedResult) {
                console.log(`[MEDIA] Using cached description for ${fileName}`);
                return cachedResult;
            }
        }

        // Filter out non-media content types
        if (!isMediaContentType(contentType)) {
            console.log(`[MEDIA] Skipping non-media content: ${contentType}`);
            return null;
        }

        // Analyze with AI
        const description = await analyzeMediaWithAI(url, contentType, fileName, messageId);

        if (description) {
            // Cache the successful result (but not for thumbnails)
            await cacheMediaDescription(mediaId, description, contentType, url, fileName);
            console.log(`[MEDIA] Successfully analyzed ${fileName}: ${description.substring(0, 100)}...`);
            return {
                description: description,
                mediaType: contentType,
                cached: false
            };
        }

        return null;
    } catch (error) {
        console.error(`[MEDIA] Error processing media item ${fileName}:`, error.message);
        return null;
    }
}

// Helper function to determine if content type is media
function isMediaContentType(contentType) {
    if (!contentType) return false;
    const mediaTypes = [
        'image/', 'video/', 'audio/',
        'application/octet-stream' // Discord sometimes uses this for media
    ];
    return mediaTypes.some(type => contentType.toLowerCase().startsWith(type));
}

// Clean up old media cache entries (call periodically)
async function cleanupMediaCache(olderThanDays = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const { rowCount } = await pool.query(`
        DELETE FROM media_cache
        WHERE last_accessed < $1
    `, [cutoffDate.toISOString()]);

    console.log(`[MEDIA] Cleaned up ${rowCount} old cache entries`);
    return rowCount;
}

// Rest of the functions remain unchanged from the original file...
// [AI SENTIMENT ANALYSIS, USER MANAGEMENT, etc. - keeping original implementations]

// ── AI SENTIMENT ANALYSIS WITH CONTEXT ───────────────────────────────────────
async function analyzeMessageSentiment(userMessage, conversationContext) {
    if (!LANGUAGE_API_KEY) {
        return simpleBackupSentiment(userMessage);
    }

    const prompt = `Context-aware sentiment analysis. Consider the user's message within the conversation context and behavioral patterns.

CONVERSATION CONTEXT:
${conversationContext.slice(-1000)}

ANALYZE THIS MESSAGE: "${userMessage}"

Rate sentiment from -1.0 (very negative) to 1.0 (very positive). Consider:
- Sarcasm detection (negative despite positive words)
- Pattern recognition (repeated behavior vs one-off)
- Context awareness (response to previous messages)
- Genuine vs performative emotions

Respond in this exact JSON format:
{"sentiment": [number], "confidence": [0-1], "reasoning": "[brief explanation]"}

Examples:
"fuck you" → {"sentiment": -0.9, "confidence": 0.95, "reasoning": "Direct insult"}
"omg you're the best!" after being hostile → {"sentiment": -0.2, "confidence": 0.6, "reasoning": "Overly positive after hostility, likely insincere"}
"thanks, that actually helped" → {"sentiment": 0.6, "confidence": 0.8, "reasoning": "Genuine appreciation with substance"}
"you always suck" → {"sentiment": -0.8, "confidence": 0.9, "reasoning": "Pattern of consistent negativity"}`;

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a contextual sentiment analyzer that detects behavioral patterns. Always respond with valid JSON only.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                max_tokens: 120,
                temperature: 0.1,
                stop: null,
            }),
        });

        if (!response.ok) {
            console.error('Sentiment analysis API error:', await response.text());
            return simpleBackupSentiment(userMessage);
        }

        const data = await response.json();
        const rawResponse = data.choices?.[0]?.message?.content?.trim();

        try {
            // Clean up the response
            let jsonString = rawResponse;
            if (!jsonString.endsWith('}')) {
                jsonString += '}';
            }
            if (jsonString.includes('```json')) {
                jsonString = jsonString.replace(/```json|```/gm, '');
            }

            const firstBrace = jsonString.indexOf('{');
            if (firstBrace > 0) {
                jsonString = jsonString.substring(firstBrace);
            }

            const lastBrace = jsonString.lastIndexOf('}');
            if (lastBrace !== -1 && lastBrace < jsonString.length - 1) {
                jsonString = jsonString.substring(0, lastBrace + 1);
            }

            const sentimentData = JSON.parse(jsonString);

            if (typeof sentimentData.sentiment === 'number' && 
                sentimentData.sentiment >= -1 && sentimentData.sentiment <= 1) {
                return {
                    sentiment: sentimentData.sentiment,
                    confidence: sentimentData.confidence || 0.7,
                    reasoning: sentimentData.reasoning || 'AI analysis'
                };
            } else {
                throw new Error('Invalid sentiment data structure');
            }
        } catch (parseError) {
            console.error('Error parsing sentiment response:', parseError);
            const fallbackSentiment = extractSentimentFromText(rawResponse, userMessage);
            if (fallbackSentiment) return fallbackSentiment;
            return simpleBackupSentiment(userMessage);
        }
    } catch (error) {
        console.error('Sentiment analysis failed:', error);
        return simpleBackupSentiment(userMessage);
    }
}

// Try to extract sentiment from malformed AI response
function extractSentimentFromText(text, originalMessage) {
    try {
        const lowerText = text.toLowerCase();

        const sentimentMatch = text.match(/"sentiment"?:\s*(-?\d*.?\d*)/i);
        if (sentimentMatch) {
            const sentiment = parseFloat(sentimentMatch[1]);
            if (sentiment >= -1 && sentiment <= 1) {
                return {
                    sentiment: sentiment,
                    confidence: 0.5,
                    reasoning: 'Extracted from malformed response'
                };
            }
        }

        if (lowerText.includes('positive') || lowerText.includes('friendly') || lowerText.includes('affectionate')) {
            return { sentiment: 0.4, confidence: 0.6, reasoning: 'Positive indicators found' };
        }
        if (lowerText.includes('negative') || lowerText.includes('hostile') || lowerText.includes('rude')) {
            return { sentiment: -0.4, confidence: 0.6, reasoning: 'Negative indicators found' };
        }
        if (lowerText.includes('neutral') || lowerText.includes('casual')) {
            return { sentiment: 0.0, confidence: 0.6, reasoning: 'Neutral indicators found' };
        }

        return null;
    } catch (error) {
        return null;
    }
}

// Simple backup sentiment analysis function
function simpleBackupSentiment(message) {
    const text = message.toLowerCase();
    let sentiment = 0;

    const strongNegative = ['fuck', 'shit', 'stupid', 'hate', 'terrible', 'awful', 'garbage', 'useless', 'pathetic'];
    const negative = ['bad', 'sucks', 'annoying', 'boring', 'whatever', 'dumb'];
    const positive = ['thanks', 'thank you', 'great', 'awesome', 'cool', 'nice', 'good', 'love', 'amazing'];
    const strongPositive = ['incredible', 'fantastic', 'perfect', 'brilliant', 'excellent'];
    const affectionate = ['mwah', 'xoxo', 'heart', 'love', 'cutie', 'sweetie'];

    strongNegative.forEach(word => {
        if (text.includes(word)) sentiment -= 0.4;
    });
    negative.forEach(word => {
        if (text.includes(word)) sentiment -= 0.2;
    });
    positive.forEach(word => {
        if (text.includes(word)) sentiment += 0.3;
    });
    strongPositive.forEach(word => {
        if (text.includes(word)) sentiment += 0.5;
    });
    affectionate.forEach(word => {
        if (text.includes(word)) sentiment += 0.4;
    });

    if (text.includes('?')) sentiment += 0.1;

    sentiment = Math.max(-1, Math.min(1, sentiment));

    return {
        sentiment,
        confidence: 0.6,
        reasoning: 'Backup keyword analysis'
    };
}

// ── ALL OTHER EXISTING FUNCTIONS (unchanged) ─────────────────────────────────

// Balance management functions
async function getBalance(userId) {
    const { rows } = await pool.query('SELECT balance FROM balances WHERE user_id = $1', [userId]);
    if (rows.length) return rows[0].balance;

    const seed = 10000;
    await pool.query('INSERT INTO balances (user_id, balance) VALUES ($1, $2)', [userId, seed]);
    return seed;
}

async function updateBalance(userId, newBalance) {
    await pool.query(`
        INSERT INTO balances (user_id, balance) VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance
    `, [userId, newBalance]);
}

async function getTopBalances(limit = 10) {
    const { rows } = await pool.query('SELECT user_id, balance FROM balances ORDER BY balance DESC LIMIT $1', [limit]);
    return rows;
}

// Blacklist management
async function isUserBlacklisted(userId) {
    const { rows } = await pool.query('SELECT 1 FROM speak_blacklist WHERE user_id = $1', [userId]);
    return rows.length > 0;
}

async function addUserToBlacklist(userId) {
    await pool.query('INSERT INTO speak_blacklist (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
}

async function removeUserFromBlacklist(userId) {
    await pool.query('DELETE FROM speak_blacklist WHERE user_id = $1', [userId]);
}

// Settings management
async function getSettingState(key) {
    const { rows } = await pool.query('SELECT state FROM settings WHERE setting = $1', [key]);
    return rows.length > 0 ? rows[0].state : null;
}

// User context and preferences
async function getUserContext(userId) {
    const { rows } = await pool.query('SELECT * FROM user_preferences WHERE user_id = $1', [userId]);

    if (rows.length === 0) {
        return {
            isNewUser: true,
            attitudeLevel: 'neutral',
            interactionCount: 0,
            sentimentScore: 0,
            recentInteractions: []
        };
    }

    return {
        isNewUser: false,
        attitudeLevel: rows[0].attitude_level,
        interactionCount: rows[0].interaction_count,
        displayName: rows[0].display_name,
        lastSeen: rows[0].last_seen,
        sentimentScore: parseFloat(rows[0].sentiment_score) || 0,
        recentInteractions: rows[0].recent_interactions
    };
}

async function updateUserPreferences(userId, interaction) {
    const displayName = interaction?.member?.displayName || interaction?.user?.username || 'unknown';

    await pool.query(`
        INSERT INTO user_preferences (user_id, display_name, interaction_count)
        VALUES ($1, $2, 1)
        ON CONFLICT (user_id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            interaction_count = user_preferences.interaction_count + 1,
            last_seen = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
    `, [userId, displayName]);
}

async function updateUserAttitudeWithAI(userId, userMessage, conversationContext) {
    const sentimentAnalysis = await analyzeMessageSentiment(userMessage, conversationContext);
    const userContext = await getUserContext(userId);

    const recentInteractions = userContext.recentInteractions;
    recentInteractions.push({
        timestamp: Date.now(),
        sentiment: sentimentAnalysis.sentiment,
        confidence: sentimentAnalysis.confidence,
        message: userMessage.substring(0, 50) + (userMessage.length > 50 ? '...' : '')
    });

    if (recentInteractions.length > 10) {
        recentInteractions.splice(0, recentInteractions.length - 10);
    }

    const weights = recentInteractions.map((_, index) => Math.pow(1.2, index));
    const weightedSum = recentInteractions.reduce((sum, interaction, index) => 
        sum + (interaction.sentiment * weights[index]), 0);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const newSentimentScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

    let newAttitude = 'neutral';
    const count = userContext.interactionCount + 1;

    if (newSentimentScore < -0.4) {
        newAttitude = 'hostile';
    } else if (newSentimentScore < -0.2) {
        newAttitude = 'cautious';
    } else if (newSentimentScore > 0.4 && count > 50) {
        newAttitude = 'familiar';
    } else if (newSentimentScore > 0.2 && count > 10) {
        newAttitude = 'friendly';
    } else if (newSentimentScore > 0.1) {
        newAttitude = 'neutral';
    }

    await pool.query(`
        UPDATE user_preferences SET
            attitude_level = $2,
            sentiment_score = $3,
            recent_interactions = $4,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
    `, [userId, newAttitude, newSentimentScore, JSON.stringify(recentInteractions)]);

    console.log(`User ${userId} sentiment: ${sentimentAnalysis.sentiment.toFixed(2)} -> avg: ${newSentimentScore.toFixed(2)} -> attitude: ${newAttitude}`);

    return {
        sentiment: sentimentAnalysis.sentiment,
        newAverage: newSentimentScore,
        newAttitude,
        reasoning: sentimentAnalysis.reasoning
    };
}

// Conversation memory management
async function storeConversationMemory(userId, channelId, userMessage, botResponse, sentimentScore) {
    await pool.query(`
        INSERT INTO conversation_memories (user_id, channel_id, user_message, bot_response, sentiment_score, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6)
    `, [userId, channelId, userMessage, botResponse, sentimentScore, Date.now()]);

    // Keep only the last 20 memories per user
    await pool.query(`
        DELETE FROM conversation_memories 
        WHERE user_id = $1 
        AND id NOT IN (
            SELECT id FROM conversation_memories 
            WHERE user_id = $1 
            ORDER BY timestamp DESC 
            LIMIT 20
        )
    `, [userId]);
}

async function getRecentMemories(userId, limit = 5) {
    const { rows } = await pool.query(`
        SELECT user_message, bot_response, sentiment_score, timestamp
        FROM conversation_memories
        WHERE user_id = $1
        ORDER BY timestamp DESC
        LIMIT $2
    `, [userId, limit]);

    return rows.reverse(); // Return in chronological order
}

// EXPORTS
module.exports = {
    // Database
    pool,
    init,

    // Balance functions
    getBalance,
    updateBalance,
    getTopBalances,

    // Blacklist functions
    isUserBlacklisted,
    addUserToBlacklist,
    removeUserFromBlacklist,

    // Settings
    getSettingState,

    // User management
    getUserContext,
    updateUserPreferences,
    updateUserAttitudeWithAI,
    analyzeMessageSentiment,

    // Conversation memory
    storeConversationMemory,
    getRecentMemories,

    // Media analysis functions (ENHANCED)
    processMediaInMessage,
    getCachedMediaDescription,
    cacheMediaDescription,
    analyzeMediaWithAI,
    getMediaAnalysisProvider,
    setMediaAnalysisProvider,
    cleanupMediaCache,
    convertGifToMp4, // NEW: GIF to MP4 conversion

    // Helper functions
    generateMediaId,
    downloadDiscordMedia,
    processMediaItem,
    isMediaContentType
};