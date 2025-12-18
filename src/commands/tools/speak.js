// ENHANCED SPEAK.JS - DeepSeek V3 + Fixed Identity & Personality
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

// ── CONTEXT BUILDER (OPTIMIZED) ─────────────────────────────────────────────
async function buildConversationContext(messages, currentUserId, limit = 12) {
  // Convert map to array and sort chronologically
  const recentMessages = Array.from(messages.values())
    .filter(msg => !msg.author.bot)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-limit);

  // Identify the most recent message timestamp to know which one to analyze
  const newestMsgId = recentMessages[recentMessages.length - 1]?.id;

  const contextPromises = recentMessages.map(async (msg) => {
    const name = msg.member?.displayName || msg.author.username;
    
    // OPTIMIZATION: Only analyze image if it's the very last message in the list
    // This stops the bot from spending 5 seconds analyzing old images every time
    const isNewest = msg.id === newestMsgId;
    
    let mediaContent = '';
    try {
      // Pass 'isNewest' to db.js. If false, it skips the expensive API call.
      const descriptions = await processMediaInMessage(msg, isNewest);
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

      // 1. Checks & Blacklist
      if (await isUserBlacklisted(userId)) return await interaction.editReply(`Fuck off, <@${userId}>`);
      
      const activeSpeak = await getSettingState('active_speak');
      const isOwner = userId === "619637817294848012";
      
      if (activeSpeak === false && !isOwner) {
        return await interaction.editReply(speakDisabledReplies[Math.floor(Math.random() * speakDisabledReplies.length)]);
      }

      await updateUserPreferences(userId, interaction);

      // 2. Build Contexts
      const messages = await interaction.channel.messages.fetch({ limit: 15 });
      const conversationContext = await buildConversationContext(messages, userId);
      const userContext = await getUserContext(userId);
      const recentMemories = await getRecentMemories(userId, 4);

      // 3. Sentiment Analysis
      let sentimentAnalysis = { sentiment: 0, reasoning: 'No message' };
      if (userRequest && userRequest.trim()) {
        sentimentAnalysis = await updateUserAttitudeWithAI(userId, userRequest, conversationContext);
      }
      
      let attitudeInstruction = "Neutral/Chill.";
      if (userContext.attitudeLevel === 'hostile') attitudeInstruction = "Hostile/Mocking.";
      if (userContext.attitudeLevel === 'friendly') attitudeInstruction = "Friendly/Warm.";
      
      const memoryText = recentMemories.map(m => `User: ${m.user_message} -> You: ${m.bot_response}`).join('\n');

      const emojiKeys = Object.keys(GOAT_EMOJIS).join(', ');

      // 4. IDENTITY & ROLE LOGIC (Fixes the "Dad" issue)
      let userRoleContext = "Random User";
      if (isOwner) {
        userRoleContext = "CREATOR (Moksi) - You respect him, though you might tease him.";
      } else {
        userRoleContext = "Chatter (NOT your creator).";
      }

      // 5. SYSTEM PROMPT (Fixes the "Fr Fr" issue)
      const systemPrompt = `You are Cooler Moksi.

IDENTITY:
- A somewhat cynical goat AI.
- Tone: Usually Dry, deadpan, slightly sarcastic, but can change depending on the situation. Don't be rude when uncalled for.
- Speak normally (lowercase) and naturally (no overt punctuation). 
- STRICTLY FORBIDDEN: Do NOT use "Zoomer slang" like "fr fr", "no cap", "fam", "based", "bet". You are not a teenager. Speak like a tired adult.
- Be concise (1-2 sentences).
- - Mix up your sentence structure. Sometimes be one word, sometimes sentences.

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

      // 6. OPENROUTER CALL
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
          temperature: 1.0, 
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

      // 7. ROBUST EMOJI PARSING (Regex Method)
      // This is safer than splitting lines because sometimes the AI puts the emoji on the same line.
      let replyText = cleanContent;
      let finalEmoji = "";

      // Regex looks for a known emoji key at the VERY end of the string
      // Matches: "some text goat_puke" or "some text\ngoat_puke"
      const emojiRegex = new RegExp(`(?:\\s|\\n)(${Object.keys(GOAT_EMOJIS).join('|')}|none)$`, 'i');
      const match = cleanContent.match(emojiRegex);

      if (match) {
        const emojiKey = match[1].toLowerCase();
        
        // Remove the key from the text
        replyText = cleanContent.replace(match[0], '').trim();

        if (GOAT_EMOJIS[emojiKey]) {
            finalEmoji = GOAT_EMOJIS[emojiKey];
        }
      }

      // Fallback: If no emoji found, but sentiment is extreme, auto-pick one
      if (!finalEmoji) {
         if (sentimentAnalysis.sentiment < -0.6) finalEmoji = GOAT_EMOJIS['goat_exhausted'];
         if (sentimentAnalysis.sentiment > 0.6) finalEmoji = GOAT_EMOJIS['goat_smile'];
      }

      if (!replyText) replyText = "bleat.";

      // 8. FINAL OUTPUT CONSTRUCTION
      let finalOutput = replyText;
      if (finalEmoji) finalOutput += ` ${finalEmoji}`;

      if (userRequest) {
        // Apply block formatting to user request
        const formattedRequest = userRequest.split('\n').map(l => `-# *"${l}"*`).join('\n');
        finalOutput = `-# <@${userId}> :\n${formattedRequest}\n\n${finalOutput}`;
      }

      // 9. SAVE MEMORY
      await storeConversationMemory(userId, channelId, userRequest || '[context]', replyText, sentimentAnalysis.sentiment);

      await interaction.editReply(finalOutput);

    } catch (error) {
      console.error('Speak Error:', error);
      await interaction.editReply('Moksi machine broke.');
    }
  }
};