// src/utils/ui/panel.js
/**
 * One description, two renderings.
 *
 * Every panel in the bot is still authored as an EmbedBuilder, exactly as
 * before. This module is the only place that decides how that description
 * reaches Discord: as a classic embed, or converted into a Components V2
 * container. Nothing else in the codebase knows which is in play, so the two
 * renderings cannot drift apart the way two hand-written copies would.
 *
 * The interesting problem is that Components V2 has no field primitive. An
 * embed's inline fields sit in three columns; V2 has only a vertical stack.
 * A naive translation makes dense panels roughly three times taller and
 * aligns nothing, so instead this picks a layout per run of fields:
 *
 *   table  - four or more short, markup-free inline fields become a padded
 *            monospace block. Values actually line up, which embed fields
 *            never did.
 *   pairs  - two or three inline fields share a line.
 *   prose  - anything full-width keeps a bold label above its value.
 *
 * Every run collapses into a single text display, which also keeps the
 * 40-component and 4000-character ceilings out of reach.
 */

const {
    ContainerBuilder, SectionBuilder, TextDisplayBuilder, SeparatorBuilder,
    ThumbnailBuilder, MediaGalleryBuilder, MessageFlags, SeparatorSpacingSize,
    ComponentType,
} = require('discord.js');

const { isV2Scope } = require('./mode');

/** Leave headroom under Discord's ceilings rather than sitting on them. */
const MAX_COMPONENTS = 36;
const MAX_TEXT_CHARS = 3800;

/** Beyond this a monospace row wraps on a phone and the alignment is a lie. */
const TABLE_NAME_MAX = 22;
const TABLE_VALUE_MAX = 26;
const TABLE_MIN_ROWS = 4;

/** Roughly one line of a desktop container before it starts to wrap. */
const PAIR_LINE_CHARS = 68;
const PAIR_MAX_PER_LINE = 3;

const EMOJI_RE = /\p{Extended_Pictographic}️?|\p{Regional_Indicator}/gu;

/** True when this message was sent as Components V2 and must stay that way. */
function isV2Message(message) {
    const flags = message?.flags;
    if (!flags) return false;
    if (typeof flags.has === 'function') return flags.has(MessageFlags.IsComponentsV2);
    return (Number(flags) & MessageFlags.IsComponentsV2) !== 0;
}

/** Accepts an EmbedBuilder, a plain embed, or an already-serialised one. */
function embedData(embed) {
    if (!embed) return {};
    if (typeof embed.toJSON === 'function') return embed.toJSON();
    return embed.data || embed;
}

/**
 * Code blocks render markdown literally and mangle emoji width, so a cell is
 * only table-safe once it is plain text. Returns null when stripping would
 * change what the value means.
 */
function tableCell(raw) {
    const text = String(raw ?? '');
    // Mentions, channel refs and <t:> timestamps all die inside a code block.
    if (text.includes('<') || text.includes('\n')) return null;
    const stripped = text
        .replace(EMOJI_RE, '')
        .replace(/\*\*|__|~~|`|\*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return stripped.length ? stripped : null;
}

/** Pads names into a column so the values start at the same offset. */
function alignTable(entries) {
    const width = Math.min(TABLE_NAME_MAX, Math.max(...entries.map(e => e.name.length)));
    const lines = entries.map(({ name, value }) => {
        const label = name.length > width ? `${name.slice(0, width - 1)}…` : name.padEnd(width, ' ');
        return `${label}  ${value}`;
    });
    return ['```', ...lines, '```'].join('\n');
}

/** Can this run of inline fields become an aligned block? */
function asTable(run) {
    if (run.length < TABLE_MIN_ROWS) return null;
    const entries = [];
    for (const field of run) {
        const name = tableCell(field.name);
        const value = tableCell(field.value);
        if (!name || !value) return null;
        if (name.length > TABLE_NAME_MAX || value.length > TABLE_VALUE_MAX) return null;
        entries.push({ name, value });
    }
    return alignTable(entries);
}

/** Two or three stats per line, keeping the bold-label look of an embed. */
function asPairs(run) {
    const parts = run.map(f => `**${String(f.name).trim()}** ${String(f.value).replace(/\n+/g, ' ').trim()}`);
    const lines = [];
    let current = [];
    let length = 0;
    for (const part of parts) {
        const wouldBe = length + part.length + 3;
        if (current.length && (current.length >= PAIR_MAX_PER_LINE || wouldBe > PAIR_LINE_CHARS)) {
            lines.push(current.join(' · '));
            current = [];
            length = 0;
        }
        current.push(part);
        length += part.length + 3;
    }
    if (current.length) lines.push(current.join(' · '));
    return lines.join('\n');
}

/** A full-width field keeps its label on its own line, like the embed did. */
function asProse(field) {
    const name = String(field.name ?? '').trim();
    const value = String(field.value ?? '').trim();
    if (!name) return value;
    if (!value) return `**${name}**`;
    return `**${name}**\n${value}`;
}

/**
 * Walks the fields in order, batching consecutive inline ones so a run can be
 * judged as a whole. Order is preserved, because an embed's field order is
 * the author's intent.
 *
 * @returns {Array<{kind: string, text: string}>}
 */
function planFields(fields, { layout = 'auto' } = {}) {
    const blocks = [];
    let run = [];

    const flushRun = () => {
        if (!run.length) return;
        if (layout !== 'pairs') {
            const table = asTable(run);
            if (table && layout !== 'prose') {
                blocks.push({ kind: 'table', text: table });
                run = [];
                return;
            }
        }
        blocks.push({ kind: 'pairs', text: asPairs(run) });
        run = [];
    };

    for (const field of fields || []) {
        if (field?.inline) {
            run.push(field);
            continue;
        }
        flushRun();
        blocks.push({ kind: 'prose', text: asProse(field) });
    }
    flushRun();
    return blocks;
}

/** Footer and timestamp collapse into one subtext line, Discord's own idiom. */
function footerLine(data) {
    const bits = [];
    if (data.footer?.text) bits.push(String(data.footer.text).replace(/\n+/g, ' ').trim());
    if (data.timestamp) {
        const ms = new Date(data.timestamp).getTime();
        if (Number.isFinite(ms)) bits.push(`<t:${Math.floor(ms / 1000)}:R>`);
    }
    if (!bits.length) return null;
    return `-# ${bits.join(' · ')}`;
}

/** The title, honouring a link the way the embed would have. */
function titleLine(data) {
    if (!data.title) return null;
    const title = String(data.title).trim();
    return data.url ? `**[${title}](${data.url})**` : `**${title}**`;
}

/**
 * Converts an embed description into a Components V2 container.
 *
 * @param {object} embed EmbedBuilder or plain embed
 * @param {Array} rows ActionRowBuilders to place inside the container
 * @param {object} opts
 * @param {string} [opts.layout] force 'table', 'pairs' or 'prose' for fields
 * @returns {ContainerBuilder|null} null when there is nothing to render
 */
function toContainer(embed, rows = [], opts = {}) {
    const data = embedData(embed);
    const container = new ContainerBuilder();
    if (typeof data.color === 'number') container.setAccentColor(data.color);

    let budget = MAX_TEXT_CHARS;
    let slots = MAX_COMPONENTS;
    let wrote = false;

    /** Adds a text display if there is room, and reports whether it landed. */
    const text = (content) => {
        if (!content || slots <= 0) return false;
        const trimmed = content.length > budget ? `${content.slice(0, Math.max(0, budget - 1))}…` : content;
        if (!trimmed.trim()) return false;
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(trimmed));
        budget -= trimmed.length;
        slots -= 1;
        wrote = true;
        return true;
    };

    const separator = (large = false) => {
        if (slots <= 1) return;
        container.addSeparatorComponents(
            new SeparatorBuilder()
                .setDivider(true)
                .setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small),
        );
        slots -= 1;
    };

    if (data.author?.name) text(`-# ${String(data.author.name).trim()}`);

    const heading = titleLine(data);
    const body = data.description ? String(data.description).trim() : null;

    // A thumbnail becomes a real accessory beside the heading rather than a
    // detached corner image, which is the one layout V2 does better for free.
    if (data.thumbnail?.url && (heading || body)) {
        const section = new SectionBuilder()
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(data.thumbnail.url));
        const lines = [heading, body].filter(Boolean);
        for (const line of lines.slice(0, 3)) {
            const trimmed = line.length > budget ? `${line.slice(0, Math.max(0, budget - 1))}…` : line;
            section.addTextDisplayComponents(new TextDisplayBuilder().setContent(trimmed));
            budget -= trimmed.length;
        }
        container.addSectionComponents(section);
        slots -= 1;
        wrote = true;
    } else {
        if (heading) text(heading);
        if (body) text(body);
    }

    const blocks = planFields(data.fields, opts);
    if (blocks.length && wrote) separator();
    for (const block of blocks) text(block.text);

    if (data.image?.url && slots > 0) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems({ media: { url: data.image.url } }),
        );
        slots -= 1;
        wrote = true;
    }

    // Controls belong to the panel they drive, so they go inside the box.
    const usable = (rows || []).filter(Boolean).slice(0, Math.max(0, Math.min(5, slots - 1)));
    if (usable.length) {
        if (wrote) separator();
        container.addActionRowComponents(...usable);
        slots -= usable.length;
        wrote = true;
    }

    const footer = footerLine(data);
    if (footer) text(footer);

    return wrote ? container : null;
}

/**
 * Builds the payload to spread into reply/editReply/update/send.
 *
 * Which rendering it picks, in order of authority:
 *   opts.mode   - an explicit 'v1' or 'v2'
 *   opts.like   - match an existing message, because the V2 flag is permanent
 *   opts.scope  - the surface toggle, for brand new messages
 *
 * @param {object|Array} embed the panel, or several of them
 * @param {Array} components ActionRowBuilders
 * @param {object} opts { scope, like, mode, ephemeral, files, layout }
 */
function ui(embed, components = [], opts = {}) {
    const { scope, like, mode, ephemeral = false, files, layout } = opts;
    const rows = Array.isArray(components) ? components.filter(Boolean) : [];
    // A message may carry several embeds; each becomes its own container, and
    // the controls belong to the last one.
    const panels = (Array.isArray(embed) ? embed : [embed]).filter(Boolean);

    let useV2;
    if (mode === 'v2' || mode === 'v1') {
        useV2 = mode === 'v2';
    } else if (like !== undefined && like !== null) {
        // Editing: the flag on the existing message is the only valid answer.
        useV2 = isV2Message(like);
    } else {
        useV2 = scope ? isV2Scope(scope) : false;
    }

    const payload = {};
    if (files) payload.files = files;

    if (useV2) {
        const containers = panels
            .map((panel, index) => toContainer(panel, index === panels.length - 1 ? rows : [], { layout }))
            .filter(Boolean);
        if (containers.length) {
            payload.components = containers;
            // Ephemeral cannot be added to a message that already exists, so it
            // is only ever set when this payload creates one.
            payload.flags = (like === undefined || like === null) && ephemeral
                ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
                : MessageFlags.IsComponentsV2;
            return payload;
        }
        // An empty container is not a legal message; fall through to the embed.
    }

    payload.embeds = panels;
    payload.components = rows;
    if (ephemeral && (like === undefined || like === null)) payload.flags = MessageFlags.Ephemeral;
    return payload;
}

/**
 * Swaps the controls on a message that is already posted, without touching
 * anything else on it.
 *
 * Under classic embeds this is the one-liner it always was, because components
 * are just the buttons. Under Components V2 `components` is the ENTIRE message
 * body, so the same one-liner would blank the panel and leave a bare row of
 * dead buttons behind. This reads the existing container back off the message
 * and rewrites only its action rows.
 *
 * @param {object} message the posted message
 * @param {Array} rows replacement rows; an empty array removes the controls
 */
function retireControls(message, rows = []) {
    const replacements = (rows || [])
        .filter(Boolean)
        .map(row => (typeof row.toJSON === 'function' ? row.toJSON() : row));

    if (!isV2Message(message)) return { components: replacements };

    const existing = (message.components || [])
        .map(part => (typeof part.toJSON === 'function' ? part.toJSON() : part));
    const container = existing.find(part => part.type === ComponentType.Container) || existing[0];
    if (!container) {
        return { components: replacements, flags: MessageFlags.IsComponentsV2 };
    }

    const children = container.components || [];
    const kept = [];
    let used = 0;

    for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (child?.type === ComponentType.ActionRow) {
            if (used < replacements.length) kept.push(replacements[used]);
            used += 1;
            continue;
        }
        // A separator that only existed to introduce controls goes with them.
        const next = children[i + 1];
        const introducesDroppedRow = child?.type === ComponentType.Separator
            && next?.type === ComponentType.ActionRow
            && replacements.length === 0;
        if (introducesDroppedRow) continue;
        kept.push(child);
    }

    while (used < replacements.length) {
        kept.push(replacements[used]);
        used += 1;
    }

    return {
        components: [{ ...container, components: kept }],
        flags: MessageFlags.IsComponentsV2,
    };
}

module.exports = {
    ui,
    toContainer,
    retireControls,
    isV2Message,
    planFields,
    alignTable,
    tableCell,
    footerLine,
    MAX_COMPONENTS,
    MAX_TEXT_CHARS,
};
