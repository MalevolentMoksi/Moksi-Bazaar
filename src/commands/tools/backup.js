// src/commands/tools/backup.js
// Owner-only control over database dumps. See utils/backup.js for the format.

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { isOwner, OWNER_REJECTION_JOKES } = require('../../utils/constants');
const { getSpeakConfigValue, setSpeakConfigValue } = require('../../utils/db');
const {
    sendBackup,
    getBackupChannelId,
    setBackupChannelId,
    LAST_RUN_KEY,
} = require('../../utils/backup');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('backup')
        .setDescription('Database dumps: post one now, or set where the weekly one goes')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub =>
            sub.setName('now').setDescription('post a database dump in this channel right now'))
        .addSubcommand(sub =>
            sub.setName('here').setDescription('send the weekly backup to this channel'))
        .addSubcommand(sub =>
            sub.setName('off').setDescription('stop the weekly backup'))
        .addSubcommand(sub =>
            sub.setName('status').setDescription('where backups go and when the last one ran')),

    async execute(interaction) {
        if (!isOwner(interaction.user.id)) {
            const msg = OWNER_REJECTION_JOKES[Math.floor(Math.random() * OWNER_REJECTION_JOKES.length)];
            return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }

        const sub = interaction.options.getSubcommand();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (sub === 'now') {
            const result = await sendBackup(interaction.client, { channelId: interaction.channelId });
            if (!result.ok) return interaction.editReply(`Backup failed: ${result.errors.join(' ')}`);
            await setSpeakConfigValue(LAST_RUN_KEY, Date.now());
            return interaction.editReply(
                `Posted: ${result.meta.totalRows.toLocaleString()} rows across `
                + `${result.meta.tables} tables, ${(result.meta.bytes / 1024).toFixed(0)} KB.`
            );
        }

        if (sub === 'here') {
            await setBackupChannelId(interaction.channelId);
            return interaction.editReply(
                `Weekly dumps and snapshots will be filed in ${interaction.channel}, and will stop `
                + 'DMing you. The first one lands within six hours. Mute the channel; you should never '
                + 'need to look at it.'
            );
        }

        if (sub === 'off') {
            const had = await getBackupChannelId();
            await setBackupChannelId(null);
            return interaction.editReply(
                had
                    ? 'Archive channel cleared. Weekly dumps go back to your DMs, since they have to go somewhere.'
                    : 'There was no archive channel. Weekly dumps land in your DMs.'
            );
        }

        // status
        const channelId = await getBackupChannelId();
        const last = Number(await getSpeakConfigValue(LAST_RUN_KEY, 0)) || 0;
        const lastText = last ? `<t:${Math.floor(last / 1000)}:R>` : 'never';
        return interaction.editReply(
            (channelId
                ? `Weekly dumps are filed in <#${channelId}>; you are only DMed if that fails.`
                : 'Weekly dumps are DMed to you. `/backup here` in a quiet channel stops that.')
            + ` Last run: ${lastText}.`
        );
    },
};
