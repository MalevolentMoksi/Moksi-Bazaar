// src/utils/presence.js
//
// The one line of the bot's own copy that everybody sees.
//
// It used to be an uptime counter and nothing else, and it had three faults.
// The interval was scheduled a minute out with no first call, so for the sixty
// seconds after every deploy (which is exactly when anyone is looking) the bot
// had no activity at all. The status was the literal 'online', so the dot
// stayed green through a dead database. And it rewrote the same string every
// minute forever, long after "3d 4h" had stopped changing.
//
// The counter stays: it is the owner's telemetry, in a place he passes anyway.
// What is new is that the line steps aside when something is actually wrong.
// Healthy, it reads the uptime and the dot is green. Broken, the text becomes
// the failure and the dot turns yellow, or red if the bot cannot work at all.
// Silence when there is nothing to say, and an alarm where he will see it.

const { ActivityType } = require('discord.js');
const health = require('./health');
const logger = require('./logger');

const REFRESH_MS = 60_000;

/** Discord's ceiling on an activity name. Longer is rejected outright. */
const MAX_ACTIVITY = 128;

/**
 * Formats a duration (in ms) into a human-readable string.
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * What the bot should be saying and showing right now.
 *
 * Only the worst problem gets the line. Three broken subsystems in 128
 * characters is a paragraph nobody reads at a glance, and the count is enough
 * to say "go look properly".
 *
 * @param {number} uptimeMs
 * @param {ReturnType<typeof health.snapshot>} snap
 * @returns {{text: string, status: 'online'|'idle'|'dnd'}}
 */
function presenceLine(uptimeMs, snap, now = Date.now()) {
  if (!snap || snap.state === 'ok' || !snap.worst) {
    return { text: `Uptime: ${formatDuration(uptimeMs)}`, status: 'online' };
  }

  const { label, detail, sinceMs } = snap.worst;
  const age = formatDuration(Math.max(0, now - sinceMs));
  const more = snap.problems.length > 1 ? ` (+${snap.problems.length - 1} more)` : '';
  const text = `${label}: ${detail || 'not working'} · ${age}${more}`;

  return {
    text: text.length > MAX_ACTIVITY ? `${text.slice(0, MAX_ACTIVITY - 1)}…` : text,
    // Yellow for a feature that has stopped; red only for the bot being
    // unable to do its job, which health.js reserves for the database.
    status: snap.state === 'down' ? 'dnd' : 'idle',
  };
}

/**
 * Keeps the presence in step with reality.
 *
 * Ticks immediately, then every minute. Writes only when the rendered line
 * actually changed, so a bot that has been up for three days sends one
 * presence update an hour instead of sixty.
 */
function initPresence(client) {
  let last = null;

  const tick = async () => {
    try {
      await health.refresh();
      if (!client.user) return;

      const { text, status } = presenceLine(client.uptime ?? 0, health.snapshot());
      const rendered = `${status}|${text}`;
      if (rendered === last) return;

      client.user.setPresence({
        activities: [{ name: text, type: ActivityType.Watching }],
        status,
      });
      // Only once it has actually gone out. Recording it first would mean a
      // single failed write silently retired that line: fine for an uptime
      // that changes anyway, fatal for an alarm that says the same thing
      // every minute until someone fixes it.
      last = rendered;
    } catch (error) {
      // A presence that cannot be set is cosmetic. Taking the timer down over
      // it would mean the first blip permanently froze the line on whatever
      // it happened to say, which is worse than a stale minute.
      logger.warn('[PRESENCE] Could not update', { error: error.message });
    }
  };

  tick();
  const timer = setInterval(tick, REFRESH_MS);
  // Never the reason the process stays alive.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  initPresence,
  presenceLine,
  formatDuration,
  REFRESH_MS,
  MAX_ACTIVITY,
};
