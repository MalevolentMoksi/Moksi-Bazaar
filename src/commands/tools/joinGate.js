// src/commands/tools/joinGate.js
/**
 * /joingate — owner-only configuration panel for the account-age auto-kicker.
 *
 * Layout: row 0 is always the section picker, rows 1-4 are that section's
 * controls. Everything is ephemeral, every write goes through the config
 * allow-list, and every write is mirrored to the config audit channel.
 */

const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder,
    TextInputStyle, ChannelType, MessageFlags, PermissionFlagsBits,
} = require('discord.js');

const { isOwner, OWNER_REJECTION_JOKES, EMBED_COLORS } = require('../../utils/constants');
const logger = require('../../utils/logger');
const {
    getSettings, updateSettings, resetStats, invalidate,
    formatDays, daysToMinutes, thresholdMs, clamp, LIMITS,
    DEFAULT_DM_MESSAGE, DEFAULT_DM_BAN_MESSAGE,
} = require('../../utils/joinGate/config');
const {
    evaluateUserId, renderDm, sweepGuild, getAttemptLeaderboard, displayTag,
} = require('../../utils/joinGate/enforcement');
const { describeRouting, logConfigChange, logTest, CATEGORIES } = require('../../utils/joinGate/logging');
const { getPendingUnbans, deletePendingUnban, recomputePendingUnbans, scheduleNext } =
    require('../../utils/joinGate/unbanScheduler');
const { checkGuildHealth } = require('../../utils/joinGate/diagnostics');

const PANEL_TIMEOUT_MS = 15 * 60_000;
const PANEL_IDLE_MS = 5 * 60_000;
const MODAL_TIMEOUT_MS = 120_000;

const SNOWFLAKE_RE = /^\d{17,20}$/;
const INVITE_RE = /^https:\/\/(discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/[A-Za-z0-9-]+$/;

const SECTIONS = [
    { value: 'overview', label: 'Overview', emoji: '📋', description: 'Status, master switch, dry run' },
    { value: 'rules', label: 'Rules', emoji: '📏', description: 'Age threshold, bots, exempt users' },
    { value: 'messaging', label: 'Messaging', emoji: '✉️', description: 'DM text, invite, preview & test' },
    { value: 'escalation', label: 'Escalation', emoji: '🔨', description: 'Temp-bans for repeat rejoiners' },
    { value: 'logging', label: 'Logging', emoji: '📓', description: 'Where each kind of event is written' },
    { value: 'advanced', label: 'Advanced', emoji: '⚙️', description: 'Burst alerts, downtime catch-up' },
    { value: 'diagnostics', label: 'Diagnostics', emoji: '🩺', description: 'Health check, stats, ID tester' },
];

// ── Small helpers ───────────────────────────────────────────────────────────

const onOff = v => (v ? '🟢 On' : '⚪ Off');
const yesNo = v => (v ? 'Yes' : 'No');
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
    const modalId = `jg_modal_${componentInteraction.id}`;
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(truncate(title, 45));

    for (const input of inputs) {
        const builder = new TextInputBuilder()
            .setCustomId(input.id)
            .setLabel(truncate(input.label, 45))
            .setStyle(input.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(input.required ?? false);
        if (input.value !== undefined && input.value !== null) builder.setValue(String(input.value).slice(0, 4000));
        if (input.placeholder) builder.setPlaceholder(truncate(input.placeholder, 100));
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
        return null; // timed out; the panel stays as it was
    }
}

// ── Section renderers ───────────────────────────────────────────────────────

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
        .setTitle('🛡️ Join Gate — Overview')
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
        .setTitle('📏 Join Gate — Rules')
        .setColor(EMBED_COLORS.INFO)
        .setDescription(
            'Account age is the **only** criterion, plus the explicit allow-list below.\n'
            + 'Roles are deliberately never consulted — an autorole bot that assigns a role on join '
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

function renderMessaging(settings) {
    const embed = new EmbedBuilder()
        .setTitle('✉️ Join Gate — Messaging')
        .setColor(EMBED_COLORS.INFO)
        .setDescription(
            'The DM is always sent **before** the removal — afterwards the bot no longer shares a server '
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
                    ? 'None — every attempt gets a DM'
                    : `${settings.dm_cooldown_minutes} min between DMs to the same user`,
                inline: true,
            },
            { name: 'Kick message', value: truncate(settings.dm_message, 1000), inline: false },
            {
                name: 'Temp-ban message',
                value: settings.escalate_enabled
                    ? truncate(settings.dm_ban_message, 1000)
                    : '*(escalation is off — unused)*',
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
            `<@${p.user_id}> — lifts <t:${Math.floor(Number(p.unban_at_ms) / 1000)}:R>`).join('\n')
        : '*none*';

    const embed = new EmbedBuilder()
        .setTitle('🔨 Join Gate — Escalation')
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
            { name: `Pending lifts (${pending.length})`, value: truncate(list, 1000), inline: false },
        );

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('jg_toggle_escalate')
                .setLabel(settings.escalate_enabled ? 'Disable escalation' : 'Enable escalation')
                .setStyle(settings.escalate_enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder().setCustomId('jg_set_attempts').setLabel('Set attempt limit').setStyle(ButtonStyle.Secondary),
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

function renderLogging(settings, routing, activeCategory) {
    const meta = logCategoryMeta(activeCategory);
    const rows = [];

    const lines = Object.entries(routing).map(([key, info]) => {
        const target = info.overrideId
            ? channelRef(info.overrideId)
            : (settings.log_channel_id ? `${channelRef(settings.log_channel_id)} *(default)*` : '*nowhere*');
        const state = !info.enabled ? '⚪ off' : info.usable ? '🟢' : '⚠️ unreachable';
        return `${state} **${info.label}** → ${target}`;
    });

    const embed = new EmbedBuilder()
        .setTitle('📓 Join Gate — Logging')
        .setColor(EMBED_COLORS.INFO)
        .setDescription(
            'Each category can have its own channel. Leave one unset and it falls back to the default '
            + 'channel — so "kicks and failures together" is just leaving both unset, while "failures to '
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

    return { embed, rows };
}

function renderAdvanced(settings) {
    const embed = new EmbedBuilder()
        .setTitle('⚙️ Join Gate — Advanced')
        .setColor(EMBED_COLORS.INFO)
        .setDescription(
            'Removals are always processed one at a time with a short gap, so a raid cannot rate-limit the '
            + 'bot. Under a heavy backlog DMs are skipped to drain faster — that is noted on each log entry.'
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
        .map(c => `${icon[c.level]} **${c.label}** — ${c.detail}`)
        .join('\n');

    const attemptLines = attempts.length
        ? attempts.map(a =>
            `<@${a.user_id}> — ${a.attempts} attempt(s), last <t:${Math.floor(Number(a.last_seen_ms) / 1000)}:R>`).join('\n')
        : '*no repeat joiners recorded*';

    const embed = new EmbedBuilder()
        .setTitle('🩺 Join Gate — Diagnostics')
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
        case 'logging':
            built = renderLogging(settings, await describeRouting(guild, settings), state.logCategory);
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

    return {
        settings,
        payload: {
            content: '',
            embeds: [built.embed],
            components: [sectionRow(state.section), ...built.rows].slice(0, 5),
        },
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
    // admin — locking the one person who is allowed to use it out of it.

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
        const state = { section: 'overview', logCategory: 'default' };

        const { payload } = await buildPanel(guild, state);
        const message = await interaction.editReply(payload);

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
         * message component, so that is checked rather than assumed — and if
         * the update fails for any reason we still edit the panel and
         * acknowledge the interaction, otherwise Discord shows the user a red
         * "interaction failed" on a change that actually saved.
         */
        const refresh = async (respondTo) => {
            const { payload: next } = await buildPanel(guild, state);

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
                    jg_toggle_dryrun: ['dry_run', s => (s.dry_run ? 'Dry run **off** — removals are live' : 'Dry run **on** — log only')],
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
                        `${adding ? 'Added' : 'Removed'} **${valid.length}** exempt user(s) — list is now ${next.length}`,
                        truncate(valid.map(v => `<@${v}>`).join(', '), 1000));

                    const notes = [];
                    if (invalid.length) {
                        notes.push(`Ignored ${invalid.length} unparseable entry/entries: ${truncate(invalid.join(', '), 400)}`);
                    }
                    if (dropped > 0) {
                        // Silently dropping exemptions would mean silently gating
                        // people the owner believes are safe. Say it out loud.
                        notes.push(`⚠️ The list is capped at ${LIMITS.EXEMPT_IDS} entries — **${dropped}** did not fit and were not saved.`);
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
                if (id === 'jg_edit_dm' || id === 'jg_edit_dm_ban') {
                    const isBan = id === 'jg_edit_dm_ban';
                    const submitted = await promptModal(i, {
                        title: isBan ? 'Temp-ban DM' : 'Kick DM',
                        inputs: [{
                            id: 'text',
                            label: 'Message — {days} {server} {user} {eligible}',
                            paragraph: true,
                            required: true,
                            value: isBan ? settings.dm_ban_message : settings.dm_message,
                            maxLength: LIMITS.DM_MESSAGE_LENGTH,
                        }],
                    });
                    if (!submitted) return;

                    const text = submitted.fields.getTextInputValue('text').trim();
                    if (!text) {
                        return submitted.reply({ content: '⚠️ Message cannot be empty.', flags: MessageFlags.Ephemeral });
                    }
                    return applyChange(submitted, { [isBan ? 'dm_ban_message' : 'dm_message']: text },
                        `${isBan ? 'Temp-ban' : 'Kick'} DM message updated`, truncate(text, 1000));
                }

                if (id === 'jg_reset_dm') {
                    return applyChange(i, { dm_message: DEFAULT_DM_MESSAGE, dm_ban_message: DEFAULT_DM_BAN_MESSAGE },
                        'DM messages reset to defaults');
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

                    const url = submitted.fields.getTextInputValue('url').trim();
                    if (url && !INVITE_RE.test(url)) {
                        // Restricted to Discord invites on purpose: this string is DMed
                        // to strangers, so it must not become an arbitrary-link vector.
                        return submitted.reply({
                            content: '⚠️ Only Discord invite links are accepted (`https://discord.gg/…` or `https://discord.com/invite/…`).',
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                    return applyChange(submitted, { dm_invite_url: url || null },
                        url ? `Rejoin invite set to ${url}` : 'Rejoin invite cleared');
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
                    const eligibleAt = Date.now() + thresholdMs(settings) / 2;
                    const kick = renderDm(settings, {
                        guildName: guild.name,
                        user: i.user,
                        eligibleAt,
                        ageMs: thresholdMs(settings) / 2,
                        kind: 'kick',
                    });
                    const ban = settings.escalate_enabled
                        ? renderDm(settings, {
                            guildName: guild.name, user: i.user, eligibleAt,
                            ageMs: thresholdMs(settings) / 2, kind: 'ban',
                        })
                        : null;

                    if (id === 'jg_preview_dm') {
                        return i.reply({
                            content: truncate(
                                `**Kick DM preview**\n>>> ${kick}` + (ban ? `\n\n**Temp-ban DM preview**\n>>> ${ban}` : ''),
                                1900
                            ),
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    try {
                        await i.user.send({ content: kick });
                        if (ban) await i.user.send({ content: ban });
                        return i.reply({ content: '✅ Test DM sent.', flags: MessageFlags.Ephemeral });
                    } catch (error) {
                        return i.reply({
                            content: `⚠️ Could not DM you: ${error.message}. (Which is exactly what happens to users with DMs closed — the removal still goes ahead.)`,
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
                                content: `⚠️ The bot cannot post in <#${channelId}> — it needs View Channel, Send Messages and Embed Links there.`,
                                flags: MessageFlags.Ephemeral,
                            });
                        }
                    }

                    return applyChange(i, { [key]: channelId },
                        channelId ? `${label} → <#${channelId}>` : `${label} cleared`);
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
                            : `⚠️ Nothing was delivered — **${label}** has no reachable channel. `
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
                        `Catch-up sweep window set to **${hours}h** — only members who joined that recently are re-checked`);
                }

                if (id === 'jg_run_sweep') {
                    await i.deferReply({ flags: MessageFlags.Ephemeral });
                    const result = await sweepGuild(interaction.client, guild.id);
                    return i.editReply({
                        content: result.skipped
                            ? `⚠️ Sweep skipped: ${result.skipped}`
                            : `✅ Scanned ${result.scanned} member(s); **${result.gated}** matched and were queued`
                              + `${settings.dry_run ? ' *(dry run — nothing will actually be removed)*' : ''}.`,
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
                        ? `🔴 **Would be removed** — ${decision.reason}`
                        : `🟢 **Would be allowed** — ${decision.reason}`;

                    return submitted.reply({
                        content: `${verdict}\nCreated <t:${created}:F>\nEligible <t:${Math.floor(decision.eligibleAt / 1000)}:F> (<t:${Math.floor(decision.eligibleAt / 1000)}:R>)`
                            + '\n\n*Evaluated from the account snowflake — this checks the age rule only, not whether the bot could actually remove them.*',
                        flags: MessageFlags.Ephemeral,
                    });
                }

                if (id === 'jg_reset_stats') {
                    await resetStats(guild.id);
                    await refresh(i);
                    return;
                }

                // Unknown component — acknowledge so the client does not hang.
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
            const { payload: last } = await buildPanel(guild, state).catch(() => ({ payload: null }));
            await interaction.editReply({
                embeds: last?.embeds ?? [],
                components: [],
                content: '*Panel timed out — run `/joingate` again to make more changes.*',
            }).catch(() => {});
        });
    },
};
