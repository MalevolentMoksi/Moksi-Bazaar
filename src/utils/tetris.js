// src/utils/tetris.js
/**
 * The game, with no Discord in it.
 *
 * The previous implementation ran gravity on a setInterval that mutated the
 * board every second and never edited the message. Pieces fell, landed, locked
 * and cleared lines while the player looked at a still picture, and the board
 * only teleported when a button was pressed. That is not a tuning problem: a
 * chat client has a half-second round trip on every input, so a piece falling
 * on a wall-clock timer cannot be steered by anyone, and editing a message
 * once a second would be rate limited into the ground anyway.
 *
 * So gravity is turn-based here. Every successful action costs one row of
 * descent, which keeps the pressure real (a badly spent move is a row you do
 * not get back) while making every input land exactly where the player aimed
 * it, however slow their connection. Level multiplies score rather than speed,
 * because there is no speed to raise.
 *
 * Everything below is a pure function of state plus an injectable random, so
 * the rules can be tested without a gateway, a database or a timer.
 */

const WIDTH = 10;
const HEIGHT = 20;

/**
 * Actions a grounded piece may take before it locks. Without a grace period a
 * piece welds itself the instant it touches the stack, and sliding a piece
 * into a gap under an overhang, which is most of the game, becomes impossible.
 * Bounded so a player cannot stall forever on a flat floor.
 */
const LOCK_GRACE_MOVES = 3;

/** Standard guideline scoring; index is lines cleared at once. */
const LINE_SCORES = [0, 100, 300, 500, 800];
const SOFT_DROP_POINTS = 1;
const HARD_DROP_POINTS = 2;
const LINES_PER_LEVEL = 10;

/**
 * Spawn orientations, in the padded boxes the Super Rotation System uses. The
 * padding is not decoration: rotating inside a centred box is what stops a
 * piece lurching sideways every time it turns.
 */
const SHAPES = {
    I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    O: [[1, 1], [1, 1]],
    T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
    S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
    Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
    J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
    L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
};

const PIECE_TYPES = Object.freeze(Object.keys(SHAPES));

/**
 * Offsets tried when a rotation lands in a wall, floor or neighbour, in order.
 * A rotation that only works from open ground is the single most common way a
 * Tetris implementation feels broken: every I-piece flush against a wall
 * simply refuses to turn.
 */
const KICKS = Object.freeze([[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1]]);

function rotateClockwise(matrix) {
    const rows = matrix.length;
    const cols = matrix[0].length;
    return Array.from({ length: cols }, (_, x) =>
        Array.from({ length: rows }, (_, y) => matrix[rows - 1 - y][x]));
}

/** All four orientations of every piece, derived rather than transcribed. */
const ROTATIONS = Object.freeze(Object.fromEntries(
    Object.entries(SHAPES).map(([type, spawn]) => {
        const states = [spawn];
        for (let i = 1; i < 4; i++) states.push(rotateClockwise(states[i - 1]));
        return [type, Object.freeze(states)];
    })
));

/** The cells a piece occupies, as [x, y] pairs relative to its box corner. */
function cellsOf(type, rotation) {
    const matrix = ROTATIONS[type][rotation % 4];
    const cells = [];
    for (let y = 0; y < matrix.length; y++) {
        for (let x = 0; x < matrix[y].length; x++) {
            if (matrix[y][x]) cells.push([x, y]);
        }
    }
    return cells;
}

// ── Bag ─────────────────────────────────────────────────────────────────────

/**
 * The seven-bag randomiser: every piece appears once per seven before any
 * repeats. Pure random draws produce genuine droughts (no I-piece for twenty
 * pieces) that read to a player as the game cheating, which is why no modern
 * Tetris uses them.
 */
function drawPiece(game) {
    if (game.bag.length === 0) {
        const bag = [...PIECE_TYPES];
        // Fisher-Yates against the injected random, so tests can pin an order.
        for (let i = bag.length - 1; i > 0; i--) {
            const j = Math.floor(game.random() * (i + 1));
            [bag[i], bag[j]] = [bag[j], bag[i]];
        }
        game.bag = bag;
    }
    return game.bag.pop();
}

// ── Collision ───────────────────────────────────────────────────────────────

/**
 * @returns {boolean} whether `type` fits at (x, y) in `rotation`
 */
function fits(game, type, rotation, x, y) {
    for (const [cx, cy] of cellsOf(type, rotation)) {
        const nx = x + cx;
        const ny = y + cy;
        if (nx < 0 || nx >= WIDTH || ny >= HEIGHT) return false;
        // Above the ceiling is legal: that is where a piece spawns from.
        if (ny >= 0 && game.board[ny][nx]) return false;
    }
    return true;
}

function pieceFits(game, { rotation = null, dx = 0, dy = 0 } = {}) {
    const p = game.piece;
    return fits(game, p.type, rotation ?? p.rotation, p.x + dx, p.y + dy);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

function spawn(game) {
    const type = game.next;
    game.next = drawPiece(game);
    const width = ROTATIONS[type][0][0].length;
    game.piece = {
        type,
        rotation: 0,
        x: Math.floor((WIDTH - width) / 2),
        y: 0,
    };
    game.grounded = 0;
    game.holdUsed = false;

    // Nowhere to put it: the stack has reached the ceiling.
    if (!pieceFits(game)) {
        game.over = true;
        return false;
    }
    return true;
}

/**
 * @param {Object} [options]
 * @param {() => number} [options.random] injectable for deterministic tests
 */
function createGame({ random = Math.random } = {}) {
    const game = {
        board: Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null)),
        score: 0,
        lines: 0,
        level: 1,
        over: false,
        /** Piece types drawn but not yet used, newest last. */
        bag: [],
        random,
        piece: null,
        next: null,
        hold: null,
        /** Hold is once per piece, or it becomes an infinite swap. */
        holdUsed: false,
        /** Actions taken while resting on the stack; see LOCK_GRACE_MOVES. */
        grounded: 0,
        /** Lines cleared by the most recent lock, for the interface to report. */
        lastClear: 0,
    };
    game.next = drawPiece(game);
    spawn(game);
    return game;
}

function clearLines(game) {
    let cleared = 0;
    for (let y = HEIGHT - 1; y >= 0; y--) {
        if (game.board[y].every(cell => cell !== null)) {
            game.board.splice(y, 1);
            game.board.unshift(Array(WIDTH).fill(null));
            cleared++;
            y++; // the row that fell into this index has not been checked yet
        }
    }

    if (cleared > 0) {
        game.lines += cleared;
        game.score += LINE_SCORES[cleared] * game.level;
        game.level = Math.floor(game.lines / LINES_PER_LEVEL) + 1;
    }
    game.lastClear = cleared;
    return cleared;
}

function lockPiece(game) {
    for (const [cx, cy] of cellsOf(game.piece.type, game.piece.rotation)) {
        const ny = game.piece.y + cy;
        const nx = game.piece.x + cx;
        // A cell resting above the ceiling simply is not stored; the game is
        // over in that case anyway, and writing to board[-1] would throw.
        if (ny >= 0) game.board[ny][nx] = game.piece.type;
    }
    clearLines(game);
    spawn(game);
}

/**
 * One row of gravity, charged after every successful action.
 * @returns {boolean} whether the piece locked
 */
function applyGravity(game) {
    if (pieceFits(game, { dy: 1 })) {
        game.piece.y++;
        game.grounded = 0;
        return false;
    }
    game.grounded++;
    if (game.grounded > LOCK_GRACE_MOVES) {
        lockPiece(game);
        return true;
    }
    return false;
}

// ── Actions ─────────────────────────────────────────────────────────────────

/** Where the piece would come to rest, for the ghost outline. */
function ghostY(game) {
    let y = game.piece.y;
    while (fits(game, game.piece.type, game.piece.rotation, game.piece.x, y + 1)) y++;
    return y;
}

function tryRotate(game) {
    const next = (game.piece.rotation + 1) % 4;
    for (const [dx, dy] of KICKS) {
        if (fits(game, game.piece.type, next, game.piece.x + dx, game.piece.y + dy)) {
            game.piece.rotation = next;
            game.piece.x += dx;
            game.piece.y += dy;
            return true;
        }
    }
    return false;
}

function tryHold(game) {
    if (game.holdUsed) return false;
    const held = game.hold;
    game.hold = game.piece.type;
    if (held) {
        // Put the held piece where a fresh one would appear.
        const width = ROTATIONS[held][0][0].length;
        game.piece = { type: held, rotation: 0, x: Math.floor((WIDTH - width) / 2), y: 0 };
        game.grounded = 0;
        if (!pieceFits(game)) game.over = true;
    } else {
        spawn(game);
    }
    // Set after spawn(), which clears it: one hold per piece, and the piece
    // that comes back from the hold slot counts as a new one.
    game.holdUsed = true;
    return true;
}

/**
 * The only entry point the interface needs.
 *
 * A failed action costs nothing. Pressing into a wall gains the player no
 * information and no advantage, so charging a row of gravity for it would be
 * punishment without purpose.
 *
 * @param {Object} game
 * @param {'left'|'right'|'rotate'|'down'|'drop'|'hold'} action
 * @returns {{changed: boolean, locked: boolean, cleared: number}}
 */
function applyAction(game, action) {
    if (game.over) return { changed: false, locked: false, cleared: 0 };
    game.lastClear = 0;

    switch (action) {
        case 'left':
        case 'right': {
            const dx = action === 'left' ? -1 : 1;
            if (!pieceFits(game, { dx })) return { changed: false, locked: false, cleared: 0 };
            game.piece.x += dx;
            break;
        }
        case 'rotate':
            if (!tryRotate(game)) return { changed: false, locked: false, cleared: 0 };
            break;
        case 'hold': {
            // Free: it swaps the piece rather than moving it, and charging
            // gravity would make holding a late-game piece cost a row.
            const held = tryHold(game);
            return { changed: held, locked: false, cleared: 0 };
        }
        case 'down': {
            // Down IS the gravity step, and pressing it into the floor is an
            // explicit instruction to place the piece, so it skips the grace.
            if (pieceFits(game, { dy: 1 })) {
                game.piece.y++;
                game.score += SOFT_DROP_POINTS;
                game.grounded = 0;
                return { changed: true, locked: false, cleared: 0 };
            }
            lockPiece(game);
            return { changed: true, locked: true, cleared: game.lastClear };
        }
        case 'drop': {
            let distance = 0;
            while (pieceFits(game, { dy: 1 })) { game.piece.y++; distance++; }
            game.score += distance * HARD_DROP_POINTS;
            lockPiece(game);
            return { changed: true, locked: true, cleared: game.lastClear };
        }
        default:
            return { changed: false, locked: false, cleared: 0 };
    }

    const locked = applyGravity(game);
    return { changed: true, locked, cleared: game.lastClear };
}

/**
 * The board as it should be drawn: a grid of piece letters, plus 'GHOST' for
 * the landing outline and null for empty. The interface decides what a letter
 * looks like; this decides what is where.
 */
function renderGrid(game) {
    const grid = game.board.map(row => [...row]);
    if (game.over || !game.piece) return grid;

    const landing = ghostY(game);
    if (landing > game.piece.y) {
        for (const [cx, cy] of cellsOf(game.piece.type, game.piece.rotation)) {
            const ny = landing + cy;
            const nx = game.piece.x + cx;
            if (ny >= 0 && ny < HEIGHT && grid[ny][nx] === null) grid[ny][nx] = 'GHOST';
        }
    }
    for (const [cx, cy] of cellsOf(game.piece.type, game.piece.rotation)) {
        const ny = game.piece.y + cy;
        const nx = game.piece.x + cx;
        if (ny >= 0 && ny < HEIGHT) grid[ny][nx] = game.piece.type;
    }
    return grid;
}

/** The smallest box containing a piece, for the next/hold previews. */
function previewGrid(type) {
    if (!type) return [];
    const matrix = ROTATIONS[type][0];
    const rows = matrix.filter(row => row.some(Boolean));
    if (rows.length === 0) return [];
    const firstCol = Math.min(...rows.map(r => r.indexOf(1)));
    const lastCol = Math.max(...rows.map(r => r.lastIndexOf(1)));
    return rows.map(row => row.slice(firstCol, lastCol + 1).map(cell => (cell ? type : null)));
}

module.exports = {
    WIDTH,
    HEIGHT,
    PIECE_TYPES,
    LOCK_GRACE_MOVES,
    LINE_SCORES,
    LINES_PER_LEVEL,
    ROTATIONS,
    createGame,
    applyAction,
    renderGrid,
    previewGrid,
    ghostY,
    cellsOf,
    fits,
};
