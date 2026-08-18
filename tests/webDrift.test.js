// tests/webDrift.test.js
//
// Two writers, one set of side effects.
//
// The Discord panel and the web dashboard share validate.js, so a rule cannot
// drift. Side effects were another story: the panel started the phishing
// refresh, primed the invite cache and recomputed pending temp-bans after a
// threshold edit, and the dashboard did none of it. The visible symptom was a
// dashboard-enabled watch scoring against an EMPTY scam-domain list until the
// next deploy: its 100-point signal, silently missing. These tests pin the
// dashboard to the panel's side effects.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/db', () => ({
    pool: { query: jest.fn(async () => ({ rows: [] })) },
}));
jest.mock('../src/utils/joinGate/unbanScheduler', () => ({
    recomputePendingUnbans: jest.fn(async () => 1),
    scheduleNext: jest.fn(async () => {}),
    getPendingUnbans: jest.fn(async () => []),
    insertPendingUnban: jest.fn(async () => {}),
    deletePendingUnban: jest.fn(async () => {}),
    initUnbanScheduler: jest.fn(async () => {}),
}));
jest.mock('../src/utils/joinGate/phishing', () => ({
    startAutoRefresh: jest.fn(),
    stats: jest.fn(() => ({ domains: 0, refreshedAt: 0 })),
    scanText: jest.fn(() => ({ urls: [], hits: [] })),
}));
jest.mock('../src/utils/joinGate/invites', () => ({
    syncGuild: jest.fn(async () => {}),
    canRead: jest.fn(() => true),
    resolveJoin: jest.fn(async () => null),
}));

const { sign, csrfTokenFor, SESSION_COOKIE } = require('../src/web/auth');
const { buildApp } = require('../src/web/server');
const { OWNER_ID } = require('../src/utils/constants');
const { recomputePendingUnbans, scheduleNext } = require('../src/utils/joinGate/unbanScheduler');
const { startAutoRefresh } = require('../src/utils/joinGate/phishing');
const { syncGuild, canRead } = require('../src/utils/joinGate/invites');

const SECRET = 'test-secret-of-decent-length-1234';
const fakeGuild = {
    id: 'g1',
    name: 'Testable',
    memberCount: 5,
    channels: { cache: new Map() },
    members: { me: { permissions: { has: () => true } } },
};
const fakeClient = {
    isReady: () => true,
    guilds: { cache: new Map([['g1', fakeGuild]]) },
    uptime: 1000,
};
const config = {
    clientId: 'app-id', clientSecret: 'app-secret',
    sessionSecret: SECRET, baseUrl: 'http://127.0.0.1', secureCookies: false,
};

let server;
let base;
let cookie;
let csrf;

beforeAll((done) => {
    const now = Date.now();
    const session = { uid: OWNER_ID, tag: 'moksi', av: null, iat: now, exp: now + 60_000 };
    cookie = `${SESSION_COOKIE}=${sign(session, SECRET)}`;
    csrf = csrfTokenFor(session, SECRET);

    const { app } = buildApp(fakeClient, config);
    server = app.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        done();
    });
});

afterAll((done) => {
    server.close(done);
    server.closeAllConnections?.();
});

beforeEach(() => {
    jest.clearAllMocks();
    canRead.mockReturnValue(true);
    recomputePendingUnbans.mockResolvedValue(1);
});

const post = (path, body) => fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, 'X-Bazaar-CSRF': csrf },
    body: JSON.stringify(body),
});

describe('the dashboard performs the panel\'s side effects', () => {
    test('enabling the watch starts the phishing refresh', async () => {
        const response = await post('/api/guild/g1/settings', { patch: { watch_enabled: true } });
        expect(response.status).toBe(200);
        expect(startAutoRefresh).toHaveBeenCalled();
    });

    test('disabling the watch does not', async () => {
        await post('/api/guild/g1/settings', { patch: { watch_enabled: false } });
        expect(startAutoRefresh).not.toHaveBeenCalled();
    });

    test('enabling invite tracking primes the cache', async () => {
        const response = await post('/api/guild/g1/settings', { patch: { invite_tracking_enabled: true } });
        expect(response.status).toBe(200);
        expect(syncGuild).toHaveBeenCalledWith(fakeGuild);
    });

    test('invite tracking without Manage Server is refused, like the panel refuses it', async () => {
        canRead.mockReturnValue(false);
        const response = await post('/api/guild/g1/settings', { patch: { invite_tracking_enabled: true } });
        expect(response.status).toBe(400);
        expect(syncGuild).not.toHaveBeenCalled();
    });

    test('an age-threshold edit recomputes pending temp-bans', async () => {
        const response = await post('/api/guild/g1/numerics', { fields: { min_account_age_minutes: '7' } });
        expect(response.status).toBe(200);
        expect(recomputePendingUnbans).toHaveBeenCalledWith('g1', expect.any(Number));
        expect(scheduleNext).toHaveBeenCalled();
    });

    test('other numeric edits leave the unban ledger alone', async () => {
        const response = await post('/api/guild/g1/numerics', { fields: { watch_window_minutes: '15' } });
        expect(response.status).toBe(200);
        expect(recomputePendingUnbans).not.toHaveBeenCalled();
    });
});
