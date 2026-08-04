// src/web/auth.js
/**
 * Dashboard authentication: one door, one person.
 *
 * The flow is standard Discord OAuth with the `identify` scope and nothing
 * else: the dashboard learns who you are and deliberately nothing more. What
 * makes it "only the owner" is not the OAuth dance but the allow-list at the
 * end of it: the returned user ID is checked against the same isOwner() that
 * gates every owner command in the bot. There is no user table, no roles, no
 * "add an admin" growth path. One ID passes; everyone else gets a joke.
 *
 * Sessions are stateless signed cookies (HMAC-SHA256 over a JSON payload).
 * Nothing is stored server-side, so a restart logs nobody out and there is no
 * session table to leak. Forging a cookie requires SESSION_SECRET, which lives
 * only in Railway's environment.
 *
 * The owner check runs on EVERY request, not just at login. A cookie is proof
 * of a past login, and the allow-list is consulted again each time, so a
 * session can never outlive its authority.
 */

const crypto = require('node:crypto');
const { isOwner, OWNER_REJECTION_JOKES } = require('../utils/constants');
const logger = require('../utils/logger');

const SESSION_COOKIE = 'bazaar_session';
const STATE_COOKIE = 'bazaar_state';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A login attempt that takes longer than this was abandoned; the state dies. */
const STATE_TTL_MS = 10 * 60 * 1000;

const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN = 'https://discord.com/api/oauth2/token';
const DISCORD_ME = 'https://discord.com/api/users/@me';

// ── Signing ─────────────────────────────────────────────────────────────────

function hmac(secret, data) {
    return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/** payload object -> "base64url(json).signature" */
function sign(payload, secret) {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${data}.${hmac(secret, data)}`;
}

/**
 * Verifies and decodes a signed token. Returns the payload or null; never
 * throws on garbage input, because cookies are attacker-controlled bytes.
 */
function verify(token, secret) {
    if (typeof token !== 'string' || token.length > 4096) return null;
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;

    const data = token.slice(0, dot);
    const given = token.slice(dot + 1);
    const expected = hmac(secret, data);

    // timingSafeEqual demands equal lengths; a length mismatch is already a
    // failed signature, checked without leaking anything through timing.
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    try {
        const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
        return (payload && typeof payload === 'object') ? payload : null;
    } catch {
        return null;
    }
}

/**
 * The CSRF token is derived from the session rather than stored: whoever holds
 * the session cookie can compute it, and nobody else can. A cross-site form
 * can make the browser SEND the cookie but can never READ this token to put it
 * in a header, which is the whole trick.
 */
function csrfTokenFor(session, secret) {
    return hmac(secret, `csrf:${session.uid}:${session.iat}`);
}

// ── Cookies ─────────────────────────────────────────────────────────────────

function parseCookies(header) {
    const jar = {};
    for (const part of String(header ?? '').split(';')) {
        const eq = part.indexOf('=');
        if (eq < 1) continue;
        jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return jar;
}

function cookieAttrs({ maxAgeMs, secure }) {
    return [
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        ...(secure ? ['Secure'] : []),
        ...(maxAgeMs != null ? [`Max-Age=${Math.floor(maxAgeMs / 1000)}`] : []),
    ].join('; ');
}

// ── Rate limiting ───────────────────────────────────────────────────────────

/**
 * In-memory sliding window per IP, for the auth endpoints only. This is not a
 * fortress; it exists so a script hammering the login flow burns out in
 * seconds instead of generating a thousand OAuth round-trips.
 */
const attempts = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 10 * 60 * 1000;

function rateLimited(ip, now = Date.now()) {
    const seen = (attempts.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS);
    seen.push(now);
    attempts.set(ip, seen);
    // The map only ever holds IPs that touched an auth route; prune the rest
    // opportunistically so it cannot grow without bound.
    if (attempts.size > 1000) {
        for (const [key, times] of attempts) {
            if (times.every(t => now - t >= RATE_WINDOW_MS)) attempts.delete(key);
        }
    }
    return seen.length > RATE_LIMIT;
}

// ── The auth surface ────────────────────────────────────────────────────────

/**
 * Builds everything auth-related against a config object so none of it touches
 * process.env directly, which is what makes it testable.
 *
 * @param {{clientId: string, clientSecret: string, sessionSecret: string,
 *          baseUrl: string, secureCookies: boolean}} config
 */
function createAuth(config) {
    const redirectUri = `${config.baseUrl}/oauth/callback`;

    function readSession(req) {
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (!token) return null;
        const session = verify(token, config.sessionSecret);
        if (!session?.uid || typeof session.exp !== 'number') return null;
        if (Date.now() >= session.exp) return null;
        if (!isOwner(session.uid)) return null;
        return session;
    }

    function setSession(res, user) {
        const now = Date.now();
        const session = {
            uid: user.id,
            tag: user.global_name || user.username || 'owner',
            av: user.avatar ?? null,
            iat: now,
            exp: now + SESSION_TTL_MS,
        };
        res.append('Set-Cookie',
            `${SESSION_COOKIE}=${sign(session, config.sessionSecret)}; `
            + cookieAttrs({ maxAgeMs: SESSION_TTL_MS, secure: config.secureCookies }));
        return session;
    }

    function clearSession(res) {
        res.append('Set-Cookie',
            `${SESSION_COOKIE}=; ${cookieAttrs({ maxAgeMs: 0, secure: config.secureCookies })}`);
    }

    /** Pages redirect to the door; the JSON API answers 401 and stays quiet. */
    function requireOwner(req, res, next) {
        const session = readSession(req);
        if (!session) {
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ error: 'Not signed in.' });
            }
            return res.redirect('/login');
        }
        req.owner = session;
        req.csrfToken = csrfTokenFor(session, config.sessionSecret);
        next();
    }

    /**
     * For state-changing requests. SameSite=Lax already stops cross-site form
     * posts in every current browser; this makes the same guarantee hold even
     * if that ever regresses, and covers the JSON API uniformly.
     */
    function requireCsrf(req, res, next) {
        const given = req.get('x-bazaar-csrf') ?? req.body?._csrf;
        let valid = false;
        try {
            const a = Buffer.from(String(given ?? ''));
            const b = Buffer.from(req.csrfToken ?? '');
            valid = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
        } catch {
            valid = false;
        }
        if (!valid) {
            if (req.path.startsWith('/api/')) {
                return res.status(403).json({ error: 'Stale page. Refresh and try again.' });
            }
            return res.status(403).send('Stale page. Go back, refresh, and try again.');
        }
        next();
    }

    function beginLogin(req, res) {
        if (rateLimited(req.ip)) {
            logger.warn('[DASHBOARD] Login rate limit hit', { ip: req.ip });
            return res.status(429).send('Too many attempts. The stall reopens in a few minutes.');
        }
        const state = crypto.randomBytes(16).toString('hex');
        res.append('Set-Cookie',
            `${STATE_COOKIE}=${sign({ s: state, exp: Date.now() + STATE_TTL_MS }, config.sessionSecret)}; `
            + cookieAttrs({ maxAgeMs: STATE_TTL_MS, secure: config.secureCookies }));

        const url = new URL(DISCORD_AUTHORIZE);
        url.searchParams.set('client_id', config.clientId);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', 'identify');
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('state', state);
        res.redirect(url.toString());
    }

    /**
     * The callback. Returns {ok: true, session} or {ok: false, status, reason,
     * joke?} and lets the route render; auth logic and page rendering stay
     * apart.
     */
    async function completeLogin(req, res) {
        if (rateLimited(req.ip)) {
            return { ok: false, status: 429, reason: 'Too many attempts. Try again in a few minutes.' };
        }

        const stateCookie = verify(parseCookies(req.headers.cookie)[STATE_COOKIE], config.sessionSecret);
        res.append('Set-Cookie',
            `${STATE_COOKIE}=; ${cookieAttrs({ maxAgeMs: 0, secure: config.secureCookies })}`);

        if (!stateCookie?.s || Date.now() >= (stateCookie.exp ?? 0)
            || stateCookie.s !== req.query.state) {
            return { ok: false, status: 400, reason: 'Login attempt expired or mismatched. Start again from the door.' };
        }
        if (!req.query.code) {
            return { ok: false, status: 400, reason: 'Discord sent no code. Start again from the door.' };
        }

        let user;
        try {
            const tokenResponse = await fetch(DISCORD_TOKEN, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: config.clientId,
                    client_secret: config.clientSecret,
                    grant_type: 'authorization_code',
                    code: String(req.query.code),
                    redirect_uri: redirectUri,
                }),
            });
            if (!tokenResponse.ok) {
                logger.warn('[DASHBOARD] OAuth code exchange failed', { status: tokenResponse.status });
                return { ok: false, status: 502, reason: 'Discord refused the login handshake. Try again.' };
            }
            const { access_token: accessToken } = await tokenResponse.json();

            const meResponse = await fetch(DISCORD_ME, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!meResponse.ok) {
                return { ok: false, status: 502, reason: 'Discord would not say who you are. Try again.' };
            }
            user = await meResponse.json();
        } catch (error) {
            logger.error('[DASHBOARD] OAuth flow error', { error: error.message });
            return { ok: false, status: 502, reason: 'Could not reach Discord. Try again.' };
        }

        if (!user?.id || !isOwner(user.id)) {
            // The one log line that matters most on this surface: who knocked.
            logger.warn('[DASHBOARD] Non-owner login attempt', {
                userId: user?.id, username: user?.username,
            });
            const joke = OWNER_REJECTION_JOKES[
                crypto.randomInt(OWNER_REJECTION_JOKES.length)];
            return { ok: false, status: 403, reason: 'This dashboard has exactly one key.', joke };
        }

        const session = setSession(res, user);
        logger.info('[DASHBOARD] Owner signed in', { userId: user.id });
        return { ok: true, session };
    }

    return {
        readSession, setSession, clearSession,
        requireOwner, requireCsrf,
        beginLogin, completeLogin,
        csrfTokenFor: session => csrfTokenFor(session, config.sessionSecret),
    };
}

module.exports = {
    createAuth,
    sign,
    verify,
    csrfTokenFor,
    parseCookies,
    rateLimited,
    SESSION_COOKIE,
    STATE_COOKIE,
    SESSION_TTL_MS,
};
