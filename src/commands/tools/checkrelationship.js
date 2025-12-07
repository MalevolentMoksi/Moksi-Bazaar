// src/commands/tools/checkrelationship.js - FIXED SCHEMA & GHOST RESPONSES
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getUserContext, getRecentMemories } = require('../../utils/db.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;

// ── AI RESPONSE ─────────────────────────────────────────────────────────────
async function generateRelationshipResponse(userContext, targetUser, recentMemories) {
  const userName = targetUser.displayName || targetUser.username;
  // Hardcoded Creator Check
  const isCreator = targetUser.id === "619637817294848012";

  // Build prompt context
  let contextStr = `User: ${userName}\nLevel: ${userContext.attitudeLevel}\nInteractions: ${userContext.interactionCount}`;
  if (isCreator) contextStr += `\nROLE: THIS IS YOUR CREATOR (MOKSI). You respect/tolerate him (mostly).`;

  if (recentMemories.length) {
    contextStr += `\nRecent Chats:\n${recentMemories.map(m => `"${m.user_message}" -> "${m.bot_response}"`).join('\n')}`;
  }

  const prompt = `You are Cooler Moksi. How do you feel about ${userName}?
  
  DATA:
  ${contextStr}
  
  INSTRUCTIONS:
  - Be cynical, authentic, and casual (lowercase).
  - If it's the Creator: Be affectionately annoyed or loyal.
  - If Stranger: admit you don't know them.
  - If Hostile: Roast them.
  
  Write 1-2 sentences.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${LANGUAGE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.8,
      }),
    });

    if (response.ok) {
        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim();
    }
  } catch (e) { console.error(e); }
  
  return isCreator ? "that's my dad. he's annoying but i guess i keep him around." : `idk ${userName} is ${userContext.attitudeLevel}, i guess.`;
}

// ── STATS FORMATTER ─────────────────────────────────────────────────────────
function formatDetailedStats(userContext, targetUser, recentMemories) {
  const stats = [
    `**Level:** ${userContext.attitudeLevel.toUpperCase()}`,
    `**Score:** ${userContext.sentimentScore.toFixed(2)}`,
    `**Interactions:** ${userContext.interactionCount}`
  ];

  if (recentMemories.length > 0) {
    stats.push(`\n**Last Memory:** "${recentMemories[0].user_message.substring(0, 40)}..."`);
  }
  
  return stats.join('\n');
}

function getColorForAttitude(level) {
  switch (level) {
    case 'hostile': return 0xFF0000;
    case 'friendly': return 0x00FF00;
    case 'familiar': return 0x00FFFF;
    default: return 0x808080;
  }
}

// ── COMMAND ─────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('checkrelation')
    .setDescription('Ask Cooler Moksi how they feel about a user')
    .addUserOption(o => o.setName('user').setDescription('The user').setRequired(true))
    .addBooleanOption(o => o.setName('detailed').setDescription('Show stats')),

  async execute(interaction) {
    await interaction.deferReply();
    try {
      const targetUser = interaction.options.getUser('user');
      const showDetailed = interaction.options.getBoolean('detailed');
      
      const userContext = await getUserContext(targetUser.id);
      // Fetch memories from DB (since they aren't in userContext)
      const recentMemories = await getRecentMemories(targetUser.id, 3);

      const response = await generateRelationshipResponse(userContext, targetUser, recentMemories);

      if (showDetailed) {
        const stats = formatDetailedStats(userContext, targetUser, recentMemories);
        await interaction.editReply({
            embeds: [{
                title: `Opinion on ${targetUser.username}`,
                description: `*"${response}"*\n\n${stats}`,
                color: getColorForAttitude(userContext.attitudeLevel)
            }]
        });
      } else {
        await interaction.editReply(response);
      }
    } catch (e) {
      console.error(e);
      await interaction.editReply('Error checking relationship.');
    }
  }
};