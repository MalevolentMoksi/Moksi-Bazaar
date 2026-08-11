// tests/neverPing.test.js
//
// On 2026-08-11 the behaviour watch caught a spammer, deleted their
// "@everyone Highly recommended!..." advert, timed them out, and posted an
// incident panel quoting the message verbatim. The mod surface was on
// Components V2, where panel text is real message content, so the panel
// pinged the entire server: the bot performed the exact attack it was
// reporting, from inside the report.
//
// The rule these tests pin is the owner's, word for word: the bot must never,
// under any condition, ping @everyone or any role unless explicitly coded to.
// Two layers enforce it. The client-wide default strips everyone/here/role
// pings from every send while keeping user pings and the reply ping alive.
// The joinGate log path goes further and parses nothing, because a log's job
// is to be read, not to wake people: mentions still render as clickable chips
// either way, which is separately load-bearing, since staff were looking
// offenders up by hand ("it doesnt say who").

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/utils/db', () => ({
    pool: { query: jest.fn(async () => ({ rows: [] })) },
    getSpeakConfigValue: jest.fn(async () => null),
    setSpeakConfigValue: jest.fn(async () => {}),
    recordSuspicionReport: jest.fn(async () => 1),
    markSuspicionReport: jest.fn(async () => null),
    getSuspicionReport: jest.fn(async () => null),
}));
// Only the database read is faked; formatDays and the rest stay real, because
// the panels under test are built out of them.
jest.mock('../src/utils/joinGate/config', () => ({
    ...jest.requireActual('../src/utils/joinGate/config'),
    getSettings: jest.fn(),
}));
jest.mock('../src/utils/joinGate/modlog', () => ({ record: jest.fn(async () => null) }));
jest.mock('../src/utils/joinGate/guard', () => ({
    ...jest.requireActual('../src/utils/joinGate/guard'),
    record: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { logSuspicion, logOutcome } = require('../src/utils/joinGate/logging');

// ── The client-wide floor ───────────────────────────────────────────────────

describe('the client never parses everyone or role pings', () => {
    const botSrc = fs.readFileSync('src/bot.js', 'utf8');

    test('the Client is constructed with users-only mention parsing', () => {
        // Source-pinned because the Client is built inside initializeBot(),
        // which logs in; constructing one in a test would need a token.
        expect(botSrc).toMatch(/allowedMentions:\s*\{\s*parse:\s*\['users'\],\s*repliedUser:\s*true\s*\}/);
    });

    test('no send site in the repo re-enables roles or everyone', () => {
        // The client default is only a default: any payload can override it.
        // This sweeps every allowedMentions in src for a parse list that
        // grants 'roles' or 'everyone', which is the one thing "never unless
        // explicitly coded to" forbids anyone doing casually.
        const offenders = [];
        const walk = dir => {
            for (const name of fs.readdirSync(dir)) {
                const p = path.join(dir, name);
                if (fs.lstatSync(p).isDirectory()) { walk(p); continue; }
                if (!name.endsWith('.js')) continue;
                const src = fs.readFileSync(p, 'utf8');
                for (const m of src.matchAll(/allowedMentions[^}]*parse:\s*\[([^\]]*)\]/g)) {
                    if (/roles|everyone/.test(m[1])) offenders.push(`${p}: ${m[0]}`);
                }
            }
        };
        walk('src');
        expect(offenders).toEqual([]);
    });
});

// ── The joinGate log path ───────────────────────────────────────────────────

/** The incident's shape: a channel that records what it was asked to send. */
function fakeGuild() {
    const channel = {
        isTextBased: () => true,
        guild: { id: 'g1' },
        permissionsFor: () => ({ has: () => true }),
        send: jest.fn(async () => ({})),
    };
    const guild = {
        id: 'g1',
        channels: { cache: new Map([['log-chan', channel]]), fetch: jest.fn() },
        members: { me: {} },
    };
    return { guild, channel };
}

const settings = { log_channel_id: 'log-chan' };

const spammer = {
    id: '1525958566979047586',
    tag: 'humphrey00614',
    username: 'humphrey00614',
    createdTimestamp: Date.now() - 30 * 86_400_000,
    displayAvatarURL: () => undefined,
};

describe('what the incident panel sends now', () => {
    test('the panel quoting an @everyone advert parses no mentions at all', async () => {
        const { guild, channel } = fakeGuild();

        const sent = await logSuspicion(guild, settings, {
            user: spammer,
            result: {
                tier: 'watch', score: 102, source: 'behaviour',
                signals: [{ points: 25, label: 'Tried @everyone', detail: 'used an @everyone/@here ping' }],
            },
            action: 'timeout',
            actionOutcome: { ok: true, minutes: 60, deleted: 2 },
            channelId: 'chan-x',
            // The verbatim quote that pinged 1,600 people from its own report.
            evidence: [{ channelId: 'chan-x', content: '@everyone Highly recommended! A small but steadily growing peptide community' }],
        });

        expect(sent).toBe(true);
        const payload = channel.send.mock.calls[0][0];
        expect(payload.allowedMentions).toEqual({ parse: [] });
    });

    test('the offender is a clickable mention, not just header text', async () => {
        const { guild, channel } = fakeGuild();

        await logSuspicion(guild, settings, {
            user: spammer,
            result: { tier: 'watch', score: 51, source: 'profile', signals: [] },
            action: 'log',
        });

        const embed = channel.send.mock.calls[0][0].embeds[0];
        expect(embed.data.description).toContain(`<@${spammer.id}>`);
    });

    // The guard alert names the account that just deleted twelve channels. It
    // was the one report in the bot that still parsed mentions, so it pinged
    // that account: the fastest possible way to tell an attacker they were
    // seen, sent by the alarm itself.
    test('the raid alert does not tap the raider on the shoulder', async () => {
        const { guild, channel } = fakeGuild();
        guild.name = 'Festival Hub';
        guild.channels.cache.set('guard-chan', channel);

        require('../src/utils/joinGate/config').getSettings.mockResolvedValue({
            enabled: true, guard_enabled: true, guard_channel_id: 'guard-chan', guard_dm_owner: false,
        });
        require('../src/utils/joinGate/guard').record.mockReturnValue({
            label: 'Mass channel deletion', actorId: 'raider-1', bucket: 'destructive',
            count: 12, windowSeconds: 30, limit: 5, actions: ['channelDelete'],
        });

        const handler = require('../src/events/client/guildAuditLogEntryCreate');
        await handler.execute(
            { id: 'audit-1', executorId: 'raider-1' },
            guild,
            { user: { id: 'bot' }, users: { fetch: jest.fn(async () => ({ username: 'raider' })) } },
        );

        const payload = channel.send.mock.calls[0][0];
        expect(payload.allowedMentions).toEqual({ parse: [] });

        const embed = payload.embeds[0].data;
        expect(embed.description).toContain('<@raider-1>');
        // "Who" repeated the first line and "Server" named the channel it was
        // posted in; the standing advice is the only thing left worth a label.
        expect(embed.fields.map(f => f.name)).toEqual(['This is a report, not an action']);
        expect(embed.description).toContain('-# raider · `raider-1`');
    });

    test('kick and ban outcomes carry the same clickable mention, silenced the same way', async () => {
        const { guild, channel } = fakeGuild();

        await logOutcome(guild, settings, {
            user: spammer,
            decision: { ageMs: 86_400_000, eligibleAt: Date.now() },
            result: { ok: true, action: 'kick', dm: 'sent' },
            origin: 'join',
            attempt: 1,
            dryRun: false,
        });

        const payload = channel.send.mock.calls[0][0];
        expect(payload.allowedMentions).toEqual({ parse: [] });
        expect(payload.embeds[0].data.description).toContain(`<@${spammer.id}>`);
    });
});
