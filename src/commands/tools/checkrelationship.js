// src/commands/tools/checkrelationship.js

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getUserContext } = require('../../utils/db.js');

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

// Generate relationship responses based on attitude level
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
                `i fucking hate ${name} and everything they do`,
                `${name} can go fuck themselves honestly`,
                `${name} is absolute trash, worst person i've dealt with`,
                `${name} makes me want to delete myself`,
                `i have zero patience left for ${name}'s bullshit`
            ];
            return {
                message: hostileResponses[Math.floor(Math.random() * hostileResponses.length)],
                emoji: Math.random() > 0.7 ? GOAT_EMOJIS.goat_puke : GOAT_EMOJIS.goat_scream
            };
            
        case 'harsh':
            const harshResponses = [
                `${name} is on thin ice with me, seriously`,
                `${name} pisses me off more often than not`,
                `i don't have much patience for ${name} anymore`,
                `${name} has been a pain in the ass lately`,
                `${name} needs to get their act together`
            ];
            return {
                message: harshResponses[Math.floor(Math.random() * harshResponses.length)],
                emoji: Math.random() > 0.6 ? GOAT_EMOJIS.goat_hurt : GOAT_EMOJIS.goat_exhausted
            };
            
        case 'wary':
            const waryResponses = [
                `${name} has been sketchy before, keeping an eye on them`,
                `i'm cautious around ${name} after last time`,
                `${name} is... questionable. not sure about them`,
                `${name} gives me weird vibes sometimes`,
                `i don't fully trust ${name} yet`
            ];
            return {
                message: waryResponses[Math.floor(Math.random() * waryResponses.length)],
                emoji: Math.random() > 0.5 ? GOAT_EMOJIS.goat_meditate : GOAT_EMOJIS.goat_sleep
            };
            
        case 'cautious':
            const cautiousResponses = [
                `${name} is alright i guess, nothing special`,
                `${name} seems fine, haven't had major issues`,
                `${name} is decent enough, no real problems`,
                `${name} is okay, could be worse`,
                `${name} doesn't annoy me too much`
            ];
            return {
                message: cautiousResponses[Math.floor(Math.random() * cautiousResponses.length)],
                emoji: Math.random() > 0.7 ? GOAT_EMOJIS.goat_small_bleat : ''
            };
            
        case 'friendly':
            const friendlyResponses = [
                `${name} is actually pretty cool`,
                `i like ${name}, they're good people`,
                `${name} is solid, no complaints`,
                `${name} gets it, they're alright with me`,
                `${name} is one of the decent ones`
            ];
            return {
                message: friendlyResponses[Math.floor(Math.random() * friendlyResponses.length)],
                emoji: Math.random() > 0.6 ? GOAT_EMOJIS.goat_smile : GOAT_EMOJIS.goat_boogie
            };
            
        case 'familiar':
            const familiarResponses = [
                `${name} and i go way back, they're solid`,
                `${name} is a regular, i respect them`,
                `${name} has been cool for ages, love having them around`,
                `${name} is practically family at this point`,
                `${name} is one of my favorites, honestly`
            ];
            return {
                message: familiarResponses[Math.floor(Math.random() * familiarResponses.length)],
                emoji: Math.random() > 0.5 ? GOAT_EMOJIS.goat_pet : GOAT_EMOJIS.goat_smile
            };
            
        default: // neutral
            const neutralResponses = [
                `${name} is fine i guess, nothing notable`,
                `${name} exists, that's about it`,
                `${name} is there, haven't really formed an opinion`,
                `${name} is just another person to me`,
                `${name} is neutral, no strong feelings either way`
            ];
            return {
                message: neutralResponses[Math.floor(Math.random() * neutralResponses.length)],
                emoji: Math.random() > 0.8 ? GOAT_EMOJIS.goat_sleep : ''
            };
    }
}

// Format the detailed stats
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
    
    if (userContext.recentTopics && userContext.recentTopics.length > 0) {
        stats.push(`**Recent Topics:** ${userContext.recentTopics.join(', ')}`);
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
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages), // Restrict to mods

    async execute(interaction) {
        await interaction.deferReply({});
        
        try {
            const targetUser = interaction.options.getUser('user');
            const showDetailed = interaction.options.getBoolean('detailed') || false;
            const isSpecialUser = targetUser.id === "619637817294848012";
            
            // Get user context from database
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
                    fields: [
                        {
                            name: 'Statistics',
                            value: detailedStats,
                            inline: false
                        }
                    ],
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
        case 'hostile': return 0xFF0000;    // Red
        case 'harsh': return 0xFF6600;     // Orange-red
        case 'wary': return 0xFFAA00;      // Orange
        case 'cautious': return 0xFFFF00;  // Yellow
        case 'friendly': return 0x66FF66;  // Light green
        case 'familiar': return 0x00FF00;  // Green
        default: return 0x888888;          // Gray (neutral)
    }
}
