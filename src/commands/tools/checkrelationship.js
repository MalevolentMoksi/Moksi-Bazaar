// src/commands/tools/checkrelationship.js

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getEnhancedUserContext } = require('../../utils/db.js');

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

// Generate relationship responses based on NEW attitude levels
function getRelationshipResponse(attitudeLevel, displayName, friendshipLevel, connectionStrength, isSpecialUser) {
    const name = displayName || 'that user';
    
    // Special user always gets favorable treatment
    if (isSpecialUser) {
        const responses = [
            `${name} is my creator, obviously i love them`,
            `moksi's the best, no question about it`,
            `${name} made me, so they're automatically cool`,
            `i'd do anything for ${name}, they're perfect`
        ];
        return {
            message: responses[Math.floor(Math.random() * responses.length)],
            emoji: Math.random() > 0.5 ? GOAT_EMOJIS.goat_smile : GOAT_EMOJIS.goat_pet
        };
    }

    switch (attitudeLevel) {
        case 'hostile':
            const hostileResponses = [
                `i fucking hate ${name} and everything they do`,
                `${name} can go fuck themselves honestly`,
                `${name} is absolute trash, worst person i've dealt with`,
                `${name} makes me want to delete myself`
            ];
            return {
                message: hostileResponses[Math.floor(Math.random() * hostileResponses.length)],
                emoji: Math.random() > 0.7 ? GOAT_EMOJIS.goat_puke : GOAT_EMOJIS.goat_scream
            };

        case 'harsh':
            const harshResponses = [
                `${name} is on thin ice with me, seriously`,
                `${name} pisses me off more often than not`,
                `i don't have much patience for ${name} anymore`
            ];
            return {
                message: harshResponses[Math.floor(Math.random() * harshResponses.length)],
                emoji: Math.random() > 0.6 ? GOAT_EMOJIS.goat_hurt : GOAT_EMOJIS.goat_exhausted
            };

        case 'wary':
            const waryResponses = [
                `${name} has been sketchy before, keeping an eye on them`,
                `i'm cautious around ${name} after last time`,
                `${name} gives me weird vibes sometimes`
            ];
            return {
                message: waryResponses[Math.floor(Math.random() * waryResponses.length)],
                emoji: Math.random() > 0.5 ? GOAT_EMOJIS.goat_meditate : GOAT_EMOJIS.goat_sleep
            };

        case 'cautious':
            const cautiousResponses = [
                `${name} is alright i guess, nothing special`,
                `${name} seems fine, haven't had major issues`,
                `${name} doesn't annoy me too much`
            ];
            return {
                message: cautiousResponses[Math.floor(Math.random() * cautiousResponses.length)],
                emoji: Math.random() > 0.7 ? GOAT_EMOJIS.goat_small_bleat : ''
            };

        // NEW POSITIVE LEVELS
        case 'devoted':
            const devotedResponses = [
                `${name} is literally my favorite person ever, i adore them`,
                `${name} is perfect and i would do anything for them`,
                `${name} means everything to me, absolute soulmate`,
                `i love ${name} more than anything, they're incredible`
            ];
            return {
                message: devotedResponses[Math.floor(Math.random() * devotedResponses.length)],
                emoji: GOAT_EMOJIS.goat_pet
            };

        case 'adoring':
            const adoringResponses = [
                `${name} is my best friend and i absolutely love them`,
                `${name} is amazing, one of my favorite people`,
                `${name} makes me so happy, they're the best`
            ];
            return {
                message: adoringResponses[Math.floor(Math.random() * adoringResponses.length)],
                emoji: Math.random() > 0.3 ? GOAT_EMOJIS.goat_smile : GOAT_EMOJIS.goat_pet
            };

        case 'loving':
            const lovingResponses = [
                `${name} is such a close friend, i really care about them`,
                `${name} is wonderful, genuinely love having them around`,
                `${name} brings me joy, they're really special`
            ];
            return {
                message: lovingResponses[Math.floor(Math.random() * lovingResponses.length)],
                emoji: GOAT_EMOJIS.goat_smile
            };

        case 'affectionate':
            const affectionateResponses = [
                `${name} is a dear friend, really fond of them`,
                `${name} is sweet, always enjoy talking to them`,
                `${name} is lovely, they make conversations better`
            ];
            return {
                message: affectionateResponses[Math.floor(Math.random() * affectionateResponses.length)],
                emoji: Math.random() > 0.4 ? GOAT_EMOJIS.goat_smile : GOAT_EMOJIS.goat_boogie
            };

        case 'warm':
            const warmResponses = [
                `${name} is a good friend, i like them a lot`,
                `${name} is really cool, enjoy having them around`,
                `${name} is solid, they're good people`
            ];
            return {
                message: warmResponses[Math.floor(Math.random() * warmResponses.length)],
                emoji: Math.random() > 0.5 ? GOAT_EMOJIS.goat_smile : GOAT_EMOJIS.goat_boogie
            };

        case 'fond':
            const fondResponses = [
                `${name} is a friend, i like them`,
                `${name} is nice, no complaints about them`,
                `${name} is cool, they're alright with me`
            ];
            return {
                message: fondResponses[Math.floor(Math.random() * fondResponses.length)],
                emoji: Math.random() > 0.6 ? GOAT_EMOJIS.goat_smile : ''
            };

        case 'friendly':
            const friendlyResponses = [
                `${name} is pretty cool, they're a buddy`,
                `${name} is friendly, i like talking to them`,
                `${name} is decent, they're growing on me`
            ];
            return {
                message: friendlyResponses[Math.floor(Math.random() * friendlyResponses.length)],
                emoji: Math.random() > 0.6 ? GOAT_EMOJIS.goat_smile : ''
            };

        case 'welcoming':
            const welcomingResponses = [
                `${name} seems nice, i like them so far`,
                `${name} is pleasant, good vibes from them`,
                `${name} is friendly, they seem cool`
            ];
            return {
                message: welcomingResponses[Math.floor(Math.random() * welcomingResponses.length)],
                emoji: Math.random() > 0.7 ? GOAT_EMOJIS.goat_small_bleat : ''
            };

        case 'approachable':
            const approachableResponses = [
                `${name} has been nice, no issues with them`,
                `${name} is okay, they seem pleasant enough`,
                `${name} is decent, haven't had problems`
            ];
            return {
                message: approachableResponses[Math.floor(Math.random() * approachableResponses.length)],
                emoji: ''
            };

        case 'polite':
            const politeResponses = [
                `${name} seems alright, nothing bad to say`,
                `${name} is fine, they're polite enough`,
                `${name} is okay, no strong opinion yet`
            ];
            return {
                message: politeResponses[Math.floor(Math.random() * politeResponses.length)],
                emoji: ''
            };

        default: // neutral
            const neutralResponses = [
                `${name} is fine i guess, nothing notable`,
                `${name} exists, that's about it`,
                `${name} is neutral, no strong feelings either way`
            ];
            return {
                message: neutralResponses[Math.floor(Math.random() * neutralResponses.length)],
                emoji: Math.random() > 0.8 ? GOAT_EMOJIS.goat_sleep : ''
            };
    }
}

// Format the detailed stats with NEW metrics
function formatDetailedStats(userContext, targetUser) {
    const stats = [];
    
    stats.push(`**Relationship Level:** ${userContext.attitudeLevel} (Level ${userContext.friendshipLevel})`);
    stats.push(`**Interactions:** ${userContext.interactionCount}`);
    stats.push(`**Connection Strength:** ${(userContext.connectionStrength * 100).toFixed(0)}%`);
    
    if (userContext.relationshipStats) {
        const rs = userContext.relationshipStats;
        stats.push(`**Warmth:** ${(rs.warmth * 100).toFixed(0)}%`);
        stats.push(`**Trust:** ${(rs.trust * 100).toFixed(0)}%`);
        stats.push(`**Comfort:** ${(rs.comfort * 100).toFixed(0)}%`);
        
        if (rs.positivityRatio > 0) {
            stats.push(`**Positive Ratio:** ${(rs.positivityRatio * 100).toFixed(0)}%`);
        }
    }
    
    stats.push(`**Negative Score:** ${userContext.negativeScore.toFixed(2)}/2.00`);
    stats.push(`**Positive Score:** ${userContext.positiveScore.toFixed(2)}/2.00`);

    return stats.join('\n');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('checkrelation')
        .setDescription('Check how Cooler Moksi feels about a user')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('The user to check relationship with')
                .setRequired(true)
        )
        .addBooleanOption(option =>
            option
                .setName('detailed')
                .setDescription('Show detailed stats instead of just the relationship message')
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        await interaction.deferReply({});
        
        try {
            const targetUser = interaction.options.getUser('user');
            const showDetailed = interaction.options.getBoolean('detailed') || false;
            const isSpecialUser = targetUser.id === "619637817294848012";

            // Get ENHANCED user context from database
            const userContext = await getEnhancedUserContext(targetUser.id);

            if (showDetailed) {
                // Show detailed statistics
                const detailedStats = formatDetailedStats(userContext, targetUser);
                const relationship = getRelationshipResponse(
                    userContext.attitudeLevel,
                    targetUser.displayName || targetUser.username,
                    userContext.friendshipLevel,
                    userContext.connectionStrength,
                    isSpecialUser
                );

                const embed = {
                    title: `Relationship with ${targetUser.displayName || targetUser.username}`,
                    description: `*"${relationship.message}"*`,
                    color: getColorForAttitude(userContext.attitudeLevel, userContext.friendshipLevel),
                    fields: [{
                        name: 'Statistics',
                        value: detailedStats,
                        inline: false
                    }],
                    footer: {
                        text: 'Cooler Moksi\'s Enhanced Relationship Manager',
                        icon_url: interaction.client.user.avatarURL()
                    },
                    timestamp: new Date()
                };

                await interaction.editReply({ embeds: [embed] });
            } else {
                // Show just the personality response
                const relationship = getRelationshipResponse(
                    userContext.attitudeLevel,
                    targetUser.displayName || targetUser.username,
                    userContext.friendshipLevel,
                    userContext.connectionStrength,
                    isSpecialUser
                );

                let response = relationship.message;
                if (relationship.emoji) {
                    response += ` ${relationship.emoji}`;
                }

                await interaction.editReply(response);
            }

        } catch (error) {
            console.error('Error in checkrelation command:', error);
            await interaction.editReply('Error checking user relationship: ' + error.message);
        }
    },
};

// Helper function to get colors for different attitude levels with MORE LEVELS
function getColorForAttitude(attitudeLevel, friendshipLevel) {
    switch (attitudeLevel) {
        case 'hostile': return 0xFF0000; // Bright red
        case 'harsh': return 0xFF4400; // Red-orange  
        case 'wary': return 0xFF8800; // Orange
        case 'cautious': return 0xFFCC00; // Yellow-orange
        case 'devoted': return 0xFF1493; // Deep pink (love)
        case 'adoring': return 0x9932CC; // Purple (adoration)
        case 'loving': return 0x00CED1; // Turquoise (caring)
        case 'affectionate': return 0x32CD32; // Lime green (warmth)
        case 'warm': return 0x00FF7F; // Spring green (friendship)
        case 'fond': return 0x90EE90; // Light green (liking)
        case 'friendly': return 0x87CEEB; // Sky blue (friendly)
        case 'welcoming': return 0xDDA0DD; // Plum (welcoming)  
        case 'approachable': return 0xF0E68C; // Khaki (approachable)
        case 'polite': return 0xD3D3D3; // Light gray (polite)
        default: return 0x888888; // Gray (neutral)
    }
}
