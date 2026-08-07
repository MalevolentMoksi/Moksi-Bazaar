// src/commands/tools/casino.js
/**
 * The books.
 *
 * Every game funnels its settled rounds into game_stats, and this is where you
 * read them back. The profile deliberately leads with net position rather than
 * with a win rate: a win rate flatters anyone who wins small and loses big,
 * which is most people at a blackjack table.
 */

const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, ComponentType, MessageFlags,
} = require('discord.js');
const {
    getGameStats, getCasinoLeaders, getBalance, getDailyState, getInventory,
} = require('../../utils/db');
const { bestTitle } = require('../../utils/shopCatalogue');
const { getAllSettings, setSetting, DEFAULTS, LIMITS } = require('../../utils/casinoConfig');
const { lastHeckleResult } = require('../../utils/casinoHeckle');
const { ui, retireControls } = require('../../utils/ui/panel');
const { promptModal } = require('../../utils/panelHelpers');
const { isOwner, OWNER_REJECTION_JOKES, EMBED_COLORS } = require('../../utils/constants');
const logger = require('../../utils/logger');

const PANEL_TIMEOUT_MS = 300_000;

const money = n => `$${Number(n).toLocaleString()}`;
function signed(n) {
    const v = Number(n);
    return `${v > 0 ? '+' : v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString()}`;
}

const GAME_LABELS = Object.freeze({
    blackjack: '🃏 Blackjack',
    slots: '🎰 Slots',
    roulette: '🔴 Roulette',
    craps: '🎲 Craps',
    highlow: '🔼 High-Low',
    duel: '⚔️ Duels',
    tetris: '🧱 Tetris',
});
const labelFor = game => GAME_LABELS[game] ?? game;

// ── Profile ─────────────────────────────────────────────────────────────────

async function renderProfile(interaction, target) {
    const stats = await getGameStats(target.id);
    const balance = await getBalance(target.id);

    if (!stats.length) {
        return interaction.editReply(
            target.id === interaction.user.id
                ? `You have never played anything. Balance: ${money(balance)}.`
                : `${target.username} has never played anything.`
        );
    }

    const totals = stats.reduce((acc, s) => ({
        rounds: acc.rounds + s.rounds,
        wagered: acc.wagered + s.wagered,
        returned: acc.returned + s.returned,
        wins: acc.wins + s.wins,
        losses: acc.losses + s.losses,
    }), { rounds: 0, wagered: 0, returned: 0, wins: 0, losses: 0 });

    const net = totals.returned - totals.wagered;
    // Return as a percentage of what was staked. Above 100 means the house is
    // down against this player, which is the honest way to read it.
    const rtp = totals.wagered > 0 ? (totals.returned / totals.wagered) * 100 : 0;

    // A title is the only thing shop purchases do, so it belongs on the one
    // page where a player's standing is on display.
    const title = bestTitle((await getInventory(target.id)).map(i => i.itemId));

    const embed = new EmbedBuilder()
        .setColor(net >= 0 ? EMBED_COLORS.SUCCESS : EMBED_COLORS.ERROR)
        .setTitle(title ? `${target.username}, ${title}` : `${target.username} at the tables`)
        .setThumbnail(target.displayAvatarURL())
        .setDescription(
            `**${signed(net)}** across ${totals.rounds.toLocaleString()} rounds.\n`
            + `Staked ${money(totals.wagered)}, got back ${money(totals.returned)} `
            + `(${rtp.toFixed(1)}%).`
        );

    for (const s of stats.slice(0, 8)) {
        const gameNet = s.returned - s.wagered;
        const decided = s.wins + s.losses;
        const winRate = decided > 0 ? Math.round((s.wins / decided) * 100) : 0;
        embed.addFields({
            name: `${labelFor(s.game)} · ${signed(gameNet)}`,
            value: `${s.rounds.toLocaleString()} rounds, ${winRate}% won\n`
                + `-# best ${money(s.biggestWin)} · worst ${money(s.biggestLoss)}`,
            inline: true,
        });
    }

    const daily = await getDailyState(target.id);
    const footer = [`Balance ${money(balance)}`];
    if (daily) footer.push(`daily streak ${daily.streak} (best ${daily.bestStreak})`);
    embed.setFooter({ text: footer.join(' · ') });

    return interaction.editReply(ui(embed, [], { scope: 'casino' }));
}

// ── Leaderboard ─────────────────────────────────────────────────────────────

async function renderLeaderboard(interaction, direction) {
    const rows = await getCasinoLeaders(direction, 10);
    if (!rows.length) return interaction.editReply('Nobody has played anything yet.');

    const title = direction === 'down' ? '📉 Deepest in the hole' : '📈 Furthest ahead';
    const lines = rows.map((r, i) => {
        const rank = ['👑', '🥈', '🥉'][i] || `**${i + 1}.**`;
        return `${rank} <@${r.userId}> ${signed(r.net)} -# over ${r.rounds.toLocaleString()} rounds`;
    });

    const board = new EmbedBuilder()
        .setColor(direction === 'down' ? EMBED_COLORS.ERROR : EMBED_COLORS.SUCCESS)
        .setTitle(title)
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Lifetime net across every game' });

    return interaction.editReply(ui(board, [], { scope: 'casino' }));
}

// ── Owner config panel ──────────────────────────────────────────────────────

/** "at most once per 5 min" reads wrong when the answer is "always". */
function describeCooldown(seconds) {
    if (!seconds) return 'on **every** qualifying swing';
    if (seconds < 60) return `at most once per **${seconds}s**`;
    return `at most once per **${Math.round(seconds / 60)} min**`;
}

/**
 * Silence has several honest causes and they all look the same from a chair
 * in the channel, so the panel says which one it was.
 */
function describeResult(result) {
    const when = `<t:${Math.floor(Number(result.at) / 1000)}:R>`;
    if (result.reason === 'spoke') return `spoke ${when}`;
    if (result.reason === 'cooling down') {
        return `stayed quiet ${when} (cooling down${result.readyInSeconds ? `, ${result.readyInSeconds}s left` : ''})`;
    }
    if (result.reason === 'failed') return `failed ${when}: ${result.error ?? 'unknown error'}`;
    return `${result.reason} ${when}`;
}

function configEmbed(settings, lastResult = null) {
    const maxBet = settings.max_bet > 0 ? money(settings.max_bet) : 'no limit';
    const dailyMin = settings.daily_base + settings.daily_streak_bonus;
    const dailyMax = settings.daily_base + settings.daily_streak_cap * settings.daily_streak_bonus;

    return new EmbedBuilder()
        .setColor(EMBED_COLORS.INFO)
        .setTitle('🎰 Casino settings')
        .addFields(
            {
                name: 'Bet limits',
                value: `min **${money(settings.min_bet)}**, max **${maxBet}**\n`
                    + '-# applies to every game that takes an opening stake',
                inline: false,
            },
            {
                name: 'Daily',
                value: `**${money(settings.daily_base)}** base, **${money(settings.daily_streak_bonus)}** `
                    + `per streak day, capped at **${settings.daily_streak_cap}** days\n`
                    + `-# day 1 pays ${money(dailyMin)}, day ${settings.daily_streak_cap}+ pays ${money(dailyMax)}`,
                inline: false,
            },
            {
                name: 'Heckling',
                value: `${settings.heckle_enabled ? '**on**' : '**off**'}: `
                    + `${describeCooldown(settings.heckle_cooldown_seconds)}, `
                    + `only for swings over **${money(settings.heckle_threshold)}**\n`
                    + '-# on: Moksi remembers notable wins and busts, and occasionally says '
                    + 'something about one out loud. Off: neither.'
                    + (lastResult ? `\n-# last swing worth remarking on: ${describeResult(lastResult)}` : ''),
                inline: false,
            },
        )
        .setFooter({ text: 'Owner only. Everything here is live immediately.' });
}

function configRows(settings) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cas_limits').setLabel('Bet limits').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cas_daily').setLabel('Daily').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('cas_heckle').setLabel('Heckle tuning').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('cas_heckle_toggle')
            .setLabel(settings.heckle_enabled ? 'Turn heckling off' : 'Turn heckling on')
            .setStyle(settings.heckle_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    )];
}

/** `min`..`max` from LIMITS, rendered for a modal placeholder. */
const range = key => `${LIMITS[key].min} to ${LIMITS[key].max}`;

async function renderConfig(interaction) {
    let settings = await getAllSettings();
    let lastResult = await lastHeckleResult().catch(() => null);
    const message = await interaction.editReply(
        ui(configEmbed(settings, lastResult), configRows(settings), { scope: 'casino' }),
    );

    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: PANEL_TIMEOUT_MS,
    });

    const refresh = async (source) => {
        settings = await getAllSettings();
        lastResult = await lastHeckleResult().catch(() => null);
        // `like` pins the rendering to whatever this message was born as: the
        // Components V2 flag cannot be added or removed after the fact, so a
        // toggle flipped mid-panel must not change the shape of an edit.
        const payload = ui(configEmbed(settings, lastResult), configRows(settings), { like: message });
        // A modal submission has its own token and has to answer itself; a
        // plain button press edits the panel it came from.
        if (source?.isModalSubmit?.()) return source.update(payload);
        return message.edit(payload);
    };

    collector.on('collect', async i => {
        try {
            if (i.user.id !== interaction.user.id) {
                return i.reply({ content: 'Not your panel.', flags: MessageFlags.Ephemeral });
            }

            if (i.customId === 'cas_heckle_toggle') {
                await i.deferUpdate();
                const next = !settings.heckle_enabled;
                await setSetting('heckle_enabled', next);
                logger.info('Casino heckling toggled', { enabled: next, by: i.user.id });
                return refresh();
            }

            const FORMS = {
                cas_limits: {
                    title: 'Bet limits',
                    fields: [
                        ['min_bet', 'Minimum bet'],
                        ['max_bet', 'Maximum bet (0 for none)'],
                    ],
                },
                cas_daily: {
                    title: 'Daily payout',
                    fields: [
                        ['daily_base', 'Base amount'],
                        ['daily_streak_bonus', 'Bonus per streak day'],
                        ['daily_streak_cap', 'Streak days that still count'],
                    ],
                },
                cas_heckle: {
                    title: 'Heckle tuning',
                    fields: [
                        ['heckle_cooldown_seconds', 'Seconds between heckles'],
                        ['heckle_threshold', 'Minimum swing worth remarking on'],
                    ],
                },
            };

            const form = FORMS[i.customId];
            if (!form) return;

            const submitted = await promptModal(i, {
                title: form.title,
                idPrefix: 'cas',
                timeoutMs: PANEL_TIMEOUT_MS,
                inputs: form.fields.map(([key, label]) => ({
                    id: key,
                    label,
                    value: String(settings[key]),
                    placeholder: range(key),
                    required: true,
                    maxLength: 12,
                })),
            });
            if (!submitted) return;

            for (const [key] of form.fields) {
                const raw = submitted.fields.getTextInputValue(key);
                // setSetting clamps into LIMITS, so a typo becomes the nearest
                // legal value rather than a broken casino.
                await setSetting(key, raw.replace(/[^0-9-]/g, ''));
            }
            logger.info('Casino settings changed', { form: i.customId, by: i.user.id });
            return refresh(submitted);
        } catch (error) {
            logger.error('Casino panel error', { error: error.message, stack: error.stack });
        }
    });

    collector.on('end', async (_c, reason) => {
        if (reason !== 'time') return;
        try { await message.edit(retireControls(message)); } catch { /* panel may be gone */ }
    });
}

// ── Command ─────────────────────────────────────────────────────────────────

module.exports = {
    data: new SlashCommandBuilder()
        .setName('casino')
        .setDescription('Your record at the tables')
        .addSubcommand(sub => sub
            .setName('profile')
            .setDescription('Lifetime results across every game')
            .addUserOption(opt => opt.setName('user').setDescription('whose record (default: yours)')))
        .addSubcommand(sub => sub
            .setName('leaderboard')
            .setDescription('Who is up and who is down')
            .addStringOption(opt => opt
                .setName('direction')
                .setDescription('winners or losers')
                .addChoices(
                    { name: 'furthest ahead', value: 'up' },
                    { name: 'deepest in the hole', value: 'down' },
                )))
        .addSubcommand(sub => sub
            .setName('config')
            .setDescription('secret')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'config') {
            if (!isOwner(interaction.user.id)) {
                const msg = OWNER_REJECTION_JOKES[Math.floor(Math.random() * OWNER_REJECTION_JOKES.length)];
                return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            return renderConfig(interaction);
        }

        await interaction.deferReply();

        if (sub === 'leaderboard') {
            return renderLeaderboard(interaction, interaction.options.getString('direction') ?? 'up');
        }

        const target = interaction.options.getUser('user') ?? interaction.user;
        if (target.bot) return interaction.editReply('The house does not keep records on itself.');
        return renderProfile(interaction, target);
    },

    // Exported for tests; DEFAULTS is the contract the panel renders against.
    _DEFAULTS: DEFAULTS,
};
