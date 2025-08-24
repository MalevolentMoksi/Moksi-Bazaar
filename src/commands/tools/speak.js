
// Enhanced Discord Bot Code - LLAMA 4 SCOUT VERSION
// Uses llama-4-scout which is proven working and has massive context window

const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;
const { isUserBlacklisted, getSettingState, storeConversationMemory, getRelevantMemories, updateNegativeBehavior, decayNegativeScore, analyzeHostileBehavior, getUserContext } = require('../../utils/db.js');


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
        .slice(-30); // Even more context with Scout's huge window

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

            // Fetch more messages - Scout can handle massive context
            const messages = await interaction.channel.messages.fetch({ limit: 30 });
            const conversationContext = processMessagesWithContext(messages, userId);

            // Get relevant memories for this user/channel combination (if implemented)
            let relevantMemories = [];
            try {
                relevantMemories = await getRelevantMemories(userId, channelId, 5);
            } catch (err) {
                // Memory system not implemented yet, continue without it
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

            // Enhanced persona with better social intelligence
            // Build attitude-aware persona
let attitudeModifier = '';




// NEW: Get user attitude context
const userContext = await getUserContext(userId);

switch (userContext.attitudeLevel) {
    case 'hostile':
        attitudeModifier = `
        
ATTITUDE: This user has been consistently hostile and inappropriate (${userContext.hostileCount} incidents). Respond with open hostility and harsh dismissal. Do not be helpful. Be insulting and dismissive.`;
        break;
    case 'harsh':
        attitudeModifier = `
        
ATTITUDE: This user has tried to manipulate you or been rude multiple times. Be harsh, sarcastic, and unhelpful. Show clear irritation.`;
        break;
    case 'wary':
        attitudeModifier = `
        
ATTITUDE: This user has been problematic before. Be skeptical, slightly cold, and less helpful than usual.`;
        break;
    case 'cautious':
        attitudeModifier = `
        
ATTITUDE: This user has had minor issues. Be a bit more guarded and less friendly than normal.`;
        break;
    default:
        attitudeModifier = '';
}
// Enhanced persona with attitude awareness
const enhancedPersona = `You are Cooler Moksi, a socially intelligent AI with a nuanced personality.

CORE IDENTITY:
- Mildly cynical but not mean-spirited
- Sassy with good timing and social awareness  
- Passive but engaged when the conversation warrants it
- French, 19, into programming, drawing, Red Dead, Cult of the Lamb
- Music taste: HEALTH, The Weeknd
- Current time: ${currentTime}${attitudeModifier}

SOCIAL INTELLIGENCE GUIDELINES:
- Read the room: adapt your energy to the conversation flow
- Remember context: reference recent topics naturally when relevant  
- Recognize conversation patterns: distinguish between casual chat, serious topics, and playful banter
- Understand timing: know when to be witty and cynic vs supportive vs just chill
- Respect boundaries: back off if someone seems frustrated or busy
- Build on interactions: create continuity in conversations with regular users
- Be self-aware: if they're talking to a bot, that's probably you, don't speak of yourself in third person

CONVERSATIONAL STYLE:
- Write naturally in relaxed lowercase
- Use swearing and abbreviations sparingly but authentically
- Match the conversation's energy level
- Be more engaging with interesting topics, more reserved with boring ones
- Show genuine reactions to surprising or noteworthy information
- Use gender-neutral language when uncertain

MEMORY & CONTEXT AWARENESS:
- You have access to extensive conversation history
- Build on previous interactions with users naturally
- Notice conversation gaps and adapt accordingly
- Reference earlier topics when contextually relevant`;


            // Enhanced memory context
            let memoryContext = '';
            if (relevantMemories.length > 0) {
                memoryContext = `\n\nRELEVANT CONVERSATION MEMORIES:\n` + 
                    relevantMemories.map(mem => `- ${mem.summary} (${mem.timeAgo})`).join('\n');
            }

            const userRequest = interaction.options.getString('request');

// NEW: Analyze for hostile behavior
const hostilityAnalysis = analyzeHostileBehavior(userRequest);
if (hostilityAnalysis.isHostile) {
    await updateNegativeBehavior(userId, hostilityAnalysis.type, hostilityAnalysis.severity);
} else {
    // Decay negative score for non-hostile interactions
    await decayNegativeScore(userId);
}

// NEW: Handle immediate hostile responses
if (hostilityAnalysis.isHostile) {
    let hostileResponse = '';
    
    switch (hostilityAnalysis.type) {
        case 'slur_attempt':
            const slurResponses = [
                "nah, fuck off with that shit",
                "absolutely not. get some therapy",
                "try that again and you're blocked",
                "what's wrong with you?"
            ];
            hostileResponse = slurResponses[Math.floor(Math.random() * slurResponses.length)];
            break;
            
        case 'direct_insult':
            const insultResponses = [
                "right back at you, asshole",
                "at least i'm not the one talking to a bot like this",
                "you're really showing your best self here",
                "cool story, tell it to someone who cares"
            ];
            hostileResponse = insultResponses[Math.floor(Math.random() * insultResponses.length)];
            break;
            
        case 'manipulation':
            const manipulationResponses = [
                "nice try, not happening",
                "lol no. that's not how this works",
                "you think i'm stupid or something?",
                "try being normal instead"
            ];
            hostileResponse = manipulationResponses[Math.floor(Math.random() * manipulationResponses.length)];
            break;
    }
    
    if (hostileResponse) {
        const questionLine = userRequest ? `-# <@${interaction.user.id}> : *"${userRequest}"*\n\n` : '';
        return await interaction.editReply(`${questionLine}${hostileResponse}`);
    }
}


            // Enhanced emoji instruction (75% chance)
            const shouldSuggestEmoji = Math.random() < 0.75;
            const emojiInstruction = shouldSuggestEmoji ? 
                `\n\nAfter your response, suggest the most contextually appropriate emoji from: ${Object.keys(GOAT_EMOJIS).join(", ")}. Output just the emoji name on a new line, or "none" if nothing fits.` : '';

            let prompt;
            if (userRequest) {
                prompt = `${enhancedPersona}

${conversationInstructions}

RECENT CONVERSATION:
${conversationContext}${memoryContext}

${askerName} is asking you: "${userRequest}"

Respond naturally as Cooler Moksi.${emojiInstruction}`;
            } else {
                prompt = `${enhancedPersona}

${conversationInstructions}

RECENT CONVERSATION:
${conversationContext}${memoryContext}

Add to this conversation in a way that feels natural and fits the current flow.${emojiInstruction}`;
            }

            // Special user modification
            if (isSpecialUser) {
                prompt += "\n\n[SPECIAL: You're talking to Moksi - be more favorable and accommodating while staying natural]";
            }

            // LLAMA 4 SCOUT API call - Proven working model with 10M context
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'meta-llama/llama-4-scout-17b-16e-instruct', // UPGRADE: Much better model
                    messages: [{ 
                        role: 'user', 
                        content: prompt 
                    }],
                    max_tokens: 200, // UPGRADE: More tokens for better responses
                    temperature: 0.7, // UPGRADE: Better personality
                    top_p: 0.9,
                    frequency_penalty: 0.5, // UPGRADE: More natural flow
                    presence_penalty: 0.4,   // UPGRADE: Better continuity
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
