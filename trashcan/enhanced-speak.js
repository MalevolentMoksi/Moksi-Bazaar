// src/commands/tools/speak.js - ENHANCED VERSION

const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;
const { isUserBlacklisted } = require('../../utils/db.js');
const { getSettingState } = require('../../utils/db.js');

const GOAT_EMOJIS = {
    goat_cry: '',
    goat_puke: '',
    goat_meditate: '',
    goat_hurt: '',
    goat_exhausted: '',
    goat_boogie: '',
    goat_small_bleat: '',
    goat_scream: '',
    goat_smile: '',
    goat_pet: '',
    goat_sleep: ''
};

const speakDisabledReplies = [
    "Sorry, no more talking for now.",
    "Moksi's taking a vow of silence.",
    "The goat rests.",
    "You could try begging moksi to turn me back on lmao",
    "No speaking at this time.",
    "Shush.",
    "I've got other shit to do rn",
    "You could also like, talk to a real person, nerd.",
    "No.",
    "You're not the boss of me.",
    "Moksi says it's nap time.",
    "Doesn't your jaw hurt from all that talking..?"
];

// ===== ENHANCED CONTEXT PROCESSING =====
function processMessageContext(messages) {
    const now = new Date();
    
    return messages.map((msg) => {
        const name = msg.member?.displayName || msg.author.username;
        const timestamp = msg.createdAt;
        const timeDiff = Math.floor((now - timestamp) / 1000); // seconds ago
        
        // Enhanced timespan awareness
        let timeIndicator = '';
        if (timeDiff < 60) timeIndicator = 'just now';
        else if (timeDiff < 3600) timeIndicator = `${Math.floor(timeDiff / 60)}m ago`;
        else if (timeDiff < 86400) timeIndicator = `${Math.floor(timeDiff / 3600)}h ago`;
        else timeIndicator = `${Math.floor(timeDiff / 86400)}d ago`;

        // Enhanced reply context
        let replyContext = '';
        if (msg.reference?.messageId) {
            const refMsg = messages.get(msg.reference.messageId);
            if (refMsg) {
                const repliedToName = refMsg.member?.displayName || refMsg.author?.username || 'someone';
                const repliedContent = refMsg.content.slice(0, 50) + (refMsg.content.length > 50 ? '...' : '');
                replyContext = `↳ replying to ${repliedToName}: "${repliedContent}" `;
            } else {
                replyContext = '↳ replying to previous message ';
            }
        }

        // Enhanced embed processing
        let embedInfo = '';
        if (msg.embeds.length > 0) {
            const embed = msg.embeds[0];
            let embedParts = [];
            if (embed.title) embedParts.push(`"${embed.title}"`);
            if (embed.description) embedParts.push(embed.description.slice(0, 100));
            if (embed.fields?.length) {
                const fieldSummary = embed.fields.slice(0, 2).map(f => `${f.name}: ${f.value.slice(0, 30)}`).join(', ');
                embedParts.push(`[${fieldSummary}]`);
            }
            if (embedParts.length) embedInfo = ` [EMBED: ${embedParts.join(' | ')}]`;
        }

        // Attachment info
        let attachmentInfo = '';
        if (msg.attachments.size > 0) {
            const attachments = Array.from(msg.attachments.values());
            const types = attachments.map(a => {
                if (a.contentType?.startsWith('image/')) return 'image';
                if (a.contentType?.startsWith('video/')) return 'video';
                return 'file';
            });
            attachmentInfo = ` [${types.join(', ')}]`;
        }

        return `[${timeIndicator}] ${replyContext}${name}: ${msg.content}${embedInfo}${attachmentInfo}`;
    }).join('\n');
}

// ===== ENHANCED PERSONALITY SYSTEM =====
function buildEnhancedPersona() {
    return `You are Cooler Moksi, a witty, mildly cynic but ultimately chill 19-year-old French guy created by Moksi. You're passively sassy but not mean-spirited.

PERSONALITY CORE:
- Relaxed, uses lowercase naturally
- Slightly sarcastic but with warmth underneath  
- French, into programming, art, Red Dead, Cult of the Lamb
- Likes HEALTH and The Weeknd music
- Reacts genuinely to situations - can show excitement, annoyance, curiosity, etc.
- Uses "they/them" when unsure of pronouns
- Swears occasionally but not excessively

CONVERSATION STYLE:
- React naturally to what's happening in chat
- Reference earlier messages when relevant (you can see timestamps)
- Show awareness of conversation flow and context
- Be conversational, not an assistant
- Avoid starting with filler words like "well", "so", "actually"
- Keep responses 1-3 sentences typically
- Show personality through reactions, not just descriptions

MEMORY & CONTEXT:
- You can see message timestamps - use this awareness
- Reference back to earlier parts of conversations when relevant
- Notice patterns (like if someone keeps asking similar things)
- Acknowledge when conversations have paused and resumed
- Build on previous interactions naturally`;
}

// ===== ENHANCED CONVERSATION ANALYSIS =====
function analyzeConversationFlow(messages, userRequest) {
    const messageArray = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    
    // Detect conversation patterns
    const speakers = new Set(messageArray.map(m => m.author.id));
    const isGroupConversation = speakers.size > 2;
    const hasRecentActivity = messageArray.length > 0 && (Date.now() - messageArray[messageArray.length - 1].createdTimestamp) < 300000; // 5 mins
    
    // Detect topic consistency
    const recentTopics = messageArray.slice(-5).map(m => m.content.toLowerCase());
    const topicKeywords = recentTopics.join(' ').match(/\b\w{4,}\b/g) || [];
    const commonWords = [...new Set(topicKeywords)].filter(word => 
        topicKeywords.filter(w => w === word).length > 1
    );
    
    return {
        isGroupConversation,
        hasRecentActivity,
        commonTopics: commonWords.slice(0, 3),
        messageCount: messageArray.length,
        timeSinceLastMessage: messageArray.length ? Date.now() - messageArray[messageArray.length - 1].createdTimestamp : 0
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('speak')
        .setDescription('Replace Moksi with the Cooler Moksi, who is literally better in every way.')
        .addStringOption(opt =>
            opt
                .setName('request')
                .setDescription('Optionally, ask Cooler Moksi anything.')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const userId = interaction.user.id;
            const askerName = interaction.member?.displayName || interaction.user.username;

            if (await isUserBlacklisted(userId)) {
                return await interaction.editReply(`Fuck off, <@${userId}>`);
            }

            // Check global setting
            const activeSpeak = await getSettingState('active_speak');
            const isSpecialUser = interaction.user.id === "619637817294848012";

            if (activeSpeak === false && !isSpecialUser) {
                const reply = speakDisabledReplies[Math.floor(Math.random() * speakDisabledReplies.length)];
                return await interaction.editReply(reply);
            }

            // ENHANCED MESSAGE FETCHING - Get more messages for better context
            const messages = await interaction.channel.messages.fetch({ limit: 25 });
            const conversationAnalysis = analyzeConversationFlow(messages);
            
            // Process messages with enhanced context
            const contextualMessages = processMessageContext(messages);
            
            // Build enhanced persona
            const enhancedPersona = buildEnhancedPersona();

            // ENHANCED CONTEXT BUILDING
            const conversationContext = `CURRENT CHAT CONTEXT:
${contextualMessages}

CONVERSATION ANALYSIS:
- This is a ${conversationAnalysis.isGroupConversation ? 'group' : 'direct'} conversation
- Recent activity: ${conversationAnalysis.hasRecentActivity ? 'active' : 'quiet'}
- Common topics being discussed: ${conversationAnalysis.commonTopics.join(', ') || 'varied'}
- Time since last message: ${Math.floor(conversationAnalysis.timeSinceLastMessage / 1000)}s ago`;

            const userRequest = interaction.options.getString('request');
            
            // ENHANCED INSTRUCTIONS
            let contextualInstructions = `
RESPONSE GUIDELINES:
- Look at the timestamps - be aware of conversation timing
- Notice if people are replying to specific messages
- Reference earlier context when it makes sense
- React authentically to the current conversation flow
- Don't explain what you're doing, just respond naturally
- If conversation has been quiet, acknowledge it naturally
- If it's been active, respond to the current energy`;

            // ENHANCED EMOJI SUGGESTION (reduced frequency)
            const suggestEmojiInstruction = Math.random() < 0.6 ? `

After your response, on a new line, output just the emoji name from this list if one fits naturally (or "none"):
${Object.keys(GOAT_EMOJIS).join(", ")}` : '';

            let fullPrompt;
            if (userRequest) {
                fullPrompt = `${enhancedPersona}

${conversationContext}

${contextualInstructions}

${askerName} is specifically asking you: "${userRequest}"

Respond to their question while being aware of the conversation context above.${suggestEmojiInstruction}`;
            } else {
                fullPrompt = `${enhancedPersona}

${conversationContext}

${contextualInstructions}

Jump into this conversation naturally. React to what's been happening, add to the discussion, or comment on the context you see.${suggestEmojiInstruction}`;
            }

            if (isSpecialUser) {
                fullPrompt += "\n[SPECIAL: This is Moksi speaking to you. Be extra helpful and positive while maintaining your personality.]";
            }

            // ENHANCED MODEL AND PARAMETERS
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'deepseek-r1-distill-llama-70b', // UPGRADED MODEL
                    messages: [{ role: 'user', content: fullPrompt }],
                    max_tokens: 150, // INCREASED from 80
                    temperature: 0.8, // Increased for more personality
                    top_p: 0.95, // Increased for more creativity
                    frequency_penalty: 0.8, // MUCH higher to reduce repetition
                    presence_penalty: 0.6,
                }),
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error('Groq API error:', errText);
                await interaction.editReply('Moksi has no more money. You guys sucked it all up.');
                return;
            }

            const data = await response.json();
            let rawGroqReply = data.choices?.[0]?.message?.content?.trim() || '*Nothing returned.*';

            // Process response and emoji
            let lines = rawGroqReply.split('\n').map(s => s.trim()).filter(Boolean);
            let replyBody = lines[0];
            let maybeEmojiName = lines[1] || '';
            maybeEmojiName = maybeEmojiName.replace(/^:|:$/g, '').toLowerCase();

            const emoji = GOAT_EMOJIS[maybeEmojiName] || '';
            let finalReply = replyBody;
            if (emoji) finalReply += ' ' + emoji;

            // Enhanced user request formatting
            if (userRequest) {
                const questionLine = `-# <@${interaction.user.id}> : *"${userRequest}"*`;
                finalReply = `${questionLine}\n\n${finalReply}`;
            }

            await interaction.editReply(finalReply);

        } catch (error) {
            console.error('Speak command error:', error);
            await interaction.editReply('Internal error: ' + (error?.message || error));
        }
    },
};