// src/commands/tools/pay.js
/**
 * Hand money to another player.
 *
 * Deliberately untaxed. The shop is where currency is supposed to leave the
 * economy; skimming gifts as well would just make people stop using this and
 * go back to losing coin flips to each other on purpose.
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { transferBalance, getBalance } = require('../../utils/db');
const { EMBED_COLORS } = require('../../utils/constants');
const logger = require('../../utils/logger');

const money = n => `$${Number(n).toLocaleString()}`;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pay')
        .setDescription('Give some of your money to someone else')
        .addUserOption(opt => opt
            .setName('user').setDescription('who gets it').setRequired(true))
        .addIntegerOption(opt => opt
            .setName('amount').setDescription('how much').setRequired(true).setMinValue(1)),

    async execute(interaction) {
        const from = interaction.user;
        const to = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');

        if (to.id === from.id) {
            return interaction.reply({
                content: 'Moving money from your left pocket to your right pocket.',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (to.bot) {
            return interaction.reply({
                content: 'Bots have no use for money. I would know.',
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply();

        // transferBalance moves both sides in one transaction, taking the two
        // rows in a fixed order so two simultaneous transfers cannot deadlock.
        // null means the sender's funds were gone by the time it ran.
        const transfer = await transferBalance(from.id, to.id, amount);
        if (!transfer) {
            const balance = await getBalance(from.id);
            return interaction.editReply(
                `You have ${money(balance)}. That does not cover ${money(amount)}.`
            );
        }

        logger.info('Payment sent', { from: from.id, to: to.id, amount });

        return interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(EMBED_COLORS.SUCCESS)
                .setDescription(`${from} handed ${to} **${money(amount)}**.`)
                .setFooter({ text: `${from.username} now has $${transfer.fromBalance.toLocaleString()}` })],
        });
    },
};
