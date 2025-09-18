// src/commands/tools/speak_settings.js - Enhanced with Media Analysis Settings

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType, MessageFlags } = require('discord.js');

const { pool, getSettingState, getMediaAnalysisProvider, setMediaAnalysisProvider } = require('../../utils/db.js');

const OWNER_ID = '619637817294848012';

const jokes = [
    "Woah! Trying to tamper with the wires, buddy?",
    "Hands off, weirdo.",
    "Only the Supreme Goat can tweak these settings.",
    "you STINK.",
    "Shoo.",
    "You are not the guy.",
];

async function getBlacklistSummary() {
    const { rows } = await pool.query('SELECT user_id FROM speak_blacklist');
    const userIds = rows.map(r => r.user_id);
    return {
        count: userIds.length,
        preview: userIds.slice(0, 5), // Show up to 5 userIds
        all: userIds,
    };
}

async function getMediaCacheStats() {
    const { rows } = await pool.query(`
        SELECT 
            COUNT(*) as total_cached,
            COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as cached_today,
            SUM(accessed_count) as total_accesses
        FROM media_cache
    `);

    return {
        totalCached: rows[0]?.total_cached || 0,
        cachedToday: rows[0]?.cached_today || 0,
        totalAccesses: rows[0]?.total_accesses || 0
    };
}

function getMediaProviderDisplay(provider) {
    switch(provider) {
        case 'gemini': return '🔍 **Gemini Vision**';
        case 'groq': return '⚡ **Groq Vision**';  
        case 'disabled': return '❌ **Disabled**';
        default: return '❓ **Unknown**';
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('speak_settings')
        .setDescription('Show & tweak speakbot settings (owner only controls)'),

    async execute(interaction) {
        // Owner check
        if (interaction.user.id !== OWNER_ID) {
            const msg = jokes[Math.floor(Math.random() * jokes.length)];
            return await interaction.reply({ content: msg });
        }

        // Get current states
        const activeSpeak = await getSettingState('active_speak');
        const blacklist = await getBlacklistSummary();
        const mediaProvider = await getMediaAnalysisProvider();
        const mediaStats = await getMediaCacheStats();

        // Get resolved member pings for preview
        const guild = interaction.guild;
        let previewUserTags = [];

        for (const id of blacklist.preview) {
            let display = `<@${id}>`;
            try {
                const member = await guild.members.fetch(id);
                if (member) display = `<@${id}> (${member.displayName})`;
            } catch { }
            previewUserTags.push(display);
        }

        let blacklistValue = `${blacklist.count} user(s)`;
        if (blacklist.count) {
            blacklistValue += ':\n' + previewUserTags.map(x => `• ${x}`).join('\n');
            if (blacklist.count > previewUserTags.length)
                blacklistValue += `\n...and more`;
        }

        // Media cache summary
        const mediaValue = `${mediaStats.totalCached} cached | ${mediaStats.cachedToday} today | ${mediaStats.totalAccesses} accesses`;

        // Update embed with media analysis info
        const embed = new EmbedBuilder()
            .setTitle('🛠️ SpeakBot Settings')
            .setDescription('Direct admin controls for speak, blacklist, and media analysis.')
            .addFields(
                { name: 'Active Speak', value: activeSpeak ? '🟢 **ON**' : '🔴 **OFF**', inline: true },
                { name: 'Media Analysis', value: getMediaProviderDisplay(mediaProvider), inline: true },
                { name: 'Media Cache', value: mediaValue, inline: true },
                { name: 'Blacklisted Users', value: blacklistValue, inline: false },
            )
            .setFooter({ text: 'All changes here are instant & database-backed.' });

        // Row of buttons - split into two rows for more options
        const buttons1 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('speak_toggle')
                    .setLabel(activeSpeak ? 'Disable Speaking' : 'Enable Speaking')
                    .setStyle(activeSpeak ? ButtonStyle.Danger : ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('media_gemini')
                    .setLabel('Use Gemini')
                    .setStyle(mediaProvider === 'gemini' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('media_groq')  
                    .setLabel('Use Groq')
                    .setStyle(mediaProvider === 'groq' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('media_disable')
                    .setLabel('Disable Media')
                    .setStyle(mediaProvider === 'disabled' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            );

        const buttons2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('add_blacklist')
                    .setLabel('Add to Blacklist')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('remove_blacklist')
                    .setLabel('Remove from Blacklist')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('clear_media_cache')
                    .setLabel('Clear Media Cache')
                    .setStyle(ButtonStyle.Danger),
            );

        await interaction.reply({ 
            embeds: [embed], 
            components: [buttons1, buttons2], 
            flags: MessageFlags.Ephemeral
        });

        // Set up button collector – live only for the OWNER, only 2 minutes
        const msg = await interaction.fetchReply();
        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === OWNER_ID,
            time: 120_000,
        });

        collector.on('collect', async i => {
            try {
                if (i.customId === 'speak_toggle') {
                    const newState = !activeSpeak;
                    await pool.query(`
                        INSERT INTO settings (setting, state)
                        VALUES ('active_speak', $1)
                        ON CONFLICT (setting) DO UPDATE SET state = EXCLUDED.state
                    `, [newState]);
                    await i.reply({ content: `Speak is now **${newState ? 'ON' : 'OFF'}**!`, flags: MessageFlags.Ephemeral});
                    collector.stop();

                } else if (i.customId === 'media_gemini') {
                    await setMediaAnalysisProvider('gemini');
                    await i.reply({ content: `Media analysis switched to **Gemini Vision**! 🔍`, flags: MessageFlags.Ephemeral});
                    collector.stop();

                } else if (i.customId === 'media_groq') {
                    await setMediaAnalysisProvider('groq');
                    await i.reply({ content: `Media analysis switched to **Groq Vision**! ⚡`, flags: MessageFlags.Ephemeral});
                    collector.stop();

                } else if (i.customId === 'media_disable') {
                    await setMediaAnalysisProvider('disabled');
                    await i.reply({ content: `Media analysis **disabled**! ❌`, flags: MessageFlags.Ephemeral});
                    collector.stop();

                } else if (i.customId === 'clear_media_cache') {
                    const result = await pool.query('DELETE FROM media_cache');
                    const deletedCount = result.rowCount || 0;
                    await i.reply({ content: `Media cache cleared! Deleted **${deletedCount}** entries.`, flags: MessageFlags.Ephemeral});
                    collector.stop();

                } else if (i.customId === 'add_blacklist') {
                    // Show modal asking for user id
                    const modal = new ModalBuilder()
                        .setCustomId('add_blacklist_modal')
                        .setTitle('Add User to Blacklist')
                        .addComponents(
                            new ActionRowBuilder().addComponents(
                                new TextInputBuilder()
                                    .setCustomId('userid')
                                    .setLabel('User ID to blacklist')
                                    .setStyle(TextInputStyle.Short)
                                    .setPlaceholder('e.g. 123456789...')
                                    .setRequired(true)
                            )
                        );
                    await i.showModal(modal);

                } else if (i.customId === 'remove_blacklist') {
                    const modal = new ModalBuilder()
                        .setCustomId('remove_blacklist_modal')
                        .setTitle('Remove User from Blacklist')
                        .addComponents(
                            new ActionRowBuilder().addComponents(
                                new TextInputBuilder()
                                    .setCustomId('userid')
                                    .setLabel('User ID to REMOVE from blacklist')
                                    .setStyle(TextInputStyle.Short)
                                    .setPlaceholder('e.g. 123456789...')
                                    .setRequired(true)
                            )
                        );
                    await i.showModal(modal);
                }
            } catch (error) {
                console.error('Error in speak_settings button handler:', error);
                try {
                    await i.reply({ content: `Error: ${error.message}`, flags: MessageFlags.Ephemeral});
                } catch (replyError) {
                    console.error('Failed to send error reply:', replyError);
                }
            }
        });

        // Handle modals
        const client = interaction.client;
        const modalFilter = m =>
            m.user.id === OWNER_ID &&
            (m.customId === 'add_blacklist_modal' || m.customId === 'remove_blacklist_modal');

        // Set up temporary modal handler
        const handleModal = async (modalInt) => {
            if (!modalFilter(modalInt)) return;

            try {
                const userid = modalInt.fields.getTextInputValue('userid').trim();

                if (!userid.match(/^\d{17,20}$/)) {
                    return await modalInt.reply({ content: "That doesn't look like a valid user ID.", flags: MessageFlags.Ephemeral});
                }

                if (modalInt.customId === 'add_blacklist_modal') {
                    await pool.query(
                        'INSERT INTO speak_blacklist (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userid]
                    );
                    await modalInt.reply({ content: `User <@${userid}> **blacklisted!**`, flags: MessageFlags.Ephemeral});
                }

                if (modalInt.customId === 'remove_blacklist_modal') {
                    await pool.query('DELETE FROM speak_blacklist WHERE user_id = $1', [userid]);
                    await modalInt.reply({ content: `User <@${userid}> removed from blacklist.`, flags: MessageFlags.Ephemeral});
                }
            } catch (error) {
                console.error('Error in modal handler:', error);
                try {
                    await modalInt.reply({ content: `Error: ${error.message}`, flags: MessageFlags.Ephemeral});
                } catch (replyError) {
                    console.error('Failed to send modal error reply:', replyError);
                }
            }

            // Remove the handler after use
            client.off('interactionCreate', handleModal);
        };

        client.on('interactionCreate', handleModal);

        // Clean up modal handler after collector ends
        collector.on('end', () => {
            client.off('interactionCreate', handleModal);
        });
    },
};