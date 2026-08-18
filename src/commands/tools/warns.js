// src/commands/tools/warns.js
/**
 * Reads back the durable warn record kept by dynoWarnListener.
 *
 * Until now the only thing the bot did with a warn was fire a single reminder
 * days later and then forget it, so "how many times has this person been
 * warned" had no answer anywhere.
 */

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { getWarns } = require('../../utils/db');
const { isOwner, OWNER_REJECTION_JOKES, EMBED_COLORS } = require('../../utils/constants');
const { ui } = require('../../utils/ui/panel');
const logger = require('../../utils/logger');

const RECENT_WINDOW_MS = 90 * 86_400_000;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warns')
        .setDescription('Read back what a member has been warned for, and when')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addUserOption(opt => opt
            .setName('user').setDescription('whose warns').setRequired(false))
        .addStringOption(opt => opt
            .setName('name').setDescription('a name, for warns recorded before the account was resolved')
            .setRequired(false))
        .addBooleanOption(opt => opt
            .setName('show_removed').setDescription('include warns staff later removed with ?delwarn')
            .setRequired(false)),

    async execute(interaction) {
        if (!isOwner(interaction.user.id)) {
            const msg = OWNER_REJECTION_JOKES[Math.floor(Math.random() * OWNER_REJECTION_JOKES.length)];
            return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }
        if (!interaction.guildId) {
            return interaction.reply({ content: 'Server only.', flags: MessageFlags.Ephemeral });
        }

        const user = interaction.options.getUser('user');
        const name = interaction.options.getString('name');
        if (!user && !name) {
            return interaction.reply({
                content: 'Give me a user or a name.',
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const showRemoved = interaction.options.getBoolean('show_removed') ?? false;
            const warns = await getWarns(interaction.guildId, {
                userId: user?.id ?? null,
                // The label search is exact, not a wildcard: a bare "a" should
                // not return the whole server.
                label: name ?? (user ? user.username : null),
                includeRemoved: showRemoved,
            }, 25);

            const subject = user ? `${user.username}` : name;
            if (!warns.length) {
                return interaction.editReply(`No warns on file for **${subject}**.`
                    + (showRemoved ? '' : '\n-# Removed warns are hidden; `show_removed` includes them.'));
            }

            // The window count from the query, not the page length: "25 on
            // file" for a member with 60 warns was a lie the LIMIT told.
            const total = warns[0]?.total ?? warns.length;
            const active = warns.filter(w => !w.removedAtMs);
            const recent = active.filter(w => Date.now() - w.createdAtMs < RECENT_WINDOW_MS).length;
            const embed = new EmbedBuilder()
                .setColor(recent >= 3 ? EMBED_COLORS.ERROR : recent >= 1 ? EMBED_COLORS.WARNING : EMBED_COLORS.NEUTRAL)
                .setTitle(`Warns: ${subject}`)
                .setDescription(
                    (showRemoved
                        ? `**${total}** ever filed, **${active.length}** still standing, **${recent}** in the last 90 days.`
                        : `**${total}** on file, **${recent}** in the last 90 days.`)
                    + (user ? '' : '\n-# Matched by name; warns recorded under another name are not shown.')
                );

            for (const warn of warns.slice(0, 10)) {
                const when = `<t:${Math.floor(warn.createdAtMs / 1000)}:R>`;
                const bits = [when];
                if (warn.moderator) bits.push(`by ${warn.moderator}`);
                if (warn.removedAtMs) {
                    bits.push(`removed <t:${Math.floor(warn.removedAtMs / 1000)}:R>`
                        + (warn.removedBy ? ` by ${warn.removedBy}` : ''));
                }
                embed.addFields({
                    name: (warn.removedAtMs ? '🗑 ' : '') + (warn.caseId ? `Case #${warn.caseId}` : 'No case number'),
                    value: `${bits.join(' · ')}\n${warn.reason ? `-# ${warn.reason.slice(0, 200)}` : '-# no reason recorded'}`,
                    inline: false,
                });
            }

            if (total > 10) {
                embed.setFooter({ text: `Showing the 10 most recent of ${total}` });
            }

            return interaction.editReply(ui(embed, [], { scope: 'mod' }));
        } catch (error) {
            logger.error('Warn lookup failed', { error: error.message, stack: error.stack });
            return interaction.editReply(`Could not read that: ${error.message}`);
        }
    },
};
