// tests/webBrowse.test.js
//
// The browsing pages: mod history, member list, member dossier. All render
// from fixtures. The recurring assertion is escaping, because every string on
// these pages (usernames, reasons, watch-window evidence) was typed by
// somebody the bot may be about to remove, and the reader is the one browser
// with an owner session.

const modlog = require('../src/web/pages/modlog');
const members = require('../src/web/pages/members');
const member = require('../src/web/pages/member');

describe('mod history', () => {
    const model = {
        q: null, action: null, page: 1, warnPage: 1, now: Date.now(),
        actions: {
            total: 60,
            rows: [{
                action: 'ban', target_id: '111111111111111111',
                target_tag: 'weedseller420', actor_id: '2', actor_tag: 'Dyno',
                actor_is_bot: true, reason: '<img src=x onerror=alert(1)>', at_ms: Date.now() - 3_600_000,
            }],
        },
        breakdown: [{ action: 'ban', count: 40 }, { action: 'kick', count: 20 }],
        warns: { total: 0, rows: [] },
    };

    test('renders rows with a link into the dossier', () => {
        const out = modlog.render(model).__raw;
        expect(out).toContain('/members/111111111111111111');
        expect(out).toContain('weedseller420');
    });

    test('a hostile reason is inert', () => {
        const out = modlog.render(model).__raw;
        expect(out).not.toContain('<img src=x');
        expect(out).toContain('&lt;img');
    });

    test('filter chips carry counts and the active one is marked', () => {
        const out = modlog.render({ ...model, action: 'ban' }).__raw;
        expect(out).toContain('?a=ban');
        expect(out).toMatch(/chip-active[^>]*href="\?a=ban"|href="\/modlog\?a=ban"/);
    });

    test('60 rows at 25 a page paginate to 3', () => {
        const out = modlog.render(model).__raw;
        expect(out).toContain('page 1 of 3');
        expect(out).toContain('older');
    });

    test('a search keeps its filter in the pager links', () => {
        const out = modlog.render({ ...model, q: 'weed', action: 'ban' }).__raw;
        expect(out).toContain('q=weed');
        expect(out).toContain('a=ban');
    });
});

describe('member list', () => {
    const base = {
        q: null, sort: 'last', page: 1, total: 1, nameMatchCapped: false, now: Date.now(),
        rows: [{
            user_id: '222222222222222222', message_count: 1234,
            first_message_ms: Date.now() - 40 * 86_400_000,
            last_message_ms: Date.now() - 60_000,
            name: '<b>sneaky</b>', username: 'sneaky', avatar: 'https://cdn.discordapp.com/embed/avatars/0.png',
            present: true, createdMs: Date.now() - 400 * 86_400_000,
        }],
    };

    test('a hostile display name is inert', () => {
        const out = members.render(base).__raw;
        expect(out).not.toContain('<b>sneaky');
        expect(out).toContain('&lt;b&gt;sneaky');
    });

    test('a member who left is labelled, not hidden', () => {
        const out = members.render({ ...base, rows: [{ ...base.rows[0], present: false, name: null }] }).__raw;
        expect(out).toContain('(left)');
        expect(out).toContain('222222222222222222');
    });

    test('the capped-search notice appears only when capped', () => {
        expect(members.render(base).__raw).not.toContain('first 500');
        expect(members.render({ ...base, nameMatchCapped: true }).__raw).toContain('first 500');
    });

    test('snowflake birthdays compute without BigInt overflow', () => {
        // Discord epoch check: a known snowflake's timestamp is its top bits.
        const id = '619637817294848012';
        const expected = Number((BigInt(id) >> 22n) + 1420070400000n);
        expect(members.createdMsOf(id)).toBe(expected);
        expect(members.createdMsOf('bob')).toBe(0);
    });
});

describe('member dossier', () => {
    const now = Date.now();
    const full = {
        userId: '333333333333333333', guildId: 'g1', now,
        user: {
            id: '333333333333333333', username: 'whatthesigma',
            globalName: '<script>what the sigma</script>', avatar: null, bot: false,
            createdTimestamp: now - 50 * 86_400_000,
        },
        member: { joinedTimestamp: now - 2 * 86_400_000, nickname: null, roleCount: 3, timedOutUntil: null },
        activityRow: { message_count: 0, first_message_ms: 0, last_message_ms: 0 },
        evaluation: {
            score: 55, tier: 'watch', signals: [], trustApplied: -10, trustCapped: false, forcedByDiscord: false,
        },
        explainText: '+25 Default avatar (never set one)\n+16 Auto-suggested name <detail>',
        warns: { rows: [], total: 0 },
        actions: { rows: [], total: 0 },
        attempts: null,
        watched: true,
        evidence: [{ content: '<a href=evil>free nitro</a>', messageId: '1', channelId: '99', at: now - 30_000 }],
    };

    test('the dossier renders score, tier, and the watch pill', () => {
        const out = member.render(full).__raw;
        expect(out).toContain('55');
        expect(out).toContain('watch');
        expect(out).toContain('in watch window');
    });

    test('a hostile global name and hostile evidence are both inert', () => {
        const out = member.render(full).__raw;
        expect(out).not.toContain('<script>what');
        expect(out).not.toContain('<a href=evil>');
        expect(out).toContain('&lt;script&gt;what');
        expect(out).toContain('&lt;a href=evil&gt;');
    });

    test('the explain breakdown is escaped too', () => {
        const out = member.render(full).__raw;
        expect(out).toContain('&lt;detail&gt;');
    });

    test('an account Discord no longer knows renders a dead end, not a crash', () => {
        const out = member.render({ ...full, user: null }).__raw;
        expect(out).toContain('Unknown account');
        expect(out).toContain('333333333333333333');
    });

    test('a clean member reads as clean', () => {
        const out = member.render({
            ...full,
            user: { ...full.user, globalName: 'Regular' },
            evaluation: { score: 0, tier: 'clear', signals: [], trustApplied: 0, trustCapped: false, forcedByDiscord: false },
            explainText: 'no signals fired',
            watched: false,
            evidence: [],
        }).__raw;
        expect(out).toContain('no signals fired');
        expect(out).toContain('Clean. Nothing recorded against them.');
        expect(out).not.toContain('in watch window');
    });
});
