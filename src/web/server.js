// src/web/server.js
/**
 * The dashboard's front door, living inside the bot's own process.
 *
 * Same process on purpose: it shares the live Discord client, so backtests,
 * cohort scans and snapshots work directly instead of through a bridge, and it
 * costs nothing extra to run. The price of sharing a process is that this file
 * must never be able to take the bot down, so:
 *
 *   - If any required env var is missing, startDashboard() logs one line and
 *     returns null. No server, no port, no change to the bot at all.
 *   - Every route is wrapped; a thrown error becomes a themed 500, never an
 *     unhandled rejection.
 *   - Shutdown closes this server FIRST, so requests drain while the gateway
 *     and the pool are still alive to serve them.
 *
 * Required env: CLIENT_ID, DISCORD_CLIENT_SECRET, SESSION_SECRET,
 * DASHBOARD_BASE_URL. PORT comes from Railway (3000 locally).
 */

const path = require('node:path');
const express = require('express');
const logger = require('../utils/logger');
const { createAuth } = require('./auth');
const { html, layout, doorPage, card } = require('./html');

/** Reads and checks configuration; says exactly what is missing. */
function dashboardConfig(env = process.env) {
    const wanted = {
        CLIENT_ID: env.CLIENT_ID,
        DISCORD_CLIENT_SECRET: env.DISCORD_CLIENT_SECRET,
        SESSION_SECRET: env.SESSION_SECRET,
        DASHBOARD_BASE_URL: env.DASHBOARD_BASE_URL,
    };
    const missing = Object.entries(wanted).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) return { enabled: false, missing };

    if (String(env.SESSION_SECRET).length < 16) {
        return { enabled: false, missing: ['SESSION_SECRET (too short: use 32+ random characters)'] };
    }

    const baseUrl = String(env.DASHBOARD_BASE_URL).replace(/\/+$/, '');
    return {
        enabled: true,
        clientId: String(env.CLIENT_ID),
        clientSecret: String(env.DISCORD_CLIENT_SECRET),
        sessionSecret: String(env.SESSION_SECRET),
        baseUrl,
        secureCookies: baseUrl.startsWith('https://'),
        port: Number(env.PORT) || 3000,
    };
}

/** Guilds the bot can show, largest first. */
function guildChoices(client) {
    return [...client.guilds.cache.values()]
        .map(g => ({ id: g.id, name: g.name, memberCount: g.memberCount ?? 0 }))
        .sort((a, b) => b.memberCount - a.memberCount);
}

/** ?g= wins, then the remembered cookie, then the biggest guild. */
function resolveGuildId(req, res, client) {
    const guilds = client.guilds.cache;
    const asked = typeof req.query.g === 'string' ? req.query.g : null;
    if (asked && guilds.has(asked)) {
        res.append('Set-Cookie', `bazaar_guild=${asked}; Path=/; SameSite=Lax; Max-Age=31536000`);
        return asked;
    }
    const remembered = /(?:^|;\s*)bazaar_guild=(\d+)/.exec(req.headers.cookie ?? '')?.[1];
    if (remembered && guilds.has(remembered)) return remembered;
    return guildChoices(client)[0]?.id ?? null;
}

/** async route -> express, without unhandled rejections. */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function securityHeaders(req, res, next) {
    res.set({
        'Content-Security-Policy':
            "default-src 'none'; style-src 'self'; script-src 'self'; "
            + "img-src 'self' https://cdn.discordapp.com data:; connect-src 'self'; "
            + "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (req.secure) {
        res.set('Strict-Transport-Security', 'max-age=31536000');
    }
    next();
}

/**
 * Builds the app. Split from startDashboard so tests can drive it on an
 * ephemeral port with a fake client and never touch Railway or Discord.
 */
function buildApp(client, config) {
    const auth = createAuth(config);
    const app = express();

    app.disable('x-powered-by');
    // Railway terminates TLS one proxy out; without this, req.secure and
    // req.ip would describe the proxy instead of the visitor.
    app.set('trust proxy', 1);

    app.use(securityHeaders);
    app.use(express.json({ limit: '64kb' }));
    app.use(express.urlencoded({ extended: false, limit: '64kb' }));
    app.use('/assets', express.static(path.join(__dirname, 'assets'), {
        maxAge: '1h',
        immutable: false,
    }));

    // ── The door ────────────────────────────────────────────────────────
    app.get('/login', (req, res) => {
        if (auth.readSession(req)) return res.redirect('/');
        res.send(doorPage({
            title: 'The door',
            body: html`
                <h1>Moksi's Bazaar</h1>
                <p>The stall is closed to strangers. The keeper may enter.</p>
                <a class="btn" href="/login/discord">Log in with Discord</a>`,
        }));
    });

    app.get('/login/discord', (req, res) => auth.beginLogin(req, res));

    app.get('/oauth/callback', wrap(async (req, res) => {
        const result = await auth.completeLogin(req, res);
        if (result.ok) return res.redirect('/');
        res.status(result.status).send(doorPage({
            title: 'Not this door',
            body: html`
                <h1>${result.status === 403 ? 'The lantern stays dark' : 'That did not work'}</h1>
                <p>${result.reason}</p>
                ${result.joke ? html`<p class="joke">${result.joke}</p>` : ''}
                <a class="btn" href="/login">Back to the door</a>`,
        }));
    }));

    // Everything below this line requires the owner's session.
    app.use(auth.requireOwner);

    app.post('/logout', auth.requireCsrf, (req, res) => {
        auth.clearSession(res);
        res.redirect('/login');
    });

    // ── Pages ───────────────────────────────────────────────────────────
    const respond = (req, res, { title, body }) => {
        res.send(layout({
            title,
            path: req.path,
            body,
            owner: req.owner,
            csrfToken: req.csrfToken,
            guilds: guildChoices(client),
            guildId: req.guildId,
        }));
    };

    // Until the gateway is up there is no guild data worth rendering.
    app.use((req, res, next) => {
        if (!client.isReady()) {
            if (req.path.startsWith('/api/')) {
                return res.status(503).json({ error: 'The bot is still connecting to Discord. Try again shortly.' });
            }
            return res.status(503).send(doorPage({
                title: 'Warming up',
                body: html`<h1>Lighting the lanterns</h1>
                    <p>The bot is still connecting to Discord. Give it a few seconds and refresh.</p>`,
            }));
        }
        req.guildId = resolveGuildId(req, res, client);
        if (!req.guildId) {
            return res.status(503).send(doorPage({
                title: 'No stalls',
                body: html`<h1>No servers</h1><p>The bot is not in any server yet.</p>`,
            }));
        }
        next();
    });

    // Writes: every /api mutation carries the CSRF token or is refused.
    const { createApi } = require('./api');
    app.use('/api', auth.requireCsrf, createApi(client));

    const overview = require('./pages/overview');
    app.get('/', wrap(async (req, res) => {
        const model = await overview.data(client, req.guildId);
        respond(req, res, { title: 'Overview', body: overview.render(model) });
    }));

    const gate = require('./pages/gate');
    app.get('/gate', wrap(async (req, res) => {
        const model = await gate.data(client, req.guildId);
        respond(req, res, { title: 'Join Gate', body: gate.render(model) });
    }));

    const modlog = require('./pages/modlog');
    app.get('/modlog', wrap(async (req, res) => {
        const model = await modlog.data(client, req.guildId, req.query);
        respond(req, res, { title: 'Mod History', body: modlog.render(model) });
    }));

    const members = require('./pages/members');
    app.get('/members', wrap(async (req, res) => {
        const model = await members.data(client, req.guildId, req.query);
        respond(req, res, { title: 'Members', body: members.render(model) });
    }));

    const member = require('./pages/member');
    app.get('/members/:id', wrap(async (req, res) => {
        if (!/^\d{17,20}$/.test(req.params.id)) {
            return respond(req, res, {
                title: 'Members',
                body: card({ title: 'Not an ID', body: html`<p class="empty">That is not a Discord user ID.</p>` }),
            });
        }
        const model = await member.data(client, req.guildId, req.params.id);
        const name = model.user ? (model.user.globalName ?? model.user.username) : 'Unknown';
        respond(req, res, { title: name, body: member.render(model) });
    }));

    const guard = require('./pages/guard');
    app.get('/guard', wrap(async (req, res) => {
        const model = await guard.data(client, req.guildId);
        respond(req, res, { title: 'Guard', body: guard.render(model) });
    }));

    const backtest = require('./pages/backtest');
    app.get('/gate/backtest', wrap(async (req, res) => {
        const model = await backtest.data(client, req.guildId, req.query);
        respond(req, res, { title: 'Backtest', body: backtest.render(model) });
    }));

    // ── Errors ──────────────────────────────────────────────────────────
    app.use((req, res) => {
        respond(req, res, {
            title: 'Lost',
            body: card({ title: 'Nothing here', body: html`<p class="empty">No such page. The nav on the left is the whole map.</p>` }),
        });
    });

    // eslint-disable-next-line no-unused-vars -- express needs the arity of 4
    app.use((error, req, res, next) => {
        logger.error('[DASHBOARD] Request failed', {
            path: req.path, error: error.message, stack: error.stack,
        });
        if (req.path.startsWith('/api/')) {
            return res.status(500).json({ error: 'Something broke on the way. It is logged.' });
        }
        res.status(500).send(doorPage({
            title: 'Broke',
            body: html`<h1>Something broke</h1>
                <p>The error is logged. The bot itself is unaffected.</p>
                <a class="btn" href="/">Back to the bazaar</a>`,
        }));
    });

    return { app, auth };
}

/**
 * Starts the dashboard if configured; returns the http.Server or null.
 * Never throws: a broken dashboard must never cost a working bot.
 */
function startDashboard(client) {
    try {
        const config = dashboardConfig();
        if (!config.enabled) {
            logger.info('[DASHBOARD] Disabled (missing env)', { missing: config.missing });
            return null;
        }
        const { app } = buildApp(client, config);
        const server = app.listen(config.port, () => {
            logger.info('[DASHBOARD] Listening', { port: config.port, baseUrl: config.baseUrl });
        });
        server.on('error', (error) => {
            logger.error('[DASHBOARD] Server error', { error: error.message });
        });
        return server;
    } catch (error) {
        logger.error('[DASHBOARD] Failed to start; the bot continues without it', {
            error: error.message, stack: error.stack,
        });
        return null;
    }
}

module.exports = { startDashboard, buildApp, dashboardConfig, guildChoices, resolveGuildId };
