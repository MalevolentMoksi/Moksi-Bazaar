// src/commands/tools/tweets_settings.js
/**
 * /tweets_settings: owner-only control panel for the X mirror.
 *
 * Same architecture as /speak_settings, minus the section picker: this has one
 * screen's worth of settings and paging them would be ceremony.
 *
 * This is the only panel in the bot whose settings cost money, so the spend
 * line is not a footnote. It shows what has been spent, what it is on track to
 * spend, and the same credit figure twitterapi.io's own dashboard shows, so
 * the two can be compared without arithmetic.
 */

const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    ChannelType, MessageFlags, PermissionsBitField,
} = require('discord.js');

const { setSpeakConfigValue } = require('../../utils/db.js');
const { OWNER_REJECTION_JOKES, isOwner, EMBED_COLORS } = require('../../utils/constants');
const { ui, retireControls, isV2Message } = require('../../utils/ui/panel');
const {
    runOnce, testFetch, mirrorStatus,
    CHANNEL_KEY, ENABLED_KEY, ACCOUNTS_KEY, BUDGET_KEY, STYLE_KEY,
    COST_PER_UNIT_USD,
} = require('../../utils/tweetMirror');
const logger = require('../../utils/logger');

const PANEL_TIMEOUT_MS = 15 * 60_000;
const PANEL_IDLE_MS = 5 * 60_000;
const MODAL_TIMEOUT_MS = 120_000;

const MAX_ACCOUNTS = 10;
/**
 * How far back "Test fetch" reaches. Long enough that silence is a real
 * signal rather than a quiet spell, short enough that the handful of posts
 * it bills for stays under a cent.
 */
const TEST_HOURS = 6;
/** twitterapi.io prices everything in credits; 100,000 of them cost a dollar. */
const CREDITS_PER_USD = 100_000;

/** "@HYPEX, ShiinaBR ,, FNFestival" becomes three clean handles. */
function parseAccounts(input) {
    return [...new Set(
        String(input)
            .split(/[\s,]+/)
            .map(s => s.trim().replace(/^@/, ''))
            .filter(s => /^[A-Za-z0-9_]{1,15}$/.test(s))
    )].slice(0, MAX_ACCOUNTS);
}

/**
 * What the bot cannot do in the target channel, in words rather than flags.
 *
 * ReadMessageHistory is in here for a reason that is easy to miss: the embed
 * repair pass works by re-reading its own message to see whether Discord
 * attached a preview. Without that permission the re-read fails, and the code
 * treats an unreadable message as fine rather than churning links, so the
 * fallback chain silently stops existing.
 *
 * @returns {string[]} empty when everything needed is granted
 */
function missingPermissions(guild, channelId) {
    const channel = guild?.channels?.cache?.get(channelId);
    const me = guild?.members?.me;
    if (!channel || !me) return [];

    const perms = channel.permissionsFor(me);
    if (!perms) return [];

    const needed = [
        [PermissionsBitField.Flags.ViewChannel, 'View Channel'],
        [PermissionsBitField.Flags.SendMessages, 'Send Messages'],
        [PermissionsBitField.Flags.EmbedLinks, 'Embed Links'],
        [PermissionsBitField.Flags.ReadMessageHistory, 'Read Message History'],
    ];
    return needed.filter(([flag]) => !perms.has(flag)).map(([, label]) => label);
}

function bar(fraction, width = 14) {
    const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * What this month ends at if the rest of it looks like the part already spent.
 * Returns null early in the month, when the sample is too small to mean
 * anything and a projection would just be a scary number.
 */
function projectMonth(spentUsd, now = new Date()) {
    const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
    const elapsed = (now.getUTCDate() - 1) + (now.getUTCHours() / 24);
    if (elapsed < 0.5 || spentUsd <= 0) return null;
    return (spentUsd / elapsed) * daysInMonth;
}

async function promptModal(componentInteraction, { title, inputs }) {
    const modalId = `tw_modal_${componentInteraction.id}`;
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(title.slice(0, 45));

    for (const input of inputs) {
        const builder = new TextInputBuilder()
            .setCustomId(input.id)
            .setLabel(input.label.slice(0, 45))
            .setStyle(input.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(input.required ?? false);
        if (input.value !== undefined && input.value !== null) builder.setValue(String(input.value).slice(0, 4000));
        if (input.placeholder) builder.setPlaceholder(input.placeholder.slice(0, 100));
        if (input.maxLength) builder.setMaxLength(input.maxLength);
        modal.addComponents(new ActionRowBuilder().addComponents(builder));
    }

    await componentInteraction.showModal(modal);
    try {
        return await componentInteraction.awaitModalSubmit({
            filter: m => m.customId === modalId && m.user.id === componentInteraction.user.id,
            time: MODAL_TIMEOUT_MS,
        });
    } catch {
        return null;
    }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function render(s) {
    const live = s.hasKey && s.enabled && Boolean(s.channelId);
    const overBudget = s.spend.usd >= s.budgetUsd;

    let colour = EMBED_COLORS.NEUTRAL;
    if (overBudget) colour = EMBED_COLORS.ERROR;
    else if (live) colour = EMBED_COLORS.SUCCESS;
    else if (!s.hasKey) colour = EMBED_COLORS.WARNING;

    let headline;
    if (!s.hasKey) headline = '⚠️ No `TWITTERAPI_KEY` set, so nothing is fetched. Add it in Railway and redeploy.';
    else if (!s.channelId) headline = 'Pick a channel below and it starts within a minute.';
    else if (overBudget) headline = `🔴 **Monthly cap reached.** Paused until ${s.spend.month === new Date().toISOString().slice(0, 7) ? 'next month' : 'the cap is raised'}, or raise it below.`;
    else if (!s.enabled) headline = 'Switched off. Nothing is fetched, so nothing is spent.';
    else headline = `Watching ${s.accounts.length} account${s.accounts.length === 1 ? '' : 's'} in one request every ${s.intervalMs / 60000} minutes.`;

    const pct = s.budgetUsd > 0 ? s.spend.usd / s.budgetUsd : 0;
    const credits = Math.round(s.spend.usd * CREDITS_PER_USD);
    const projected = projectMonth(s.spend.usd);

    const embed = new EmbedBuilder()
        .setTitle('🐦 Tweet mirror')
        .setColor(colour)
        .setDescription(headline)
        .addFields(
            {
                name: 'Channel',
                value: s.channelId ? `<#${s.channelId}>` : '*none*',
                inline: true,
            },
            ...(s.missingPerms?.length ? [{
                name: '⚠️ Cannot post there',
                value: `Missing **${s.missingPerms.join('**, **')}**. Posts are held, not dropped, `
                    + 'so fixing this brings back the last couple of hours.',
                inline: false,
            }] : []),
            {
                name: 'State',
                value: !s.hasKey ? '⚠️ no key' : s.enabled ? (s.running ? '🟢 Running' : '🟡 On, not scheduled') : '⚪ Off',
                inline: true,
            },
            {
                name: 'Posts as',
                value: s.style === 'embed' ? 'built-in embed' : 'fxtwitter link',
                inline: true,
            },
            {
                name: 'Watching',
                value: s.accounts.length ? s.accounts.map(a => `[@${a}](https://fxtwitter.com/${a})`).join(' · ') : '*nobody*',
                inline: false,
            },
            {
                name: `Spent this month (${s.spend.month})`,
                value: [
                    `\`${bar(pct)}\` **$${s.spend.usd.toFixed(4)}** of $${s.budgetUsd.toFixed(2)}`,
                    // Locale pinned: bare toLocaleString() follows the host, so
                    // this panel would group digits differently on Railway than
                    // it does on a French Windows box.
                    `${credits.toLocaleString('en-US')} credits · ${s.spend.calls} checks · ${s.spend.tweets} posts fetched`,
                    projected
                        ? `On track for **$${projected.toFixed(2)}** this month${projected > s.budgetUsd ? ' ⚠️ over cap' : ''}`
                        : `A month of empty checks costs about $${s.floorUsdPerMonth.toFixed(2)}`,
                ].join('\n'),
                inline: false,
            },
            {
                name: 'Last checked',
                value: s.sinceMs ? `<t:${Math.floor(s.sinceMs / 1000)}:R>` : 'never',
                inline: true,
            },
            {
                name: 'Per check',
                value: `$${COST_PER_UNIT_USD.toFixed(5)} when nothing is new`,
                inline: true,
            },
        );

    const rows = [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId('tw_channel')
                .setPlaceholder(s.channelId ? 'Move the mirror to another channel…' : 'Choose where posts go…')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setMinValues(1)
                .setMaxValues(1)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('tw_toggle')
                .setLabel(s.enabled ? 'Turn off' : 'Turn on')
                .setStyle(s.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
                .setDisabled(!s.channelId),
            new ButtonBuilder()
                .setCustomId('tw_check')
                .setLabel('Check now')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(!s.hasKey || !s.channelId),
            new ButtonBuilder()
                .setCustomId('tw_test')
                .setLabel('Test fetch')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(!s.hasKey),
            new ButtonBuilder().setCustomId('tw_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tw_accounts').setLabel('Edit accounts').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('tw_budget').setLabel('Monthly cap').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('tw_style')
                .setLabel(s.style === 'embed' ? 'Use fxtwitter links' : 'Use built-in embeds')
                .setStyle(ButtonStyle.Secondary)
        ),
    ];

    return { embed, rows };
}

/**
 * Turns a test fetch into a verdict rather than a row of numbers.
 *
 * The reason this exists at all: "0 posts fetched" is what a healthy mirror
 * looks like on a quiet quarter of an hour AND what a broken one looks like
 * forever. Six hours of silence from three accounts that post hourly is not
 * ambiguous, so say so plainly instead of printing a zero and leaving it to
 * be interpreted.
 */
function testReport(r) {
    if (!r.ok) {
        return `❌ Could not test: ${r.reason}.`
            + (r.error ? `\n\`${String(r.error).slice(0, 250)}\`` : '')
            + (r.reason === 'no TWITTERAPI_KEY set'
                ? '\nSet it in Railway and redeploy.'
                : '');
    }

    const head = `Looked back **${r.hoursBack}h**. `;
    const cost = `\n-# This check: $${r.callUsd.toFixed(5)}. `
        + `Month so far: $${r.spend.usd.toFixed(4)} of $${r.budgetUsd.toFixed(2)}.`;

    if (r.found === 0) {
        return `${head}⚠️ **Found nothing.**\n`
            + 'Three accounts posting hourly should not be silent that long, so this is '
            + 'more likely a wrong handle or a rejected query than a quiet day. '
            + 'The exact query was:\n'
            + `\`\`\`${r.query.slice(0, 300)}\`\`\``
            + cost;
    }

    const breakdown = Object.entries(r.perAccount)
        .sort((a, b) => b[1] - a[1])
        .map(([handle, n]) => `@${handle} ${n}`)
        .join(' · ');

    const newest = r.newest;
    // X appends its own t.co link for whatever media the post carries. Left in
    // the quote, Discord unfurls it too and the report grows a second, worse
    // embed above the one that is the actual proof.
    const quoted = (newest.text || '[no text]')
        .replace(/https?:\/\/t\.co\/\w+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);

    return `${head}✅ **Found ${r.found}${r.more ? '+' : ''} posts.**\n`
        + `${breakdown}\n`
        + (r.more ? '-# That is one page; there were more in the window than a single request returns.\n' : '')
        + (r.silent?.length
            ? `-# Nothing from ${r.silent.map(a => `@${a}`).join(', ')} in that window, which is normal for a low-volume account and also what a typo looks like.\n`
            : '')
        + `\nNewest, <t:${Math.floor(newest.atMs / 1000)}:R>:\n`
        + `> ${quoted || '[no text]'}\n`
        + `${newest.url}\n`
        + 'Nothing was posted to the channel and the cursor did not move, so the '
        + 'next real check still picks up from where it was.'
        + cost;
}

async function buildPanel(guild = null) {
    const state = await mirrorStatus();
    // Re-checked on every render rather than once at setup, because a
    // permission can be taken away long after the channel was chosen and the
    // symptom of that is an empty channel, not an error.
    state.missingPerms = state.channelId ? missingPermissions(guild, state.channelId) : [];
    const { embed, rows } = render(state);
    return { state, embed, rows };
}

// ── Command ─────────────────────────────────────────────────────────────────

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tweets_settings')
        .setDescription('Admin controls for the X mirror'),

    async execute(interaction) {
        if (!isOwner(interaction.user.id)) {
            const msg = OWNER_REJECTION_JOKES[Math.floor(Math.random() * OWNER_REJECTION_JOKES.length)];
            return await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const opening = await buildPanel(interaction.guild);
        const message = await interaction.editReply(ui(opening.embed, opening.rows, { scope: 'speak' }));

        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && isOwner(i.user.id),
            time: PANEL_TIMEOUT_MS,
            idle: PANEL_IDLE_MS,
        });

        const refresh = async (respondTo) => {
            const rebuilt = await buildPanel(interaction.guild);
            const next = ui(rebuilt.embed, rebuilt.rows, { like: message });
            const canUpdate = respondTo && !respondTo.replied && !respondTo.deferred
                && (typeof respondTo.isFromMessage !== 'function' || respondTo.isFromMessage());
            if (canUpdate) {
                try { await respondTo.update(next); return; } catch { /* fall through */ }
            }
            await interaction.editReply(next).catch(() => {});
            if (respondTo && !respondTo.replied && !respondTo.deferred) {
                await respondTo.deferUpdate?.().catch(() => {});
            }
        };

        collector.on('collect', async (i) => {
            try {
                const id = i.customId;

                if (id === 'tw_refresh') return refresh(i);

                if (id === 'tw_channel') {
                    const channelId = i.values[0];
                    await setSpeakConfigValue(CHANNEL_KEY, channelId);
                    // Choosing a channel is the whole setup, so it implies
                    // wanting it on; leaving it off here would look broken.
                    await setSpeakConfigValue(ENABLED_KEY, true);
                    logger.info('[TWEETS] Channel set', { channelId, by: i.user.id });
                    await refresh(i);

                    // Checked now rather than discovered later. A missing
                    // permission here does not fail loudly at post time: the
                    // panel goes on saying Running and the spend goes on
                    // ticking, and the only symptom is an empty channel.
                    const missing = missingPermissions(i.guild, channelId);
                    if (missing.length) {
                        return i.followUp({
                            content: `⚠️ The bot is missing **${missing.join('**, **')}** in <#${channelId}>.\n`
                                + 'Nothing will appear there until that is fixed. Posts are held rather '
                                + 'than dropped in the meantime, so fixing it brings back the last couple of hours.',
                            flags: MessageFlags.Ephemeral,
                        }).catch(() => {});
                    }
                    return undefined;
                }

                if (id === 'tw_toggle') {
                    const { enabled } = await mirrorStatus();
                    await setSpeakConfigValue(ENABLED_KEY, !enabled);
                    logger.info('[TWEETS] Toggled', { enabled: !enabled, by: i.user.id });
                    return refresh(i);
                }

                if (id === 'tw_style') {
                    const { style } = await mirrorStatus();
                    await setSpeakConfigValue(STYLE_KEY, style === 'embed' ? 'link' : 'embed');
                    return refresh(i);
                }

                if (id === 'tw_check') {
                    // A real request, so a real (tiny) charge. Deferring first
                    // because the round trip is well past Discord's 3s window.
                    await i.deferUpdate().catch(() => {});
                    const result = await runOnce(interaction.client);
                    await refresh(null);
                    const note = result.skipped
                        ? `Nothing happened: ${result.skipped}.${result.error ? `\n\`${String(result.error).slice(0, 200)}\`` : ''}`
                        : `Found ${result.found}, posted ${result.posted}.`
                        + (result.dropped ? ` Skipped ${result.dropped} older ones from a burst.` : '');
                    return i.followUp({ content: note, flags: MessageFlags.Ephemeral }).catch(() => {});
                }

                if (id === 'tw_test') {
                    await i.deferUpdate().catch(() => {});
                    const r = await testFetch({ hoursBack: TEST_HOURS });
                    await refresh(null);
                    return i.followUp({ content: testReport(r), flags: MessageFlags.Ephemeral }).catch(() => {});
                }

                if (id === 'tw_accounts') {
                    const { accounts } = await mirrorStatus();
                    const submit = await promptModal(i, {
                        title: 'Accounts to mirror',
                        inputs: [{
                            id: 'handles',
                            label: 'Handles, separated by commas',
                            value: accounts.join(', '),
                            placeholder: 'FNFestival, HYPEX, ShiinaBR',
                            paragraph: true,
                            required: true,
                            maxLength: 300,
                        }],
                    });
                    if (!submit) return;

                    const parsed = parseAccounts(submit.fields.getTextInputValue('handles'));
                    if (!parsed.length) {
                        return submit.reply({
                            content: 'None of those look like handles. Names only, like `FNFestival, HYPEX`.',
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                    await setSpeakConfigValue(ACCOUNTS_KEY, parsed);
                    logger.info('[TWEETS] Accounts set', { accounts: parsed, by: i.user.id });
                    await submit.deferUpdate().catch(() => {});
                    return refresh(null);
                }

                if (id === 'tw_budget') {
                    const { budgetUsd } = await mirrorStatus();
                    const submit = await promptModal(i, {
                        title: 'Monthly spending cap',
                        inputs: [{
                            id: 'usd',
                            label: 'Dollars per month',
                            value: budgetUsd.toFixed(2),
                            placeholder: '2.00',
                            required: true,
                            maxLength: 8,
                        }],
                    });
                    if (!submit) return;

                    const usd = Number(String(submit.fields.getTextInputValue('usd')).replace(/[^0-9.]/g, ''));
                    if (!Number.isFinite(usd) || usd <= 0 || usd > 50) {
                        return submit.reply({
                            content: 'Give me a number between 0 and 50.',
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                    await setSpeakConfigValue(BUDGET_KEY, usd);
                    logger.info('[TWEETS] Budget set', { usd, by: i.user.id });
                    await submit.deferUpdate().catch(() => {});
                    return refresh(null);
                }

                if (!i.replied && !i.deferred) await i.deferUpdate().catch(() => {});
            } catch (error) {
                logger.error('tweets_settings interaction failed', { customId: i.customId, error: error.message, stack: error.stack });
                const notice = { content: '⚠️ That action failed. Check the logs.', flags: MessageFlags.Ephemeral };
                if (i.replied || i.deferred) await i.followUp(notice).catch(() => {});
                else await i.reply(notice).catch(() => {});
            }
        });

        collector.on('end', async () => {
            const notice = 'Panel timed out. Run /tweets_settings again to make more changes.';

            if (isV2Message(message)) {
                const last = await buildPanel(interaction.guild).catch(() => null);
                if (last?.embed) {
                    last.embed.setFooter({ text: notice });
                    await interaction.editReply(ui(last.embed, [], { like: message })).catch(() => {});
                } else {
                    await interaction.editReply(retireControls(message)).catch(() => {});
                }
                return;
            }
            await interaction.editReply({ components: [], content: `*${notice}*` }).catch(() => {});
        });
    },

    // Exported for the tests; the command loader ignores anything but data/execute.
    parseAccounts,
    projectMonth,
    render,
    testReport,
};
