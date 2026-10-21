// src/utils/money.js
/**
 * How money is written, and how it is read back from a player.
 *
 * Both used to live in each command. Five of them carried their own `money()`
 * helper and the rest printed `$${n}` bare, so the same balance read
 * "$10,000" on one panel and "$10000" on the next. Only /bj understood "all"
 * or "10,000"; every other game wanted a bare integer and said nothing useful
 * when it did not get one.
 */

/** Pinned, so the separator does not depend on where the process runs. */
const LOCALE = 'en-US';

/** `$12,345`. Negative amounts keep their sign: `-$12`. */
function money(n) {
    const value = Math.trunc(Number(n) || 0);
    const sign = value < 0 ? '-' : '';
    return `${sign}$${Math.abs(value).toLocaleString(LOCALE)}`;
}

/** `+$12`, `-$12` or `$0`: a result rather than a balance. */
function signedMoney(n) {
    const value = Math.trunc(Number(n) || 0);
    return `${value > 0 ? '+' : ''}${money(value)}`;
}

const SUFFIX = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };

/**
 * Reads what a player typed into an amount option, without knowing their
 * balance yet. A spec rather than a number, because "all" and "half" can only
 * be resolved after the balance has been read, and the balance read is the
 * thing that has to wait until the interaction is acknowledged. The shape
 * check, though, can happen first, while a private rejection still costs
 * nothing.
 *
 * Accepts `500`, `10,000`, `10 000`, `10_000`, `10k`, `2.5k`, `1m`, and with
 * `relative` on, `all`, `half` and `max`.
 *
 * @param {string|number|null} raw
 * @param {{relative?: boolean}} [options] relative: whether all/half/max are
 *   allowed. Off for /pay, where "all" is one typo from giving everything away.
 * @returns {{kind: 'fixed', value: number}|{kind: 'all'|'half'|'max'}|null}
 */
function parseAmount(raw, { relative = true } = {}) {
    const text = String(raw ?? '').trim().toLowerCase().replace(/^\$/, '');
    if (!text) return null;

    if (relative && (text === 'all' || text === 'allin' || text === 'all-in' || text === 'all in')) return { kind: 'all' };
    if (relative && text === 'half') return { kind: 'half' };
    if (relative && text === 'max') return { kind: 'max' };

    const match = text.replace(/[,_\s]/g, '').match(/^(\d+(?:\.\d+)?)([kmb])?$/);
    if (!match) return null;
    const [, digits, suffix] = match;
    // A decimal only means something in front of a suffix: "2.5k" is a
    // number of dollars, "2.5" is a fraction of one.
    if (digits.includes('.') && !suffix) return null;
    const value = Math.floor(Number(digits) * (suffix ? SUFFIX[suffix] : 1));
    if (!Number.isSafeInteger(value)) return null;
    return { kind: 'fixed', value };
}

/**
 * Turns a spec into dollars.
 *
 * "max" is the most this player may actually bet: the balance, or the house
 * ceiling when one is set and lower. "all" is the whole balance whatever the
 * ceiling, so it fails the limit check honestly rather than quietly betting
 * less than was asked.
 *
 * @param {{kind: string, value?: number}} spec from parseAmount
 * @param {number} balance
 * @param {{maxBet?: number}} [limits] house ceiling, 0 or absent for none
 */
function resolveAmount(spec, balance, { maxBet = 0 } = {}) {
    const have = Math.max(0, Math.floor(Number(balance) || 0));
    if (!spec) return 0;
    if (spec.kind === 'fixed') return spec.value;
    if (spec.kind === 'all') return have;
    if (spec.kind === 'half') return Math.floor(have / 2);
    if (spec.kind === 'max') return maxBet > 0 ? Math.min(have, maxBet) : have;
    return 0;
}

/** True when resolving this spec needs the player's balance first. */
const isRelative = spec => Boolean(spec) && spec.kind !== 'fixed';

/** The one line every amount option shows when it cannot be read. */
const AMOUNT_HINT = 'Bet a whole number of dollars: `500`, `10,000`, `10k`, or `all` / `half` / `max`.';
const PAY_HINT = 'Give a whole number of dollars: `500`, `10,000` or `10k`.';

module.exports = {
    money, signedMoney, parseAmount, resolveAmount, isRelative, AMOUNT_HINT, PAY_HINT,
};
