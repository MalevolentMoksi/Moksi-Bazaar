// src/commands/media/steal.js
/**
 * Clones custom emoji and stickers from a message into this server.
 *
 * It replaces a Vencord plugin that broke, and the way it broke is the reason
 * this is written the way it is. That plugin worked out each server's emoji
 * capacity by searching Discord's minified bundle for a function containing
 * ".additionalEmojiSlots". Discord moved the string, the search came back
 * undefined, and every `count < undefined` evaluated false, so it filtered out
 * every server its user had and rendered an empty picker. No error, no console
 * line: just a modal with nothing in it, which reads to the user as a missing
 * button rather than a bug.
 *
 * So this predicts nothing. It does not compute slot limits, read premium
 * tiers, or guess what will fit. It asks Discord to create the thing and turns
 * the answer into a sentence, which is why a full server here says "out of
 * emoji slots" instead of quietly offering nothing to click. A limit Discord
 * tells us cannot rot; one we derive can.
 *
 * The single exception is the bot's own permission, checked before any upload,
 * because "I do not have Manage Expressions" is worth knowing before ten
 * failures rather than after them.
 */

const {
    SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType,
    PermissionFlagsBits, StickerFormatType, EmbedBuilder, MessageFlags,
} = require('discord.js');
const { EMBED_COLORS } = require('../../utils/constants');
const { ui } = require('../../utils/ui/panel');
const logger = require('../../utils/logger');

/** Discord's ceilings. Enforced on their side; these only shape our messages. */
const MAX_EMOJI_BYTES = 256 * 1024;
const MAX_STICKER_BYTES = 512 * 1024;

/**
 * Sizes to ask the CDN for, largest first, until one fits.
 *
 * `null` means the original upload, which is what almost every emoji will
 * take: Discord already enforced the 256KB cap when it was first uploaded
 * somewhere else. The smaller rungs exist for stickers and for the odd asset
 * that grew across a format change.
 */
const SIZE_LADDER = [null, 512, 256, 128, 64];

/**
 * Emoji creation is rate limited per guild, so a message pasted full of them
 * is a good way to earn a 429 and a partial result nobody can interpret. Ten
 * at a time, and say so when there were more.
 */
const MAX_PER_RUN = 10;

const FETCH_TIMEOUT_MS = 10_000;

/** Custom emoji as they appear in raw message content. */
const EMOJI_TOKEN = /<(a?):(\w{2,32}):(\d{15,25})>/g;
const EMOJI_TOKEN_ONE = /^<(a?):(\w{2,32}):(\d{15,25})>$/;
const EMOJI_LINK = /(?:cdn|media)\.discordapp\.(?:com|net)\/emojis\/(\d{15,25})\.(png|gif|webp|jpe?g)/i;

const STICKER_EXT = Object.freeze({
    [StickerFormatType.PNG]: 'png',
    [StickerFormatType.APNG]: 'png',
    [StickerFormatType.GIF]: 'gif',
    // Lottie is JSON, and only partnered servers may upload it. Excluded below
    // with a reason rather than left to fail as a mystery.
});

/**
 * Discord's own error codes, spelled out because the bare numbers are
 * unreadable six months from now. Anything unlisted falls through to Discord's
 * own message, so an unrecognised code still says something true rather than
 * "unknown error".
 */
const FAILURES = Object.freeze({
    30008: 'this server is out of emoji slots',
    30018: 'this server is out of animated emoji slots',
    30039: 'this server is out of sticker slots',
    30056: 'this server is out of premium emoji slots',
    40005: 'the file is too large for Discord',
    50013: 'I am missing the Manage Expressions permission',
    50035: 'Discord rejected the name or the file',
});

function describeFailure(error) {
    return FAILURES[error?.code] ?? error?.message ?? 'unknown error';
}

/**
 * Emoji names are 2 to 32 characters of letters, digits and underscores, and
 * Discord rejects anything else outright.
 *
 * The `~` split is inherited knowledge: FakeNitro appends `~1` to names so it
 * can tell its own copies apart, and cloning one of those should not carry the
 * bookkeeping across.
 */
function sanitizeEmojiName(raw) {
    const base = String(raw ?? '').split('~')[0];
    const cleaned = base.replace(/\W/g, '').slice(0, 32);
    return cleaned.length >= 2 ? cleaned : `${cleaned}_emoji`.slice(0, 32);
}

/** Sticker names are 2 to 30 and tolerate rather more than emoji names do. */
function sanitizeStickerName(raw) {
    const cleaned = String(raw ?? '').trim().slice(0, 30);
    return cleaned.length >= 2 ? cleaned : 'stolen_sticker';
}

function cdnUrlFor(expr, size) {
    // An uploaded attachment already is a URL; there is nothing to construct.
    if (expr.url) return expr.url;

    if (expr.kind === 'sticker') {
        const ext = STICKER_EXT[expr.format];
        if (!ext) return null;
        return `https://cdn.discordapp.com/stickers/${expr.id}.${ext}`;
    }

    const base = `https://cdn.discordapp.com/emojis/${expr.id}.${expr.animated ? 'gif' : 'png'}`;
    return size ? `${base}?size=${size}` : base;
}

/**
 * Everything clonable on a message: emoji typed into the text, emoji used as
 * reactions, and stickers.
 *
 * Takes anything message-shaped rather than a real Message, so the collection
 * rules can be tested without a client.
 */
function collectExpressions(message) {
    const found = new Map();
    const add = expr => {
        if (expr?.id && !found.has(expr.id)) found.set(expr.id, expr);
    };

    for (const [, animated, name, id] of String(message?.content ?? '').matchAll(EMOJI_TOKEN)) {
        add({ kind: 'emoji', id, name: sanitizeEmojiName(name), animated: animated === 'a' });
    }

    for (const reaction of message?.reactions?.cache?.values?.() ?? []) {
        const emoji = reaction?.emoji;
        // Unicode reactions carry no id. There is nothing to clone: they are
        // already available in every server on Discord.
        if (!emoji?.id) continue;
        add({
            kind: 'emoji', id: emoji.id,
            name: sanitizeEmojiName(emoji.name),
            animated: Boolean(emoji.animated),
        });
    }

    for (const sticker of message?.stickers?.values?.() ?? []) {
        if (!sticker?.id) continue;
        add({
            kind: 'sticker', id: sticker.id,
            name: sanitizeStickerName(sticker.name),
            format: sticker.format,
            tags: sticker.tags,
            description: sticker.description,
        });
    }

    return [...found.values()];
}

/** What `/steal emoji:` will accept: the emoji itself, or a link to one. */
function parseEmojiInput(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;

    const token = raw.match(EMOJI_TOKEN_ONE);
    if (token) {
        return {
            kind: 'emoji', id: token[3],
            name: sanitizeEmojiName(token[2]),
            animated: token[1] === 'a',
        };
    }

    const link = raw.match(EMOJI_LINK);
    if (link) {
        // A link carries no name, so the caller has to supply one.
        return { kind: 'emoji', id: link[1], name: null, animated: link[2].toLowerCase() === 'gif' };
    }

    return null;
}

async function fetchBytes(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return { ok: false, error: `the CDN answered ${res.status}` };
        // Read inside the timeout, not after it. Clearing the timer once the
        // headers land turns the deadline into a time-to-first-byte check, and
        // a response that trickles its body would sail past it.
        return { ok: true, buf: Buffer.from(await res.arrayBuffer()) };
    } catch (error) {
        return {
            ok: false,
            error: error.name === 'AbortError'
                ? `the download timed out after ${FETCH_TIMEOUT_MS / 1000}s`
                : error.message,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function fetchWithinLimit(expr, maxBytes) {
    // An uploaded file has one URL and no CDN resizing behind it, so retrying
    // down the ladder would just be five identical failures.
    const ladder = expr.url ? [null] : SIZE_LADDER;
    let last = 'there was nothing to download';

    for (const size of ladder) {
        const url = cdnUrlFor(expr, size);
        if (!url) return { ok: false, error: 'I cannot download that format' };

        const got = await fetchBytes(url);
        if (!got.ok) {
            last = got.error;
            continue;
        }
        if (got.buf.length <= maxBytes) return { ok: true, buf: got.buf };
        last = `it is ${Math.round(got.buf.length / 1024)}KB, over Discord's ${Math.round(maxBytes / 1024)}KB limit`;
    }

    return { ok: false, error: last };
}

async function cloneOne(guild, expr, reason) {
    if (expr.kind === 'sticker' && expr.format === StickerFormatType.Lottie) {
        return { expr, ok: false, why: 'Lottie stickers cannot be re-uploaded by anyone' };
    }

    const got = await fetchWithinLimit(
        expr, expr.kind === 'sticker' ? MAX_STICKER_BYTES : MAX_EMOJI_BYTES);
    if (!got.ok) return { expr, ok: false, why: got.error };

    try {
        if (expr.kind === 'sticker') {
            const made = await guild.stickers.create({
                file: got.buf,
                name: expr.name,
                // Discord requires tags and refuses an empty string. The
                // source sticker's own tags are the honest answer; when it has
                // none, its name beats inventing something.
                tags: String(expr.tags || expr.name).slice(0, 200),
                description: expr.description ? String(expr.description).slice(0, 100) : null,
                reason,
            });
            return { expr, ok: true, made };
        }

        const made = await guild.emojis.create({ attachment: got.buf, name: expr.name, reason });
        return { expr, ok: true, made };
    } catch (error) {
        return { expr, ok: false, why: describeFailure(error) };
    }
}

function buildReport(results, skipped) {
    const ok = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);

    const embed = new EmbedBuilder()
        .setColor(!failed.length ? EMBED_COLORS.SUCCESS
            : !ok.length ? EMBED_COLORS.ERROR : EMBED_COLORS.CAUTIOUS)
        .setTitle(results.length === 1
            ? (ok.length ? 'Stolen' : 'Could not steal that')
            : `Stole ${ok.length} of ${results.length}`);

    if (ok.length) {
        embed.addFields({
            name: 'Added',
            value: ok.map(r => r.expr.kind === 'sticker'
                ? `**${r.made?.name ?? r.expr.name}** (sticker)`
                : `${r.made ?? ''} \`:${r.made?.name ?? r.expr.name}:\``,
            ).join('\n').slice(0, 1024),
            inline: false,
        });
    }

    if (failed.length) {
        embed.addFields({
            name: ok.length ? 'Left behind' : 'Why not',
            value: failed.map(r => `\`${r.expr.name}\`: ${r.why}`).join('\n').slice(0, 1024),
            inline: false,
        });
    }

    if (skipped > 0) {
        embed.setFooter({ text: `${skipped} more left alone; ${MAX_PER_RUN} at a time is all Discord will sit still for.` });
    }

    return embed;
}

/**
 * @param {import('discord.js').Interaction} interaction
 * @param {() => Promise<Array>} collect deferred, so the ack goes out first
 */
async function run(interaction, collect) {
    if (!interaction.inGuild()) {
        return interaction.reply({
            content: 'Emoji live in servers, so this only works inside one.',
            flags: MessageFlags.Ephemeral,
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const me = interaction.guild.members.me
        ?? await interaction.guild.members.fetchMe().catch(() => null);
    if (!me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
        return interaction.editReply(
            'I need the **Manage Expressions** permission here before I can add anything.');
    }

    const expressions = await collect();
    if (!expressions.length) {
        return interaction.editReply(
            'Nothing there I can take. Custom emoji and stickers work; the built-in unicode ones are already yours everywhere.');
    }

    const taking = expressions.slice(0, MAX_PER_RUN);
    const reason = `Cloned by ${interaction.user.tag}`;

    // One at a time. Expression creation is rate limited per guild, and firing
    // ten at once turns a full server into ten 429s instead of one clear
    // "out of slots".
    const results = [];
    for (const expr of taking) {
        results.push(await cloneOne(interaction.guild, expr, reason));
    }

    const failed = results.filter(r => !r.ok);
    if (failed.length) {
        logger.info('[STEAL] Some expressions did not clone', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            failed: failed.map(r => `${r.expr.name}: ${r.why}`),
        });
    }

    return interaction.editReply(
        ui(buildReport(results, expressions.length - taking.length), [], { scope: 'mod' }));
}

const slash = {
    data: new SlashCommandBuilder()
        .setName('steal')
        .setDescription('Add a custom emoji or sticker to this server')
        // Discord evaluates this itself, and its evaluation treats
        // Administrator as satisfying any requirement. A bitwise test in our
        // own code would not, which is exactly how the plugin this replaces
        // managed to hide itself from server admins.
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuildExpressions)
        .addStringOption(opt => opt
            .setName('emoji')
            .setDescription('Paste the emoji itself, or a link to one'))
        .addAttachmentOption(opt => opt
            .setName('image')
            .setDescription('Or upload an image to turn into an emoji'))
        .addStringOption(opt => opt
            .setName('name')
            .setDescription('What to call it here (2-32 letters, digits or underscores)')),

    async execute(interaction) {
        const text = interaction.options.getString('emoji');
        const file = interaction.options.getAttachment('image');
        const wanted = interaction.options.getString('name');

        return run(interaction, async () => {
            if (file) {
                return [{
                    kind: 'emoji',
                    id: file.id,
                    url: file.url,
                    name: sanitizeEmojiName(wanted ?? file.name?.replace(/\.\w+$/, '')),
                    animated: /\.gif$/i.test(file.name ?? ''),
                }];
            }

            const parsed = parseEmojiInput(text);
            if (!parsed) return [];
            if (!parsed.name && !wanted) {
                // A bare link has no name in it, and guessing one from the
                // snowflake would be worse than asking.
                throw Object.assign(new Error('needs a name'), { userFacing: true });
            }
            return [{ ...parsed, name: sanitizeEmojiName(wanted ?? parsed.name) }];
        }).catch(async error => {
            if (!error?.userFacing) throw error;
            return interaction.editReply(
                'That link does not carry a name, so tell me what to call it with the `name` option.');
        });
    },
};

const contextMenu = {
    data: new ContextMenuCommandBuilder()
        .setName('Steal expressions')
        .setType(ApplicationCommandType.Message)
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuildExpressions),

    async execute(interaction) {
        return run(interaction, async () => {
            // Resolved messages on an interaction are documented as *partial*,
            // and unlike partial members and channels the docs do not say
            // which fields survive. Reactions are exactly the sort of thing
            // that goes missing there, so the message is read again rather
            // than trusted, and the re-read costs one call.
            let target = null;
            if (interaction.channel) {
                target = await interaction.channel.messages
                    .fetch(interaction.targetId).catch(() => null);
            }
            return collectExpressions(target ?? interaction.targetMessage);
        });
    },
};

module.exports = [slash, contextMenu];
// Exported for the tests; the command loader ignores anything but data/execute.
module.exports.collectExpressions = collectExpressions;
module.exports.parseEmojiInput = parseEmojiInput;
module.exports.sanitizeEmojiName = sanitizeEmojiName;
module.exports.sanitizeStickerName = sanitizeStickerName;
module.exports.cdnUrlFor = cdnUrlFor;
module.exports.describeFailure = describeFailure;
module.exports.buildReport = buildReport;
module.exports.MAX_PER_RUN = MAX_PER_RUN;
