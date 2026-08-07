// tests/openStakes.test.js
//
// Every wager leaves the balance the instant it is placed, and the hand that
// would give it back lives in an in-memory collector. This bot deploys on
// every push, so each deploy quietly kept the bets on every live table.
//
// The rules these pin: the money and the promise to return it move in one
// transaction, a settled stake is never refunded twice, the shutdown sweep
// touches only this process's own tables (Railway overlaps containers during
// a deploy), and the boot sweep will not reach into a game young enough to
// still be running somewhere else.

const fs = require('fs');
const path = require('path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const db = require('../src/utils/db.js');

// One fake client for the whole transaction; each test programs what the
// statements hand back. pg pools are lazy, so nothing here opens a socket.
let statements;
let nextBalance;
let nextStakeId;
let deleteReturns;

const client = {
    query: jest.fn(async (sql, params) => {
        statements.push([String(sql).replace(/\s+/g, ' ').trim(), params]);
        const text = String(sql);
        if (text.includes('UPDATE balances SET balance = balance - ')) {
            return nextBalance === null ? { rows: [] } : { rows: [{ balance: nextBalance }] };
        }
        if (text.includes('INSERT INTO open_stakes')) {
            return { rows: [{ id: nextStakeId++ }] };
        }
        if (text.includes('DELETE FROM open_stakes')) {
            if (deleteReturns.length) return { rows: deleteReturns, rowCount: deleteReturns.length };
            // Postgres hands back exactly the rows it deleted; mirroring that
            // is what lets the cleanup between tests actually drain the set.
            const ids = Array.isArray(params?.[0]) ? params[0] : [];
            const rows = ids.map(id => ({ id, user_id: 'swept', amount: 0, game: 'test' }));
            return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
};

beforeEach(async () => {
    statements = [];
    nextBalance = 900;
    nextStakeId = 1;
    deleteReturns = [];
    jest.clearAllMocks();
    db.pool.connect = jest.fn(async () => client);
    db.pool.query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
});

afterEach(async () => {
    // Drain the process-local set so one test's open stakes cannot appear in
    // the next test's shutdown sweep.
    deleteReturns = [];
    await db.refundOwnStakes();
});

const sqlLike = fragment => statements.filter(([sql]) => sql.includes(fragment));

describe('taking a bet', () => {
    test('the deduction and the promise to return it share one transaction', async () => {
        const result = await db.placeStake('u1', 100, 'blackjack');

        expect(result).toEqual({ balance: 900, stakeId: '1' });
        expect(statements[0][0]).toBe('BEGIN');
        expect(statements[statements.length - 1][0]).toBe('COMMIT');
        expect(sqlLike('UPDATE balances SET balance = balance - ')).toHaveLength(1);
        expect(sqlLike('INSERT INTO open_stakes')).toHaveLength(1);
        expect(db.openStakeCount()).toBe(1);
    });

    test('short funds roll the whole thing back: no debt, no deduction', async () => {
        nextBalance = null;
        const result = await db.placeStake('u1', 999999, 'blackjack');

        expect(result).toBeNull();
        expect(sqlLike('INSERT INTO open_stakes')).toHaveLength(0);
        expect(statements[statements.length - 1][0]).toBe('ROLLBACK');
        expect(db.openStakeCount()).toBe(0);
    });

    test('a nonsense amount never reaches the database', async () => {
        expect(await db.placeStake('u1', 0, 'slots')).toBeNull();
        expect(await db.placeStake('u1', -5, 'slots')).toBeNull();
        expect(db.pool.connect).not.toHaveBeenCalled();
    });
});

describe('settling', () => {
    test('a resolved hand stops being refundable', async () => {
        const { stakeId } = await db.placeStake('u1', 100, 'highlow');
        expect(db.openStakeCount()).toBe(1);

        await db.settleStakes([stakeId]);

        expect(db.openStakeCount()).toBe(0);
        expect(db.pool.query).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM open_stakes'), [[stakeId]]);
    });

    test('settling nothing costs nothing', async () => {
        expect(await db.settleStakes([])).toBe(0);
        expect(db.pool.query).not.toHaveBeenCalled();
    });
});

describe('the sweeps', () => {
    test('shutdown refunds only the tables this process was dealing', async () => {
        await db.placeStake('u1', 100, 'blackjack');
        await db.placeStake('u1', 50, 'blackjack');
        await db.placeStake('u2', 25, 'craps');
        deleteReturns = [
            { id: 1, user_id: 'u1', amount: 100, game: 'blackjack' },
            { id: 2, user_id: 'u1', amount: 50, game: 'blackjack' },
            { id: 3, user_id: 'u2', amount: 25, game: 'craps' },
        ];
        statements = [];

        const summary = await db.refundOwnStakes();

        expect(summary).toEqual({ stakes: 3, users: 2, total: 175 });
        // Targeted by id, never a blanket delete: another container may be
        // mid-deploy and still dealing its own hands.
        const [sql, params] = sqlLike('DELETE FROM open_stakes')[0];
        expect(sql).toContain('id = ANY');
        expect(params[0]).toEqual(['1', '2', '3']);
        // Two hands, one player, one credit.
        expect(sqlLike('INSERT INTO balances')).toHaveLength(2);
        expect(db.openStakeCount()).toBe(0);
    });

    test('the boot sweep only reaches games too old to still be running', async () => {
        deleteReturns = [{ id: 9, user_id: 'u3', amount: 40, game: 'slots' }];
        const before = Date.now();

        const summary = await db.refundOpenStakes({ olderThanMs: 10 * 60 * 1000 });

        expect(summary).toEqual({ stakes: 1, users: 1, total: 40 });
        const [sql, params] = sqlLike('DELETE FROM open_stakes')[0];
        expect(sql).toContain('opened_at_ms <= ');
        expect(params[0]).toBeLessThanOrEqual(before - 10 * 60 * 1000);
    });

    test('an empty own-set never opens a connection', async () => {
        const summary = await db.refundOwnStakes();
        expect(summary).toEqual({ stakes: 0, users: 0, total: 0 });
        expect(db.pool.connect).not.toHaveBeenCalled();
    });

    test('a refund that throws mid-transaction rolls back rather than half-paying', async () => {
        await db.placeStake('u1', 100, 'craps');
        statements = [];
        client.query.mockImplementationOnce(async () => { throw new Error('connection lost'); });

        await expect(db.refundOwnStakes()).rejects.toThrow('connection lost');
        expect(sqlLike('ROLLBACK')).toHaveLength(1);
    });
});

// The wiring needs a live bot to exercise, so it is pinned at the source.
describe('the games actually hold and release their stakes', () => {
    test('every game that holds money across a collector opens a labelled stake', () => {
        for (const [file, label] of [
            ['src/commands/tools/bj.js', 'blackjack'],
            ['src/commands/tools/craps.js', 'craps'],
            ['src/commands/tools/highlow.js', 'highlow'],
            ['src/commands/tools/roulette.js', 'roulette'],
        ]) {
            expect(read(file)).toContain(`game: '${label}'`);
        }
        expect(read('src/commands/tools/slots.js')).toContain("createStake(userId, 'slots')");
    });

    test('and settles it once the hand has paid out', () => {
        for (const file of ['bj', 'craps', 'highlow', 'roulette', 'slots']) {
            expect(read(`src/commands/tools/${file}.js`)).toMatch(/[Ss]take\??\.settle\(\)/);
        }
    });

    test('a forfeit settles too: walking away must not become a refund', () => {
        // High-low is the one game where the timeout keeps the money, so its
        // collector end handler has to discharge the debt itself.
        const highlow = read('src/commands/tools/highlow.js');
        const endHandler = highlow.slice(highlow.indexOf("collector.on('end'"));
        expect(endHandler.slice(0, 400)).toMatch(/[Ss]take\??\.settle\(\)/);
    });

    test('the process refunds on the way out and sweeps stragglers on the way in', () => {
        const bot = read('src/bot.js');
        expect(bot).toContain('refundOwnStakes');
        expect(bot).toContain('refundOpenStakes({ olderThanMs: STALE_STAKE_MS })');
        // The refund has to happen while the pool is still open.
        expect(bot.indexOf('refundOwnStakes()')).toBeLessThan(bot.indexOf('pool.end()'));
    });
});
