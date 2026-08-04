// tests/webApi.test.js
//
// The write surface. What matters here: the allow-lists actually match the
// schema they gate, arming a switch honours the actions already stored behind
// it, and a request that fails CSRF or names an unknown column dies before it
// touches anything.

const { sign, csrfTokenFor, SESSION_COOKIE } = require('../src/web/auth');
const { buildApp } = require('../src/web/server');
const { TOGGLES, CHANNEL_COLUMNS, MESSAGE_COLUMNS, requiresForToggle } = require('../src/web/api');
const { DEFAULTS } = require('../src/utils/joinGate/config');
const { OWNER_ID } = require('../src/utils/constants');

// WRITABLE_COLUMNS is not exported; the DEFAULTS table carries the same truth
// for what exists and what type it is.
describe('allow-lists agree with the schema', () => {
    test('every toggle is a real boolean setting', () => {
        for (const column of Object.keys(TOGGLES)) {
            expect(typeof DEFAULTS[column]).toBe('boolean');
        }
    });

    test('every channel column exists and defaults to null', () => {
        for (const column of Object.keys(CHANNEL_COLUMNS)) {
            expect(DEFAULTS).toHaveProperty(column);
            expect(DEFAULTS[column]).toBeNull();
        }
    });

    test('every message column exists', () => {
        for (const column of Object.keys(MESSAGE_COLUMNS)) {
            expect(DEFAULTS).toHaveProperty(column);
        }
    });
});

describe('arming a switch honours what is stored behind it', () => {
    const armed = {
        ...DEFAULTS,
        suspicion_watch_action: 'log',
        suspicion_suspect_action: 'timeout',
        suspicion_malicious_action: 'kick',
        watch_action: 'ban',
    };

    test('enabling suspicion needs the stored tier permissions', () => {
        expect(requiresForToggle('suspicion_enabled', true, armed).sort())
            .toEqual(['KickMembers', 'ModerateMembers']);
    });

    test('enabling the watch needs the stored watch action', () => {
        expect(requiresForToggle('watch_enabled', true, armed)).toEqual(['BanMembers']);
    });

    test('log-only tiers need nothing', () => {
        expect(requiresForToggle('suspicion_enabled', true, DEFAULTS)).toEqual([]);
    });

    test('switching OFF never needs anything', () => {
        expect(requiresForToggle('suspicion_enabled', false, armed)).toEqual([]);
        expect(requiresForToggle('guard_enabled', false, armed)).toEqual([]);
    });

    test('the guard needs the audit log, escalation needs ban', () => {
        expect(requiresForToggle('guard_enabled', true, DEFAULTS)).toEqual(['ViewAuditLog']);
        expect(requiresForToggle('escalate_enabled', true, DEFAULTS)).toEqual(['BanMembers']);
    });
});

describe('the API over the wire', () => {
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

    const post = (path, body, headers = {}) => fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie, ...headers },
        body: JSON.stringify(body),
    });

    test('no CSRF token, no write', async () => {
        const response = await post('/api/guild/g1/settings', { patch: { enabled: true } });
        expect(response.status).toBe(403);
    });

    test('a wrong CSRF token is the same as none', async () => {
        const response = await post('/api/guild/g1/settings',
            { patch: { enabled: true } }, { 'X-Bazaar-CSRF': 'guessed' });
        expect(response.status).toBe(403);
    });

    test('an unknown toggle column is refused by name', async () => {
        const response = await post('/api/guild/g1/settings',
            { patch: { drop_table: true } }, { 'X-Bazaar-CSRF': csrf });
        expect(response.status).toBe(400);
    });

    test('two columns at once is refused: toggles are one switch each', async () => {
        const response = await post('/api/guild/g1/settings',
            { patch: { enabled: true, dry_run: true } }, { 'X-Bazaar-CSRF': csrf });
        expect(response.status).toBe(400);
    });

    test('an unknown message template is refused', async () => {
        const response = await post('/api/guild/g1/message',
            { fields: { key: 'dm_message_evil', text: 'x' } }, { 'X-Bazaar-CSRF': csrf });
        expect(response.status).toBe(400);
    });

    test('a channel that is not in the guild is refused', async () => {
        const response = await post('/api/guild/g1/channel',
            { fields: { key: 'log_channel_id', channel: '12345' } }, { 'X-Bazaar-CSRF': csrf });
        expect(response.status).toBe(400);
    });

    test('a guild the bot is not in is a 404, even for the owner', async () => {
        const response = await post('/api/guild/elsewhere/thresholds',
            { fields: { watch: 1, suspect: 2, malicious: 3 } }, { 'X-Bazaar-CSRF': csrf });
        expect(response.status).toBe(404);
    });

    test('a validator refusal comes back with its own words', async () => {
        const response = await post('/api/guild/g1/thresholds',
            { fields: { watch: 100, suspect: 50, malicious: 200 } }, { 'X-Bazaar-CSRF': csrf });
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toMatch(/must rise/);
    });

    test('junk in a numeric field is refused with the field named', async () => {
        const response = await post('/api/guild/g1/numerics',
            { fields: { watch_window_minutes: 'abc' } }, { 'X-Bazaar-CSRF': csrf });
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toMatch(/not a number/);
    });

    test('a non-Discord invite is refused before it can reach a stranger', async () => {
        const response = await post('/api/guild/g1/invite',
            { fields: { url: 'https://evil.example/free-nitro' } }, { 'X-Bazaar-CSRF': csrf });
        expect(response.status).toBe(400);
    });
});
