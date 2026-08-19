// src/utils/joinGate/removalCohorts.js
/**
 * Join Gate: batches among the accounts the gate has already removed.
 *
 * `cohorts.js` has always been able to spot a batch. It could never see the
 * batches that mattered most, because the only place it ran was over the
 * CURRENT member roster, and anything the gate caught is by definition no
 * longer in it. On 2026-08-19 two obvious throwaways arrived minutes apart,
 * were both correctly kicked, and left nothing behind that could later be
 * recognised as a pair. The evidence deleted itself at the moment the gate
 * worked.
 *
 * This reads the removal log instead, so the population being examined is
 * exactly the one the gate acted on.
 *
 * TWO RULES, both about not turning a report into an accusation:
 *
 *  1. IT NEVER ACTS, and nothing here is wired into scoring. The live scorer
 *     does not know about cohorts and must not: a grouping is context for a
 *     person, not a signal with a weight.
 *  2. PAIRS COUNT HERE, AND ONLY HERE. `cohorts.js` requires three members
 *     over the live roster, where a wrong grouping is an accusation against
 *     somebody who is still in the server. Over accounts that have already
 *     been removed, a wrong grouping costs a glance at an embed, so the bar
 *     is lower. That asymmetry is the whole reason this file exists rather
 *     than a looser default on the shared module.
 */

const { findCohorts } = require('./cohorts');
const { getRemovalLog } = require('./enforcement');

/** How far back the report looks. Long enough to span a slow-burn campaign. */
const DEFAULT_WINDOW_MS = 14 * 86_400_000;

/**
 * Groups recently removed accounts into likely batches.
 *
 * @returns {Promise<{cohorts: Array, scanned: number, windowMs: number}>}
 */
async function findRemovalCohorts(guildId, { windowMs = DEFAULT_WINDOW_MS, now = Date.now() } = {}) {
    const rows = await getRemovalLog(guildId, { sinceMs: now - windowMs });

    // The removal log stores what the account looked like; findCohorts wants
    // the member shape. `joinedTimestamp` becomes the time they were last
    // turned away, which is the closest thing to "arrived together" that
    // exists for somebody who never got in.
    const roster = rows
        .filter(r => r.username && r.created_ms)
        .map(r => ({
            id: r.user_id,
            username: String(r.username),
            tag: r.global_name ? `${r.username} (${r.global_name})` : String(r.username),
            createdTimestamp: Number(r.created_ms),
            joinedTimestamp: Number(r.last_seen_ms),
            defaultAvatar: !r.avatar,
            avatar: r.avatar ?? null,
            inviteCode: r.invite_code ?? null,
            attempts: Number(r.attempts) || 1,
            messages: 0,
        }));

    return {
        cohorts: findCohorts(roster, { minSize: 2 }),
        scanned: roster.length,
        windowMs,
    };
}

module.exports = { findRemovalCohorts, DEFAULT_WINDOW_MS };
