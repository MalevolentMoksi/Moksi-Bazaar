const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const {
    getAllWarnReminders,
    deleteWarnReminder,
    scheduleNext,
} = require('../../utils/warnReminderScheduler');
const { isOwner } = require('../../utils/constants');
const { ui, retireControls, isV2Message } = require('../../utils/ui/panel');

const WARN_GUILD_ID = '1271818662839451699';
const EMPTY_TEXT = 'No pending warn reminders.';

/**
 * Components V2 forbids `content` outright, so the empty state cannot stay a
 * bare string once a panel is rendering that way. On classic embeds it still
 * is one, exactly as before.
 */
function emptyPayload(message) {
    if (message && isV2Message(message)) {
        return ui(new EmbedBuilder().setDescription(EMPTY_TEXT), [], { like: message });
    }
    return { content: EMPTY_TEXT, embeds: [], components: [] };
}

async function buildListEmbed(client) {
    // Scoped to the guild the command is locked to: the table can hold other
    // guilds' reminders, and this panel's cancel buttons must not reach them.
    const reminders = await getAllWarnReminders(WARN_GUILD_ID);

    if (reminders.length === 0) {
        return { embed: null, rows: [] };
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

    return { embed, rows };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warnreminders')
        .setDescription('View and cancel pending warn reminders')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub =>
            sub.setName('list').setDescription('Show all pending warn reminders')
        ),

    async execute(interaction) {
        if (!isOwner(interaction.user.id)) {
            return interaction.reply({ content: 'Only the bot owner can use this command.', flags: MessageFlags.Ephemeral });
        }

        if (interaction.guildId !== WARN_GUILD_ID) {
            return interaction.reply({ content: 'This command is not available here.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const { embed, rows: components } = await buildListEmbed(interaction.client);

        if (!embed) {
            return interaction.editReply({ content: EMPTY_TEXT });
        }

        const reply = await interaction.editReply(ui(embed, components, { scope: 'mod' }));

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
                if (!refreshed.embed) {
                    await btn.update(emptyPayload(btn.message));
                    collector.stop();
                } else {
                    await btn.update(ui(refreshed.embed, refreshed.rows, { like: btn.message }));
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
            await interaction.editReply(retireControls(reply, disabledRows)).catch(() => {});
        });
    },
};
