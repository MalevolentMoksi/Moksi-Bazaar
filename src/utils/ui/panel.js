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

/**
 * A code block is reference furniture: right for a settings page or a spec
 * sheet, far too heavy for a dice roll you glance at once and forget. Row
 * count is the only generic signal for which is which, and four was low
 * enough to make /craps look like a config dump.
 */
const TABLE_MIN_ROWS = 5;

/** Roughly one line of a desktop container before it starts to wrap. */
const PAIR_LINE_CHARS = 68;
const PAIR_MAX_PER_LINE = 3;

/** Past this a full-width value wants its own line, as it had in the embed. */
const PROSE_INLINE_MAX = 44;

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

/** Markdown is literal inside a code block, so it has to go either way. */
const stripMarkup = text => text.replace(/\*\*|__|~~|`|\*/g, '');

/**
 * The left column of a table gets padded to a fixed width, so it has to be
 * plain: an emoji here is a variable number of columns and every row below it
 * stops lining up.
 */
function tableName(raw) {
    const text = String(raw ?? '');
    if (text.includes('<') || text.includes('\n')) return null;
    const stripped = stripMarkup(text).replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim();
    return stripped.length ? stripped : null;
}

/**
 * The right column keeps its emoji. Nothing is padded after the value, so a
 * wide glyph there costs nothing, and "10 ⛁" and "🟢 On" carry meaning that
 * stripping them threw away.
 *
 * A two-line value is folded onto one with a separator rather than rejected:
 * "-18,200 ⛁ / 612 rounds" reads better as a table row than the pair of lines
 * an embed was forced into.
 */
function tableValue(raw) {
    const text = String(raw ?? '');
    // Mentions, channel refs and <t:> timestamps all render raw in a code block.
    if (text.includes('<')) return null;
    const folded = stripMarkup(text)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join(' · ')
        .replace(/[ \t]+/g, ' ')
        .trim();
    return folded.length ? folded : null;
}

/** Kept for callers that only care whether a string can sit in a table at all. */
function tableCell(raw) {
    const text = String(raw ?? '');
    if (text.includes('\n')) return null;
    return tableName(text);
}

/** Pads names into a column so the values start at the same offset. */
function alignTable(entries) {
    if (!entries?.length) return '';
    const width = Math.min(TABLE_NAME_MAX, Math.max(...entries.map(e => e.name.length)));
    const lines = entries.map(({ name, value }) => {
        const label = name.length > width ? `${name.slice(0, width - 1)}…` : name.padEnd(width, ' ');
        return `${label}  ${value}`;
    });
    return ['```', ...lines, '```'].join('\n');
}

/** Can this run of inline fields become an aligned block? */
function asTable(run, { force = false } = {}) {
    if (!force && run.length < TABLE_MIN_ROWS) return null;
    if (!run.length) return null;
    const entries = [];
    for (const field of run) {
        const name = tableName(field.name);
        const value = tableValue(field.value);
        if (!name || !value) return null;
        if (name.length > TABLE_NAME_MAX) return null;
        // Emoji are one code point but read wider, so they are worth two.
        const width = value.length + (value.match(EMOJI_RE) || []).length;
        if (width > TABLE_VALUE_MAX) return null;
        entries.push({ name, value });
    }
    return alignTable(entries);
}

/** What a reader actually sees: the asterisks are markup, not width. */
function visibleLength(text) {
    return text.replace(/\*\*|__|~~|`/g, '').length;
}

/**
 * An embed bolds field names and leaves values plain, which is what tells them
 * apart at a glance. A value that opens with its own bold run ("**14** days")
 * lands right against the bold label and the two blur into one, so that
 * leading emphasis is dropped. Emphasis further inside a sentence is doing
 * real work and is left alone.
 */
function demoteLeadingBold(value) {
    return value.replace(/^\*\*([^*]+)\*\*/, '$1');
}

/** Two or three stats per line, keeping the bold-label look of an embed. */
function asPairs(run) {
    const parts = run.map((f) => {
        const name = String(f.name ?? '').trim();
        const value = String(f.value ?? '').replace(/\n+/g, ' ').trim();
        if (BLANK_NAME_RE.test(name)) return value;
        return `**${name}** ${demoteLeadingBold(value)}`;
    });
    const lines = [];
    let current = [];
    let length = 0;
    for (const part of parts) {
        const width = visibleLength(part);
        const wouldBe = length + width + 3;
        if (current.length && (current.length >= PAIR_MAX_PER_LINE || wouldBe > PAIR_LINE_CHARS)) {
            lines.push(current.join(' · '));
            current = [];
            length = 0;
        }
        current.push(part);
        length += width + 3;
    }
    if (current.length) lines.push(current.join(' · '));
    return lines.join('\n');
}

/**
 * A zero-width space is Discord's idiom for "this field has no label", so it
 * has to count as blank rather than as a name worth bolding. Written as escapes
 * on purpose: the literal characters are invisible in a diff.
 */
const BLANK_NAME_RE = /^[\s\u200B-\u200D\uFEFF]*$/;

/** A value that opens with an emoji is a decorated line, not a bare reading. */
const LEADS_WITH_EMOJI = /^\s*(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u;

/**
 * A full-width field. A short single-line value sits beside its label rather
 * than under it: an embed had no choice about the line break, a container does,
 * and "Dealer  K♠ 9♦" on one line reads far better than two.
 *
 * It stays under the label when the value is really a block: a mention list, or
 * anything that opens with its own emoji, both of which read as a run-on
 * sentence once they are pushed up against a bold label.
 */
function asProse(field) {
    const name = String(field.name ?? '').trim();
    const value = String(field.value ?? '').trim();
    // A blank label is deliberate; printing `****` for it is not.
    if (!name || BLANK_NAME_RE.test(name)) return value;
    if (!value) return `**${name}**`;

    const structured = value.includes('<@') || value.includes('<#') || LEADS_WITH_EMOJI.test(value);
    const oneLine = !value.includes('\n') && !structured && value.length <= PROSE_INLINE_MAX;
    return oneLine ? `**${name}** ${demoteLeadingBold(value)}` : `**${name}**\n${value}`;
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
        if (layout === 'prose') {
            for (const field of run) blocks.push({ kind: 'prose', text: asProse(field) });
            run = [];
            return;
        }
        if (layout !== 'pairs') {
            // One outlier should not sink the whole block. The join gate
            // overview is eight tidy settings and a long lifetime tally; the
            // eight still deserve to line up. Only a leading run is taken, so
            // the author's field order is never rearranged.
            const force = layout === 'table';
            let cut = run.length;
            while (cut > 0 && !asTable(run.slice(0, cut), { force })) cut -= 1;

            if (cut === run.length) {
                blocks.push({ kind: 'table', text: asTable(run, { force }) });
                run = [];
                return;
            }
            if (cut >= TABLE_MIN_ROWS) {
                blocks.push({ kind: 'table', text: asTable(run.slice(0, cut), { force }) });
                blocks.push({ kind: 'pairs', text: asPairs(run.slice(cut)) });
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

/**
 * The title, honouring a link the way the embed would have.
 *
 * A heading rather than bold text: an embed title renders visibly larger than
 * its body, and plain bold does not. `###` is the closest match Discord's
 * markdown offers, and it keeps links working.
 */
function titleLine(data) {
    if (!data.title) return null;
    const title = String(data.title).trim();
    return data.url ? `### [${title}](${data.url})` : `### ${title}`;
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

    const usableRows = (rows || []).filter(Boolean).slice(0, 5);

    // Discord counts EVERY component, nested ones included: the container
    // itself, each action row, and each button inside it. A join gate panel
    // with five full rows spends 31 of the 40 on controls alone, so the
    // controls are costed first and the text works with what is left.
    const rowCost = usableRows.reduce((total, row) => {
        const kids = typeof row.toJSON === 'function' ? (row.toJSON().components || []) : (row.components || []);
        return total + 1 + kids.length;
    }, 0);

    const heading = titleLine(data);
    const body = data.description ? String(data.description).trim() : null;
    const authorLine = data.author?.name ? `-# ${String(data.author.name).trim()}` : null;
    const useSection = Boolean(data.thumbnail?.url && (heading || body));
    const hasImage = Boolean(data.image?.url);
    const footer = footerLine(data);

    // A section costs itself, its lines and its accessory.
    const sectionCost = useSection ? 1 + [heading, body].filter(Boolean).length + 1 : 0;
    const fixedCost = 1 + rowCost + sectionCost + (hasImage ? 1 : 0);

    const blocks = planFields(data.fields, opts);
    const wantSeparators = (blocks.length ? 1 : 0) + (usableRows.length ? 1 : 0);

    /**
     * Every text display that is not part of the section, in order. Merging
     * two of these costs nothing visually, so overflow is folded into the last
     * one rather than dropped: a panel that will not send is worse than a
     * panel with one paragraph break fewer.
     */
    const pieces = [
        ...(authorLine ? [authorLine] : []),
        ...(useSection ? [] : [heading, body].filter(Boolean)),
        ...blocks.map(block => block.text),
        ...(footer ? [footer] : []),
    ];

    let separators = wantSeparators;
    let allowance = MAX_COMPONENTS - fixedCost - separators;
    if (allowance < 1) {
        // Drop the decoration before the content.
        separators = 0;
        allowance = Math.max(1, MAX_COMPONENTS - fixedCost);
    }

    const merged = pieces.slice(0, Math.max(0, allowance - 1));
    const overflow = pieces.slice(Math.max(0, allowance - 1));
    if (overflow.length) merged.push(overflow.join('\n'));

    let budget = MAX_TEXT_CHARS;
    let wrote = false;
    let queue = merged.filter(Boolean);

    /** Adds the next queued text display, clipped to the character budget. */
    const flushText = (count) => {
        for (let i = 0; i < count && queue.length; i += 1) {
            const content = queue.shift();
            const trimmed = content.length > budget
                ? `${content.slice(0, Math.max(0, budget - 1))}…`
                : content;
            if (!trimmed.trim()) continue;
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(trimmed));
            budget -= trimmed.length;
            wrote = true;
        }
    };

    const separator = () => {
        if (separators <= 0) return;
        container.addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
        );
        separators -= 1;
    };

    if (authorLine) flushText(1);

    if (useSection) {
        const section = new SectionBuilder()
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(data.thumbnail.url));
        for (const line of [heading, body].filter(Boolean)) {
            const trimmed = line.length > budget ? `${line.slice(0, Math.max(0, budget - 1))}…` : line;
            section.addTextDisplayComponents(new TextDisplayBuilder().setContent(trimmed));
            budget -= trimmed.length;
        }
        container.addSectionComponents(section);
        wrote = true;
    } else {
        flushText([heading, body].filter(Boolean).length);
    }

    if (blocks.length && wrote) separator();
    // Everything except the footer, which is held back until after the rows.
    flushText(Math.max(0, queue.length - (footer ? 1 : 0)));

    if (hasImage) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems({ media: { url: data.image.url } }),
        );
        wrote = true;
    }

    // Controls belong to the panel they drive, so they go inside the box.
    if (usableRows.length) {
        if (wrote) separator();
        container.addActionRowComponents(...usableRows);
        wrote = true;
    }

    // The footer sits below the controls, where an embed footer sat below
    // everything, so it stays queued until now.
    flushText(queue.length);

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
    // A lone builder rather than an array is an easy slip, and silently
    // dropping the controls would be a very quiet bug to chase.
    const rows = Array.isArray(components)
        ? components.filter(Boolean)
        : (components ? [components] : []);
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
    tableName,
    tableValue,
    planFields,
    alignTable,
    tableCell,
    footerLine,
    MAX_COMPONENTS,
    MAX_TEXT_CHARS,
};
