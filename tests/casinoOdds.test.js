// tests/casinoOdds.test.js
/**
 * The casino's prices, computed exactly rather than sampled.
 *
 * Two games paid out more than they took in for months: slots handed back
 * about $1.29 per dollar, and High-Low $1.51 to anyone who picked the obvious
 * side. Nothing failed and nothing logged; the leak only shows up as money
 * that should not exist. So the odds are pinned here, by enumeration.
 */

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const slots = require('../src/commands/tools/slots');
const highlow = require('../src/commands/tools/highlow');

/** C(n, k), small enough to do directly. */
function choose(n, k) {
    let r = 1;
    for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
    return r;
}

describe('slots', () => {
    const { ALL_SYMBOLS, scatterSymbol, lineMultiplier } = slots._odds;
    const total = ALL_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);

    /** Expected multiplier of one three-symbol line, over every combination. */
    function lineEV() {
        let ev = 0;
        for (const a of ALL_SYMBOLS) for (const b of ALL_SYMBOLS) for (const c of ALL_SYMBOLS) {
            ev += lineMultiplier([a, b, c]) * (a.weight * b.weight * c.weight) / total ** 3;
        }
        return ev;
    }

    /** Expected free spins per spin: one for every two scatters among nine cells. */
    function freeSpinsEV() {
        const p = scatterSymbol.weight / total;
        let ev = 0;
        for (let k = 0; k <= 9; k++) ev += Math.floor(k / 2) * choose(9, k) * p ** k * (1 - p) ** (9 - k);
        return ev;
    }

    test('returns about 95 cents per dollar, and never more than a dollar', () => {
        const rtp = lineEV() * (1 + freeSpinsEV());
        expect(rtp).toBeGreaterThan(0.93);
        expect(rtp).toBeLessThan(0.97);
    });

    test('still pays on roughly a third of spins', () => {
        let hit = 0;
        for (const a of ALL_SYMBOLS) for (const b of ALL_SYMBOLS) for (const c of ALL_SYMBOLS) {
            if (lineMultiplier([a, b, c]) > 0) hit += (a.weight * b.weight * c.weight) / total ** 3;
        }
        expect(hit).toBeGreaterThan(0.33);
    });

    test('a wild completes whatever it sits next to', () => {
        const by = emoji => ALL_SYMBOLS.find(s => s.emoji === emoji);
        expect(lineMultiplier([by('💎'), by('💎'), by('🌟')])).toBe(100);
        // Three wilds stand in for the best triple there is, not for themselves.
        expect(lineMultiplier([by('🌟'), by('🌟'), by('🌟')])).toBe(100);
        expect(lineMultiplier([by('⬛'), by('⬛'), by('⬛')])).toBe(0);
    });
});

describe('high-low', () => {
    const { RTP, RANKS, NEVER_OPENS, pricesFor, winReturn, cardValue } = highlow._odds;
    const SUITS = ['♠', '♥', '♦', '♣'];
    const fullDeck = () => SUITS.flatMap(suit => RANKS.map(rank => ({ rank, suit })));

    /** The 51 cards left once `rank` is face up. */
    function afterOpening(rank) {
        const deck = fullDeck();
        deck.splice(deck.findIndex(c => c.rank === rank), 1);
        return { current: { rank, suit: '♠' }, deck };
    }

    /** What one side returns per dollar, paid exactly as the command pays it. */
    function sideReturn(current, deck, side, bet) {
        const prices = pricesFor(current, deck);
        const m = prices[side];
        let returned = 0;
        for (const next of deck) {
            const diff = cardValue(next) - cardValue(current);
            if (diff === 0) returned += bet;
            else if ((diff > 0) === (side === 'higher')) returned += winReturn(bet, m);
        }
        return returned / deck.length / bet;
    }

    const opening = RANKS.filter(r => !NEVER_OPENS.has(r));

    test('never opens on a 2 or an Ace', () => {
        expect(opening).not.toContain('2');
        expect(opening).not.toContain('A');
        expect(opening).toHaveLength(11);
    });

    test.each(opening)('on a %s, both sides pay more than the stake', rank => {
        const { current, deck } = afterOpening(rank);
        const prices = pricesFor(current, deck);
        expect(prices.higher).toBeGreaterThan(1);
        expect(prices.lower).toBeGreaterThan(1);
    });

    test.each(opening)('on a %s, neither side returns more than the house allows', rank => {
        const { current, deck } = afterOpening(rank);
        for (const side of ['higher', 'lower']) {
            // A big bet sees the price exactly; rounding only ever favours the house.
            const r = sideReturn(current, deck, side, 1_000_000);
            expect(r).toBeLessThanOrEqual(RTP + 1e-9);
            expect(r).toBeGreaterThan(RTP - 0.01);
        }
    });

    test('the obvious side no longer prints money', () => {
        // The old game: a 3 showing, "higher", flat 2x. 44 of 51 cards win.
        const { current, deck } = afterOpening('3');
        expect(pricesFor(current, deck).higher).toBe(1.05);
        expect(sideReturn(current, deck, 'higher', 1_000_000)).toBeLessThan(1);
    });

    test('a tiny bet still wins at least a dollar', () => {
        expect(winReturn(5, 1.05)).toBe(6);
        expect(winReturn(1000, 1.05)).toBe(1050);
    });
});
