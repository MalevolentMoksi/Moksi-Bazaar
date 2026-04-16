// src/commands/tools/checkrelationship.js - Nuanced, trend-aware
const { SlashCommandBuilder } = require('discord.js');
const { getUserContext, getRecentMemories, getSentimentHistory } = require('../../utils/db.js');
const { callGroqAPI } = require('../../utils/apiHelpers');
const { createRelationshipEmbed } = require('../../utils/embedBuilder');
const { handleCommandError } = require('../../utils/errorHandler');
const { isOwner, ATTITUDE_INSTRUCTIONS } = require('../../utils/constants');

// ── TREND CALCULATION ───────────────────────────────────────────────────────
function describeTrend(history) {
  if (!history || history.length < 3) return null;
  const recent = history.slice(-3);
  const older  = history.slice(0, -3);
  const avg = arr => arr.reduce((s, h) => s + h.sentiment, 0) / arr.length;
  const recentAvg = avg(recent);
  const olderAvg  = older.length ? avg(older) : recentAvg;
  const delta = recentAvg - olderAvg;
  if (delta > 0.15)  return 'warming up to them recently';
  if (delta < -0.15) return 'growing colder toward them recently';
  return 'steady with them';
}

// ── AI RESPONSE ─────────────────────────────────────────────────────────────
async function generateRelationshipResponse(userContext, targetUser, recentMemories, trend) {
  const userName = targetUser.displayName || targetUser.username;
  const userIsCreator = isOwner(targetUser.id);
  const attitudeRule = ATTITUDE_INSTRUCTIONS[userContext.attitudeLevel] || ATTITUDE_INSTRUCTIONS.neutral;

  let contextStr = `Name: ${userName}
Attitude: ${userContext.attitudeLevel}
Interactions: ${userContext.interactionCount || 0}`;
  if (trend) contextStr += `\nRecent trend: ${trend}`;
  if (userIsCreator) contextStr += `\nROLE: This is your creator (Moksi) — affectionately annoyed / loyal.`;
  if (recentMemories.length > 0) {
    contextStr += `\nRecent exchanges:\n${recentMemories.map(m => `"${m.user_message}" -> "${m.bot_response}"`).join('\n')}`;
  }

  const prompt = `You are Cooler Moksi, a cynical goat AI. How do you feel about ${userName}?

DATA:
${contextStr}

BEHAVIOR FOR THIS ATTITUDE LEVEL: ${attitudeRule}

INSTRUCTIONS:
- Write 1-2 sentences, lowercase, dry. Speak from feeling — do NOT reference numbers, counts, or internal data.
- No zoomer slang. No standard emojis.
- If Interactions is 0 or very low, admit you don't really know them.
- If a trend is provided: warming → let a trace of softening show, perhaps mild surprise at yourself; cooling → let quiet suspicion or distance show.
- If Creator: affectionately annoyed or loyal.`;

  const response = await callGroqAPI(prompt, { maxTokens: 150, temperature: 0.8 });

  if (response) return response;

  // Tier-specific fallbacks instead of one generic line
  if (userIsCreator) return "that's my dad. he's annoying but i guess i keep him around.";
  switch (userContext.attitudeLevel) {
    case 'hostile':  return `${userName}? don't get me started.`;
    case 'cautious': return `${userName} and i have an... understanding. we don't talk much.`;
    case 'familiar': return `${userName}'s around enough. they're alright.`;
    case 'friendly': return `yeah, ${userName}'s one of the good ones.`;
    default:         return `don't really know ${userName}.`;
  }
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

      const [userContext, recentMemories, sentimentHistory] = await Promise.all([
        getUserContext(targetUser.id),
        getRecentMemories(targetUser.id, 3, { excludeContext: true }),
        getSentimentHistory(targetUser.id, 10)
      ]);

      const trend = describeTrend(sentimentHistory);
      const description = await generateRelationshipResponse(userContext, targetUser, recentMemories, trend);

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
