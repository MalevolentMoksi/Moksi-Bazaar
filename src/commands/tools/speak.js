// CLEAN SPEAK.JS - Refactored for better context and no repetition
const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;

// Import only the functions we actually need from the clean database
const {
  isUserBlacklisted,
  getSettingState,
  getUserContext,
  updateUserPreferences,
  updateUserAttitude,
  storeConversationMemory,
  getRecentMemories
} = require('../../utils/db.js');

// Goat emojis - keep the fun stuff!
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

// ── CLEAN CONTEXT PROCESSING ─────────────────────────────────────────────────
function buildConversationContext(messages, currentUserId, limit = 10) {
  const recentMessages = Array.from(messages.values())
    .filter(msg => !msg.author.bot) // Skip bot messages to avoid confusion
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-limit);

  const context = recentMessages.map(msg => {
    const name = msg.member?.displayName || msg.author.username;
    const timeAgo = Math.floor((Date.now() - msg.createdTimestamp) / 60000); // minutes ago
    const timeStr = timeAgo < 1 ? 'now' : `${timeAgo}m ago`;

    return `${name} (${timeStr}): ${msg.content.slice(0, 200)}`;
  });

  return context.join('\n');
}

// ── SIMPLE SENTIMENT ANALYSIS ────────────────────────────────────────────────
function analyzeSentiment(message) {
  if (!message) return 0;

  const positive = ['thanks', 'thank you', 'great', 'awesome', 'cool', 'nice', 'good', 'love', 'like', 'appreciate'];
  const negative = ['hate', 'stupid', 'dumb', 'sucks', 'terrible', 'awful', 'annoying'];

  const text = message.toLowerCase();
  let score = 0;

  positive.forEach(word => {
    if (text.includes(word)) score += 0.2;
  });

  negative.forEach(word => {
    if (text.includes(word)) score -= 0.3;
  });

  return Math.max(-1, Math.min(1, score));
}

// ── EMOJI SUGGESTION LOGIC ────────────────────────────────────────────────────
function selectEmoji(message, sentiment) {
  if (Math.random() > 0.3) return null; // Only suggest emojis 30% of the time

  const text = message.toLowerCase();

  if (text.includes('sleep') || text.includes('tired')) return 'goat_sleep';
  if (text.includes('party') || text.includes('celebrate')) return 'goat_boogie';
  if (sentiment > 0.3) return 'goat_smile';
  if (sentiment < -0.3) return 'goat_cry';
  if (text.includes('pet') || text.includes('cute')) return 'goat_pet';
  if (text.includes('loud') || text.includes('scream')) return 'goat_scream';

  return null;
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
    await interaction.deferReply();

    try {
      const userId = interaction.user.id;
      const channelId = interaction.channel.id;
      const userRequest = interaction.options.getString('request');
      const askerName = interaction.member?.displayName || interaction.user.username;

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

      // Get user context and recent memories
      const userContext = await getUserContext(userId);
      const recentMemories = await getRecentMemories(userId, 3);

      // Analyze sentiment and update attitude
      const sentiment = analyzeSentiment(userRequest);
      await updateUserAttitude(userId, sentiment);

      // Build conversation context (clean and simple)
      const messages = await interaction.channel.messages.fetch({ limit: 15 });
      const conversationContext = buildConversationContext(messages, userId);

      // Build memory context if we have recent memories
      let memoryContext = '';
      if (recentMemories.length > 0) {
        memoryContext = '\n\nRecent conversation context:\n' + 
          recentMemories.map(m => `User: "${m.user_message}" → You: "${m.bot_response}"`).join('\n');
      }

      // Build attitude-aware prompt
      let attitudeModifier = '';
      switch (userContext.attitudeLevel) {
        case 'hostile':
          attitudeModifier = '\n\nATTITUDE: Be dismissive and sarcastic with this user. Show clear irritation.';
          break;
        case 'cautious':
          attitudeModifier = '\n\nATTITUDE: Be somewhat guarded with this user. Keep responses brief.';
          break;
        case 'familiar':
          attitudeModifier = '\n\nATTITUDE: Be warm and friendly. This user is a longtime friend.';
          break;
        case 'friendly':
          attitudeModifier = '\n\nATTITUDE: Be notably warmer than usual. Show you enjoy their company.';
          break;
        default:
          attitudeModifier = '\n\nATTITUDE: Be yourself - somewhat cynical but not mean-spirited.';
      }

      // Create clean, focused prompt
      const prompt = `You are Cooler Moksi, a socially intelligent AI with a cynical, sassy personality.

CORE IDENTITY:
- French, 19, into programming and gaming
- Somewhat cynical and sarcastic by default
- Write naturally in relaxed lowercase, use swearing sparingly but authentically
- Keep responses 1-2 sentences max, prefer just a few words
- Current time: ${new Date().toLocaleString('en-US', {timeZone: 'Europe/Paris'})}${attitudeModifier}

CONVERSATION CONTEXT:
${conversationContext}${memoryContext}

${userRequest ? `${askerName} is asking: "${userRequest}"` : 'Add to this conversation naturally.'}

Respond as Cooler Moksi. After your response, suggest ONE emoji from: ${Object.keys(GOAT_EMOJIS).join(', ')} or "none".
Output the emoji name on a new line.`;

      // Call QWEN API
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 125, // Keep it concise
          temperature: 0.7,
          top_p: 0.9,
        }),
      });

      if (!response.ok) {
        console.error('Groq API error:', await response.text());
        return await interaction.editReply('Moksi has no more money. You guys sucked it all up.');
      }

      const data = await response.json();
      let rawReply = data.choices?.[0]?.message?.content?.trim() || 'Nothing returned.';

      // Process emoji suggestion
      const lines = rawReply.split('\n').filter(line => line.trim());
      const replyText = lines[0];
      const suggestedEmoji = lines[1]?.toLowerCase().replace(/^:|:$/g, '') || '';
      const emoji = GOAT_EMOJIS[suggestedEmoji] || '';

      // Build final reply
      let finalReply = replyText;
      if (emoji) finalReply += ' ' + emoji;

      // Add question context if user asked something
      if (userRequest) {
        finalReply = `-# <@${userId}> : *"${userRequest}"*\n\n${finalReply}`;
      }

      // Store this conversation in memory
      await storeConversationMemory(
        userId, 
        channelId, 
        userRequest || '[joined conversation]', 
        replyText
      );

      await interaction.editReply(finalReply);

    } catch (error) {
      console.error('Speak command error:', error);
      await interaction.editReply('Internal error: ' + (error?.message || error));
    }
  }
};