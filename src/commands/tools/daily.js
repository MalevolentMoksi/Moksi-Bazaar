// src/commands/tools/daily.js
/**
 * A daily stipend with a streak.
 *
 * The point is a reason to come back that is not gambling, and a floor under
 * players who have busted out; /currency beg only pays when you are at exactly
 * zero, which makes being nearly broke worse than being broke.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { adjustBalance, claimDaily, getDailyState } = require('../../utils/db');
const { getSetting } = require('../../utils/casinoConfig');
const { ui } = require('../../utils/ui/panel');
const { EMBED_COLORS } = require('../../utils/constants');
const logger = require('../../utils/logger');

const money = n => `$${Number(n).toLocaleString()}`;

/** Payout grows with the streak and then stops, so day 400 is not absurd. */
async function payoutFor(streak) {
    const base = await getSetting('daily_base');
    const bonus = await getSetting('daily_streak_bonus');
    const cap = await getSetting('daily_streak_cap');
    return base + Math.min(streak, cap) * bonus;
}

/** Something to notice on the way past a round number. */
function milestone(streak) {
    if (streak === 7) return 'A full week. Consistency, from you. Noted.';
    if (streak === 30) return 'Thirty days straight. That is a habit now, for better or worse.';
    if (streak === 100) return 'One hundred days. I genuinely did not expect this to happen.';
    if (streak === 365) return 'A year. Every single day. I have no joke for this one.';
    if (streak % 100 === 0) return `${streak} days. Still here.`;
    return null;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('daily')
        .setDescription('Claim your daily cash, and keep a streak going'),

    async execute(interaction) {
        const userId = interaction.user.id;
        await interaction.deferReply();

        let result;
        try {
            result = await claimDaily(userId);
        } catch (error) {
            logger.error('Daily claim failed', { userId, error: error.message });
            return interaction.editReply('Something went wrong claiming that. Nothing was paid out; try again.');
        }

        if (!result.claimed) {
            const state = await getDailyState(userId);
            // Reset is midnight UTC, which Discord will render in the reader's
            // own timezone rather than making them do the arithmetic.
            const nextReset = new Date();
            nextReset.setUTCHours(24, 0, 0, 0);
            const stamp = Math.floor(nextReset.getTime() / 1000);
            const claimed = new EmbedBuilder()
                .setColor(EMBED_COLORS.NEUTRAL)
                .setTitle('Already claimed today')
                .setDescription(`Next one <t:${stamp}:R>.`)
                .addFields(
                    { name: 'Streak', value: `${state?.streak ?? 0} days`, inline: true },
                    { name: 'Best', value: `${state?.bestStreak ?? 0} days`, inline: true },
                );
            return interaction.editReply(ui(claimed, [], { scope: 'casino' }));
        }

        const amount = await payoutFor(result.streak);
        const balance = await adjustBalance(userId, amount);

        const embed = new EmbedBuilder()
            .setColor(EMBED_COLORS.SUCCESS)
            .setTitle(`Daily: ${money(amount)}`)
            .addFields(
                { name: 'Streak', value: `${result.streak} day${result.streak === 1 ? '' : 's'}`, inline: true },
                { name: 'Best', value: `${result.bestStreak} days`, inline: true },
                { name: 'Balance', value: money(balance ?? amount), inline: true },
            );

        const notes = [];
        if (result.broke) notes.push('Your old streak lapsed, so this starts again at one.');
        const note = milestone(result.streak);
        if (note) notes.push(note);
        if (notes.length) embed.setDescription(notes.join(' '));

        embed.setFooter({ text: `${result.totalClaims} claimed in total` });

        logger.info('Daily claimed', { userId, amount, streak: result.streak });
        return interaction.editReply(ui(embed, [], { scope: 'casino' }));
    },
};
