// src/utils/joinGate/phishing.js
/**
 * Join Gate: known-scam domain list.
 *
 * A heuristic says "this account looks odd". A hit here says "this account
 * posted a domain that is on a curated list of Discord phishing sites", which
 * is evidence rather than suspicion.
 *
 * The list is fetched at startup and refreshed periodically. Everything about
 * this module is best-effort: if GitHub is unreachable the bot keeps whatever
 * it already had (possibly nothing) and simply stops contributing this signal.
 * A network problem must never break message handling.
 */

const logger = require('../logger');

const SOURCES = [
    'https://raw.githubusercontent.com/Discord-AntiScam/scam-links/main/list.json',
    'https://raw.githubusercontent.com/nikolaischunk/discord-phishing-links/main/domain-list.json',
];

const REFRESH_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
/**
 * The panel clamps watch_window_minutes to 1440, so anything older than a day
 * is stale for every guild. Used by the piggybacked watch-list sweep below.
 */
const MAX_WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** @type {Set<string>} */
let domains = new Set();
let lastLoadedAt = 0;
let refreshTimer = null;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

function parsePayload(text) {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.domains)) return data.domains;
    return [];
}

async function fetchSource(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parsePayload(await response.text());
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Reloads the blocklist. Sources are tried in order and merged, so one being
 * down degrades coverage rather than removing it.
 * @returns {Promise<number>} domain count now held
 */
async function refresh() {
    const merged = new Set();

    for (const url of SOURCES) {
        try {
            for (const entry of await fetchSource(url)) {
                const domain = String(entry).trim().toLowerCase();
                if (domain && !domain.includes(' ')) merged.add(domain);
            }
        } catch (error) {
            logger.warn('[JOIN-GATE] Scam list source failed', { url, error: error.message });
        }
    }

    if (merged.size === 0) {
        logger.warn('[JOIN-GATE] Scam list refresh produced nothing, keeping previous set', { held: domains.size });
        return domains.size;
    }

    domains = merged;
    lastLoadedAt = Date.now();
    logger.info('[JOIN-GATE] Scam domain list loaded', { domains: domains.size });
    return domains.size;
}

function startAutoRefresh() {
    if (refreshTimer) return;
    refresh().catch(e => logger.warn('[JOIN-GATE] Initial scam list load failed', { error: e.message }));
    refreshTimer = setInterval(() => {
        refresh().catch(e => logger.warn('[JOIN-GATE] Scam list refresh failed', { error: e.message }));
        // Piggybacked janitor: sweep idle watched members whose window has
        // long expired. Required lazily because watch.js requires this module
        // at load; by the first tick both are fully initialised.
        try {
            require('./watch').pruneAll(MAX_WATCH_WINDOW_MS);
        } catch (e) {
            logger.warn('[JOIN-GATE] Watch-list prune failed', { error: e.message });
        }
    }, REFRESH_MS);
    refreshTimer.unref?.();
}

function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

/** Normalises a hostname: strips a leading www. and any trailing dot. */
function normalizeHost(host) {
    return String(host ?? '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

/**
 * True when the host, or any parent of it, is listed. `login.evil.com` is
 * caught by an entry for `evil.com`.
 */
function isListedHost(host) {
    const normalized = normalizeHost(host);
    if (!normalized) return false;
    if (domains.has(normalized)) return true;

    const parts = normalized.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
        if (domains.has(parts.slice(i).join('.'))) return true;
    }
    return false;
}

function extractUrls(text) {
    return String(text ?? '').match(URL_RE) ?? [];
}

function hostOf(rawUrl) {
    try {
        const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
        return new URL(withScheme).hostname;
    } catch {
        return null;
    }
}

/**
 * @returns {{urls: string[], hits: string[]}} every URL found, and the hosts
 * that are on the blocklist
 */
function scanText(text) {
    const urls = extractUrls(text);
    const hits = [];
    for (const url of urls) {
        const host = hostOf(url);
        if (host && isListedHost(host)) hits.push(normalizeHost(host));
    }
    return { urls, hits: [...new Set(hits)] };
}

function stats() {
    return { domains: domains.size, lastLoadedAt };
}

/** Test seam: load a set directly instead of over the network. */
function seed(list) {
    domains = new Set(list.map(d => String(d).toLowerCase()));
    lastLoadedAt = Date.now();
}

module.exports = {
    refresh,
    startAutoRefresh,
    stopAutoRefresh,
    scanText,
    extractUrls,
    isListedHost,
    normalizeHost,
    stats,
    seed,
};
