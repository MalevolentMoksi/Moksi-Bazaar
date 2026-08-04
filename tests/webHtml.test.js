// tests/webHtml.test.js
//
// The renderer's one hard rule: interpolated data is escaped unless somebody
// wrote raw() on purpose. A page that renders &lt;b&gt; is ugly; a page that
// renders <script> from a Discord username hands the only owner session on
// earth to whoever picked the username. Ugly loses to unsafe.

const { esc, raw, html, table, pill, fmtAgo, layout } = require('../src/web/html');
const overview = require('../src/web/pages/overview');
const { DEFAULTS } = require('../src/utils/joinGate/config');

describe('escaping', () => {
    test('esc covers the five characters that matter', () => {
        expect(esc('<b a="x" b=\'y\'>&')).toBe('&lt;b a=&quot;x&quot; b=&#39;y&#39;&gt;&amp;');
    });

    test('the html template escapes interpolations by default', () => {
        expect(html`<p>${'<script>alert(1)</script>'}</p>`.__raw)
            .toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    });

    test('raw() opts out on purpose', () => {
        expect(html`<p>${raw('<b>ok</b>')}</p>`.__raw).toBe('<p><b>ok</b></p>');
    });

    test('arrays interleave and escape each element', () => {
        expect(html`<ul>${['<x>', raw('<li>real</li>')]}</ul>`.__raw)
            .toBe('<ul>&lt;x&gt;<li>real</li></ul>');
    });

    test('null and false vanish instead of printing', () => {
        expect(html`<p>${null}${false}${undefined}</p>`.__raw).toBe('<p></p>');
    });
});

describe('atoms', () => {
    test('a table escapes cell content from plain keys', () => {
        const out = table({
            columns: [{ key: 'name', label: 'Name' }],
            rows: [{ name: '<img onerror=x>' }],
        }).__raw;
        expect(out).toContain('&lt;img');
        expect(out).not.toContain('<img onerror');
    });

    test('an empty table says so instead of rendering nothing', () => {
        expect(table({ columns: [], rows: [], empty: 'Bare shelves.' }).__raw).toContain('Bare shelves.');
    });

    test('pills carry their state as a class', () => {
        expect(pill('danger', 'ban').__raw).toContain('pill-danger');
    });

    test('relative time has a floor and never says NaN', () => {
        expect(fmtAgo(0)).toBe('never');
        expect(fmtAgo(NaN)).toBe('never');
        expect(fmtAgo(Date.now() - 30_000)).toBe('just now');
        expect(fmtAgo(Date.now() - 3 * 86_400_000)).toBe('3d ago');
    });
});

describe('the layout shell', () => {
    test('a hostile guild name cannot break out of the picker', () => {
        const page = layout({
            title: 'Overview', path: '/',
            body: html`<p>hi</p>`,
            owner: { uid: '1', tag: '<script>alert(1)</script>', av: null },
            csrfToken: 'tok',
            guilds: [{ id: '1', name: '"><script>alert(2)</script>', memberCount: 5 }],
            guildId: '1',
        });
        expect(page).not.toContain('<script>alert');
        expect(page).toContain('&lt;script&gt;');
    });

    test('the csrf token rides along as a meta tag', () => {
        const page = layout({ title: 'T', body: html``, owner: { uid: '1', tag: 'm' }, csrfToken: 'the-token', guilds: [], guildId: null });
        expect(page).toContain('<meta name="csrf" content="the-token">');
    });
});

describe('the overview page', () => {
    const model = {
        guildName: 'Festival',
        memberCount: 1624,
        uptimeMs: 5 * 3_600_000,
        settings: {
            ...DEFAULTS,
            enabled: true,
            suspicion_enabled: true,
            suspicion_malicious_action: 'kick',
            total_kicks: 42,
            total_bans: 3,
        },
        watching: 2,
        modSummary: { total: 120 },
        recentActions: [{
            action: 'ban', target_id: '123', target_tag: '<script>evil</script>',
            actor_id: '456', actor_tag: 'Dyno', actor_is_bot: true,
            reason: 'Suspected Bot', at_ms: Date.now() - 60_000,
        }],
        unbans: [],
        now: Date.now(),
    };

    test('renders the armed state honestly', () => {
        const out = overview.render(model).__raw;
        expect(out).toContain('kick');
        expect(out).toContain('42');
        expect(out).toContain('Suspected Bot');
    });

    test('a hostile username in mod history is escaped', () => {
        const out = overview.render(model).__raw;
        expect(out).not.toContain('<script>evil');
        expect(out).toContain('&lt;script&gt;evil');
    });

    test('an untouched guild renders without a single armed pill', () => {
        const quiet = { ...model, settings: { ...DEFAULTS }, recentActions: [], modSummary: null };
        const out = overview.render(quiet).__raw;
        expect(out).toContain('pill-off');
        expect(out).not.toContain('pill-danger');
    });
});
