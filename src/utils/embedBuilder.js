// src/utils/embedBuilder.js - Standardized Embed Creation
const { EmbedBuilder } = require('discord.js');
const {
    EMBED_COLORS,
    getColorForAttitude,
    getEmojiForAttitude
} = require('./constants');
const { trendDirection } = require('./trend');

/**
 * Creates a relationship display embed for a single user
 * @param {Object} userContext - User context from getUserContext()
 * @param {Object} targetUser - Discord user object
 * @param {Object} options - Configuration options
 * @param {string} options.description - AI-generated description
 * @param {Array} options.recentMemories - Recent conversation memories
 * @param {boolean} options.detailed - Whether to show detailed stats
 * @returns {EmbedBuilder} Configured embed
 */
function createRelationshipEmbed(userContext, targetUser, options = {}) {
    const {
        description = 'No description available.',
        recentMemories = [],
        detailed = false
    } = options;

    const color = getColorForAttitude(userContext.attitudeLevel);
    const emoji = getEmojiForAttitude(userContext.attitudeLevel);
    
    const embed = new EmbedBuilder()
        .setTitle(`${emoji} Opinion on ${targetUser.username}`)
        .setDescription(`*"${description}"*`)
        .setColor(color)
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 128 }));

    if (detailed) {
        embed.addFields([
            {
                name: 'Attitude Level',
                value: userContext.attitudeLevel.toUpperCase(),
                inline: true
            },
            {
                name: 'Sentiment Score',
                value: formatSentimentScore(userContext.sentimentScore),
                inline: true
            },
            {
                name: 'Interactions',
                value: userContext.interactionCount?.toString() || '0',
                inline: true
            }
        ]);

        if (recentMemories.length > 0) {
            const lastMeaningful = [...recentMemories]
                .reverse()
                .find(m => m.user_message && m.user_message !== '[context]');

            if (lastMeaningful) {
                const clipped = lastMeaningful.user_message.substring(0, 80);
                const suffix = lastMeaningful.user_message.length > 80 ? '...' : '';
                embed.addFields([{
                    name: 'Last Interaction',
                    value: `"${clipped}${suffix}"`
                }]);
            } else {
                embed.addFields([{
                    name: 'Last Interaction',
                    value: 'No recent user message.'
                }]);
            }
        }

        if (userContext.lastSeen) {
            // The footer names it; setTimestamp below renders the date itself.
            embed.setFooter({ 
                text: `Last seen` 
            });
            embed.setTimestamp(new Date(userContext.lastSeen));
        }
    } else {
        embed.setFooter({ 
            text: `${userContext.interactionCount || 0} interactions` 
        });
    }

    return embed;
}

/**
 * Creates an overview embed showing multiple user relationships
 * @param {Array} relationships - Array of relationship objects
 * @param {Object} options - Configuration options
 * @param {string} options.summary - AI-generated summary text
 * @param {number} options.page - Current page number (for pagination)
 * @param {number} options.totalPages - Total pages (for pagination)
 * @returns {EmbedBuilder} Configured embed
 */
function createOverviewEmbed(relationships, options = {}) {
    const {
        summary = null,
        page = 1,
        totalPages = 1
    } = options;

    const embed = new EmbedBuilder()
        .setTitle('🌐 Relationships Overview')
        .setColor(EMBED_COLORS.INFO);

    // Add summary if provided
    if (summary) {
        embed.setDescription(`*"${summary}"*\n`);
    }

    // Group by attitude for better organization
    const grouped = {
        familiar: [],
        friendly: [],
        neutral: [],
        cautious: [],
        hostile: []
    };

    relationships.forEach(rel => {
        const level = rel.attitudeLevel || 'neutral';
        if (grouped[level]) grouped[level].push(rel);
    });

    // Add fields for each non-empty group
    if (grouped.familiar.length > 0) {
        embed.addFields([{
            name: '💚 Close Friends',
            value: grouped.familiar.map((r, i) => formatRelationshipLine(r, i)).join('\n') || 'None',
            inline: false
        }]);
    }

    if (grouped.friendly.length > 0) {
        embed.addFields([{
            name: '😊 Friendly',
            value: grouped.friendly.map((r, i) => formatRelationshipLine(r, i)).join('\n') || 'None',
            inline: false
        }]);
    }

    if (grouped.neutral.length > 0) {
        embed.addFields([{
            name: '😐 Neutral',
            value: grouped.neutral.map((r, i) => formatRelationshipLine(r, i)).join('\n').substring(0, 1024) || 'None',
            inline: false
        }]);
    }

    if (grouped.cautious.length > 0) {
        embed.addFields([{
            name: '🤨 Cautious',
            value: grouped.cautious.map((r, i) => formatRelationshipLine(r, i)).join('\n') || 'None',
            inline: false
        }]);
    }

    if (grouped.hostile.length > 0) {
        embed.addFields([{
            name: '🖕 Hostile',
            value: grouped.hostile.map((r, i) => formatRelationshipLine(r, i)).join('\n') || 'None',
            inline: false
        }]);
    }

    // Footer with stats and pagination
    const avgSentiment = relationships.reduce((sum, r) => sum + (r.sentimentScore || 0), 0) / relationships.length;
    let footerText = `Tracking ${relationships.length} users | Avg sentiment: ${avgSentiment >= 0 ? '+' : ''}${avgSentiment.toFixed(2)}`;
    
    if (totalPages > 1) {
        footerText += ` | Page ${page}/${totalPages}`;
    }

    embed.setFooter({ text: footerText });
    embed.setTimestamp();

    return embed;
}

/**
 * Creates a simple stats embed for a user's own information
 * @param {Object} userContext - User context from getUserContext()
 * @param {Object} user - Discord user object
 * @param {Array} recentSentiments - Array of recent sentiment scores
 * @returns {EmbedBuilder} Configured embed
 */
function createStatsEmbed(userContext, user, recentSentiments = []) {
    const color = getColorForAttitude(userContext.attitudeLevel);
    const emoji = getEmojiForAttitude(userContext.attitudeLevel);

    const embed = new EmbedBuilder()
        .setTitle(`${emoji} Your Stats`)
        .setColor(color)
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 128 }))
        .addFields([
            {
                name: 'Attitude Level',
                value: userContext.attitudeLevel.toUpperCase(),
                inline: true
            },
            {
                name: 'Sentiment Score',
                value: formatSentimentScore(userContext.sentimentScore),
                inline: true
            },
            {
                name: 'Interactions',
                value: userContext.interactionCount?.toString() || '0',
                inline: true
            }
        ]);

    if (recentSentiments.length > 0) {
        const trend = calculateTrend(recentSentiments);
        embed.addFields([{
            name: 'Recent Trend',
            value: `${trend.emoji} ${trend.description}`,
            inline: false
        }]);
    }

    embed.setFooter({ text: 'Your relationship with Cooler Moksi' });
    embed.setTimestamp();

    return embed;
}

/**
 * Creates an error embed
 * @param {string} title - Error title
 * @param {string} description - Error description
 * @returns {EmbedBuilder} Configured embed
 */
function createErrorEmbed(title, description) {
    return new EmbedBuilder()
        .setTitle(`❌ ${title}`)
        .setDescription(description)
        .setColor(EMBED_COLORS.ERROR)
        .setTimestamp();
}

/**
 * Creates a success embed
 * @param {string} title - Success title
 * @param {string} description - Success description
 * @returns {EmbedBuilder} Configured embed
 */
function createSuccessEmbed(title, description) {
    return new EmbedBuilder()
        .setTitle(`✅ ${title}`)
        .setDescription(description)
        .setColor(EMBED_COLORS.SUCCESS)
        .setTimestamp();
}

// ── HELPER FUNCTIONS ────────────────────────────────────────────────────────

function formatSentimentScore(score) {
    const prefix = score >= 0 ? '+' : '';
    const emoji = score > 0.5 ? '😊' : score < -0.5 ? '😠' : '😐';
    return `${emoji} ${prefix}${score.toFixed(2)}`;
}

function formatRelationshipLine(rel) {
    const hasDisplayName = rel.displayName && rel.displayName.toLowerCase() !== 'user';
    const name = hasDisplayName ? rel.displayName : `<@${rel.userId}>`;
    const emoji = getEmojiForAttitude(rel.attitudeLevel);
    const sentimentStr = rel.sentimentScore ? ` (${rel.sentimentScore > 0 ? '+' : ''}${rel.sentimentScore.toFixed(2)})` : '';
    const activeIcon = rel.isActive ? '🟢' : '';
    return `${emoji} **${name}** - ${rel.interactionCount || 0} msgs${sentimentStr} ${activeIcon}`;
}

// Classification lives in utils/trend.js (canonical 0.15 threshold; this
// copy used to drift at 0.1). Here we only map the direction to display.
function calculateTrend(sentiments) {
    const direction = trendDirection(sentiments);
    if (direction === 'rising') return { emoji: '📈', description: 'Improving' };
    if (direction === 'falling') return { emoji: '📉', description: 'Declining' };
    if (direction === 'stable') return { emoji: '➡️', description: 'Stable' };
    return { emoji: '➡️', description: 'Not enough data' };
}

module.exports = {
    createRelationshipEmbed,
    createOverviewEmbed,
    createStatsEmbed,
    createErrorEmbed,
    createSuccessEmbed
};
