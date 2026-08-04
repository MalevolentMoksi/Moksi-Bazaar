// src/utils/joinGate/cohorts.js
/**
 * Join Gate: finding batches among members who are already here.
 *
 * The three strongest correlation signals (created alongside others, shared
 * avatar, similar name) read from an in-memory list of the last ten minutes of
 * joins, capped at 200 entries and wiped by every restart. They are built for
 * a raid arriving at once. They can say nothing at all about fourteen accounts
 * that trickled in over months and have been sitting quietly ever since, which
 * is the shape a real cleanup turned out to have.
 *
 * All the evidence needed is already on hand and free: a Discord snowflake
 * carries the account's creation time, and the member object carries the join
 * time. This groups on that, plus the shape of the username.
 *
 * Deliberately NOT wired into live scoring. Chance collisions are common across
 * a thousand members and would spray points over innocent pairs; this is
 * evidence for a person reading a report, not an automatic accusation.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DEFAULTS = Object.freeze({
    creationWindowMs: DAY_MS,
    joinWindowMs: 6 * HOUR_MS,
    minSize: 3,
});

/**
 * The structural shape of a username, or null when it has none.
 *
 * Only structured names group. Grouping on "has no digits in it" would put half
 * the server in one bucket, which is not a cohort, it is a member list.
 */
function nameShape(username) {
    const name = String(username ?? '').toLowerCase();

    const suggested = name.match(/^[a-z0-9._]*[a-z][a-z0-9._]*_(\d{4,6})$/);
    if (suggested) return `suggested_${suggested[1].length}`;

    const trailing = name.match(/(\d{4,})$/);
    if (trailing) return `digits_${trailing[1].length}`;

    return null;
}

/** Human-readable version of a shape key, for the report. */
function describeShape(shape) {
    const [kind, length] = String(shape).split('_');
    return kind === 'suggested'
        ? `name_${'#'.repeat(Number(length))} (signup suggestion)`
        : `ends in ${length} digits`;
}

function span(values) {
    if (values.length === 0) return 0;
    return Math.max(...values) - Math.min(...values);
}

/**
 * Splits a list already sorted by `key` into runs where each member is within
 * `windowMs` of the previous one.
 *
 * Chaining is intentional and bounded: fourteen accounts registered a few hours
 * apart are one batch even though the first and last are days apart. The span
 * is reported so a run that stretched too far is visible rather than implied.
 */
function runsWithin(sorted, key, windowMs) {
    const runs = [];
    let current = [];

    for (const entry of sorted) {
        const value = Number(entry[key]);
        if (!Number.isFinite(value) || value <= 0) continue;
        const previous = current[current.length - 1];
        if (previous && value - Number(previous[key]) > windowMs) {
            runs.push(current);
            current = [];
        }
        current.push(entry);
    }
    if (current.length) runs.push(current);
    return runs;
}

function summarise(members, basis) {
    const created = members.map(m => Number(m.createdTimestamp)).filter(Boolean);
    const joined = members.map(m => Number(m.joinedTimestamp)).filter(Boolean);

    return {
        basis,
        shape: members[0].shape,
        size: members.length,
        members,
        creationSpanMs: span(created),
        joinSpanMs: span(joined),
        defaultAvatars: members.filter(m => m.defaultAvatar).length,
        silent: members.filter(m => (m.messages ?? 0) === 0).length,
    };
}

/**
 * Finds batches in a member list.
 *
 * @param {Array<{id, username, createdTimestamp, joinedTimestamp, defaultAvatar, messages?}>} members
 * @returns {Array} clusters, largest first
 */
function findCohorts(members, options = {}) {
    const { creationWindowMs, joinWindowMs, minSize } = { ...DEFAULTS, ...options };

    const shaped = [];
    for (const member of members) {
        const shape = nameShape(member.username);
        if (shape) shaped.push({ ...member, shape });
    }

    const byShape = new Map();
    for (const member of shaped) {
        if (!byShape.has(member.shape)) byShape.set(member.shape, []);
        byShape.get(member.shape).push(member);
    }

    const clusters = [];
    for (const group of byShape.values()) {
        // Registered together: a batch bought in one go.
        const byCreation = [...group].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const run of runsWithin(byCreation, 'createdTimestamp', creationWindowMs)) {
            if (run.length >= minSize) clusters.push(summarise(run, 'creation'));
        }

        // Arrived together: accounts aged separately then walked in as a wave.
        const byJoin = [...group].sort((a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0));
        for (const run of runsWithin(byJoin, 'joinedTimestamp', joinWindowMs)) {
            if (run.length >= minSize) clusters.push(summarise(run, 'join'));
        }
    }

    // A batch that was both registered and admitted together shows up twice.
    // Keep the larger telling of it.
    const seen = new Map();
    for (const cluster of clusters) {
        const key = cluster.members.map(m => m.id).sort().join(',');
        const existing = seen.get(key);
        if (!existing || cluster.size > existing.size) seen.set(key, cluster);
    }

    return [...seen.values()].sort((a, b) => b.size - a.size);
}

module.exports = { findCohorts, nameShape, describeShape, DEFAULTS };
