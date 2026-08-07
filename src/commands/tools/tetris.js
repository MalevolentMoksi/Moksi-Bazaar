// src/commands/tools/tetris.js
/**
 * Tetris, played through Discord buttons.
 *
 * The rules live in utils/tetris.js and know nothing about Discord. This file
 * is the interface: what a piece looks like, which button does what, and who
 * is allowed to press it.
 *
 * Three things the first version got wrong, all of them structural:
 *
 *  - gravity ran on a setInterval that never redrew the message, so the board
 *    the player was looking at had nothing to do with the board they were
 *    playing. Gravity is turn-based now; see utils/tetris.js.
 *  - the collector listened to the whole CHANNEL rather than to its own
 *    message, so a second game in the same channel drove the first one's
 *    board. It listens to its own message now.
 *  - finished games were never removed from the registry, so every game ever
 *    played stayed in memory for the life of the process.
 */

const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const {
    adjustBalance, recordGameResult, setUserCooldown, getUserCooldownRemaining,
} = require('../../utils/db');
const engine = require('../../utils/tetris');
const logger = require('../../utils/logger');
const { ui, retireControls } = require('../../utils/ui/panel');

/**
 * Tetris is the one game here that costs nothing to play, so it had nothing to
 * do with the economy at all. Cleared lines pay, with two brakes on it: a
 * per-game ceiling, and an hour between paid games. Play as much as you like
 * past that; it just stops printing money.
 */
const TETRIS_PER_LINE = 100;
const TETRIS_MAX_PAID_LINES = 50;
const TETRIS_PAYOUT_COOLDOWN_MS = 60 * 60 * 1000;
const TETRIS_COOLDOWN_KEY = 'tetris_payout';

/** A board nobody has touched in this long is not being played any more. */
const IDLE_TIMEOUT_MS = 3 * 60_000;

/**
 * One coloured square per piece, plus the empty cell and the landing ghost.
 * Emoji rather than a code block: the old board drew every piece as the same
 * grey brick, so a stack of four different pieces was indistinguishable, and
 * ANSI colour blocks render as raw escape codes on clients that lack them.
 */
const SQUARES = Object.freeze({
    I: '🟦', O: '🟨', T: '🟪', S: '🟩', Z: '🟥', J: '🟫', L: '🟧',
    GHOST: '⬜', EMPTY: '⬛',
});

/** userId-channelId -> game in progress. */
const activeGames = new Map();

// ── Payout ──────────────────────────────────────────────────────────────────

/**
 * Settles a finished game exactly once.
 *
 * The `paid` flag is set before the first await: a game can end down several
 * paths at once (top-out, quit, restart, idle expiry, shutdown) and two of
 * them racing must not pay twice.
 *
 * @returns {Promise<string|null>} a line to show the player, or null
 */
async function awardTetris(entry) {
    if (entry.paid || entry.game.lines <= 0) return null;
    entry.paid = true;

    try {
        const remaining = await getUserCooldownRemaining(entry.userId, TETRIS_COOLDOWN_KEY);
        if (remaining > 0) {
            const mins = Math.ceil(remaining / 60000);
            return `No payout: another paid game in ${mins} min. Lines still counted.`;
        }

        const paidLines = Math.min(entry.game.lines, TETRIS_MAX_PAID_LINES);
        const amount = paidLines * TETRIS_PER_LINE;
        const balance = await adjustBalance(entry.userId, amount);
        await setUserCooldown(entry.userId, TETRIS_COOLDOWN_KEY, TETRIS_PAYOUT_COOLDOWN_MS);
        recordGameResult(entry.userId, 'tetris', { wagered: 0, returned: amount }).catch(() => {});

        logger.info('Tetris payout', { userId: entry.userId, lines: entry.game.lines, amount });

        const capped = entry.game.lines > TETRIS_MAX_PAID_LINES
            ? ` (${TETRIS_MAX_PAID_LINES} line cap)` : '';
        return `Earned **$${amount.toLocaleString()}** for ${paidLines} lines${capped}. `
            + `Balance $${Number(balance ?? 0).toLocaleString()}.`;
    } catch (error) {
        logger.error('Tetris payout failed', { userId: entry.userId, error: error.message });
        return null;
    }
}

/**
 * Pays out every game still in progress. Called on shutdown: a deploy kills
 * every board in memory, and lines that were genuinely cleared should not
 * evaporate because the container restarted.
 */
async function settleActiveGames() {
    const entries = [...activeGames.values()];
    activeGames.clear();
    let paid = 0;
    for (const entry of entries) {
        entry.collector?.stop('shutdown');
        const receipt = await awardTetris(entry).catch(() => null);
        if (receipt) paid++;
    }
    if (paid > 0) logger.info('Tetris: settled games interrupted by shutdown', { games: paid });
    return paid;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function drawBoard(game) {
    return engine.renderGrid(game)
        .map(row => row.map(cell => SQUARES[cell] ?? SQUARES.EMPTY).join(''))
        .join('\n');
}

function drawPreview(type) {
    if (!type) return '*empty*';
    return engine.previewGrid(type)
        .map(row => row.map(cell => SQUARES[cell] ?? SQUARES.EMPTY).join(''))
        .join('\n');
}

function gameEmbed(entry, { note = null } = {}) {
    const { game } = entry;
    const embed = new EmbedBuilder()
        .setTitle(game.over ? '🎮 Tetris: topped out' : '🎮 Tetris')
        .setDescription(drawBoard(game))
        .setColor(game.over ? 0xE74C3C : 0x5865F2)
        .addFields(
            { name: 'Score', value: game.score.toLocaleString(), inline: true },
            { name: 'Lines', value: String(game.lines), inline: true },
            { name: 'Level', value: String(game.level), inline: true },
            { name: 'Next', value: drawPreview(game.next), inline: true },
            { name: 'Hold', value: drawPreview(game.hold), inline: true },
        );

    if (note) embed.addFields({ name: '​', value: note, inline: false });
    if (entry.payoutText) embed.addFields({ name: '💰 Payout', value: entry.payoutText, inline: false });

    embed.setFooter({
        text: game.over
            ? 'Topped out. New game deals a fresh board.'
            : 'Every move drops the piece one row. ⬇️ places it, ⚡ slams it.',
    });
    return embed;
}

function controls(game) {
    const dead = game.over;
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tetris:left').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(dead),
            new ButtonBuilder().setCustomId('tetris:rotate').setEmoji('🔄').setStyle(ButtonStyle.Primary).setDisabled(dead),
            new ButtonBuilder().setCustomId('tetris:right').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(dead),
            new ButtonBuilder().setCustomId('tetris:down').setEmoji('⬇️').setStyle(ButtonStyle.Secondary).setDisabled(dead),
            new ButtonBuilder().setCustomId('tetris:drop').setEmoji('⚡').setStyle(ButtonStyle.Danger).setDisabled(dead),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tetris:hold').setLabel('Hold').setStyle(ButtonStyle.Secondary)
                .setDisabled(dead || game.holdUsed),
            new ButtonBuilder().setCustomId('tetris:new').setLabel('New game').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('tetris:quit').setLabel('Quit').setStyle(ButtonStyle.Danger),
        ),
    ];
}

const HELP = new EmbedBuilder()
    .setTitle('🎮 Tetris')
    .setColor(0x5865F2)
    .setDescription(
        'Turn-based, because a piece falling on a timer cannot be steered through a chat client: '
        + 'by the time you see it and press a button, it has moved. **Every move you make drops the '
        + 'piece one row instead.** A move that fails (into a wall, say) costs nothing.'
    )
    .addFields(
        { name: '⬅️ ➡️', value: 'Move, and fall one row', inline: true },
        { name: '🔄', value: 'Rotate, with wall kicks', inline: true },
        { name: '⬇️', value: 'Down one row, or place it', inline: true },
        { name: '⚡', value: 'Slam to the bottom', inline: true },
        { name: 'Hold', value: 'Park a piece for later, once per piece', inline: true },
        { name: 'Landing', value: `The white outline is where it lands. Once it touches down you get ${engine.LOCK_GRACE_MOVES} more moves before it welds.`, inline: false },
        { name: 'Scoring', value: `Lines pay ${engine.LINE_SCORES.slice(1).join(' / ')} × level. Four at once is worth more than four separately. Level rises every ${engine.LINES_PER_LEVEL} lines.`, inline: false },
        { name: 'Money', value: `$${TETRIS_PER_LINE} per line cleared, up to ${TETRIS_MAX_PAID_LINES} lines, once an hour.`, inline: false },
    );

// ── Command ─────────────────────────────────────────────────────────────────

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tetris')
        .setDescription('Play Tetris in the channel')
        .addStringOption(option =>
            option.setName('action')
                .setDescription('What to do')
                .addChoices(
                    { name: 'New game', value: 'new' },
                    { name: 'How it works', value: 'help' },
                )),

    async execute(interaction) {
        const userId = interaction.user.id;
        const channelId = interaction.channel.id;
        const key = `${userId}-${channelId}`;

        if (interaction.options.getString('action') === 'help') {
            return interaction.reply(ui(HELP, [], { scope: 'casino', ephemeral: true }));
        }

        await interaction.deferReply();

        // Starting a second board settles the first and retires its buttons,
        // rather than leaving a live-looking game nobody is playing.
        const previous = activeGames.get(key);
        let carried = null;
        if (previous) {
            carried = await awardTetris(previous);
            previous.collector?.stop('superseded');
            activeGames.delete(key);
            if (previous.message) {
                await previous.message.edit(retireControls(previous.message)).catch(() => {});
            }
        }

        const entry = {
            userId,
            channelId,
            game: engine.createGame(),
            paid: false,
            payoutText: carried ? `Previous game: ${carried}` : null,
            message: null,
            collector: null,
        };
        activeGames.set(key, entry);

        const message = await interaction.editReply(
            ui(gameEmbed(entry), controls(entry.game), { scope: 'casino' }),
        );
        entry.message = message;

        // On the message, not the channel: a channel-wide collector meant a
        // second game's buttons drove the first game's board.
        const collector = message.createMessageComponentCollector({ idle: IDLE_TIMEOUT_MS });
        entry.collector = collector;

        collector.on('collect', async (press) => {
            if (press.user.id !== userId) {
                return press.reply({
                    content: 'Not your game. `/tetris` starts your own.',
                    flags: MessageFlags.Ephemeral,
                }).catch(() => {});
            }

            // A board superseded by a newer one keeps its own buttons live
            // until the edit lands; say so rather than driving a dead game.
            if (activeGames.get(key) !== entry) {
                return press.reply({
                    content: 'This board was replaced by a newer game.',
                    flags: MessageFlags.Ephemeral,
                }).catch(() => {});
            }

            const action = press.customId.split(':')[1];

            // Settling a game is two or three database round trips, and
            // Discord kills the token after three seconds. Anything that pays
            // out claims the interaction first and edits afterwards; ordinary
            // moves touch nothing but memory and answer in a single call.
            if (action === 'quit' || action === 'new') {
                await press.deferUpdate().catch(() => {});
                const receipt = await awardTetris(entry);

                if (action === 'quit') {
                    entry.payoutText = receipt;
                    activeGames.delete(key);
                    collector.stop('quit');
                    const farewell = gameEmbed(entry, { note: 'Game ended.' })
                        .setTitle('🎮 Tetris: ended')
                        .setColor(0x99AAB5);
                    return press.editReply(ui(farewell, [], { like: press.message })).catch(() => {});
                }

                entry.game = engine.createGame();
                entry.paid = false;
                entry.payoutText = receipt ? `Previous game: ${receipt}` : null;
                return press.editReply(
                    ui(gameEmbed(entry), controls(entry.game), { like: press.message }),
                ).catch(() => {});
            }

            const before = entry.game.lines;
            const result = engine.applyAction(entry.game, action);

            if (!result.changed) {
                // Nothing moved, so nothing to redraw. Acknowledging silently
                // is what stops Discord showing "interaction failed".
                return press.deferUpdate().catch(() => {});
            }

            const cleared = entry.game.lines - before;
            const note = cleared === 4
                ? '**TETRIS.**'
                : (cleared > 0 ? `${cleared} line${cleared > 1 ? 's' : ''} cleared.` : null);

            if (!entry.game.over) {
                return press.update(
                    ui(gameEmbed(entry, { note }), controls(entry.game), { like: press.message }),
                ).catch(error => logger.debug('Tetris update failed', { error: error.message }));
            }

            // Topped out. The board stays registered and the collector stays
            // alive so New game and Quit still work; every movement button is
            // disabled, and applyAction ignores them regardless.
            await press.deferUpdate().catch(() => {});
            entry.payoutText = await awardTetris(entry);
            await press.editReply(
                ui(gameEmbed(entry, { note }), controls(entry.game), { like: press.message }),
            ).catch(error => logger.debug('Tetris update failed', { error: error.message }));
        });

        collector.on('end', async (_collected, reason) => {
            if (activeGames.get(key) === entry) activeGames.delete(key);
            // Whatever ended it, the lines were still cleared. Shutdown is the
            // exception: settleActiveGames is already paying, and paying twice
            // is what the `paid` flag exists to prevent anyway.
            if (reason !== 'shutdown' && reason !== 'superseded') {
                await awardTetris(entry).catch(error =>
                    logger.error('Tetris payout on expiry failed', { error: error.message }));
            }
            if (reason === 'quit' || reason === 'superseded') return;
            if (entry.message) {
                await entry.message.edit(retireControls(entry.message)).catch(() => {});
            }
        });
    },

    // Exported for the shutdown hook and the tests; not part of the command.
    settleActiveGames,
    activeGames,
};
