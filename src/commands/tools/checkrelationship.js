// src/commands/tools/checkrelationship.js

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getUserContext } = require('../../utils/db.js'); // Use the function that exists

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

// ENHANCED: More distinct personality responses
function getRelationshipResponse(attitudeLevel, displayName, negativeScore, hostileCount, isSpecialUser) {
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
                `i fucking despise ${name}, they're genuinely awful`,
                `${name} can go die in a fire for all i care`,
                `${name} is human garbage, absolute waste of space`,
                `${name} makes me want to delete myself just to avoid them`,
                `i'd rather talk to a brick wall than deal with ${name}'s bullshit`
            ];
            return {
                message: hostileResponses[Math.floor(Math.random() * hostileResponses.length)],
                emoji: Math.random() > 0.7 ? GOAT_EMOJIS.goat_puke : GOAT_EMOJIS.goat_scream
            };

        case 'harsh':
            const harshResponses = [
                `${name} is on very thin ice with me, seriously considering blocking them`,
                `${name} consistently pisses me off, they're becoming unbearable`,
                `i have zero patience left for ${name}'s constant bullshit`,
                `${name} is a massive pain in the ass and getting worse`,
                `${name} needs to seriously get their act together or fuck off`
            ];
            return {
                message: harshResponses[Math.floor(Math.random() * harshResponses.length)],
                emoji: Math.random() > 0.6 ? GOAT_EMOJIS.goat_hurt : GOAT_EMOJIS.goat_exhausted
            };

        case 'wary':
            const waryResponses = [
                `${name} has been sketchy before, keeping a close eye on them`,
                `i'm genuinely cautious around ${name} after their past behavior`,
                `${name} gives me bad vibes, something feels off about them`,
                `${name} is questionable at best, don't really trust them yet`,
                `${name} has shown red flags, staying guarded around them`
            ];
            return {
                message: waryResponses[Math.floor(Math.random() * waryResponses.length)],
                emoji: Math.random() > 0.5 ? GOAT_EMOJIS.goat_meditate : GOAT_EMOJIS.goat_sleep
            };

        case 'cautious':
            const cautiousResponses = [
                `${name} is... fine i guess, nothing particularly impressive`,
                `${name} seems decent enough but hasn't proven themselves yet`,
                `${name} is okay but i'm not going out of my way for them`,
                `${name} doesn't actively annoy me, which is something i suppose`,
                `${name} is tolerable but unremarkable, very meh overall`
            ];
            return {
                message: cautiousResponses[Math.floor(Math.random() * cautiousResponses.length)],
                emoji: Math.random() > 0.7 ? GOAT_EMOJIS.goat_small_bleat : ''
            };

        case 'friendly':
            const friendlyResponses = [
                `${name} is actually pretty cool, i genuinely enjoy talking to them`,
                `${name} is solid people, they've proven themselves to be decent`,
                `${name} gets it, they're definitely alright with me`,
                `${name} is one of the good ones, no major complaints`,
                `${name} has grown on me, they're becoming a proper friend`
            ];
            return {
                message: friendlyResponses[Math.floor(Math.random() * friendlyResponses.length)],
                emoji: Math.random() > 0.6 ? GOAT_EMOJIS.goat_smile : GOAT_EMOJIS.goat_boogie
            };

        case 'familiar':
            const familiarResponses = [
                `${name} and i go way back, they're genuinely one of my favorites`,
                `${name} is a longtime friend, i really respect and care about them`,
                `${name} has been consistently awesome, love having them around`,
                `${name} is practically family at this point, they mean a lot to me`,
                `${name} is one of my absolute favorites, they're just incredible`
            ];
            return {
                message: familiarResponses[Math.floor(Math.random() * familiarResponses.length)],
                emoji: Math.random() > 0.5 ? GOAT_EMOJIS.goat_pet : GOAT_EMOJIS.goat_smile
            };

        default: // neutral - MORE CYNICAL
            const neutralResponses = [
                `${name} is... whatever, just another person i guess`,
                `${name} exists, that's about all i can say for them`,
                `${name} hasn't impressed me yet, pretty unremarkable honestly`,
                `${name} is fine i suppose, though they haven't earned my interest`,
                `${name} is neutral at best, haven't seen anything worth caring about`
            ];
            return {
                message: neutralResponses[Math.floor(Math.random() * neutralResponses.length)],
                emoji: Math.random() > 0.8 ? GOAT_EMOJIS.goat_sleep : ''
            };
    }
}

// FIXED: Include recent topics again
function formatDetailedStats(userContext, targetUser) {
    const stats = [];
    
    stats.push(`**Relationship Level:** ${userContext.attitudeLevel}`);
    stats.push(`**Interactions:** ${userContext.interactionCount}`);
    stats.push(`**Negative Score:** ${userContext.negativeScore.toFixed(2)}/1.00`);
    stats.push(`**Hostile Incidents:** ${userContext.hostileCount}`);

    if (userContext.lastNegativeInteraction) {
        const lastIncident = new Date(userContext.lastNegativeInteraction);
        const timeSince = Math.floor((Date.now() - lastIncident.getTime()) / (1000 * 60 * 60 * 24));
        stats.push(`**Last Incident:** ${timeSince} days ago`);
    }

    // RESTORED: Recent topics display
    if (userContext.recentTopics && userContext.recentTopics.length > 0) {
        const topics = userContext.recentTopics.slice(-8).join(', ');
        stats.push(`**Recent Topics:** ${topics}`);
    }

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

            // FIXED: Use the function that actually exists
            const userContext = await getUserContext(targetUser.id);

            if (showDetailed) {
                // Show detailed statistics
                const detailedStats = formatDetailedStats(userContext, targetUser);
                const relationship = getRelationshipResponse(
                    userContext.attitudeLevel,
                    targetUser.displayName || targetUser.username,
                    userContext.negativeScore,
                    userContext.hostileCount,
                    isSpecialUser
                );

                const embed = {
                    title: `Relationship with ${targetUser.displayName || targetUser.username}`,
                    description: `*"${relationship.message}"*`,
                    color: getColorForAttitude(userContext.attitudeLevel),
                    fields: [{
                        name: 'Statistics',
                        value: detailedStats,
                        inline: false
                    }],
                    footer: {
                        text: 'Cooler Moksi\'s Relationship Manager',
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
                    userContext.negativeScore,
                    userContext.hostileCount,
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

// Helper function to get colors for different attitude levels
function getColorForAttitude(attitudeLevel) {
    switch (attitudeLevel) {
        case 'hostile': return 0xFF0000; // Bright red
        case 'harsh': return 0xFF6600; // Orange-red
        case 'wary': return 0xFFAA00; // Orange
        case 'cautious': return 0xFFCC00; // Yellow-orange
        case 'friendly': return 0x66FF66; // Light green
        case 'familiar': return 0x00FF00; // Green
        default: return 0x666666; // Darker gray for more cynical neutral
    }
}
