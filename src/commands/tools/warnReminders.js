const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const {
    getAllWarnReminders,
    deleteWarnReminder,
    scheduleNext,
} = require('../../utils/warnReminderScheduler');

const WARN_GUILD_ID = '1271818662839451699';

async function buildListEmbed(client) {
    const reminders = await getAllWarnReminders();

    if (reminders.length === 0) {
        return { content: 'No pending warn reminders.', embeds: [], components: [] };
    }

    const embed = new EmbedBuilder()
        .setTitle('Pending Warn Reminders')
        .setColor(0x5865F2)
        .setTimestamp()
        .setFooter({ text: 'Click a button to cancel a reminder' });

    const buttons = [];

    for (let i = 0; i < Math.min(reminders.length, 10); i++) {
        const r = reminders[i];
        const epoch = Math.floor(Number(r.due_at_utc_ms) / 1000);
        const count = r.warn_count || 1;
        const ids   = r.warn_ids ? r.warn_ids.split(',').map(id => `#${id}`).join(', ') : null;

        const channel = await client.channels.fetch(r.channel_id).catch(() => null);
        const channelText = channel ? `<#${channel.id}>` : 'unknown channel';

        const fieldName = count > 1 ? `${r.warned_user} (${count} warns)` : r.warned_user;
        const idLine    = ids ? `\nCases: ${ids}` : '';
        const value     = `Due <t:${epoch}:F> (<t:${epoch}:R>)\nChannel: ${channelText}${idLine}`;

        embed.addFields({ name: fieldName, value, inline: false });

        buttons.push(
            new ButtonBuilder()
                .setCustomId(`cancel_warn_${r.id}`)
                .setLabel(`Cancel #${i + 1}`)
                .setStyle(ButtonStyle.Danger)
        );
    }

    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    return { content: null, embeds: [embed], components: rows };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warnreminders')
        .setDescription('View and cancel pending warn reminders')
        .addSubcommand(sub =>
            sub.setName('list').setDescription('Show all pending warn reminders')
        ),

    async execute(interaction) {
        if (interaction.guildId !== WARN_GUILD_ID) {
            return interaction.reply({ content: 'This command is not available here.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const { content, embeds, components } = await buildListEmbed(interaction.client);

        if (!embeds.length) {
            return interaction.editReply({ content });
        }

        const reply = await interaction.editReply({ embeds, components });

        const collector = reply.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: 300_000,
        });

        collector.on('collect', async btn => {
            if (!btn.customId.startsWith('cancel_warn_')) return;
            const reminderId = btn.customId.replace('cancel_warn_', '');
            try {
                await deleteWarnReminder(reminderId);
                await scheduleNext(interaction.client);
                const refreshed = await buildListEmbed(interaction.client);
                if (!refreshed.embeds.length) {
                    await btn.update({ content: 'No pending warn reminders.', embeds: [], components: [] });
                    collector.stop();
                } else {
                    await btn.update(refreshed);
                }
            } catch {
                await btn.reply({ content: 'Failed to cancel reminder.', flags: MessageFlags.Ephemeral });
            }
        });

        collector.on('end', async () => {
            const disabledRows = components.map(row => {
                const newRow = new ActionRowBuilder();
                row.components.forEach(btn => newRow.addComponents(ButtonBuilder.from(btn).setDisabled(true)));
                return newRow;
            });
            await interaction.editReply({ components: disabledRows }).catch(() => {});
        });
    },
};
