// src/commands/tools/speak_settings.js
/**
 * /speak_settings: owner-only control panel for the conversation system.
 *
 * Same architecture as /joingate: row 0 is a section picker, rows 1-4 are the
 * active section's controls, everything ephemeral, every handler behind the
 * owner check. Sections:
 *
 *   Overview      master switches and a health summary
 *   Interjections when/where the bot may butt in unprompted
 *   Memory        distilled long-term profiles + raw memory stats
 *   Delivery      multi-message "typing beats" + reply length mode
 *   Users         blacklist and attitude management
 */

const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder,
    TextInputStyle, ChannelType, MessageFlags,
} = require('discord.js');

const {
    pool, getSettingState,
    getSpeakConfigValue, setSpeakConfigValue,
    getSpeakProfile, deleteSpeakProfile, countSpeakProfiles,
} = require('../../utils/db.js');
const { DISTILL_EVERY_N } = require('../../utils/speakProfile');
const { normalisePipeline } = require('../../utils/speakPipeline');
const { OWNER_REJECTION_JOKES, isOwner, EMBED_COLORS } = require('../../utils/constants');
const { ui, retireControls, isV2Message } = require('../../utils/ui/panel');
const logger = require('../../utils/logger');

const PANEL_TIMEOUT_MS = 15 * 60_000;
const PANEL_IDLE_MS = 5 * 60_000;
const MODAL_TIMEOUT_MS = 120_000;
const SNOWFLAKE_RE = /^\d{17,20}$/;

const DEFAULT_INTERJECTIONS = Object.freeze({
    enabled: false, channels: [], keywords: [], chance: 15, cooldownMinutes: 10,
    // Extra gate: asks the cheap model whether the moment is worth a remark.
    // Off by default like every other addition; see utils/interjectionBouncer.js.
    bouncer: false,
});

const SECTIONS = [
    { value: 'overview', label: 'Overview', emoji: '📋', description: 'Master switches, health summary' },
    { value: 'brain', label: 'Brain', emoji: '🧪', description: 'Draft pipeline, room read, models' },
    { value: 'interject', label: 'Interjections', emoji: '💬', description: 'Let it butt in, on your terms' },
    { value: 'memory', label: 'Memory', emoji: '🧠', description: 'Long-term profiles, raw memory, vision cache' },
    { value: 'delivery', label: 'Delivery', emoji: '⌨️', description: 'Typing beats & reply length' },
    { value: 'users', label: 'Users', emoji: '👥', description: 'Blacklist, attitude resets' },
];

const onOff = v => (v ? '🟢 On' : '⚪ Off');

function truncate(text, max) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function parseId(raw) {
    const id = String(raw ?? '').trim().replace(/^<@!?/, '').replace(/>$/, '');
    return SNOWFLAKE_RE.test(id) ? id : null;
}

// ── Stats queries (kept from the old panel) ─────────────────────────────────

async function getBlacklistSummary() {
    const { rows } = await pool.query('SELECT user_id FROM speak_blacklist');
    return { count: rows.length, preview: rows.slice(0, 5).map(r => r.user_id) };
}

async function getMediaCacheStats() {
    const { rows } = await pool.query(`
        SELECT COUNT(*) as total_cached,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as cached_today
        FROM media_cache
    `);
    return { totalCached: rows[0]?.total_cached || 0, cachedToday: rows[0]?.cached_today || 0 };
}

async function getMemoryStats() {
    const { rows } = await pool.query(`
        SELECT
            (SELECT COUNT(*) FROM conversation_memories) AS total_memories,
            (SELECT COUNT(*) FROM conversation_memories WHERE is_context_only = false) AS real_exchanges,
            (SELECT COUNT(*) FROM user_preferences WHERE interaction_count > 0) AS tracked_users
    `);
    const r = rows[0] || {};
    return {
        totalMemories: Number(r.total_memories) || 0,
        realExchanges: Number(r.real_exchanges) || 0,
        trackedUsers: Number(r.tracked_users) || 0,
    };
}

// ── Modal helper (same pattern as /joingate) ────────────────────────────────

async function promptModal(componentInteraction, { title, inputs }) {
    const modalId = `ss_modal_${componentInteraction.id}`;
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
        return null;
    }
}

// ── Section renderers ───────────────────────────────────────────────────────

function sectionRow(active) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('ss_section')
            .setPlaceholder('Jump to a section…')
            .addOptions(SECTIONS.map(s => ({
                label: s.label, value: s.value, description: s.description,
                emoji: s.emoji, default: s.value === active,
            })))
    );
}

async function renderOverview(state) {
    const { activeSpeak, activeMedia, interjections, distill, delivery, memoryStats, profileCount, blacklist } = state;

    const embed = new EmbedBuilder()
        .setTitle('🛠️ Cooler Moksi: Overview')
        .setColor(activeSpeak ? EMBED_COLORS.SUCCESS : EMBED_COLORS.ERROR)
        .setDescription(activeSpeak
            ? 'The goat is awake. All systems below act only while this stays on.'
            : '🔴 **Maintenance mode.** The bot answers nobody but you.')
        .addFields(
            { name: '🗣️ Speak', value: onOff(activeSpeak), inline: true },
            { name: '👁️ Vision', value: onOff(activeMedia), inline: true },
            { name: '💬 Interjections', value: onOff(interjections.enabled), inline: true },
            { name: '🧠 Long-term memory', value: onOff(distill?.enabled), inline: true },
            { name: '⌨️ Multi-message', value: onOff(delivery?.multiMessage), inline: true },
            { name: '🚫 Blacklist', value: `${blacklist.count} user(s)`, inline: true },
            {
                name: 'Data',
                value: `${memoryStats.realExchanges} real exchanges · ${memoryStats.trackedUsers} users tracked · ${profileCount} distilled profile(s)`,
                inline: false,
            },
        );

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ss_toggle_speak')
                .setLabel(activeSpeak ? 'Silence the goat' : 'Wake the goat')
                .setStyle(activeSpeak ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('ss_toggle_vision')
                .setLabel(activeMedia ? 'Disable vision' : 'Enable vision')
                .setStyle(activeMedia ? ButtonStyle.Secondary : ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('ss_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary)
        ),
    ];

    return { embed, rows };
}

function renderInterjections(interjections) {
    const cfg = interjections;
    const channelsText = cfg.channels.length
        ? cfg.channels.map(id => `<#${id}>`).join(' ')
        : '⚠️ *none set; interjections cannot fire without at least one channel*';
    const keywordsText = cfg.keywords.length
        ? cfg.keywords.map(k => `\`${k}\``).join(', ')
        : '*none: any message in an allowed channel may roll the dice*';

    const embed = new EmbedBuilder()
        .setTitle('💬 Interjections')
        .setColor(cfg.enabled ? EMBED_COLORS.WARNING : EMBED_COLORS.NEUTRAL)
        .setDescription(
            'Lets the bot butt into conversations nobody invited it to. A message must clear every '
            + 'gate below, in order: allowed channel → keyword (if any are set) → per-channel cooldown '
            + '→ chance roll → bouncer (if on). Replies never ping anyone.'
        )
        .addFields(
            { name: 'Status', value: onOff(cfg.enabled), inline: true },
            { name: 'Chance', value: `${cfg.chance}% per eligible message`, inline: true },
            { name: 'Cooldown', value: `${cfg.cooldownMinutes} min per channel`, inline: true },
            {
                name: 'Bouncer',
                value: `${onOff(cfg.bouncer)}\n-# ${cfg.bouncer
                    ? 'a winning roll still has to be a moment worth reacting to'
                    : 'every winning roll interjects, however dull the moment'}`,
                inline: false,
            },
            { name: `Channels (${cfg.channels.length})`, value: truncate(channelsText, 1000), inline: false },
            { name: `Keywords (${cfg.keywords.length})`, value: truncate(keywordsText, 1000), inline: false },
        )
        .setFooter({ text: 'Example: channels = staff lounge, keywords = "moksi" -> it only reacts when staff mention it by name.' });

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ss_ij_toggle')
                .setLabel(cfg.enabled ? 'Disable interjections' : 'Enable interjections')
                .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
                .setDisabled(!cfg.enabled && cfg.channels.length === 0),
            new ButtonBuilder().setCustomId('ss_ij_tuning').setLabel('Chance & cooldown').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('ss_ij_keywords').setLabel('Edit keywords').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('ss_ij_bouncer')
                .setLabel(cfg.bouncer ? 'Bouncer off' : 'Bouncer on')
                .setStyle(cfg.bouncer ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('ss_ij_clear_channels')
                .setLabel('Clear channels')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(cfg.channels.length === 0)
        ),
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId('ss_ij_channels')
                .setPlaceholder('Set the allowed channels (replaces the list)')
                .setChannelTypes(ChannelType.GuildText)
                .setMinValues(1)
                .setMaxValues(10)
        ),
    ];

    return { embed, rows };
}

function renderBrain(pipeline) {
    const cfg = pipeline;
    const anyOn = cfg.prepass || cfg.drafts || cfg.memory || cfg.attitude;

    const embed = new EmbedBuilder()
        .setTitle('🧪 Brain')
        .setColor(anyOn ? EMBED_COLORS.WARNING : EMBED_COLORS.NEUTRAL)
        .setDescription(
            'The reply pipeline, piece by piece. Everything here is reversible: '
            + 'with all four off, replies are generated exactly the way they always were '
            + '(one DeepSeek V3 call, published unexamined).\n\n'
            + '**Room read**: a fast pre-pass decides what kind of moment it is and what deserves '
            + 'the reaction, before writing. **Drafts & judge**: every writer below drafts in '
            + 'parallel and a judge picks the best; no reply ships as an unexamined first draft. '
            + '**Memory v2**: distilled profiles become the primary memory (shown for everyone in '
            + 'the room), raw quote-pairs demoted. **Attitude v2**: one honest relationship '
            + 'sentence instead of five canned personas, fed by the room read instead of a '
            + 'separate sentiment call.\n\n'
            + 'The pre-pass and judge skip themselves when a reply is running late; the hard '
            + 'deadline stays 20s regardless of what is switched on.'
        )
        .addFields(
            { name: 'Room read', value: onOff(cfg.prepass), inline: true },
            { name: 'Drafts & judge', value: onOff(cfg.drafts), inline: true },
            { name: 'Memory v2', value: onOff(cfg.memory), inline: true },
            { name: 'Attitude v2', value: onOff(cfg.attitude), inline: true },
            { name: `Writers (${cfg.writers.length} drafts)`, value: cfg.writers.map(w => `\`${w}\``).join('\n'), inline: false },
            { name: 'Utility model (read + judge)', value: `\`${cfg.utilityModel}\``, inline: false },
        )
        .setFooter({ text: 'Rough cost with everything on: ~$0.002 per reply. Legacy path: ~$0.0008.' });

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ss_pl_prepass')
                .setLabel(cfg.prepass ? 'Room read off' : 'Room read on')
                .setStyle(cfg.prepass ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('ss_pl_drafts')
                .setLabel(cfg.drafts ? 'Drafts off' : 'Drafts on')
                .setStyle(cfg.drafts ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('ss_pl_memory')
                .setLabel(cfg.memory ? 'Memory v2 off' : 'Memory v2 on')
                .setStyle(cfg.memory ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('ss_pl_attitude')
                .setLabel(cfg.attitude ? 'Attitude v2 off' : 'Attitude v2 on')
                .setStyle(cfg.attitude ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('ss_pl_models')
                .setLabel('Edit models')
                .setStyle(ButtonStyle.Secondary)
        ),
    ];

    return { embed, rows };
}

function renderMemory(state) {
    const { distill, memoryStats, mediaStats, profileCount } = state;

    const embed = new EmbedBuilder()
        .setTitle('🧠 Memory')
        .setColor(EMBED_COLORS.INFO)
        .setDescription(
            'Two layers. **Raw memory** is the last exchanges, fed to the prompt as-is and recycled '
            + `constantly. **Distilled profiles** are small fact sheets (interests, running jokes, how `
            + `they treat the bot) rebuilt by a cheap model every ~${DISTILL_EVERY_N} real exchanges per user, `
            + 'so the bot remembers things long after the raw rows have scrolled away.'
        )
        .addFields(
            { name: 'Distillation', value: onOff(distill?.enabled), inline: true },
            { name: 'Profiles held', value: `${profileCount}`, inline: true },
            { name: 'Raw memory', value: `${memoryStats.realExchanges} real / ${memoryStats.totalMemories} rows`, inline: true },
            { name: '📦 Vision cache', value: `${mediaStats.totalCached} items (${mediaStats.cachedToday} new today)`, inline: false },
        );

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ss_distill_toggle')
                .setLabel(distill?.enabled ? 'Disable distillation' : 'Enable distillation')
                .setStyle(distill?.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder().setCustomId('ss_profile_view').setLabel('View a profile').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('ss_profile_reset').setLabel('Delete a profile').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('ss_clear_cache').setLabel('Purge vision cache').setStyle(ButtonStyle.Danger)
        ),
    ];

    return { embed, rows };
}

function renderDelivery(delivery) {
    const on = Boolean(delivery?.multiMessage);
    const adaptive = delivery?.replyLength === 'adaptive';
    const embed = new EmbedBuilder()
        .setTitle('⌨️ Delivery')
        .setColor(EMBED_COLORS.INFO)
        .setDescription(
            'With multi-message on, the model is allowed to write a reply as two or three very short '
            + 'beats, and each beat arrives as its own message with a typing pause between them:\n\n'
            + '> just\n> give it a few secs\n> don\'t kick him\n\n'
            + 'Off means everything arrives as one message, line breaks included.\n\n'
            + '**Reply length** controls how much the bot is allowed to say:\n'
            + '- **Terse**: hard lock at 1-2 sentences, no exceptions. The historical behaviour.\n'
            + '- **Adaptive**: short stays the default, but when a message genuinely calls for a real '
            + 'answer (an explanation, a real take, a story), it may go up to a short paragraph. '
            + 'Interjections stay short either way.'
        )
        .addFields(
            { name: 'Multi-message beats', value: onOff(on), inline: true },
            { name: 'Reply length', value: adaptive ? '📏 Adaptive' : '✂️ Terse', inline: true },
        );

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ss_delivery_toggle')
                .setLabel(on ? 'Disable beats' : 'Enable beats')
                .setStyle(on ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('ss_delivery_length')
                .setLabel(adaptive ? 'Switch to terse' : 'Switch to adaptive')
                .setStyle(ButtonStyle.Primary)
        ),
    ];

    return { embed, rows };
}

function renderUsers(blacklist) {
    const preview = blacklist.preview.length
        ? blacklist.preview.map(id => `<@${id}>`).join(', ') + (blacklist.count > 5 ? ` +${blacklist.count - 5} more` : '')
        : '*nobody*';

    const embed = new EmbedBuilder()
        .setTitle('👥 Users')
        .setColor(EMBED_COLORS.INFO)
        .addFields(
            { name: `Blacklist (${blacklist.count})`, value: truncate(preview, 1000), inline: false },
            { name: 'Attitude', value: 'Reset returns a user to neutral (sentiment 0), as if the bot had no opinion of them.', inline: false },
            { name: '💣 Full reset', value: 'Wipes every memory, profile, attitude and ledger entry for everyone, in one transaction. Asks you to type RESET first.', inline: false },
        );

    const rows = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ss_bl_add').setLabel('Block user').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('ss_bl_remove').setLabel('Unblock user').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('ss_attitude_reset').setLabel('Reset attitude').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('ss_reset_all').setLabel('Reset ALL relationships & memories').setStyle(ButtonStyle.Danger)
        ),
    ];

    return { embed, rows };
}

// ── Panel assembly ──────────────────────────────────────────────────────────

async function loadState() {
    const [activeSpeak, activeMedia, interjections, distill, delivery, pipelineRaw, blacklist, mediaStats, memoryStats, profileCount] =
        await Promise.all([
            getSettingState('active_speak'),
            getSettingState('active_media_analysis'),
            getSpeakConfigValue('interjections', DEFAULT_INTERJECTIONS),
            getSpeakConfigValue('distill', { enabled: false }),
            getSpeakConfigValue('delivery', { multiMessage: false }),
            getSpeakConfigValue('pipeline', null),
            getBlacklistSummary(),
            getMediaCacheStats(),
            getMemoryStats(),
            countSpeakProfiles(),
        ]);

    return {
        activeSpeak, activeMedia,
        interjections: { ...DEFAULT_INTERJECTIONS, ...(interjections ?? {}) },
        distill: distill ?? { enabled: false },
        delivery: delivery ?? { multiMessage: false },
        pipeline: normalisePipeline(pipelineRaw),
        blacklist, mediaStats, memoryStats, profileCount,
    };
}

async function buildPanel(section) {
    const state = await loadState();
    let built;
    switch (section) {
        case 'brain': built = renderBrain(state.pipeline); break;
        case 'interject': built = renderInterjections(state.interjections); break;
        case 'memory': built = renderMemory(state); break;
        case 'delivery': built = renderDelivery(state.delivery); break;
        case 'users': built = renderUsers(state.blacklist); break;
        default: built = await renderOverview(state);
    }
    // Embed and rows stay separate: the send site is the only place that knows
    // whether it is creating a message or editing an existing one, and under
    // Components V2 that choice cannot be revisited.
    return {
        state,
        embed: built.embed,
        rows: [sectionRow(section), ...built.rows].slice(0, 5),
    };
}

// ── Command ─────────────────────────────────────────────────────────────────

module.exports = {
    data: new SlashCommandBuilder()
        .setName('speak_settings')
        .setDescription('Admin controls for Cooler Moksi'),

    async execute(interaction) {
        if (!isOwner(interaction.user.id)) {
            const msg = OWNER_REJECTION_JOKES[Math.floor(Math.random() * OWNER_REJECTION_JOKES.length)];
            return await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const panel = { section: 'overview' };
        const opening = await buildPanel(panel.section);
        const message = await interaction.editReply(ui(opening.embed, opening.rows, { scope: 'speak' }));

        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && isOwner(i.user.id),
            time: PANEL_TIMEOUT_MS,
            idle: PANEL_IDLE_MS,
        });

        const refresh = async (respondTo) => {
            const rebuilt = await buildPanel(panel.section);
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

                if (id === 'ss_section') { panel.section = i.values[0]; return refresh(i); }
                if (id === 'ss_refresh') return refresh(i);

                // ── Master switches ─────────────────────────────────────────
                if (id === 'ss_toggle_speak' || id === 'ss_toggle_vision') {
                    const key = id === 'ss_toggle_speak' ? 'active_speak' : 'active_media_analysis';
                    const current = await getSettingState(key);
                    await pool.query(`
                        INSERT INTO settings (setting, state) VALUES ($1, $2)
                        ON CONFLICT (setting) DO UPDATE SET state = EXCLUDED.state
                    `, [key, !current]);
                    logger.info('Speak setting toggled', { key, newState: !current, by: i.user.id });
                    return refresh(i);
                }

                // ── Interjections ───────────────────────────────────────────
                if (id === 'ss_ij_toggle') {
                    const cfg = { ...DEFAULT_INTERJECTIONS, ...(await getSpeakConfigValue('interjections', DEFAULT_INTERJECTIONS) ?? {}) };
                    if (!cfg.enabled && cfg.channels.length === 0) {
                        return i.reply({ content: '⚠️ Pick at least one channel first; interjections have no "everywhere" mode.', flags: MessageFlags.Ephemeral });
                    }
                    await setSpeakConfigValue('interjections', { ...cfg, enabled: !cfg.enabled });
                    logger.info('Interjections toggled', { enabled: !cfg.enabled, by: i.user.id });
                    return refresh(i);
                }

                if (id === 'ss_ij_bouncer') {
                    const cfg = { ...DEFAULT_INTERJECTIONS, ...(await getSpeakConfigValue('interjections', DEFAULT_INTERJECTIONS) ?? {}) };
                    await setSpeakConfigValue('interjections', { ...cfg, bouncer: !cfg.bouncer });
                    logger.info('Interjection bouncer toggled', { enabled: !cfg.bouncer, by: i.user.id });
                    return refresh(i);
                }

                if (id === 'ss_ij_channels') {
                    const cfg = { ...DEFAULT_INTERJECTIONS, ...(await getSpeakConfigValue('interjections', DEFAULT_INTERJECTIONS) ?? {}) };
                    await setSpeakConfigValue('interjections', { ...cfg, channels: i.values });
                    return refresh(i);
                }

                if (id === 'ss_ij_clear_channels') {
                    const cfg = { ...DEFAULT_INTERJECTIONS, ...(await getSpeakConfigValue('interjections', DEFAULT_INTERJECTIONS) ?? {}) };
                    // No channels means it can never fire; disarm it too so the
                    // panel never shows "enabled" for something that cannot run.
                    await setSpeakConfigValue('interjections', { ...cfg, channels: [], enabled: false });
                    return refresh(i);
                }

                if (id === 'ss_ij_keywords') {
                    const cfg = { ...DEFAULT_INTERJECTIONS, ...(await getSpeakConfigValue('interjections', DEFAULT_INTERJECTIONS) ?? {}) };
                    const submitted = await promptModal(i, {
                        title: 'Interjection keywords',
                        inputs: [{
                            id: 'keywords',
                            label: 'Comma separated (empty = react to anything)',
                            paragraph: true,
                            value: cfg.keywords.join(', '),
                            placeholder: 'moksi, goat',
                            maxLength: 500,
                        }],
                    });
                    if (!submitted) return;
                    const keywords = submitted.fields.getTextInputValue('keywords')
                        .split(',').map(k => k.trim().toLowerCase()).filter(Boolean).slice(0, 20);
                    await setSpeakConfigValue('interjections', { ...cfg, keywords });
                    return refresh(submitted);
                }

                if (id === 'ss_ij_tuning') {
                    const cfg = { ...DEFAULT_INTERJECTIONS, ...(await getSpeakConfigValue('interjections', DEFAULT_INTERJECTIONS) ?? {}) };
                    const submitted = await promptModal(i, {
                        title: 'Interjection tuning',
                        inputs: [
                            { id: 'chance', label: 'Chance %, per eligible message (1-100)', value: String(cfg.chance), required: true, maxLength: 3 },
                            { id: 'cooldown', label: 'Cooldown minutes, per channel (1-1440)', value: String(cfg.cooldownMinutes), required: true, maxLength: 4 },
                        ],
                    });
                    if (!submitted) return;
                    const chance = Math.min(100, Math.max(1, Math.round(Number(submitted.fields.getTextInputValue('chance')) || 15)));
                    const cooldownMinutes = Math.min(1440, Math.max(1, Math.round(Number(submitted.fields.getTextInputValue('cooldown')) || 10)));
                    await setSpeakConfigValue('interjections', { ...cfg, chance, cooldownMinutes });
                    return refresh(submitted);
                }

                // ── Brain (pipeline) ────────────────────────────────────────
                if (id === 'ss_pl_prepass' || id === 'ss_pl_drafts' || id === 'ss_pl_memory' || id === 'ss_pl_attitude') {
                    const key = id.slice('ss_pl_'.length);
                    const cfg = normalisePipeline(await getSpeakConfigValue('pipeline', null));
                    cfg[key] = !cfg[key];
                    await setSpeakConfigValue('pipeline', cfg);
                    logger.info('Speak pipeline toggled', { key, enabled: cfg[key], by: i.user.id });
                    return refresh(i);
                }

                if (id === 'ss_pl_models') {
                    const cfg = normalisePipeline(await getSpeakConfigValue('pipeline', null));
                    const submitted = await promptModal(i, {
                        title: 'Pipeline models',
                        inputs: [
                            {
                                id: 'writers',
                                label: 'Writers, comma separated (max 4)',
                                paragraph: true,
                                value: cfg.writers.join(', '),
                                placeholder: 'vendor/model, vendor/model',
                                maxLength: 400,
                                required: true,
                            },
                            {
                                id: 'utility',
                                label: 'Utility model (room read + judge)',
                                value: cfg.utilityModel,
                                maxLength: 100,
                                required: true,
                            },
                        ],
                    });
                    if (!submitted) return;

                    const writersInput = submitted.fields.getTextInputValue('writers')
                        .split(',').map(w => w.trim()).filter(Boolean);
                    const next = normalisePipeline({
                        ...cfg,
                        writers: writersInput,
                        utilityModel: submitted.fields.getTextInputValue('utility').trim(),
                    });
                    await setSpeakConfigValue('pipeline', next);
                    logger.info('Speak pipeline models changed', { writers: next.writers, utility: next.utilityModel, by: i.user.id });

                    await refresh(null);
                    const dropped = writersInput.length - next.writers.length;
                    return submitted.reply({
                        content: `✅ Writers: ${next.writers.map(w => `\`${w}\``).join(', ')}\nUtility: \`${next.utilityModel}\``
                            + (dropped > 0 ? `\n⚠️ ${dropped} entr${dropped === 1 ? 'y' : 'ies'} did not look like a model id and ${dropped === 1 ? 'was' : 'were'} dropped.` : ''),
                        flags: MessageFlags.Ephemeral,
                    });
                }

                // ── Memory ──────────────────────────────────────────────────
                if (id === 'ss_distill_toggle') {
                    const cfg = await getSpeakConfigValue('distill', { enabled: false }) ?? { enabled: false };
                    await setSpeakConfigValue('distill', { ...cfg, enabled: !cfg.enabled });
                    logger.info('Profile distillation toggled', { enabled: !cfg.enabled, by: i.user.id });
                    return refresh(i);
                }

                if (id === 'ss_profile_view' || id === 'ss_profile_reset') {
                    const viewing = id === 'ss_profile_view';
                    const submitted = await promptModal(i, {
                        title: viewing ? 'View a profile' : 'Delete a profile',
                        inputs: [{ id: 'uid', label: 'User ID', required: true, maxLength: 25 }],
                    });
                    if (!submitted) return;
                    const uid = parseId(submitted.fields.getTextInputValue('uid'));
                    if (!uid) return submitted.reply({ content: '⚠️ That is not a user ID.', flags: MessageFlags.Ephemeral });

                    if (viewing) {
                        const row = await getSpeakProfile(uid);
                        return submitted.reply({
                            content: row?.profile
                                ? `**Distilled profile for <@${uid}>** (as of <t:${Math.floor(Number(row.updated_at_ms) / 1000)}:R>):\n${row.profile}`
                                : `No distilled profile stored for <@${uid}> yet.`,
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                    const deleted = await deleteSpeakProfile(uid);
                    await refresh(null);
                    return submitted.reply({
                        content: deleted ? `✅ Profile for <@${uid}> deleted. It will rebuild from scratch.` : `Nothing stored for <@${uid}>.`,
                        flags: MessageFlags.Ephemeral,
                    });
                }

                if (id === 'ss_clear_cache') {
                    const { rowCount } = await pool.query('DELETE FROM media_cache');
                    logger.info('Media cache cleared', { deleted: rowCount, by: i.user.id });
                    return i.reply({ content: `✅ Purged ${rowCount} cached vision items.`, flags: MessageFlags.Ephemeral });
                }

                // ── Delivery ────────────────────────────────────────────────
                if (id === 'ss_delivery_toggle') {
                    const cfg = await getSpeakConfigValue('delivery', { multiMessage: false }) ?? { multiMessage: false };
                    await setSpeakConfigValue('delivery', { ...cfg, multiMessage: !cfg.multiMessage });
                    logger.info('Multi-message delivery toggled', { enabled: !cfg.multiMessage, by: i.user.id });
                    return refresh(i);
                }

                if (id === 'ss_delivery_length') {
                    const cfg = await getSpeakConfigValue('delivery', { multiMessage: false }) ?? { multiMessage: false };
                    const next = cfg.replyLength === 'adaptive' ? 'terse' : 'adaptive';
                    await setSpeakConfigValue('delivery', { ...cfg, replyLength: next });
                    logger.info('Reply length mode changed', { mode: next, by: i.user.id });
                    return refresh(i);
                }

                // ── Users ───────────────────────────────────────────────────
                if (id === 'ss_bl_add' || id === 'ss_bl_remove') {
                    const adding = id === 'ss_bl_add';
                    const submitted = await promptModal(i, {
                        title: adding ? 'Block user' : 'Unblock user',
                        inputs: [{ id: 'uid', label: 'User ID', required: true, maxLength: 25 }],
                    });
                    if (!submitted) return;
                    const uid = parseId(submitted.fields.getTextInputValue('uid'));
                    if (!uid) return submitted.reply({ content: '⚠️ That is not a user ID.', flags: MessageFlags.Ephemeral });

                    if (adding) {
                        await pool.query('INSERT INTO speak_blacklist (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [uid]);
                    } else {
                        await pool.query('DELETE FROM speak_blacklist WHERE user_id = $1', [uid]);
                    }
                    logger.info(adding ? 'User blacklisted' : 'User unblacklisted', { userId: uid, by: i.user.id });
                    await refresh(null);
                    return submitted.reply({ content: `✅ <@${uid}> ${adding ? 'blocked' : 'unblocked'}.`, flags: MessageFlags.Ephemeral });
                }

                if (id === 'ss_reset_all') {
                    const submitted = await promptModal(i, {
                        title: 'Reset ALL relationships & memories',
                        inputs: [{
                            id: 'confirm',
                            label: 'Type RESET (uppercase) to confirm',
                            required: true,
                            maxLength: 10,
                            placeholder: 'This wipes every user. There is no undo.',
                        }],
                    });
                    if (!submitted) return;
                    if (submitted.fields.getTextInputValue('confirm').trim() !== 'RESET') {
                        return submitted.reply({ content: 'Not touched. It only listens to the exact word RESET.', flags: MessageFlags.Ephemeral });
                    }

                    // One transaction: a half-wiped memory system (profiles
                    // gone, attitudes kept) would be worse than either state.
                    const client = await pool.connect();
                    let counts;
                    try {
                        await client.query('BEGIN');
                        const memories = await client.query('DELETE FROM conversation_memories');
                        const ledger = await client.query('DELETE FROM attitude_ledger');
                        const profiles = await client.query('DELETE FROM speak_profiles');
                        const prefs = await client.query(`
                            UPDATE user_preferences
                            SET sentiment_score = 0, attitude_level = 'neutral', interaction_count = 0,
                                last_sentiment_update = NOW(), updated_at = NOW()
                        `);
                        await client.query('COMMIT');
                        counts = {
                            memories: memories.rowCount, ledger: ledger.rowCount,
                            profiles: profiles.rowCount, users: prefs.rowCount,
                        };
                    } catch (txError) {
                        await client.query('ROLLBACK').catch(() => {});
                        throw txError;
                    } finally {
                        client.release();
                    }

                    logger.warn('FULL relationship & memory reset executed', { ...counts, by: i.user.id });
                    await refresh(null);
                    return submitted.reply({
                        content: `💣 Done. ${counts.memories} memories, ${counts.profiles} profiles and ${counts.ledger} ledger entries deleted; ${counts.users} users back to neutral strangers.`,
                        flags: MessageFlags.Ephemeral,
                    });
                }

                if (id === 'ss_attitude_reset') {
                    const submitted = await promptModal(i, {
                        title: 'Reset attitude to neutral',
                        inputs: [{ id: 'uid', label: 'User ID', required: true, maxLength: 25 }],
                    });
                    if (!submitted) return;
                    const uid = parseId(submitted.fields.getTextInputValue('uid'));
                    if (!uid) return submitted.reply({ content: '⚠️ That is not a user ID.', flags: MessageFlags.Ephemeral });

                    const { rowCount } = await pool.query(`
                        UPDATE user_preferences
                        SET sentiment_score = 0, attitude_level = 'neutral', last_sentiment_update = NOW(), updated_at = NOW()
                        WHERE user_id = $1
                    `, [uid]);
                    logger.info('User attitude reset', { userId: uid, by: i.user.id });
                    return submitted.reply({
                        content: rowCount > 0 ? `✅ Reset <@${uid}> to neutral.` : `⚠️ No record found for <@${uid}>.`,
                        flags: MessageFlags.Ephemeral,
                    });
                }

                if (!i.replied && !i.deferred) await i.deferUpdate().catch(() => {});
            } catch (error) {
                logger.error('speak_settings interaction failed', { customId: i.customId, error: error.message, stack: error.stack });
                const notice = { content: '⚠️ That action failed. Check the logs.', flags: MessageFlags.Ephemeral };
                if (i.replied || i.deferred) await i.followUp(notice).catch(() => {});
                else await i.reply(notice).catch(() => {});
            }
        });

        collector.on('end', async () => {
            const notice = 'Panel timed out. Run /speak_settings again to make more changes.';

            // Under Components V2 there is no `content` to put the notice in,
            // and blanking `components` would erase the panel rather than its
            // buttons. Rebuild it with the notice as its footer instead, so
            // the timed-out panel reads the same either way.
            if (isV2Message(message)) {
                const last = await buildPanel(panel.section).catch(() => null);
                if (last?.embed) {
                    last.embed.setFooter({ text: notice });
                    await interaction.editReply(ui(last.embed, [], { like: message })).catch(() => {});
                } else {
                    await interaction.editReply(retireControls(message)).catch(() => {});
                }
                return;
            }
            await interaction.editReply({
                components: [],
                content: `*${notice}*`,
            }).catch(() => {});
        });
    },
};
