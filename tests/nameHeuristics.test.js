// tests/nameHeuristics.test.js
//
// A member whose display name is صلو على محمد scored 20 points for an
// "unpronounceable name" and 15 more for a "generated-looking" one. The
// username was slwlmhmd__10161: a transliteration of that display name.
//
// Arabic, Hebrew, Persian and Urdu are abjads. Short vowels are not written.
// Discord allows only [a-z0-9._] in a username, so speakers of those languages
// cannot write their own name there without producing a run of consonants,
// which is exactly what the generator test measured. It was not detecting
// machine output, it was detecting the writing system.
//
// The exemption is deliberately narrow, and these pin the boundary in both
// directions: another script in the display name clears, everything else does
// not, and generator output still scores.

const {
    looksRandom, isMostlyNonLatin, scoreAccount, DAY_MS,
} = require('../src/utils/joinGate/suspicion');

/** The reported member, reconstructed from the profile card. */
const reported = {
    id: '900000000000000000',
    username: 'slwlmhmd__10161',
    globalName: 'صلو على محمد',
    avatar: 'abc123',
    createdTimestamp: Date.now() - 400 * DAY_MS,
};

const score = (user, extra = {}) =>
    scoreAccount(user, { applyTenure: false, protectedNames: [], ...extra });
const idsFor = user => score(user).signals.map(s => s.id);

describe('the reported false positive', () => {
    test('no longer scores as a random-looking name', () => {
        expect(idsFor(reported)).not.toContain('gibberish_name');
        expect(idsFor(reported)).not.toContain('generated_name');
    });

    test('the digit block is still reported, because that part was true', () => {
        // Reported as suggested_name rather than digit_suffix: the username is
        // stem-underscore-five-digits, which is the narrower signal.
        expect(idsFor(reported)).toContain('suggested_name');
    });

    test('and the score drops below the watch tier', () => {
        expect(score(reported).score).toBeLessThan(40);
    });
});

describe('a display name in another script clears the username', () => {
    const scripts = [
        ['slwlmhmd__10161', 'صلو على محمد', 'Arabic, the reported case'],
        ['shlmhtzbrg', 'שלמה הרצברג', 'Hebrew, another abjad'],
        ['zhngwmng', '张伟明', 'Chinese'],
        ['tnkykhr', '田中幸宏', 'Japanese'],
        ['kmsnghyn', '김성현', 'Korean'],
        ['ptrsmrnv', 'Пётр Смирнов', 'Cyrillic'],
        ['nkhntchrn', 'ณัฐพงศ์', 'Thai'],
    ];

    for (const [username, globalName, why] of scripts) {
        test(`${username} (${why})`, () => {
            expect(idsFor({ ...reported, username, globalName })).not.toContain('gibberish_name');
        });
    }
});

describe('deliberately still flagged', () => {
    // Accepted false positives. A Latin-script name dense enough to trip the
    // run test is rare in a server this size, and a report someone glances at
    // costs less than a bot that walks through. Documented so the trade is a
    // decision on the record rather than an oversight.
    const stillFlagged = [
        ['mhmdslh1234', 'Mohammed Saleh', 'vowels dropped, but the display name is Latin'],
        ['llwybrcwmwd', 'Llwybr Cwmwd', 'Welsh, where w is a vowel'],
    ];

    for (const [username, globalName, why] of stillFlagged) {
        test(`${username} (${why})`, () => {
            expect(idsFor({ ...reported, username, globalName })).toContain('gibberish_name');
        });
    }
});

describe('romanisations written out in full were never at risk', () => {
    // Pinyin, Hepburn and Revised Romanization all write vowels, so these were
    // clear before the fix too. Pinned so a later tweak cannot break them.
    for (const name of ['zhangweiming', 'tanakayukihiro', 'kimseonghyeon', 'rodriguezmartinez']) {
        test(`${name} is not random-looking`, () => {
            expect(looksRandom(name)).toBe(false);
        });
    }

    test('schwartzmann is clear now the vowel-density test is gone', () => {
        // It measured 0.25 percentage points of extra catch on random strings
        // and flagged Germanic compounds, so it was removed.
        expect(looksRandom('schwartzmann')).toBe(false);
    });
});

describe('generator output is still caught', () => {
    for (const name of ['jxglybtecdmzfhwc', 'qzwrtplkjhgfds', 'bcdfghjklm', 'xkcdvbnmqw']) {
        test(`${name} still reads as random`, () => {
            expect(looksRandom(name)).toBe(true);
        });
    }

    test('with no display name at all it scores the full signature', () => {
        const user = { ...reported, username: 'jxglybtecdmzfhwc1234', globalName: null, avatar: null };
        expect(idsFor(user)).toContain('gibberish_name');
        expect(idsFor(user)).toContain('bulk_signature');
    });

    test('a nicer-looking Latin display name buys nothing', () => {
        expect(idsFor({ ...reported, username: 'jxglybtecdmzfhwc', globalName: 'Steve' }))
            .toContain('gibberish_name');
    });

    test('spelling the username out as a display name buys nothing', () => {
        // The rejected subsequence exemption would have cleared this one.
        expect(idsFor({ ...reported, username: 'jxglybtecdmzfhwc', globalName: 'Jxglyb Tecdmzfhwc' }))
            .toContain('gibberish_name');
    });

    test('an Arabic display name does not hide the rest of the signature', () => {
        // The exemption removes 35 points and no more: a throwaway that sets a
        // non-Latin display name is still comfortably over the suspect tier.
        const user = {
            ...reported,
            username: 'jxglybtecdmzfhwc1234',
            globalName: 'محمد',
            avatar: null,
            createdTimestamp: Date.now() - 2 * DAY_MS,
        };
        expect(idsFor(user)).not.toContain('gibberish_name');
        expect(score(user).score).toBeGreaterThanOrEqual(70);
    });
});

describe('isMostlyNonLatin', () => {
    test.each([
        ['صلو على محمد', true],
        ['张伟明', true],
        ['Пётр', true],
        ['Mohammed Saleh', false],
        ['Jxglyb Tecdmzfhwc', false],
        ['', false],
        ['A', false],
        [null, false],
    ])('%s -> %s', (text, expected) => {
        expect(isMostlyNonLatin(text)).toBe(expected);
    });
});
