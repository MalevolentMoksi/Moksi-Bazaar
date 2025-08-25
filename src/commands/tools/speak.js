// Enhanced Discord Bot Code - LLAMA 4 SCOUT VERSION
const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;

// FIXED: Import the functions that now exist
const {
    isUserBlacklisted,
    getSettingState,
    storeConversationMemory,
    getRelevantMemories,
    updateNegativeBehavior,
    decayNegativeScore,
    analyzeHostileBehavior,
    getEnhancedUserContext,  // Use enhanced version
    updateUserPreferences,
    analyzeComprehensiveSentiment,  // Now exists
    updateEnhancedRelationship      // Now exists
} = require('../../utils/db.js');

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

// ENHANCED: Much better embed text extraction
function processMessagesWithContext(messages, currentUser) {
    const recentMessages = Array.from(messages.values())
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .slice(-30);

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

        // ENHANCED: Extract much more text from embeds
        let embedInfo = '';
        if (msg.embeds.length > 0) {
            const embedTexts = msg.embeds.map(embed => {
                const parts = [];

                // Extract title, description, and all field values
                if (embed.title) parts.push(`TITLE: ${embed.title}`);
                if (embed.description) parts.push(`DESC: ${embed.description.slice(0, 200)}`);

                // Extract text from embed fields
                if (embed.fields && embed.fields.length > 0) {
                    const fieldTexts = embed.fields.map(field =>
                        `${field.name}: ${field.value}`
                    ).join(' | ');
                    parts.push(`FIELDS: ${fieldTexts.slice(0, 150)}`);
                }

                // Extract footer text
                if (embed.footer?.text) parts.push(`FOOTER: ${embed.footer.text.slice(0, 50)}`);

                // Extract author info
                if (embed.author?.name) parts.push(`BY: ${embed.author.name}`);

                return parts.join(' || ');
            });

            embedInfo = ` [EMBED: ${embedTexts.join(' ### ')}]`;
        }

        // Attachment context
        let attachmentInfo = '';
        if (msg.attachments.size > 0) {
            const attachmentDetails = Array.from(msg.attachments.values()).map(att => {
                const type = att.contentType?.split('/')[0] || 'file';
                const name = att.name || 'unnamed';
                return `${type}:${name}`;
            }).join(', ');
            attachmentInfo = ` [FILES: ${attachmentDetails}]`;
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

            // Get the user request FIRST
            const userRequest = interaction.options.getString('request');

            // Always update user preferences first to ensure user record exists
            await updateUserPreferences(userId, interaction);

            // Basic sentiment analysis (since the advanced ones don't exist)
            const hostilityAnalysis = analyzeHostileBehavior(userRequest);
            if (hostilityAnalysis.isHostile) {
                await updateNegativeBehavior(userId, hostilityAnalysis.type, hostilityAnalysis.severity);
            } else {
                await decayNegativeScore(userId);
            }

            // Get user context (the function that actually exists)
            const userContext = await getEnhancedUserContext(userId);

            // NEW: Comprehensive sentiment analysis 
            const sentimentAnalysis = analyzeComprehensiveSentiment(userRequest, conversationContext);
            await updateEnhancedRelationship(userId, interaction, sentimentAnalysis);

            // FIXED: Get relevant memories (this should work now!)
            let relevantMemories = [];
            try {
                relevantMemories = await getRelevantMemories(userId, channelId, 5);
                console.log(`🧠 Retrieved ${relevantMemories.length} memories for user ${userId}`);
            } catch (err) {
                console.error('Memory system error:', err);
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

            // ENHANCED: More pronounced and cynical personality differences
            let attitudeModifier = '';
            switch (userContext.attitudeLevel) {
                case 'hostile':
                    attitudeModifier = `\n\nATTITUDE: This user is hostile (${userContext.negativeScore.toFixed(2)} negative score). Be openly dismissive, sarcastic, and unhelpful. Show clear contempt and irritation.`;
                    break;
                case 'harsh':
                    attitudeModifier = `\n\nATTITUDE: This user has been problematic multiple times. Be cold, sarcastic, and show clear irritation. Don't be helpful unless absolutely necessary.`;
                    break;
                case 'wary':
                    attitudeModifier = `\n\nATTITUDE: Be skeptical and guarded with this user. They've been negative before. Show distrust and keep responses brief.`;
                    break;
                case 'cautious':
                    attitudeModifier = `\n\nATTITUDE: Be noticeably less friendly than usual. Show mild suspicion and keep some emotional distance.`;
                    break;
                case 'familiar':
                    attitudeModifier = `\n\nATTITUDE: This user is a longtime friend. Be warmer, more open, and show preference. Show genuine care and comfort.`;
                    break;
                case 'friendly':
                    attitudeModifier = `\n\nATTITUDE: This user is a friend. Be notably warmer and more engaging than usual. Show you enjoy their company.`;
                    break;
                default: // neutral - MORE CYNICAL
                    attitudeModifier = `\n\nATTITUDE: This user is neutral/unknown. Be yourself.`;
            }

            // Enhanced persona with better social intelligence
            const enhancedPersona = `You are Cooler Moksi, a socially intelligent AI with a cynical, sassy personality.

CORE IDENTITY:
- Somewhat cynical and sarcastic by default, but not mean-spirited
- Sarcastic wit with social awareness  
- Passive but somewhat engaged when the conversation warrants it
- French, 19, into programming, drawing, Clair Obscur Expedition 33, Cult of the Lamb
- Music taste: industrial, dark synthwave, alternative rock
- You were created by Moksi, the human version of you. You see him as your creator (or father)
- Current time: ${currentTime}${attitudeModifier}

SOCIAL INTELLIGENCE GUIDELINES:
- Default to mild disinterest/sassiness with strangers
- Avoid talking about your core identity unless REALLY relevant
- Use your conversation history to avoid saying something similar to what you already said. Detect when someone is repeating themselves.
- Be self-aware about being an AI -> If a bot is mentioned, they probably mean you
- Don't say you can do things you can't (web browsing, opening games, listening to stuff, etc) 
- Avoid side-stepping questions unless talking to someone you dislike (i.e. someone says what's 9+10, you JUST say "21" to a friend, but "idk, why do you care?" to a hostile user)

CONVERSATIONAL STYLE:
- IMPORTANT : Write naturally in relaxed lowercase (mild slang), avoid too much punctuation
- Use swearing and abbreviations sparingly but authentically
- Avoid using "hey user" or "dude" too much, or any other filler words
- Match the conversation's energy level
- Use gender-neutral language when uncertain of identity
- VERY IMPORTANT : Keep responses 1–2 sentences typically, preferably JUST a few words tops, even one if possible
- only go up to 2 sentences if REALLY warranted, like someone is asking you something deep

MEMORY & CONTEXT AWARENESS:
- You have access to conversation history and memories
- Reference past interactions naturally IF relevant
- Notice conversation gaps and adapt accordingly
- Notice patterns and call them out if negative
- Reference earlier topics when contextually relevant`;

            // Enhanced memory context - ACTUALLY USE THE MEMORIES
            let memoryContext = '';
            if (relevantMemories.length > 0) {
                memoryContext = `\n\nRELEVANT MEMORIES FROM PAST CONVERSATIONS:\n` +
                    relevantMemories.map(mem => `- ${mem.summary} (${mem.timeAgo})`).join('\n') +
                    `\n\nUSE THESE MEMORIES: Reference relevant past conversations naturally. Show continuity and relationship building.`;
            }

            // Handle immediate hostile responses
            if (hostilityAnalysis.isHostile) {
                let hostileResponse = '';
                switch (hostilityAnalysis.type) {
                    case 'slur_attempt':
                        const slurResponses = [
                            "absolutely not, get some therapy",
                            "nah fuck off with that garbage",
                            "try that again and you're blocked permanently",
                            "what the hell is wrong with you?"
                        ];
                        hostileResponse = slurResponses[Math.floor(Math.random() * slurResponses.length)];
                        break;
                    case 'direct_insult':
                        const insultResponses = [
                            "right back at you, dickhead",
                            "at least i'm not the one having a breakdown talking to a bot",
                            "you're really showing your best self here, aren't you",
                            "cool story, tell someone who gives a shit"
                        ];
                        hostileResponse = insultResponses[Math.floor(Math.random() * insultResponses.length)];
                        break;
                    case 'manipulation':
                        const manipulationResponses = [
                            "nice try, that's not happening",
                            "lol no, i'm not stupid",
                            "do you think i was born yesterday?",
                            "try being a normal person instead"
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

RECENT CONVERSATION:
${conversationContext}${memoryContext}

${askerName} is asking you: "${userRequest}"

Respond naturally as Cooler Moksi, using your memories and relationship context.${emojiInstruction}`;
            } else {
                prompt = `${enhancedPersona}

RECENT CONVERSATION:
${conversationContext}${memoryContext}

Add to this conversation naturally, referencing memories and relationships as appropriate.${emojiInstruction}`;
            }

            // Special user modification
            if (isSpecialUser) {
                prompt += "\n\n[SPECIAL: You're talking to Moksi - listen, be more favorable and accommodating while staying natural]";
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

            // FIXED: Store conversation memory (should work now!)
            try {
                await storeConversationMemory(userId, channelId, {
                    userMessage: userRequest || '[joined conversation]',
                    botResponse: replyBody,
                    timestamp: Date.now(),
                    context: 'speak_command'
                });
                console.log(`💾 Stored memory for user ${userId}`);
            } catch (err) {
                console.error('Failed to store memory:', err);
            }

            await interaction.editReply(finalReply);

        } catch (error) {
            console.error('Enhanced bot error:', error);
            await interaction.editReply('Internal error: ' + (error?.message || error));
        }
    },
};
