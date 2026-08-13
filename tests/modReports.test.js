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
//
// The second pass came from a photograph of a real kick report. Collapsing the
// stack of equal fields into one subtext line fixed the forms and created a
// different fault: five unrelated facts strung together with dots, wrapping
// mid-item, everything grey. "eligible in 12 days", which is the only question
// anybody asks about a joiner the gate turned away, read exactly like "caught
// on join". So there are three weights now, and the rule about which fact goes
// where is checked at the bottom of this file rather than left to taste.

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
const {
    logSuspicion, logOutcome, logUnban, logConfigChange, logTest, logBurst,
    outcomeEmbed, isAside,
} = require('../src/utils/joinGate/logging');

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
        const [mention, outcome, where] = embed.description.split('\n');

        expect(mention).toBe(`<@${spammer.id}>`);
        expect(outcome).toBe('**Timed out for 60 min** · 2 messages removed');
        // Where it happened is a link, and following it is the next thing a
        // moderator does, so it is a line and not the first item of a grey run.
        expect(where).toBe('Seen in <#chan-x>');
    });

    test('how new the account is survives, as the least of it', async () => {
        const { embed } = await report();
        const last = embed.fields[embed.fields.length - 1];
        expect(last.value.startsWith('-# ')).toBe(true);
        expect(last.value).toContain('account made <t:');
    });

    test('a temp-ban says when it lifts on a line of its own', async () => {
        // It used to be the middle item of "banned · lifts in 7 days · 2
        // messages removed", which is three unrelated facts in one breath.
        const { embed } = await report({
            action: 'ban',
            actionOutcome: { ok: true, unbanAt: Date.now() + 604_800_000, deleted: 2 },
        });
        const lines = embed.description.split('\n');
        expect(lines[1]).toBe('**Temporarily banned** · 2 messages removed');
        expect(lines[2]).toMatch(/^Ban lifts <t:\d+:R>$/);
    });

    test('the score is the headline and the arithmetic is a labelled group', async () => {
        const { embed } = await report();
        expect(embed.title).toBe('🚨 Behaviour flag · score 102');
        expect(embed.fields[0].name).toBe('Why it fired');
        expect(embed.fields[0].value).toContain('**Advertising broadcast**');
    });

    test('the four equal rows are gone, not restyled', async () => {
        const { embed } = await report();
        const names = embed.fields.filter(f => !isAside(f)).map(f => f.name);
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
        expect(embed.fields[0].value).toContain('no signals fired');
    });

    // "suspect tier" under a title that reads "Suspicious · score 51" is the
    // same word twice, and it was taking up a third of the context line.
    test('the tier is not restated under a title that is the tier', async () => {
        const { embed } = await report({
            result: { tier: 'suspect', score: 51, source: 'profile', signals: [] },
            action: 'log', actionOutcome: null, evidence: [],
        });
        expect(embed.description).not.toContain('suspect tier');
        expect(embed.fields.map(f => f.value).join('\n')).not.toContain('suspect tier');
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

        const breakdown = embed.fields
            .filter(f => !isAside(f))
            .filter(f => f.name === 'Why it fired' || f.name === '​');
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
        const [mention, grounds, returns] = embed.description.split('\n');
        expect(mention).toBe(`<@${spammer.id}>`);
        expect(grounds).toBe('**0.42 days old** at join, threshold is 14 days');
        // The only question anybody asks about a kicked joiner, answered in
        // the header block instead of buried third in a grey line.
        expect(returns).toMatch(/^Can rejoin <t:\d+:R>$/);
    });

    test('and the receipts are lines, not a run-on', async () => {
        const embed = await outcome();
        const named = embed.fields.filter(f => !isAside(f));
        expect(named.map(f => f.name)).toEqual(['DM', 'Join attempt']);
        expect(named[0].value).toBe('sent');
        expect(named[1].value).toBe('#2');
    });

    // At #1 this is on every report the gate ever writes, which makes it
    // furniture. Past #1 it is somebody working out how to get in.
    test('a first attempt is background; a repeat is a line', async () => {
        const first = await outcome({ attempt: 1 });
        expect(first.fields.map(f => f.name)).not.toContain('Join attempt');
        expect(first.fields[first.fields.length - 1].value).toContain('first attempt');

        const again = await outcome({ attempt: 4 });
        expect(again.fields.find(f => f.name === 'Join attempt').value).toBe('#4');
        expect(again.fields[again.fields.length - 1].value).not.toContain('first attempt');
    });

    test('a failure leads with the error and still shows the grounds', async () => {
        const embed = await outcome({
            result: { ok: false, action: 'kick', error: 'Missing Permissions', hint: 'Move my role up.' },
        });
        expect(embed.title).toBe('⚠️ Could not kick');
        expect(embed.description).toContain('Missing Permissions');
        expect(embed.description).toContain('at join, threshold is');
        expect(embed.fields.map(f => f.name)).toContain('How to fix');
        // Nothing is holding them out, so the date is when they stop being new.
        expect(embed.description).toMatch(/Eligible <t:\d+:R>/);
    });

    // enforcement.js hands the ban scheduler decision.eligibleAt verbatim, so
    // these were always the same instant. The report stated it twice, in two
    // different weights, and the louder one was the less useful.
    test('a temp-ban states the one moment once', async () => {
        const unbanAt = Date.now() + 604_800_000;
        const embed = await outcome({
            result: { ok: true, action: 'ban', dm: 'sent', unbanAt },
            decision: { ageMs: 0.42 * 86_400_000, eligibleAt: unbanAt },
        });
        expect(embed.title).toBe('🔨 Temporarily banned');
        expect(embed.description).toContain(`Ban lifts <t:${Math.floor(unbanAt / 1000)}:R>`);
        expect(embed.fields.map(f => f.name)).not.toContain('Auto-unban');

        const stamps = JSON.stringify(embed).match(/<t:\d+:/g) ?? [];
        const unbanStamps = stamps.filter(s => s.includes(String(Math.floor(unbanAt / 1000))));
        expect(unbanStamps).toHaveLength(2); // the relative and the absolute, one line
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The rule, applied to every embed the join gate writes rather than to the one
// that was photographed. A moderation channel is read at a glance, and a glance
// resolves a line at a time: two facts on one line is a comparison, five is a
// paragraph in grey, and the eye gives up on it.
//
// So: a line carries one fact, unless the facts are two halves of one thought
// ("Timed out for 60 min · 2 messages removed"). Background is the exception
// that proves it, because there the items really are equals and none of them
// is going to change anybody's mind.
describe('no report strings its facts together', () => {
    const linesOf = (embed) => [
        ...String(embed.description ?? '').split('\n'),
        ...(embed.fields ?? []).flatMap(f => String(f.value ?? '').split('\n')),
    ].map(l => l.trim()).filter(Boolean);

    /** Every embed the gate can write, built with realistic input. */
    async function everyEmbed() {
        const decision = { ageMs: 0.26 * 86_400_000, eligibleAt: Date.now() + 12 * 86_400_000 };
        const base = { user: spammer, decision, origin: 'join', attempt: 1, dryRun: false };
        const out = [
            outcomeEmbed(settings, { ...base, result: { ok: true, action: 'kick', dm: 'delivered' } }).embed.data,
            outcomeEmbed(settings, { ...base, attempt: 5, origin: 'sweep', result: { ok: true, action: 'ban', dm: 'failed', unbanAt: decision.eligibleAt } }).embed.data,
            outcomeEmbed(settings, { ...base, dryRun: true, result: { ok: true, action: 'kick', dm: 'would send' } }).embed.data,
            outcomeEmbed(settings, { ...base, result: { ok: false, benign: true, action: 'kick', error: 'they already left', dm: 'n/a' } }).embed.data,
            outcomeEmbed(settings, { ...base, result: { ok: false, action: 'kick', error: 'Missing Permissions', hint: 'Move my role above theirs.', dm: 'n/a' } }).embed.data,
        ];

        const capture = async (fn) => {
            const { guild, channel } = fakeGuild();
            await fn(guild);
            return channel.send.mock.calls[0][0].embeds[0].data;
        };

        out.push((await report({ action: 'ban', actionOutcome: { ok: true, unbanAt: Date.now() + 604_800_000, deleted: 2 } })).embed);
        out.push((await report({ result: { tier: 'watch', score: 22, source: 'profile', signals: [], inviteInfo: { known: true, code: 'abc', inviterId: 'u9', usesInWindow: 3 } } })).embed);
        out.push(await capture(g => logUnban(g, settings, { userId: 'u1', bannedAtMs: Date.now() - 86_400_000, ok: true })));
        out.push(await capture(g => logUnban(g, settings, { userId: 'u1', bannedAtMs: Date.now() - 86_400_000, ok: false, error: 'Unknown Ban' })));
        out.push(await capture(g => logConfigChange(g, settings, { actor: { id: 'u1' }, summary: 'Minimum account age is now 14 days.', details: 'min_account_age_minutes 10080 -> 20160' })));
        out.push(await capture(g => logTest(g, settings, 'kick', { id: 'u1' })));
        out.push(await capture(g => logBurst(g, settings, { count: 9, windowSeconds: 60 })));
        return out;
    }

    test('a line carries one fact, or two that are one thought', async () => {
        const offenders = [];
        for (const embed of await everyEmbed()) {
            for (const line of linesOf(embed)) {
                const items = line.split(' · ').length;
                const limit = isAside({ value: line }) ? 3 : 2;
                if (items > limit) offenders.push(`${embed.title}: ${line}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('and the background line is the only grey one', async () => {
        for (const embed of await everyEmbed()) {
            const grey = (embed.fields ?? []).filter(isAside);
            expect(grey.length).toBeLessThanOrEqual(1);
            // It is last, because it is the least of it.
            if (grey.length) expect(embed.fields[embed.fields.length - 1]).toBe(grey[0]);
        }
    });

    // A label is the weight. Something that reads as a sentence is not a fact
    // with a name, it is a paragraph wearing one.
    test('every named fact is short enough to sit beside its label', async () => {
        for (const embed of await everyEmbed()) {
            for (const field of (embed.fields ?? []).filter(f => !isAside(f))) {
                if (field.name === 'How to fix' || field.name === 'Why it fired') continue;
                if (field.name === 'What they posted') continue;
                expect(field.name.length).toBeLessThanOrEqual(14);
            }
        }
    });
});
