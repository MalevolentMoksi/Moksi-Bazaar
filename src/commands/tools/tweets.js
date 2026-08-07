// src/commands/tools/tweets.js
// Owner-only control over the X mirror. See utils/tweetMirror.js for why this
// costs money at all, and how it is kept to roughly a euro a month.

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isOwner, OWNER_REJECTION_JOKES } = require('../../utils/constants');
const { setSpeakConfigValue } = require('../../utils/db');
const {
    runOnce,
    mirrorStatus,
    buildQuery,
    CHANNEL_KEY,
    ENABLED_KEY,
    ACCOUNTS_KEY,
    BUDGET_KEY,
    STYLE_KEY,
    POLL_INTERVAL_MS,
} = require('../../utils/tweetMirror');

const MAX_ACCOUNTS = 10;

/** "@HYPEX, ShiinaBR ,, FNFestival" becomes three clean handles. */
function parseAccounts(input) {
    return [...new Set(
        String(input)
            .split(/[\s,]+/)
            .map(s => s.trim().replace(/^@/, ''))
            .filter(s => /^[A-Za-z0-9_]{1,15}$/.test(s))
    )].slice(0, MAX_ACCOUNTS);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tweets')
        .setDescription('secret')
        .addSubcommand(sub =>
            sub.setName('here').setDescription('mirror new posts into this channel'))
        .addSubcommand(sub =>
            sub.setName('off').setDescription('stop mirroring (stops all spending)'))
        .addSubcommand(sub =>
            sub.setName('status').setDescription('what it watches, what it has spent'))
        .addSubcommand(sub =>
            sub.setName('check').setDescription('poll right now instead of waiting'))
        .addSubcommand(sub =>
            sub.setName('accounts')
                .setDescription('set which handles to watch')
                .addStringOption(opt =>
                    opt.setName('handles')
                        .setDescription('e.g. FNFestival, HYPEX, ShiinaBR')
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('budget')
                .setDescription('monthly spending cap in dollars')
                .addNumberOption(opt =>
                    opt.setName('usd')
                        .setDescription('polling stops for the month when this is hit')
                        .setMinValue(0.1)
                        .setMaxValue(20)
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('style')
                .setDescription('how a post looks in the channel')
                .addStringOption(opt =>
                    opt.setName('mode')
                        .setDescription('link: FixTweet renders it, video plays. embed: built here, always renders.')
                        .addChoices(
                            { name: 'fxtwitter link', value: 'link' },
                            { name: 'built-in embed', value: 'embed' },
                        )
                        .setRequired(true))),

    async execute(interaction) {
        if (!isOwner(interaction.user.id)) {
            const msg = OWNER_REJECTION_JOKES[Math.floor(Math.random() * OWNER_REJECTION_JOKES.length)];
            return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }

        const sub = interaction.options.getSubcommand();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (sub === 'here') {
            await setSpeakConfigValue(CHANNEL_KEY, interaction.channelId);
            await setSpeakConfigValue(ENABLED_KEY, true);
            const { accounts, hasKey } = await mirrorStatus();
            return interaction.editReply(
                `Mirroring ${accounts.map(a => `@${a}`).join(', ')} into ${interaction.channel}, `
                + `checking every ${POLL_INTERVAL_MS / 60000} minutes.`
                + (hasKey ? ' First check within a minute.' : '\n\n⚠️ `TWITTERAPI_KEY` is not set, so nothing will actually be fetched yet.')
            );
        }

        if (sub === 'off') {
            await setSpeakConfigValue(ENABLED_KEY, false);
            return interaction.editReply('Mirror off. No further requests, so no further spending. `/tweets here` restarts it.');
        }

        if (sub === 'accounts') {
            const accounts = parseAccounts(interaction.options.getString('handles'));
            if (!accounts.length) {
                return interaction.editReply('None of those look like handles. Give me names like `FNFestival, HYPEX`.');
            }
            await setSpeakConfigValue(ACCOUNTS_KEY, accounts);
            return interaction.editReply(
                `Watching ${accounts.map(a => `@${a}`).join(', ')}.\n`
                + 'They all ride in one request, so the count barely affects the bill.'
            );
        }

        if (sub === 'budget') {
            const usd = interaction.options.getNumber('usd');
            await setSpeakConfigValue(BUDGET_KEY, usd);
            const { floorUsdPerMonth } = await mirrorStatus();
            return interaction.editReply(
                `Cap set to $${usd.toFixed(2)}/month. Polling stops for the rest of the month if it is reached.\n`
                + `A month of empty checks costs about $${floorUsdPerMonth.toFixed(2)}, so that is the floor.`
            );
        }

        if (sub === 'style') {
            const mode = interaction.options.getString('mode');
            await setSpeakConfigValue(STYLE_KEY, mode);
            return interaction.editReply(mode === 'embed'
                ? 'Posts will use an embed built here: always renders, but video will not play inline.'
                : 'Posts will be fxtwitter links: FixTweet renders them, and video plays inline.');
        }

        if (sub === 'check') {
            const before = await mirrorStatus();
            if (!before.channelId) return interaction.editReply('No channel set yet. Run `/tweets here` in the channel you want.');

            const result = await runOnce(interaction.client);
            if (result.skipped) {
                return interaction.editReply(`Nothing happened: ${result.skipped}.`
                    + (result.error ? `\n\`${String(result.error).slice(0, 200)}\`` : ''));
            }
            return interaction.editReply(
                `Found ${result.found}, posted ${result.posted}.`
                + (result.dropped ? ` Skipped ${result.dropped} older ones from a burst.` : '')
                + `\nThis month: $${result.spend.usd.toFixed(4)} over ${result.spend.calls} checks.`
            );
        }

        // status
        const s = await mirrorStatus();
        const pct = s.budgetUsd > 0 ? Math.round((s.spend.usd / s.budgetUsd) * 100) : 0;
        const lines = [
            `**Channel** ${s.channelId ? `<#${s.channelId}>` : 'not set, run `/tweets here`'}`,
            `**Watching** ${s.accounts.map(a => `@${a}`).join(', ')}`,
            `**State** ${!s.hasKey ? '⚠️ no API key set' : s.enabled ? (s.running ? 'running' : 'enabled, scheduler not started') : 'off'}`,
            `**Every** ${s.intervalMs / 60000} minutes, as ${s.style === 'embed' ? 'built-in embeds' : 'fxtwitter links'}`,
            `**Last checked** ${s.sinceMs ? `<t:${Math.floor(s.sinceMs / 1000)}:R>` : 'never'}`,
            '',
            `**This month** $${s.spend.usd.toFixed(4)} of $${s.budgetUsd.toFixed(2)} (${pct}%)`,
            `${s.spend.calls} checks, ${s.spend.tweets} posts fetched. Empty months cost about $${s.floorUsdPerMonth.toFixed(2)}.`,
        ];
        if (s.accounts.length) {
            lines.push('', `\`${buildQuery(s.accounts, Math.floor((s.sinceMs || Date.now()) / 1000)).slice(0, 180)}\``);
        }
        return interaction.editReply(lines.join('\n'));
    },
};
