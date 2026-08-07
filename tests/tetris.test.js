// tests/tetris.test.js
//
// The old /tetris ran gravity on a setInterval that mutated the board every
// second and never redrew the message, so the player was steering a board they
// could not see. None of it was testable, because the rules lived inside a
// class that owned a timer and a Discord message at the same time.
//
// The rules are a pure function of state now, so these are the actual game:
// what collides, what rotates, when a piece welds itself down, what a line
// clear is worth, and the two rules that decide whether it feels fair at all
// (wall kicks and the seven-bag).
//
// Pieces are placed by coordinate rather than by searching for a fit: a test
// that hunts for a position in a while loop hangs the runner the first time
// the position does not exist.

const fs = require('fs');
const path = require('path');

const engine = require('../src/utils/tetris');
const {
    WIDTH, HEIGHT, createGame, applyAction, renderGrid, previewGrid, ghostY, fits, cellsOf,
} = engine;

/** A game with a known piece order and an empty board. */
function gameWithBag(order) {
    const queue = [...order];
    const game = createGame({ random: () => 0 });
    game.board = Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null));
    game.piece = { type: queue.shift(), rotation: 0, x: 3, y: 0 };
    game.next = queue.shift() ?? 'O';
    game.bag = queue.reverse();
    game.grounded = 0;
    game.holdUsed = false;
    game.score = 0;
    return game;
}

/** Fills a row, leaving the named columns empty. */
function fillRow(game, y, holes = []) {
    for (let x = 0; x < WIDTH; x++) {
        game.board[y][x] = holes.includes(x) ? null : 'O';
    }
}

const filledCells = game => game.board.flat().filter(Boolean).length;

describe('the board and the pieces', () => {
    test('a new game has an empty board, a piece and something on deck', () => {
        const game = createGame();
        expect(game.board).toHaveLength(HEIGHT);
        expect(game.board[0]).toHaveLength(WIDTH);
        expect(filledCells(game)).toBe(0);
        expect(game.piece).not.toBeNull();
        expect(game.next).toBeTruthy();
        expect(game.over).toBe(false);
    });

    test('every piece has four cells in all four orientations', () => {
        for (const type of engine.PIECE_TYPES) {
            for (let rotation = 0; rotation < 4; rotation++) {
                expect(cellsOf(type, rotation)).toHaveLength(4);
            }
        }
    });

    test('the O piece is the same shape whichever way you turn it', () => {
        const normalise = cells => cells.map(([x, y]) => `${x},${y}`).sort().join(' ');
        for (let rotation = 1; rotation < 4; rotation++) {
            expect(normalise(cellsOf('O', rotation))).toBe(normalise(cellsOf('O', 0)));
        }
    });

    test('nothing may leave the walls or the floor', () => {
        const game = gameWithBag(['O', 'O']);
        expect(fits(game, 'O', 0, -1, 0)).toBe(false);
        expect(fits(game, 'O', 0, WIDTH - 1, 0)).toBe(false);
        expect(fits(game, 'O', 0, 0, HEIGHT - 1)).toBe(false);
        expect(fits(game, 'O', 0, 0, HEIGHT - 2)).toBe(true);
    });

    test('a piece may sit above the ceiling, which is where it spawns from', () => {
        const game = gameWithBag(['I', 'O']);
        expect(fits(game, 'I', 1, 3, -2)).toBe(true);
    });
});

describe('turn-based gravity', () => {
    test('a successful move costs exactly one row', () => {
        const game = gameWithBag(['T', 'O']);
        applyAction(game, 'left');
        expect(game.piece.x).toBe(2);
        expect(game.piece.y).toBe(1);
    });

    test('a move into a wall costs nothing at all', () => {
        const game = gameWithBag(['O', 'O']);
        game.piece.x = 0;
        const before = { ...game.piece };

        const result = applyAction(game, 'left');

        expect(result.changed).toBe(false);
        // Pressing into a wall gains no information and no advantage, so
        // charging a row of gravity for it is punishment without purpose.
        expect(game.piece).toEqual(before);
    });

    test('down moves one row and scores, without a second gravity step', () => {
        const game = gameWithBag(['T', 'O']);
        applyAction(game, 'down');
        expect(game.piece.y).toBe(1);
        expect(game.score).toBe(1);
    });

    test('a hard drop lands the piece on the floor and pays per row', () => {
        const game = gameWithBag(['O', 'I']);

        const result = applyAction(game, 'drop');

        expect(result.locked).toBe(true);
        expect(game.board[HEIGHT - 1].filter(Boolean)).toHaveLength(2);
        expect(game.board[HEIGHT - 2].filter(Boolean)).toHaveLength(2);
        expect(game.score).toBeGreaterThan(0);
        expect(game.piece.type).toBe('I');
    });
});

describe('landing and locking', () => {
    test('a piece that has just landed can still be slid sideways', () => {
        const game = gameWithBag(['O', 'O']);
        game.piece = { type: 'O', rotation: 0, x: 4, y: HEIGHT - 2 };

        const result = applyAction(game, 'left');

        // Sliding a piece under an overhang is most of the game; locking on
        // contact would make it impossible.
        expect(result.locked).toBe(false);
        expect(game.piece.x).toBe(3);
        expect(filledCells(game)).toBe(0);
    });

    test('pressing down into the floor places the piece immediately', () => {
        const game = gameWithBag(['O', 'T']);
        for (let i = 0; i < HEIGHT; i++) applyAction(game, 'down');

        // Down is an explicit instruction to place, so it skips the grace.
        expect(game.board[HEIGHT - 1].filter(Boolean)).toHaveLength(2);
        expect(game.piece.type).toBe('T');
    });

    test('the grace period is bounded: a flat floor cannot be stalled on forever', () => {
        const game = gameWithBag(['O', 'T']);
        game.piece = { type: 'O', rotation: 0, x: 4, y: HEIGHT - 2 };

        for (let i = 0; i <= engine.LOCK_GRACE_MOVES; i++) {
            applyAction(game, i % 2 === 0 ? 'left' : 'right');
        }

        expect(game.board[HEIGHT - 1].filter(Boolean)).toHaveLength(2);
        expect(game.piece.type).toBe('T');
    });
});

describe('rotation', () => {
    test('an I piece flush against the wall is kicked clear instead of refused', () => {
        const game = gameWithBag(['I', 'O']);
        // Standing upright in the leftmost column: turning it flat would put
        // half the piece through the wall.
        game.piece = { type: 'I', rotation: 1, x: -2, y: 0 };

        const result = applyAction(game, 'rotate');

        // Without kicks this is the commonest "the game is broken" complaint:
        // a piece against a wall that simply refuses to turn.
        expect(result.changed).toBe(true);
        expect(game.piece.rotation).toBe(2);
        expect(game.piece.x).toBe(0);
    });

    test('a rotation with nowhere to go at all is refused, not forced', () => {
        const game = gameWithBag(['I', 'O']);
        // Everything solid except the one row the piece is lying in.
        for (let y = 0; y < HEIGHT; y++) if (y !== 1) fillRow(game, y);
        game.piece = { type: 'I', rotation: 0, x: 3, y: 0 };

        const result = applyAction(game, 'rotate');

        expect(result.changed).toBe(false);
        expect(game.piece.rotation).toBe(0);
        // And nothing was shoved through the stack to make room.
        expect(game.board[1].filter(Boolean)).toHaveLength(0);
    });

    test('four rotations in open space return the piece to its own column', () => {
        const game = gameWithBag(['T', 'O']);
        for (let i = 0; i < 4; i++) applyAction(game, 'rotate');

        expect(game.piece.rotation).toBe(0);
        expect(game.piece.x).toBe(3);
        // Four turns, four rows of gravity.
        expect(game.piece.y).toBe(4);
    });
});

describe('clearing lines', () => {
    test('a filled row disappears and everything above it falls', () => {
        const game = gameWithBag(['O', 'O']);
        fillRow(game, HEIGHT - 1, [4, 5]);
        game.board[HEIGHT - 2][0] = 'T';   // a marker that should drop one row
        game.piece = { type: 'O', rotation: 0, x: 4, y: 0 };

        applyAction(game, 'drop');

        expect(game.lines).toBe(1);
        expect(game.board[HEIGHT - 1][0]).toBe('T');
        expect(game.score).toBeGreaterThanOrEqual(engine.LINE_SCORES[1]);
    });

    test('four rows at once clear together, and are worth more than four singles', () => {
        const game = gameWithBag(['I', 'O']);
        for (let y = HEIGHT - 4; y < HEIGHT; y++) fillRow(game, y, [0]);
        game.piece = { type: 'I', rotation: 1, x: -2, y: 0 };  // upright, in the empty column

        applyAction(game, 'drop');

        expect(game.lines).toBe(4);
        expect(filledCells(game)).toBe(0);
        // Otherwise there is no reason to ever build a well.
        expect(engine.LINE_SCORES[4]).toBeGreaterThan(engine.LINE_SCORES[1] * 4);
    });

    test('two separated rows both clear', () => {
        const game = gameWithBag(['O', 'O']);
        fillRow(game, HEIGHT - 1, [4, 5]);
        fillRow(game, HEIGHT - 2, [4, 5]);
        game.piece = { type: 'O', rotation: 0, x: 4, y: 0 };

        applyAction(game, 'drop');

        expect(game.lines).toBe(2);
        expect(filledCells(game)).toBe(0);
    });

    test('the level rises with the line count', () => {
        const game = gameWithBag(['O', 'O']);
        game.lines = engine.LINES_PER_LEVEL - 1;
        fillRow(game, HEIGHT - 1, [4, 5]);
        game.piece = { type: 'O', rotation: 0, x: 4, y: 0 };

        applyAction(game, 'drop');

        expect(game.level).toBe(2);
    });
});

describe('hold', () => {
    test('the first hold parks the piece and brings the next one in', () => {
        const game = gameWithBag(['T', 'I', 'O']);

        applyAction(game, 'hold');

        expect(game.hold).toBe('T');
        expect(game.piece.type).toBe('I');
    });

    test('holding again swaps them back', () => {
        const game = gameWithBag(['T', 'I', 'O']);
        applyAction(game, 'hold');
        applyAction(game, 'drop');           // a new piece, so hold is allowed again
        const current = game.piece.type;

        applyAction(game, 'hold');

        expect(game.piece.type).toBe('T');
        expect(game.hold).toBe(current);
    });

    test('it is once per piece, or it is an infinite swap', () => {
        const game = gameWithBag(['T', 'I', 'O']);
        applyAction(game, 'hold');

        const result = applyAction(game, 'hold');

        expect(result.changed).toBe(false);
        expect(game.hold).toBe('T');
    });

    test('holding costs no gravity: it swaps a piece, it does not move one', () => {
        const game = gameWithBag(['T', 'I', 'O']);
        applyAction(game, 'hold');
        expect(game.piece.y).toBe(0);
    });
});

describe('the seven-bag', () => {
    test('the first seven pieces are all seven, exactly once each', () => {
        const game = createGame();
        const seen = [game.piece.type];

        for (let i = 0; i < 13; i++) {
            // Wipe the board between drops so the sample cannot be cut short
            // by a top-out; this is testing the draw order, not survival.
            game.board = Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null));
            applyAction(game, 'drop');
            seen.push(game.piece.type);
        }

        // Pure random draws produce real droughts (no I piece for twenty
        // pieces) that read to a player as the game cheating.
        expect(new Set(seen.slice(0, 7)).size).toBe(7);
        expect(new Set(seen.slice(7, 14)).size).toBe(7);
    });
});

describe('topping out', () => {
    test('a stack to the ceiling ends the game rather than throwing', () => {
        const game = gameWithBag(['O', 'O']);
        // A hole in every row, or the stack would simply clear itself away.
        for (let y = 2; y < HEIGHT; y++) fillRow(game, y, [9]);

        expect(() => applyAction(game, 'drop')).not.toThrow();
        expect(game.over).toBe(true);
    });

    test('a piece locking partly above the ceiling does not write off the board', () => {
        const game = gameWithBag(['I', 'O']);
        for (let y = 1; y < HEIGHT; y++) fillRow(game, y, [9]);
        // Upright in column 0, with three of its four cells above the ceiling.
        game.piece = { type: 'I', rotation: 1, x: -2, y: -3 };

        expect(() => applyAction(game, 'drop')).not.toThrow();
        expect(game.board).toHaveLength(HEIGHT);
        expect(game.board[0][0]).toBe('I');
    });

    test('a finished game ignores further input', () => {
        const game = gameWithBag(['O', 'O']);
        game.over = true;
        expect(applyAction(game, 'left')).toEqual({ changed: false, locked: false, cleared: 0 });
    });
});

describe('what gets drawn', () => {
    test('the grid shows the live piece and its landing outline', () => {
        const game = gameWithBag(['O', 'O']);
        const grid = renderGrid(game);

        expect(grid.flat().filter(c => c === 'O')).toHaveLength(4);
        expect(grid.flat().filter(c => c === 'GHOST')).toHaveLength(4);
        expect(grid[ghostY(game)].includes('GHOST')).toBe(true);
    });

    test('the outline disappears once the piece is already resting there', () => {
        const game = gameWithBag(['O', 'O']);
        game.piece = { type: 'O', rotation: 0, x: 4, y: HEIGHT - 2 };
        expect(renderGrid(game).flat().filter(c => c === 'GHOST')).toHaveLength(0);
    });

    test('the grid is always the size of the board', () => {
        const game = createGame();
        const grid = renderGrid(game);
        expect(grid).toHaveLength(HEIGHT);
        for (const row of grid) expect(row).toHaveLength(WIDTH);
    });

    test('a preview is the piece with no empty padding around it', () => {
        expect(previewGrid('O')).toEqual([['O', 'O'], ['O', 'O']]);
        expect(previewGrid('I')).toEqual([['I', 'I', 'I', 'I']]);
        expect(previewGrid(null)).toEqual([]);
    });
});

// The interface needs a gateway to exercise, so these pin the three structural
// faults the rebuild was for.
describe('the interface faults that made it unplayable', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src/commands/tools/tetris.js'), 'utf8');

    test('no timer moves a piece the player cannot see', () => {
        // The call, not the word: the header comment explains the old bug.
        expect(source).not.toMatch(/setInterval\(/);
        expect(source).not.toMatch(/fallSpeed/);
    });

    test('the collector listens to its own message, not the whole channel', () => {
        expect(source).toContain('message.createMessageComponentCollector');
        expect(source).not.toContain('channel.createMessageComponentCollector');
    });

    test('finished games leave the registry, on every path', () => {
        // Quit, top-out, superseded and expiry all delete the entry. A game
        // left in the map is a leak for the life of the process.
        expect((source.match(/activeGames\.delete\(key\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
        expect(source).toContain('activeGames.clear()');
    });

    test('a shutdown pays for lines that were genuinely cleared', () => {
        expect(source).toContain('settleActiveGames');
        expect(fs.readFileSync(path.join(__dirname, '..', 'src/bot.js'), 'utf8'))
            .toContain('settleActiveGames');
    });

    test('a payout can only happen once per game', () => {
        expect(source).toMatch(/if \(entry\.paid \|\| entry\.game\.lines <= 0\) return null;\s*\n\s*entry\.paid = true;/);
    });

    test('every piece is drawn in its own colour', () => {
        // The old board drew every piece as the same grey brick, so a stack of
        // four different pieces was indistinguishable.
        const colours = [...source.matchAll(/\b([IOTSZJL]): '([^']+)'/g)].map(m => m[2]);
        expect(colours).toHaveLength(7);
        expect(new Set(colours).size).toBe(7);
    });
});
