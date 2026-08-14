// tests/relationTiers.test.js
//
// The August 2026 relation overview was eight identical neutral rows. Not a
// data problem: the smoothing makes a score converge on the average raw
// reading, the room's banter reads 0.2-0.3, and the familiar bar sat at 0.25.
// The tiers were decoration. These pin the recalibration and the texture the
// overview gained: warmth ordering, trend arrows, and a profile hook per row.

const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const { SENTIMENT_THRESHOLDS } = require('../src/utils/constants');
const { attitudeSentence } = require('../src/utils/speakPipeline');
const { createOverviewEmbed } = require('../src/utils/embedBuilder');

describe('the tiers are reachable from real readings', () => {
    test('familiar sits below the banter band, friendly demands sustained warmth', () => {
        expect(SENTIMENT_THRESHOLDS.FAMILIAR_THRESHOLD).toBe(0.15);
        expect(SENTIMENT_THRESHOLDS.FRIENDLY_THRESHOLD).toBe(0.4);
        expect(SENTIMENT_THRESHOLDS.CAUTIOUS_THRESHOLD).toBe(-0.15);
        expect(SENTIMENT_THRESHOLDS.HOSTILE_THRESHOLD).toBe(-0.4);
    });

    test('a reading moves the score far enough to matter within a session', () => {
        expect(SENTIMENT_THRESHOLDS.LOW_IMPACT).toBe(0.15);
        expect(SENTIMENT_THRESHOLDS.HIGH_IMPACT).toBe(0.3);
    });

    test('a regular whose room reads average 0.2 actually reaches a tier', () => {
        // The whole point of the recalibration: simulate the smoothing at the
        // observed banter tone and check the score crosses the familiar bar.
        let score = 0;
        for (let i = 0; i < 20; i++) {
            score = score * (1 - SENTIMENT_THRESHOLDS.LOW_IMPACT) + 0.2 * SENTIMENT_THRESHOLDS.LOW_IMPACT;
        }
        expect(score).toBeGreaterThan(SENTIMENT_THRESHOLDS.FAMILIAR_THRESHOLD);
    });

    test('the attitude sentence reads its bands from the same constants', () => {
        // Consistency, not copied numbers: the source must name the
        // thresholds, and behaviour at the band edges must match them.
        const source = read('src/utils/speakPipeline.js');
        expect(source).toContain('T.FAMILIAR_THRESHOLD');
        expect(source).toContain('T.HOSTILE_THRESHOLD');
        expect(attitudeSentence({ interactionCount: 30, sentimentScore: 0.2 })).toContain('warming');
        expect(attitudeSentence({ interactionCount: 30, sentimentScore: 0.45 })).toContain('genuinely like');
        expect(attitudeSentence({ interactionCount: 30, sentimentScore: -0.2 })).toContain('guarded');
        expect(attitudeSentence({ interactionCount: 30, sentimentScore: -0.45 })).toContain('hostility');
    });

    test('the trend query sums the ledger per user in one round trip', () => {
        const db = read('src/utils/db.js');
        expect(db).toContain('SUM(delta) AS drift');
        expect(db).toMatch(/getAttitudeTrendsBulk/);
        expect(db).toContain("user_id = ANY($1) AND created_at > NOW() - ($2::int * INTERVAL '1 day')");
    });
});

describe('the overview stops being a wall of identical rows', () => {
    const rel = (over = {}) => ({
        userId: '1', displayName: 'Someone', attitudeLevel: 'neutral',
        interactionCount: 10, sentimentScore: 0.1, isActive: true,
        drift: 0, hook: null, ...over,
    });

    const fieldNames = embed => (embed.data.fields ?? []).map(f => f.name);
    const fieldFor = (embed, name) => (embed.data.fields ?? []).find(f => f.name.includes(name));

    test('warmest tier first, and friendly is no longer filed under familiar\'s label', () => {
        const embed = createOverviewEmbed([
            rel({ attitudeLevel: 'familiar', sentimentScore: 0.2 }),
            rel({ userId: '2', attitudeLevel: 'friendly', sentimentScore: 0.5 }),
        ]);
        const names = fieldNames(embed);
        expect(names[0]).toContain('Actually likes');
        expect(names[1]).toContain('Warming up to');
        expect(names.join(' ')).not.toContain('Close Friends');
    });

    test('a week of movement earns an arrow; a mood does not', () => {
        const moving = createOverviewEmbed([rel({ drift: 0.08 })]);
        expect(fieldFor(moving, 'Neutral').value).toContain('↗');
        const cooling = createOverviewEmbed([rel({ drift: -0.06 })]);
        expect(fieldFor(cooling, 'Neutral').value).toContain('↘');
        const still = createOverviewEmbed([rel({ drift: 0.02 })]);
        expect(fieldFor(still, 'Neutral').value).not.toMatch(/[↗↘]/);
    });

    test('the profile hook rides under the row as subtext', () => {
        const embed = createOverviewEmbed([rel({ hook: 'defends mayo-ketchup as a valid fry sauce' })]);
        expect(fieldFor(embed, 'Neutral').value).toContain('-# defends mayo-ketchup');
    });

    test('a canned summary says so instead of wearing the AI\'s clothes', () => {
        const embed = createOverviewEmbed([rel()], { summary: 'i know people.', summaryCanned: true });
        expect(embed.data.footer.text).toContain('summary model failed');
        const honest = createOverviewEmbed([rel()], { summary: 'real summary', summaryCanned: false });
        expect(honest.data.footer.text).not.toContain('summary model failed');
    });

    test('every tier carries the 1024 guard, since hooks made rows taller', () => {
        const many = Array.from({ length: 40 }, (_, i) =>
            rel({ userId: String(i), displayName: `user${i}`, hook: 'a long hook '.repeat(8) }));
        const embed = createOverviewEmbed(many);
        for (const field of embed.data.fields) {
            expect(field.value.length).toBeLessThanOrEqual(1024);
        }
    });
});
