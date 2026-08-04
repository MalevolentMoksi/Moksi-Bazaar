// tests/phishing.test.js
//
// scam_link is worth 100 points, the strongest single signal the moderation
// pipeline has. It was reachable only through a URL with an explicit scheme or
// a www., and Discord renders `steamcomunity.com/gift` as a clickable link with
// neither. These pin the blind spot shut and, just as importantly, pin down
// that the wider matching cannot invent a hit.

const phishing = require('../src/utils/joinGate/phishing');

beforeEach(() => {
    phishing.seed(['steamcomunity.com', 'discord-nitro.ru', 'evil.example']);
});

describe('schemeless scam domains', () => {
    test('a bare host with a path is caught', () => {
        expect(phishing.scanText('free nitro at steamcomunity.com/gift/x').hits)
            .toEqual(['steamcomunity.com']);
    });

    test('a bare host with no path at all is caught', () => {
        expect(phishing.scanText('go to discord-nitro.ru now').hits)
            .toEqual(['discord-nitro.ru']);
    });

    test('a subdomain of a listed host is caught, and reported as posted', () => {
        // The full host, not the listed parent: a moderator reading the log
        // wants to see what was actually in the message. This matches what the
        // scheme-based pass has always reported.
        expect(phishing.scanText('login.steamcomunity.com is where').hits)
            .toEqual(['login.steamcomunity.com']);
    });

    test('still caught with a scheme, and reported once', () => {
        expect(phishing.scanText('https://steamcomunity.com/gift and steamcomunity.com again').hits)
            .toEqual(['steamcomunity.com']);
    });
});

describe('the wider matching cannot invent a hit', () => {
    // Everything here is hostname-shaped. None of it is on the list, so none of
    // it can score: the second pass is gated entirely on the blocklist.
    const innocent = [
        'I rewrote it in node.js last night',
        'the file is report.txt in the zip',
        'check readme.md first',
        'my favourite is discord.gg/ourserver',
        'watch it on youtube.com/watch?v=abc',
        'e.g. this and that',
    ];

    for (const text of innocent) {
        test(`"${text.slice(0, 34)}" scores no hits`, () => {
            expect(phishing.scanText(text).hits).toEqual([]);
        });
    }

    test('an empty blocklist can never produce a hit', () => {
        phishing.seed([]);
        expect(phishing.scanText('steamcomunity.com/gift').hits).toEqual([]);
    });
});

describe('the link count is unchanged by the second pass', () => {
    test('a bare hostname is not counted as a link', () => {
        // `urls` drives link_in_first_message (+12). Counting every dotted word
        // as a link would make "I use node.js" look like posting a link.
        expect(phishing.scanText('I use node.js').urls).toEqual([]);
    });

    test('real links are still counted', () => {
        expect(phishing.scanText('https://example.com and www.other.com').urls).toHaveLength(2);
    });
});

describe('host matching', () => {
    test('www and trailing dots are normalised away', () => {
        expect(phishing.normalizeHost('WWW.Evil.Example.')).toBe('evil.example');
    });

    test('a parent domain on the list catches its subdomains', () => {
        expect(phishing.isListedHost('a.b.evil.example')).toBe(true);
    });

    test('a bare TLD is never treated as a listed domain', () => {
        phishing.seed(['com']);
        expect(phishing.isListedHost('safe.com')).toBe(false);
    });
});
