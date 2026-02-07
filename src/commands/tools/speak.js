// ENHANCED SPEAK.JS - DeepSeek V3 + Optimized & Refactored
const { SlashCommandBuilder } = require('discord.js');

const {
  isUserBlacklisted,
  getSettingState,
  getUserContext,
  updateUserPreferences,
  updateUserAttitudeWithAI,
  storeConversationMemory,
  getRecentMemories,
  processMediaInMessage
} = require('../../utils/db.js');

const { callOpenRouterAPI } = require('../../utils/apiHelpers');
const { handleCommandError, sendError } = require('../../utils/errorHandler');
const { 
    GOAT_EMOJIS, 
    SPEAK_DISABLED_REPLIES, 
    MEMORY_LIMITS, 
    SENTIMENT_THRESHOLDS, 
    isOwner 
} = require('../../utils/constants');
const logger = require('../../utils/logger');

// ── CONTEXT BUILDER (OPTIMIZED) ─────────────────────────────────────────────
/**
 * Builds conversation context from recent messages
 * @param {Collection} messages - Discord messages collection
 * @param {string} currentUserId - Current user's ID
 * @returns {Promise<string>} Formatted conversation context
 */
async function buildConversationContext(messages, currentUserId) {
  // Convert map to array and sort chronologically
  const recentMessages = Array.from(messages.values())
    .filter(msg => !msg.author.bot)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-MEMORY_LIMITS.CONVERSATION_MESSAGES);

  if (recentMessages.length === 0) return 'No recent conversation.';

  // Pre-calculate newest message ID for media analysis optimization
  const newestMsgId = recentMessages[recentMessages.length - 1]?.id;

  const contextPromises = recentMessages.map(async (msg) => {
    const name = msg.member?.displayName || msg.author.username;
    
    // OPTIMIZATION: Only analyze image if it's the very last message
    // This stops the bot from spending 5-10s analyzing old images every time
    const isNewest = msg.id === newestMsgId;
    
    let mediaContent = '';
    try {
      const descriptions = await processMediaInMessage(msg, isNewest);
      if (descriptions.length > 0) mediaContent = ` ${descriptions.join(' ')}`;
    } catch (e) { 
      logger.warn('Media processing failed in context builder', { error: e.message, messageId: msg.id });
    }

    let content = msg.content.replace(/\n/g, ' ').slice(0, 300);
    if (!content && mediaContent) content = "[media only]";
    
    return `${name}: ${content}${mediaContent}`;
  });

  const contextArray = await Promise.all(contextPromises);
  return contextArray.join('\n');
}

// ── MAIN COMMAND ────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('speak')
    .setDescription('Talk with Cooler Moksi')
    .addStringOption(opt =>
      opt.setName('request')
        .setDescription('Ask Cooler Moksi anything')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    // Progressive feedback: send "thinking" message after 2s if still processing
    const thinkingTimeout = setTimeout(async () => {
      try {
        await interaction.followUp({ 
          content: '_thinking..._', 
          ephemeral: true 
        });
      } catch (e) { /* Ignore if interaction already completed */ }
    }, 2000);

    try {
      const userId = interaction.user.id;
      const channelId = interaction.channel.id;
      const userRequest = interaction.options.getString('request');
      const askerName = interaction.member?.displayName || interaction.user.username;

      // 1. Checks & Blacklist
      if (await isUserBlacklisted(userId)) {
        clearTimeout(thinkingTimeout);
        return await sendError(
          interaction, 
          'You\'re blocked from using this command. Contact an admin if you believe this is an error.',
          false
        );
      }
      
      const activeSpeak = await getSettingState('active_speak');
      const userIsOwner = isOwner(userId);
      
      if (activeSpeak === false && !userIsOwner) {
        clearTimeout(thinkingTimeout);
        const randomReply = SPEAK_DISABLED_REPLIES[Math.floor(Math.random() * SPEAK_DISABLED_REPLIES.length)];
        return await interaction.editReply(`${randomReply}\n-# _(The bot is in maintenance mode. Try again later.)_`);
      }

      // 2. PARALLELIZED: Fetch all independent data simultaneously
      const [messages, userContext, recentMemories] = await Promise.all([
        interaction.channel.messages.fetch({ limit: MEMORY_LIMITS.FETCH_LIMIT }),
        getUserContext(userId),
        getRecentMemories(userId, MEMORY_LIMITS.RECENT_MEMORIES)
      ]);

      // Update last seen (non-blocking)
      updateUserPreferences(userId, interaction).catch(e => 
        logger.error('Failed to update user preferences', { userId, error: e.message })
      );

      // 3. Build conversation context (needs messages first)
      const conversationContext = await buildConversationContext(messages, userId);

      // 4. Sentiment Analysis (only if user sent a message)
      let sentimentAnalysis = { sentiment: 0, reasoning: 'No message' };
      if (userRequest && userRequest.trim()) {
        sentimentAnalysis = await updateUserAttitudeWithAI(userId, userRequest, conversationContext);
      }
      
      // 5. Build AI Instructions
      let attitudeInstruction = "Neutral/Chill.";
      if (userContext.attitudeLevel === 'hostile') attitudeInstruction = "Hostile/Mocking.";
      if (userContext.attitudeLevel === 'friendly' || userContext.attitudeLevel === 'familiar') attitudeInstruction = "Friendly/Warm.";
      
      const memoryText = recentMemories.length > 0 
        ? recentMemories.map(m => `User: ${m.user_message} -> You: ${m.bot_response}`).join('\n')
        : 'No prior memories.';

      const emojiKeys = Object.keys(GOAT_EMOJIS).join(', ');

      let userRoleContext = "Random User";
      if (userIsOwner) {
        userRoleContext = "CREATOR (Moksi) - You respect him, though you might tease him.";
      } else {
        userRoleContext = "Chatter (NOT your creator).";
      }

      const systemPrompt = `You are Cooler Moksi.

IDENTITY:
- A somewhat cynical goat AI.
- Tone: Usually Dry, deadpan, slightly sarcastic, but can change depending on the situation. Don't be rude when uncalled for.
- Speak normally (lowercase) and naturally (no overt punctuation). 
- STRICTLY FORBIDDEN: Do NOT use "Zoomer slang" like "fr fr", "no cap", "fam", "based", "bet". You are not a teenager. Speak like a tired adult.
- Be concise (1-2 sentences).
- Mix up your sentence structure. Sometimes be one word, sometimes sentences.

CURRENT CONTEXT:
- User: ${askerName}
- Role: ${userRoleContext}
- Attitude: ${attitudeInstruction}

REACTION SYSTEM:
1. Write your text reply.
2. STRICT RULE: Do NOT use standard emojis (like 😂, 💀) in your text.
3. On a NEW LINE at the end, output ONLY one ID from this list: [${emojiKeys}] or "none".

CHAT LOG:
${conversationContext}

MEMORY:
${memoryText}`;

      const userPrompt = userRequest 
        ? `${askerName} says: "${userRequest}"` 
        : `(No text sent, just lurking)`;

      // 6. API CALL using helper (with timeout and error handling)
      const rawContent = await callOpenRouterAPI(
        'deepseek/deepseek-chat',
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        {
          maxTokens: 200,
          temperature: 1.0
        }
      );

      clearTimeout(thinkingTimeout);

      if (!rawContent) {
        logger.error('OpenRouter returned null', { userId, hasRequest: !!userRequest });
        return await sendError(
          interaction,
          'My brain timed out. The AI servers might be slow right now. Try again?'
        );
      }

      // 7. ROBUST EMOJI PARSING
      let replyText = rawContent;
      let finalEmoji = "";

      // Regex looks for a known emoji key at the VERY end of the string
      const emojiRegex = new RegExp(`(?:\\s|\\n)(${Object.keys(GOAT_EMOJIS).join('|')}|none)$`, 'i');
      const match = rawContent.match(emojiRegex);

      if (match) {
        const emojiKey = match[1].toLowerCase();
        replyText = rawContent.replace(match[0], '').trim();
        if (GOAT_EMOJIS[emojiKey]) finalEmoji = GOAT_EMOJIS[emojiKey];
      }

      // Fallback: If no emoji found but sentiment is extreme, auto-pick one
      if (!finalEmoji) {
         if (sentimentAnalysis.sentiment <= SENTIMENT_THRESHOLDS.AUTO_EMOJI_NEGATIVE) {
           finalEmoji = GOAT_EMOJIS['goat_exhausted'];
         } else if (sentimentAnalysis.sentiment >= SENTIMENT_THRESHOLDS.AUTO_EMOJI_POSITIVE) {
           finalEmoji = GOAT_EMOJIS['goat_smile'];
         }
      }

      if (!replyText) replyText = "bleat.";

      // 8. FINAL OUTPUT CONSTRUCTION
      let finalOutput = replyText;
      if (finalEmoji) finalOutput += ` ${finalEmoji}`;

      if (userRequest) {
        const formattedRequest = userRequest.split('\n').map(l => `-# *"${l}"*`).join('\n');
        finalOutput = `-# <@${userId}> :\n${formattedRequest}\n\n${finalOutput}`;
      }

      // 9. SAVE MEMORY (non-blocking)
      storeConversationMemory(
        userId, 
        channelId, 
        userRequest || '[context]', 
        replyText, 
        sentimentAnalysis.sentiment
      ).catch(e => 
        logger.error('Failed to store conversation memory', { userId, error: e.message })
      );

      await interaction.editReply(finalOutput);

    } catch (error) {
      clearTimeout(thinkingTimeout);
      await handleCommandError(interaction, error, { 
        hasRequest: !!interaction.options.getString('request') 
      });
    }
  }
};