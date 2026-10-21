// tests/money.test.js
/**
 * Every game now reads its stake through one parser and writes money through
 * one formatter. Before, only /bj understood "all" or "10,000", and the same
 * balance read "$10,000" on one panel and "$10000" on the next.
 */

const {
    money, signedMoney, parseAmount, resolveAmount, isRelative,
} = require('../src/utils/money');

describe('money', () => {
    test.each([
        [0, '$0'],
        [5, '$5'],
        [10000, '$10,000'],
        [1234567, '$1,234,567'],
        [-12, '-$12'],
        ['2500', '$2,500'],
    ])('%p reads as %s', (n, text) => {
        expect(money(n)).toBe(text);
    });

    test('a result carries its sign, a zero does not', () => {
        expect(signedMoney(50)).toBe('+$50');
        expect(signedMoney(-50)).toBe('-$50');
        expect(signedMoney(0)).toBe('$0');
    });
});

describe('parseAmount', () => {
    test.each([
        ['500', 500],
        ['10,000', 10000],
        ['10 000', 10000],
        ['10_000', 10000],
        ['$750', 750],
        ['10k', 10000],
        ['2.5k', 2500],
        ['1M', 1000000],
        ['1.2345k', 1234],
        [' 42 ', 42],
    ])('%p is %p dollars', (raw, value) => {
        expect(parseAmount(raw)).toEqual({ kind: 'fixed', value });
    });

    test.each(['all', 'ALL', 'all in', 'half', 'max'])('%p waits for the balance', raw => {
        const spec = parseAmount(raw);
        expect(spec).not.toBeNull();
        expect(isRelative(spec)).toBe(true);
    });

    test.each(['', null, 'abc', '2.5', '-5', '10kk', '1e5', 'k', '5 dollars'])('%p is not an amount', raw => {
        expect(parseAmount(raw)).toBeNull();
    });

    test('/pay never hears "all" or "half"', () => {
        expect(parseAmount('all', { relative: false })).toBeNull();
        expect(parseAmount('half', { relative: false })).toBeNull();
        expect(parseAmount('10k', { relative: false })).toEqual({ kind: 'fixed', value: 10000 });
    });
});

describe('resolveAmount', () => {
    test('all and half are measured against the balance', () => {
        expect(resolveAmount({ kind: 'all' }, 901)).toBe(901);
        expect(resolveAmount({ kind: 'half' }, 901)).toBe(450);
        expect(resolveAmount({ kind: 'fixed', value: 30 }, 901)).toBe(30);
    });

    test('max respects the house ceiling; all does not, so it fails honestly', () => {
        expect(resolveAmount({ kind: 'max' }, 50_000, { maxBet: 10_000 })).toBe(10_000);
        expect(resolveAmount({ kind: 'max' }, 5_000, { maxBet: 10_000 })).toBe(5_000);
        expect(resolveAmount({ kind: 'max' }, 50_000)).toBe(50_000);
        expect(resolveAmount({ kind: 'all' }, 50_000, { maxBet: 10_000 })).toBe(50_000);
    });

    test('a negative or missing balance resolves to nothing', () => {
        expect(resolveAmount({ kind: 'all' }, -20)).toBe(0);
        expect(resolveAmount({ kind: 'half' }, null)).toBe(0);
        expect(resolveAmount(null, 100)).toBe(0);
    });
});
