// tests/webGate.test.js
//
// The settings page's job is coverage: every switch the API accepts must be
// on the page, and every numeric field validate.js knows must have an input.
// These are drift tests. Add a column to the API without rendering it and a
// test here names it, instead of the control silently not existing, which is
// the exact failure the embed panel shipped once with a slice(0, 5).

const gate = require('../src/web/pages/gate');
const { TOGGLES } = require('../src/web/api');
const { NUMERIC_FIELDS } = require('../src/utils/joinGate/validate');
const { DEFAULTS } = require('../src/utils/joinGate/config');

const fixture = () => ({
    settings: {
        ...DEFAULTS,
        configured: true,
        exempt_user_ids: ['123456789012345678'],
        guard_exempt_user_ids: [],
        watch_exempt_channel_ids: ['2'],
        suspicion_weights: { default_avatar: 25 },
    },
    channels: [
        { id: '1', name: 'general' },
        { id: '2', name: 'self-promotion' },
        { id: '3', name: '"><script>alert(1)</script>' },
    ],
});

// Grouped forms rename their inputs; these keys are covered by those forms.
const GROUPED_NUMERICS = new Set([
    'watch_window_minutes', 'watch_action_at', 'watch_timeout_minutes',
    'guard_window_seconds', 'guard_delete_limit', 'guard_create_limit',
    'guard_perm_limit', 'guard_webhook_limit',
]);

describe('the gate page covers everything', () => {
    const out = gate.render(fixture()).__raw;

    test('every toggle the API accepts is on the page exactly once', () => {
        for (const column of Object.keys(TOGGLES)) {
            const hits = out.split(`data-toggle="${column}"`).length - 1;
            expect(`${column}:${hits}`).toBe(`${column}:1`);
        }
    });

    test('every numeric field has an input, by its own name or in a group', () => {
        for (const key of Object.keys(NUMERIC_FIELDS)) {
            if (GROUPED_NUMERICS.has(key)) continue;
            expect(out.includes(`name="${key}"`)).toBe(true);
        }
    });

    test('the grouped forms exist', () => {
        for (const api of ['watch-window', 'guard-limits', 'thresholds', 'tier-actions', 'weights', 'invite']) {
            expect(out.includes(`data-api="${api}"`)).toBe(true);
        }
    });

    test('stored values prefill', () => {
        const model = fixture();
        model.settings.suspicion_suspect_at = 77;
        model.settings.dm_invite_url = 'https://discord.gg/festival';
        const page = gate.render(model).__raw;
        expect(page).toContain('value="77"');
        expect(page).toContain('value="https://discord.gg/festival"');
        expect(page).toContain('default_avatar = 25');
    });

    test('a hostile channel name cannot break out of an option tag', () => {
        expect(out).not.toContain('<script>alert(1)');
        expect(out).toContain('&lt;script&gt;');
    });

    test('the watch-exempt channel is preselected', () => {
        const select = out.slice(out.indexOf('id="wex"'), out.indexOf('</select>', out.indexOf('id="wex"')));
        expect(select).toContain('value="2" selected');
        expect(select).toContain('value="1" >');
    });

    test('a snapshot without a DM copy warns in place', () => {
        const model = fixture();
        model.settings.snapshot_enabled = true;
        model.settings.snapshot_dm_owner = false;
        expect(gate.render(model).__raw).toContain('inside the server it backs up');
        expect(out).not.toContain('inside the server it backs up');
    });

    test('no inline style attributes: the CSP blocks them', () => {
        expect(out).not.toContain('style="');
    });

    test('minimum account age renders in days, not minutes', () => {
        const model = fixture();
        model.settings.min_account_age_minutes = 20160;
        expect(gate.render(model).__raw).toContain('value="14"');
    });
});
