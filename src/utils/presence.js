const { ActivityType } = require('discord.js');

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
 * Initialize presence to show remaining trial time.
 * Requires an env var TRIAL_END_DATE (ISO string), e.g. 2025-06-23T00:00:00Z
 */
function initTrialPresence(client) {
  const updateInterval = 60_000; // every minute
  setInterval(() => {
    const endDate = process.env.TRIAL_END_DATE
      ? new Date(process.env.TRIAL_END_DATE)
      : null;
    let statusText;
    if (endDate) {
      const remainingMs = endDate - Date.now();
      statusText = remainingMs > 0
        ? `DOOMSDAY in: ${formatDuration(remainingMs)}`
        : 'DOOMSDAY';
    } else {
      statusText = 'DOOMSDAY date not set';
    }

    client.user.setPresence({
      activities: [{
        name: statusText,
        type: ActivityType.Watching
      }],
      status: 'online'
    });
  }, updateInterval);
}

// Backup uptime presence (commented out)
/*
function initUptimePresence(client) {
  const updateInterval = 60_000; // every minute
  setInterval(() => {
    const uptime = formatDuration(client.uptime);
    client.user.setPresence({
      activities: [{
        name: `Uptime: ${uptime}`,
        type: ActivityType.Watching
      }],
      status: 'online'
    });
  }, updateInterval);
}
*/

module.exports = {
  initTrialPresence,
  // initUptimePresence,
};
