// tests/interactionAck.test.js
//
// Discord kills an interaction token three seconds after it is created.
// Several commands ran a database round trip first and replied second, so a
// slow query produced the one outcome worth engineering against: the bet
// deducted or the cooldown spent, and "This interaction failed" on screen.
//
// Acknowledging first is easy. Keeping refusals private after acknowledging
// publicly is the part with edges, because a deferred reply's visibility is
// fixed at defer time, so these pin that "you only have $12" still lands
// where it used to.

const fs = require('fs');
const path = require('path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const { MessageFlags } = require('discord.js');
const { ackPublic, replyPublic, replyPrivate } = require('../src/utils/interactionAck');

/** A stand-in that tracks acknowledgement state the way discord.js does. */
function fakeInteraction(overrides = {}) {
    const it = {
        commandName: 'slots',
        replied: false,
        deferred: false,
        deferReply: jest.fn(async () => { it.deferred = true; }),
        reply: jest.fn(async () => { it.replied = true; return 'reply'; }),
        editReply: jest.fn(async () => 'edited'),
        followUp: jest.fn(async () => 'followed-up'),
        deleteReply: jest.fn(async () => undefined),
        ...overrides,
    };
    return it;
}

describe('claiming the interaction', () => {
    test('an untouched interaction gets deferred', async () => {
        const it = fakeInteraction();
        await ackPublic(it);
        expect(it.deferReply).toHaveBeenCalledTimes(1);
    });

    test('calling it twice does not double-acknowledge', async () => {
        const it = fakeInteraction();
        await ackPublic(it);
        await ackPublic(it);
        expect(it.deferReply).toHaveBeenCalledTimes(1);
    });

    test('a defer that fails does not throw at the command', async () => {
        const it = fakeInteraction({ deferReply: jest.fn(async () => { throw new Error('Unknown interaction'); }) });
        await expect(ackPublic(it)).resolves.toBeUndefined();
    });
});

describe('the public answer', () => {
    test('edits the placeholder when one was deferred', async () => {
        const it = fakeInteraction();
        await ackPublic(it);
        await replyPublic(it, { content: 'spinning' });
        expect(it.editReply).toHaveBeenCalledWith({ content: 'spinning' });
        expect(it.reply).not.toHaveBeenCalled();
    });

    test('fetchReply is dropped on the edit path: editReply already returns the message', async () => {
        const it = fakeInteraction();
        await ackPublic(it);
        await replyPublic(it, { content: 'x', fetchReply: true });
        expect(it.editReply).toHaveBeenCalledWith({ content: 'x' });
    });

    test('replies outright when nothing was acknowledged', async () => {
        const it = fakeInteraction();
        await replyPublic(it, 'plain string');
        expect(it.reply).toHaveBeenCalledWith({ content: 'plain string' });
    });
});

describe('the private answer', () => {
    test('after a public defer, the placeholder is removed and the refusal is ephemeral', async () => {
        const it = fakeInteraction();
        await ackPublic(it);
        await replyPrivate(it, '❌ You only have $12.');

        expect(it.deleteReply).toHaveBeenCalledTimes(1);
        expect(it.followUp).toHaveBeenCalledWith({
            content: '❌ You only have $12.', flags: MessageFlags.Ephemeral,
        });
        // Never edited into the public placeholder.
        expect(it.editReply).not.toHaveBeenCalled();
    });

    test('with nothing acknowledged it is a plain ephemeral reply', async () => {
        const it = fakeInteraction();
        await replyPrivate(it, 'nope');
        expect(it.reply).toHaveBeenCalledWith({ content: 'nope', flags: MessageFlags.Ephemeral });
    });

    test('if the private path breaks, the player still gets an answer', async () => {
        const it = fakeInteraction({ deleteReply: jest.fn(async () => { throw new Error('already gone'); }) });
        await ackPublic(it);
        await replyPrivate(it, 'nope');
        // Public is worse than private, and far better than silence.
        expect(it.editReply).toHaveBeenCalledWith({ content: 'nope' });
    });
});

// Ordering is the whole point, and only the source can show it.
describe('the money-moving commands acknowledge first', () => {
    const cases = [
        ['src/commands/tools/slots.js', 'stake.place(bet)'],
        ['src/commands/tools/craps.js', 'deductBet(userId, bet'],
        ['src/commands/tools/roulette.js', 'deductBet(userId, betAmount'],
        ['src/commands/tools/gacha.js', 'getUserCooldownRemaining'],
        ['src/commands/tools/duels.js', 'getPendingDuelsFor'],
    ];

    test.each(cases)('%s claims the interaction before it costs the player anything', (file, costly) => {
        // From the handler body only: the same names appear in the import
        // block at the top of the file, where ordering means nothing.
        const source = read(file).split('async execute')[1];
        const ack = source.indexOf('ackPublic(interaction)');
        expect(ack).toBeGreaterThan(-1);
        expect(ack).toBeLessThan(source.indexOf(costly));
    });

    test('blackjack and high-low already deferred before the money moved', () => {
        for (const file of ['src/commands/tools/bj.js', 'src/commands/tools/highlow.js']) {
            const source = read(file);
            expect(source.indexOf('deferReply()')).toBeLessThan(source.indexOf('deductBet('));
        }
    });

    test('no refusal became public in the process', () => {
        // If a converted command still edits an ephemeral flag into a public
        // placeholder, the flag is silently dropped and the refusal is public.
        for (const file of ['slots', 'craps', 'roulette', 'duels']) {
            const source = read(`src/commands/tools/${file}.js`);
            expect(source).not.toMatch(/editReply\([^)]*MessageFlags\.Ephemeral/);
        }
    });
});
