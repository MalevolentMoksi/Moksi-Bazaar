// tests/tenure.test.js
//
// Membership tenure used to forgive on presence alone, so an account that
// joined, went quiet and never came back scored the same as a regular once the
// grace window passed. With the guild's grace set to 45 days that meant six
// weeks of sitting still bought permanent invisibility, which is not a side
// effect of the sleeper strategy, it IS the sleeper strategy.
//
// The rule is deliberately generous, and it only ever WITHHOLDS forgiveness.
// It must never add a point, and it must never touch anything else on the
// profile, because accounts with avatars and messages have turned out to be
// bots before.

const {
    participationFactor, scoreAccount, MESSAGES_FOR_FULL_TENURE, MIN_OBSERVED_DAYS, DAY_MS,
} = require('../src/utils/joinGate/suspicion');

describe('participationFactor', () => {
    test('unknown activity forgives in full, so missing data costs nobody', () => {
        expect(participationFactor(null)).toBe(1);
    });

    test('too little observation forgives in full', () => {
        // Counting started when the feature shipped. Before enough time has
        // passed, "no messages recorded" means "not watched yet".
        expect(participationFactor({ messages: 0, observedDays: MIN_OBSERVED_DAYS - 1 })).toBe(1);
    });

    test('the stated bar buys everything', () => {
        expect(participationFactor({ messages: MESSAGES_FOR_FULL_TENURE, observedDays: 200 })).toBe(1);
        expect(participationFactor({ messages: 900, observedDays: 200 })).toBe(1);
    });

    test('silence over a long window earns nothing', () => {
        expect(participationFactor({ messages: 0, observedDays: 200 })).toBe(0);
    });

    test('saying anything at all is worth a lot, by design', () => {
        // The interesting gap is between nobody and somebody, so the curve is
        // steep at the bottom: one message is already a quarter of the way.
        expect(participationFactor({ messages: 1, observedDays: 200 })).toBeGreaterThan(0.25);
        expect(participationFactor({ messages: 4, observedDays: 200 })).toBeGreaterThan(0.5);
        expect(participationFactor({ messages: 8, observedDays: 200 })).toBeGreaterThan(0.7);
    });

    test('is monotonic', () => {
        let previous = -1;
        for (let n = 0; n <= 20; n++) {
            const factor = participationFactor({ messages: n, observedDays: 200 });
            expect(factor).toBeGreaterThanOrEqual(previous);
            previous = factor;
        }
    });
});

// A profile shaped like the batch that was banned by hand: no avatar, a
// signup-suggested name, nothing else on it.
const sleeper = {
    id: '900000000000000000',
    username: 'harry_59338',
    globalName: null,
    avatar: null,
    createdTimestamp: Date.now() - 500 * DAY_MS,
};
const joinedLongAgo = { joinedTimestamp: Date.now() - 300 * DAY_MS };

const score = (participation) => scoreAccount(sleeper, {
    member: joinedLongAgo,
    protectedNames: [],
    tenureGraceDays: 45,
    participation,
});

describe('the sleeper the old rule protected', () => {
    test('a year of silence used to clear it', () => {
        // Unchanged when activity is unknown, which is what every guild looks
        // like until counting has been running for a month.
        expect(score(null).tier).toBe('clear');
    });

    test('and now keeps its profile score', () => {
        const scored = score({ messages: 0, observedDays: 300 });
        expect(scored.score).toBeGreaterThan(40);
        expect(scored.tier).not.toBe('clear');
    });

    test('the stated bar restores exactly what full forgiveness gave', () => {
        expect(score({ messages: 15, observedDays: 300 }).score).toBe(score(null).score);
        expect(score({ messages: 15, observedDays: 300 }).tier).toBe('clear');
    });

    test('even a handful of messages pulls it most of the way back', () => {
        const quiet = score({ messages: 0, observedDays: 300 }).score;
        const chatty = score({ messages: 6, observedDays: 300 }).score;
        expect(chatty).toBeLessThan(quiet / 2);
    });
});

describe('it withholds, it never accuses', () => {
    test('the tenure signal is never positive', () => {
        for (const messages of [0, 1, 5, 15, 100]) {
            const tenure = score({ messages, observedDays: 300 }).signals
                .find(s => s.id === 'membership_tenure');
            if (tenure) expect(tenure.points).toBeLessThanOrEqual(0);
        }
    });

    test('no other signal changes with participation', () => {
        const idsOf = p => score(p).signals
            .filter(s => s.id !== 'membership_tenure').map(s => s.id).sort();
        expect(idsOf({ messages: 0, observedDays: 300 })).toEqual(idsOf({ messages: 900, observedDays: 300 }));
        expect(idsOf({ messages: 0, observedDays: 300 })).toEqual(idsOf(null));
    });

    test('a quiet member with a clean profile is still clear', () => {
        // Withholding forgiveness only exposes what was already there. A real
        // lurker has nothing to expose.
        const lurker = {
            id: '900000000000000001',
            username: 'gemma',
            globalName: 'Gemma',
            avatar: 'a_animated',
            createdTimestamp: Date.now() - 1200 * DAY_MS,
        };
        const scored = scoreAccount(lurker, {
            member: joinedLongAgo,
            protectedNames: [],
            tenureGraceDays: 45,
            participation: { messages: 0, observedDays: 300 },
        });
        expect(scored.tier).toBe('clear');
    });

    test('an account with messages AND an avatar is not laundered clean', () => {
        // Participation restores tenure and nothing more. A bad profile with
        // a chat history still scores its profile.
        const chattyBot = {
            id: '900000000000000002',
            username: 'jxglybtecdmzfhwc_1234',
            globalName: null,
            avatar: 'abc',
            createdTimestamp: Date.now() - 3 * DAY_MS,
        };
        const scored = scoreAccount(chattyBot, {
            member: { joinedTimestamp: Date.now() - 2 * DAY_MS },
            protectedNames: [],
            participation: { messages: 900, observedDays: 300 },
        });
        expect(scored.tier).not.toBe('clear');
    });
});
