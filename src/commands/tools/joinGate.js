// src/commands/tools/joinGate.js
/**
 * /joingate: owner-only configuration panel for the account-age auto-kicker.
 *
 * Layout: row 0 is always the section picker, rows 1-4 are that section's
 * controls. Everything is ephemeral, every write goes through the config
 * allow-list, and every write is mirrored to the config audit channel.
 */

const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
    ChannelType, MessageFlags, PermissionFlagsBits,
} = require('discord.js');

const { isOwner, OWNER_REJECTION_JOKES, EMBED_COLORS } = require('../../utils/constants');
const { promptModal: sharedPromptModal, fitRows } = require('../../utils/panelHelpers');
const logger = require('../../utils/logger');
const {
    getSettings, updateSettings, resetStats, invalidate,
    formatDays, daysToMinutes, thresholdMs, clamp, LIMITS,
    DEFAULT_DM_MESSAGE, DEFAULT_DM_BAN_MESSAGE,
    DEFAULT_DM_SUSPICION_MESSAGE, DEFAULT_DM_WATCH_MESSAGE,
} = require('../../utils/joinGate/config');
const {
    evaluateUserId, renderDm, sweepGuild, backtestGuild, collectProtectedNames,
    getAttemptLeaderboard, displayTag,
} = require('../../utils/joinGate/enforcement');
const {
    scoreAccount, explain, DEFAULT_WEIGHTS, DEFAULT_SCAM_KEYWORDS,
} = require('../../utils/joinGate/suspicion');
const validate = require('../../utils/joinGate/validate');
const { describeShape } = require('../../utils/joinGate/cohorts');
const { sendSnapshot, resolveChannel: resolveSnapshotChannel } = require('../../utils/joinGate/snapshot');
const { stats: phishingStats, startAutoRefresh: startPhishingRefresh } = require('../../utils/joinGate/phishing');
const { syncGuild: syncInvites, canRead: canReadInvites } = require('../../utils/joinGate/invites');
const { describeRouting, logConfigChange, logTest, CATEGORIES } = require('../../utils/joinGate/logging');
const { getPendingUnbans, deletePendingUnban, recomputePendingUnbans, scheduleNext } =
    require('../../utils/joinGate/unbanScheduler');
const { checkGuildHealth } = require('../../utils/joinGate/diagnostics');
const { ui, isV2Message } = require('../../utils/ui/panel');

const PANEL_TIMEOUT_MS = 15 * 60_000;
const PANEL_IDLE_MS = 5 * 60_000;
const MODAL_TIMEOUT_MS = 120_000;

const SNOWFLAKE_RE = /^\d{17,20}$/;

const SECTIONS = [
    { value: 'overview', label: 'Overview', emoji: '📋', description: 'Status, master switch, dry run' },
    { value: 'rules', label: 'Rules', emoji: '📏', description: 'Age threshold, bots, exempt users' },
    { value: 'messaging', label: 'Messaging', emoji: '✉️', description: 'DM text, invite, preview & test' },
    { value: 'escalation', label: 'Escalation', emoji: '🔨', description: 'Temp-bans for repeat rejoiners' },
    { value: 'suspicion', label: 'Suspicion', emoji: '🕵️', description: 'Score joiners on more than age' },
    { value: 'guard', label: 'Guard', emoji: '🛰️', description: 'Watch staff and bots for nuke patterns' },
    { value: 'logging', label: 'Logging', emoji: '📓', description: 'Where each kind of event is written' },
    { value: 'advanced', label: 'Advanced', emoji: '⚙️', description: 'Burst alerts, downtime catch-up' },
    { value: 'diagnostics', label: 'Diagnostics', emoji: '🩺', description: 'Health check, stats, ID tester' },
];

// ── Small helpers ───────────────────────────────────────────────────────────

const onOff = v => (v ? '🟢 On' : '⚪ Off');
const channelRef = id => (id ? `<#${id}>` : '*not set*');

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Parses a free-form list of IDs from a modal into unique valid snowflakes. */
function parseIdList(raw) {
    const tokens = String(raw || '').split(/[\s,;]+/).map(t => t.trim()).filter(Boolean);
    const valid = [];
    const invalid = [];
    for (const token of tokens) {
        // Tolerate a pasted mention.
        const id = token.replace(/^<@!?/, '').replace(/>$/, '');
        if (SNOWFLAKE_RE.test(id)) valid.push(id);
        else invalid.push(token);
    }
    return { valid: [...new Set(valid)], invalid };
}

/**
 * Shows a modal from a component interaction and waits for the submission.
 * @returns {Promise<import('discord.js').ModalSubmitInteraction|null>} null on timeout
 */
async function promptModal(componentInteraction, { title, inputs }) {
    // Implementation lives in utils/panelHelpers.js so the casino panel uses
    // the same one. This wrapper keeps the twenty-odd call sites below and the
    // jg_ modal id prefix exactly as they were.
    return sharedPromptModal(componentInteraction, {
        title, inputs, idPrefix: 'jg', timeoutMs: MODAL_TIMEOUT_MS,
    });
}

// ── Section renderers ───────────────────────────────────────────────────────

/** "3d 4h", for cohort spans. Rounded, since nobody needs the seconds. */
function formatSpan(ms) {
    const minutes = Math.round(Number(ms ?? 0) / 60_000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
}

function sectionRow(active) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('jg_section')
            .setPlaceholder('Jump to a section…')
            .addOptions(SECTIONS.map(s => ({
                label: s.label,
                value: s.value,
                description: s.description,
                emoji: s.emoji,
                default: s.value === active,
            })))
    );
}

function renderOverview(guild, settings) {
    const armed = settings.enabled && !settings.dry_run && thresholdMs(settings) > 0;

    const embed = new EmbedBuilder()
        .setTitle('🛡️ Join Gate: Overview')
        .setColor(armed ? EMBED_COLORS.SUCCESS : settings.enabled ? EMBED_COLORS.WARNING : EMBED_COLORS.NEUTRAL)
        .setDescription(
            settings.enabled
                ? (settings.dry_run
                    ? '🧪 **Enabled, dry run.** Joins are evaluated and logged, but nobody is removed.'
                    : '🟢 **Armed.** New accounts under the threshold are removed on join.')
                : '⚪ **Disabled.** Nothing is evaluated in this server.'
        )
        .addFields(
            { name: 'Server', value: `${guild.name}`, inline: true },
            { name: 'Minimum age', value: `**${formatDays(settings.min_account_age_minutes)}** days`, inline: true },
            { name: 'Dry run', value: onOff(settings.dry_run), inline: true },
            { name: 'Bots', value: settings.gate_bots ? 'Gated like users' : 'Exempt', inline: true },
            { name: 'Exempt users', value: `${settings.exempt_user_ids.length}`, inline: true },
            { name: 'DM on removal', value: onOff(settings.dm_enabled), inline: true },
            {
                name: 'Escalation',
                value: settings.escalate_enabled
                    ? `Temp-ban after **${settings.escalate_after_attempts}** attempts`
                    : '⚪ Off',
                inline: true,
            },
            { name: 'Catch-up sweep', value: settings.sweep_enabled ? `${settings.sweep_window_hours}h window` : '⚪ Off', inline: true },
            {
                name: 'Lifetime',
                value: `${settings.total_kicks} kicked · ${settings.total_bans} banned · ${settings.total_failures} failed`,
                inline: true,
            },
        )
        .setFooter({ text: 'Existing members are never re-evaluated. Only new joins are.' });

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('jg_toggle_enabled')
                .setLabel(settings.enabled ? 'Disable gate' : 'Enable gate')
                .setStyle(settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('jg_toggle_dryrun')
                .setLabel(settings.dry_run ? 'Turn off dry run' : 'Turn on dry run')
                .setStyle(settings.dry_run ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('jg_set_days').setLabel('Set threshold').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('jg_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary)
        ),
    ];

    return { embed, rows };
}

function renderRules(settings) {
    const exempt = settings.exempt_user_ids;
    const preview = exempt.length
        ? truncate(exempt.map(id => `<@${id}>`).join(', '), 1000)
        : '*nobody*';

    const embed = new EmbedBuilder()
        .setTitle('📏 Join Gate: Rules')
        .setColor(EMBED_COLORS.INFO)
        .setDescription(
            'Account age is the **only** criterion, plus the explicit allow-list below.\n'
            + 'Roles are deliberately never consulted: an autorole bot that assigns a role on join '
            + 'must not be able to accidentally whitelist everyone.'
        )
        .addFields(
            { name: 'Minimum account age', value: `**${formatDays(settings.min_account_age_minutes)}** days`, inline: true },
            { name: 'Bot accounts', value: settings.gate_bots ? '🔨 Gated like users' : '✅ Exempt', inline: true },
            { name: `Exempt users (${exempt.length})`, value: preview, inline: false },
        );

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('jg_set_days').setLabel('Set threshold').setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('jg_toggle_bots')
                .setLabel(settings.gate_bots ? 'Exempt bots' : 'Gate bots too')
                .setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('jg_exempt_add').setLabel('Add exempt users').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('jg_exempt_remove').setLabel('Remove exempt users').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('jg_exempt_clear')
                .setLabel('Clear list')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(exempt.length === 0)
        ),
    ];

    return { embed, rows };
}

/** True when any suspicion tier is armed to remove people. */
function suspicionRemoves(settings) {
    return Boolean(settings.suspicion_enabled)
        && [settings.suspicion_watch_action, settings.suspicion_suspect_action, settings.suspicion_malicious_action]
            .some(a => a === 'kick' || a === 'ban');
}

/** True when the behaviour watch window is armed to remove people. */
function watchRemoves(settings) {
    return Boolean(settings.watch_enabled)
        && (settings.watch_action === 'kick' || settings.watch_action === 'ban');
}

function renderMessaging(settings) {
    const embed = new EmbedBuilder()
        .setTitle('✉️ Join Gate: Messaging')
        .setColor(EMBED_COLORS.INFO)
        .setDescription(
            'The DM is always sent **before** the removal, because afterwards the bot no longer shares a server '
            + 'with the user and Discord rejects the message.\n\n'
            + 'Placeholders: `{days}` `{server}` `{user}` `{eligible}` `{age}`'
        )
        .addFields(
            { name: 'Send a DM', value: onOff(settings.dm_enabled), inline: true },
            { name: 'Append eligible time', value: onOff(settings.dm_append_eligible), inline: true },
            {
                name: 'Append invite',
                value: settings.dm_append_invite
                    ? (settings.dm_invite_url ? `🟢 ${settings.dm_invite_url}` : '⚠️ On, but no invite set')
                    : '⚪ Off',
                inline: true,
            },
            {
                name: 'Re-DM cooldown',
                value: Number(settings.dm_cooldown_minutes) === 0
                    ? 'None, every attempt gets a DM'
                    : `${settings.dm_cooldown_minutes} min between DMs to the same user`,
                inline: true,
            },
            { name: 'Kick message', value: truncate(settings.dm_message, 1000), inline: false },
            {
                name: 'Temp-ban message',
                value: settings.escalate_enabled
                    ? truncate(settings.dm_ban_message, 1000)
                    : '*(escalation is off, unused)*',
                inline: false,
            },
            {
                name: 'Suspicion removal message',
                value: suspicionRemoves(settings)
                    ? truncate(settings.dm_suspicion_message, 1000)
                    : '*(no suspicion tier removes anyone, unused)*',
                inline: false,
            },
            {
                name: 'Behaviour removal message',
                value: watchRemoves(settings)
                    ? truncate(settings.dm_watch_message, 1000)
                    : '*(the watch window removes nobody, unused)*',
                inline: false,
            },
        );

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('jg_toggle_dm')
                .setLabel(settings.dm_enabled ? 'Disable DM' : 'Enable DM')
                .setStyle(settings.dm_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('jg_toggle_dm_eligible')
                .setLabel(settings.dm_append_eligible ? 'Drop eligible time' : 'Append eligible time')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('jg_toggle_dm_invite')
                .setLabel(settings.dm_append_invite ? 'Drop invite line' : 'Append invite line')
                .setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('jg_edit_dm').setLabel('Edit kick message').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('jg_edit_dm_ban').setLabel('Edit ban message').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('jg_edit_dm_susp').setLabel('Edit suspicion message').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('jg_edit_dm_watch').setLabel('Edit behaviour message').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('jg_reset_dm').setLabel('Reset to default').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('jg_set_invite').setLabel('Set invite URL').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('jg_set_dm_cooldown').setLabel('Set DM cooldown').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('jg_preview_dm').setLabel('Preview').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('jg_test_dm').setLabel('Send test DM to me').setStyle(ButtonStyle.Success)
        ),
    ];

    return { embed, rows };
}

function renderEscalation(settings, pending) {
    const list = pending.length
        ? pending.slice(0, 10).map(p =>
            `<@${p.user_id}>: lifts <t:${Math.floor(Number(p.unban_at_ms) / 1000)}:R>`).join('\n')
        : '*none*';

    const embed = new EmbedBuilder()
        .setTitle('🔨 Join Gate: Escalation')
        .setColor(settings.escalate_enabled ? EMBED_COLORS.WARNING : EMBED_COLORS.NEUTRAL)
        .setDescription(
            'A kicked user can rejoin with the same invite immediately. After enough attempts the gate '
            + 'switches from kicking to a **temporary ban**, lifted automatically at the exact moment the '
            + 'account reaches the threshold.\n\n'
            + '⚠️ Requires **Ban Members**. Pending lifts survive restarts and are honoured even if the gate '
            + 'is later disabled. Lowering the threshold shortens pending bans; raising it never extends them.'
        )
        .addFields(
            { name: 'Escalation', value: onOff(settings.escalate_enabled), inline: true },
            { name: 'Ban after', value: `**${settings.escalate_after_attempts}** join attempts`, inline: true },
            {
                name: 'Suspicion & behaviour bans',
                value: `score-tier bans last **${settings.suspicion_ban_hours}h**, watch-window bans `
                    + `**${settings.watch_ban_hours}h**. Fixed cooldowns from the moment of the ban: these `
                    + 'members already passed the age gate, so there is no age to wait out.',
                inline: false,
            },
            { name: `Pending lifts (${pending.length})`, value: truncate(list, 1000), inline: false },
        );

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('jg_toggle_escalate')
                .setLabel(settings.escalate_enabled ? 'Disable escalation' : 'Enable escalation')
                .setStyle(settings.escalate_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder().setCustomId('jg_set_attempts').setLabel('Set attempt limit').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('jg_set_ban_hours').setLabel('Set ban hours').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('jg_lift_ban')
                .setLabel('Lift a ban now')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(pending.length === 0)
        ),
    ];

    return { embed, rows };
}

/** 'default' is a pseudo-category (the fallback channel), so it has no CATEGORIES entry. */
function logCategoryMeta(activeCategory) {
    if (activeCategory === 'default') {
        return { label: 'Default channel', channelKey: 'log_channel_id', toggleKey: null, isDefault: true };
    }
    return { ...CATEGORIES[activeCategory], isDefault: false };
}

function renderSuspicion(settings) {
    const actionLabel = a => ({
        log: '📝 log only', timeout: '🔇 timeout', kick: '👢 kick',
        ban: '🔨 temp-ban', none: '⚪ ignore',
    }[a] ?? a);
    const overrides = Object.entries(settings.suspicion_weights ?? {});
    const keywords = settings.suspicion_keywords ?? DEFAULT_SCAM_KEYWORDS;

    const embed = new EmbedBuilder()
        .setTitle('🕵️ Join Gate: Suspicion scoring')
        .setColor(settings.suspicion_enabled ? EMBED_COLORS.WARNING : EMBED_COLORS.NEUTRAL)
        .setDescription(
            'Scores each joiner across profile shape, name heuristics, impersonation and raid '
            + 'correlation. Trust signals (Nitro, badges, a genuinely old account) **subtract** points, '
            + 'which is what keeps ordinary newcomers out of the net.\n\n'
            + 'Runs only on members the age gate already let through, so nobody is judged twice. '
            + 'Every report shows the full arithmetic.\n\n'
            + '⚠️ Backtest before raising any tier above **log**.'
        )
        .addFields(
            { name: 'Scoring', value: onOff(settings.suspicion_enabled), inline: true },
            { name: 'Reports go to', value: channelRef(settings.suspicion_log_channel_id), inline: true },
            { name: 'Flagged so far', value: `${settings.total_flagged}`, inline: true },
            {
                name: 'Tiers',
                value: `👁️ watch **${settings.suspicion_watch_at}+** → ${actionLabel(settings.suspicion_watch_action)}\n`
                    + `⚠️ suspect **${settings.suspicion_suspect_at}+** → ${actionLabel(settings.suspicion_suspect_action)}\n`
                    + `🚨 malicious **${settings.suspicion_malicious_at}+** → ${actionLabel(settings.suspicion_malicious_action)}`,
                inline: false,
            },
            {
                name: `Weight overrides (${overrides.length})`,
                value: overrides.length
                    ? truncate(overrides.map(([k, v]) => `${k}=${v}`).join(', '), 1000)
                    : '*defaults*',
                inline: false,
            },
            { name: `Scam keywords (${keywords.length})`, value: truncate(keywords.join(', '), 1000), inline: false },
            {
                name: 'Watch window (behaviour)',
                value: (settings.watch_enabled
                    ? `🟢 first **${settings.watch_window_minutes} min** after joining · act at **${settings.watch_action_at}** → ${actionLabel(settings.watch_action)}`
                      + (settings.watch_action === 'timeout' ? ` for **${settings.watch_timeout_minutes} min**` : '')
                      + (settings.watch_exempt_channel_ids?.length
                          ? `\n-# ignores ${settings.watch_exempt_channel_ids.map(channelRef).join(' ')}`
                          : '')
                    : '⚪ Off. Nothing is scored on what people post')
                    + '\n-# **Watch settings** below opens its own page',
                inline: false,
            },
            {
                name: 'Invite tracking',
                value: settings.invite_tracking_enabled
                    ? '🟢 On. Reports show which invite was used, and flag codes minting joins fast'
                    : '⚪ Off',
                inline: true,
            },
            {
                name: 'Tenure grace',
                value: Number(settings.suspicion_tenure_grace_days) > 0
                    ? `tenure forgiveness reaches full strength at **${settings.suspicion_tenure_grace_days}d** in the server`
                    : 'unset (**0d**): the stock **365d** forgiveness timeline applies',
                inline: true,
            },
        );

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('jg_susp_toggle')
                .setLabel(settings.suspicion_enabled ? 'Disable scoring' : 'Enable scoring')
                .setStyle(settings.suspicion_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('jg_watch_toggle')
                .setLabel(settings.watch_enabled ? 'Disable watch window' : 'Enable watch window')
                .setStyle(settings.watch_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('jg_invite_toggle')
                .setLabel(settings.invite_tracking_enabled ? 'Disable invite tracking' : 'Enable invite tracking')
                .setStyle(settings.invite_tracking_enabled ? ButtonStyle.Danger : ButtonStyle.Success)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('jg_susp_backtest').setLabel('Backtest').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('jg_susp_test_user').setLabel('Score a user ID').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('jg_susp_thresholds').setLabel('Thresholds').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('jg_susp_actions').setLabel('Tier actions').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('jg_susp_watchcfg').setLabel('Watch settings').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('jg_susp_weights').setLabel('Tune weights').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('jg_susp_keywords').setLabel('Edit keywords').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('jg_susp_tenure').setLabel('Tenure grace').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId('jg_susp_channel')
                .setPlaceholder('Where should suspicion reports go?')
                .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setMinValues(1)
                .setMaxValues(1)
        ),
    ];

    // Four rows, plus the section picker the panel adds, is exactly Discord's
    // five. There is no room here for anything else, which is why the watch
    // window has its own page below rather than one more control bolted on.
    return { embed, rows };
}

/**
 * The watch window's own page, reached from "Watch settings".
 *
 * Everything watch-related was competing for space in the suspicion section,
 * which was already full. The channel exemption in particular has to be a
 * select menu, and a select menu costs a whole row.
 */
function renderWatch(settings, guild) {
    const actionLabel = a => ({
        log: '📝 log only', timeout: '🔇 timeout', kick: '👢 kick',
        ban: '🔨 temp-ban', none: '⚪ ignore',
    }[a] ?? a);
    const exempt = settings.watch_exempt_channel_ids ?? [];
    // Pre-selecting a channel Discord cannot resolve is rejected for the whole
    // message, which would take the page down over a channel someone deleted
    // months ago. The embed field below still lists whatever is stored.
    const exemptLive = exempt.filter(id => guild?.channels?.cache?.has(id));

    const embed = new EmbedBuilder()
        .setTitle('👁️ Join Gate: Watch window')
        .setColor(settings.watch_enabled ? EMBED_COLORS.WARNING : EMBED_COLORS.NEUTRAL)
        .setDescription(
            'Profile scoring judges an account the moment it joins. This judges what it then **does**: '
            + 'known scam domains, the same message sprayed across channels, mass pings, invite links.\n\n'
            + 'Only members inside the window are ever watched, so regulars are never scored on their posts.'
        )
        .addFields(
            { name: 'Watch window', value: onOff(settings.watch_enabled), inline: true },
            { name: 'Window length', value: `**${settings.watch_window_minutes} min** after joining`, inline: true },
            {
                name: 'Acts at',
                value: `**${settings.watch_action_at}** → ${actionLabel(settings.watch_action)}`
                    + (settings.watch_action === 'timeout' ? ` for **${settings.watch_timeout_minutes} min**` : '')
                    + (settings.watch_action === 'ban' ? ` for **${settings.watch_ban_hours}h**` : ''),
                inline: true,
            },
            {
                name: `Ignored channels (${exempt.length})`,
                value: exempt.length
                    ? `${exempt.map(channelRef).join(' ')}\n-# nothing posted here is scored at all`
                    : '*none: every channel is scored*',
                inline: false,
            },
            {
                name: 'Scam-domain list',
                value: phishingStats().domains
                    ? `**${phishingStats().domains}** domains loaded`
                    : '*not loaded yet*: it is fetched when the window is switched on',
                inline: true,
            },
            {
                name: 'Discord AutoMod',
                value: settings.watch_automod_enabled
                    ? '🟢 Counts your **spam** and **mention-spam** rules as evidence\n'
                      + '-# keyword rules (slurs, politics, profanity) are ignored: those are people, not bots'
                    : '⚪ Off. What AutoMod blocks does not feed the score',
                inline: false,
            },
        );

    const exemptPicker = new ChannelSelectMenuBuilder()
        .setCustomId('jg_watch_exempt')
        .setPlaceholder('Channels the watch window ignores (replaces the list)')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum)
        .setMinValues(1)
        .setMaxValues(10);
    if (exemptLive.length) exemptPicker.setDefaultChannels(...exemptLive);

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('jg_watch_toggle')
                .setLabel(settings.watch_enabled ? 'Disable watch window' : 'Enable watch window')
                .setStyle(settings.watch_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder().setCustomId('jg_watch_edit').setLabel('Window & action').setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('jg_watch_automod')
                .setLabel(settings.watch_automod_enabled ? 'Ignore AutoMod' : 'Count AutoMod')
                .setStyle(settings.watch_automod_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('jg_watch_exempt_clear')
                .setLabel('Clear ignored channels')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(exempt.length === 0),
            new ButtonBuilder().setCustomId('jg_watch_back').setLabel('← Back to suspicion').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(exemptPicker),
    ];

    return { embed, rows };
}

function renderGuard(settings) {
    const embed = new EmbedBuilder()
        .setTitle('🛰️ Join Gate: Audit-log guard')
        .setColor(settings.guard_enabled ? EMBED_COLORS.WARNING : EMBED_COLORS.NEUTRAL)
        .setDescription(
            'Everything else here watches people arriving. This watches people already trusted: '
            + 'a moderator whose account was taken, a bot with a leaked token, a staff member '
            + 'having a very bad day.\n\n'
            + '**It reports and never acts.** Discord writes an audit-log entry *after* carrying '
            + 'an action out, so this cannot intercept, block or undo anything, by anyone. There '
            + 'is no ban, kick or timeout call anywhere in it.\n\n'
            + '**Bans, kicks and timeouts are not watched at all.** That is deliberate: a nuke '
            + 'destroys structure, while bans are reversible and routine. Clear out fifty accounts '
            + 'through Dyno and nothing here so much as blinks.'
        )
        .addFields(
            { name: 'Guard', value: onOff(settings.guard_enabled), inline: true },
            { name: 'Alerts to', value: channelRef(settings.guard_channel_id || settings.log_channel_id), inline: true },
            { name: 'DM the owner', value: onOff(settings.guard_dm_owner), inline: true },
            {
                name: `Limits (per ${settings.guard_window_seconds}s, per person)`,
                value: `🗑️ channels/roles deleted **${settings.guard_delete_limit}**\n`
                    + `➕ channels/roles created **${settings.guard_create_limit}**\n`
                    + `🔑 dangerous permission grants **${settings.guard_perm_limit}**\n`
                    + `🪝 webhooks created **${settings.guard_webhook_limit}**`,
                inline: false,
            },
            {
                name: 'Reported on sight, no threshold',
                value: `${settings.guard_watch_identity ? '🟢' : '⚪'} vanity URL, server name and icon changes\n`
                    + `${settings.guard_watch_bots ? '🟢' : '⚪'} a bot being added, and who added it`,
                inline: false,
            },
            {
                name: 'Weekly structure snapshot',
                value: (settings.snapshot_enabled
                    ? '🟢 On. Channels, roles, permission overwrites, who holds which role, settings and emoji, '
                      + `sent to ${channelRef(resolveSnapshotChannel(settings))}`
                    : '⚪ Off. The database backup holds nothing about the server itself')
                    + (settings.snapshot_dm_owner
                        ? '\n-# 🟢 also DM\'d to you, which is the copy that survives the server being wrecked'
                        : '\n-# ⚠️ no DM copy: the only backup would live inside the server it backs up')
                    + '\n-# Capture only: there is no restore button, here or anywhere',
                inline: false,
            },
            {
                name: `Exempt (${settings.guard_exempt_user_ids?.length ?? 0})`,
                value: settings.guard_exempt_user_ids?.length
                    ? truncate(settings.guard_exempt_user_ids.map(id => `<@${id}>`).join(', '), 1000)
                    : '*nobody*',
                inline: false,
            },
        );

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('jg_guard_toggle')
                .setLabel(settings.guard_enabled ? 'Disable guard' : 'Enable guard')
                .setStyle(settings.guard_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('jg_guard_dm')
                .setLabel(settings.guard_dm_owner ? 'Stop DMing me' : 'DM me alerts')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('jg_guard_identity')
                .setLabel(settings.guard_watch_identity ? 'Ignore identity' : 'Watch identity')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('jg_guard_bots')
                .setLabel(settings.guard_watch_bots ? 'Ignore bot adds' : 'Watch bot adds')
                .setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('jg_guard_limits').setLabel('Set limits').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('jg_guard_exempt').setLabel('Exempt someone').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('jg_guard_exempt_clear')
                .setLabel('Clear exemptions')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!settings.guard_exempt_user_ids?.length)
        ),
        // Snapshots get their own row: they are storage, not detection, and
        // there is now a third control that would not have fitted above.
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('jg_guard_snapshot')
                .setLabel(settings.snapshot_enabled ? 'Stop snapshots' : 'Weekly snapshot')
                .setStyle(settings.snapshot_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder().setCustomId('jg_guard_snapshot_now').setLabel('Snapshot now').setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('jg_guard_snapshot_dm')
                .setLabel(settings.snapshot_dm_owner ? 'Stop DM copy' : 'DM me a copy')
                .setStyle(settings.snapshot_dm_owner ? ButtonStyle.Secondary : ButtonStyle.Success)
        ),
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId('jg_guard_channel')
                .setPlaceholder('Where should guard alerts go?')
                .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setMinValues(1)
                .setMaxValues(1)
        ),
    ];

    return { embed, rows };
}

function renderLogging(settings, routing, activeCategory, guild) {
    const meta = logCategoryMeta(activeCategory);
    const rows = [];
    const markRoles = settings.false_positive_role_ids ?? [];
    // Pre-selecting a role Discord cannot resolve is rejected for the whole
    // message, which would take the page down over a role someone deleted.
    const markRolesLive = markRoles.filter(id => guild?.roles?.cache?.has(id));

    const lines = Object.values(routing).map((info) => {
        const target = info.overrideId
            ? channelRef(info.overrideId)
            : (settings.log_channel_id ? `${channelRef(settings.log_channel_id)} *(default)*` : '*nowhere*');
        const state = !info.enabled ? '⚪ off' : info.usable ? '🟢' : '⚠️ unreachable';
        return `${state} **${info.label}** → ${target}`;
    });

    const embed = new EmbedBuilder()
        .setTitle('📓 Join Gate: Logging')
        .setColor(EMBED_COLORS.INFO)
        .setDescription(
            'Each category can have its own channel. Leave one unset and it falls back to the default '
            + 'channel, so "kicks and failures together" is just leaving both unset, while "failures to '
            + 'staff, kicks to the audit log" is setting two overrides.\n\n'
            + lines.join('\n')
        )
        .addFields(
            { name: 'Default channel', value: channelRef(settings.log_channel_id), inline: true },
            { name: 'Now editing', value: `**${meta.label}**`, inline: true },
            {
                name: 'Currently',
                value: meta.isDefault
                    ? `Fallback for every category without its own channel → ${channelRef(settings.log_channel_id)}`
                    : `${settings[meta.toggleKey] ? '🟢 logged' : '⚪ not logged'} → `
                      + `${settings[meta.channelKey] ? channelRef(settings[meta.channelKey]) : '*default channel*'}`,
                inline: false,
            },
            {
                name: 'Can mark a report wrong',
                value: (markRoles.length
                    ? markRoles.map(id => `<@&${id}>`).join(' ')
                    : '*anyone who can time members out*')
                    + '\n-# The button on a suspicion report records that the score was a mistake, '
                    + 'so the weights have something to be tuned against. It is reversible, and it '
                    + 'never undoes a timeout or a ban.',
                inline: false,
            },
        );

    rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('jg_log_category')
            .setPlaceholder('Which category to edit…')
            .addOptions([
                { label: 'Default channel (fallback for all)', value: 'default', emoji: '📥', default: activeCategory === 'default' },
                ...Object.entries(CATEGORIES).map(([key, c]) => ({
                    label: c.label,
                    value: key,
                    default: key === activeCategory,
                })),
            ])
    ));

    rows.push(new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
            .setCustomId('jg_log_channel')
            .setPlaceholder(`Set channel for: ${meta.label}`)
            .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setMinValues(1)
            .setMaxValues(1)
    ));

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('jg_log_here').setLabel('Use this channel').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('jg_log_clear').setLabel('Clear').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('jg_log_toggle')
            .setLabel(meta.isDefault ? 'Always on' : (settings[meta.toggleKey] ? 'Stop logging this' : 'Start logging this'))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(meta.isDefault),
        new ButtonBuilder().setCustomId('jg_log_test').setLabel('Send test entry').setStyle(ButtonStyle.Success)
    ));

    const markPicker = new RoleSelectMenuBuilder()
        .setCustomId('jg_log_fp_roles')
        .setPlaceholder('Roles that can mark a report wrong (none = anyone who can time out)')
        // Zero is allowed on purpose: deselecting everything is how you go
        // back to the default, without spending a button on a Clear.
        .setMinValues(0)
        .setMaxValues(4);
    if (markRolesLive.length) markPicker.setDefaultRoles(...markRolesLive);
    rows.push(new ActionRowBuilder().addComponents(markPicker));

    return { embed, rows };
}

function renderAdvanced(settings) {
    const embed = new EmbedBuilder()
        .setTitle('⚙️ Join Gate: Advanced')
        .setColor(EMBED_COLORS.INFO)
        .setDescription(
            'Removals are always processed one at a time with a short gap, so a raid cannot rate-limit the '
            + 'bot. Under a heavy backlog DMs are skipped to drain faster; that is noted on each log entry.'
        )
        .addFields(
            { name: 'Burst alert', value: onOff(settings.burst_alert_enabled), inline: true },
            {
                name: 'Burst trigger',
                value: `${settings.burst_threshold} gated joins / ${settings.burst_window_seconds}s`,
                inline: true,
            },
            { name: 'Catch-up sweep', value: onOff(settings.sweep_enabled), inline: true },
            {
                name: 'Sweep window',
                value: `Only members who joined in the last **${settings.sweep_window_hours}h** are re-checked on startup. `
                    + 'Anyone who joined earlier is never touched.',
                inline: false,
            },
        );

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('jg_toggle_burst')
                .setLabel(settings.burst_alert_enabled ? 'Disable burst alert' : 'Enable burst alert')
                .setStyle(settings.burst_alert_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder().setCustomId('jg_set_burst').setLabel('Set burst trigger').setStyle(ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('jg_toggle_sweep')
                .setLabel(settings.sweep_enabled ? 'Disable catch-up' : 'Enable catch-up')
                .setStyle(settings.sweep_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder().setCustomId('jg_set_sweep').setLabel('Set sweep window').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('jg_run_sweep')
                .setLabel('Run sweep now')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(!settings.sweep_enabled)
        ),
    ];

    return { embed, rows };
}

async function renderDiagnostics(guild, settings) {
    const [health, attempts] = await Promise.all([
        checkGuildHealth(guild, settings),
        getAttemptLeaderboard(guild.id, 5),
    ]);

    const icon = { ok: '🟢', warn: '🟡', fail: '🔴' };
    const checkLines = health.checks
        .map(c => `${icon[c.level]} **${c.label}**: ${c.detail}`)
        .join('\n');

    const attemptLines = attempts.length
        ? attempts.map(a =>
            `<@${a.user_id}>: ${a.attempts} attempt(s), last <t:${Math.floor(Number(a.last_seen_ms) / 1000)}:R>`).join('\n')
        : '*no repeat joiners recorded*';

    const embed = new EmbedBuilder()
        .setTitle('🩺 Join Gate: Diagnostics')
        .setColor(health.ok ? EMBED_COLORS.SUCCESS : EMBED_COLORS.ERROR)
        .setDescription(truncate(checkLines, 4000))
        .addFields(
            {
                name: 'Lifetime counters',
                value: `${settings.total_kicks} kicked · ${settings.total_bans} temp-banned · ${settings.total_failures} failures`,
                inline: false,
            },
            { name: 'Most persistent rejoiners', value: truncate(attemptLines, 1000), inline: false },
        );

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('jg_refresh').setLabel('Re-run checks').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('jg_test_user').setLabel('Test a user ID').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('jg_reset_stats').setLabel('Reset counters').setStyle(ButtonStyle.Danger)
        ),
    ];

    return { embed, rows };
}

// ── Panel assembly ──────────────────────────────────────────────────────────

async function buildPanel(guild, state) {
    const settings = await getSettings(guild.id, { fresh: true });
    let built;

    switch (state.section) {
        case 'rules':
            built = renderRules(settings);
            break;
        case 'messaging':
            built = renderMessaging(settings);
            break;
        case 'escalation':
            built = renderEscalation(settings, await getPendingUnbans(guild.id));
            break;
        case 'suspicion':
            built = state.watchDetail ? renderWatch(settings, guild) : renderSuspicion(settings);
            break;
        case 'guard':
            built = renderGuard(settings);
            break;
        case 'logging':
            built = renderLogging(settings, await describeRouting(guild, settings), state.logCategory, guild);
            break;
        case 'advanced':
            built = renderAdvanced(settings);
            break;
        case 'diagnostics':
            built = await renderDiagnostics(guild, settings);
            break;
        default:
            built = renderOverview(guild, settings);
    }

    // The embed and its rows are returned separately rather than as a finished
    // payload: only the send site knows whether it is creating a message or
    // editing one, and under Components V2 that decision is permanent.
    return {
        settings,
        embed: built.embed,
        rows: fitRows([sectionRow(state.section), ...built.rows], `joingate:${state.section}`),
    };
}

// ── Command ─────────────────────────────────────────────────────────────────

module.exports = {
    data: new SlashCommandBuilder()
        .setName('joingate')
        .setDescription('Configure the account-age auto-kicker for this server'),
    // Access control is the isOwner() check below, not a Discord permission
    // flag. setDefaultMemberPermissions(Administrator) was tempting, but it
    // would hide the panel from the owner in any server where they are not an
    // admin, locking the one person who is allowed to use it out of it.

    async execute(interaction) {
        if (!isOwner(interaction.user.id)) {
            const msg = OWNER_REJECTION_JOKES[Math.floor(Math.random() * OWNER_REJECTION_JOKES.length)];
            return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }
        if (!interaction.inGuild()) {
            return interaction.reply({
                content: 'Run this inside the server you want to configure.',
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guild = interaction.guild;
        const state = { section: 'overview', logCategory: 'default', watchDetail: false };

        const opening = await buildPanel(guild, state);
        const message = await interaction.editReply(ui(opening.embed, opening.rows, { scope: 'mod' }));

        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && isOwner(i.user.id),
            time: PANEL_TIMEOUT_MS,
            idle: PANEL_IDLE_MS,
        });

        /**
         * Re-renders the panel in place.
         *
         * `respondTo` may be a button/select interaction or a modal submission.
         * A modal submission can only `.update()` when it originated from a
         * message component, so that is checked rather than assumed. If
         * the update fails for any reason we still edit the panel and
         * acknowledge the interaction, otherwise Discord shows the user a red
         * "interaction failed" on a change that actually saved.
         */
        const refresh = async (respondTo) => {
            const rebuilt = await buildPanel(guild, state);
            const next = ui(rebuilt.embed, rebuilt.rows, { like: message });

            const canUpdate = respondTo
                && !respondTo.replied
                && !respondTo.deferred
                && (typeof respondTo.isFromMessage !== 'function' || respondTo.isFromMessage());

            if (canUpdate) {
                try {
                    await respondTo.update(next);
                    return;
                } catch (error) {
                    logger.warn('[JOIN-GATE] Panel update failed, falling back to editReply', {
                        error: error.message,
                    });
                }
            }

            await interaction.editReply(next).catch(() => {});
            if (respondTo && !respondTo.replied && !respondTo.deferred) {
                await respondTo.deferUpdate?.().catch(() => {});
            }
        };

        /** Permissions from a validator's `requires` that the bot does not have. */
        const missingPermissions = async (required = []) => {
            if (!required?.length) return [];
            const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
            return required.filter(name => !me?.permissions.has(PermissionFlagsBits[name]));
        };

        /**
         * Applies a validated change, or explains why it was refused.
         *
         * One path for every settings write here. The rules themselves live in
         * validate.js so anything else that writes settings reads the same
         * definition, and the permissions a change declares are enforced at
         * this end, where the guild actually is.
         */
        const applyValidated = async (respondTo, verdict) => {
            if (!verdict.ok) {
                return respondTo.reply({ content: `⚠️ ${verdict.error}`, flags: MessageFlags.Ephemeral });
            }
            const missing = await missingPermissions(verdict.requires);
            if (missing.length) {
                return respondTo.reply({
                    content: `⚠️ That needs **${missing.join('**, **')}**, which the bot does not have here. `
                        + 'Grant it first: otherwise the panel would report an action as armed that cannot happen.',
                    flags: MessageFlags.Ephemeral,
                });
            }
            return applyChange(respondTo, verdict.patch, verdict.summary);
        };

        /** Applies a settings patch, refreshes, and writes the audit entry. */
        const applyChange = async (respondTo, patch, summary, details = null) => {
            const updated = await updateSettings(guild.id, patch);
            await refresh(respondTo);
            logger.info('[JOIN-GATE] Config changed', { guildId: guild.id, by: interaction.user.id, summary });
            logConfigChange(guild, updated, { actor: interaction.user, summary, details }).catch(() => {});
            return updated;
        };

        collector.on('collect', async (i) => {
            try {
                const settings = await getSettings(guild.id);
                const id = i.customId;

                // ── Navigation ──────────────────────────────────────────────
                if (id === 'jg_section') {
                    state.section = i.values[0];
                    state.watchDetail = false; // leaving suspicion closes its sub-page
                    return refresh(i);
                }
                if (id === 'jg_susp_watchcfg' || id === 'jg_watch_back') {
                    state.section = 'suspicion';
                    state.watchDetail = id === 'jg_susp_watchcfg';
                    return refresh(i);
                }
                if (id === 'jg_log_category') {
                    state.logCategory = i.values[0];
                    return refresh(i);
                }
                if (id === 'jg_refresh') {
                    invalidate(guild.id);
                    return refresh(i);
                }

                // ── Simple toggles ──────────────────────────────────────────
                const TOGGLES = {
                    jg_toggle_enabled: ['enabled', s => (s.enabled ? 'Gate **disabled**' : 'Gate **enabled**')],
                    jg_toggle_dryrun: ['dry_run', s => (s.dry_run ? 'Dry run **off**: removals are live' : 'Dry run **on**: log only')],
                    jg_toggle_bots: ['gate_bots', s => (s.gate_bots ? 'Bots are now **exempt**' : 'Bots are now **gated**')],
                    jg_toggle_dm: ['dm_enabled', s => (s.dm_enabled ? 'Removal DM **off**' : 'Removal DM **on**')],
                    jg_toggle_dm_eligible: ['dm_append_eligible', s => `Eligible-time line ${s.dm_append_eligible ? 'removed' : 'appended'}`],
                    jg_toggle_dm_invite: ['dm_append_invite', s => `Invite line ${s.dm_append_invite ? 'removed' : 'appended'}`],
                    jg_toggle_burst: ['burst_alert_enabled', s => `Burst alert ${s.burst_alert_enabled ? 'off' : 'on'}`],
                    jg_toggle_sweep: ['sweep_enabled', s => `Catch-up sweep ${s.sweep_enabled ? 'off' : 'on'}`],
                };
                if (TOGGLES[id]) {
                    const [key, describe] = TOGGLES[id];
                    return applyChange(i, { [key]: !settings[key] }, describe(settings));
                }

                if (id === 'jg_toggle_escalate') {
                    const turningOn = !settings.escalate_enabled;
                    if (turningOn) {
                        const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
                        if (!me?.permissions.has(PermissionFlagsBits.BanMembers)) {
                            return i.reply({
                                content: '⚠️ Escalation needs the **Ban Members** permission, which the bot does not have here. '
                                    + 'Grant it first, otherwise every escalated removal will fail.',
                                flags: MessageFlags.Ephemeral,
                            });
                        }
                    }
                    return applyChange(i, { escalate_enabled: turningOn },
                        `Escalation **${turningOn ? 'enabled' : 'disabled'}**`);
                }

                // ── Threshold ───────────────────────────────────────────────
                if (id === 'jg_set_days') {
                    const submitted = await promptModal(i, {
                        title: 'Minimum account age',
                        inputs: [{
                            id: 'days',
                            label: 'Days (decimals allowed, e.g. 14 or 0.5)',
                            value: formatDays(settings.min_account_age_minutes),
                            placeholder: '14',
                            required: true,
                            maxLength: 10,
                        }],
                    });
                    if (!submitted) return;

                    const raw = Number(submitted.fields.getTextInputValue('days').replace(',', '.'));
                    if (!Number.isFinite(raw) || raw < 0) {
                        return submitted.reply({ content: '⚠️ That is not a number of days.', flags: MessageFlags.Ephemeral });
                    }
                    const minutes = clamp(daysToMinutes(raw), LIMITS.MIN_AGE_MINUTES);
                    const updated = await applyChange(submitted, { min_account_age_minutes: minutes },
                        `Threshold set to **${formatDays(minutes)} days**`);

                    // Pending temp-bans were sold to the user with an end date.
                    // Lowering the bar must release them early; raising it must not
                    // silently extend a ban somebody was already given a date for.
                    const shortened = await recomputePendingUnbans(guild.id, thresholdMs(updated));
                    if (shortened > 0) {
                        await scheduleNext(interaction.client);
                        await interaction.followUp({
                            content: `ℹ️ ${shortened} pending temp-ban(s) shortened to match the new threshold.`,
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                    return;
                }

                // ── Exempt list ─────────────────────────────────────────────
                if (id === 'jg_exempt_add' || id === 'jg_exempt_remove') {
                    const adding = id === 'jg_exempt_add';
                    const submitted = await promptModal(i, {
                        title: adding ? 'Add exempt users' : 'Remove exempt users',
                        inputs: [{
                            id: 'ids',
                            label: 'User IDs (space, comma or newline separated)',
                            paragraph: true,
                            required: true,
                            placeholder: '619637817294848012 123456789012345678',
                            maxLength: 2000,
                        }],
                    });
                    if (!submitted) return;

                    const { valid, invalid } = parseIdList(submitted.fields.getTextInputValue('ids'));
                    if (valid.length === 0) {
                        return submitted.reply({
                            content: `⚠️ No valid user IDs found${invalid.length ? ` (rejected: ${truncate(invalid.join(', '), 200)})` : ''}.`,
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    const current = new Set(settings.exempt_user_ids);
                    for (const uid of valid) {
                        if (adding) current.add(uid);
                        else current.delete(uid);
                    }
                    const merged = [...current];
                    const next = merged.slice(0, LIMITS.EXEMPT_IDS);
                    const dropped = merged.length - next.length;

                    await applyChange(submitted, { exempt_user_ids: next },
                        `${adding ? 'Added' : 'Removed'} **${valid.length}** exempt user(s); list is now ${next.length}`,
                        truncate(valid.map(v => `<@${v}>`).join(', '), 1000));

                    const notes = [];
                    if (invalid.length) {
                        notes.push(`Ignored ${invalid.length} unparseable entry/entries: ${truncate(invalid.join(', '), 400)}`);
                    }
                    if (dropped > 0) {
                        // Silently dropping exemptions would mean silently gating
                        // people the owner believes are safe. Say it out loud.
                        notes.push(`⚠️ The list is capped at ${LIMITS.EXEMPT_IDS} entries, so **${dropped}** did not fit and were not saved.`);
                    }
                    if (notes.length) {
                        await interaction.followUp({
                            content: `ℹ️ ${notes.join('\n')}`,
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                    return;
                }

                if (id === 'jg_exempt_clear') {
                    return applyChange(i, { exempt_user_ids: [] },
                        `Exempt list cleared (**${settings.exempt_user_ids.length}** removed)`);
                }

                // ── DM text ─────────────────────────────────────────────────
                const DM_EDITS = {
                    jg_edit_dm: ['dm_message', 'Kick DM'],
                    jg_edit_dm_ban: ['dm_ban_message', 'Temp-ban DM'],
                    jg_edit_dm_susp: ['dm_suspicion_message', 'Suspicion removal DM'],
                    jg_edit_dm_watch: ['dm_watch_message', 'Behaviour removal DM'],
                };
                if (DM_EDITS[id]) {
                    const [key, label] = DM_EDITS[id];
                    const submitted = await promptModal(i, {
                        title: label,
                        inputs: [{
                            id: 'text',
                            label: 'Message ({days} {server} {user} {eligible})',
                            paragraph: true,
                            required: true,
                            value: settings[key],
                            maxLength: LIMITS.DM_MESSAGE_LENGTH,
                        }],
                    });
                    if (!submitted) return;

                    const text = submitted.fields.getTextInputValue('text').trim();
                    if (!text) {
                        return submitted.reply({ content: '⚠️ Message cannot be empty.', flags: MessageFlags.Ephemeral });
                    }
                    return applyChange(submitted, { [key]: text },
                        `${label} message updated`, truncate(text, 1000));
                }

                if (id === 'jg_reset_dm') {
                    return applyChange(i, {
                        dm_message: DEFAULT_DM_MESSAGE,
                        dm_ban_message: DEFAULT_DM_BAN_MESSAGE,
                        dm_suspicion_message: DEFAULT_DM_SUSPICION_MESSAGE,
                        dm_watch_message: DEFAULT_DM_WATCH_MESSAGE,
                    }, 'DM messages reset to defaults');
                }

                if (id === 'jg_set_invite') {
                    const submitted = await promptModal(i, {
                        title: 'Rejoin invite URL',
                        inputs: [{
                            id: 'url',
                            label: 'Discord invite (blank to clear)',
                            value: settings.dm_invite_url ?? '',
                            placeholder: 'https://discord.gg/abcdef',
                            maxLength: 200,
                        }],
                    });
                    if (!submitted) return;

                    // Restricted to Discord invites on purpose: this string is
                    // DMed to strangers, so it must not become an
                    // arbitrary-link vector. The rule lives in validate.js.
                    return applyValidated(submitted,
                        validate.inviteUrl(submitted.fields.getTextInputValue('url')));
                }

                if (id === 'jg_set_dm_cooldown') {
                    const submitted = await promptModal(i, {
                        title: 'Re-DM cooldown',
                        inputs: [{
                            id: 'minutes',
                            label: 'Minutes between DMs (0 = every attempt)',
                            value: String(settings.dm_cooldown_minutes),
                            required: true,
                            maxLength: 6,
                        }],
                    });
                    if (!submitted) return;

                    const minutes = clamp(Number(submitted.fields.getTextInputValue('minutes')), LIMITS.DM_COOLDOWN_MINUTES);
                    return applyChange(submitted, { dm_cooldown_minutes: minutes },
                        minutes === 0 ? 'Every gated join now gets a DM' : `Re-DM cooldown set to **${minutes} min**`);
                }

                if (id === 'jg_preview_dm' || id === 'jg_test_dm') {
                    const base = {
                        guildName: guild.name,
                        user: i.user,
                        eligibleAt: Date.now() + thresholdMs(settings) / 2,
                        ageMs: thresholdMs(settings) / 2,
                    };

                    // Only the messages the current settings could actually send.
                    const previews = [['Kick DM', renderDm(settings, { ...base, kind: 'kick' })]];
                    if (settings.escalate_enabled) {
                        previews.push(['Temp-ban DM', renderDm(settings, { ...base, kind: 'ban' })]);
                    }
                    if (suspicionRemoves(settings)) {
                        previews.push(['Suspicion removal DM', renderDm(settings, {
                            ...base,
                            cause: 'suspicion',
                            eligibleAt: Date.now() + Number(settings.suspicion_ban_hours) * 3_600_000,
                        })]);
                    }
                    if (watchRemoves(settings)) {
                        previews.push(['Behaviour removal DM', renderDm(settings, {
                            ...base,
                            cause: 'behaviour',
                            eligibleAt: Date.now() + Number(settings.watch_ban_hours) * 3_600_000,
                        })]);
                    }

                    if (id === 'jg_preview_dm') {
                        return i.reply({
                            content: truncate(
                                previews.map(([label, text]) => `**${label} preview**\n>>> ${text}`).join('\n\n'),
                                1900
                            ),
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    try {
                        for (const [, text] of previews) await i.user.send({ content: text });
                        return i.reply({ content: '✅ Test DM sent.', flags: MessageFlags.Ephemeral });
                    } catch (error) {
                        return i.reply({
                            content: `⚠️ Could not DM you: ${error.message}. (Which is exactly what happens to users with DMs closed: the removal still goes ahead.)`,
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                }

                // ── Escalation ──────────────────────────────────────────────
                if (id === 'jg_set_attempts') {
                    const submitted = await promptModal(i, {
                        title: 'Attempts before temp-ban',
                        inputs: [{
                            id: 'attempts',
                            label: `Join attempts (${LIMITS.ESCALATE_ATTEMPTS.min}-${LIMITS.ESCALATE_ATTEMPTS.max})`,
                            value: String(settings.escalate_after_attempts),
                            required: true,
                            maxLength: 3,
                        }],
                    });
                    if (!submitted) return;

                    const attempts = clamp(Number(submitted.fields.getTextInputValue('attempts')), LIMITS.ESCALATE_ATTEMPTS);
                    return applyChange(submitted, { escalate_after_attempts: attempts },
                        `Temp-ban now triggers on join attempt **#${attempts}**`);
                }

                if (id === 'jg_lift_ban') {
                    const submitted = await promptModal(i, {
                        title: 'Lift a temp-ban now',
                        inputs: [{ id: 'uid', label: 'User ID', required: true, maxLength: 25 }],
                    });
                    if (!submitted) return;

                    const uid = submitted.fields.getTextInputValue('uid').trim().replace(/^<@!?/, '').replace(/>$/, '');
                    if (!SNOWFLAKE_RE.test(uid)) {
                        return submitted.reply({ content: '⚠️ That is not a user ID.', flags: MessageFlags.Ephemeral });
                    }

                    let note;
                    try {
                        await guild.bans.remove(uid, `Join gate: manually lifted by ${displayTag(i.user)}`);
                        note = `✅ Unbanned <@${uid}>.`;
                    } catch (error) {
                        note = error?.code === 10026
                            ? `ℹ️ <@${uid}> was not banned; clearing the pending entry anyway.`
                            : `⚠️ Unban failed: ${error.message}`;
                    }
                    await deletePendingUnban(guild.id, uid);
                    await scheduleNext(interaction.client);
                    await refresh(null);
                    return submitted.reply({ content: note, flags: MessageFlags.Ephemeral });
                }

                if (id === 'jg_set_ban_hours') {
                    const submitted = await promptModal(i, {
                        title: 'Suspicion & behaviour ban length',
                        inputs: [
                            {
                                id: 'susp',
                                label: `Suspicion-tier ban hours (${LIMITS.BAN_HOURS.min}-${LIMITS.BAN_HOURS.max})`,
                                value: String(settings.suspicion_ban_hours),
                                required: true,
                                maxLength: 4,
                            },
                            {
                                id: 'watch',
                                label: `Watch-window ban hours (${LIMITS.BAN_HOURS.min}-${LIMITS.BAN_HOURS.max})`,
                                value: String(settings.watch_ban_hours),
                                required: true,
                                maxLength: 4,
                            },
                        ],
                    });
                    if (!submitted) return;

                    const suspHours = clamp(Number(submitted.fields.getTextInputValue('susp')), LIMITS.BAN_HOURS);
                    const watchHours = clamp(Number(submitted.fields.getTextInputValue('watch')), LIMITS.BAN_HOURS);
                    return applyChange(submitted, { suspicion_ban_hours: suspHours, watch_ban_hours: watchHours },
                        `Suspicion-tier bans now last **${suspHours}h**, watch-window bans **${watchHours}h**`);
                }

                // ── Suspicion ───────────────────────────────────────────────
                if (id === 'jg_susp_toggle') {
                    return applyChange(i, { suspicion_enabled: !settings.suspicion_enabled },
                        `Suspicion scoring **${settings.suspicion_enabled ? 'disabled' : 'enabled'}**`);
                }

                if (id === 'jg_watch_toggle') {
                    const turningOn = !settings.watch_enabled;
                    // Start pulling the scam-domain list the moment it is
                    // needed, rather than making the owner restart the bot.
                    if (turningOn) startPhishingRefresh();
                    return applyChange(i, { watch_enabled: turningOn },
                        `Behaviour watch window **${turningOn ? 'enabled' : 'disabled'}**`);
                }

                if (id === 'jg_invite_toggle') {
                    const turningOn = !settings.invite_tracking_enabled;
                    if (turningOn) {
                        if (!canReadInvites(guild)) {
                            return i.reply({
                                content: '⚠️ Invite tracking needs **Manage Server**, which the bot does not have here. '
                                    + 'Without it, Discord will not show the invite list and joins cannot be attributed.',
                                flags: MessageFlags.Ephemeral,
                            });
                        }
                        await syncInvites(guild).catch(() => {});
                    }
                    return applyChange(i, { invite_tracking_enabled: turningOn },
                        `Invite tracking **${turningOn ? 'enabled' : 'disabled'}**`);
                }

                if (id === 'jg_watch_edit') {
                    const submitted = await promptModal(i, {
                        title: 'Watch window settings',
                        inputs: [
                            { id: 'minutes', label: 'Minutes to watch after joining', value: String(settings.watch_window_minutes), required: true, maxLength: 4 },
                            { id: 'at', label: 'Behaviour score that triggers an action', value: String(settings.watch_action_at), required: true, maxLength: 4 },
                            { id: 'action', label: 'log / timeout / kick / ban / none', value: settings.watch_action, required: true, maxLength: 7 },
                            { id: 'timeout', label: 'If timeout: how many minutes', value: String(settings.watch_timeout_minutes), required: false, maxLength: 5 },
                        ],
                    });
                    if (!submitted) return;

                    // Bounds, the action check and both permission checks now
                    // live in validate.js, so a second writer cannot arm a
                    // watch action this bot is unable to carry out.
                    return applyValidated(submitted, validate.watchWindow({
                        minutes: submitted.fields.getTextInputValue('minutes'),
                        at: submitted.fields.getTextInputValue('at'),
                        action: submitted.fields.getTextInputValue('action'),
                        timeout: submitted.fields.getTextInputValue('timeout'),
                    }));
                }

                if (id === 'jg_susp_tenure') {
                    const submitted = await promptModal(i, {
                        title: 'Tenure grace',
                        inputs: [{
                            id: 'days',
                            label: 'Days after which members are damped',
                            value: String(settings.suspicion_tenure_grace_days),
                            required: true,
                            maxLength: 5,
                        }],
                    });
                    if (!submitted) return;

                    const days = clamp(Number(submitted.fields.getTextInputValue('days')), { min: 0, max: 3650 });
                    // 0 means "unset" to the scorer, which falls back to the
                    // stock 365d timeline. Confirming "set to 0 days" would
                    // read as "forgiveness switched off", the opposite.
                    return applyChange(submitted, { suspicion_tenure_grace_days: days },
                        days > 0
                            ? `Tenure grace set to **${days} days**`
                            : 'Tenure grace cleared: the stock **365d** forgiveness timeline applies');
                }

                if (id === 'jg_watch_exempt') {
                    // Replaces the list rather than adding to it: the picker
                    // opens with the current channels already selected, so what
                    // you see on submit is what you get.
                    return applyChange(i, { watch_exempt_channel_ids: i.values },
                        `The watch window now ignores ${i.values.map(channelRef).join(' ')}`);
                }

                // ── Audit-log guard ─────────────────────────────────────────
                if (id === 'jg_guard_toggle') {
                    const turningOn = !settings.guard_enabled;
                    if (turningOn) {
                        const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
                        if (!me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
                            return i.reply({
                                content: '⚠️ The guard reads the audit log, which needs the **View Audit Log** '
                                    + 'permission. Without it Discord sends nothing and the guard would sit there '
                                    + 'looking armed while seeing nothing at all.',
                                flags: MessageFlags.Ephemeral,
                            });
                        }
                    }
                    return applyChange(i, { guard_enabled: turningOn },
                        `Audit-log guard **${turningOn ? 'enabled' : 'disabled'}** (watch-only)`);
                }
                if (id === 'jg_guard_dm') {
                    return applyChange(i, { guard_dm_owner: !settings.guard_dm_owner },
                        `Guard DMs ${settings.guard_dm_owner ? 'off' : 'on'}`);
                }
                if (id === 'jg_guard_identity') {
                    return applyChange(i, { guard_watch_identity: !settings.guard_watch_identity },
                        `Identity changes ${settings.guard_watch_identity ? 'ignored' : 'watched'}`);
                }
                if (id === 'jg_guard_bots') {
                    return applyChange(i, { guard_watch_bots: !settings.guard_watch_bots },
                        `Bot additions ${settings.guard_watch_bots ? 'ignored' : 'watched'}`);
                }
                if (id === 'jg_guard_channel') {
                    return applyChange(i, { guard_channel_id: i.values[0] },
                        `Guard alerts → <#${i.values[0]}>`);
                }
                if (id === 'jg_guard_snapshot') {
                    return applyChange(i, { snapshot_enabled: !settings.snapshot_enabled },
                        `Weekly structure snapshot **${settings.snapshot_enabled ? 'off' : 'on'}**`);
                }
                if (id === 'jg_guard_snapshot_now') {
                    const target = resolveSnapshotChannel(settings);
                    const dmUserId = settings.snapshot_dm_owner ? (process.env.OWNER_ID || null) : null;
                    if (!target && !dmUserId) {
                        return i.reply({
                            content: '⚠️ Nowhere to send it. Set a guard alert channel, or turn on the DM copy.',
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                    await i.deferReply({ flags: MessageFlags.Ephemeral });
                    const result = await sendSnapshot(guild, target, { dmUserId });
                    return i.editReply({
                        content: result.ok
                            ? `📸 Snapshot sent (${result.sentTo.join(' and ')}): **${result.meta.channels}** channels, `
                              + `**${result.meta.roles}** roles, **${result.meta.overwrites}** permission overwrites, `
                              + `**${result.meta.membersWithRoles}** members with roles, `
                              + `${(result.meta.bytes / 1024).toFixed(0)} KB.`
                              + (result.warning ? `\n-# but: ${result.warning}` : '')
                            : `⚠️ Snapshot failed: ${result.error}`,
                    });
                }
                if (id === 'jg_guard_snapshot_dm') {
                    return applyChange(i, { snapshot_dm_owner: !settings.snapshot_dm_owner },
                        settings.snapshot_dm_owner
                            ? 'Snapshots will no longer be DM\'d: the only copy would live in the server it describes'
                            : 'Snapshots will be DM\'d as well, so a copy survives the server');
                }

                if (id === 'jg_guard_exempt_clear') {
                    return applyChange(i, { guard_exempt_user_ids: [] }, 'Guard exemptions cleared');
                }
                if (id === 'jg_guard_limits') {
                    const submitted = await promptModal(i, {
                        title: 'Guard limits',
                        inputs: [
                            { id: 'window', label: 'Window in seconds', value: String(settings.guard_window_seconds), required: true, maxLength: 5 },
                            { id: 'del', label: 'Channels/roles deleted', value: String(settings.guard_delete_limit), required: true, maxLength: 4 },
                            { id: 'cre', label: 'Channels/roles created', value: String(settings.guard_create_limit), required: true, maxLength: 4 },
                            { id: 'perm', label: 'Dangerous permission grants', value: String(settings.guard_perm_limit), required: true, maxLength: 4 },
                            { id: 'hook', label: 'Webhooks created', value: String(settings.guard_webhook_limit), required: true, maxLength: 4 },
                        ],
                    });
                    if (!submitted) return;
                    return applyValidated(submitted, validate.guardLimits({
                        window: submitted.fields.getTextInputValue('window'),
                        del: submitted.fields.getTextInputValue('del'),
                        cre: submitted.fields.getTextInputValue('cre'),
                        perm: submitted.fields.getTextInputValue('perm'),
                        hook: submitted.fields.getTextInputValue('hook'),
                    }));
                }
                if (id === 'jg_guard_exempt') {
                    const submitted = await promptModal(i, {
                        title: 'Exempt from the guard',
                        inputs: [{
                            id: 'ids',
                            label: 'User IDs, one per line',
                            value: (settings.guard_exempt_user_ids ?? []).join('\n'),
                            paragraph: true,
                            required: false,
                            maxLength: 900,
                        }],
                    });
                    if (!submitted) return;
                    const parsed = validate.userIds(submitted.fields.getTextInputValue('ids'));
                    if (!parsed.ok) {
                        return submitted.reply({ content: `⚠️ ${parsed.error}`, flags: MessageFlags.Ephemeral });
                    }
                    return applyChange(submitted, { guard_exempt_user_ids: parsed.ids },
                        `Guard exemptions: **${parsed.ids.length}** user(s)`);
                }

                if (id === 'jg_watch_automod') {
                    const turningOn = !settings.watch_automod_enabled;
                    return applyChange(i, { watch_automod_enabled: turningOn },
                        turningOn
                            ? 'Watch window now counts Discord **AutoMod spam** verdicts'
                            : 'Watch window ignores Discord AutoMod');
                }

                if (id === 'jg_watch_exempt_clear') {
                    return applyChange(i, { watch_exempt_channel_ids: [] },
                        'The watch window now scores every channel');
                }

                if (id === 'jg_susp_channel') {
                    return applyChange(i, { suspicion_log_channel_id: i.values[0] },
                        `Suspicion reports → <#${i.values[0]}>`);
                }

                if (id === 'jg_susp_thresholds') {
                    const submitted = await promptModal(i, {
                        title: 'Suspicion thresholds',
                        inputs: [
                            { id: 'watch', label: 'Watch tier at score', value: String(settings.suspicion_watch_at), required: true, maxLength: 4 },
                            { id: 'suspect', label: 'Suspect tier at score', value: String(settings.suspicion_suspect_at), required: true, maxLength: 4 },
                            { id: 'malicious', label: 'Malicious tier at score', value: String(settings.suspicion_malicious_at), required: true, maxLength: 4 },
                        ],
                    });
                    if (!submitted) return;

                    return applyValidated(submitted, validate.thresholds({
                        watch: submitted.fields.getTextInputValue('watch'),
                        suspect: submitted.fields.getTextInputValue('suspect'),
                        malicious: submitted.fields.getTextInputValue('malicious'),
                    }));
                }

                if (id === 'jg_susp_actions') {
                    const submitted = await promptModal(i, {
                        title: 'Tier actions',
                        inputs: [
                            { id: 'watch', label: 'Watch: log / kick / ban / none', value: settings.suspicion_watch_action, required: true, maxLength: 5 },
                            { id: 'suspect', label: 'Suspect: log / kick / ban / none', value: settings.suspicion_suspect_action, required: true, maxLength: 5 },
                            { id: 'malicious', label: 'Malicious: log / kick / ban / none', value: settings.suspicion_malicious_action, required: true, maxLength: 5 },
                        ],
                    });
                    if (!submitted) return;

                    // The permission check that used to sit here is declared by
                    // the validator and enforced in applyValidated, so the rule
                    // holds for every writer rather than only this one.
                    return applyValidated(submitted, validate.tierActions({
                        watch: submitted.fields.getTextInputValue('watch'),
                        suspect: submitted.fields.getTextInputValue('suspect'),
                        malicious: submitted.fields.getTextInputValue('malicious'),
                    }));
                }

                if (id === 'jg_susp_weights') {
                    const current = Object.entries(settings.suspicion_weights ?? {})
                        .map(([k, v]) => `${k}=${v}`).join('\n');
                    const submitted = await promptModal(i, {
                        title: 'Weight overrides',
                        inputs: [{
                            id: 'weights',
                            label: 'signal=points per line (blank to reset)',
                            paragraph: true,
                            value: current,
                            placeholder: Object.keys(DEFAULT_WEIGHTS).slice(0, 3).map(k => `${k}=${DEFAULT_WEIGHTS[k]}`).join('\n'),
                            maxLength: 1500,
                        }],
                    });
                    if (!submitted) return;

                    return applyValidated(submitted,
                        validate.weights(submitted.fields.getTextInputValue('weights')));
                }

                if (id === 'jg_susp_keywords') {
                    const current = (settings.suspicion_keywords ?? DEFAULT_SCAM_KEYWORDS).join(', ');
                    const submitted = await promptModal(i, {
                        title: 'Scam keywords',
                        inputs: [{
                            id: 'keywords',
                            label: 'Comma separated (blank restores defaults)',
                            paragraph: true,
                            value: current,
                            maxLength: 1500,
                        }],
                    });
                    if (!submitted) return;

                    const list = submitted.fields.getTextInputValue('keywords')
                        .split(',').map(k => k.trim()).filter(Boolean);
                    return applyChange(submitted, { suspicion_keywords: list.length ? list : null },
                        list.length ? `Scam keyword list set (${list.length})` : 'Scam keywords reset to defaults');
                }

                if (id === 'jg_susp_backtest') {
                    await i.deferReply({ flags: MessageFlags.Ephemeral });
                    const report = await backtestGuild(guild, settings, { limit: 15 });
                    if (report.skipped) {
                        return i.editReply({ content: `⚠️ Backtest skipped: ${report.skipped}` });
                    }

                    const d = report.distribution;
                    const TIER_ICON = { malicious: '🚨', suspect: '⚠️', watch: '👁️' };

                    // Every entry carries its own reason. A bare score with a
                    // tier next to it is unactionable, and the forced-malicious
                    // cases look like outright bugs without it.
                    const lines = report.flagged.length
                        ? report.flagged.map(f =>
                            `${TIER_ICON[f.tier] ?? ''} \`${String(f.score).padStart(3)}\` <@${f.id}>`
                            + (f.tenureScore !== f.score ? ` *(${f.tenureScore} w/ tenure)*` : '')
                            + `\n-# ${truncate(f.reason, 150)}`).join('\n')
                        : '_nothing above the watch threshold_';

                    const embed = new EmbedBuilder()
                        .setTitle(`🕵️ Backtest: ${report.scanned} member(s)`)
                        .setColor(report.totalFlagged > 0 ? EMBED_COLORS.WARNING : EMBED_COLORS.SUCCESS)
                        .setDescription(truncate(
                            `Thresholds **${settings.suspicion_watch_at} / ${settings.suspicion_suspect_at} / `
                            + `${settings.suspicion_malicious_at}**\n`
                            + `clear **${d.clear ?? 0}** · 👁️ watch **${d.watch ?? 0}** · ⚠️ suspect **${d.suspect ?? 0}** `
                            + `· 🚨 malicious **${d.malicious ?? 0}**\n`
                            + `**${report.totalFlagged}** flagged on profile alone, **${report.stillFlaggedWithTenure}** still `
                            + `flagged once membership tenure counts.\n\n${lines}`,
                            4000
                        ))
                        .setFooter({
                            text: 'Sorted by severity. Scored ignoring tenure so raw profile signal is visible; '
                                + 'live joins have no tenure anyway. Raid and behaviour signals cannot be '
                                + 'reconstructed after the fact, so real scores can only be higher.',
                        });

                    if (report.flagged.some(f => f.forcedByDiscord)) {
                        embed.addFields({
                            name: 'Why is a low score marked malicious?',
                            value: '🚩 entries were flagged by **Discord itself** (Spammer or Quarantined). '
                                + 'That forces the top tier regardless of the number next to it.',
                            inline: false,
                        });
                    }

                    // Batches. Scores judge one account at a time and cannot see
                    // that fourteen of them share a shape and a registration
                    // week, which is the thing a person spots instantly.
                    if (report.cohorts.length) {
                        embed.addFields({
                            name: `🧬 Batches found (${report.cohorts.length})`,
                            value: truncate(report.cohorts.slice(0, 4).map((c, n) =>
                                `**${n + 1}.** **${c.size}** members · ${describeShape(c.shape)}\n`
                                + `-# ${c.basis === 'creation' ? 'registered' : 'joined'} within `
                                + `${formatSpan(c.basis === 'creation' ? c.creationSpanMs : c.joinSpanMs)}`
                                + ` · ${c.defaultAvatars}/${c.size} default avatar`
                                + (report.activityTracked ? ` · ${c.silent}/${c.size} never spoke` : '')
                            ).join('\n'), 1000),
                            inline: false,
                        });
                    }

                    if (!report.activityTracked) {
                        embed.addFields({
                            name: 'Participation',
                            value: 'Message counting has not started yet, so tenure still forgives on presence '
                                + 'alone. It begins on the next deploy and needs **30 days** of observation '
                                + 'before it withholds anything from anybody.',
                            inline: false,
                        });
                    }

                    // Picker for the full arithmetic behind any one entry.
                    const picker = report.flagged.slice(0, 25).map(f => ({
                        label: truncate(`${f.score} · ${f.tag}`, 100),
                        value: f.id,
                        description: truncate(f.reason, 100),
                        emoji: TIER_ICON[f.tier],
                    }));

                    const components = [];
                    if (picker.length) {
                        components.push(new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('jg_backtest_detail')
                                .setPlaceholder('Show the full breakdown for...')
                                .addOptions(picker)
                        ));
                    }
                    if (report.cohorts.length) {
                        components.push(new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('jg_backtest_cohort')
                                .setPlaceholder('List a batch, with ban commands to paste...')
                                .addOptions(report.cohorts.slice(0, 25).map((c, n) => ({
                                    label: truncate(`Batch ${n + 1}: ${c.size} members`, 100),
                                    value: String(n),
                                    description: truncate(describeShape(c.shape), 100),
                                    emoji: '🧬',
                                })))
                        ));
                    }

                    const reportMessage = await i.editReply(ui(embed, components, { scope: 'mod' }));
                    if (!components.length) return;

                    // The result lives in its own ephemeral message, so it needs
                    // its own collector; the panel's is bound to a different one.
                    const detailCollector = reportMessage.createMessageComponentCollector({
                        filter: sel => sel.user.id === interaction.user.id,
                        time: 10 * 60_000,
                    });

                    detailCollector.on('collect', async sel => {
                        try {
                            if (sel.customId === 'jg_backtest_cohort') {
                                const cluster = report.cohorts[Number(sel.values[0])];
                                if (!cluster) {
                                    return sel.reply({ content: '⚠️ That batch is no longer available.', flags: MessageFlags.Ephemeral });
                                }

                                const roster = cluster.members
                                    .map(m => `${m.username}  ${m.defaultAvatar ? '(no avatar)' : ''}`.trim())
                                    .join('\n');
                                // Commands rather than an action. A ban this bot
                                // issues is attributed to this bot, and would
                                // never reach Dyno's ?modstats; pasted by you,
                                // it counts as yours.
                                const commands = cluster.members
                                    .map(m => `?ban ${m.id} Suspected Bot`)
                                    .join('\n');

                                return sel.reply({
                                    content: truncate(
                                        `🧬 **${cluster.size} members** · ${describeShape(cluster.shape)}\n`
                                        + `-# ${cluster.basis === 'creation' ? 'registered' : 'joined'} within `
                                        + `${formatSpan(cluster.basis === 'creation' ? cluster.creationSpanMs : cluster.joinSpanMs)}`
                                        + ` · ${cluster.defaultAvatars}/${cluster.size} default avatar`
                                        + (report.activityTracked ? ` · ${cluster.silent}/${cluster.size} never spoke` : '')
                                        + `\n\`\`\`\n${roster}\n\`\`\`\n`
                                        + `Paste into Dyno's channel, so the bans are attributed to you:\n`
                                        + `\`\`\`\n${commands}\n\`\`\``,
                                        1900
                                    ),
                                    flags: MessageFlags.Ephemeral,
                                });
                            }

                            // Named rather than left as the fallthrough, so a
                            // future select on this message cannot silently
                            // land in the breakdown branch.
                            if (sel.customId !== 'jg_backtest_detail') return;

                            const picked = report.flagged.find(f => f.id === sel.values[0]);
                            if (!picked) {
                                return sel.reply({ content: '⚠️ That entry is no longer available.', flags: MessageFlags.Ephemeral });
                            }
                            const forcedNote = picked.forcedByDiscord
                                ? '\n\n🚩 **Discord flagged this account itself**, which forces the malicious tier '
                                  + 'no matter what the arithmetic adds up to.'
                                : '';
                            await sel.reply({
                                content: truncate(
                                    `**${picked.tag}** scores **${picked.score}** (${picked.tier})\n`
                                    + `\`\`\`\n${explain(picked.result)}\n\`\`\``
                                    + (picked.tenureScore !== picked.score
                                        ? `\nWith membership tenure counted this drops to **${picked.tenureScore}**.`
                                        : '')
                                    + forcedNote,
                                    1900
                                ),
                                flags: MessageFlags.Ephemeral,
                            });
                        } catch (error) {
                            logger.error('[JOIN-GATE] Backtest detail failed', { error: error.message });
                        }
                    });

                    return;
                }

                if (id === 'jg_susp_test_user') {
                    const submitted = await promptModal(i, {
                        title: 'Score a user ID',
                        inputs: [{ id: 'uid', label: 'User ID', required: true, maxLength: 25 }],
                    });
                    if (!submitted) return;

                    const uid = submitted.fields.getTextInputValue('uid').trim().replace(/^<@!?/, '').replace(/>$/, '');
                    if (!SNOWFLAKE_RE.test(uid)) {
                        return submitted.reply({ content: '⚠️ That is not a user ID.', flags: MessageFlags.Ephemeral });
                    }

                    const member = await guild.members.fetch(uid).catch(() => null);
                    const user = member?.user ?? await interaction.client.users.fetch(uid).catch(() => null);
                    if (!user) {
                        return submitted.reply({
                            content: '⚠️ Could not fetch that user, so only their account age is knowable. '
                                + 'Use Diagnostics → Test a user ID for the age rule alone.',
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    const result = scoreAccount(user, {
                        weights: settings.suspicion_weights,
                        keywords: settings.suspicion_keywords ?? DEFAULT_SCAM_KEYWORDS,
                        protectedNames: collectProtectedNames(guild),
                        thresholds: {
                            watch: Number(settings.suspicion_watch_at),
                            suspect: Number(settings.suspicion_suspect_at),
                            malicious: Number(settings.suspicion_malicious_at),
                        },
                    });

                    return submitted.reply({
                        content: truncate(
                            `**${displayTag(user)}** scores **${result.score}** (${result.tier})\n\`\`\`\n${explain(result)}\n\`\`\``
                            + '\n-# Correlation signals are omitted: they only exist relative to other joiners at the time.',
                            1900
                        ),
                        flags: MessageFlags.Ephemeral,
                    });
                }

                // ── Logging ─────────────────────────────────────────────────
                if (id === 'jg_log_channel' || id === 'jg_log_here' || id === 'jg_log_clear') {
                    const key = state.logCategory === 'default'
                        ? 'log_channel_id'
                        : CATEGORIES[state.logCategory].channelKey;
                    const label = state.logCategory === 'default'
                        ? 'Default log channel'
                        : CATEGORIES[state.logCategory].label;

                    let channelId = null;
                    if (id === 'jg_log_channel') channelId = i.values[0];
                    else if (id === 'jg_log_here') channelId = i.channelId;

                    if (channelId) {
                        const channel = guild.channels.cache.get(channelId);
                        const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
                        if (!channel?.isTextBased()) {
                            return i.reply({ content: '⚠️ That is not a text channel in this server.', flags: MessageFlags.Ephemeral });
                        }
                        if (me && !channel.permissionsFor(me)?.has([
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.EmbedLinks,
                        ])) {
                            return i.reply({
                                content: `⚠️ The bot cannot post in <#${channelId}>: it needs View Channel, Send Messages and Embed Links there.`,
                                flags: MessageFlags.Ephemeral,
                            });
                        }
                    }

                    return applyChange(i, { [key]: channelId },
                        channelId ? `${label} → <#${channelId}>` : `${label} cleared`);
                }

                if (id === 'jg_log_fp_roles') {
                    const roleIds = (i.values ?? []).slice(0, 4);
                    return applyChange(i, { false_positive_role_ids: roleIds },
                        roleIds.length
                            ? `Reports can be marked wrong by ${roleIds.map(r => `<@&${r}>`).join(', ')}`
                            : 'Reports can be marked wrong by anyone who can time members out');
                }

                if (id === 'jg_log_toggle' && state.logCategory !== 'default') {
                    const key = CATEGORIES[state.logCategory].toggleKey;
                    return applyChange(i, { [key]: !settings[key] },
                        `${CATEGORIES[state.logCategory].label} logging **${settings[key] ? 'off' : 'on'}**`);
                }

                if (id === 'jg_log_test') {
                    const label = logCategoryMeta(state.logCategory).label;
                    const delivered = await logTest(guild, settings, state.logCategory, i.user);
                    return i.reply({
                        content: delivered
                            ? `✅ Test entry sent to the **${label}** destination.`
                            : `⚠️ Nothing was delivered: **${label}** has no reachable channel. `
                              + 'Either it is switched off, no channel is set (and there is no default), '
                              + 'or the bot cannot post there.',
                        flags: MessageFlags.Ephemeral,
                    });
                }

                // ── Advanced ────────────────────────────────────────────────
                if (id === 'jg_set_burst') {
                    const submitted = await promptModal(i, {
                        title: 'Burst alert trigger',
                        inputs: [
                            { id: 'count', label: 'Gated joins to trigger an alert', value: String(settings.burst_threshold), required: true, maxLength: 4 },
                            { id: 'window', label: 'Within how many seconds', value: String(settings.burst_window_seconds), required: true, maxLength: 5 },
                        ],
                    });
                    if (!submitted) return;

                    const count = clamp(Number(submitted.fields.getTextInputValue('count')), LIMITS.BURST_THRESHOLD);
                    const window = clamp(Number(submitted.fields.getTextInputValue('window')), LIMITS.BURST_WINDOW_SECONDS);
                    return applyChange(submitted, { burst_threshold: count, burst_window_seconds: window },
                        `Burst alert at **${count} gated joins / ${window}s**`);
                }

                if (id === 'jg_set_sweep') {
                    const submitted = await promptModal(i, {
                        title: 'Catch-up sweep window',
                        inputs: [{
                            id: 'hours',
                            label: `Hours of downtime to cover (${LIMITS.SWEEP_WINDOW_HOURS.min}-${LIMITS.SWEEP_WINDOW_HOURS.max})`,
                            value: String(settings.sweep_window_hours),
                            required: true,
                            maxLength: 4,
                        }],
                    });
                    if (!submitted) return;

                    const hours = clamp(Number(submitted.fields.getTextInputValue('hours')), LIMITS.SWEEP_WINDOW_HOURS);
                    return applyChange(submitted, { sweep_window_hours: hours },
                        `Catch-up sweep window set to **${hours}h**; only members who joined that recently are re-checked`);
                }

                if (id === 'jg_run_sweep') {
                    await i.deferReply({ flags: MessageFlags.Ephemeral });
                    const result = await sweepGuild(interaction.client, guild.id);
                    return i.editReply({
                        content: result.skipped
                            ? `⚠️ Sweep skipped: ${result.skipped}`
                            : `✅ Scanned ${result.scanned} member(s); **${result.gated}** matched and were queued`
                              + `${settings.dry_run ? ' *(dry run, nothing will actually be removed)*' : ''}.`,
                    });
                }

                // ── Diagnostics ─────────────────────────────────────────────
                if (id === 'jg_test_user') {
                    const submitted = await promptModal(i, {
                        title: 'Test a user ID',
                        inputs: [{ id: 'uid', label: 'User ID to evaluate', required: true, maxLength: 25 }],
                    });
                    if (!submitted) return;

                    const uid = submitted.fields.getTextInputValue('uid').trim().replace(/^<@!?/, '').replace(/>$/, '');
                    if (!SNOWFLAKE_RE.test(uid)) {
                        return submitted.reply({ content: '⚠️ That is not a user ID.', flags: MessageFlags.Ephemeral });
                    }

                    const decision = evaluateUserId(uid, settings, { guildOwnerId: guild.ownerId });
                    const created = Math.floor((Date.now() - decision.ageMs) / 1000);
                    const verdict = decision.action === 'gate'
                        ? `🔴 **Would be removed**: ${decision.reason}`
                        : `🟢 **Would be allowed**: ${decision.reason}`;

                    return submitted.reply({
                        content: `${verdict}\nCreated <t:${created}:F>\nEligible <t:${Math.floor(decision.eligibleAt / 1000)}:F> (<t:${Math.floor(decision.eligibleAt / 1000)}:R>)`
                            + '\n\n*Evaluated from the account snowflake. This checks the age rule only, not whether the bot could actually remove them.*',
                        flags: MessageFlags.Ephemeral,
                    });
                }

                if (id === 'jg_reset_stats') {
                    await resetStats(guild.id);
                    await refresh(i);
                    return;
                }

                // Unknown component: acknowledge so the client does not hang.
                if (!i.replied && !i.deferred) await i.deferUpdate().catch(() => {});
            } catch (error) {
                logger.error('[JOIN-GATE] Panel interaction failed', {
                    customId: i.customId, guildId: guild.id, error: error.message, stack: error.stack,
                });
                const notice = { content: '⚠️ That action failed. Check the logs.', flags: MessageFlags.Ephemeral };
                if (i.replied || i.deferred) await i.followUp(notice).catch(() => {});
                else await i.reply(notice).catch(() => {});
            }
        });

        collector.on('end', async () => {
            // Leave the last view readable, just inert.
            const last = await buildPanel(guild, state).catch(() => null);
            const notice = 'Panel timed out. Run /joingate again to make more changes.';

            // Components V2 has no `content` at all, so the notice has to move
            // inside the panel rather than sit above it.
            if (last?.embed && isV2Message(message)) {
                last.embed.setFooter({ text: notice });
                await interaction.editReply(ui(last.embed, [], { like: message })).catch(() => {});
                return;
            }
            await interaction.editReply({
                embeds: last?.embed ? [last.embed] : [],
                components: [],
                content: `*${notice}*`,
            }).catch(() => {});
        });
    },
};

/**
 * Test seam. The section renderers are pure functions of the settings row, and
 * tests/panelRows.test.js walks them to prove no section outgrows Discord's
 * five-row ceiling: the watch-window channel picker shipped complete and
 * invisible because the sixth row was being sliced off in silence.
 *
 * Safe to hang here: the command loader only ever reads `data` and `execute`.
 */
module.exports.__renderers = {
    sectionRow, renderOverview, renderRules, renderMessaging,
    renderEscalation, renderSuspicion, renderWatch, renderGuard, renderLogging, renderAdvanced,
};
