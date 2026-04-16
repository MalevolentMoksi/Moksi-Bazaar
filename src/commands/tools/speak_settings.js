// src/commands/tools/speak_settings.js - Refactored with New Utilities
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
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

async function getMemoryStats() {
    const { rows } = await pool.query(`
        SELECT
            (SELECT COUNT(*) FROM conversation_memories) AS total_memories,
            (SELECT COUNT(*) FROM conversation_memories WHERE is_context_only = false) AS real_exchanges,
            (SELECT COUNT(*) FROM user_preferences WHERE interaction_count > 0) AS tracked_users
    `);
    const r = rows[0] || {};
    return {
        totalMemories: Number(r.total_memories) || 0,
        realExchanges: Number(r.real_exchanges) || 0,
        trackedUsers:  Number(r.tracked_users)  || 0
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('speak_settings')
        .setDescription('Admin controls for Cooler Moksi'),

    async execute(interaction) {
        // Humorous rejection for non-owners
        if (!isOwner(interaction.user.id)) {
            const msg = OWNER_REJECTION_JOKES[Math.floor(Math.random() * OWNER_REJECTION_JOKES.length)];
            return await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }

        // Fetch States
        const [activeSpeak, activeMedia, blacklist, mediaStats, memoryStats] = await Promise.all([
            getSettingState('active_speak'),
            getSettingState('active_media_analysis'),
            getBlacklistSummary(),
            getMediaCacheStats(),
            getMemoryStats()
        ]);

        // Build Embed
        const embed = new EmbedBuilder()
            .setTitle('🛠️ Moksi Brain Settings')
            .setColor(EMBED_COLORS.INFO)
            .addFields(
                { name: '🗣️ Speak System', value: activeSpeak ? '🟢 **ONLINE**' : '🔴 **OFFLINE**', inline: true },
                { name: '👁️ Vision (OpenRouter)', value: activeMedia ? '🟢 **ONLINE**' : '🔴 **OFFLINE**', inline: true },
                { name: '📦 Media Cache', value: `${mediaStats.totalCached} items (${mediaStats.cachedToday} new today)`, inline: false },
                { name: '🧠 Memory', value: `${memoryStats.realExchanges} real / ${memoryStats.totalMemories} total | ${memoryStats.trackedUsers} users tracked`, inline: false },
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
            new ButtonBuilder().setCustomId('reset_user').setLabel('Reset User Attitude').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('clear_cache').setLabel('Purge Vision Cache').setStyle(ButtonStyle.Danger)
        );

        const reply = await interaction.reply({ embeds: [embed], components: [row1, row2], flags: MessageFlags.Ephemeral });

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
                    await i.reply({ content: `✅ Purged ${rowCount} cached items.`, flags: MessageFlags.Ephemeral });
                }

                else if (i.customId === 'reset_user') {
                    const modalId = `modal_reset_${Date.now()}`;
                    const modal = new ModalBuilder()
                        .setCustomId(modalId)
                        .setTitle('Reset User Attitude')
                        .addComponents(new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('uid')
                                .setLabel('User ID to reset to neutral')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                        ));
                    await i.showModal(modal);
                    try {
                        const submitted = await i.awaitModalSubmit({
                            filter: m => m.customId === modalId,
                            time: TIMEOUTS.MODAL_SUBMIT
                        });
                        const uid = submitted.fields.getTextInputValue('uid').trim();
                        const { rowCount } = await pool.query(`
                            UPDATE user_preferences
                            SET sentiment_score = 0, attitude_level = 'neutral', last_sentiment_update = NOW(), updated_at = NOW()
                            WHERE user_id = $1
                        `, [uid]);
                        if (rowCount > 0) {
                            logger.info('User attitude reset', { userId: uid, by: interaction.user.id });
                            await submitted.reply({ content: `✅ Reset <@${uid}> to neutral (sentiment 0).`, flags: MessageFlags.Ephemeral });
                        } else {
                            await submitted.reply({ content: `⚠️ No record found for <@${uid}>.`, flags: MessageFlags.Ephemeral });
                        }
                    } catch (modalError) {
                        if (!modalError.message?.includes('time')) {
                            logger.error('Reset modal error', { error: modalError.message });
                        }
                    }
                }

                else if (i.customId === 'add_bl' || i.customId === 'rem_bl') {
                    const action = i.customId === 'add_bl' ? 'Add' : 'Remove';
                    const modalId = `modal_${i.customId}_${Date.now()}`;
                    const modal = new ModalBuilder()
                        .setCustomId(modalId)
                        .setTitle(`${action} Blacklist`)
                        .addComponents(new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('uid')
                                .setLabel('User ID')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                        ));
                    await i.showModal(modal);

                    // Await the modal submission directly after showing it
                    try {
                        const submitted = await i.awaitModalSubmit({
                            filter: m => m.customId === modalId,
                            time: TIMEOUTS.MODAL_SUBMIT
                        });

                        const uid = submitted.fields.getTextInputValue('uid');

                        if (i.customId === 'add_bl') {
                            await pool.query('INSERT INTO speak_blacklist (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [uid]);
                            logger.info('User added to blacklist', { userId: uid, by: interaction.user.id });
                            await submitted.reply({ content: `✅ <@${uid}> blocked.`, flags: MessageFlags.Ephemeral });
                        } else {
                            await pool.query('DELETE FROM speak_blacklist WHERE user_id = $1', [uid]);
                            logger.info('User removed from blacklist', { userId: uid, by: interaction.user.id });
                            await submitted.reply({ content: `✅ <@${uid}> unblocked.`, flags: MessageFlags.Ephemeral });
                        }
                    } catch (modalError) {
                        if (modalError.message?.includes('time')) {
                            logger.debug('Modal submission timeout');
                        } else {
                            logger.error('Modal submission error', { error: modalError.message });
                        }
                    }
                }
            } catch (error) {
                logger.error('Settings button interaction error', { error: error.message, customId: i.customId });
                await i.reply({ content: 'An error occurred. Check logs.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        });

        collector.on('end', () => {
            logger.debug('Settings collector ended');
        });
    }
};