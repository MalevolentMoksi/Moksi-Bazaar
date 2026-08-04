// src/commands/tools/lookup.js
/**
 * Everything the bot knows about one person, on one page.
 *
 * The information already existed, spread across /checkrelation, the join gate
 * panel, /casino profile and the warn reminders, which meant answering "who is
 * this and should I be worried" took four commands and a good memory.
 *
 * Owner only, and deliberately so. This is a dossier: suspicion scoring, the
 * sentiment model's private reasoning, spending habits. Handing that to
 * anybody who can type a slash command would be a different product.
 */

const {
    SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType,
    EmbedBuilder, MessageFlags,
} = require('discord.js');
const {
    getUserContext, getAttitudeLedger, getRecentMemories, getSentimentHistory,
    getBalance, getGameStats, getDailyState, getInventory, isUserBlacklisted, getWarns,
} = require('../../utils/db');
const { getSettings } = require('../../utils/joinGate/config');
const suspicion = require('../../utils/joinGate/suspicion');
const { collectProtectedNames, peekAttempt } = require('../../utils/joinGate/enforcement');
const { getPendingUnbans } = require('../../utils/joinGate/unbanScheduler');
const { bestTitle } = require('../../utils/shopCatalogue');
const { trendDirection } = require('../../utils/trend');
const { isOwner, OWNER_REJECTION_JOKES, EMBED_COLORS } = require('../../utils/constants');
const logger = require('../../utils/logger');

const DAY_MS = 86_400_000;
const money = n => `$${Number(n).toLocaleString()}`;
const stamp = ms => `<t:${Math.floor(Number(ms) / 1000)}:R>`;

function signed(n) {
    const v = Number(n);
    return `${v > 0 ? '+' : v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString()}`;
}

const TIER_COLOR = Object.freeze({
    clear: EMBED_COLORS.SUCCESS,
    watch: EMBED_COLORS.WARNING,
    suspect: EMBED_COLORS.CAUTIOUS,
    malicious: EMBED_COLORS.ERROR,
});

/**
 * Scores the target the way the live gate would, using this guild's tuned
 * weights and thresholds rather than the defaults. A dossier that disagrees
 * with the thing making the decisions is worse than no dossier.
 */
function scoreNow(user, member, settings, guild) {
    try {
        return suspicion.scoreAccount(user, {
            weights: settings.suspicion_weights,
            keywords: settings.suspicion_keywords ?? suspicion.DEFAULT_SCAM_KEYWORDS,
            protectedNames: guild ? collectProtectedNames(guild) : [],
            member,
            tenureGraceDays: Number(settings.suspicion_tenure_grace_days),
            thresholds: {
                watch: Number(settings.suspicion_watch_at),
                suspect: Number(settings.suspicion_suspect_at),
                malicious: Number(settings.suspicion_malicious_at),
            },
        });
    } catch (error) {
        logger.warn('Lookup could not score account', { error: error.message });
        return null;
    }
}

async function buildDossier(interaction, target) {
    const guild = interaction.guild;
    const member = guild ? await guild.members.fetch(target.id).catch(() => null) : null;

    const [
        settings, userContext, ledger, memories, history,
        balance, stats, daily, inventory, blacklisted,
    ] = await Promise.all([
        guild ? getSettings(guild.id).catch(() => null) : null,
        getUserContext(target.id).catch(() => null),
        getAttitudeLedger(target.id, 3).catch(() => []),
        getRecentMemories(target.id, 3, { excludeContext: true }).catch(() => []),
        getSentimentHistory(target.id, 10).catch(() => []),
        getBalance(target.id).catch(() => 0),
        getGameStats(target.id).catch(() => []),
        getDailyState(target.id).catch(() => null),
        getInventory(target.id).catch(() => []),
        isUserBlacklisted(target.id).catch(() => false),
    ]);

    const scored = settings ? scoreNow(target, member, settings, guild) : null;
    const embed = new EmbedBuilder()
        .setColor(TIER_COLOR[scored?.tier] ?? EMBED_COLORS.INFO)
        .setTitle(`Dossier: ${target.username}`)
        .setThumbnail(target.displayAvatarURL())
        .setFooter({ text: `${target.id} · owner only` });

    // ── Identity ────────────────────────────────────────────────────────────
    const accountAgeDays = (Date.now() - target.createdTimestamp) / DAY_MS;
    const identity = [
        `Account made ${stamp(target.createdTimestamp)} (${accountAgeDays.toFixed(0)}d old)`,
    ];
    if (member) {
        identity.push(`Joined ${stamp(member.joinedTimestamp)}`);
        const ageAtJoin = (member.joinedTimestamp - target.createdTimestamp) / DAY_MS;
        identity.push(`-# account was ${ageAtJoin.toFixed(1)}d old when they joined`);
        const roles = member.roles.cache.filter(r => r.name !== '@everyone');
        if (roles.size) identity.push(`Roles: ${roles.map(r => r.name).slice(0, 8).join(', ')}`);
        if (member.communicationDisabledUntilTimestamp > Date.now()) {
            identity.push(`⏱️ **Timed out** until ${stamp(member.communicationDisabledUntilTimestamp)}`);
        }
    } else {
        identity.push('**Not in this server.**');
    }
    if (blacklisted) identity.push('🚫 On the speak blacklist.');
    embed.addFields({ name: 'Identity', value: identity.join('\n'), inline: false });

    // ── Warns ───────────────────────────────────────────────────────────────
    if (guild) {
        const warns = await getWarns(guild.id, { userId: target.id, label: target.username }, 25)
            .catch(() => []);
        if (warns.length) {
            const recent = warns.filter(w => Date.now() - w.createdAtMs < 90 * DAY_MS).length;
            const latest = warns[0];
            embed.addFields({
                name: 'Warns',
                value: `**${warns.length}** on file, **${recent}** in the last 90 days\n`
                    + `-# most recent ${stamp(latest.createdAtMs)}`
                    + (latest.reason ? `: ${latest.reason.slice(0, 120)}` : ''),
                inline: false,
            });
        }
    }

    // ── Safety ──────────────────────────────────────────────────────────────
    if (scored) {
        const safety = [
            `**${scored.tier.toUpperCase()}** at **${scored.score}** `
            + `(watch ${settings.suspicion_watch_at} / suspect ${settings.suspicion_suspect_at} `
            + `/ malicious ${settings.suspicion_malicious_at})`,
            `-# ${suspicion.summarise(scored)}`,
        ];

        if (guild) {
            const attempts = await peekAttempt(guild.id, target.id).catch(() => null);
            if (attempts?.attempts > 0) {
                safety.push(`Blocked joins: **${attempts.attempts}**`);
            }
            const pending = await getPendingUnbans(guild.id).catch(() => []);
            const mine = pending.find(row => row.user_id === target.id);
            if (mine) {
                safety.push(`⛔ Temp-banned (${mine.kind}), lifts ${stamp(mine.unban_at_ms)}`);
            }
        }
        embed.addFields({ name: 'Safety', value: safety.join('\n'), inline: false });
    }

    // ── Standing with Moksi ─────────────────────────────────────────────────
    if (userContext && !userContext.isNewUser) {
        const direction = trendDirection(history.map(h => h.sentiment));
        const arrow = direction === 'rising' ? '📈 warming'
            : direction === 'falling' ? '📉 cooling'
                : direction === 'stable' ? '➡️ steady' : 'not enough history';
        const standing = [
            `**${userContext.attitudeLevel}** at ${Number(userContext.sentimentScore).toFixed(2)}, ${arrow}`,
            `${userContext.interactionCount} exchanges`,
        ];
        if (ledger.length) {
            standing.push('-# ' + ledger.map(e =>
                `${e.delta > 0 ? '+' : ''}${e.delta.toFixed(2)} ${(e.reason || '?').slice(0, 60)}`
            ).join(' · '));
        }
        embed.addFields({ name: 'Standing with Moksi', value: standing.join('\n'), inline: false });
    }

    // ── Economy ─────────────────────────────────────────────────────────────
    const net = stats.reduce((sum, s) => sum + (s.returned - s.wagered), 0);
    const rounds = stats.reduce((sum, s) => sum + s.rounds, 0);
    const economy = [`Balance **${money(balance)}**`];
    if (rounds > 0) {
        const busiest = stats[0];
        economy.push(`**${signed(net)}** over ${rounds.toLocaleString()} rounds, mostly ${busiest.game}`);
    }
    if (daily) economy.push(`Daily streak ${daily.streak} (best ${daily.bestStreak})`);
    const title = bestTitle(inventory.map(i => i.itemId));
    if (title) economy.push(`Carries the title **${title}**`);
    embed.addFields({ name: 'Economy', value: economy.join('\n'), inline: false });

    // ── Last words ──────────────────────────────────────────────────────────
    if (memories.length) {
        embed.addFields({
            name: 'Recent exchanges',
            value: memories.slice(-2).map(m =>
                `-# "${String(m.user_message).slice(0, 90)}" → "${String(m.bot_response).slice(0, 90)}"`
            ).join('\n'),
            inline: false,
        });
    }

    return embed;
}

async function run(interaction, target) {
    if (!isOwner(interaction.user.id)) {
        const msg = OWNER_REJECTION_JOKES[Math.floor(Math.random() * OWNER_REJECTION_JOKES.length)];
        return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (target.bot) return interaction.editReply('I do not keep files on bots.');

    try {
        const embed = await buildDossier(interaction, target);
        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('Lookup failed', { targetId: target.id, error: error.message, stack: error.stack });
        return interaction.editReply(`Could not assemble that: ${error.message}`);
    }
}

module.exports = [
    {
        data: new SlashCommandBuilder()
            .setName('lookup')
            .setDescription('secret')
            .addUserOption(opt => opt
                .setName('user').setDescription('who').setRequired(true)),
        async execute(interaction) {
            return run(interaction, interaction.options.getUser('user'));
        },
    },
    {
        // Right-click a member, Apps, Lookup. The same dossier without having
        // to find the user in an autocomplete box.
        data: new ContextMenuCommandBuilder()
            .setName('Lookup')
            .setType(ApplicationCommandType.User),
        async execute(interaction) {
            return run(interaction, interaction.targetUser);
        },
    },
];
