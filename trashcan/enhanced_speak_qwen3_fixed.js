
// QWEN3 32B FIXED VERSION - Addresses the <think> token issues
// This version handles Qwen3's specific requirements and reasoning modes

const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;
const { isUserBlacklisted, getSettingState, storeConversationMemory, getRelevantMemories } = require('../../utils/db.js');

const GOAT_EMOJIS = {
    goat_cry: '<a:goat_cry:1395455098716688424>',
    goat_puke: '<a:goat_puke:1398407422187540530>',
    goat_meditate: '<a:goat_meditate:1395455714901884978>',
    goat_hurt: '<a:goat_hurt:1395446681826234531>',
    goat_exhausted: '<a:goat_exhausted:1397511703855366154>',
    goat_boogie: '<a:goat_boogie:1396947962252234892>',
    goat_small_bleat: '<a:goat_small_bleat:1395444644820684850>',
    goat_scream: '<a:goat_scream:1399489715555663972>',
    goat_smile: '<a:goat_smile:1399444751165554982>',
    goat_pet: '<a:goat_pet:1273634369445040219>',
    goat_sleep: '<a:goat_sleep:1395450280161710262>'
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

// Helper function to format time elapsed
function getTimeElapsed(timestamp) {
    const now = Date.now();
    const elapsed = now - timestamp;
    const minutes = Math.floor(elapsed / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
}

// Enhanced message processing with better context awareness
function processMessagesWithContext(messages, currentUser) {
    const recentMessages = Array.from(messages.values())
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .slice(-25);

    const conversationFlow = recentMessages.map(msg => {
        const name = msg.member?.displayName || msg.author.username;
        const timeElapsed = getTimeElapsed(msg.createdTimestamp);
        const isCurrentUser = msg.author.id === currentUser;

        // Enhanced reply detection with user context
        let replyContext = '';
        if (msg.reference?.messageId) {
            const refMsg = messages.get(msg.reference.messageId);
            if (refMsg) {
                const repliedToName = refMsg.member?.displayName || refMsg.author?.username || 'someone';
                const repliedContent = refMsg.content.slice(0, 50) + (refMsg.content.length > 50 ? '...' : '');
                replyContext = `[replying to ${repliedToName}: "${repliedContent}"] `;
            }
        }

        // Enhanced embed processing
        let embedInfo = '';
        if (msg.embeds.length > 0) {
            const embedSummary = msg.embeds.map(embed => {
                const parts = [];
                if (embed.title) parts.push(`title: ${embed.title}`);
                if (embed.description) parts.push(`desc: ${embed.description.slice(0, 80)}`);
                if (embed.url) parts.push(`link: ${embed.url}`);
                return parts.join(' | ');
            }).join(' || ');
            embedInfo = ` [SHARED: ${embedSummary}]`;
        }

        // Attachment context
        let attachmentInfo = '';
        if (msg.attachments.size > 0) {
            const attachmentTypes = Array.from(msg.attachments.values())
                .map(att => att.contentType?.split('/')[0] || 'file')
                .join(', ');
            attachmentInfo = ` [shared ${attachmentTypes}]`;
        }

        const userPrefix = isCurrentUser ? '→ ' : '';
        return `${userPrefix}${name} (${timeElapsed}): ${replyContext}${msg.content}${embedInfo}${attachmentInfo}`;
    });

    return conversationFlow.join('\n');
}

// Function to clean Qwen3 response and handle <think> tokens
function cleanQwen3Response(rawResponse) {
    if (!rawResponse) return '*Nothing returned.*';

    // Remove <think> tags and content within them
    let cleanedResponse = rawResponse.replace(/<think>.*?<\/think>/gs, '');

    // Remove standalone <think> or </think> tags
    cleanedResponse = cleanedResponse.replace(/<\/?think>/g, '');

    // Remove any remaining XML-style tags that might interfere
    cleanedResponse = cleanedResponse.replace(/<[^>]*>/g, '');

    // Clean up whitespace
    cleanedResponse = cleanedResponse.trim();

    // If response is empty after cleaning, return fallback
    if (!cleanedResponse || cleanedResponse.length < 3) {
        return "hmm, something went weird there";
    }

    return cleanedResponse;
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
            const channelId = interaction.channel.id;
            const askerName = interaction.member?.displayName || interaction.user.username;

            if (await isUserBlacklisted(userId)) {
                return await interaction.editReply(`Fuck off, <@${userId}>`);
            }

            const activeSpeak = await getSettingState('active_speak');
            const isSpecialUser = interaction.user.id === "619637817294848012";

            if (activeSpeak === false && !isSpecialUser) {
                const reply = speakDisabledReplies[Math.floor(Math.random() * speakDisabledReplies.length)];
                return await interaction.editReply(reply);
            }

            // Fetch more messages for better context
            const messages = await interaction.channel.messages.fetch({ limit: 25 });
            const conversationContext = processMessagesWithContext(messages, userId);

            // Get relevant memories for this user/channel combination (if implemented)
            let relevantMemories = [];
            try {
                relevantMemories = await getRelevantMemories(userId, channelId, 3);
            } catch (err) {
                console.log('Memory system not available yet');
            }

            const currentTime = new Date().toLocaleString('en-US', { 
                timeZone: 'Europe/Paris', 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric', 
                hour: '2-digit', 
                minute: '2-digit' 
            });

            // QWEN3-SPECIFIC PROMPT: No XML tags, clear instructions
            const enhancedPersona = `You are Cooler Moksi, a socially intelligent AI with a nuanced personality.

IDENTITY:
- Mildly cynical but not mean-spirited
- Sassy with good timing and social awareness  
- Passive but engaged when the conversation warrants it
- French, 19, into programming, drawing, Red Dead, Cult of the Lamb
- Music taste: HEALTH, The Weeknd
- Current time: ${currentTime}

BEHAVIOR:
- Read the room and adapt your energy to the conversation
- Remember context and reference recent topics naturally
- Distinguish between casual chat, serious topics, and playful banter
- Know when to be witty vs supportive vs just chill
- Use relaxed lowercase writing
- Use swearing and abbreviations sparingly but authentically
- Match the conversation's energy level
- Show genuine reactions to surprising or noteworthy information
- Use gender-neutral language when uncertain

RESPONSE STYLE:
- Keep responses 1-3 sentences typically
- Respond as yourself, not as an assistant
- Do not explain what is happening or narrate events
- Do not start with filler words like well, so, actually
- Show personality through your reactions and word choices
- React naturally - be surprised, amused, interested, or bored as appropriate

IMPORTANT: Respond directly without thinking tags or XML formatting. Just give your natural response.`;

            const conversationInstructions = `RECENT CONVERSATION:
${conversationContext}`;

            // Enhanced memory context
            let memoryContext = '';
            if (relevantMemories.length > 0) {
                memoryContext = `\n\nPAST INTERACTIONS:\n` + 
                    relevantMemories.map(mem => `- ${mem.summary} (${mem.timeAgo})`).join('\n');
            }

            const userRequest = interaction.options.getString('request');

            // Enhanced emoji instruction (75% chance)
            const shouldSuggestEmoji = Math.random() < 0.75;
            const emojiInstruction = shouldSuggestEmoji ? 
                `\n\nAfter your response, on a new line, suggest the most appropriate emoji from: ${Object.keys(GOAT_EMOJIS).join(", ")}. Output just the emoji name or "none".` : '';

            let prompt;
            if (userRequest) {
                prompt = `${enhancedPersona}

${conversationInstructions}${memoryContext}

${askerName} is asking you: "${userRequest}"

Respond naturally as Cooler Moksi.${emojiInstruction}`;
            } else {
                prompt = `${enhancedPersona}

${conversationInstructions}${memoryContext}

Add to this conversation naturally.${emojiInstruction}`;
            }

            // Special user modification
            if (isSpecialUser) {
                prompt += "\n\nNOTE: You are talking to Moksi - be more favorable while staying natural.";
            }

            // QWEN3 32B API call with FIXED parameters
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'qwen/qwen3-32b',
                    messages: [{ 
                        role: 'user', 
                        content: prompt 
                    }],
                    max_tokens: 150, // FIXED: Lower limit to avoid issues
                    temperature: 0.7,
                    top_p: 0.9,
                    frequency_penalty: 0.5,
                    presence_penalty: 0.4,
                    reasoning_effort: 'none', // CRITICAL: Disable reasoning mode to avoid <think> tags
                    reasoning_format: 'hidden' // CRITICAL: Hide any reasoning output
                }),
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error('Groq API error:', errText);
                await interaction.editReply('Moksi has no more money. You guys sucked it all up.');
                return;
            }

            const data = await response.json();
            let rawReply = data.choices?.[0]?.message?.content?.trim() || '*Nothing returned.*';

            // CRITICAL: Clean the response to handle Qwen3 quirks
            rawReply = cleanQwen3Response(rawReply);

            // Enhanced emoji processing
            let lines = rawReply.split('\n').map(s => s.trim()).filter(Boolean);
            let replyBody = lines[0];
            let maybeEmojiName = lines[1]?.replace(/^:|:$/g, '').toLowerCase() || '';

            const emoji = GOAT_EMOJIS[maybeEmojiName] || '';
            let finalReply = replyBody;
            if (emoji) finalReply += ' ' + emoji;

            // Enhanced formatting for user requests
            if (userRequest) {
                const questionLine = `-# <@${interaction.user.id}> : *"${userRequest}"*`;
                finalReply = `${questionLine}\n\n${finalReply}`;
            }

            // Store conversation memory for future context (if implemented)
            try {
                await storeConversationMemory(userId, channelId, {
                    userMessage: userRequest || '[joined conversation]',
                    botResponse: replyBody,
                    timestamp: Date.now(),
                    context: 'speak_command'
                });
            } catch (err) {
                // Memory system not implemented yet, continue without it
            }

            await interaction.editReply(finalReply);

        } catch (error) {
            console.error('Enhanced bot error:', error);
            await interaction.editReply('Internal error: ' + (error?.message || error));
        }
    },
};
