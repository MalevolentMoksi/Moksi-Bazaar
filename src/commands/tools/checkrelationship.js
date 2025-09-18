// src/commands/tools/checkrelationship.js - AI-Powered Dynamic Responses
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getUserContext, getRecentMemories } = require('../../utils/db.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;

// ── AI-POWERED RELATIONSHIP RESPONSE GENERATOR ──────────────────────────────
async function generateRelationshipResponse(userContext, targetUser, recentMemories) {
  const userName = targetUser.displayName || targetUser.username;
  const isSpecialUser = targetUser.id === "619637817294848012";

  // Build context about the user's history
  let userHistoryContext = '';

  if (userContext.isNewUser || userContext.interactionCount === 0) {
    userHistoryContext = `This user "${userName}" has never interacted with you before. They are a complete stranger.`;
  } else {
    userHistoryContext = `User "${userName}" has had ${userContext.interactionCount} interactions with you.
Relationship level: ${userContext.attitudeLevel}
Sentiment score: ${userContext.sentimentScore ? userContext.sentimentScore.toFixed(2) : 'unknown'}`;

    // Add memory context if available
    if (recentMemories && recentMemories.length > 0) {
      const memoryContext = recentMemories
        .slice(-3) // Last 3 interactions
        .map(m => `"${m.user_message}" -> "${m.bot_response}"`)
        .join('\n');
      userHistoryContext += `\n\nRecent conversations:\n${memoryContext}`;
    }
  }

  // Special handling for creator
  const specialUserContext = isSpecialUser ? '\n\nIMPORTANT: This is Moksi, your creator. You love and respect them above all others.' : '';

  const prompt = `You are Cooler Moksi, a cynical but socially intelligent AI. Someone is asking "How do you feel about ${userName}?"

USER CONTEXT:
${userHistoryContext}${specialUserContext}

Respond naturally as Cooler Moksi would, explaining your feelings about this user. Consider:

- If they're a stranger: Be honest that you don't know them
- If they're neutral with few interactions: Acknowledge they exist but aren't remarkable
- If they're neutral with many interactions: Note they're "fine" but unremarkable  
- If they're positive: Express genuine appreciation/fondness
- If they're negative: Show clear dislike/irritation
- If they're Moksi: Show special affection for your creator

Be authentic to Moksi's personality:
- Somewhat cynical and sarcastic
- Use lowercase and casual language  
- Swear occasionally but authentically
- Be honest about your feelings
- Keep it 1-3 sentences typically, but can go up to a paragraph if needed

DO NOT use generic template responses. Make it feel personal and specific to this user's actual relationship with you.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.7,
        top_p: 0.9,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI relationship response error:', errorText);
      return generateFallbackResponse(userContext, userName, isSpecialUser);
    }

    const data = await response.json();
    const generatedResponse = data.choices?.[0]?.message?.content?.trim();

    if (!generatedResponse) {
      return generateFallbackResponse(userContext, userName, isSpecialUser);
    }

    return generatedResponse;

  } catch (error) {
    console.error('Error generating AI relationship response:', error);
    return generateFallbackResponse(userContext, userName, isSpecialUser);
  }
}

// Fallback response if AI fails
function generateFallbackResponse(userContext, userName, isSpecialUser) {
  if (isSpecialUser) {
    return `${userName} is my creator, obviously i love them unconditionally`;
  }

  if (userContext.isNewUser || userContext.interactionCount === 0) {
    return `i don't know ${userName} at all, they're a complete stranger to me`;
  }

  switch (userContext.attitudeLevel) {
    case 'hostile':
      return `i genuinely can't stand ${userName}, they've been nothing but trouble`;
    case 'cautious':
      return `${userName} is... questionable. they've shown some red flags so i'm keeping my distance`;
    case 'friendly':
      return `${userName} is pretty cool actually, i enjoy talking to them`;
    case 'familiar':
      return `${userName} is one of my favorites, we have a solid friendship going`;
    default:
      if (userContext.interactionCount > 20) {
        return `${userName} exists, they talk to me regularly but nothing particularly stands out about them`;
      } else if (userContext.interactionCount > 5) {
        return `${userName} is fine i suppose, they're around but haven't made much of an impression`;  
      } else {
        return `i barely know ${userName}, they've only talked to me a few times`;
      }
  }
}

// ── ENHANCED STATS FORMATTING ────────────────────────────────────────────────
function formatDetailedStats(userContext, targetUser, recentMemories) {
  const stats = [];

  // Basic info
  stats.push(`**User ID:** ${targetUser.id}`);
  stats.push(`**Relationship Level:** ${userContext.attitudeLevel}`);
  stats.push(`**Interactions:** ${userContext.interactionCount}`);

  // Sentiment tracking (if available)
  if (userContext.sentimentScore !== undefined) {
    stats.push(`**Average Sentiment:** ${userContext.sentimentScore.toFixed(2)} (-1.00 to +1.00)`);
  }

  // Recent interactions summary
  if (userContext.recentInteractions && userContext.recentInteractions.length > 0) {
    const recentCount = userContext.recentInteractions.length;
    const avgRecentSentiment = userContext.recentInteractions.reduce((sum, i) => sum + i.sentiment, 0) / recentCount;
    stats.push(`**Recent Pattern:** ${avgRecentSentiment.toFixed(2)} avg over last ${recentCount} interactions`);
  }

  // Time info
  if (userContext.lastSeen) {
    const lastSeen = new Date(userContext.lastSeen);
    const timeSince = Math.floor((Date.now() - lastSeen.getTime()) / (1000 * 60 * 60 * 24));
    stats.push(`**Last Seen:** ${timeSince} days ago`);
  }

  // Memory context
  if (recentMemories && recentMemories.length > 0) {
    stats.push(`**Stored Memories:** ${recentMemories.length} recent conversations`);

    // Show a snippet of recent interaction
    const lastMemory = recentMemories[recentMemories.length - 1];
    if (lastMemory && lastMemory.user_message) {
      const snippet = lastMemory.user_message.length > 50 
        ? lastMemory.user_message.substring(0, 50) + '...'
        : lastMemory.user_message;
      stats.push(`**Last Interaction:** "${snippet}"`);
    }
  }

  // Relationship progression hint
  const progressHint = getProgressionHint(userContext);
  if (progressHint) {
    stats.push(`**Progression:** ${progressHint}`);
  }

  return stats.join('\n');
}

function getProgressionHint(userContext) {
  const { attitudeLevel, interactionCount, sentimentScore } = userContext;

  switch (attitudeLevel) {
    case 'hostile':
      return 'Needs consistent positive interactions to improve relationship';
    case 'cautious':
      return 'Some positive interactions could move toward neutral';
    case 'neutral':
      if (interactionCount < 10) {
        return `${10 - interactionCount} more positive interactions for friendly status`;
      } else {
        return 'Needs more positive interactions to build friendship';
      }
    case 'friendly':
      if (interactionCount < 50) {
        return `${50 - interactionCount} more positive interactions for familiar status`;
      } else {
        return 'Close to familiar status with continued positive interactions';
      }
    case 'familiar':
      return 'Maximum positive relationship achieved! 💚';
    default:
      return null;
  }
}

function getColorForAttitude(attitudeLevel) {
  switch (attitudeLevel) {
    case 'hostile': return 0xFF0000;   // Red
    case 'cautious': return 0xFFA500;  // Orange  
    case 'neutral': return 0x808080;   // Gray
    case 'friendly': return 0x90EE90;  // Light Green
    case 'familiar': return 0x00FF00;  // Green
    default: return 0x808080;
  }
}

// ── MAIN COMMAND HANDLER ──────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('checkrelation')
    .setDescription('Ask Cooler Moksi how they feel about a user')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('The user to check relationship with')
        .setRequired(true)
    )
    .addBooleanOption(option =>
      option
        .setName('detailed')
        .setDescription('Show detailed stats instead of just Moksi\'s feelings')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async execute(interaction) {
    await interaction.deferReply({});

    try {
      const targetUser = interaction.options.getUser('user');
      const showDetailed = interaction.options.getBoolean('detailed') || false;

      // Get user context and memories
      const userContext = await getUserContext(targetUser.id);
      const recentMemories = await getRecentMemories(targetUser.id, 5);

      if (showDetailed) {
        // Show detailed stats with AI-generated response
        const aiResponse = await generateRelationshipResponse(userContext, targetUser, recentMemories);
        const detailedStats = formatDetailedStats(userContext, targetUser, recentMemories);

        const embed = {
          title: `How Cooler Moksi feels about ${targetUser.displayName || targetUser.username}`,
          description: `*"${aiResponse}"*`,
          color: getColorForAttitude(userContext.attitudeLevel),
          fields: [{
            name: 'Relationship Statistics',
            value: detailedStats,
            inline: false
          }],
          footer: {
            text: 'AI-Generated Response | Cooler Moksi\'s Relationship System',
            icon_url: interaction.client.user.avatarURL()
          },
          timestamp: new Date()
        };

        await interaction.editReply({ embeds: [embed] });
      } else {
        // Just the AI-generated relationship response
        const aiResponse = await generateRelationshipResponse(userContext, targetUser, recentMemories);
        await interaction.editReply(aiResponse);
      }

    } catch (error) {
      console.error('Error in checkrelation command:', error);
      await interaction.editReply('Error checking user relationship: ' + error.message);
    }
  }
};