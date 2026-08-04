// tests/webGuard.test.js
//
// The guard page and the backtest page, rendered from fixtures. The claims
// worth pinning: the guard page tells the truth about what is and is not
// watched, the snapshot button is disabled when there is nowhere to send one,
// and the backtest never runs by accident and never renders a ban button.

const guardPage = require('../src/web/pages/guard');
const backtestPage = require('../src/web/pages/backtest');
const { vetBacktestRun } = require('../src/web/server');
const { DEFAULTS } = require('../src/utils/joinGate/config');

describe('the guard page', () => {
    const base = {
        settings: { ...DEFAULTS, guard_exempt_user_ids: [] },
        guildId: 'g1',
        guardChannelName: null,
        snapshotChannelName: null,
        snapshotHasDm: true,
        backupChannelName: null,
        backupLastMs: 0,
        auditEntries: [],
        auditError: null,
        watchedNouns: ['channel deleted', 'role deleted', 'bot added'],
        now: Date.now(),
    };

    test('says plainly that moderation is not watched', () => {
        const out = guardPage.render(base).__raw;
        expect(out).toContain('Bans, kicks and timeouts are deliberately not on this list');
    });

    test('the snapshot button is live when a DM copy exists', () => {
        const out = guardPage.render(base).__raw;
        const button = out.slice(out.indexOf('Snapshot now') - 300, out.indexOf('Snapshot now'));
        expect(button).toContain('/api/guild/g1/snapshot');
        expect(button).not.toContain('disabled');
    });

    test('with nowhere to send one, the button is disabled and the page says why', () => {
        const out = guardPage.render({ ...base, snapshotHasDm: false }).__raw;
        expect(out).toContain('Nowhere to send one');
        expect(out).toContain('disabled');
    });

    test('a channel copy without a DM copy warns about where it lives', () => {
        const out = guardPage.render({ ...base, snapshotChannelName: 'guard-alerts', snapshotHasDm: false }).__raw;
        expect(out).toContain('inside the server it backs up');
    });

    test('the backup card always offers the button, and is honest about never', () => {
        const out = guardPage.render(base).__raw;
        expect(out).toContain('/api/guild/g1/backup');
        expect(out).toContain('Back up now');
        expect(out).toContain('never yet');
        expect(out).toContain('DMed to you');
    });

    test('a configured channel copy and a past run both show', () => {
        const out = guardPage.render({
            ...base, backupChannelName: 'the-vault', backupLastMs: base.now - 3 * 86_400_000,
        }).__raw;
        expect(out).toContain('#the-vault');
        expect(out).not.toContain('never yet');
    });

    test('an unreadable audit log names the missing permission', () => {
        const out = guardPage.render({ ...base, auditError: 'Missing Permissions' }).__raw;
        expect(out).toContain('View Audit Log');
    });

    test('watched audit entries are marked; unwatched ones stay quiet', () => {
        const out = guardPage.render({
            ...base,
            auditEntries: [
                { noun: 'channel deleted', name: 'ChannelDelete', watched: true, executorTag: 'evil<b>guy</b>', executorId: '1', targetId: '2', reason: null, at: Date.now() },
                { noun: null, name: 'MemberUpdate', watched: false, executorTag: 'mod', executorId: '3', targetId: '4', reason: null, at: Date.now() },
            ],
        }).__raw;
        expect(out).toContain('channel deleted');
        expect(out).toContain('MemberUpdate');
        expect(out).not.toContain('evil<b>');
        expect(out).toContain('evil&lt;b&gt;');
    });
});

describe('the backtest page', () => {
    test('without ?run=1 it renders the landing, not a report', () => {
        const out = backtestPage.render({ ran: false, limit: 50, applyTenure: false }).__raw;
        expect(out).toContain('Run the backtest');
        expect(out).toContain('name="run" value="1"');
        expect(out).not.toContain('Flagged members');
    });

    const report = {
        ran: true, limit: 50, applyTenure: false, now: Date.now(),
        report: {
            scanned: 1600,
            distribution: { clear: 1580, watch: 12, suspect: 6, malicious: 2 },
            flagged: [{
                id: '444444444444444444', tag: '<i>xx</i>_882231', score: 105, tier: 'malicious',
                tenureScore: 80, reason: 'default avatar +25, suggested name +16', forcedByDiscord: false,
            }],
            totalFlagged: 20,
            stillFlaggedWithTenure: 9,
            appliedTenure: false,
            cohorts: [{
                basis: 'creation', shape: 'suggested_6', size: 3,
                creationSpanMs: 3 * 3_600_000, joinSpanMs: 50 * 86_400_000,
                defaultAvatars: 3, silent: 3,
                members: [
                    { id: '555555555555555555', username: 'aaa_882231', createdTimestamp: Date.now() - 90 * 86_400_000, joinedTimestamp: Date.now() - 40 * 86_400_000, defaultAvatar: true, messages: 0 },
                    { id: '555555555555555556', username: 'bbb_882232', createdTimestamp: Date.now() - 90 * 86_400_000, joinedTimestamp: Date.now() - 39 * 86_400_000, defaultAvatar: true, messages: 0 },
                    { id: '555555555555555557', username: 'ccc_882233', createdTimestamp: Date.now() - 90 * 86_400_000, joinedTimestamp: Date.now() - 12 * 86_400_000, defaultAvatar: true, messages: 0 },
                ],
            }],
            activityTracked: true,
            activitySince: Date.now() - 30 * 86_400_000,
        },
    };

    test('the report shows the distribution and the both-ways tenure count', () => {
        const out = backtestPage.render(report).__raw;
        expect(out).toContain('1,600');
        expect(out).toContain('9 of these would still be flagged');
    });

    test('flagged tags are escaped and linked into the dossier', () => {
        const out = backtestPage.render(report).__raw;
        expect(out).toContain('/members/444444444444444444');
        expect(out).not.toContain('<i>xx</i>');
        expect(out).toContain('&lt;i&gt;xx&lt;/i&gt;');
    });

    test('ban commands are a paste block, never a button', () => {
        const out = backtestPage.render(report).__raw;
        expect(out).toContain('?ban 555555555555555555 Suspected Bot');
        // No POST anything near a ban; the only buttons on the page navigate.
        expect(out).not.toMatch(/data-action="[^"]*ban/);
    });

    test('a failed member fetch reports itself instead of an empty report', () => {
        const out = backtestPage.render({
            ran: true, limit: 50, applyTenure: false, now: Date.now(),
            report: { skipped: 'member fetch failed: timeout', scanned: 0, distribution: {}, flagged: [] },
        }).__raw;
        expect(out).toContain('member fetch failed');
    });

    test('no inline style attributes: the CSP blocks them', () => {
        expect(backtestPage.render(report).__raw).not.toContain('style="');
        expect(backtestPage.render({ ran: false, limit: 50, applyTenure: false }).__raw).not.toContain('style="');
    });

    test('span formatting has sane units', () => {
        expect(backtestPage.fmtSpan(90_000)).toBe('1m');
        expect(backtestPage.fmtSpan(3 * 3_600_000 + 120_000)).toBe('3h 2m');
        expect(backtestPage.fmtSpan(2 * 86_400_000 + 5 * 3_600_000)).toBe('2d 5h');
        expect(backtestPage.fmtSpan(NaN)).toBe('0m');
    });
});

describe('vetting a backtest run', () => {
    // SameSite=Lax still sends the session cookie on top-level cross-site
    // GETs, so ?run=1 must not be honored when another site navigated here.
    const reqFor = ({ run, fetchSite, ip }) => ({
        query: run ? { run: '1', n: '50' } : { n: '50' },
        ip,
        get: name => (name === 'sec-fetch-site' ? fetchSite : undefined),
    });

    test('a cross-site navigation is stripped of its run and told so', () => {
        const { query, notice } = vetBacktestRun(reqFor({ run: true, fetchSite: 'cross-site', ip: '10.0.0.1' }));
        expect(query.run).toBeUndefined();
        expect(notice).toContain('another site');
    });

    test('a same-origin click runs; so does the address bar', () => {
        expect(vetBacktestRun(reqFor({ run: true, fetchSite: 'same-origin', ip: '10.0.0.2' })).notice).toBeNull();
        expect(vetBacktestRun(reqFor({ run: true, fetchSite: undefined, ip: '10.0.0.3' })).notice).toBeNull();
    });

    test('hammering the run burns out instead of hammering Discord', () => {
        let last;
        for (let i = 0; i < 11; i++) {
            last = vetBacktestRun(reqFor({ run: true, fetchSite: 'same-origin', ip: '10.0.0.4' }));
        }
        expect(last.query.run).toBeUndefined();
        expect(last.notice).toContain('cool');
    });

    test('without ?run=1 there is nothing to vet, wherever it came from', () => {
        const { query, notice } = vetBacktestRun(reqFor({ run: false, fetchSite: 'cross-site', ip: '10.0.0.5' }));
        expect(query).toEqual({ n: '50' });
        expect(notice).toBeNull();
    });

    test('the landing page shows the notice where the run button is', () => {
        const out = backtestPage.render({ ran: false, limit: 50, applyTenure: false, notice: 'Too many runs.' }).__raw;
        expect(out).toContain('form-error');
        expect(out).toContain('Too many runs.');
    });
});
