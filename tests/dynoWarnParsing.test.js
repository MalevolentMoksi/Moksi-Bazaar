// tests/dynoWarnParsing.test.js
//
// Scraping another bot's wording is the fragile half of the warns record, so
// the parsing is pinned: what counts as a warn, what counts as a removal,
// and, above all, who the warn is attributed to. The attribution bug this
// guards against was real: id resolution used to scan the whole flattened
// embed, so a reason reading "harassing @victim" filed the warn against the
// victim, because the reason field is exactly where somebody else's mention
// is most likely to appear.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/health', () => ({ report: jest.fn() }));
jest.mock('../src/utils/db', () => ({
    pool: { query: jest.fn(async () => ({ rows: [] })) },
    recordWarn: jest.fn(async () => true),
    linkWarnsToUser: jest.fn(async () => 0),
    removeWarnByCase: jest.fn(async () => null),
    removeWarnsForUser: jest.fn(async () => 0),
}));

const {
    extractWarnInfo,
    extractRemovalInfo,
    resolveWarnedUserId,
    embedTextWithoutReasons,
} = require('../src/events/client/dynoWarnListener');

const embed = (over = {}) => ({
    description: '', title: '', footer: null, author: null, fields: [], ...over,
});

describe('what counts as a warn', () => {
    test('the standard confirmation, with its case number', () => {
        const info = extractWarnInfo(embed({ description: '<:dynoSuccess:1> ***somebody has been warned. Case #42***' }));
        expect(info).toEqual({ warnedUser: 'somebody', warnId: '42' });
    });

    test('the case number can live in the footer instead', () => {
        const info = extractWarnInfo(embed({
            description: '**somebody has been warned.**',
            footer: { text: 'Case #7' },
        }));
        expect(info).toEqual({ warnedUser: 'somebody', warnId: '7' });
    });

    test('an unrelated Dyno embed is not a warn', () => {
        expect(extractWarnInfo(embed({ description: '**somebody has been muted.**' }))).toBeNull();
    });
});

describe('what counts as a removal', () => {
    test.each([
        ['**Deleted warning #42**', 'case', '42'],
        ['Removed warn 42 for somebody', 'case', '42'],
        ['**Deleted Case #42**', 'case', '42'],
        ['Warning #42 deleted.', 'case', '42'],
        ['Case #42 has been removed', 'case', '42'],
    ])('%s marks one case', (text, kind, caseId) => {
        expect(extractRemovalInfo(embed({ description: text }))).toEqual({ kind, caseId });
    });

    test('a cleared-user line marks the person', () => {
        const removal = extractRemovalInfo(embed({ description: 'Cleared 3 warnings for somebody.' }));
        expect(removal).toEqual({ kind: 'clear', subject: 'somebody' });
    });

    test('an ordinary warn is not a removal', () => {
        expect(extractRemovalInfo(embed({ description: '**somebody has been warned.** Case #42' }))).toBeNull();
    });
});

describe('who the warn belongs to', () => {
    const message = { guildId: 'g1', guild: { members: { fetch: jest.fn(async () => new Map()) } } };

    test('a mention outside the reason wins', async () => {
        const id = await resolveWarnedUserId(message, embed({
            description: '**somebody has been warned.**',
            fields: [{ name: 'User', value: '<@111111111111111111>' }],
        }), 'somebody');
        expect(id).toBe('111111111111111111');
    });

    test('a mention INSIDE the reason is the victim, not the target', async () => {
        const id = await resolveWarnedUserId(message, embed({
            description: '**somebody has been warned.**',
            fields: [{ name: 'Reason', value: 'harassing <@222222222222222222> in general' }],
        }), 'somebody');
        // No usable id outside the reason, and the member lookup found no
        // unique match: unresolved beats wrong.
        expect(id).toBeNull();
    });

    test('the reason is stripped before any id is read', () => {
        const text = embedTextWithoutReasons(embed({
            description: 'desc',
            fields: [
                { name: 'Reason', value: '<@222222222222222222>' },
                { name: 'Moderator', value: 'modname' },
            ],
        }));
        expect(text).not.toContain('222222222222222222');
        expect(text).toContain('modname');
    });
});
