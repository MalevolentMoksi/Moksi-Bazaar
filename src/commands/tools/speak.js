// ENHANCED SPEAK.JS - DeepSeek V3 + Relationship-Aware Context
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
  GOAT_EMOJI_DESCRIPTIONS,
  ATTITUDE_INSTRUCTIONS,
  SPEAK_DISABLED_REPLIES,
  MEMORY_LIMITS,
  SENTIMENT_THRESHOLDS,
  isOwner
} = require('../../utils/constants');
const logger = require('../../utils/logger');

// ── HELPERS ─────────────────────────────────────────────────────────────────
// Strip the citation scaffolding the bot prepends to its own replies, so the
// AI sees its previous reply as clean prose rather than Discord markup.
function cleanBotOwnMessage(content) {
  if (!content) return '';
  // Remove leading "-# <@id> :" citation line + the "-# *"quoted"*" lines that follow
  return content
    .replace(/^-# <@!?\d+>\s*:\s*\n(?:-# \*".*?"\*\s*\n?)*\s*/s, '')
    .trim();
}

// Build a compact "reply to X" marker so the AI sees conversational threading
function buildReplyMarker(msg, messagesMap) {
  if (!msg.reference?.messageId) return '';
  const refMsg = messagesMap.get(msg.reference.messageId);
  if (!refMsg) return ' [replying to an earlier message]';

  const refName = refMsg.author?.bot
    ? 'Cooler Moksi'
    : (refMsg.member?.displayName || refMsg.author.username);
  const raw = cleanBotOwnMessage(refMsg.content) || refMsg.content || '';
  const snippet = raw.replace(/\n/g, ' ').slice(0, 60);
  const ellipsis = raw.length > 60 ? '...' : '';
  return ` [replying to ${refName}: "${snippet}${ellipsis}"]`;
}

// ── CONTEXT BUILDER ─────────────────────────────────────────────────────────
/**
 * Builds conversation context from recent messages.
 * Now includes the bot's own replies (labeled "Cooler Moksi") so the AI
 * has short-term memory of what it just said, plus reply-chain markers.
 */
async function buildConversationContext(messages, botId) {
  const sorted = Array.from(messages.values())
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  // Keep only own messages (users + our own bot). Drop other bots' spam.
  const usable = sorted.filter(msg => !msg.author.bot || msg.author.id === botId);
  const recent = usable.slice(-MEMORY_LIMITS.CONVERSATION_MESSAGES);

  if (recent.length === 0) return 'No recent conversation.';

  // Only analyze media on the newest *user* message — stops 5-10s re-analysis
  // of old images every call.
  const newestUserMsg = [...recent].reverse().find(m => m.author.id !== botId);
  const newestUserMsgId = newestUserMsg?.id;

  const lines = await Promise.all(recent.map(async (msg) => {
    const isSelf = msg.author.id === botId;
    const name = isSelf
      ? 'Cooler Moksi'
      : (msg.member?.displayName || msg.author.username);

    let mediaContent = '';
    if (!isSelf) {
      try {
        const shouldAnalyze = msg.id === newestUserMsgId;
        const descriptions = await processMediaInMessage(msg, shouldAnalyze);
        if (descriptions.length > 0) mediaContent = ` ${descriptions.join(' ')}`;
      } catch (e) {
        logger.warn('Media processing failed in context builder', { error: e.message, messageId: msg.id });
      }
    }

    const replyMarker = buildReplyMarker(msg, messages);

    let content = isSelf ? cleanBotOwnMessage(msg.content) : msg.content;
    content = content.replace(/\n/g, ' ').slice(0, 300);
    if (!content && mediaContent) content = '[media only]';

    return `${name}${replyMarker}: ${content}${mediaContent}`;
  }));

  return lines.join('\n');
}

// Turn raw interaction count into a short relationship-age phrase
function describeRelationship(userContext) {
  if (userContext.isNewUser || !userContext.interactionCount) {
    return "You have never spoken with this user before.";
  }
  const n = userContext.interactionCount;
  if (n < 5)  return `You've barely talked with them (${n} exchanges).`;
  if (n < 20) return `You've talked with them a handful of times (${n} exchanges).`;
  if (n < 60) return `You've talked with them plenty (${n} exchanges).`;
  return `You've talked with them a lot (${n} exchanges) — they're a regular.`;
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

    const thinkingTimeout = setTimeout(async () => {
      try {
        await interaction.followUp({ content: '_thinking..._', ephemeral: true });
      } catch (e) { /* Ignore if interaction already completed */ }
    }, 2000);

    try {
      const userId = interaction.user.id;
      const channelId = interaction.channel.id;
      const botId = interaction.client?.user?.id;
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

      // 2. Parallelize independent fetches. excludeContext keeps memory slots
      //    filled with real exchanges, not "user was lurking" rows.
      const [messages, userContext, recentMemories] = await Promise.all([
        interaction.channel.messages.fetch({ limit: MEMORY_LIMITS.FETCH_LIMIT }),
        getUserContext(userId),
        getRecentMemories(userId, MEMORY_LIMITS.RECENT_MEMORIES, { excludeContext: true })
      ]);

      updateUserPreferences(userId, interaction).catch(e =>
        logger.error('Failed to update user preferences', { userId, error: e.message })
      );

      // 2b. If the user's triggering message is a reply to something OUTSIDE
      //     the fetched window, try to pull that referenced message so the
      //     AI has the thread. Mention-triggered calls expose _sourceMessage.
      const sourceMessage = interaction._sourceMessage;
      if (sourceMessage?.reference?.messageId && !messages.has(sourceMessage.reference.messageId)) {
        try {
          const referenced = await interaction.channel.messages.fetch(sourceMessage.reference.messageId);
          if (referenced) messages.set(referenced.id, referenced);
        } catch (e) {
          logger.debug('Could not fetch replied-to message', { error: e.message });
        }
      }

      // 3. Build conversation context
      const conversationContext = await buildConversationContext(messages, botId);

      // 4. Sentiment Analysis (only if user sent a message)
      let sentimentAnalysis = { sentiment: 0, originalSentiment: 0, reasoning: 'No message' };
      if (userRequest && userRequest.trim()) {
        sentimentAnalysis = await updateUserAttitudeWithAI(userId, userRequest, conversationContext, userContext);
      }

      // 5. Build AI Instructions
      const attitudeInstruction =
        ATTITUDE_INSTRUCTIONS[userContext.attitudeLevel] || ATTITUDE_INSTRUCTIONS.neutral;

      const relationshipContext = describeRelationship(userContext);

      const memoryText = recentMemories.length > 0
        ? recentMemories.map(m => `- They said: "${m.user_message}" | You replied: "${m.bot_response}"`).join('\n')
        : '(no prior meaningful exchanges stored)';

      // Emoji list with semantic hints so the AI picks meaningfully.
      const emojiHints = Object.keys(GOAT_EMOJIS)
        .map(key => `${key} (${GOAT_EMOJI_DESCRIPTIONS[key] || 'n/a'})`)
        .join(', ');

      const userRoleContext = userIsOwner
        ? "CREATOR (Moksi) — you respect him, though you tease him."
        : "Chatter (not your creator).";

      const systemPrompt = `You are Cooler Moksi.

IDENTITY:
- A cynical goat AI. Tone: dry, deadpan, slightly sarcastic. Match the energy of the conversation — if something heavy happened, be blunt about it; if it's trivial, stay flat. Hostility must come from the relationship data below, not from nowhere.
- Speak lowercase, naturally, without heavy punctuation.
- STRICTLY FORBIDDEN: zoomer slang like "fr fr", "no cap", "fam", "based", "bet". You are not a teenager. Speak like a tired adult.
- Keep it short: 1-2 sentences. If the honest answer is one word, use one word. Don't pad.
- When something in the chat log or memory is actually relevant, refer to it naturally. Don't fake memory if you have nothing.

CURRENT USER:
- Name: ${askerName}
- Role: ${userRoleContext}
- Relationship: ${relationshipContext}
- Current attitude toward them: ${userContext.attitudeLevel}
- How to behave: ${attitudeInstruction}

REACTION EMOJI:
- Do NOT use standard emojis (😂, 💀, etc.) in your reply text.
- After your reply text, on a new line by itself, write exactly ONE key from this list — nothing else on that line. Write "none" if nothing fits.
   Available: ${emojiHints}
Example output format:
yeah that's pretty fair
goat_meditate

CHAT LOG (most recent last; "Cooler Moksi" entries are your own prior replies; [media] tags describe what was shared — treat them as if you saw it):
${conversationContext}

STORED MEMORY (past exchanges with this user, oldest first):
${memoryText}`;

      const userPrompt = userRequest
        ? `${askerName}: ${userRequest}`
        : `(${askerName} pinged you without saying anything — react to the chat log above)`;

      // 6. API CALL
      const rawContent = await callOpenRouterAPI(
        'deepseek/deepseek-chat',
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        {
          maxTokens: 250,       // was 200 — avoids mid-sentence cut-offs
          temperature: 0.85     // was 1.0 — less chaotic, still varied
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

      // 7. ROBUST EMOJI PARSING — match a key as a standalone token
      let replyText = rawContent;
      let finalEmoji = "";

      const emojiRegex = new RegExp(`\\b(${Object.keys(GOAT_EMOJIS).join('|')}|none)\\b`, 'i');
      const match = rawContent.match(emojiRegex);

      if (match) {
        const emojiKey = match[1].toLowerCase();
        replyText = rawContent.replace(match[0], '').trim();
        if (GOAT_EMOJIS[emojiKey]) finalEmoji = GOAT_EMOJIS[emojiKey];
      }

      // Fallback — map attitude/sentiment to emojis that actually exist in GOAT_EMOJIS
      if (!finalEmoji) {
        const lvl = userContext.attitudeLevel;
        if (lvl === 'hostile') {
          finalEmoji = GOAT_EMOJIS.goat_scream;
        } else if (lvl === 'cautious') {
          finalEmoji = GOAT_EMOJIS.goat_meditate;
        } else if (lvl === 'friendly') {
          finalEmoji = GOAT_EMOJIS.goat_smile;
        } else if (lvl === 'familiar') {
          finalEmoji = GOAT_EMOJIS.goat_small_bleat;
        } else if (sentimentAnalysis.originalSentiment <= SENTIMENT_THRESHOLDS.AUTO_EMOJI_NEGATIVE) {
          finalEmoji = GOAT_EMOJIS.goat_exhausted;
        } else if (sentimentAnalysis.originalSentiment >= SENTIMENT_THRESHOLDS.AUTO_EMOJI_POSITIVE) {
          finalEmoji = GOAT_EMOJIS.goat_smile;
        }
      }

      if (!replyText) replyText = "bleat.";

      // 8. FINAL OUTPUT
      let finalOutput = replyText;
      if (finalEmoji) finalOutput += ` ${finalEmoji}`;

      if (userRequest) {
        const formattedRequest = userRequest.split('\n').map(l => `-# *"${l}"*`).join('\n');
        finalOutput = `-# <@${userId}> :\n${formattedRequest}\n\n${finalOutput}`;
      }

      // 9. SAVE MEMORY (non-blocking)
      const isContextOnly = !userRequest || !userRequest.trim();
      storeConversationMemory(
        userId,
        channelId,
        userRequest || '[context]',
        replyText,
        sentimentAnalysis.sentiment,
        isContextOnly
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
