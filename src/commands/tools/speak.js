// ENHANCED SPEAK.JS - DeepSeek V3 + AI Autonomy
const { SlashCommandBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Your OpenRouter Key
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY; 

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

// 1. THE FACE BANK
// The AI will see these keys (e.g., "goat_puke") and choose one.
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
    "The goat rests.",
    "Shush.",
    "No."
];

// ── CONTEXT BUILDER ─────────────────────────────────────────────────────────
async function buildConversationContext(messages, currentUserId, limit = 12) {
  const recentMessages = Array.from(messages.values())
    .filter(msg => !msg.author.bot)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-limit);

  const contextPromises = recentMessages.map(async (msg) => {
    const name = msg.member?.displayName || msg.author.username;
    
    let mediaContent = '';
    try {
      const descriptions = await processMediaInMessage(msg);
      if (descriptions.length > 0) mediaContent = ` ${descriptions.join(' ')}`;
    } catch (e) { console.error(e); }

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

    try {
      const userId = interaction.user.id;
      const channelId = interaction.channel.id;
      const userRequest = interaction.options.getString('request');
      const askerName = interaction.member?.displayName || interaction.user.username;

      // Checks
      if (await isUserBlacklisted(userId)) return await interaction.editReply(`Fuck off, <@${userId}>`);
      
      const activeSpeak = await getSettingState('active_speak');
      const isOwner = userId === "619637817294848012";
      if (activeSpeak === false && !isOwner) {
        return await interaction.editReply(speakDisabledReplies[Math.floor(Math.random() * speakDisabledReplies.length)]);
      }

      await updateUserPreferences(userId, interaction);

      // Build Contexts
      const messages = await interaction.channel.messages.fetch({ limit: 15 });
      const conversationContext = await buildConversationContext(messages, userId);
      const userContext = await getUserContext(userId);
      const recentMemories = await getRecentMemories(userId, 4);

      // Sentiment (Still useful for tracking long term attitude in DB, even if not used for emoji)
      let sentimentAnalysis = { sentiment: 0, reasoning: 'No message' };
      if (userRequest && userRequest.trim()) {
        sentimentAnalysis = await updateUserAttitudeWithAI(userId, userRequest, conversationContext);
      }
      
      let attitudeInstruction = "Neutral/Chill.";
      if (userContext.attitudeLevel === 'hostile') attitudeInstruction = "Hostile/Mocking.";
      if (userContext.attitudeLevel === 'friendly') attitudeInstruction = "Friendly/Warm.";
      
      const memoryText = recentMemories.map(m => `User: ${m.user_message} -> You: ${m.bot_response}`).join('\n');

      // ── THE BRAIN (SYSTEM PROMPT) ─────────────────────────────────────────
      // We give the AI the list of keys and tell it to pick one.
      const emojiKeys = Object.keys(GOAT_EMOJIS).join(', ');

      const systemPrompt = `You are Cooler Moksi.

IDENTITY:
- A cynical, tech-savvy, slightly unhinged goat AI.
- Speak in relaxed, internet-native English (lowercase, minimal punctuation).
- Be witty and concise (1-2 sentences).

CONTEXT:
- User: ${askerName}
- Attitude: ${attitudeInstruction}

REACTION SYSTEM:
You have a specific set of facial expressions (emojis). 
Available Emotions: [${emojiKeys}] or "none".

INSTRUCTIONS:
1. Write your text reply.
2. On a NEW LINE at the end, output ONLY the single ID string of the emoji that matches your reply's tone.
   (e.g., if you are being mean, put "goat_puke". If happy, "goat_smile").
3. DO NOT repeat your text in the emoji line.

CHAT LOG:
${conversationContext}

MEMORY:
${memoryText}`;

      const userPrompt = userRequest 
        ? `${askerName} says: "${userRequest}"` 
        : `(No text sent, just lurking)`;

      // ── OPENROUTER / DEEPSEEK CALL ────────────────────────────────────────
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://discord.com',
          'X-Title': 'Cooler Moksi',
        },
        body: JSON.stringify({
          model: 'deepseek/deepseek-chat', 
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 200,
          temperature: 1.1, // DeepSeek Creative Setting
        }),
      });

      if (!response.ok) {
        console.error('OpenRouter Error:', await response.text());
        return await interaction.editReply('My brain is buffering.');
      }

      const data = await response.json();
      const rawContent = data.choices?.[0]?.message?.content?.trim() || '...';
      
      // Clean thinking blocks if DeepSeek sends them
      const cleanContent = rawContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      // ── PARSING THE AI CHOICE ─────────────────────────────────────────────
      const lines = cleanContent.split('\n').filter(l => l.trim());
      
      // 1. Get the potential Emoji ID from the last line
      let suggestedEmojiKey = lines[lines.length - 1]?.trim().toLowerCase() || "";
      suggestedEmojiKey = suggestedEmojiKey.replace(/:/g, ''); // remove colons if AI added them
      
      let replyText = "";
      let finalEmoji = "";

      // 2. Validate: Is the last line actually a valid emoji key?
      if (GOAT_EMOJIS[suggestedEmojiKey]) {
        // Yes -> The last line IS the emoji. The text is everything before it.
        finalEmoji = GOAT_EMOJIS[suggestedEmojiKey];
        replyText = lines.slice(0, -1).join('\n').trim(); // Take all lines except the last
      } else if (suggestedEmojiKey === 'none') {
        // AI explicitly said "none"
        replyText = lines.slice(0, -1).join('\n').trim();
      } else {
        // No -> The AI failed to follow format or just spoke text. 
        // We assume the whole thing is text and default to a small bleat (neutral).
        replyText = cleanContent;
        finalEmoji = GOAT_EMOJIS['goat_small_bleat']; 
      }

      // Fallback: If text is empty (rare), just bleat.
      if (!replyText) replyText = "bleat.";

      // 3. Assemble
      let finalOutput = replyText;
      if (finalEmoji) finalOutput += ` ${finalEmoji}`;

      if (userRequest) {
        const formattedRequest = userRequest.split('\n').map(l => `-# *"${l}"*`).join('\n');
        finalOutput = `-# <@${userId}> :\n${formattedRequest}\n\n${finalOutput}`;
      }

      await storeConversationMemory(userId, channelId, userRequest || '[context]', replyText, sentimentAnalysis.sentiment);

      await interaction.editReply(finalOutput);

    } catch (error) {
      console.error('Speak Error:', error);
      await interaction.editReply('Moksi machine broke.');
    }
  }
};