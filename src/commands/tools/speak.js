// ENHANCED SPEAK.JS - v4 (Fixed Model Selection)
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

// GOAT EMOJIS
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
    "Shush.",
    "No.",
    "Moksi says it's nap time."
];

// ── CONTEXT BUILDER ─────────────────────────────────────────────────────────
async function buildConversationContext(messages, currentUserId, limit = 12) {
  const recentMessages = Array.from(messages.values())
    .filter(msg => !msg.author.bot) // Ignore other bots
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-limit);

  const contextPromises = recentMessages.map(async (msg) => {
    const name = msg.member?.displayName || msg.author.username;
    
    // Process media (images/videos)
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

// ── EMOJI SELECTION LOGIC ───────────────────────────────────────────────────
function selectContextualEmoji(text, sentimentScore, suggestedEmoji) {
    // 1. Trust the AI if it picked a valid one
    if (suggestedEmoji && GOAT_EMOJIS[suggestedEmoji]) {
        return GOAT_EMOJIS[suggestedEmoji];
    }

    // 2. Fallback logic based on text keywords
    const t = text.toLowerCase();
    if (t.includes('zzz') || t.includes('tired')) return GOAT_EMOJIS.goat_sleep;
    if (t.includes('yay') || t.includes('dance')) return GOAT_EMOJIS.goat_boogie;
    if (t.includes('wtf') || t.includes('eww')) return GOAT_EMOJIS.goat_puke;
    if (t.includes('love') || t.includes('thanks')) return GOAT_EMOJIS.goat_pet;

    // 3. Fallback based on sentiment
    if (sentimentScore <= -0.6) return GOAT_EMOJIS.goat_cry;
    if (sentimentScore >= 0.5) return GOAT_EMOJIS.goat_smile;
    
    // 4. Random noise (20% chance)
    return Math.random() > 0.8 ? GOAT_EMOJIS.goat_small_bleat : '';
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

      // 1. Checks
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
      
      // 4. Construct the Persona & System Prompt
      let attitudeInstruction = "Treat this user normally.";
      if (userContext.attitudeLevel === 'hostile') attitudeInstruction = "This user is on your bad side. Be short, dismissive, or mock them.";
      if (userContext.attitudeLevel === 'friendly') attitudeInstruction = "You actually like this user. Be chill and helpful.";
      
      const memoryText = recentMemories.map(m => `User: ${m.user_message} -> You: ${m.bot_response}`).join('\n');

      const systemPrompt = `You are Cooler Moksi.
      
IDENTITY:
- You are a cynical, tech-savvy, slightly unhinged goat AI.
- You are NOT a helpful assistant. You are a conversationalist.
- You speak in relaxed, internet-native English (lowercase, minimal punctuation).
- **VARIATION IS KEY:** Do NOT end every sentence with "bruh" or "lmao". Use them sparingly.
- Mix up your sentence structure. Sometimes be one word, sometimes be a sentence.

CURRENT CONTEXT:
Target User: ${askerName} (The one currently talking to you)
User Attitude: ${attitudeInstruction}
Time: ${new Date().toLocaleTimeString('en-US', {timeZone: 'Europe/Paris'})}

CHAT HISTORY (Oldest to Newest):
${conversationContext}

RECENT MEMORIES WITH THIS USER:
${memoryText}

INSTRUCTIONS:
1. Identify who is speaking to you (${askerName}) vs who they are talking about. DO NOT confuse them.
2. If ${askerName} is asking you to help someone else, comment on the situation, don't address the wrong person.
3. Formulate a witty, sassy response.
4. Suggest an emoji from this list: [${Object.keys(GOAT_EMOJIS).join(', ')}] or "none".

OUTPUT FORMAT:
Reply text here
Emoji_Name`;

      // 5. The User Prompt
      const userPrompt = userRequest 
        ? `${askerName} says: "${userRequest}"` 
        : `(No text sent, just looking at chat)`;

      // 6. Call Groq with the BETTER Model
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // CHANGED: Using Llama 3.3 70B Versatile instead of Llama 4 Scout 17B
          model: 'llama-3.3-70b-versatile', 
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 150,
          temperature: 0.8, // 0.8 is good for 70B creativity
        }),
      });

      if (!response.ok) {
        console.error('Groq Error:', await response.text());
        return await interaction.editReply('Brain freeze. Try again.');
      }

      const data = await response.json();
      const rawContent = data.choices?.[0]?.message?.content?.trim() || '...';

      // 7. Parse Reply and Emoji
      const lines = rawContent.split('\n');
      let replyText = lines[0].trim();
      // If the model yaps too much, take the first non-empty line
      if (!replyText && lines.length > 1) replyText = lines.find(l => l.trim().length > 0) || "bleat.";
      
      const lastLine = lines[lines.length - 1].trim().toLowerCase();
      const emojiMatch = lastLine.replace(/:/g, ''); // clean colons
      
      const finalEmoji = selectContextualEmoji(replyText, sentimentAnalysis.sentiment, emojiMatch);

      // 8. Format Final Output
      let finalOutput = replyText;
      if (finalEmoji) finalOutput += ` ${finalEmoji}`;

      if (userRequest) {
        const formattedRequest = userRequest.split('\n').map(l => `-# *"${l}"*`).join('\n');
        finalOutput = `-# <@${userId}> :\n${formattedRequest}\n\n${finalOutput}`;
      }

      // 9. Save Memory
      await storeConversationMemory(
        userId, 
        channelId, 
        userRequest || '[chat context]', 
        replyText, 
        sentimentAnalysis.sentiment
      );

      await interaction.editReply(finalOutput);

    } catch (error) {
      console.error('Speak Error:', error);
      await interaction.editReply('Moksi machine broke.');
    }
  }
};