// src/commands/tools/speak_settings.js - Refactored with New Utilities
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { pool, getSettingState } = require('../../utils/db.js');
const { OWNER_REJECTION_JOKES, isOwner, EMBED_COLORS, TIMEOUTS } = require('../../utils/constants');
const { handleCommandError } = require('../../utils/errorHandler');
const logger = require('../../utils/logger');

async function getBlacklistSummary() {
    const { rows } = await pool.query('SELECT user_id FROM speak_blacklist');
    const userIds = rows.map(r => r.user_id);
    return { count: userIds.length, preview: userIds.slice(0, 5) };
}

async function getMediaCacheStats() {
    const { rows } = await pool.query(`
        SELECT COUNT(*) as total_cached,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as cached_today
        FROM media_cache
    `);
    return { totalCached: rows[0]?.total_cached || 0, cachedToday: rows[0]?.cached_today || 0 };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('speak_settings')
        .setDescription('Admin controls for Cooler Moksi'),

    async execute(interaction) {
        // Humorous rejection for non-owners
        if (!isOwner(interaction.user.id)) {
            const msg = OWNER_REJECTION_JOKES[Math.floor(Math.random() * OWNER_REJECTION_JOKES.length)];
            return await interaction.reply({ content: msg, ephemeral: true });
        }

        // Fetch States
        const [activeSpeak, activeMedia, blacklist, mediaStats] = await Promise.all([
            getSettingState('active_speak'),
            getSettingState('active_media_analysis'),
            getBlacklistSummary(),
            getMediaCacheStats()
        ]);

        // Build Embed
        const embed = new EmbedBuilder()
            .setTitle('🛠️ Moksi Brain Settings')
            .setColor(EMBED_COLORS.INFO)
            .addFields(
                { name: '🗣️ Speak System', value: activeSpeak ? '🟢 **ONLINE**' : '🔴 **OFFLINE**', inline: true },
                { name: '👁️ Vision (OpenRouter)', value: activeMedia ? '🟢 **ONLINE**' : '🔴 **OFFLINE**', inline: true },
                { name: '📦 Media Cache', value: `${mediaStats.totalCached} items (${mediaStats.cachedToday} new today)`, inline: false },
                { name: '🚫 Blacklist', value: `${blacklist.count} users`, inline: true }
            );

        // Buttons
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('toggle_speak')
                .setLabel(activeSpeak ? 'Silence Bot' : 'Enable Bot')
                .setStyle(activeSpeak ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('toggle_media')
                .setLabel(activeMedia ? 'Disable Vision' : 'Enable Vision')
                .setStyle(activeMedia ? ButtonStyle.Secondary : ButtonStyle.Primary)
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('add_bl').setLabel('Block User').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('rem_bl').setLabel('Unblock User').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('clear_cache').setLabel('Purge Vision Cache').setStyle(ButtonStyle.Danger)
        );

        const reply = await interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });

        // Collector
        const collector = reply.createMessageComponentCollector({ time: TIMEOUTS.BUTTON_COLLECTOR });

        collector.on('collect', async i => {
            if (!isOwner(i.user.id)) return;

            try {
                if (i.customId === 'toggle_speak') {
                    const newState = !activeSpeak;
                    await pool.query(`
                        INSERT INTO settings (setting, state) VALUES ('active_speak', $1) 
                        ON CONFLICT (setting) DO UPDATE SET state = EXCLUDED.state
                    `, [newState]);
                    logger.info('Speak system toggled', { newState, by: i.user.id });
                    await i.update({ content: `✅ Speak is now ${newState ? 'ON' : 'OFF'}`, embeds: [], components: [] });
                } 
                
                else if (i.customId === 'toggle_media') {
                    const newState = !activeMedia;
                    await pool.query(`
                        INSERT INTO settings (setting, state) VALUES ('active_media_analysis', $1) 
                        ON CONFLICT (setting) DO UPDATE SET state = EXCLUDED.state
                    `, [newState]);
                    logger.info('Media analysis toggled', { newState, by: i.user.id });
                    await i.update({ content: `✅ Vision is now ${newState ? 'ON' : 'OFF'}`, embeds: [], components: [] });
                }

                else if (i.customId === 'clear_cache') {
                    const { rowCount } = await pool.query('DELETE FROM media_cache');
                    logger.info('Media cache cleared', { deleted: rowCount, by: i.user.id });
                    await i.reply({ content: `✅ Purged ${rowCount} cached items.`, ephemeral: true });
                }

                else if (i.customId === 'add_bl' || i.customId === 'rem_bl') {
                    const action = i.customId === 'add_bl' ? 'Add' : 'Remove';
                    const modal = new ModalBuilder()
                        .setCustomId(`modal_${i.customId}`)
                        .setTitle(`${action} Blacklist`)
                        .addComponents(new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('uid')
                                .setLabel('User ID')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                        ));
                    await i.showModal(modal);
                }
            } catch (error) {
                logger.error('Settings button interaction error', { error: error.message, customId: i.customId });
                await i.reply({ content: 'An error occurred. Check logs.', ephemeral: true }).catch(() => {});
            }
        });

        // Modal Handler (using awaitModalSubmit pattern)
        collector.on('collect', async i => {
            if (i.customId === 'add_bl' || i.customId === 'rem_bl') {
                try {
                    const submitted = await interaction.awaitModalSubmit({
                        filter: m => m.user.id === interaction.user.id && m.customId.startsWith('modal_'),
                        time: TIMEOUTS.MODAL_SUBMIT
                    });

                    const uid = submitted.fields.getTextInputValue('uid');
                    
                    if (submitted.customId === 'modal_add_bl') {
                        await pool.query('INSERT INTO speak_blacklist (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [uid]);
                        logger.info('User added to blacklist', { userId: uid, by: interaction.user.id });
                        await submitted.reply({ content: `✅ <@${uid}> blocked.`, ephemeral: true });
                    } else {
                        await pool.query('DELETE FROM speak_blacklist WHERE user_id = $1', [uid]);
                        logger.info('User removed from blacklist', { userId: uid, by: interaction.user.id });
                        await submitted.reply({ content: `✅ <@${uid}> unblocked.`, ephemeral: true });
                    }
                } catch (error) {
                    if (error.message?.includes('time')) {
                        logger.debug('Modal submission timeout');
                    } else {
                        logger.error('Modal submission error', { error: error.message });
                    }
                }
            }
        });

        collector.on('end', () => {
            logger.debug('Settings collector ended');
        });
    }
};