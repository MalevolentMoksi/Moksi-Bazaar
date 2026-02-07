// src/commands/tools/checkrelationship.js - Refactored with New Utilities
const { SlashCommandBuilder } = require('discord.js');
const { getUserContext, getRecentMemories } = require('../../utils/db.js');
const { callGroqAPI } = require('../../utils/apiHelpers');
const { createRelationshipEmbed } = require('../../utils/embedBuilder');
const { handleCommandError } = require('../../utils/errorHandler');
const { isOwner } = require('../../utils/constants');

// ── AI RESPONSE ─────────────────────────────────────────────────────────────
async function generateRelationshipResponse(userContext, targetUser, recentMemories) {
  const userName = targetUser.displayName || targetUser.username;
  const userIsCreator = isOwner(targetUser.id);

  // Build prompt context
  let contextStr = `User: ${userName}\nLevel: ${userContext.attitudeLevel}\nInteractions: ${userContext.interactionCount || 0}`;
  if (userIsCreator) contextStr += `\nROLE: THIS IS YOUR CREATOR (MOKSI). You respect/tolerate him (mostly).`;

  if (recentMemories.length > 0) {
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

  const response = await callGroqAPI(prompt, {
    maxTokens: 150,
    temperature: 0.8
  });

  // Fallback if API fails
  if (!response) {
    if (userIsCreator) return "that's my dad. he's annoying but i guess i keep him around.";
    return `idk ${userName} is ${userContext.attitudeLevel}, i guess.`;
  }

  return response;
}

// ── COMMAND ─────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('checkrelation')
    .setDescription('Ask Cooler Moksi how they feel about a user')
    .addUserOption(o => o.setName('user').setDescription('The user').setRequired(true))
    .addBooleanOption(o => o.setName('detailed').setDescription('Show detailed stats').setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply();
    
    try {
      const targetUser = interaction.options.getUser('user');
      const showDetailed = interaction.options.getBoolean('detailed') || false;
      
      // Parallel data fetching
      const [userContext, recentMemories] = await Promise.all([
        getUserContext(targetUser.id),
        getRecentMemories(targetUser.id, 3, { excludeContext: true })
      ]);

      const description = await generateRelationshipResponse(userContext, targetUser, recentMemories);

      const embed = createRelationshipEmbed(userContext, targetUser, {
        description,
        recentMemories,
        detailed: showDetailed
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await handleCommandError(interaction, error, {
        targetUser: interaction.options.getUser('user')?.id
      });
    }
  }
};