// src/commands/tools/speak_settings.js

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType } = require('discord.js');
const { pool, getSettingState } = require('../../utils/db.js');

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
            // Sassy refusal, NOT ephemeral:
            return await interaction.reply({ content: msg, ephemeral: false });
        }

        // Get current states
        const activeSpeak = await getSettingState('active_speak');
        const blacklist = await getBlacklistSummary();

        // 1. Get resolved member pings for preview
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

        // Update embed
        const embed = new EmbedBuilder()
            .setTitle('🛠️ SpeakBot Settings')
            .setDescription('Direct admin controls for speak and blacklist.')
            .addFields(
                { name: 'Active Speak', value: activeSpeak ? '🟢 **ON**' : '🔴 **OFF**', inline: true },
                { name: 'Blacklisted Users', value: blacklistValue, inline: true },
            )
            .setFooter({ text: 'All changes here are instant & database-backed.' });


        // Row of buttons
        const buttons = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('speak_toggle')
                    .setLabel(activeSpeak ? 'Disable Speaking' : 'Enable Speaking')
                    .setStyle(activeSpeak ? ButtonStyle.Danger : ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('add_blacklist')
                    .setLabel('Add to Blacklist')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('remove_blacklist')
                    .setLabel('Remove from Blacklist')
                    .setStyle(ButtonStyle.Secondary),
            );

        await interaction.reply({ embeds: [embed], components: [buttons], ephemeral: true });

        // Set up button collector – live only for the OWNER, only 1 minute
        const msg = await interaction.fetchReply();
        const collector = msg.createMessageComponentCollector({
            filter: i => i.user.id === OWNER_ID,
            time: 60_000,
        });

        collector.on('collect', async i => {
            if (i.customId === 'speak_toggle') {
                const newState = !activeSpeak;
                await pool.query(`
          INSERT INTO settings (setting, state)
          VALUES ('active_speak', $1)
          ON CONFLICT (setting) DO UPDATE SET state = EXCLUDED.state
        `, [newState]);
                await i.reply({ content: `Speak is now **${newState ? 'ON' : 'OFF'}**!`, ephemeral: true });
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
        });

        // Handle modals
        // Only want modal submissions from this user and this interaction – so outside of collector, setup a filter on client.once
        const client = interaction.client;
        const modalFilter = m =>
            m.user.id === OWNER_ID &&
            (m.customId === 'add_blacklist_modal' || m.customId === 'remove_blacklist_modal');
        // Multiple modals could be active, but limit is fine
        client.on('interactionCreate', async modalInt => {
            if (!modalFilter(modalInt)) return;
            const userid = modalInt.fields.getTextInputValue('userid').trim();
            if (!userid.match(/^\d{17,20}$/)) {
                return await modalInt.reply({ content: "That doesn't look like a valid user ID.", ephemeral: true });
            }
            if (modalInt.customId === 'add_blacklist_modal') {
                await pool.query(
                    'INSERT INTO speak_blacklist (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userid]
                );
                await modalInt.reply({ content: `User <@${userid}> **blacklisted!**`, ephemeral: true });
            }
            if (modalInt.customId === 'remove_blacklist_modal') {
                await pool.query('DELETE FROM speak_blacklist WHERE user_id = $1', [userid]);
                await modalInt.reply({ content: `User <@${userid}> removed from blacklist.`, ephemeral: true });
            }
        });

    }
};
