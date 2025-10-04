// ENHANCED SPEAK.JS - AI Sentiment Analysis & Anti-Repetition System (CORRECTED)

const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;

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

// FIXED: Goat emojis with actual IDs
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

// ── ENHANCED CONTEXT PROCESSING WITH MEDIA ANALYSIS ──────────────────────────
async function buildConversationContext(messages, currentUserId, limit = 10) {
  // console.log('[MEDIA DEBUG] Starting buildConversationContext');

  const recentMessages = Array.from(messages.values())
    .filter(msg => !msg.author.bot)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-limit);

  // console.log(`[MEDIA DEBUG] Processing ${recentMessages.length} messages`);

  const contextPromises = recentMessages.map(async (msg, index) => {
    const name = msg.member?.displayName || msg.author.username;
    const timeAgo = Math.floor((Date.now() - msg.createdTimestamp) / 60000);
    const timeStr = timeAgo < 1 ? 'now' : `${timeAgo}m ago`;

    // console.log(`[MEDIA DEBUG] Message ${index + 1} from ${name}:`);
    // console.log(`[MEDIA DEBUG] - Has attachments: ${msg.attachments?.size || 0}`);
    // console.log(`[MEDIA DEBUG] - Has embeds: ${msg.embeds?.length || 0}`);
    // console.log(`[MEDIA DEBUG] - Content: "${msg.content.substring(0, 100)}..."`);

    // Process media in message
    let mediaDescriptions = [];
    try {
      // console.log(`[MEDIA DEBUG] Calling processMediaInMessage for message from ${name}`);
      mediaDescriptions = await processMediaInMessage(msg);
      // Only log when media is actually found
      if (mediaDescriptions.length > 0) {
        console.log(`[MEDIA] Found ${mediaDescriptions.length} descriptions for ${name}:`, mediaDescriptions);
      }
    } catch (error) {
      console.error(`[MEDIA] Error processing media from ${name}:`, error.message);
    }

    // Build message content
    let messageContent = msg.content.slice(0, 200);

    // Add media descriptions
    if (mediaDescriptions.length > 0) {
      const mediaText = mediaDescriptions.join(' ');
      // console.log(`[MEDIA DEBUG] Adding media text: "${mediaText}"`);
      if (messageContent.trim()) {
        messageContent += ` ${mediaText}`;
      } else {
        messageContent = mediaText;
      }
    }

    // Handle empty content (e.g., just attachments)
    if (!messageContent.trim()) {
      messageContent = '[no text content]';
    }

    const finalContent = `${name} (${timeStr}): ${messageContent}`;
    // console.log(`[MEDIA DEBUG] Final context line: "${finalContent}"`);

    return finalContent;
  });

  try {
    const contextArray = await Promise.all(contextPromises);
    const finalContext = contextArray.join('\n');
    // console.log(`[MEDIA DEBUG] Final conversation context:\n${finalContext}`);
    return finalContext;
  } catch (error) {
    console.error('[MEDIA] Error building conversation context:', error.message);

    // Fallback to simple context without media
    const fallback = recentMessages.map(msg => {
      const name = msg.member?.displayName || msg.author.username;
      const timeAgo = Math.floor((Date.now() - msg.createdTimestamp) / 60000);
      const timeStr = timeAgo < 1 ? 'now' : `${timeAgo}m ago`;
      return `${name} (${timeStr}): ${msg.content.slice(0, 200) || '[no text content]'}`;
    }).join('\n');

    // console.log(`[MEDIA DEBUG] Using fallback context:\n${fallback}`);
    return fallback;
  }
}

// ── ANTI-REPETITION SYSTEM ────────────────────────────────────────────────────
function buildAntiRepetitionContext(recentMemories, userContext) {
  if (!recentMemories || recentMemories.length === 0) {
    return '';
  }

  const recentBotResponses = recentMemories.map(m => m.bot_response).filter(Boolean);

  if (recentBotResponses.length === 0) {
    return '';
  }

  const patterns = [];

  const startWords = recentBotResponses.map(response => {
    const words = response.toLowerCase().split(' ').slice(0, 3);
    return words.join(' ');
  });

  const startPatterns = [...new Set(startWords)];
  if (startPatterns.length < startWords.length) {
    patterns.push('You keep starting responses the same way');
  }

  const endWords = recentBotResponses.map(response => {
    const words = response.toLowerCase().split(' ').slice(-2);
    return words.join(' ');
  });

  const endPatterns = [...new Set(endWords)];
  if (endPatterns.length < endWords.length) {
    patterns.push('You keep ending responses similarly');
  }

  let antiRepetitionInstructions = '';

  if (patterns.length > 0) {
    antiRepetitionInstructions = `\n\nANTI-REPETITION WARNING: ${patterns.join(', ')}. 
VARY your response structure. Your recent responses:
${recentBotResponses.map((r, i) => `${i+1}. "${r}"`).join('\n')}

DO NOT use similar patterns. Be creative with different:
- Sentence structures
- Starting words  
- Ending phrases
- Response length
- Tone variations`;
  }

  return antiRepetitionInstructions;
}

// ── ENHANCED CONTEXTUAL EMOJI SELECTION ───────────────────────────────────────
function selectContextualEmoji(message, sentimentScore, conversationContext = '') {
  const text = message.toLowerCase();
  const context = conversationContext.toLowerCase();

  // Context-based selection (higher priority)
  if (context.includes('coding') || context.includes('programming') || context.includes('bug')) {
    if (sentimentScore < -0.3) return 'goat_exhausted';
    if (sentimentScore > 0.3) return 'goat_smile';
    return 'goat_meditate';
  }

  if (context.includes('sleep') || context.includes('tired') || text.includes('goodnight')) {
    return 'goat_sleep';
  }

  if (context.includes('party') || context.includes('celebration') || text.includes('yay')) {
    return 'goat_boogie';
  }

  // Direct message content
  if (text.includes('pet') || text.includes('cute') || text.includes('adorable')) {
    return 'goat_pet';
  }

  if (text.includes('loud') || text.includes('scream') || text.includes('!!!')) {
    return 'goat_scream';
  }

  if (text.includes('mwah') || text.includes('kiss') || text.includes('love')) {
    return 'goat_pet';
  }

  // Sentiment-based fallback
  if (sentimentScore >= 0.5) return 'goat_smile';
  if (sentimentScore <= -0.6) return 'goat_cry';
  if (sentimentScore <= -0.8) return 'goat_puke';
  if (sentimentScore >= -0.3 && sentimentScore <= 0.3) return 'goat_meditate';

  // Random chance of no emoji (30% chance)
  if (Math.random() > 0.7) return null;

  return 'goat_small_bleat'; // Default mild reaction
}

// ── MAIN COMMAND HANDLER ──────────────────────────────────────────────────────
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
    // PERFECT: Use Discord's built-in "Bot is thinking..." indicator - no (edited) marks!
    await interaction.deferReply();

    try {
      const userId = interaction.user.id;
      const channelId = interaction.channel.id;
      const userRequest = interaction.options.getString('request');
      const askerName = interaction.member?.displayName || interaction.user.username;

      // console.log(`[MEDIA DEBUG] Starting speak command for user ${askerName} (${userId})`);

      // Check blacklist
      if (await isUserBlacklisted(userId)) {
        return await interaction.editReply(`Fuck off, <@${userId}>`);
      }

      // Check if speak is enabled
      const activeSpeak = await getSettingState('active_speak');
      const isSpecialUser = interaction.user.id === "619637817294848012";

      if (activeSpeak === false && !isSpecialUser) {
        const reply = speakDisabledReplies[Math.floor(Math.random() * speakDisabledReplies.length)];
        return await interaction.editReply(reply);
      }

      // Update user preferences (tracks interaction count)
      await updateUserPreferences(userId, interaction);

      // Build conversation context for AI sentiment analysis WITH MEDIA ANALYSIS
      // console.log('[MEDIA DEBUG] Fetching recent messages');
      const messages = await interaction.channel.messages.fetch({ limit: 15 });
      // console.log(`[MEDIA DEBUG] Fetched ${messages.size} messages from channel`);

      // console.log('[MEDIA DEBUG] Building conversation context with media analysis');
      const conversationContext = await buildConversationContext(messages, userId);

      // Get user context and recent memories BEFORE sentiment analysis
      const userContext = await getUserContext(userId);
      const recentMemories = await getRecentMemories(userId, 5);

      // AI-POWERED SENTIMENT ANALYSIS (now with enhanced context awareness)
      let sentimentAnalysis = { sentiment: 0, reasoning: 'No message' };
      if (userRequest && userRequest.trim()) {
        sentimentAnalysis = await updateUserAttitudeWithAI(userId, userRequest, conversationContext);
        console.log(`Sentiment analysis for user ${userId}: ${sentimentAnalysis.sentiment.toFixed(2)} (${sentimentAnalysis.reasoning})`);
      }

      // Get UPDATED user context after sentiment analysis
      const updatedUserContext = await getUserContext(userId);

      // Build memory context  
      let memoryContext = '';
      if (recentMemories.length > 0) {
        memoryContext = '\n\nRecent conversation context:\n' + 
          recentMemories.map(m => `User: "${m.user_message}" → You: "${m.bot_response}"`).join('\n');
      }

      // Build anti-repetition context
      const antiRepetitionContext = buildAntiRepetitionContext(recentMemories, updatedUserContext);

      // Build attitude-aware prompt
      let attitudeModifier = '';
      switch (updatedUserContext.attitudeLevel) {
        case 'hostile':
          attitudeModifier = '\n\nATTITUDE: This user has been consistently negative/hostile. Be dismissive, sarcastic, use rude insults and show clear irritation. You genuinely dislike them.';
          break;
        case 'cautious':
          attitudeModifier = '\n\nATTITUDE: This user has shown some negative behavior. Be somewhat guarded and less friendly than usual.';
          break;
        case 'familiar':
          attitudeModifier = '\n\nATTITUDE: This user is a longtime friend with many positive interactions. Be notably warmer and more engaged.';
          break;
        case 'friendly':
          attitudeModifier = '\n\nATTITUDE: This user has been consistently positive. Be warmer than usual and show you enjoy their company.';
          break;
        default:
          attitudeModifier = '\n\nATTITUDE: Standard interactions. Be yourself - somewhat cynical but not mean-spirited.';
      }

      // Create enhanced prompt with anti-repetition system
      const prompt = `You are Cooler Moksi, a socially intelligent AI with a cynical, sassy personality.

CORE IDENTITY:
- into programming and gaming (don't mention unless relevant)
- Somewhat cynical and sarcastic by default
- Write naturally in relaxed lowercase, use swearing sparingly but authentically  
- Keep responses 1-2 sentences max, but prefer just a few words when possible (one word answers allowed)
- Current time: ${new Date().toLocaleString('en-US', {timeZone: 'Europe/Paris'})}${attitudeModifier}

CONVERSATION CONTEXT:
${conversationContext}${memoryContext}${antiRepetitionContext}

CURRENT INTERACTION:
${userRequest ? `${askerName} is asking: "${userRequest}"` : 'Add to this conversation naturally.'}
${sentimentAnalysis.reasoning ? `[Detected sentiment: ${sentimentAnalysis.sentiment.toFixed(2)} - ${sentimentAnalysis.reasoning}]` : ''}

Respond as Cooler Moksi. CRITICAL: Do not repeat patterns from your recent responses. Be creative and varied.
Note : you can see images and videos people post, so comment on them if relevant.

After your response, suggest ONE emoji from: ${Object.keys(GOAT_EMOJIS).join(', ')} or "none".
Output the emoji name on a new line.`;

      // Call AI with correct model
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct', // FIXED: Correct model for text generation
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 100,
          temperature: 0.7,
          top_p: 0.9,
          frequency_penalty: 0.6,
          presence_penalty: 0.3,
        }),
      });

      if (!response.ok) {
        console.error('Groq API error:', await response.text());
        return await interaction.editReply('Moksi has no more money. You guys sucked it all up.');
      }

      const data = await response.json();
      let rawReply = data.choices?.[0]?.message?.content?.trim() || 'Nothing returned.';

      // Process emoji suggestion with ENHANCED contextual logic
      const lines = rawReply.split('\n').filter(line => line.trim());
      let replyText = lines[0].replace(/:[a-z0-9_]+:/gi, '').trim();

      const suggestedEmoji = lines[1]?.toLowerCase().replace(/^:|:$/g, '') || '';
      let emojiKey = null;

      // ENHANCED: Use contextual emoji selection (single strategy)
      if (suggestedEmoji && GOAT_EMOJIS[suggestedEmoji]) {
        emojiKey = suggestedEmoji;
      } else {
        emojiKey = selectContextualEmoji(replyText, sentimentAnalysis.sentiment, conversationContext);
      }

      const emoji = emojiKey ? GOAT_EMOJIS[emojiKey] : '';

      // Build final reply
      let finalReply = replyText;
      if (emoji) {
        finalReply += ' ' + emoji;
      }

      // ENHANCED: Fix multi-line request formatting
      if (userRequest) {
        const requestLines = userRequest.split('\n');
        if (requestLines.length === 1) {
          // Single line - original format
          finalReply = `-# <@${userId}> : *"${userRequest}"*\n\n${finalReply}`;
        } else {
          // Multi-line - apply -# to each line
          const formattedRequest = requestLines.map(line => `-# *"${line}"*`).join('\n');
          finalReply = `-# <@${userId}> :\n${formattedRequest}\n\n${finalReply}`;
        }
      }

      // Store conversation memory with sentiment score
      await storeConversationMemory(
        userId,
        channelId,
        userRequest || '[joined conversation]',
        replyText,
        sentimentAnalysis.sentiment
      );

      // console.log('[MEDIA DEBUG] Speak command completed successfully');
      await interaction.editReply(finalReply);

    } catch (error) {
      console.error('Speak command error:', error);
      console.error('Full error details:', error.stack);
      await interaction.editReply('Internal error: ' + (error?.message || error));
    }
  }
};