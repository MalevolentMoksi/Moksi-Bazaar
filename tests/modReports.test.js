// tests/modReports.test.js
//
// A moderation report is read once, usually late, usually by someone deciding
// in five seconds whether they have to do something. The reports had drifted
// into forms: a stack of fields of identical weight where bold-versus-not-bold
// was the only hierarchy, so "timed out for 60 min, 2 messages removed" sat in
// the same typeface as "Source: first messages after joining".
//
// These pin the shape rather than the wording: what happened is in the header
// block, provenance is subtext, and anything a moderator must read is a
// labelled group of its own. They also pin the two things that were simply
// missing: a way to reach the message, and a report that wakes nobody.

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/utils/db', () => ({
    pool: { query: jest.fn(async () => ({ rows: [] })) },
    getSpeakConfigValue: jest.fn(async () => null),
    setSpeakConfigValue: jest.fn(async () => {}),
    recordSuspicionReport: jest.fn(async () => 77),
    markSuspicionReport: jest.fn(async () => ({ id: 77, userId: 'u', falsePositive: true })),
    getSuspicionReport: jest.fn(async () => ({ id: 77, user_id: 'u', score: 102, false_positive: false })),
}));

const db = require('../src/utils/db');
const { logSuspicion, logOutcome } = require('../src/utils/joinGate/logging');

beforeEach(() => {
    db.recordSuspicionReport.mockClear();
    db.recordSuspicionReport.mockResolvedValue(77);
});

function fakeGuild() {
    const channel = {
        isTextBased: () => true,
        guild: { id: 'g1' },
        permissionsFor: () => ({ has: () => true }),
        send: jest.fn(async () => ({})),
    };
    const guild = {
        id: 'g1',
        name: 'Festival Hub',
        channels: { cache: new Map([['log-chan', channel]]), fetch: jest.fn() },
        members: { me: {} },
    };
    return { guild, channel };
}

const settings = { log_channel_id: 'log-chan', min_account_age_minutes: 20_160 };

const spammer = {
    id: '1525958566979047586',
    tag: 'humphrey00614',
    username: 'humphrey00614',
    createdTimestamp: Date.now() - 30 * 86_400_000,
    displayAvatarURL: () => 'https://cdn.invalid/avatar.png',
};

/** The live incident, minus whichever part a given test wants to vary. */
async function report(overrides = {}) {
    const { guild, channel } = fakeGuild();
    await logSuspicion(guild, settings, {
        user: spammer,
        result: {
            tier: 'malicious', score: 102, source: 'behaviour',
            signals: [
                { points: 35, label: 'Advertising broadcast', detail: 'an invite to another server, pushed with a mass ping' },
                { points: 25, label: 'Tried @everyone', detail: 'used an @everyone/@here ping' },
            ],
        },
        action: 'timeout',
        actionOutcome: { ok: true, minutes: 60, deleted: 2 },
        channelId: 'chan-x',
        evidence: [{ channelId: 'chan-x', messageId: 'm-77', content: '@everyone Highly recommended!' }],
        ...overrides,
    });
    const payload = channel.send.mock.calls[0][0];
    return { payload, embed: payload.embeds[0].data };
}

describe('the behaviour flag reads as a card, not a form', () => {
    test('what the bot did is in the header block, in its own weight', async () => {
        const { embed } = await report();
        const [mention, outcome, context] = embed.description.split('\n');

        expect(mention).toBe(`<@${spammer.id}>`);
        expect(outcome).toBe('**Timed out for 60 min** · 2 messages removed');
        // Where and how new the account is: kept, never a heading.
        expect(context.startsWith('-# ')).toBe(true);
        expect(context).toContain('in <#chan-x>');
        expect(context).toContain('account made <t:');
    });

    test('the score is the headline and the arithmetic is a labelled group', async () => {
        const { embed } = await report();
        expect(embed.title).toBe('🚨 Behaviour flag · score 102');
        expect(embed.fields[0].name).toBe('Why it fired');
        expect(embed.fields[0].value).toContain('**Advertising broadcast**');
    });

    test('the four equal rows are gone, not restyled', async () => {
        const { embed } = await report();
        const names = embed.fields.map(f => f.name);
        // "Outcome" moved up into the header, "Source" repeated the footer and
        // "Tier" repeated the title, so none of them is a row any more.
        expect(names).not.toContain('Outcome');
        expect(names).not.toContain('Source');
        expect(names).not.toContain('Tier');
        expect(names).not.toContain('Where');
        expect(names).not.toContain('Account created');
        expect(names).toEqual(['Why it fired', 'What they posted']);
    });

    test('a profile-tier report keeps its own words for the same shape', async () => {
        const { embed } = await report({
            result: { tier: 'suspect', score: 51, source: 'profile', signals: [] },
            action: 'log',
            actionOutcome: null,
            evidence: [],
        });
        expect(embed.title).toBe('⚠️ Suspicious · score 51');
        expect(embed.description).toContain('**Logged only** · no action taken');
        expect(embed.description).toContain('suspect tier');
        expect(embed.fields[0].value).toContain('no signals fired');
    });

    // The arithmetic is the entire point of the report, and an embed field
    // value stops at 1024 characters.
    test('a long breakdown continues instead of being cut off mid-signal', async () => {
        const signals = Array.from({ length: 30 }, (_, i) => ({
            points: 30 - i,
            label: `Signal number ${i}`,
            detail: 'a detail long enough to matter when thirty of them are stacked together',
        }));
        const { embed } = await report({
            result: { tier: 'malicious', score: 300, source: 'profile', signals },
        });

        const breakdown = embed.fields.filter(f => f.name === 'Why it fired' || f.name === '​');
        expect(breakdown.length).toBeGreaterThan(1);
        for (const field of breakdown) expect(field.value.length).toBeLessThanOrEqual(1024);
        expect(breakdown.map(f => f.value).join('\n')).toContain('Signal number 20');
    });
});

describe('what the report lets you do from where you read it', () => {
    const buttons = payload => (payload.components ?? []).flatMap(r => r.toJSON().components);
    const jumpOf = payload => buttons(payload).find(b => b.url)?.url;
    const idsOf = payload => buttons(payload).map(b => b.custom_id ?? 'link');

    test('a surviving message gets a jump button', async () => {
        const { payload } = await report({ actionOutcome: { ok: true, minutes: 60 } });
        expect(jumpOf(payload)).toBe('https://discord.com/channels/g1/chan-x/m-77');
    });

    test('a dry run, which deletes nothing, gets one too', async () => {
        const { payload } = await report({ dryRun: true, action: 'none', actionOutcome: null });
        expect(jumpOf(payload)).toBe('https://discord.com/channels/g1/chan-x/m-77');
    });

    // A dead jump button is worse than none: it reads as a report pointing at
    // something staff cannot see, when in fact the bot removed it on purpose.
    test('purged evidence loses the jump, and only the jump', async () => {
        const { payload } = await report();
        expect(jumpOf(payload)).toBeUndefined();
        expect(idsOf(payload)).toEqual([`jg_uid:${spammer.id}`, 'jg_fp:77']);
    });

    test('evidence recorded without a message id is simply not linked', async () => {
        const { payload } = await report({
            actionOutcome: { ok: true, minutes: 60 },
            evidence: [{ channelId: 'chan-x', content: 'no id on this one' }],
        });
        expect(jumpOf(payload)).toBeUndefined();
    });

    // The mark button is the only one that needs the report to exist on file,
    // because the row id is what a click three deploys later resolves against.
    test('the report is filed with its signals before the panel goes out', async () => {
        await report();
        const filed = db.recordSuspicionReport.mock.calls[0][0];
        expect(filed).toMatchObject({ guildId: 'g1', userId: spammer.id, score: 102, tier: 'malicious', source: 'behaviour', action: 'timeout' });
        expect(filed.signals.map(s => s.label)).toContain('Tried @everyone');
    });

    test('a dry run is filed as one, not as the action it would have taken', async () => {
        await report({ dryRun: true });
        expect(db.recordSuspicionReport.mock.calls[0][0].action).toBe('dry-run');
    });

    test('a failed write costs the mark button and nothing else', async () => {
        db.recordSuspicionReport.mockRejectedValueOnce(new Error('no database'));
        const { payload, embed } = await report({ actionOutcome: { ok: true, minutes: 60 } });
        expect(idsOf(payload)).toEqual(['link', `jg_uid:${spammer.id}`]);
        expect(embed.title).toContain('Behaviour flag');
    });
});

describe('the kick and ban report answers in the same order', () => {
    async function outcome(overrides = {}) {
        const { guild, channel } = fakeGuild();
        await logOutcome(guild, settings, {
            user: spammer,
            decision: { ageMs: 0.42 * 86_400_000, eligibleAt: Date.now() + 86_400_000 },
            result: { ok: true, action: 'kick', dm: 'sent' },
            origin: 'join',
            attempt: 2,
            dryRun: false,
            ...overrides,
        });
        return channel.send.mock.calls[0][0].embeds[0].data;
    }

    test('what happened is the title and the grounds are the line under it', async () => {
        const embed = await outcome();
        expect(embed.title).toBe('👢 Kicked');
        const [mention, grounds, paperwork] = embed.description.split('\n');
        expect(mention).toBe(`<@${spammer.id}>`);
        expect(grounds).toBe('**0.42 days old** at join, threshold is 14 days');
        // Seven fields of equal weight became one subtext line of receipts.
        expect(paperwork.startsWith('-# ')).toBe(true);
        expect(paperwork).toContain('join attempt #2');
        expect(paperwork).toContain('DM sent');
        expect(paperwork).toContain('caught on join');
        expect(embed.fields ?? []).toHaveLength(0);
    });

    test('a failure leads with the error and still shows the grounds', async () => {
        const embed = await outcome({
            result: { ok: false, action: 'kick', error: 'Missing Permissions', hint: 'Move my role up.' },
        });
        expect(embed.title).toBe('⚠️ Could not kick');
        expect(embed.description).toContain('Missing Permissions');
        expect(embed.description).toContain('at join, threshold is');
        expect(embed.fields.map(f => f.name)).toContain('How to fix');
    });

    test('a temp-ban keeps the unban time as a group of its own', async () => {
        const embed = await outcome({
            result: { ok: true, action: 'ban', dm: 'sent', unbanAt: Date.now() + 604_800_000 },
        });
        expect(embed.title).toBe('🔨 Temporarily banned');
        expect(embed.fields.map(f => f.name)).toContain('Auto-unban');
    });
});
