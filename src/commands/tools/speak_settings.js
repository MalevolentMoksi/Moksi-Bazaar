// src/commands/tools/speak_settings.js - Humorous Rejection Restored + Unified Settings
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { pool, getSettingState } = require('../../utils/db.js');

const OWNER_ID = '619637817294848012';

// 1. REINSTATED: The Joke List
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
        // 2. REINSTATED: The Humorous Rejection Logic
        if (interaction.user.id !== OWNER_ID) {
            const msg = jokes[Math.floor(Math.random() * jokes.length)];
            // Using ephemeral: true so we don't spam the chat with rejection messages
            return await interaction.reply({ content: msg, ephemeral: true });
        }

        // Fetch States
        const activeSpeak = await getSettingState('active_speak');
        const activeMedia = await getSettingState('active_media_analysis');
        const blacklist = await getBlacklistSummary();
        const mediaStats = await getMediaCacheStats();

        // Build Embed
        const embed = new EmbedBuilder()
            .setTitle('🛠️ Moksi Brain Settings')
            .setColor('#00ff00')
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
        const collector = reply.createMessageComponentCollector({ time: 60000 });

        collector.on('collect', async i => {
            if (i.user.id !== OWNER_ID) return;

            if (i.customId === 'toggle_speak') {
                const newState = !activeSpeak;
                await pool.query(`INSERT INTO settings (setting, state) VALUES ('active_speak', $1) 
                    ON CONFLICT (setting) DO UPDATE SET state = EXCLUDED.state`, [newState]);
                await i.update({ content: `Speak is now ${newState ? 'ON' : 'OFF'}`, components: [] });
            } 
            
            else if (i.customId === 'toggle_media') {
                const newState = !activeMedia;
                await pool.query(`INSERT INTO settings (setting, state) VALUES ('active_media_analysis', $1) 
                    ON CONFLICT (setting) DO UPDATE SET state = EXCLUDED.state`, [newState]);
                await i.update({ content: `Vision is now ${newState ? 'ON' : 'OFF'}`, components: [] });
            }

            else if (i.customId === 'clear_cache') {
                await pool.query('DELETE FROM media_cache');
                await i.reply({ content: 'Cache purged.', ephemeral: true });
            }

            else if (i.customId === 'add_bl' || i.customId === 'rem_bl') {
                const action = i.customId === 'add_bl' ? 'Add' : 'Remove';
                const modal = new ModalBuilder()
                    .setCustomId(`modal_${i.customId}`)
                    .setTitle(`${action} Blacklist`)
                    .addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('uid').setLabel('User ID').setStyle(TextInputStyle.Short).setRequired(true)
                    ));
                await i.showModal(modal);
            }
        });

        // Modal Handler (attached to client for this instance)
        const filter = (i) => i.user.id === OWNER_ID && i.customId.startsWith('modal_');
        
        // Remove existing listeners to prevent duplicates if command is run multiple times
        const modalListener = async m => {
            if (!m.isModalSubmit() || !filter(m)) return;
            
            const uid = m.fields.getTextInputValue('uid');
            if (m.customId === 'modal_add_bl') {
                await pool.query('INSERT INTO speak_blacklist (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [uid]);
                await m.reply({ content: `<@${uid}> blocked.`, ephemeral: true });
            } else {
                await pool.query('DELETE FROM speak_blacklist WHERE user_id = $1', [uid]);
                await m.reply({ content: `<@${uid}> unblocked.`, ephemeral: true });
            }
        };

        interaction.client.on('interactionCreate', modalListener);

        // Cleanup listener after collector ends
        collector.on('end', () => {
            interaction.client.off('interactionCreate', modalListener);
        });
    }
};